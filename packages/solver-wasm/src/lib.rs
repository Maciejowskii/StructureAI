use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use nalgebra::{DMatrix, DVector};

// =============================================================================
// Data Structures — JSON Contract
// =============================================================================

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Node {
    pub id: String,
    pub x: f64, // Position along beam length (horizontal X axis)
    pub support_type: String, // "Free", "Pinned", "Fixed"
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Element {
    pub id: String,
    pub start_node_id: String,
    pub end_node_id: String,
    pub e: f64, // Young's modulus (Pa, e.g. 210e9)
    pub i_inertia: f64, // Moment of inertia (m4, e.g. 1.943e-5)
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct DistributedLoad {
    pub element_id: String,
    pub value: f64, // Uniform distributed load [kN/m] (negative downwards)
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct PointLoad {
    pub x: f64,     // Global position of point load from start of beam (m)
    pub value: f64, // Point load value [kN] (negative downwards)
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct InputModel {
    pub nodes: Vec<Node>,
    pub elements: Vec<Element>,
    pub distributed_loads: Vec<DistributedLoad>,
    pub point_loads: Vec<PointLoad>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ResultPoint {
    pub global_x: f64,
    pub deflection: f64, // Deflection in mm
    pub moment: f64,     // Bending moment in kNm
    pub shear: f64,      // Shear force in kN
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SolverOutput {
    pub success: bool,
    pub error: Option<String>,
    pub results: Vec<ResultPoint>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SteelProfile {
    pub name: String,
    pub height: f64,       // h (mm)
    pub width: f64,        // b (mm)
    pub thickness_w: f64,  // tw (mm)
    pub thickness_f: f64,  // tf (mm)
    pub iy: f64,           // Moment of inertia (cm^4) -> to SGU
    pub wy: f64,           // Section modulus (cm^3) -> to SGN
    pub area: f64,         // Section area (cm^2)
    pub weight: f64,       // Weight (kg/m)
    pub price_factor: f64, // Price factor (e.g. IPE = 1.0, HEB = 1.25)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OptimizationResult {
    pub name: String,
    pub utilization_sgn: f64, // e.g. 0.78 (78%)
    pub deflection_sgu: f64,  // max deflection in mm
    pub limit_sgu: f64,       // allowable deflection in mm (L/250)
    pub weight: f64,          // kg/m
    pub price_factor: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OptimizerOutput {
    pub success: bool,
    pub error: Option<String>,
    pub cheapest: Option<OptimizationResult>,
    pub lightest: Option<OptimizationResult>,
    pub balanced: Option<OptimizationResult>,
}

// =============================================================================
// Static Steel Profile Database
// =============================================================================

pub fn get_profile_database() -> Vec<SteelProfile> {
    vec![
        SteelProfile { name: "IPE 100".to_string(), height: 100.0, width: 55.0, thickness_w: 4.1, thickness_f: 5.7, iy: 171.0, wy: 34.2, area: 10.3, weight: 8.1, price_factor: 1.0 },
        SteelProfile { name: "IPE 120".to_string(), height: 120.0, width: 64.0, thickness_w: 4.4, thickness_f: 6.3, iy: 318.0, wy: 53.0, area: 13.2, weight: 10.4, price_factor: 1.0 },
        SteelProfile { name: "IPE 140".to_string(), height: 140.0, width: 73.0, thickness_w: 4.7, thickness_f: 6.9, iy: 541.0, wy: 77.3, area: 16.4, weight: 12.9, price_factor: 1.0 },
        SteelProfile { name: "IPE 160".to_string(), height: 160.0, width: 82.0, thickness_w: 5.0, thickness_f: 7.4, iy: 869.0, wy: 109.0, area: 20.1, weight: 15.8, price_factor: 1.0 },
        SteelProfile { name: "IPE 180".to_string(), height: 180.0, width: 91.0, thickness_w: 5.3, thickness_f: 8.0, iy: 1317.0, wy: 146.0, area: 23.9, weight: 18.8, price_factor: 1.0 },
        SteelProfile { name: "IPE 200".to_string(), height: 200.0, width: 100.0, thickness_w: 5.6, thickness_f: 8.5, iy: 1943.0, wy: 194.0, area: 28.5, weight: 22.4, price_factor: 1.0 },
        SteelProfile { name: "IPE 220".to_string(), height: 220.0, width: 110.0, thickness_w: 5.9, thickness_f: 9.2, iy: 2772.0, wy: 252.0, area: 33.4, weight: 26.2, price_factor: 1.0 },
        SteelProfile { name: "IPE 240".to_string(), height: 240.0, width: 120.0, thickness_w: 6.2, thickness_f: 9.8, iy: 3892.0, wy: 324.0, area: 39.1, weight: 30.7, price_factor: 1.0 },
        SteelProfile { name: "IPE 270".to_string(), height: 270.0, width: 135.0, thickness_w: 6.6, thickness_f: 10.2, iy: 5790.0, wy: 429.0, area: 45.9, weight: 36.1, price_factor: 1.0 },
        SteelProfile { name: "IPE 300".to_string(), height: 300.0, width: 150.0, thickness_w: 7.1, thickness_f: 10.7, iy: 8356.0, wy: 557.0, area: 53.8, weight: 42.2, price_factor: 1.0 },
        SteelProfile { name: "IPE 330".to_string(), height: 330.0, width: 160.0, thickness_w: 7.5, thickness_f: 11.5, iy: 11770.0, wy: 713.0, area: 62.6, weight: 49.1, price_factor: 1.0 },
        SteelProfile { name: "IPE 360".to_string(), height: 360.0, width: 170.0, thickness_w: 8.0, thickness_f: 12.7, iy: 16270.0, wy: 904.0, area: 72.7, weight: 57.1, price_factor: 1.0 },
        SteelProfile { name: "IPE 400".to_string(), height: 400.0, width: 180.0, thickness_w: 8.6, thickness_f: 13.5, iy: 23130.0, wy: 1160.0, area: 84.5, weight: 66.3, price_factor: 1.0 },
        SteelProfile { name: "HEB 100".to_string(), height: 100.0, width: 100.0, thickness_w: 6.0, thickness_f: 10.0, iy: 450.0, wy: 89.9, area: 26.0, weight: 20.4, price_factor: 1.25 },
        SteelProfile { name: "HEB 120".to_string(), height: 120.0, width: 120.0, thickness_w: 6.5, thickness_f: 11.0, iy: 864.0, wy: 144.0, area: 34.0, weight: 26.7, price_factor: 1.25 },
        SteelProfile { name: "HEB 140".to_string(), height: 140.0, width: 140.0, thickness_w: 7.0, thickness_f: 12.0, iy: 1509.0, wy: 216.0, area: 43.0, weight: 33.7, price_factor: 1.25 },
        SteelProfile { name: "HEB 160".to_string(), height: 160.0, width: 160.0, thickness_w: 8.0, thickness_f: 13.0, iy: 2492.0, wy: 311.0, area: 52.7, weight: 42.6, price_factor: 1.25 },
        SteelProfile { name: "HEB 180".to_string(), height: 180.0, width: 180.0, thickness_w: 8.5, thickness_f: 14.0, iy: 3831.0, wy: 426.0, area: 65.3, weight: 51.2, price_factor: 1.25 },
        SteelProfile { name: "HEB 200".to_string(), height: 200.0, width: 200.0, thickness_w: 9.0, thickness_f: 15.0, iy: 5696.0, wy: 570.0, area: 78.1, weight: 61.3, price_factor: 1.25 },
        SteelProfile { name: "HEB 220".to_string(), height: 220.0, width: 200.0, thickness_w: 9.5, thickness_f: 16.0, iy: 7357.0, wy: 673.0, area: 91.0, weight: 71.5, price_factor: 1.25 },
        SteelProfile { name: "HEB 240".to_string(), height: 240.0, width: 240.0, thickness_w: 10.0, thickness_f: 17.0, iy: 11260.0, wy: 938.0, area: 106.0, weight: 83.2, price_factor: 1.25 },
        SteelProfile { name: "HEB 260".to_string(), height: 260.0, width: 260.0, thickness_w: 10.0, thickness_f: 17.5, iy: 14920.0, wy: 1150.0, area: 118.4, weight: 93.0, price_factor: 1.25 },
        SteelProfile { name: "HEB 280".to_string(), height: 280.0, width: 280.0, thickness_w: 10.5, thickness_f: 18.0, iy: 19270.0, wy: 1380.0, area: 131.4, weight: 103.0, price_factor: 1.25 },
        SteelProfile { name: "HEB 300".to_string(), height: 300.0, width: 300.0, thickness_w: 11.0, thickness_f: 19.0, iy: 25170.0, wy: 1680.0, area: 149.0, weight: 117.0, price_factor: 1.25 },
    ]
}

// =============================================================================
// WASM-Bindgen Entry Points
// =============================================================================

#[wasm_bindgen]
pub fn solve_mesh(input_val: JsValue) -> JsValue {
    let input_model: InputModel = match serde_wasm_bindgen::from_value(input_val) {
        Ok(m) => m,
        Err(e) => {
            let err_output = SolverOutput {
                success: false,
                error: Some(format!("Failed to parse input model from JS: {}", e)),
                results: vec![],
            };
            return serde_wasm_bindgen::to_value(&err_output).unwrap();
        }
    };

    let result = solve_mesh_internal(&input_model);
    serde_wasm_bindgen::to_value(&result).unwrap_or_default()
}

#[wasm_bindgen]
pub fn optimize_sections(input_val: JsValue) -> JsValue {
    let input_model: InputModel = match serde_wasm_bindgen::from_value(input_val) {
        Ok(m) => m,
        Err(e) => {
            let err_output = OptimizerOutput {
                success: false,
                error: Some(format!("Failed to parse input model from JS: {}", e)),
                cheapest: None,
                lightest: None,
                balanced: None,
            };
            return serde_wasm_bindgen::to_value(&err_output).unwrap();
        }
    };

    let result = optimize_sections_internal(&input_model);
    serde_wasm_bindgen::to_value(&result).unwrap_or_default()
}

// =============================================================================
// FEM Solver Core
// =============================================================================

pub fn solve_mesh_internal(input_model: &InputModel) -> SolverOutput {
    let n_nodes = input_model.nodes.len();
    if n_nodes < 2 {
        return SolverOutput {
            success: false,
            error: Some("The structural model must have at least 2 nodes".to_string()),
            results: vec![],
        };
    }
    if input_model.elements.is_empty() {
        return SolverOutput {
            success: false,
            error: Some("The structural model must have at least 1 element".to_string()),
            results: vec![],
        };
    }

    // N nodes means 2*N degrees of freedom (DOF)
    // Even DOF: 2 * node_index -> vertical deflection (w)
    // Odd DOF: 2 * node_index + 1 -> rotation (theta)
    let system_size = n_nodes * 2;
    let mut k_global = DMatrix::<f64>::zeros(system_size, system_size);
    let mut f_global = DVector::<f64>::zeros(system_size);

    // Krok 3.2: Agregacja macierzy elementów
    for element in &input_model.elements {
        let start_idx = match input_model.nodes.iter().position(|n| n.id == element.start_node_id) {
            Some(idx) => idx,
            None => {
                return SolverOutput {
                    success: false,
                    error: Some(format!("Element {} has invalid start node {}", element.id, element.start_node_id)),
                    results: vec![],
                };
            }
        };
        let end_idx = match input_model.nodes.iter().position(|n| n.id == element.end_node_id) {
            Some(idx) => idx,
            None => {
                return SolverOutput {
                    success: false,
                    error: Some(format!("Element {} has invalid end node {}", element.id, element.end_node_id)),
                    results: vec![],
                };
            }
        };

        let x_start = input_model.nodes[start_idx].x;
        let x_end = input_model.nodes[end_idx].x;
        let l = x_end - x_start;

        if l <= 1e-9 {
            return SolverOutput {
                success: false,
                error: Some(format!("Element {} has zero or negative length: {}", element.id, l)),
                results: vec![],
            };
        }

        let e = element.e;
        let i = element.i_inertia;
        let const_k = (e * i) / (l * l * l);

        // Local 4x4 stiffness matrix
        let l2 = l * l;
        let k_local = [
            [12.0,  6.0 * l,  -12.0,  6.0 * l],
            [6.0 * l, 4.0 * l2, -6.0 * l, 2.0 * l2],
            [-12.0, -6.0 * l,  12.0,  -6.0 * l],
            [6.0 * l, 2.0 * l2, -6.0 * l, 4.0 * l2],
        ];

        // Global DOF indices for local nodes
        let dof = [
            2 * start_idx,
            2 * start_idx + 1,
            2 * end_idx,
            2 * end_idx + 1,
        ];

        for r in 0..4 {
            for c in 0..4 {
                k_global[(dof[r], dof[c])] += const_k * k_local[r][c];
            }
        }
    }

    // Krok 3.3: Agregacja obciążeń ciągłych (Equivalent Nodal Forces)
    for load in &input_model.distributed_loads {
        let element_idx = match input_model.elements.iter().position(|e| e.id == load.element_id) {
            Some(idx) => idx,
            None => continue,
        };
        let element = &input_model.elements[element_idx];

        let start_idx = input_model.nodes.iter().position(|n| n.id == element.start_node_id).unwrap();
        let end_idx = input_model.nodes.iter().position(|n| n.id == element.end_node_id).unwrap();

        let x_start = input_model.nodes[start_idx].x;
        let x_end = input_model.nodes[end_idx].x;
        let l = x_end - x_start;

        let q = load.value * 1000.0; // convert kN/m to N/m

        let f_v1 = q * l / 2.0;
        let m_1 = q * l * l / 12.0;
        let f_v2 = q * l / 2.0;
        let m_2 = -q * l * l / 12.0;

        f_global[2 * start_idx] += f_v1;
        f_global[2 * start_idx + 1] += m_1;
        f_global[2 * end_idx] += f_v2;
        f_global[2 * end_idx + 1] += m_2;
    }

    // KROK 1.2: Agregacja Obciążeń Skupionych (Equivalent Nodal Forces)
    for load in &input_model.point_loads {
        for element in &input_model.elements {
            let start_idx = input_model.nodes.iter().position(|n| n.id == element.start_node_id).unwrap();
            let end_idx = input_model.nodes.iter().position(|n| n.id == element.end_node_id).unwrap();

            let x_start = input_model.nodes[start_idx].x;
            let x_end = input_model.nodes[end_idx].x;
            let l = x_end - x_start;

            // Check if load falls within this element
            // Adding a small tolerance 1e-9 for boundaries
            if load.x >= (x_start - 1e-9) && load.x <= (x_end + 1e-9) {
                let a = (load.x - x_start).max(0.0).min(l);
                let b = l - a;
                let p = load.value * 1000.0; // convert kN to N

                // Concentrated equivalent nodal forces formulas:
                let f_v1 = (p * b * b * (3.0 * a + b)) / (l * l * l);
                let m_1 = (p * a * b * b) / (l * l);
                let f_v2 = (p * a * a * (a + 3.0 * b)) / (l * l * l);
                let m_2 = -(p * a * a * b) / (l * l);

                f_global[2 * start_idx] += f_v1;
                f_global[2 * start_idx + 1] += m_1;
                f_global[2 * end_idx] += f_v2;
                f_global[2 * end_idx + 1] += m_2;

                break; // A point load belongs to one element segment
            }
        }
    }

    // Krok 3.4: Nałożenie warunków brzegowych (Metoda Kary)
    let penalty = 1e12;
    for (idx, node) in input_model.nodes.iter().enumerate() {
        if node.support_type == "Pinned" {
            // Block vertical displacement (DOF 2 * idx)
            k_global[(2 * idx, 2 * idx)] += penalty;
            f_global[2 * idx] = 0.0;
        } else if node.support_type == "Fixed" {
            // Block vertical displacement (DOF 2 * idx) AND rotation (DOF 2 * idx + 1)
            k_global[(2 * idx, 2 * idx)] += penalty;
            k_global[(2 * idx + 1, 2 * idx + 1)] += penalty;
            f_global[2 * idx] = 0.0;
            f_global[2 * idx + 1] = 0.0;
        }
    }

    // Krok 3.5: Rozwiązanie układu równań
    let u_solved = match k_global.lu().solve(&f_global) {
        Some(u) => u,
        None => {
            return SolverOutput {
                success: false,
                error: Some("Solver failed to solve K * U = F. Global stiffness matrix is singular.".to_string()),
                results: vec![],
            };
        }
    };

    // Krok 4: Post-processing (Generowanie punktów wykresów Hermite'a)
    let mut results = Vec::new();
    let num_points = 50;

    for element in &input_model.elements {
        let start_idx = input_model.nodes.iter().position(|n| n.id == element.start_node_id).unwrap();
        let end_idx = input_model.nodes.iter().position(|n| n.id == element.end_node_id).unwrap();

        let x_start = input_model.nodes[start_idx].x;
        let x_end = input_model.nodes[end_idx].x;
        let l = x_end - x_start;

        let w1 = u_solved[2 * start_idx];
        let theta1 = u_solved[2 * start_idx + 1];
        let w2 = u_solved[2 * end_idx];
        let theta2 = u_solved[2 * end_idx + 1];

        let e = element.e;
        let i_inertia = element.i_inertia;

        // Sum distributed loads for this element (in N/m)
        let q_sum: f64 = input_model.distributed_loads.iter()
            .filter(|ld| ld.element_id == element.id)
            .map(|ld| ld.value * 1000.0)
            .sum();

        // Find concentrated loads inside this element
        let mut element_point_loads = Vec::new();
        for ld in &input_model.point_loads {
            if ld.x >= x_start && ld.x <= x_end {
                let a = ld.x - x_start;
                // Exclude load placed exactly at nodes to prevent duplicate jumps at bounds
                if a > 1e-4 && (l - a) > 1e-4 {
                    element_point_loads.push((a, ld.value * 1000.0));
                }
            }
        }

        for step in 0..=num_points {
            let x_loc = (step as f64 / num_points as f64) * l;
            let xi = x_loc / l;

            // Hermite Shape Functions
            let n1 = 1.0 - 3.0 * xi * xi + 2.0 * xi * xi * xi;
            let n2 = x_loc * (1.0 - xi) * (1.0 - xi);
            let n3 = 3.0 * xi * xi - 2.0 * xi * xi * xi;
            let n4 = x_loc * (xi * xi - xi);

            // Deflection (m) -> convert to mm
            let deflection = n1 * w1 + n2 * theta1 + n3 * w2 + n4 * theta2;
            let deflection_mm = deflection * 1000.0;

            // Second derivatives of Hermite shape functions
            let d2n1 = (6.0 / (l * l)) * (2.0 * xi - 1.0);
            let d2n2 = (2.0 / l) * (3.0 * xi - 2.0);
            let d2n3 = (6.0 / (l * l)) * (1.0 - 2.0 * xi);
            let d2n4 = (2.0 / l) * (3.0 * xi - 1.0);

            let d2_delta = d2n1 * w1 + d2n2 * theta1 + d2n3 * w2 + d2n4 * theta2;

            // Partcular solution for bending moment from point loads
            let mut p_moment = 0.0;
            let mut p_shear = 0.0;

            for &(a, p) in &element_point_loads {
                if x_loc <= a {
                    p_moment += -p * (l - a) * x_loc / l;
                    p_shear += -p * (l - a) / l;
                } else {
                    p_moment += -p * a * (l - x_loc) / l;
                    p_shear += p * a / l;
                }
            }

            // Bending Moment [Nm]: M = -E * I * d2_delta - q * x * (L - x) / 2 + M_particular
            let moment_nm = -e * i_inertia * d2_delta - q_sum * x_loc * (l - x_loc) / 2.0 + p_moment;
            let moment_knm = moment_nm / 1000.0;

            // Third derivatives of Hermite shape functions
            let d3n1 = 12.0 / (l * l * l);
            let d3n2 = 6.0 / (l * l);
            let d3n3 = -12.0 / (l * l * l);
            let d3n4 = 6.0 / (l * l);

            let d3_delta = d3n1 * w1 + d3n2 * theta1 + d3n3 * w2 + d3n4 * theta2;

            // Shear Force [N]: V = dM/dx = -E * I * d3_delta - q * (L - 2*x) / 2 + V_particular
            let shear_n = -e * i_inertia * d3_delta - q_sum * (l - 2.0 * x_loc) / 2.0 + p_shear;
            let shear_kn = shear_n / 1000.0;

            results.push(ResultPoint {
                global_x: x_start + x_loc,
                deflection: deflection_mm,
                moment: moment_knm,
                shear: shear_kn,
            });
        }
    }

    SolverOutput {
        success: true,
        error: None,
        results,
    }
}

// =============================================================================
// AI Section Optimization Logic (SGN & SGU)
// =============================================================================

pub fn optimize_sections_internal(input_model: &InputModel) -> OptimizerOutput {
    let database = get_profile_database();
    let mut candidates = Vec::new();

    // Total beam length is the max coordinate x
    let total_beam_length = match input_model.nodes.iter().map(|n| n.x).max_by(|a, b| a.partial_cmp(b).unwrap()) {
        Some(x) => x,
        None => 5.0,
    };
    
    // Serviceability limit (SGU) deflection limit L/250
    let limit_sgu = total_beam_length / 250.0;

    for profile in &database {
        let mut temp_model = input_model.clone();
        let iy_m4 = profile.iy * 1e-8; // cm^4 -> m^4
        
        for element in &mut temp_model.elements {
            element.e = 210e9; // Young's modulus
            element.i_inertia = iy_m4;
        }

        // Run full FEM mesh solver
        let solver_out = solve_mesh_internal(&temp_model);
        if !solver_out.success {
            continue;
        }

        // Find absolute maximums
        let max_moment_knm = solver_out.results.iter()
            .map(|r| r.moment.abs())
            .max_by(|a, b| a.partial_cmp(b).unwrap())
            .unwrap_or(0.0);
            
        let max_deflection_mm = solver_out.results.iter()
            .map(|r| r.deflection.abs())
            .max_by(|a, b| a.partial_cmp(b).unwrap())
            .unwrap_or(0.0);

        // Ultimate Limit State (SGN) Check: sigma = M / Wy <= fy (235 MPa)
        let max_moment_nm = max_moment_knm * 1000.0;
        let wy_m3 = profile.wy * 1e-6; // cm^3 -> m^3
        let sigma_max = max_moment_nm / wy_m3;
        
        let sgn_passed = sigma_max <= 235e6;
        
        // Serviceability Limit State (SGU) Check: deflection <= L/250
        let sgu_passed = (max_deflection_mm / 1000.0) <= limit_sgu;

        let utilization_sgn = sigma_max / 235e6;

        if sgn_passed && sgu_passed {
            candidates.push(OptimizationResult {
                name: profile.name.clone(),
                utilization_sgn,
                deflection_sgu: max_deflection_mm,
                limit_sgu: limit_sgu * 1000.0, // mm
                weight: profile.weight,
                price_factor: profile.price_factor,
            });
        }
    }

    if candidates.is_empty() {
        return OptimizerOutput {
            success: false,
            error: Some("Brak profili spełniających warunki nośności SGN i użytkowalności SGU.".to_string()),
            cheapest: None,
            lightest: None,
            balanced: None,
        };
    }

    // A: Cheapest (weight * price_factor)
    let cheapest = candidates.iter()
        .min_by(|a, b| {
            let cost_a = a.weight * a.price_factor;
            let cost_b = b.weight * b.price_factor;
            cost_a.partial_cmp(&cost_b).unwrap()
        })
        .cloned();

    // B: Lightest (weight)
    let lightest = candidates.iter()
        .min_by(|a, b| a.weight.partial_cmp(&b.weight).unwrap())
        .cloned();

    // C: Balanced (utilization closest to 65% stress)
    let balanced = candidates.iter()
        .min_by(|a, b| {
            let diff_a = (a.utilization_sgn - 0.65).abs();
            let diff_b = (b.utilization_sgn - 0.65).abs();
            diff_a.partial_cmp(&diff_b).unwrap()
        })
        .cloned();

    OptimizerOutput {
        success: true,
        error: None,
        cheapest,
        lightest,
        balanced,
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fem_simple_beam_udl() {
        let nodes = vec![
            Node { id: "N1".to_string(), x: 0.0, support_type: "Pinned".to_string() },
            Node { id: "N2".to_string(), x: 2.5, support_type: "Free".to_string() },
            Node { id: "N3".to_string(), x: 5.0, support_type: "Pinned".to_string() },
        ];
        let elements = vec![
            Element {
                id: "E1".to_string(),
                start_node_id: "N1".to_string(),
                end_node_id: "N2".to_string(),
                e: 210e9,
                i_inertia: 1.943e-5,
            },
            Element {
                id: "E2".to_string(),
                start_node_id: "N2".to_string(),
                end_node_id: "N3".to_string(),
                e: 210e9,
                i_inertia: 1.943e-5,
            }
        ];
        let distributed_loads = vec![
            DistributedLoad { element_id: "E1".to_string(), value: -10.0 },
            DistributedLoad { element_id: "E2".to_string(), value: -10.0 }
        ];

        let model = InputModel { nodes, elements, distributed_loads, point_loads: vec![] };
        let output = solve_mesh_internal(&model);

        assert!(output.success);
        assert_eq!(output.results.len(), 102);

        let mid_point = &output.results[50];
        assert!((mid_point.global_x - 2.5).abs() < 0.01);
        assert!((mid_point.deflection - (-19.94)).abs() < 0.1);
        assert!((mid_point.moment - (-36.46)).abs() < 0.1);
    }

    #[test]
    fn test_fem_point_load_midspan() {
        // Simply supported beam, L=5.0m, concentrated force P = -50 kN at x=2.5m (middle node).
        let nodes = vec![
            Node { id: "N1".to_string(), x: 0.0, support_type: "Pinned".to_string() },
            Node { id: "N2".to_string(), x: 2.5, support_type: "Free".to_string() },
            Node { id: "N3".to_string(), x: 5.0, support_type: "Pinned".to_string() },
        ];
        let elements = vec![
            Element {
                id: "E1".to_string(),
                start_node_id: "N1".to_string(),
                end_node_id: "N2".to_string(),
                e: 210e9,
                i_inertia: 1.943e-5,
            },
            Element {
                id: "E2".to_string(),
                start_node_id: "N2".to_string(),
                end_node_id: "N3".to_string(),
                e: 210e9,
                i_inertia: 1.943e-5,
            }
        ];
        let point_loads = vec![
            PointLoad { x: 2.5, value: -50.0 }
        ];

        let model = InputModel { nodes, elements, distributed_loads: vec![], point_loads };
        let output = solve_mesh_internal(&model);

        assert!(output.success);
        let mid_point = &output.results[50];

        // Analytical max deflection for midspan point load: PL³/(48EI)
        // 50000 * 125 / (48 * 210e9 * 1.943e-5)
        // = 6,250,000 / 195,854.4 = 0.031911 m = -31.91 mm
        assert!((mid_point.deflection - (-31.91)).abs() < 0.1, "Deflection was: {}", mid_point.deflection);

        // Max moment at midspan: PL/4 = -50 * 5 / 4 = -62.5 kNm
        assert!((mid_point.moment - (-62.5)).abs() < 0.1, "Moment was: {}", mid_point.moment);
    }

    #[test]
    fn test_steel_profile_optimizer() {
        let nodes = vec![
            Node { id: "N1".to_string(), x: 0.0, support_type: "Pinned".to_string() },
            Node { id: "N2".to_string(), x: 5.0, support_type: "Pinned".to_string() },
        ];
        let elements = vec![
            Element {
                id: "E1".to_string(),
                start_node_id: "N1".to_string(),
                end_node_id: "N2".to_string(),
                e: 210e9,
                i_inertia: 1.943e-5,
            }
        ];
        let distributed_loads = vec![
            DistributedLoad { element_id: "E1".to_string(), value: -15.0 }
        ];

        let model = InputModel { nodes, elements, distributed_loads, point_loads: vec![] };
        let opt_output = optimize_sections_internal(&model);

        assert!(opt_output.success);
        assert!(opt_output.cheapest.is_some());
        assert!(opt_output.lightest.is_some());
        assert!(opt_output.balanced.is_some());

        let cheap = opt_output.cheapest.unwrap();
        println!("Cheapest section: {}", cheap.name);
        assert!(cheap.utilization_sgn <= 1.0);
    }
}
