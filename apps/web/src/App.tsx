import { useState, useEffect, useCallback } from 'react';
import Canvas2D, { type ResultPoint } from './components/Canvas2D';

// =============================================================================
// WASM Solver Integration
// =============================================================================

type SolveFn = (input: any) => any;
let solveMeshFn: SolveFn | null = null;
let optimizeSectionsFn: SolveFn | null = null;

async function initWasm(): Promise<boolean> {
  try {
    const wasmModule = await import('solver-wasm');
    await wasmModule.default();
    solveMeshFn = wasmModule.solve_mesh;
    optimizeSectionsFn = wasmModule.optimize_sections;
    return true;
  } catch (err) {
    console.warn('[StructurAI] WASM module not available, using mock solver:', err);
    return false;
  }
}

export interface PointLoad {
  id: string;
  x: number;
  value: number; // kN, negative is downwards
}

export interface OptimizationResult {
  name: string;
  utilization_sgn: number;
  deflection_sgu: number;
  limit_sgu: number;
  weight: number;
  price_factor: number;
}

export interface OptimizerOutput {
  success: boolean;
  error: string | null;
  cheapest: OptimizationResult | null;
  lightest: OptimizationResult | null;
  balanced: OptimizationResult | null;
}

// Mock solver for development without WASM
function mockSolver(inputModel: any): any {
  try {
    const results: ResultPoint[] = [];
    const nodes = inputModel.nodes;
    const elements = inputModel.elements;
    const distributed_loads = inputModel.distributed_loads;
    const point_loads = inputModel.point_loads || [];

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const startNode = nodes.find((n: any) => n.id === el.start_node_id);
      const endNode = nodes.find((n: any) => n.id === el.end_node_id);
      const length = endNode.x - startNode.x;

      const load = distributed_loads.find((ld: any) => ld.element_id === el.id);
      const q = Math.abs(load?.value || 10);
      const E = el.e;
      const I = el.i_inertia;

      // Find concentrated loads inside this element segment
      const elPointLoads = point_loads.filter((pl: any) => pl.x >= startNode.x && pl.x <= endNode.x);

      // Simple parabolic approximation for fallback
      const numPoints = 50;
      for (let step = 0; step <= numPoints; step++) {
        const x_loc = (step / numPoints) * length;
        // deflection: 5qL^4/(384EI) * sin(pi*x/L)
        const deflMax = (5 * q * Math.pow(length, 4)) / (384 * E * I * 1e-3); // mm
        let deflection = -deflMax * Math.sin((Math.PI * x_loc) / length);

        // Add dummy displacement from point loads
        elPointLoads.forEach((pl: any) => {
          const pVal = Math.abs(pl.value);
          const pDefl = (pVal * Math.pow(length, 3)) / (48 * E * I * 1e-3);
          deflection -= pDefl * Math.sin((Math.PI * x_loc) / length);
        });

        // moment: qLx/2 - qx^2/2 + concentrated moment
        let moment = -((q * length * x_loc) / 2 - (q * x_loc * x_loc) / 2);
        elPointLoads.forEach((pl: any) => {
          const a = pl.x - startNode.x;
          if (x_loc <= a) {
            moment -= (Math.abs(pl.value) * (length - a) * x_loc) / length;
          } else {
            moment -= (Math.abs(pl.value) * a * (length - x_loc)) / length;
          }
        });

        // shear: qL/2 - qx + concentrated shear
        let shear = -((q * length) / 2 - q * x_loc);
        elPointLoads.forEach((pl: any) => {
          const a = pl.x - startNode.x;
          if (x_loc <= a) {
            shear -= (Math.abs(pl.value) * (length - a)) / length;
          } else {
            shear += (Math.abs(pl.value) * a) / length;
          }
        });

        results.push({
          global_x: startNode.x + x_loc,
          deflection,
          moment,
          shear,
        });
      }
    }

    return {
      success: true,
      error: null,
      results,
    };
  } catch (e) {
    return { success: false, error: 'Mock solver parse error: ' + e, results: [] };
  }
}

interface Support {
  id: string;
  x: number;
  type: 'Pinned' | 'Fixed';
}

// =============================================================================
// App Component
// =============================================================================

