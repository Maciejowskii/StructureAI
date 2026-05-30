import { useState, useEffect, useCallback } from 'react';
import Canvas2D, { type ResultPoint } from './components/Canvas2D';

// =============================================================================
// WASM Solver Integration
// =============================================================================

type SolveFn = (input: any) => any;
let solveMeshFn: SolveFn | null = null;

async function initWasm(): Promise<SolveFn | null> {
  try {
    const wasmModule = await import('solver-wasm');
    await wasmModule.default();
    return wasmModule.solve_mesh;
  } catch (err) {
    console.warn('[StructurAI] WASM module not available, using mock solver:', err);
    return null;
  }
}

// Mock solver for development without WASM
function mockSolver(inputModel: any): any {
  try {
    const results: ResultPoint[] = [];
    const nodes = inputModel.nodes;
    const elements = inputModel.elements;
    const distributed_loads = inputModel.distributed_loads;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const startNode = nodes.find((n: any) => n.id === el.start_node_id);
      const endNode = nodes.find((n: any) => n.id === el.end_node_id);
      const length = endNode.x - startNode.x;

      const load = distributed_loads.find((ld: any) => ld.element_id === el.id);
      const q = Math.abs(load?.value || 10);
      const E = el.e;
      const I = el.i_inertia;

      // Simple parabolic approximation for fallback
      const numPoints = 50;
      for (let step = 0; step <= numPoints; step++) {
        const x_loc = (step / numPoints) * length;
        // deflection: 5qL^4/(384EI) * sin(pi*x/L)
        const deflMax = (5 * q * 1000 * Math.pow(length, 4)) / (384 * E * I) * 1000; // mm
        const deflection = -deflMax * Math.sin((Math.PI * x_loc) / length);

        // moment: qLx/2 - qx^2/2
        const moment = -((q * length * x_loc) / 2 - (q * x_loc * x_loc) / 2);

        // shear: qL/2 - qx
        const shear = -((q * length) / 2 - q * x_loc);

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
  const [beamLength, setBeamLength] = useState(5.0);
  const [loadValue, setLoadValue] = useState(10.0);
  const [sectionId, setSectionId] = useState('IPE200');
  const [solveTimeMs, setSolveTimeMs] = useState<number | null>(null);
  const [supports, setSupports] = useState<Support[]>([
    { id: 'S1', x: 0, type: 'Pinned' },
    { id: 'S2', x: 5.0, type: 'Pinned' },
  ]);

  // Initialize WASM
  useEffect(() => {
    initWasm().then((fn) => {
      if (fn) {
        solveMeshFn = fn;
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

    const inputModel = {
      nodes,
      elements,
      distributed_loads,
    };

    const t0 = performance.now();
    const output = solveMeshFn ? solveMeshFn(inputModel) : mockSolver(inputModel);
    const t1 = performance.now();
    setSolveTimeMs(Math.round((t1 - t0) * 100) / 100);

    if (output && output.success) {
      setResults(output.results);
      console.log('[StructurAI] Solver output points count:', output.results.length);
    } else {
      console.error('[StructurAI] Solver error:', output?.error);
    }
  }, [beamLength, loadValue, sectionId, supports]);

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
            <Canvas2D results={results} supports={supports} beamLength={beamLength} load={loadValue} />
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

          {/* Load */}
          <div className="properties-panel__section">
            <div className="properties-panel__section-title">Obciążenie</div>
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
