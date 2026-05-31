import { useState, useEffect, useCallback } from 'react';
import Canvas2D, { type ResultPoint } from './components/Canvas2D';
import Canvas3D from './components/Canvas3D';
import { Layers, Box, Trash2 } from 'lucide-react';
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

export const STEEL_PROFILES_3D: Record<string, { area: number, iy: number, iz: number, j: number, wy: number, wz: number }> = {
  'IPE100': { area: 10.3, iz: 171, iy: 15.9, j: 1.2, wz: 34.2, wy: 5.79 },
  'IPE120': { area: 13.2, iz: 318, iy: 27.7, j: 1.74, wz: 53.0, wy: 8.65 },
  'IPE140': { area: 16.4, iz: 541, iy: 44.9, j: 2.45, wz: 77.3, wy: 12.3 },
  'IPE160': { area: 20.1, iz: 869, iy: 68.3, j: 3.6, wz: 109, wy: 16.7 },
  'IPE180': { area: 23.9, iz: 1317, iy: 101, j: 4.79, wz: 146, wy: 22.2 },
  'IPE200': { area: 28.5, iz: 1943, iy: 142, j: 6.98, wz: 194, wy: 28.5 },
  'IPE220': { area: 33.4, iz: 2772, iy: 205, j: 9.07, wz: 252, wy: 37.3 },
  'IPE240': { area: 39.1, iz: 3892, iy: 284, j: 12.9, wz: 324, wy: 47.3 },
  'IPE270': { area: 45.9, iz: 5790, iy: 420, j: 15.9, wz: 429, wy: 62.2 },
  'IPE300': { area: 53.8, iz: 8356, iy: 558, j: 20.1, wz: 557, wy: 80.5 },
  'IPE330': { area: 62.6, iz: 11770, iy: 788, j: 28.1, wz: 713, wy: 98.5 },
  'IPE360': { area: 72.7, iz: 16270, iy: 1043, j: 37.3, wz: 904, wy: 123 },
  'IPE400': { area: 84.5, iz: 23130, iy: 1318, j: 51.2, wz: 1160, wy: 146 },
  'HEB100': { area: 26.0, iz: 450, iy: 167, j: 9.25, wz: 89.9, wy: 33.5 },
  'HEB120': { area: 34.0, iz: 864, iy: 318, j: 14.5, wz: 144, wy: 52.9 },
  'HEB140': { area: 43.0, iz: 1509, iy: 550, j: 24.4, wz: 216, wy: 78.5 },
  'HEB160': { area: 52.7, iz: 2492, iy: 889, j: 36.5, wz: 311, wy: 111 },
  'HEB180': { area: 65.3, iz: 3831, iy: 1363, j: 54.8, wz: 426, wy: 151 },
  'HEB200': { area: 78.1, iz: 5696, iy: 2003, j: 59.3, wz: 570, wy: 200 },
  'HEB220': { area: 91.0, iz: 7357, iy: 2585, j: 77.0, wz: 673, wy: 258 },
  'HEB240': { area: 106.0, iz: 11260, iy: 3923, j: 103, wz: 938, wy: 327 },
  'HEB260': { area: 118.4, iz: 14920, iy: 5135, j: 130, wz: 1150, wy: 395 },
  'HEB280': { area: 131.4, iz: 19270, iy: 6560, j: 167, wz: 1380, wy: 468 },
  'HEB300': { area: 149.0, iz: 25170, iy: 8563, j: 233, wz: 1680, wy: 571 },
};

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
  const [columnSection, setColumnSection] = useState('HEB200');
  const [rafterSection, setRafterSection] = useState('IPE220');
  const [bracingSection, setBracingSection] = useState('IPE100');
  const [deformationScale, setDeformationScale] = useState(100);
  const [results3D, setResults3D] = useState<any | null>(null);
  const [inputModel3D, setInputModel3D] = useState<any | null>(null);
  const [freeModel3D, setFreeModel3D] = useState<any | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<{type: 'node' | 'element', id: string} | null>(null);
  const [workMode3D, setWorkMode3D] = useState<'parametric' | 'free_cad'>('parametric');
  const [connectNodeA, setConnectNodeA] = useState<string>('');
  const [connectNodeB, setConnectNodeB] = useState<string>('');
  const activeModel3D = workMode3D === 'free_cad' ? freeModel3D : inputModel3D;

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

  const generateParametricModel3D = useCallback((width: number, height: number, alpha: number, bayLength: number, bays: number, qLoad: number) => {
    const nodes: any[] = [];
    const elements: any[] = [];

    const alpha_rad = (alpha * Math.PI) / 180;
    const H_ridge = height + Math.tan(alpha_rad) * (width / 2);

    // Generate nodes with V2 supportRestraints [Tx, Ty, Tz, Rx, Ry, Rz]
    for (let b = 0; b <= bays; b++) {
      const z = b * bayLength;
      // Fixed column bases
      nodes.push({ id: `N_base_L_${b}`, x: -width/2, y: 0, z, supportRestraints: [true, true, true, true, true, true] });
      nodes.push({ id: `N_base_R_${b}`, x: width/2, y: 0, z, supportRestraints: [true, true, true, true, true, true] });
      // Free eaves/ridge nodes
      nodes.push({ id: `N_eaves_L_${b}`, x: -width/2, y: height, z, supportRestraints: [false, false, false, false, false, false] });
      nodes.push({ id: `N_eaves_R_${b}`, x: width/2, y: height, z, supportRestraints: [false, false, false, false, false, false] });
      nodes.push({ id: `N_ridge_${b}`, x: 0, y: H_ridge, z, supportRestraints: [false, false, false, false, false, false] });
    }

    const colProps = STEEL_PROFILES_3D[columnSection] || STEEL_PROFILES_3D['HEB200'];
    const rafProps = STEEL_PROFILES_3D[rafterSection] || STEEL_PROFILES_3D['IPE220'];
    const braceProps = STEEL_PROFILES_3D[bracingSection] || STEEL_PROFILES_3D['IPE100'];

    for (let b = 0; b <= bays; b++) {
      // Columns
      elements.push({ 
        id: `Col_L_${b}`, startNode: `N_base_L_${b}`, endNode: `N_eaves_L_${b}`, 
        ...colProps, iy: colProps.iy * 1e-8, iz: colProps.iz * 1e-8, area: colProps.area * 1e-4, wy: colProps.wy * 1e-6, wz: colProps.wz * 1e-6, groupId: "columns" 
      });
      elements.push({ 
        id: `Col_R_${b}`, startNode: `N_base_R_${b}`, endNode: `N_eaves_R_${b}`, 
        ...colProps, iy: colProps.iy * 1e-8, iz: colProps.iz * 1e-8, area: colProps.area * 1e-4, wy: colProps.wy * 1e-6, wz: colProps.wz * 1e-6, groupId: "columns" 
      });
      
      // Rafters
      elements.push({ 
        id: `Raf_L_${b}`, startNode: `N_eaves_L_${b}`, endNode: `N_ridge_${b}`, 
        ...rafProps, iy: rafProps.iy * 1e-8, iz: rafProps.iz * 1e-8, area: rafProps.area * 1e-4, wy: rafProps.wy * 1e-6, wz: rafProps.wz * 1e-6, groupId: "rafters" 
      });
      elements.push({ 
        id: `Raf_R_${b}`, startNode: `N_ridge_${b}`, endNode: `N_eaves_R_${b}`, 
        ...rafProps, iy: rafProps.iy * 1e-8, iz: rafProps.iz * 1e-8, area: rafProps.area * 1e-4, wy: rafProps.wy * 1e-6, wz: rafProps.wz * 1e-6, groupId: "rafters" 
      });
    }

    // Longitudinal elements (purlins and girts connecting bays)
    for (let b = 0; b < bays; b++) {
      // Eaves girts
      elements.push({ 
        id: `Girt_L_${b}`, startNode: `N_eaves_L_${b}`, endNode: `N_eaves_L_${b+1}`, 
        ...braceProps, iy: braceProps.iy * 1e-8, iz: braceProps.iz * 1e-8, area: braceProps.area * 1e-4, wy: braceProps.wy * 1e-6, wz: braceProps.wz * 1e-6, groupId: "bracings" 
      });
      elements.push({ 
        id: `Girt_R_${b}`, startNode: `N_eaves_R_${b}`, endNode: `N_eaves_R_${b+1}`, 
        ...braceProps, iy: braceProps.iy * 1e-8, iz: braceProps.iz * 1e-8, area: braceProps.area * 1e-4, wy: braceProps.wy * 1e-6, wz: braceProps.wz * 1e-6, groupId: "bracings" 
      });
      
      // Ridge purlins
      elements.push({ 
        id: `Purlin_R_${b}`, startNode: `N_ridge_${b}`, endNode: `N_ridge_${b+1}`, 
        ...braceProps, iy: braceProps.iy * 1e-8, iz: braceProps.iz * 1e-8, area: braceProps.area * 1e-4, wy: braceProps.wy * 1e-6, wz: braceProps.wz * 1e-6, groupId: "bracings" 
      });

      // X-bracing in the first and last bays (diagonal members)
      if (b === 0 || b === bays - 1) {
        elements.push({ 
          id: `Brace_Col_L_${b}`, startNode: `N_base_L_${b}`, endNode: `N_eaves_L_${b+1}`, 
          ...braceProps, iy: braceProps.iy * 1e-8, iz: braceProps.iz * 1e-8, area: braceProps.area * 1e-4, wy: braceProps.wy * 1e-6, wz: braceProps.wz * 1e-6, groupId: "bracings" 
        });
        elements.push({ 
          id: `Brace_Col_R_${b}`, startNode: `N_base_R_${b}`, endNode: `N_eaves_R_${b+1}`, 
          ...braceProps, iy: braceProps.iy * 1e-8, iz: braceProps.iz * 1e-8, area: braceProps.area * 1e-4, wy: braceProps.wy * 1e-6, wz: braceProps.wz * 1e-6, groupId: "bracings" 
        });
      }
    }

    const distributed_loads: any[] = [];
    for (let b = 0; b <= bays; b++) {
      distributed_loads.push({
        elementId: `Raf_L_${b}`,
        value: -qLoad, // kN/m vertical distributed load
      });
      distributed_loads.push({
        elementId: `Raf_R_${b}`,
        value: -qLoad,
      });
    }

    return {
      geometry: { nodes, elements },
      loads: distributed_loads
    };
  }, [columnSection, rafterSection, bracingSection]);

  const solve3D = useCallback((customModel?: any) => {
    const modelToSolve = customModel || inputModel3D;
    if (!modelToSolve) return;

    if (solveMesh3dFn) {
      const startTime = performance.now();
      const output = solveMesh3dFn(modelToSolve);
      const endTime = performance.now();
      if (output && output.success) {
        setResults3D({ ...output, model: modelToSolve });
        setSolveTimeMs(endTime - startTime);
      } else {
        console.error('[StructurAI] 3D Solver error:', output?.error);
      }
    } else {
      // Mock / fallback solver calculating dynamically to feel completely alive
      const mockResultDisplacements: Record<string, number[]> = {};
      const mockResultReactions: Record<string, number[]> = {};
      const mockResultUtilization: Record<string, number[]> = {};

      modelToSolve.geometry.nodes.forEach((n: any) => {
        const isRidge = n.id.includes('ridge');
        const isEaves = n.id.includes('eaves');
        
        // Displacements scale dynamically with dimensions (Width and Height)
        const scaleW = width3D / 6.0;
        const scaleH = height3D / 4.0;
        mockResultDisplacements[n.id] = [
          isEaves ? 12.5 * scaleW : 0.0,
          isRidge ? -18.2 * scaleW * scaleH : isEaves ? -8.4 * scaleW * scaleH : 0.0,
          0.0, 0.0, 0.0, 0.0
        ];
        mockResultReactions[n.id] = [0.0, 15.0 * scaleW, 0.0, 0.0, 0.0, 0.0];
      });

      modelToSolve.geometry.elements.forEach((el: any) => {
        const nStart = modelToSolve.geometry.nodes.find((n: any) => n.id === el.startNode);
        const nEnd = modelToSolve.geometry.nodes.find((n: any) => n.id === el.endNode);
        
        let length = 5.0;
        if (nStart && nEnd) {
          length = Math.sqrt(
            Math.pow(nEnd.x - nStart.x, 2) +
            Math.pow(nEnd.y - nStart.y, 2) +
            Math.pow(nEnd.z - nStart.z, 2)
          );
        }

        // Utilization scales with square of length (bending moment theory)
        const lengthFactor = Math.pow(length / 5.0, 2);
        
        // Utilization also scales with the section properties (IPE/HEB size)
        let sectionFactor = 1.0;
        const sectionName = el.sectionId || 'IPE200';
        const numericPart = parseInt(sectionName.replace(/\D/g, '')) || 200;
        sectionFactor = Math.pow(200 / numericPart, 1.5);

        if (el.groupId === 'columns') {
          const baseU = 0.35 * lengthFactor * sectionFactor;
          mockResultUtilization[el.id] = [
            baseU * 0.9,
            baseU * 0.7,
            baseU * 0.5,
            baseU * 0.7,
            baseU * 0.9
          ].map(u => Math.min(1.5, Math.max(0.02, u)));
        } else if (el.groupId === 'rafters') {
          const baseU = 0.85 * lengthFactor * sectionFactor;
          mockResultUtilization[el.id] = [
            baseU * 0.3,
            baseU * 0.7,
            baseU * 1.0,
            baseU * 0.75,
            baseU * 0.4
          ].map(u => Math.min(1.5, Math.max(0.02, u)));
        } else {
          mockResultUtilization[el.id] = [0.08, 0.08, 0.08, 0.08, 0.08];
        }
      });

      setResults3D({
        success: true,
        error: null,
        displacements: mockResultDisplacements,
        reactions: mockResultReactions,
        utilization: mockResultUtilization,
        model: modelToSolve,
      });
    }
  }, [inputModel3D, solveMesh3dFn]);

  // Regenerate parametric 3D model when sliders change
  useEffect(() => {
    if (appMode === '3d') {
      const bayLength = length3D / bays3D;
      const model = generateParametricModel3D(width3D, height3D, slope3D, bayLength, bays3D, loadValue);
      setInputModel3D(model);
      setSelectedEntity(null); // Clear selection
    }
  }, [appMode, width3D, height3D, slope3D, length3D, bays3D, loadValue, columnSection, rafterSection, bracingSection, generateParametricModel3D]);

  // Synchronizacja przy przełączeniu trybu pracy 3D (tylko inicjalizacja, nie nadpisujemy istniejącego modelu!)
  useEffect(() => {
    if (workMode3D === 'free_cad' && !freeModel3D) {
      const bayLength = length3D / bays3D;
      const currentParametric = generateParametricModel3D(width3D, height3D, slope3D, bayLength, bays3D, loadValue);
      setFreeModel3D(currentParametric);
    }
  }, [workMode3D, freeModel3D]);

  // Reactive MES 3D solver runs automatically when model updates
  useEffect(() => {
    if (appMode === '3d' && activeModel3D) {
      solve3D(activeModel3D);
    }
  }, [appMode, activeModel3D]);

  // Automatyczne przełączenie na Free CAD po kliknięciu narzędzia ołówka w 3D
  useEffect(() => {
    if (appMode === '3d' && activeTool === 'draw_beam' && workMode3D !== 'free_cad') {
      setWorkMode3D('free_cad');
    }
  }, [appMode, activeTool, workMode3D]);

  // Safe entity lookup helpers
  const getNode = (id: string) => {
    return activeModel3D?.geometry?.nodes.find((n: any) => n.id === id) || { x: 0, y: 0, z: 0, supportRestraints: [false, false, false, false, false, false] };
  };

  const getElement = (id: string) => {
    return activeModel3D?.geometry?.elements.find((el: any) => el.id === id) || { sectionId: 'IPE220' };
  };

  // Node editing handlers
  const updateNodeCoord = (nodeId: string, axis: 'x' | 'y' | 'z', value: number) => {
    setFreeModel3D((prev: any) => {
      if (!prev) return prev;
      const updatedNodes = prev.geometry.nodes.map((n: any) => 
        n.id === nodeId ? { ...n, [axis]: value } : n
      );
      return {
        ...prev,
        geometry: { ...prev.geometry, nodes: updatedNodes }
      };
    });
  };

  const toggleRestraint = (nodeId: string, dofIdx: number) => {
    setFreeModel3D((prev: any) => {
      if (!prev) return prev;
      const updatedNodes = prev.geometry.nodes.map((n: any) => {
        if (n.id === nodeId) {
          const restraints = [...(n.supportRestraints || [false, false, false, false, false, false])];
          restraints[dofIdx] = !restraints[dofIdx];
          return { ...n, supportRestraints: restraints };
        }
        return n;
      });
      return {
        ...prev,
        geometry: { ...prev.geometry, nodes: updatedNodes }
      };
    });
  };

  // Element profile editing handler
  const updateElementProfile = (elementId: string, sectionId: string) => {
    const props = STEEL_PROFILES_3D[sectionId];
    if (!props) return;
    setFreeModel3D((prev: any) => {
      if (!prev) return prev;
      const updatedElements = prev.geometry.elements.map((el: any) => 
        el.id === elementId ? {
          ...el,
          sectionId,
          iy: props.iy * 1e-8,
          iz: props.iz * 1e-8,
          area: props.area * 1e-4,
          wy: props.wy * 1e-6,
          wz: props.wz * 1e-6
        } : el
      );
      return {
        ...prev,
        geometry: { ...prev.geometry, elements: updatedElements }
      };
    });
  };

  // Delete element or node and its connections
  const removeElement = (elementId: string) => {
    setFreeModel3D((prev: any) => {
      if (!prev) return prev;
      const updatedElements = prev.geometry.elements.filter((el: any) => el.id !== elementId);
      return {
        ...prev,
        geometry: { ...prev.geometry, elements: updatedElements }
      };
    });
    setSelectedEntity(null);
  };

  // Drag and draw element insertion callback
  const handleAddElement3D = (startNodeId: string, endNodeId: string) => {
    const nodeA = activeModel3D?.geometry?.nodes.find((n: any) => n.id === startNodeId);
    const nodeB = activeModel3D?.geometry?.nodes.find((n: any) => n.id === endNodeId);
    console.log(`[StructurAI] handleAddElement3D: connecting nodes ${startNodeId} (${nodeA ? `x: ${nodeA.x}, y: ${nodeA.y}, z: ${nodeA.z}` : '?'}) and ${endNodeId} (${nodeB ? `x: ${nodeB.x}, y: ${nodeB.y}, z: ${nodeB.z}` : '?'})`);
    setFreeModel3D((prev: any) => {
      if (!prev) return prev;
      const exists = prev.geometry.elements.some(
        (el: any) => 
          (el.startNode === startNodeId && el.endNode === endNodeId) ||
          (el.startNode === endNodeId && el.endNode === startNodeId)
      );
      if (exists) return prev;

      const newId = `Beam_${Date.now()}`;
      const defaultProps = STEEL_PROFILES_3D['IPE200'] || STEEL_PROFILES_3D['IPE220'];
      const newElement = {
        id: newId,
        startNode: startNodeId,
        endNode: endNodeId,
        ...defaultProps,
        iy: defaultProps.iy * 1e-8,
        iz: defaultProps.iz * 1e-8,
        area: defaultProps.area * 1e-4,
        wy: defaultProps.wy * 1e-6,
        wz: defaultProps.wz * 1e-6,
        sectionId: 'IPE200',
        groupId: "rafters"
      };

      return {
        ...prev,
        geometry: {
          ...prev.geometry,
          elements: [...prev.geometry.elements, newElement]
        }
      };
    });
  };

  const handleAddNode3D = () => {
    setFreeModel3D((prev: any) => {
      if (!prev) return prev;
      const newId = `Node_${prev.geometry.nodes.length + 1}`;
      const newNode = {
        id: newId,
        x: 2.0,
        y: 2.0,
        z: 0.0,
        supportRestraints: [false, false, false, false, false, false]
      };
      setSelectedEntity({ type: 'node', id: newId });
      return {
        ...prev,
        geometry: {
          ...prev.geometry,
          nodes: [...prev.geometry.nodes, newNode]
        }
      };
    });
  };

  const handleConnectNodes3D = () => {
    if (!connectNodeA || !connectNodeB || connectNodeA === connectNodeB) return;
    handleAddElement3D(connectNodeA, connectNodeB);
    setConnectNodeA('');
    setConnectNodeB('');
  };

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
        <nav className="toolbar" style={{ transition: 'opacity 0.2s' }}>
          <button 
            className={`toolbar__btn ${activeTool === 'select' ? 'toolbar__btn--active' : ''}`} 
            data-tooltip="Wskaźnik (Wybierz)" 
            onClick={() => setActiveTool('select')}
            id="tool-select"
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
            data-tooltip="Rysuj belkę" 
            onClick={() => setActiveTool('draw_beam')}
            id="tool-beam"
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
            <Canvas3D 
              model={activeModel3D} 
              result={results3D} 
              deformationScale={deformationScale} 
              activeTool={activeTool}
              selectedEntity={selectedEntity}
              onSelectEntity={setSelectedEntity}
              onAddElement3D={handleAddElement3D}
            />
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
            <span className="properties-panel__title">
              {appMode === '3d' ? 'Tryb Projektowy 3D Pro' : 'Parametry Konstrukcji'}
            </span>
            {appMode === '3d' && (
              <span style={{
                background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
                color: '#fff',
                fontSize: '10px',
                fontWeight: 'bold',
                padding: '2px 8px',
                borderRadius: '9999px',
                boxShadow: '0 0 8px rgba(139, 92, 246, 0.4)'
              }}>
                6-DOF
              </span>
            )}
          </div>

          {appMode === '2d' ? (
            <>
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

              {designType === 'steel' ? (
                <>
                  {/* Sekcja: Geometria */}
                  <div className="properties-panel__section">
                    <div className="properties-panel__section-title">Geometria Przęsła</div>
                    <div className="param-group" style={{ marginTop: '10px' }}>
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
                          gap: '6px'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span className="mono-value" style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8' }}>
                              F{idx + 1} (x = {pl.x.toFixed(1)}m)
                            </span>
                            <button 
                              onClick={() => removePointLoad(pl.id)}
                              style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '12px', cursor: 'pointer', padding: 0 }}
                            >
                              ✕
                            </button>
                          </div>
                          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                            <input
                              type="range"
                              min="0.1"
                              max={beamLength - 0.1}
                              step="0.1"
                              value={pl.x}
                              onChange={(e) => updatePointLoadX(pl.id, parseFloat(e.target.value))}
                              style={{ flex: 1, accentColor: '#3b82f6', height: '4px' }}
                            />
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <input 
                                type="number" 
                                value={pl.value} 
                                onChange={(e) => updatePointLoadVal(pl.id, parseFloat(e.target.value) || 0)}
                                style={{ width: '50px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '2px 4px', borderRadius: '4px', fontSize: '11px', textAlign: 'center' }}
                              />
                              <span style={{ fontSize: '10px', color: '#64748b' }}>kN</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Distributed Load */}
                  <div className="properties-panel__section">
                    <div className="properties-panel__section-title">Obciążenie ciągłe (q)</div>
                    <div className="param-group" style={{ marginTop: '10px' }}>
                      <div className="param-input-group">
                        <input 
                          type="range" 
                          min="0.0" 
                          max="50.0" 
                          step="1.0" 
                          value={loadValue}
                          onChange={(e) => setLoadValue(parseFloat(e.target.value))}
                          className="param-range"
                        />
                        <span className="param-value mono-value">{loadValue.toFixed(1)} kN/m</span>
                      </div>
                    </div>
                  </div>

                  {/* Steel Profile */}
                  <div className="properties-panel__section">
                    <div className="properties-panel__section-title">Profil Stalowy</div>
                    <select
                      value={sectionId}
                      onChange={(e) => setSectionId(e.target.value)}
                      className="param-select"
                      style={{ marginTop: '10px' }}
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
          ) : (
            // ==================== TRYB 3D ====================
            <>
              {/* Tabs for Generator vs Free CAD */}
              <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <button
                  onClick={() => setWorkMode3D('parametric')}
                  style={{
                    flex: 1,
                    padding: '12px',
                    background: workMode3D === 'parametric' ? 'rgba(139, 92, 246, 0.15)' : 'transparent',
                    border: 'none',
                    borderBottom: workMode3D === 'parametric' ? '2px solid #8b5cf6' : '2px solid transparent',
                    color: workMode3D === 'parametric' ? '#a78bfa' : '#94a3b8',
                    fontWeight: 'bold',
                    fontSize: '13px',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  id="tab-3d-parametric"
                >
                  📐 Kreator Ramy
                </button>
                <button
                  onClick={() => setWorkMode3D('free_cad')}
                  style={{
                    flex: 1,
                    padding: '12px',
                    background: workMode3D === 'free_cad' ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                    border: 'none',
                    borderBottom: workMode3D === 'free_cad' ? '2px solid #6366f1' : '2px solid transparent',
                    color: workMode3D === 'free_cad' ? '#818cf8' : '#94a3b8',
                    fontWeight: 'bold',
                    fontSize: '13px',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  id="tab-3d-freecad"
                >
                  ✏️ Edytor Wolny CAD
                </button>
              </div>

              {workMode3D === 'free_cad' && (
                <div style={{ padding: '0 15px', marginBottom: '10px' }}>
                  <button
                    onClick={() => setFreeModel3D(null)}
                    style={{
                      width: '100%',
                      padding: '8px',
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      color: '#ef4444',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      fontSize: '12px',
                    }}
                  >
                    🔄 Resetuj układ do Kreatora
                  </button>
                </div>
              )}

              {workMode3D === 'parametric' ? (
                <>
                  {/* Sekcja: Parametryczna Geometria 3D */}
                  <div className="properties-panel__section">
                    <div className="properties-panel__section-title">Parametry Ramy</div>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
                      {/* Width 3D */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <label className="param-label" style={{ margin: 0 }}>Szerokość ramy B [m]</label>
                          <span className="mono-value" style={{ color: '#a78bfa', fontWeight: 'bold' }}>{width3D.toFixed(1)} m</span>
                        </div>
                        <input
                          type="range"
                          min="3.0"
                          max="15.0"
                          step="0.5"
                          value={width3D}
                          onChange={(e) => setWidth3D(parseFloat(e.target.value))}
                          style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                          id="param-3d-width"
                        />
                      </div>

                      {/* Height 3D */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <label className="param-label" style={{ margin: 0 }}>Wysokość słupów H [m]</label>
                          <span className="mono-value" style={{ color: '#a78bfa', fontWeight: 'bold' }}>{height3D.toFixed(1)} m</span>
                        </div>
                        <input
                          type="range"
                          min="2.0"
                          max="8.0"
                          step="0.5"
                          value={height3D}
                          onChange={(e) => setHeight3D(parseFloat(e.target.value))}
                          style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                          id="param-3d-height"
                        />
                      </div>

                      {/* Slope 3D */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <label className="param-label" style={{ margin: 0 }}>Kąt nachylenia dachu alpha [°]</label>
                          <span className="mono-value" style={{ color: '#a78bfa', fontWeight: 'bold' }}>{slope3D.toFixed(0)}°</span>
                        </div>
                        <input
                          type="range"
                          min="0.0"
                          max="45.0"
                          step="5"
                          value={slope3D}
                          onChange={(e) => setSlope3D(parseFloat(e.target.value))}
                          style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                          id="param-3d-slope"
                        />
                      </div>

                      {/* Length 3D */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <label className="param-label" style={{ margin: 0 }}>Długość hali L [m]</label>
                          <span className="mono-value" style={{ color: '#a78bfa', fontWeight: 'bold' }}>{length3D.toFixed(1)} m</span>
                        </div>
                        <input
                          type="range"
                          min="3.0"
                          max="30.0"
                          step="1.0"
                          value={length3D}
                          onChange={(e) => setLength3D(parseFloat(e.target.value))}
                          style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                          id="param-3d-length"
                        />
                      </div>

                      {/* Bays 3D */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <label className="param-label" style={{ margin: 0 }}>Liczba segmentów</label>
                          <span className="mono-value" style={{ color: '#a78bfa', fontWeight: 'bold' }}>{bays3D}</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="10"
                          step="1"
                          value={bays3D}
                          onChange={(e) => setBays3D(parseInt(e.target.value))}
                          style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                          id="param-3d-bays"
                        />
                      </div>

                      {/* Obciążenie pionowe q 3D */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <label className="param-label" style={{ margin: 0 }}>Obciążenie pionowe ramy q [kN/m]</label>
                          <span className="mono-value" style={{ color: '#a78bfa', fontWeight: 'bold' }}>{loadValue.toFixed(1)} kN/m</span>
                        </div>
                        <input
                          type="range"
                          min="5.0"
                          max="80.0"
                          step="1.0"
                          value={loadValue}
                          onChange={(e) => setLoadValue(parseFloat(e.target.value))}
                          style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                          id="param-3d-load"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Section Profile Selectors */}
                  <div className="properties-panel__section">
                    <div className="properties-panel__section-title">Przekroje Stalowe 3D</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                      <div>
                        <label className="param-label" style={{ margin: '0 0 4px 0' }}>Słupy (Columns)</label>
                        <select
                          value={columnSection}
                          onChange={(e) => setColumnSection(e.target.value)}
                          className="param-select"
                        >
                          {Object.keys(STEEL_PROFILES_3D).filter(k => k.startsWith('HEB')).map(k => (
                            <option key={k} value={k}>{k}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="param-label" style={{ margin: '0 0 4px 0' }}>Rygle (Rafters)</label>
                        <select
                          value={rafterSection}
                          onChange={(e) => setRafterSection(e.target.value)}
                          className="param-select"
                        >
                          {Object.keys(STEEL_PROFILES_3D).filter(k => k.startsWith('IPE')).map(k => (
                            <option key={k} value={k}>{k}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="param-label" style={{ margin: '0 0 4px 0' }}>Stężenia / Płatwie (Bracings)</label>
                        <select
                          value={bracingSection}
                          onChange={(e) => setBracingSection(e.target.value)}
                          className="param-select"
                        >
                          {Object.keys(STEEL_PROFILES_3D).filter(k => k.startsWith('IPE')).map(k => (
                            <option key={k} value={k}>{k}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Visual controls */}
                  <div className="properties-panel__section">
                    <div className="properties-panel__section-title">Skala deformacji 3D</div>
                    <div style={{ marginTop: '10px' }}>
                      <input
                        type="range"
                        min="10"
                        max="500"
                        step="10"
                        value={deformationScale}
                        onChange={(e) => setDeformationScale(parseInt(e.target.value))}
                        style={{ width: '100%', accentColor: '#8b5cf6', height: '4px' }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#94a3b8', marginTop: '4px' }}>
                        <span>Mniejsza</span>
                        <span>x{deformationScale}</span>
                        <span>Większa</span>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Narzędzia Edycji CAD */}
                  <div className="properties-panel__section">
                    <div className="properties-panel__section-title">Narzędzia CAD 3D</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                      <button
                        onClick={() => {
                          setFreeModel3D(null);
                          setSelectedEntity(null);
                        }}
                        style={{
                          width: '100%',
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '6px',
                          color: '#e2e8f0',
                          fontWeight: 'bold',
                          padding: '10px',
                          fontSize: '12px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '6px',
                          transition: 'all 0.15s ease',
                          marginBottom: '4px'
                        }}
                        id="btn-reset-to-sliders-3d"
                      >
                        🔄 Resetuj do ramy suwaków
                      </button>

                      <button
                        onClick={handleAddNode3D}
                        style={{
                          width: '100%',
                          background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '6px',
                          fontWeight: 'bold',
                          padding: '10px',
                          fontSize: '12px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '6px',
                          boxShadow: '0 4px 12px rgba(99, 102, 241, 0.2)',
                          transition: 'all 0.15s ease'
                        }}
                        id="btn-add-node-3d"
                      >
                        ➕ Dodaj nowy węzeł (Node)
                      </button>
                      
                      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '10px', marginTop: '5px' }}>
                        <span style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '6px', fontWeight: '600' }}>
                          🔗 Szybkie łączenie prętem:
                        </span>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '8px' }}>
                          <div>
                            <label style={{ fontSize: '9px', color: '#64748b', display: 'block', marginBottom: '2px' }}>Węzeł A</label>
                            <select
                              id="connect-node-a"
                              style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '6px', borderRadius: '6px', fontSize: '11px' }}
                              value={connectNodeA}
                              onChange={(e) => setConnectNodeA(e.target.value)}
                            >
                              <option value="">-- wybierz --</option>
                              {freeModel3D?.geometry?.nodes.map((n: any) => (
                                <option key={n.id} value={n.id}>{n.id}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={{ fontSize: '9px', color: '#64748b', display: 'block', marginBottom: '2px' }}>Węzeł B</label>
                            <select
                              id="connect-node-b"
                              style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '6px', borderRadius: '6px', fontSize: '11px' }}
                              value={connectNodeB}
                              onChange={(e) => setConnectNodeB(e.target.value)}
                            >
                              <option value="">-- wybierz --</option>
                              {freeModel3D?.geometry?.nodes.map((n: any) => (
                                <option key={n.id} value={n.id}>{n.id}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <button
                          onClick={handleConnectNodes3D}
                          disabled={!connectNodeA || !connectNodeB || connectNodeA === connectNodeB}
                          style={{
                            width: '100%',
                            background: (!connectNodeA || !connectNodeB || connectNodeA === connectNodeB)
                              ? 'rgba(255,255,255,0.05)'
                              : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                            color: (!connectNodeA || !connectNodeB || connectNodeA === connectNodeB) ? '#64748b' : '#fff',
                            border: 'none',
                            borderRadius: '6px',
                            fontWeight: 'bold',
                            padding: '8px',
                            fontSize: '11px',
                            cursor: (!connectNodeA || !connectNodeB || connectNodeA === connectNodeB) ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                            transition: 'all 0.15s ease'
                          }}
                          id="btn-connect-nodes-3d"
                        >
                          ✏️ Połącz węzły prętem
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Free CAD Manual Editor Section */}
                  <div className="properties-panel__section">
                    <div className="properties-panel__section-title">Inspektor CAD 3D</div>
                    
                    {selectedEntity ? (
                      <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
                        {selectedEntity.type === 'node' ? (() => {
                          const node = getNode(selectedEntity.id);
                          const restraints = node.supportRestraints || [false, false, false, false, false, false];
                          const restraintNames = ['Tx', 'Ty', 'Tz', 'Rx', 'Ry', 'Rz'];
                          return (
                            <>
                              <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                                <span style={{ fontSize: '11px', color: '#818cf8', fontWeight: 'bold' }}>Węzeł ID:</span>
                                <div className="mono-value" style={{ fontSize: '14px', fontWeight: 'bold', color: '#fff', marginTop: '2px' }}>{selectedEntity.id}</div>
                              </div>

                              {/* Coordinate Editors */}
                              <div>
                                <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: '600' }}>Współrzędne węzła [m]:</span>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginTop: '6px' }}>
                                  <div>
                                    <label style={{ fontSize: '10px', color: '#64748b', display: 'block', marginBottom: '2px' }}>X</label>
                                    <input
                                      type="number"
                                      step="0.1"
                                      value={node.x || 0}
                                      onChange={(e) => updateNodeCoord(selectedEntity.id, 'x', parseFloat(e.target.value))}
                                      style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '6px', borderRadius: '6px', fontSize: '12px' }}
                                    />
                                  </div>
                                  <div>
                                    <label style={{ fontSize: '10px', color: '#64748b', display: 'block', marginBottom: '2px' }}>Y (Pion)</label>
                                    <input
                                      type="number"
                                      step="0.1"
                                      value={node.y || 0}
                                      onChange={(e) => updateNodeCoord(selectedEntity.id, 'y', parseFloat(e.target.value))}
                                      style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '6px', borderRadius: '6px', fontSize: '12px' }}
                                    />
                                  </div>
                                  <div>
                                    <label style={{ fontSize: '10px', color: '#64748b', display: 'block', marginBottom: '2px' }}>Z</label>
                                    <input
                                      type="number"
                                      step="0.1"
                                      value={node.z || 0}
                                      onChange={(e) => updateNodeCoord(selectedEntity.id, 'z', parseFloat(e.target.value))}
                                      style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '6px', borderRadius: '6px', fontSize: '12px' }}
                                    />
                                  </div>
                                </div>
                              </div>

                              {/* 6-DOF supportRestraints panel */}
                              <div>
                                <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: '600' }}>Więzy podporowe (6-DOF):</span>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginTop: '8px' }}>
                                  {restraintNames.map((name, idx) => (
                                    <label key={name} style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '6px',
                                      fontSize: '12px',
                                      color: restraints[idx] ? '#818cf8' : '#94a3b8',
                                      cursor: 'pointer',
                                      background: 'rgba(255,255,255,0.02)',
                                      padding: '6px 8px',
                                      borderRadius: '6px',
                                      border: restraints[idx] ? '1px solid #6366f1' : '1px solid rgba(255,255,255,0.05)',
                                      fontWeight: restraints[idx] ? 'bold' : 'normal',
                                      transition: 'all 0.15s ease'
                                    }}>
                                      <input
                                        type="checkbox"
                                        checked={restraints[idx]}
                                        onChange={() => toggleRestraint(selectedEntity.id, idx)}
                                        style={{ cursor: 'pointer', accentColor: '#6366f1' }}
                                      />
                                      {name}
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </>
                          );
                        })() : (() => {
                          const element = getElement(selectedEntity.id);
                          return (
                            <>
                              <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                                <span style={{ fontSize: '11px', color: '#818cf8', fontWeight: 'bold' }}>Pręt ID:</span>
                                <div className="mono-value" style={{ fontSize: '14px', fontWeight: 'bold', color: '#fff', marginTop: '2px' }}>{selectedEntity.id}</div>
                              </div>

                              {/* Section/Profile Selector for Single Element */}
                              <div>
                                <label className="param-label" style={{ margin: '0 0 6px 0' }}>Przekrój pręta (Profile)</label>
                                <select
                                  value={element.sectionId || 'IPE220'}
                                  onChange={(e) => updateElementProfile(selectedEntity.id, e.target.value)}
                                  className="param-select"
                                >
                                  {Object.keys(STEEL_PROFILES_3D).map(k => (
                                    <option key={k} value={k}>{k}</option>
                                  ))}
                                </select>
                              </div>

                              {/* Delete element */}
                              <button
                                onClick={() => removeElement(selectedEntity.id)}
                                className="btn"
                                style={{
                                  width: '100%',
                                  background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                                  border: 'none',
                                  borderRadius: '8px',
                                  color: '#fff',
                                  fontWeight: 'bold',
                                  height: '38px',
                                  display: 'flex',
                                  justifyContent: 'center',
                                  alignItems: 'center',
                                  gap: '8px',
                                  cursor: 'pointer',
                                  boxShadow: '0 4px 12px rgba(239, 68, 68, 0.2)'
                                }}
                              >
                                <Trash2 size={16} />
                                USUŃ PRĘT
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    ) : (
                      <div style={{ 
                        marginTop: '15px', 
                        padding: '20px 15px', 
                        background: 'rgba(255,255,255,0.02)', 
                        border: '1px dashed rgba(255,255,255,0.1)',
                        borderRadius: '10px',
                        textAlign: 'center',
                        color: '#94a3b8',
                        fontSize: '12px',
                        lineHeight: '1.5'
                      }}>
                        💡 <span style={{ fontWeight: 'bold', color: '#e2e8f0', display: 'block', marginBottom: '6px' }}>Brak Selekcji</span>
                        Kliknij węzeł lub pręt bezpośrednio w oknie renderowania 3D, aby go dynamicznie zmodyfikować.<br /><br />
                        Możesz także wybrać **narzędzie ołówka (✏)** z paska narzędzi i rysować nowe pręty łącząc węzły bezpośrednio na ekranie!
                      </div>
                    )}
                  </div>
                </>
              )}
              {/* Wyniki Analizy 3D Pro */}
              {results3D && (() => {
                const maxUtilization3D = results3D.utilization 
                  ? Math.max(...Object.values(results3D.utilization).flatMap((arr: any) => arr))
                  : 0;

                const maxDeflection3D = results3D.displacements
                  ? Math.max(...Object.values(results3D.displacements).map((arr: any) => 
                      Math.sqrt(arr[0]*arr[0] + arr[1]*arr[1] + arr[2]*arr[2])
                    ))
                  : 0;

                return (
                  <div className="properties-panel__section" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '15px' }}>
                    <div className="properties-panel__section-title">Wyniki Analizy 3D Pro</div>
                    
                    <div className="result-card" style={{
                      background: maxUtilization3D > 1.0 
                        ? 'linear-gradient(135deg, rgba(239,68,68,0.15) 0%, rgba(220,38,38,0.05) 100%)'
                        : 'linear-gradient(135deg, rgba(16,185,129,0.15) 0%, rgba(5,150,105,0.05) 100%)',
                      border: maxUtilization3D > 1.0 ? '1px solid #ef4444' : '1px solid #10b981',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      marginBottom: '10px',
                      marginTop: '10px'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>Wytężenie prętów SGN max</span>
                        <span style={{ 
                          background: maxUtilization3D > 1.0 ? '#ef4444' : '#10b981',
                          color: '#fff',
                          fontSize: '10px',
                          fontWeight: 'bold',
                          padding: '2px 6px',
                          borderRadius: '4px'
                        }}>
                          {maxUtilization3D > 1.0 ? 'SGN PRZEKROCZONE' : 'SGN SPEŁNIONE'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '6px' }}>
                        <span className="mono-value" style={{ 
                          fontSize: '18px', 
                          fontWeight: 'bold', 
                          color: maxUtilization3D > 1.0 ? '#ef4444' : '#10b981' 
                        }}>
                          {(maxUtilization3D * 100).toFixed(1)}%
                        </span>
                        <span style={{ fontSize: '10px', color: '#64748b' }}>Granica: 100.0%</span>
                      </div>
                    </div>

                    <div className="result-card result-card--deflection" style={{ margin: 0 }}>
                      <div className="result-card__label">Przemieszczenie max (SGU)</div>
                      <div className="result-card__value" style={{ fontSize: '18px' }}>
                        {maxDeflection3D.toFixed(2)}
                        <span className="result-card__unit">mm</span>
                      </div>
                    </div>
                  </div>
                );
              })()}
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