export default function App() {
  const [wasmReady, setWasmReady] = useState(false);
  const [wasmError, setWasmError] = useState(false);
  const [results, setResults] = useState<ResultPoint[] | null>(null);
  const [optResults, setOptResults] = useState<OptimizerOutput | null>(null);
  const [beamLength, setBeamLength] = useState(5.0);
  const [loadValue, setLoadValue] = useState(10.0);
  const [sectionId, setSectionId] = useState('IPE200');
  const [solveTimeMs, setSolveTimeMs] = useState<number | null>(null);
  const [supports, setSupports] = useState<Support[]>([
    { id: 'S1', x: 0, type: 'Pinned' },
    { id: 'S2', x: 5.0, type: 'Pinned' },
  ]);
  const [pointLoads, setPointLoads] = useState<PointLoad[]>([]);

  // Initialize WASM
  useEffect(() => {
    initWasm().then((success) => {
      if (success) {
        setWasmReady(true);
      } else {
        setWasmError(true);
        setWasmReady(true); // Still "ready" — will use mock
      }
    });
  }, []);

  // Update edge supports positions when beamLength changes
  useEffect(() => {
    setSupports(prev => {
      return prev.map((s, idx) => {
        if (idx === 0) return { ...s, x: 0 };
        if (idx === prev.length - 1) return { ...s, x: beamLength };
        // Clamp intermediate supports to be within the beam span
        return { ...s, x: Math.min(Math.max(s.x, 0.5), beamLength - 0.5) };
      });
    });
  }, [beamLength]);

  // Clamp point loads when beamLength changes
  useEffect(() => {
    setPointLoads(prev => {
      return prev.map(pl => ({
        ...pl,
        x: Math.min(Math.max(pl.x, 0.1), beamLength - 0.1),
      }));
    });
  }, [beamLength]);

  const addSupport = () => {
    if (supports.length >= 10) return;
    const newX = parseFloat((beamLength / 2).toFixed(1));
    setSupports(prev => {
      const next = [...prev];
      const end = next.pop()!;
      next.push({
        id: `S_int_${Date.now()}`,
        x: newX,
        type: 'Pinned'
      });
      next.sort((a, b) => a.x - b.x);
      next.push(end);
      return next;
    });
  };

  const removeSupport = (id: string) => {
    setSupports(prev => {
      if (prev[0].id === id || prev[prev.length - 1].id === id) return prev;
      return prev.filter(s => s.id !== id);
    });
  };

  const updateSupportX = (id: string, x: number) => {
    setSupports(prev => {
      return prev.map((s, idx) => {
        if (s.id !== id) return s;
        if (idx === 0 || idx === prev.length - 1) return s;
        const clampedX = Math.min(Math.max(x, 0.5), beamLength - 0.5);
        return { ...s, x: parseFloat(clampedX.toFixed(1)) };
      });
    });
  };

  const updateSupportType = (id: string, type: 'Pinned' | 'Fixed') => {
    setSupports(prev => {
      return prev.map(s => (s.id === id ? { ...s, type } : s));
    });
  };

  const addPointLoad = () => {
    if (pointLoads.length >= 5) return;
    const newX = parseFloat((beamLength / 2).toFixed(1));
    setPointLoads(prev => [
      ...prev,
      {
        id: `PL_${Date.now()}`,
        x: newX,
        value: -20.0, // default -20 kN (downwards)
      }
    ]);
  };

  const removePointLoad = (id: string) => {
    setPointLoads(prev => prev.filter(pl => pl.id !== id));
  };

  const updatePointLoadX = (id: string, x: number) => {
    setPointLoads(prev => prev.map(pl => {
      if (pl.id !== id) return pl;
      const clampedX = Math.min(Math.max(x, 0.1), beamLength - 0.1);
      return { ...pl, x: parseFloat(clampedX.toFixed(1)) };
    }));
  };

  const updatePointLoadVal = (id: string, value: number) => {
    setPointLoads(prev => prev.map(pl => {
      if (pl.id !== id) return pl;
      return { ...pl, value: parseFloat(value.toFixed(1)) };
    }));
  };

  // Solve function
  const solve = useCallback(() => {
    // Sort nodes by X coordinate
    const sortedSupports = [...supports].sort((a, b) => a.x - b.x);

    const nodes = sortedSupports.map((s, idx) => ({
      id: `N${idx}`,
      x: s.x,
      support_type: s.type,
    }));

    // Elements connecting consecutive nodes
    const elements = [];
    let E = 210e9; // steel Young's modulus
    let I = 1.943e-5; // standard IPE200 moment of inertia
    if (sectionId === 'IPE300') { I = 8.356e-5; }
    else if (sectionId === 'IPE400') { I = 2.313e-4; }
    else if (sectionId === 'HEB200') { I = 5.696e-5; }
    else if (sectionId === 'HEB300') { I = 2.517e-4; }

    for (let i = 0; i < nodes.length - 1; i++) {
      elements.push({
        id: `E${i}`,
        start_node_id: nodes[i].id,
        end_node_id: nodes[i + 1].id,
        e: E,
        i_inertia: I,
      });
    }

    const distributed_loads = elements.map(el => ({
      element_id: el.id,
      value: -loadValue,
    }));

    const mappedPointLoads = pointLoads.map(pl => ({
      x: pl.x,
      value: pl.value,
    }));

    const inputModel = {
      nodes,
      elements,
      distributed_loads,
      point_loads: mappedPointLoads,
    };

    const t0 = performance.now();
    const output = solveMeshFn ? solveMeshFn(inputModel) : mockSolver(inputModel);
    const t1 = performance.now();
    setSolveTimeMs(Math.round((t1 - t0) * 100) / 100);

    if (output && output.success) {
      setResults(output.results);
    } else {
      console.error('[StructurAI] Solver error:', output?.error);
    }

    // Run AI section optimization in real-time
    if (optimizeSectionsFn) {
      const optOut = optimizeSectionsFn(inputModel);
      if (optOut && optOut.success) {
        setOptResults(optOut);
        console.log('[StructurAI] AI section optimization complete');
      } else {
        console.warn('[StructurAI] AI section optimizer returned error:', optOut?.error);
        setOptResults(null);
      }
    } else {
      // Mock optimizer output if WASM is not loaded
      setOptResults({
        success: true,
        error: null,
        cheapest: { name: 'IPE 140', utilization_sgn: 0.88, deflection_sgu: 18.2, limit_sgu: 20.0, weight: 12.9, price_factor: 1.0 },
        lightest: { name: 'IPE 140', utilization_sgn: 0.88, deflection_sgu: 18.2, limit_sgu: 20.0, weight: 12.9, price_factor: 1.0 },
        balanced: { name: 'IPE 200', utilization_sgn: 0.44, deflection_sgu: 5.1, limit_sgu: 20.0, weight: 22.4, price_factor: 1.0 }
      });
    }
  }, [beamLength, loadValue, sectionId, supports, pointLoads]);

  // Auto-solve on parameter change (real-time!)
  useEffect(() => {
    if (wasmReady) solve();
  }, [wasmReady, solve]);

  return (
    <div className="app-layout">
      {/* ===== Top Bar ===== */}
      <header className="top-bar">
        <div className="top-bar__logo">
          <div className="top-bar__logo-icon">S</div>
          <span className="top-bar__logo-text">StructurAI Dynamics</span>
          <span className="top-bar__logo-version">v0.1.0 PoC</span>
        </div>
        <div className="top-bar__actions">
          {solveTimeMs !== null && (
            <span className="badge badge--info">
              ⚡ {solveTimeMs < 1 ? '<1' : solveTimeMs.toFixed(1)} ms
            </span>
          )}
          <span className={`badge ${wasmError ? 'badge--warning' : 'badge--success'}`}>
            {wasmError ? '⚠ JS Fallback' : '✓ WASM Active'}
          </span>
        </div>
      </header>

      {/* ===== Main Content ===== */}
      <div className="main-content">
        {/* ----- Left Toolbar ----- */}
        <nav className="toolbar">
          <button className="toolbar__btn toolbar__btn--active" data-tooltip="Wskaźnik" id="tool-select">
            ◇
          </button>
          <button className="toolbar__btn" data-tooltip="Dodaj węzeł" id="tool-node">
            ⊕
          </button>
          <button className="toolbar__btn" data-tooltip="Dodaj belkę" id="tool-beam">
            ─
          </button>
          <div className="toolbar__separator" />
          <button className="toolbar__btn" data-tooltip="Podpora stała" id="tool-pinned">
            △
          </button>
          <button className="toolbar__btn" data-tooltip="Podpora przesuwna" id="tool-roller">
            ○
          </button>
          <div className="toolbar__separator" />
          <button className="toolbar__btn" data-tooltip="Obciążenie skupione" id="tool-point-load">
            ↓
          </button>
          <button className="toolbar__btn" data-tooltip="Obciążenie ciągłe" id="tool-dist-load">
            ⇣
          </button>
          <div className="toolbar__separator" />
          <button className="toolbar__btn" data-tooltip="Uruchom solver" onClick={solve} id="tool-solve">
            ▶
          </button>
        </nav>

        {/* ----- Canvas Area ----- */}
        <div className="canvas-area canvas-grid">
          {!results ? (
            <div className="welcome-overlay">
              <div className="welcome-overlay__icon">🏗</div>
              <h1 className="welcome-overlay__title">StructurAI Dynamics</h1>
              <p className="welcome-overlay__subtitle">
                Analiza konstrukcji w czasie rzeczywistym.
                Silnik MES (Rust/WASM) oblicza wyniki natychmiast przy każdej zmianie parametrów.
              </p>
              <div className="welcome-overlay__actions">
                <button className="btn btn--primary" onClick={solve} id="btn-start-analysis">
                  ▶ Uruchom analizę
                </button>
              </div>
            </div>
          ) : (
            <Canvas2D results={results} supports={supports} pointLoads={pointLoads} beamLength={beamLength} load={loadValue} />
          )}
        </div>

        {/* ----- Right Properties Panel ----- */}
        <aside className="properties-panel">
          <div className="properties-panel__header">
            <span className="properties-panel__title">Parametry</span>
          </div>

          {/* Beam Length */}
          <div className="properties-panel__section">
            <div className="properties-panel__section-title">Geometria</div>
            <label className="param-label" htmlFor="param-length">
              Długość belki [m]
            </label>
            <div className="param-input-group">
              <input
                id="param-length"
                type="range"
                min="1"
                max="20"
                step="0.5"
                value={beamLength}
                onChange={(e) => setBeamLength(parseFloat(e.target.value))}
                className="param-range"
              />
              <span className="param-value mono-value">{beamLength.toFixed(1)}</span>
            </div>
          </div>

          {/* Supports */}
          <div className="properties-panel__section">
            <div className="properties-panel__section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Podpory belki</span>
              <button 
                className="btn btn--primary" 
                onClick={addSupport} 
                style={{ padding: '2px 8px', fontSize: '11px', height: 'auto', borderRadius: '4px' }}
                disabled={supports.length >= 8}
              >
                + Dodaj
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
              {supports.map((s, idx) => {
                const isStart = idx === 0;
                const isEnd = idx === supports.length - 1;
                const isEdge = isStart || isEnd;
                return (
                  <div key={s.id} style={{ 
                    background: 'rgba(255,255,255,0.03)', 
                    padding: '8px 12px', 
                    borderRadius: '8px', 
                    border: '1px solid rgba(255,255,255,0.06)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="mono-value" style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8' }}>
                        Węzeł N{idx + 1} ({isStart ? 'Start' : isEnd ? 'Koniec' : `x = ${s.x.toFixed(1)}m`})
                      </span>
                      {!isEdge && (
                        <button 
                          onClick={() => removeSupport(s.id)}
                          style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '11px', cursor: 'pointer', padding: 0 }}
                        >
                          Usuń
                        </button>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '4px' }}>
                      {!isEdge && (
                        <input
                          type="range"
                          min="0.5"
                          max={beamLength - 0.5}
                          step="0.1"
                          value={s.x}
                          onChange={(e) => updateSupportX(s.id, parseFloat(e.target.value))}
                          style={{ flex: 1, accentColor: '#3b82f6', height: '4px' }}
                        />
                      )}
                      
                      <select
                        value={s.type}
                        onChange={(e) => updateSupportType(s.id, e.target.value as 'Pinned' | 'Fixed')}
                        className="param-select"
                        style={{ 
                          padding: '2px 6px', 
                          fontSize: '11px', 
                          height: '24px', 
                          width: '100px', 
                          background: 'rgba(0,0,0,0.3)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '4px',
                          color: '#e2e8f0'
                        }}
                      >
                        <option value="Pinned">Przegub</option>
                        <option value="Fixed">Utwierdzenie</option>
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Point Loads */}
          <div className="properties-panel__section">
            <div className="properties-panel__section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Siły skupione</span>
              <button 
                className="btn btn--primary" 
                onClick={addPointLoad} 
                style={{ padding: '2px 8px', fontSize: '11px', height: 'auto', borderRadius: '4px' }}
                disabled={pointLoads.length >= 5}
              >
                + Dodaj
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
              {pointLoads.map((pl, idx) => (
                <div key={pl.id} style={{ 
                  background: 'rgba(255,255,255,0.03)', 
                  padding: '8px 12px', 
                  borderRadius: '8px', 
                  border: '1px solid rgba(255,255,255,0.06)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="mono-value" style={{ fontSize: '11px', fontWeight: '600', color: '#f97316' }}>
                      Siła P{idx + 1} (x = {pl.x.toFixed(1)}m)
                    </span>
                    <button 
                      onClick={() => removePointLoad(pl.id)}
                      style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '11px', cursor: 'pointer', padding: 0 }}
                    >
                      Usuń
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
                    <label style={{ fontSize: '10px', color: '#64748b' }}>Pozycja [m]</label>
                    <input
                      type="range"
                      min="0.1"
                      max={beamLength - 0.1}
                      step="0.1"
                      value={pl.x}
                      onChange={(e) => updatePointLoadX(pl.id, parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: '#f97316', height: '4px' }}
                    />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontSize: '10px', color: '#64748b' }}>Wartość [kN]</label>
                      <span className="mono-value" style={{ fontSize: '10px', color: '#f97316', fontWeight: 'bold' }}>{pl.value.toFixed(1)} kN</span>
                    </div>
                    <input
                      type="range"
                      min="-100"
                      max="100"
                      step="5"
                      value={pl.value}
                      onChange={(e) => updatePointLoadVal(pl.id, parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: '#f97316', height: '4px' }}
                    />
                  </div>
                </div>
              ))}
              {pointLoads.length === 0 && (
                <div style={{ fontSize: '11px', color: '#64748b', fontStyle: 'italic', textAlign: 'center', padding: '6px 0' }}>
                  Brak sił skupionych. Dodaj siłę przyciskiem powyżej.
                </div>
              )}
            </div>
          </div>

          {/* Load */}
          <div className="properties-panel__section">
            <div className="properties-panel__section-title">Obciążenie ciągłe</div>
            <label className="param-label" htmlFor="param-load">
              Obciążenie ciągłe [kN/m]
            </label>
            <div className="param-input-group">
              <input
                id="param-load"
                type="range"
                min="1"
                max="100"
                step="1"
                value={loadValue}
                onChange={(e) => setLoadValue(parseFloat(e.target.value))}
                className="param-range"
              />
              <span className="param-value mono-value">{loadValue.toFixed(1)}</span>
            </div>
          </div>

          {/* Section */}
          <div className="properties-panel__section">
            <div className="properties-panel__section-title">Przekrój</div>
            <label className="param-label" htmlFor="param-section">
              Profil stalowy
            </label>
            <select
              id="param-section"
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
              className="param-select"
            >
              <option value="IPE200">IPE 200</option>
              <option value="IPE300">IPE 300</option>
              <option value="IPE400">IPE 400</option>
              <option value="HEB200">HEB 200</option>
              <option value="HEB300">HEB 300</option>
            </select>
          </div>

          {/* AI Section Recommendation */}
          {optResults && optResults.success && (
            <div className="properties-panel__section">
              <div className="properties-panel__section-title">Optymalizacja Przekroju AI</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
                
                {/* Cheapest (Najtańszy) */}
                {optResults.cheapest && (
                  <div 
                    onClick={() => setSectionId(optResults.cheapest!.name.replace(' ', ''))}
                    style={{ 
                      background: sectionId === optResults.cheapest.name.replace(' ', '') ? 'rgba(16, 185, 129, 0.12)' : 'rgba(255,255,255,0.02)', 
                      border: sectionId === optResults.cheapest.name.replace(' ', '') ? '1px solid #10b981' : '1px solid rgba(255,255,255,0.06)',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                    className="opt-card"
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#10b981' }}>🟢 Najtańszy profil</span>
                      <span className="mono-value" style={{ fontSize: '10px', color: '#64748b' }}>{optResults.cheapest.weight.toFixed(1)} kg/m</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#e2e8f0' }}>{optResults.cheapest.name}</span>
                      <span className="mono-value" style={{ fontSize: '11px', fontWeight: '600', color: optResults.cheapest.utilization_sgn > 0.95 ? '#ef4444' : '#f59e0b' }}>
                        Wytężenie: {(optResults.cheapest.utilization_sgn * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '4px' }}>
                      Ugięcie: {optResults.cheapest.deflection_sgu.toFixed(1)} mm / {optResults.cheapest.limit_sgu.toFixed(1)} mm
                    </div>
                  </div>
                )}

                {/* Lightest (Najlżejszy) */}
                {optResults.lightest && (
                  <div 
                    onClick={() => setSectionId(optResults.lightest!.name.replace(' ', ''))}
                    style={{ 
                      background: sectionId === optResults.lightest.name.replace(' ', '') ? 'rgba(6, 182, 212, 0.12)' : 'rgba(255,255,255,0.02)', 
                      border: sectionId === optResults.lightest.name.replace(' ', '') ? '1px solid #06b6d4' : '1px solid rgba(255,255,255,0.06)',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                    className="opt-card"
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#06b6d4' }}>⚡ Najlżejszy profil (Eco)</span>
                      <span className="mono-value" style={{ fontSize: '10px', color: '#64748b' }}>{optResults.lightest.weight.toFixed(1)} kg/m</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#e2e8f0' }}>{optResults.lightest.name}</span>
                      <span className="mono-value" style={{ fontSize: '11px', fontWeight: '600', color: optResults.lightest.utilization_sgn > 0.95 ? '#ef4444' : '#f59e0b' }}>
                        Wytężenie: {(optResults.lightest.utilization_sgn * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '4px' }}>
                      Ugięcie: {optResults.lightest.deflection_sgu.toFixed(1)} mm / {optResults.lightest.limit_sgu.toFixed(1)} mm
                    </div>
                  </div>
                )}

                {/* Balanced (Zrównoważony) */}
                {optResults.balanced && (
                  <div 
                    onClick={() => setSectionId(optResults.balanced!.name.replace(' ', ''))}
                    style={{ 
                      background: sectionId === optResults.balanced.name.replace(' ', '') ? 'rgba(139, 92, 246, 0.12)' : 'rgba(255,255,255,0.02)', 
                      border: sectionId === optResults.balanced.name.replace(' ', '') ? '1px solid #8b5cf6' : '1px solid rgba(255,255,255,0.06)',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                    className="opt-card"
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#8b5cf6' }}>⚖ Zrównoważony profil (60-70%)</span>
                      <span className="mono-value" style={{ fontSize: '10px', color: '#64748b' }}>{optResults.balanced.weight.toFixed(1)} kg/m</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#e2e8f0' }}>{optResults.balanced.name}</span>
                      <span className="mono-value" style={{ fontSize: '11px', fontWeight: '600', color: '#8b5cf6' }}>
                        Wytężenie: {(optResults.balanced.utilization_sgn * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '4px' }}>
                      Ugięcie: {optResults.balanced.deflection_sgu.toFixed(1)} mm / {optResults.balanced.limit_sgu.toFixed(1)} mm
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Results */}
          {results && (() => {
            const maxDeflection = Math.max(...results.map(r => Math.abs(r.deflection)));
            const maxMoment = Math.max(...results.map(r => Math.abs(r.moment)));
            const maxShear = Math.max(...results.map(r => Math.abs(r.shear)));

            return (
              <div className="properties-panel__section">
                <div className="properties-panel__section-title">Wyniki Analizy</div>

                <div className="result-card result-card--moment">
                  <div className="result-card__label">Moment zginający max</div>
                  <div className="result-card__value">
                    {maxMoment.toFixed(2)}
                    <span className="result-card__unit">kNm</span>
                  </div>
                </div>

                <div className="result-card result-card--shear">
                  <div className="result-card__label">Siła tnąca max</div>
                  <div className="result-card__value">
                    {maxShear.toFixed(2)}
                    <span className="result-card__unit">kN</span>
                  </div>
                </div>

                <div className="result-card result-card--deflection">
                  <div className="result-card__label">Ugięcie max</div>
                  <div className="result-card__value">
                    {maxDeflection.toFixed(3)}
                    <span className="result-card__unit">mm</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </aside>
      </div>

      {/* ===== Status Bar ===== */}
      <footer className="status-bar">
        <div className="status-bar__left">
          <div className="status-bar__indicator">
            <div className="status-bar__dot" />
            <span>Solver MES gotowy</span>
          </div>
          <span className="mono-value" style={{ fontSize: '11px' }}>
            Przęsła: {supports.length - 1} | {sectionId} | S235
          </span>
        </div>
        <div className="status-bar__right">
          <span>L = {beamLength}m</span>
          <span>q = {loadValue} kN/m</span>
          {solveTimeMs !== null && (
            <span className="mono-value">t = {solveTimeMs}ms</span>
          )}
        </div>
      </footer>
    </div>
  );
}
