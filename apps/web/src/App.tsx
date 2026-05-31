import { useState, useEffect, useCallback } from 'react';
import Canvas2D, { type ResultPoint } from './components/Canvas2D';
import Canvas3D from './components/Canvas3D';
import { Layers, Box } from 'lucide-react';
import { generateSteelReport, generateConcreteReport } from './utils/latexGenerator';

// =============================================================================
// WASM Solver Integration
// =============================================================================

type SolveFn = (input: any) => any;
let solveMeshFn: SolveFn | null = null;
let solveMesh3dFn: SolveFn | null = null;
let optimizeSectionsFn: SolveFn | null = null;
let designRcSectionFn: ((m_ed_k_nm: number, profile_val: any) => any) | null = null;

async function initWasm(): Promise<boolean> {
  try {
    const wasmModule = await import('solver-wasm');
    await wasmModule.default();
    solveMeshFn = wasmModule.solve_mesh;
    solveMesh3dFn = wasmModule.solve_mesh_3d;
    optimizeSectionsFn = wasmModule.optimize_sections;
    designRcSectionFn = wasmModule.design_rc_section;
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
  type: 'Pinned' | 'Roller' | 'Fixed';
}

export type ToolMode = 'select' | 'draw_beam' | 'add_point_load' | 'add_support_pinned' | 'add_support_roller' | 'add_support_fixed';
export type AppMode = '2d' | '3d';

// =============================================================================
// App Component
// =============================================================================

export default function App() {
  const [appMode, setAppMode] = useState<AppMode>('2d');
  const [activeTool, setActiveTool] = useState<ToolMode>('select');
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

  // Reinforced Concrete Design States (Faza 3)
  const [designType, setDesignType] = useState<'steel' | 'concrete'>('steel');
  const [rcWidth, setRcWidth] = useState<number>(30); // cm
  const [rcHeight, setRcHeight] = useState<number>(50); // cm
  const [rcCover, setRcCover] = useState<number>(3.5); // cm
  const [rcConcreteClass, setRcConcreteClass] = useState<'C20/25' | 'C25/30' | 'C30/37'>('C25/30');
  const [rcSteelGrade, setRcSteelGrade] = useState<number>(500); // MPa
  const [rcResult, setRcResult] = useState<any | null>(null);

  // 3D Parametric Generator States
  const [width3D, setWidth3D] = useState(6.0); // B (m)
  const [height3D, setHeight3D] = useState(4.0); // H (m)
  const [slope3D, setSlope3D] = useState(15.0); // alpha (deg)
  const [length3D, setLength3D] = useState(6.0); // L (m)
  const [bays3D, setBays3D] = useState(2); // n_bays
  const [results3D, setResults3D] = useState<any | null>(null);
  const [inputModel3D, setInputModel3D] = useState<any | null>(null);

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

  const addSupport = (x: number = beamLength / 2, type: 'Pinned' | 'Roller' | 'Fixed' = 'Roller') => {
    if (supports.length >= 10) return;
    const clampedX = Math.min(Math.max(x, 0), beamLength);
    setSupports(prev => {
      return [...prev, { id: 'S_' + Date.now(), x: parseFloat(clampedX.toFixed(1)), type }].sort((a, b) => a.x - b.x);
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

  const updateSupportType = (id: string, type: 'Pinned' | 'Roller' | 'Fixed') => {
    setSupports(prev => {
      return prev.map(s => (s.id === id ? { ...s, type } : s));
    });
  };

  const addPointLoad = (x: number = beamLength / 2, value: number = -50) => {
    if (pointLoads.length >= 5) return;
    const clampedX = Math.min(Math.max(x, 0.1), beamLength - 0.1);
    setPointLoads(prev => [
      ...prev,
      {
        id: `PL_${Date.now()}`,
        x: parseFloat(clampedX.toFixed(1)),
        value,
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
      geometry: { length: beamLength }
    };

    const t0 = performance.now();
    const output = solveMeshFn ? solveMeshFn(inputModel) : mockSolver(inputModel);
    const t1 = performance.now();
    setSolveTimeMs(Math.round((t1 - t0) * 100) / 100);

    if (output && output.success) {
      setResults(output.results);

      // Faza 3: Obliczenie Wymiarowania Żelbetu
      if (designType === 'concrete') {
        const maxMoment = Math.max(...output.results.map((r: any) => Math.abs(r.moment)));
        const fckVal = rcConcreteClass === 'C20/25' ? 20.0 : rcConcreteClass === 'C25/30' ? 25.0 : 30.0;
        const profile = {
          width: rcWidth / 100.0,
          height: rcHeight / 100.0,
          cover: rcCover / 100.0,
          fck: fckVal,
          fyk: rcSteelGrade,
        };

        if (designRcSectionFn) {
          const res = designRcSectionFn(maxMoment, profile);
          setRcResult(res);
        } else {
          // Mock / Fallback calculations
          const b_m = rcWidth / 100.0;
          const h_m = rcHeight / 100.0;
          const cover_m = rcCover / 100.0;
          const fcd = fckVal / 1.5;
          const fyd = rcSteelGrade / 1.15;
          const d_val = h_m - cover_m - 0.01;
          
          let is_over = false;
          let mi_val = 0;
          let as_req_val = 0;
          let as_min_val = 0;

          if (d_val > 0) {
            const m_ed_mnm = maxMoment / 1000.0;
            const denom = b_m * d_val * d_val * fcd;
            mi_val = denom > 0 ? m_ed_mnm / denom : 999.0;
            if (mi_val > 0.372) {
              is_over = true;
            } else {
              const xi_val = 1.25 * (1.0 - Math.sqrt(1.0 - 2.0 * mi_val));
              const z_val = d_val * (1.0 - 0.4 * xi_val);
              as_req_val = (m_ed_mnm / (z_val * fyd)) * 10000.0;
              
              const fctm = 0.3 * Math.pow(fckVal, 2.0 / 3.0);
              const term1 = 0.26 * (fctm / rcSteelGrade) * b_m * d_val;
              const term2 = 0.0013 * b_m * d_val;
              as_min_val = Math.max(term1, term2) * 10000.0;
            }
          } else {
            is_over = true;
          }

          setRcResult({
            d: d_val,
            mi: mi_val,
            as_req: as_req_val,
            as_min: as_min_val,
            is_overreinforced: is_over,
          });
        }
      }
    } else {
      console.error('[StructurAI] Solver error:', output?.error);
    }

    // Run AI section optimization in real-time if steel mode is selected
    if (designType === 'steel') {
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
        const currentLength = inputModel.geometry.length || 5.0;
        const sguLimit = (currentLength * 1000) / 250; // mm
        setOptResults({
          success: true,
          error: null,
          cheapest: { name: 'IPE 140', utilization_sgn: 0.88, deflection_sgu: 18.2, limit_sgu: sguLimit, weight: 12.9, price_factor: 1.0 },
          lightest: { name: 'IPE 140', utilization_sgn: 0.88, deflection_sgu: 18.2, limit_sgu: sguLimit, weight: 12.9, price_factor: 1.0 },
          balanced: { name: 'IPE 200', utilization_sgn: 0.44, deflection_sgu: 5.1, limit_sgu: sguLimit, weight: 22.4, price_factor: 1.0 }
        });
      }
    }
  }, [
    beamLength,
    loadValue,
    sectionId,
    supports,
    pointLoads,
    designType,
    rcWidth,
    rcHeight,
    rcCover,
    rcConcreteClass,
    rcSteelGrade,
  ]);

  // Auto-solve on parameter change (real-time!)
  useEffect(() => {
    if (wasmReady) solve();
  }, [wasmReady, solve]);

  const generateParametricModel3D = useCallback((width: number, height: number, alpha: number, bayLength: number, bays: number) => {
    const nodes: any[] = [];
    const elements: any[] = [];
    const loads: any[] = [];

    const alpha_rad = (alpha * Math.PI) / 180;
    const H_ridge = height + Math.tan(alpha_rad) * (width / 2);

    // Generate nodes
    for (let b = 0; b <= bays; b++) {
      const z = b * bayLength;
      // Left column base
      nodes.push({ id: `N_base_L_${b}`, x: -width/2, y: 0, z, support_type: 'Fixed' });
      // Right column base
      nodes.push({ id: `N_base_R_${b}`, x: width/2, y: 0, z, support_type: 'Fixed' });
      // Left column top (eaves)
      nodes.push({ id: `N_eaves_L_${b}`, x: -width/2, y: height, z, support_type: 'Free' });
      // Right column top (eaves)
      nodes.push({ id: `N_eaves_R_${b}`, x: width/2, y: height, z, support_type: 'Free' });
      // Ridge node (roof top center)
      nodes.push({ id: `N_ridge_${b}`, x: 0, y: H_ridge, z, support_type: 'Free' });
    }

    // Standard IPE200 properties for portal frame members:
    // E = 210 GPa, G = 80 GPa, A = 28.5 cm2 = 2.85e-3 m2
    // Iy = 1943 cm4 = 1.943e-5 m4 (major axis iz in 3D), Iz = 142 cm4 = 1.42e-6 m4 (minor axis iy in 3D)
    // J = 7 cm4 = 7e-8 m4
    const E = 210e9;
    const G = 80e9;
    const area = 2.85e-3;
    const iz = 1.943e-5;
    const iy = 1.42e-6;
    const j = 7e-8;

    for (let b = 0; b <= bays; b++) {
      // Columns
      elements.push({ id: `Col_L_${b}`, start_node_id: `N_base_L_${b}`, end_node_id: `N_eaves_L_${b}`, e: E, g: G, area, iy, iz, j });
      elements.push({ id: `Col_R_${b}`, start_node_id: `N_base_R_${b}`, end_node_id: `N_eaves_R_${b}`, e: E, g: G, area, iy, iz, j });
      
      // Rafters
      elements.push({ id: `Raf_L_${b}`, start_node_id: `N_eaves_L_${b}`, end_node_id: `N_ridge_${b}`, e: E, g: G, area, iy, iz, j });
      elements.push({ id: `Raf_R_${b}`, start_node_id: `N_ridge_${b}`, end_node_id: `N_eaves_R_${b}`, e: E, g: G, area, iy, iz, j });
    }

    // Longitudinal elements (purlins and girts connecting bays)
    for (let b = 0; b < bays; b++) {
      // Eaves girts
      elements.push({ id: `Girt_L_${b}`, start_node_id: `N_eaves_L_${b}`, end_node_id: `N_eaves_L_${b+1}`, e: E, g: G, area: area * 0.5, iy: iy * 0.5, iz: iz * 0.5, j: j * 0.5 });
      elements.push({ id: `Girt_R_${b}`, start_node_id: `N_eaves_R_${b}`, end_node_id: `N_eaves_R_${b+1}`, e: E, g: G, area: area * 0.5, iy: iy * 0.5, iz: iz * 0.5, j: j * 0.5 });
      
      // Ridge purlins
      elements.push({ id: `Purlin_R_${b}`, start_node_id: `N_ridge_${b}`, end_node_id: `N_ridge_${b+1}`, e: E, g: G, area: area * 0.5, iy: iy * 0.5, iz: iz * 0.5, j: j * 0.5 });

      // X-bracing in the first and last bays (diagonal members)
      if (b === 0 || b === bays - 1) {
        elements.push({ id: `Brace_Col_L_${b}`, start_node_id: `N_base_L_${b}`, end_node_id: `N_eaves_L_${b+1}`, e: E, g: G, area: area * 0.2, iy: iy * 0.1, iz: iz * 0.1, j: j * 0.1 });
        elements.push({ id: `Brace_Col_R_${b}`, start_node_id: `N_base_R_${b}`, end_node_id: `N_eaves_R_${b+1}`, e: E, g: G, area: area * 0.2, iy: iy * 0.1, iz: iz * 0.1, j: j * 0.1 });
      }
    }

    // Apply some sample loads
    for (let b = 0; b <= bays; b++) {
      loads.push({
        node_id: `N_ridge_${b}`,
        fx: 0.0,
        fy: -25000.0, // -25 kN downward
        fz: 0.0,
        mx: 0.0,
        my: 0.0,
        mz: 0.0,
      });
      loads.push({
        node_id: `N_eaves_L_${b}`,
        fx: 12000.0, // 12 kN lateral wind
        fy: 0.0,
        fz: 0.0,
        mx: 0.0,
        my: 0.0,
        mz: 0.0,
      });
    }

    const distributed_loads: any[] = [];
    for (let b = 0; b <= bays; b++) {
      distributed_loads.push({
        element_id: `Raf_L_${b}`,
        value: -1200.0, // -1.2 kN/m vertical distributed load
      });
      distributed_loads.push({
        element_id: `Raf_R_${b}`,
        value: -1200.0, // -1.2 kN/m vertical distributed load
      });
    }

    return {
      nodes,
      elements,
      geometry: { nodes, elements },
      loads,
      distributed_loads
    };
  }, []);

  const solve3D = useCallback(() => {
    const bayLength = length3D / bays3D;
    const inputModel3D = generateParametricModel3D(width3D, height3D, slope3D, bayLength, bays3D);
    setInputModel3D(inputModel3D);
    if (solveMesh3dFn) {
      const startTime = performance.now();
      const output = solveMesh3dFn(inputModel3D);
      const endTime = performance.now();
      if (output && output.success) {
        setResults3D({ ...output, model: inputModel3D });
        setSolveTimeMs(endTime - startTime);
      } else {
        console.error('[StructurAI] 3D Solver error:', output?.error);
      }
    } else {
      const mockResultNodes = inputModel3D.nodes.map(n => {
        const isRidge = n.id.includes('ridge');
        const isEaves = n.id.includes('eaves');
        return {
          id: n.id,
          ux: isEaves ? 12.5 : 0.0,
          uy: isRidge ? -18.2 : isEaves ? -8.4 : 0.0,
          uz: 0.0,
          rx: 0.0,
          ry: 0.0,
          rz: 0.0,
        };
      });
      const mockResultElements = inputModel3D.elements.map(el => {
        return {
          id: el.id,
          fx_start: 0, fy_start: 0, fz_start: 0, mx_start: 0, my_start: 0, mz_start: el.id.includes('Col') ? -15.4 : -32.5,
          fx_end: 0, fy_end: 0, fz_end: 0, mx_end: 0, my_end: 0, mz_end: el.id.includes('Col') ? 32.5 : 15.4,
        };
      });
      setResults3D({
        success: true,
        error: null,
        nodes: mockResultNodes,
        elements: mockResultElements,
        model: inputModel3D,
      });
    }
  }, [width3D, height3D, slope3D, length3D, bays3D, generateParametricModel3D]);

  useEffect(() => {
    if (appMode === '3d') {
      solve3D();
    }
  }, [appMode, solve3D]);

  const handleDownloadReport = () => {
    if (!results) return;
    const maxMoment = Math.max(...results.map(r => Math.abs(r.moment)));
    let latexContent = '';
    let filename = 'raport_projektowy.tex';

    if (designType === 'concrete') {
      if (!rcResult) return;
      const fckVal = rcConcreteClass === 'C20/25' ? 20.0 : rcConcreteClass === 'C25/30' ? 25.0 : 30.0;
      latexContent = generateConcreteReport(
        maxMoment,
        rcWidth,
        rcHeight,
        rcCover,
        fckVal,
        rcSteelGrade,
        rcResult.d,
        rcResult.mi,
        rcResult.as_req,
        rcResult.as_min,
        rcResult.is_overreinforced
      );
      filename = `raport_zelbet_${rcWidth}x${rcHeight}_${rcConcreteClass}.tex`;
    } else {
      // Steel
      let wy = 194.0; // standard IPE 200
      if (sectionId === 'IPE300') wy = 557.0;
      else if (sectionId === 'IPE400') wy = 1160.0;
      else if (sectionId === 'HEB200') wy = 570.0;
      else if (sectionId === 'HEB300') wy = 1680.0;

      let utilization = 0.5;
      let deflection = 5.0;
      let limit_sgu = 20.0;

      if (optResults && optResults.success) {
        const activeName = sectionId.replace('HEB', 'HEB ').replace('IPE', 'IPE ');
        let activeOpt = optResults.cheapest;
        if (optResults.lightest?.name === activeName) activeOpt = optResults.lightest;
        if (optResults.balanced?.name === activeName) activeOpt = optResults.balanced;
        
        if (activeOpt) {
          utilization = activeOpt.utilization_sgn;
          deflection = activeOpt.deflection_sgu;
          limit_sgu = activeOpt.limit_sgu;
        }
      }

      latexContent = generateSteelReport(
        maxMoment,
        sectionId.replace('HEB', 'HEB ').replace('IPE', 'IPE '),
        wy,
        235, // S235
        utilization,
        deflection,
        limit_sgu
      );
      filename = `raport_stal_${sectionId}.tex`;
    }

    const blob = new Blob([latexContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleSketchComplete = (newLength: number) => {
    setBeamLength(newLength);
    // Automatyczne ustawienie podpór na krańcach narysowanej belki
    setSupports([
      { id: 'S1', x: 0, type: 'Pinned' },
      { id: 'S2', x: newLength, type: 'Pinned' }
    ]);
    // Wyczyszczenie starych obciążeń skupionych, bo mogły znaleźć się poza belką
    setPointLoads([]); 
    setActiveTool('select');
  };

  const handleCanvasClick = (xMeters: number) => {
    // Zaokrąglamy kliknięcie do 0.1m dla równego wymiarowania
    const roundedX = Math.round(xMeters * 10) / 10;
    if (activeTool === 'add_support_pinned') {
      addSupport(roundedX, 'Pinned');
      setActiveTool('select');
    } else if (activeTool === 'add_support_roller') {
      addSupport(roundedX, 'Roller');
      setActiveTool('select');
    } else if (activeTool === 'add_support_fixed') {
      addSupport(roundedX, 'Fixed');
      setActiveTool('select');
    } else if (activeTool === 'add_point_load') {
      addPointLoad(roundedX, -50);
      setActiveTool('select');
    }
  };

  const sortedSupportsForModel = [...supports].sort((a, b) => a.x - b.x);
  const nodesForModel = sortedSupportsForModel.map((s, idx) => ({
    id: `N${idx}`,
    x: s.x,
    support_type: s.type === 'Roller' ? 'Pinned' : s.type, // Map Roller to Pinned for the solver
  }));
  const elementsForModel = [];
  let EForModel = 210e9;
  let IForModel = 1.943e-5;
  if (sectionId === 'IPE300') { IForModel = 8.356e-5; }
  else if (sectionId === 'IPE400') { IForModel = 2.313e-4; }
  else if (sectionId === 'HEB200') { IForModel = 5.696e-5; }
  else if (sectionId === 'HEB300') { IForModel = 2.517e-4; }

  for (let i = 0; i < nodesForModel.length - 1; i++) {
    elementsForModel.push({
      id: `E${i}`,
      start_node_id: nodesForModel[i].id,
      end_node_id: nodesForModel[i + 1].id,
      e: EForModel,
      i_inertia: IForModel,
    });
  }
  const inputModel = {
    nodes: nodesForModel,
    elements: elementsForModel,
    distributed_loads: elementsForModel.map(el => ({
      element_id: el.id,
      value: -loadValue,
    })),
    point_loads: pointLoads.map(pl => ({
      x: pl.x,
      value: pl.value,
    })),
    geometry: { length: beamLength }
  };

  const result = { results };

  return (
    <div className="app-layout">
      {/* ===== Global Header ===== */}
      <header className="topbar">
        <div className="topbar__logo">StructurAI Dynamics</div>
        
        <div style={{
          display: 'flex',
          background: 'rgba(0,0,0,0.4)',
          padding: '4px',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.05)',
          gap: '4px'
        }}>
          <button
            onClick={() => setAppMode('2d')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 16px',
              borderRadius: '6px',
              border: 'none',
              background: appMode === '2d' ? '#3b82f6' : 'transparent',
              color: appMode === '2d' ? '#ffffff' : '#94a3b8',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s ease'
            }}
          >
            <Layers size={16} />
            Pulpit 2D
          </button>
          <button
            onClick={() => setAppMode('3d')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 16px',
              borderRadius: '6px',
              border: 'none',
              background: appMode === '3d' ? '#8b5cf6' : 'transparent',
              color: appMode === '3d' ? '#ffffff' : '#94a3b8',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s ease'
            }}
          >
            <Box size={16} />
            Przestrzeń 3D (Pro)
          </button>
        </div>

        <div className="topbar__status">
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
        <nav className="toolbar" style={{ opacity: appMode === '3d' ? 0.5 : 1, transition: 'opacity 0.2s' }}>
          <button 
            className={`toolbar__btn ${activeTool === 'select' ? 'toolbar__btn--active' : ''}`} 
            data-tooltip={appMode === '3d' ? "Wskaźnik (tylko 2D)" : "Wskaźnik (Wybierz)"} 
            onClick={() => setActiveTool('select')}
            id="tool-select"
            disabled={appMode === '3d'}
          >
            ◇
          </button>
          <button 
            className="toolbar__btn" 
            data-tooltip="Dodaj węzeł" 
            id="tool-node"
            disabled
          >
            ⊕
          </button>
          <button 
            className={`toolbar__btn ${activeTool === 'draw_beam' ? 'toolbar__btn--active' : ''}`} 
            data-tooltip={appMode === '3d' ? "Rysuj belkę (tylko 2D)" : "Rysuj belkę (Odręczny szkic)"} 
            onClick={() => setActiveTool('draw_beam')}
            id="tool-beam"
            disabled={appMode === '3d'}
          >
            ✏
          </button>
          <div className="toolbar__separator" />
          <button 
            className={`toolbar__btn ${activeTool === 'add_support_pinned' ? 'toolbar__btn--active' : ''}`} 
            data-tooltip={appMode === '3d' ? "Dodaj podporę (tylko 2D)" : "Dodaj podporę stałą (przegubową)"} 
            onClick={() => setActiveTool('add_support_pinned')}
            id="tool-pinned"
            disabled={appMode === '3d'}
          >
            △
          </button>
          <button 
            className={`toolbar__btn ${activeTool === 'add_support_roller' ? 'toolbar__btn--active' : ''}`} 
            data-tooltip={appMode === '3d' ? "Dodaj podporę (tylko 2D)" : "Dodaj podporę przesuwną"} 
            onClick={() => setActiveTool('add_support_roller')}
            id="tool-roller"
            disabled={appMode === '3d'}
          >
            ○
          </button>
          <button 
            className={`toolbar__btn ${activeTool === 'add_support_fixed' ? 'toolbar__btn--active' : ''}`} 
            data-tooltip={appMode === '3d' ? "Dodaj utwierdzenie (tylko 2D)" : "Dodaj utwierdzenie"} 
            onClick={() => setActiveTool('add_support_fixed')}
            id="tool-fixed"
            disabled={appMode === '3d'}
          >
            ◫
          </button>
          <div className="toolbar__separator" />
          <button 
            className={`toolbar__btn ${activeTool === 'add_point_load' ? 'toolbar__btn--active' : ''}`} 
            data-tooltip={appMode === '3d' ? "Dodaj obciążenie (tylko 2D)" : "Dodaj obciążenie skupione"} 
            onClick={() => setActiveTool('add_point_load')}
            id="tool-point-load"
            disabled={appMode === '3d'}
          >
            ↓
          </button>
          <button className="toolbar__btn" data-tooltip="Obciążenie ciągłe" id="tool-dist-load" disabled>
            ⇣
          </button>
          <div className="toolbar__separator" />
          <button 
            className="toolbar__btn" 
            data-tooltip={appMode === '3d' ? "Solver (tylko 2D)" : "Uruchom solver"} 
            onClick={solve} 
            id="tool-solve"
            disabled={appMode === '3d'}
          >
            ▶
          </button>
        </nav>

        {/* ----- Canvas Area ----- */}
        <div className="canvas-area canvas-grid">
          {appMode === '3d' ? (
            <Canvas3D model={inputModel3D} result={results3D} />
          ) : !results ? (
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
            <Canvas2D 
              model={inputModel} 
              result={result} 
              activeTool={activeTool} 
              onSketchComplete={handleSketchComplete} 
              onCanvasClick={handleCanvasClick}
            />
          )}
        </div>

        {/* ----- Right Properties Panel ----- */}
        <aside className="properties-panel">
          <div className="properties-panel__header">
            <span className="properties-panel__title">Parametry</span>
          </div>

          {/* Material / Design Toggle (Faza 3) */}
          <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <button
              onClick={() => setDesignType('steel')}
              style={{
                flex: 1,
                padding: '12px',
                background: designType === 'steel' ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                border: 'none',
                borderBottom: designType === 'steel' ? '2px solid #3b82f6' : '2px solid transparent',
                color: designType === 'steel' ? '#3b82f6' : '#94a3b8',
                fontWeight: 'bold',
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              id="toggle-design-steel"
            >
              🏗 Stal (Optymalizacja)
            </button>
            <button
              onClick={() => setDesignType('concrete')}
              style={{
                flex: 1,
                padding: '12px',
                background: designType === 'concrete' ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                border: 'none',
                borderBottom: designType === 'concrete' ? '2px solid #10b981' : '2px solid transparent',
                color: designType === 'concrete' ? '#10b981' : '#94a3b8',
                fontWeight: 'bold',
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              id="toggle-design-concrete"
            >
              🧱 Żelbet (EC2)
            </button>
          </div>

          {appMode === '3d' ? (
            <div style={{ padding: '16px', color: '#94a3b8' }}>
              {/* Generator Info Widget */}
              <div style={{
                background: 'rgba(139, 92, 246, 0.1)',
                border: '1px solid rgba(139, 92, 246, 0.2)',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px'
              }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#c4b5fd', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Box size={16} /> Parametry Ramy 3D Pro
                </h3>
                <p style={{ margin: '0 0 16px 0', fontSize: '12px', lineHeight: 1.5 }}>
                  Parametryczny generator hal stalowych o 6 stopniach swobody (DOF) na węzeł. Modyfikuj parametry, aby wyliczyć siły w czasie rzeczywistym.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span>Aktywny solver</span>
                    <span style={{ color: '#8b5cf6', fontWeight: 'bold' }}>solve_mesh_3d</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span>Stopnie swobody (DOF)</span>
                    <span style={{ color: '#fff' }}>6 na węzeł</span>
                  </div>
                </div>
              </div>

              {/* Sliders Area */}
              <div className="panel-section" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <h3 className="panel-heading">Geometria Przestrzenna</h3>

                {/* Width B */}
                <div className="param-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <label className="param-label" style={{ margin: 0 }}>Szerokość hali B [m]</label>
                    <span className="mono-value" style={{ color: '#8b5cf6', fontWeight: 'bold' }}>{width3D.toFixed(1)} m</span>
                  </div>
                  <input
                    type="range"
                    min="4.0"
                    max="20.0"
                    step="0.5"
                    value={width3D}
                    onChange={(e) => setWidth3D(parseFloat(e.target.value))}
                    style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                  />
                </div>

                {/* Height H */}
                <div className="param-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <label className="param-label" style={{ margin: 0 }}>Wysokość słupa H [m]</label>
                    <span className="mono-value" style={{ color: '#8b5cf6', fontWeight: 'bold' }}>{height3D.toFixed(1)} m</span>
                  </div>
                  <input
                    type="range"
                    min="3.0"
                    max="10.0"
                    step="0.5"
                    value={height3D}
                    onChange={(e) => setHeight3D(parseFloat(e.target.value))}
                    style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                  />
                </div>

                {/* Roof Slope Alpha */}
                <div className="param-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <label className="param-label" style={{ margin: 0 }}>Kąt nachylenia dachu α [°]</label>
                    <span className="mono-value" style={{ color: '#8b5cf6', fontWeight: 'bold' }}>{slope3D.toFixed(0)}°</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="45"
                    step="1"
                    value={slope3D}
                    onChange={(e) => setSlope3D(parseFloat(e.target.value))}
                    style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                  />
                </div>

                {/* Length L */}
                <div className="param-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <label className="param-label" style={{ margin: 0 }}>Długość całkowita L [m]</label>
                    <span className="mono-value" style={{ color: '#8b5cf6', fontWeight: 'bold' }}>{length3D.toFixed(1)} m</span>
                  </div>
                  <input
                    type="range"
                    min="3.0"
                    max="15.0"
                    step="0.5"
                    value={length3D}
                    onChange={(e) => setLength3D(parseFloat(e.target.value))}
                    style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                  />
                </div>

                {/* Bays n_bays */}
                <div className="param-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <label className="param-label" style={{ margin: 0 }}>Liczba segmentów (n_bays)</label>
                    <span className="mono-value" style={{ color: '#8b5cf6', fontWeight: 'bold' }}>{bays3D}</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    step="1"
                    value={bays3D}
                    onChange={(e) => setBays3D(parseInt(e.target.value))}
                    style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Sekcja: Geometria */}
              <div className="panel-section">
                <h3 className="panel-heading">Geometria Przęsła</h3>
                <div className="param-group">
                  <label className="param-label" htmlFor="param-length">Długość całkowita belki (L) [m]</label>
                  <div className="param-input-group">
                    <input 
                      id="param-length"
                      type="range" 
                      min="1.0" 
                      max="20.0" 
                      step="0.5" 
                      value={beamLength}
                      onChange={(e) => setBeamLength(parseFloat(e.target.value))}
                      className="param-range"
                    />
                    <span className="param-value mono-value">{beamLength.toFixed(1)}</span>
                  </div>
                </div>
              </div>

          {/* Supports */}
          <div className="properties-panel__section">
            <div className="properties-panel__section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Podpory belki</span>
              <button 
                className="btn btn--primary" 
                onClick={() => addSupport()} 
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
                      {supports.length > 2 && (
                        <button 
                          onClick={() => removeSupport(s.id)}
                          style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '12px', cursor: 'pointer', padding: 0, fontWeight: 'bold' }}
                          title="Usuń węzeł"
                        >
                          ✕
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
                      
                      <div style={{ display: 'flex', gap: '4px', flex: isEdge ? 1 : 'unset', justifyContent: isEdge ? 'flex-end' : 'flex-start' }}>
                        <button
                          onClick={() => updateSupportType(s.id, 'Roller')}
                          style={{
                            padding: '2px 8px',
                            fontSize: '11px',
                            borderRadius: '4px',
                            border: '1px solid rgba(255,255,255,0.1)',
                            background: s.type === 'Roller' ? '#2563eb' : 'rgba(0,0,0,0.3)',
                            color: '#fff',
                            cursor: 'pointer'
                          }}
                        >
                          Przesuwna
                        </button>
                        <button
                          onClick={() => updateSupportType(s.id, 'Pinned')}
                          style={{
                            padding: '2px 8px',
                            fontSize: '11px',
                            borderRadius: '4px',
                            border: '1px solid rgba(255,255,255,0.1)',
                            background: s.type === 'Pinned' ? '#2563eb' : 'rgba(0,0,0,0.3)',
                            color: '#fff',
                            cursor: 'pointer'
                          }}
                        >
                          Stała
                        </button>
                        <button
                          onClick={() => updateSupportType(s.id, 'Fixed')}
                          style={{
                            padding: '2px 8px',
                            fontSize: '11px',
                            borderRadius: '4px',
                            border: '1px solid rgba(255,255,255,0.1)',
                            background: s.type === 'Fixed' ? '#2563eb' : 'rgba(0,0,0,0.3)',
                            color: '#fff',
                            cursor: 'pointer'
                          }}
                        >
                          Utwierdzenie
                        </button>
                      </div>
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
                onClick={() => addPointLoad()} 
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
                      style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '12px', cursor: 'pointer', padding: 0, fontWeight: 'bold' }}
                      title="Usuń siłę"
                    >
                      ✕
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
            <div className="param-input-group" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                id="param-load"
                type="range"
                min="1"
                max="100"
                step="1"
                value={loadValue}
                onChange={(e) => setLoadValue(parseFloat(e.target.value))}
                className="param-range"
                style={{ flex: 1 }}
              />
              <input 
                type="number"
                min="1"
                max="1000"
                step="1"
                value={loadValue}
                onChange={(e) => setLoadValue(parseFloat(e.target.value) || 0)}
                style={{ width: '60px', background: 'rgba(0,0,0,0.3)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', padding: '2px 4px', textAlign: 'center' }}
              />
              <span className="param-value mono-value">{loadValue.toFixed(1)}</span>
            </div>
          </div>

          {/* Faza 3: Przekrój Stalowy lub Przekrój Żelbetowy */}
          {designType === 'steel' ? (
            <>
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
                  <div className="properties-panel__section-title">Optymalizator Generatywny</div>
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
            </>
          ) : (
            <>
              {/* Concrete Geometry */}
              <div className="properties-panel__section">
                <div className="properties-panel__section-title">Parametry Żelbetu (EC2)</div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
                  
                  {/* Width b */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <label className="param-label" style={{ margin: 0 }}>Szerokość belki b [cm]</label>
                      <span className="mono-value" style={{ color: '#10b981', fontWeight: 'bold' }}>{rcWidth} cm</span>
                    </div>
                    <input
                      type="range"
                      min="15"
                      max="80"
                      step="5"
                      value={rcWidth}
                      onChange={(e) => setRcWidth(parseInt(e.target.value))}
                      style={{ width: '100%', accentColor: '#10b981', height: '4px' }}
                      id="rc-param-width"
                    />
                  </div>

                  {/* Height h */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <label className="param-label" style={{ margin: 0 }}>Wysokość belki h [cm]</label>
                      <span className="mono-value" style={{ color: '#10b981', fontWeight: 'bold' }}>{rcHeight} cm</span>
                    </div>
                    <input
                      type="range"
                      min="20"
                      max="120"
                      step="5"
                      value={rcHeight}
                      onChange={(e) => setRcHeight(parseInt(e.target.value))}
                      style={{ width: '100%', accentColor: '#10b981', height: '4px' }}
                      id="rc-param-height"
                    />
                  </div>

                  {/* Cover cover */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <label className="param-label" style={{ margin: 0 }}>Otulina c_nom [cm]</label>
                      <span className="mono-value" style={{ color: '#10b981', fontWeight: 'bold' }}>{rcCover.toFixed(1)} cm</span>
                    </div>
                    <input
                      type="range"
                      min="2"
                      max="6"
                      step="0.5"
                      value={rcCover}
                      onChange={(e) => setRcCover(parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: '#10b981', height: '4px' }}
                      id="rc-param-cover"
                    />
                  </div>

                  {/* Concrete Class */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label className="param-label" style={{ margin: 0 }}>Klasa betonu</label>
                    <select
                      value={rcConcreteClass}
                      onChange={(e) => setRcConcreteClass(e.target.value as any)}
                      className="param-select"
                      id="rc-param-class"
                    >
                      <option value="C20/25">C20/25 (fck = 20 MPa)</option>
                      <option value="C25/30">C25/30 (fck = 25 MPa)</option>
                      <option value="C30/37">C30/37 (fck = 30 MPa)</option>
                    </select>
                  </div>

                  {/* Steel Grade */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label className="param-label" style={{ margin: 0 }}>Klasa stali zbrojeniowej</label>
                    <select
                      value={rcSteelGrade}
                      onChange={(e) => setRcSteelGrade(parseInt(e.target.value))}
                      className="param-select"
                      id="rc-param-steel"
                    >
                      <option value="500">S500 (fyk = 500 MPa)</option>
                      <option value="400">S400 (fyk = 400 MPa)</option>
                    </select>
                  </div>

                </div>
              </div>

              {/* Concrete Design Results Card */}
              {rcResult && (
                <div className="properties-panel__section">
                  <div className="properties-panel__section-title">Wymiarowanie Żelbetu</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
                    
                    {rcResult.is_overreinforced ? (
                      <div style={{ 
                        background: 'rgba(239, 68, 68, 0.15)', 
                        border: '1px solid #ef4444', 
                        padding: '12px', 
                        borderRadius: '8px',
                        color: '#fca5a5',
                        fontSize: '12px',
                        lineHeight: '1.4'
                      }} id="rc-result-overreinforced">
                        <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: '4px' }}>🔴 PRZEBROJENIE PRZEKROJU!</div>
                        Współczynnik mi = {rcResult.mi.toFixed(3)} przekracza wartość graniczną mi_lim = 0.372. 
                        Należy zwiększyć wysokość/szerokość belki lub podwyższyć klasę betonu.
                      </div>
                    ) : (
                      <>
                        <div style={{ 
                          background: 'rgba(16, 185, 129, 0.05)', 
                          border: '1px solid rgba(16, 185, 129, 0.2)', 
                          padding: '10px 12px', 
                          borderRadius: '8px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center'
                        }}>
                          <span style={{ fontSize: '11px', color: '#94a3b8' }}>Wysokość użyteczna d:</span>
                          <span className="mono-value" style={{ fontSize: '12px', fontWeight: 'bold', color: '#e2e8f0' }}>{(rcResult.d * 100).toFixed(1)} cm</span>
                        </div>

                        <div style={{ 
                          background: 'rgba(16, 185, 129, 0.05)', 
                          border: '1px solid rgba(16, 185, 129, 0.2)', 
                          padding: '10px 12px', 
                          borderRadius: '8px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center'
                        }}>
                          <span style={{ fontSize: '11px', color: '#94a3b8' }}>Moment względny mi:</span>
                          <span className="mono-value" style={{ fontSize: '12px', fontWeight: 'bold', color: '#e2e8f0' }}>{rcResult.mi.toFixed(3)}</span>
                        </div>

                        <div style={{ 
                          background: 'rgba(16, 185, 129, 0.1)', 
                          border: '1px solid #10b981', 
                          padding: '12px', 
                          borderRadius: '8px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px'
                        }} id="rc-result-success">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '11px', color: '#a7f3d0', fontWeight: '500' }}>Wymagane zbrojenie As,req:</span>
                            <span className="mono-value" style={{ fontSize: '14px', fontWeight: 'bold', color: '#10b981' }}>{rcResult.as_req.toFixed(2)} cm²</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '11px', color: '#a7f3d0', fontWeight: '500' }}>Minimalne zbrojenie As,min:</span>
                            <span className="mono-value" style={{ fontSize: '14px', fontWeight: 'bold', color: '#10b981' }}>{rcResult.as_min.toFixed(2)} cm²</span>
                          </div>
                          <div style={{ height: '1px', background: 'rgba(16, 185, 129, 0.2)', margin: '4px 0' }} />
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '12px', color: '#fff', fontWeight: 'bold' }}>Dobierz przekrój As:</span>
                            <span className="mono-value" style={{ fontSize: '15px', fontWeight: 'bold', color: '#10b981' }}>
                              {Math.max(rcResult.as_req, rcResult.as_min).toFixed(2)} cm²
                            </span>
                          </div>
                        </div>
                      </>
                    )}

                  </div>
                </div>
              )}
            </>
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

          {/* Raport Generator */}
          {results && (
            <div className="properties-panel__section" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '15px' }}>
              <button 
                className="btn btn--primary" 
                onClick={handleDownloadReport}
                style={{ 
                  width: '100%', 
                  background: designType === 'steel' 
                    ? 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)'
                    : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  boxShadow: designType === 'steel'
                    ? '0 4px 12px rgba(59, 130, 246, 0.3)'
                    : '0 4px 12px rgba(16, 185, 129, 0.3)',
                  border: 'none',
                  borderRadius: '8px',
                  fontWeight: 'bold',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: '8px',
                  height: '42px',
                  fontSize: '13px'
                }}
                id="btn-generate-report"
              >
                📄 Generuj Raport White-Box (.tex)
              </button>
            </div>
          )}
            </>
          )}
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
            Przęsła: {supports.length - 1} | {designType === 'steel' ? `${sectionId} | S235` : `${rcWidth}x${rcHeight}cm | ${rcConcreteClass}`}
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
