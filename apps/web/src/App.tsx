import { useState, useEffect, useCallback } from 'react';
import Canvas2D, { type BeamResults } from './components/Canvas2D';

// =============================================================================
// WASM Solver Integration
// =============================================================================

type SolveFn = (input: string) => string;
let solveStructure: SolveFn | null = null;

async function initWasm(): Promise<SolveFn | null> {
  try {
    const wasmModule = await import('solver-wasm');
    await wasmModule.default();
    return wasmModule.solve_structure;
  } catch (err) {
    console.warn('[StructurAI] WASM module not available, using mock solver:', err);
    return null;
  }
}

// Mock solver for development without WASM
function mockSolver(input: string): string {
  try {
    const model = JSON.parse(input);
    const element = model.geometry.elements[0];
    const startNode = model.geometry.nodes.find((n: { id: string }) => n.id === element.startNode);
    const endNode = model.geometry.nodes.find((n: { id: string }) => n.id === element.endNode);
    const length = Math.sqrt(
      Math.pow(endNode.x - startNode.x, 2) + Math.pow(endNode.z - startNode.z, 2)
    );
    const q = Math.abs(model.loads[0]?.value || 10);
    const E = 210_000_000; // kN/m²
    const I = 1943e-8;     // m⁴ (IPE200)

    const reaction = (q * length) / 2;
    const maxMoment = (q * length * length) / 8;
    const maxShear = reaction;
    const maxDeflection = (5 * q * Math.pow(length, 4)) / (384 * E * I) * 1000;

    const numStations = 21;
    const momentDiagram: number[] = [];
    const shearDiagram: number[] = [];
    const deflectionDiagram: number[] = [];

    for (let i = 0; i < numStations; i++) {
      const t = i / (numStations - 1);
      const x = t * length;

      momentDiagram.push(
        Math.round(((q * length * x) / 2 - (q * x * x) / 2) * 1000) / 1000
      );
      shearDiagram.push(
        Math.round(((q * length) / 2 - q * x) * 1000) / 1000
      );
      const defl = (q / (24 * E * I)) * x * (Math.pow(length, 3) - 2 * length * x * x + Math.pow(x, 3));
      deflectionDiagram.push(Math.round(defl * 1000 * 1000) / 1000);
    }

    return JSON.stringify({
      success: true,
      error: null,
      results: [{
        element_id: element.id,
        length,
        reaction_left: Math.round(reaction * 1000) / 1000,
        reaction_right: Math.round(reaction * 1000) / 1000,
        max_moment: Math.round(maxMoment * 1000) / 1000,
        max_moment_position: length / 2,
        max_shear: Math.round(maxShear * 1000) / 1000,
        max_deflection: Math.round(maxDeflection * 1000) / 1000,
        moment_diagram: momentDiagram,
        shear_diagram: shearDiagram,
        deflection_diagram: deflectionDiagram,
      }],
    });
  } catch {
    return JSON.stringify({ success: false, error: 'Mock solver parse error', results: [] });
  }
}

// =============================================================================
// App Component
// =============================================================================

export default function App() {
  const [wasmReady, setWasmReady] = useState(false);
  const [wasmError, setWasmError] = useState(false);
  const [results, setResults] = useState<BeamResults | null>(null);
  const [beamLength, setBeamLength] = useState(5.0);
  const [loadValue, setLoadValue] = useState(10.0);
  const [sectionId, setSectionId] = useState('IPE200');
  const [solveTimeMs, setSolveTimeMs] = useState<number | null>(null);

  // Initialize WASM
  useEffect(() => {
    initWasm().then((fn) => {
      if (fn) {
        solveStructure = fn;
        setWasmReady(true);
      } else {
        setWasmError(true);
        setWasmReady(true); // Still "ready" — will use mock
      }
    });
  }, []);

  // Solve function
  const solve = useCallback(() => {
    const input = JSON.stringify({
      project_id: 'poc-001',
      geometry: {
        nodes: [
          { id: 'N1', x: 0.0, z: 0.0, support: 'pinned' },
          { id: 'N2', x: beamLength, z: 0.0, support: 'roller_x' },
        ],
        elements: [
          {
            id: 'E1',
            startNode: 'N1',
            endNode: 'N2',
            section_id: sectionId,
            material_id: 'S235',
          },
        ],
      },
      loads: [
        {
          type: 'distributed',
          element: 'E1',
          value: -loadValue,
          direction: 'global_Z',
        },
      ],
    });

    const t0 = performance.now();
    const resultJson = solveStructure ? solveStructure(input) : mockSolver(input);
    const t1 = performance.now();
    setSolveTimeMs(Math.round((t1 - t0) * 100) / 100);

    try {
      const output = JSON.parse(resultJson);
      if (output.success && output.results.length > 0) {
        setResults(output.results[0]);
        console.log('[StructurAI] Solver output:', output.results[0]);
      } else {
        console.error('[StructurAI] Solver error:', output.error);
      }
    } catch (e) {
      console.error('[StructurAI] JSON parse error:', e);
    }
  }, [beamLength, loadValue, sectionId]);

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
            <Canvas2D results={results} beamLength={beamLength} load={loadValue} />
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
          {results && (
            <div className="properties-panel__section">
              <div className="properties-panel__section-title">Wyniki Analizy</div>

              <div className="result-card result-card--reaction">
                <div className="result-card__label">Reakcja podpór</div>
                <div className="result-card__value">
                  {results.reaction_left.toFixed(2)}
                  <span className="result-card__unit">kN</span>
                </div>
              </div>

              <div className="result-card result-card--moment">
                <div className="result-card__label">Moment zginający max</div>
                <div className="result-card__value">
                  {results.max_moment.toFixed(2)}
                  <span className="result-card__unit">kNm</span>
                </div>
              </div>

              <div className="result-card result-card--shear">
                <div className="result-card__label">Siła tnąca max</div>
                <div className="result-card__value">
                  {results.max_shear.toFixed(2)}
                  <span className="result-card__unit">kN</span>
                </div>
              </div>

              <div className="result-card result-card--deflection">
                <div className="result-card__label">Ugięcie max</div>
                <div className="result-card__value">
                  {results.max_deflection.toFixed(3)}
                  <span className="result-card__unit">mm</span>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* ===== Status Bar ===== */}
      <footer className="status-bar">
        <div className="status-bar__left">
          <div className="status-bar__indicator">
            <div className="status-bar__dot" />
            <span>Solver gotowy</span>
          </div>
          <span className="mono-value">
            Element: E1 | {sectionId} | S235
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
