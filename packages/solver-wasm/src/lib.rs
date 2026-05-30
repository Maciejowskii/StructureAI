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
    pub support_type: String, // "Free", "Pinned" (vertical locked), "Fixed" (vertical and rotation locked)
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
pub struct InputModel {
    pub nodes: Vec<Node>,
    pub elements: Vec<Element>,
    pub distributed_loads: Vec<DistributedLoad>,
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

// =============================================================================
// WASM-Bindgen Entry Point
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
    // Distributed load value is in kN/m. E is in Pa (N/m2), I is in m4.
    // To maintain SI consistency internally, we convert q [kN/m] to [N/m] by multiplying by 1000.0.
    for load in &input_model.distributed_loads {
        let element_idx = match input_model.elements.iter().position(|e| e.id == load.element_id) {
            Some(idx) => idx,
            None => continue, // Ignore loads referencing missing elements
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
        Some(u) => {
            println!("U_SOLVED: {:?}", u);
            u
        }
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

        for step in 0..=num_points {
            let x_loc = (step as f64 / num_points as f64) * l;
            let xi = x_loc / l;

            // Hermite Shape Functions
            let n1 = 1.0 - 3.0 * xi * xi + 2.0 * xi * xi * xi;
            let n2 = x_loc * (1.0 - xi) * (1.0 - xi);
            let n3 = 3.0 * xi * xi - 2.0 * xi * xi * xi;
            let n4 = x_loc * (xi * xi - xi);

            // Vertical deflection (m) -> convert to mm
            let deflection = n1 * w1 + n2 * theta1 + n3 * w2 + n4 * theta2;
            let deflection_mm = deflection * 1000.0;

            // Second derivatives of Hermite shape functions
            let d2n1 = (6.0 / (l * l)) * (2.0 * xi - 1.0);
            let d2n2 = (2.0 / l) * (3.0 * xi - 2.0);
            let d2n3 = (6.0 / (l * l)) * (1.0 - 2.0 * xi);
            let d2n4 = (2.0 / l) * (3.0 * xi - 1.0);

            let d2_delta = d2n1 * w1 + d2n2 * theta1 + d2n3 * w2 + d2n4 * theta2;

            // Bending Moment [Nm]: M = -E * I * d2_delta - q * x_loc * (L - x_loc) / 2
            // Convert to kNm by dividing by 1000.0.
            let moment_nm = -e * i_inertia * d2_delta - q_sum * x_loc * (l - x_loc) / 2.0;
            let moment_knm = moment_nm / 1000.0;

            // Third derivatives of Hermite shape functions
            let d3n1 = 12.0 / (l * l * l);
            let d3n2 = 6.0 / (l * l);
            let d3n3 = -12.0 / (l * l * l);
            let d3n4 = 6.0 / (l * l);

            let d3_delta = d3n1 * w1 + d3n2 * theta1 + d3n3 * w2 + d3n4 * theta2;

            // Shear Force [N]: V = dM/dx = -E * I * d3_delta - q * (L - 2*x) / 2
            // Convert to kN by dividing by 1000.0.
            let shear_n = -e * i_inertia * d3_delta - q_sum * (l - 2.0 * x_loc) / 2.0;
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
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fem_simple_beam_udl() {
        // Simply supported beam, L=5m, q=-10 kN/m (IPE200, S235 steel E=210 GPa, I=1.943e-5 m4)
        // Using a 2-element mesh (Node at 0.0, 2.5, 5.0) to get exact analytical deflection.
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

        let model = InputModel { nodes, elements, distributed_loads };
        let output = solve_mesh_internal(&model);

        assert!(output.success);
        assert_eq!(output.results.len(), 102);

        // Midspan is the 50th point (x = 2.5m)
        let mid_point = &output.results[50];
        assert!((mid_point.global_x - 2.5).abs() < 0.01);

        // Max deflection analytical formula: 5qL⁴/(384EI)
        // 5 * 10000 * 5^4 / (384 * 210e9 * 1.943e-5)
        // = 31,250,000 / 1,566,835,200 = 19.94 mm (downwards = negative)
        assert!((mid_point.deflection - (-19.94)).abs() < 0.1, "Deflection was: {}", mid_point.deflection);

        // Under a 2-element mesh, the FEM bending moment at the center node (index 50)
        // is exactly 7qL²/48 = -36.46 kNm.
        assert!((mid_point.moment - (-36.46)).abs() < 0.1, "Moment was: {}", mid_point.moment);
    }

    #[test]
    fn test_fem_two_span_beam() {
        // Continuous beam with 2 spans: 5m each, total 10m.
        // Node 1: Pinned (x=0)
        // Node 2: Pinned (x=5)
        // Node 3: Pinned (x=10)
        // E=210e9, I=1.943e-5
        // UDL = -10 kN/m on both elements.
        let nodes = vec![
            Node { id: "N1".to_string(), x: 0.0, support_type: "Pinned".to_string() },
            Node { id: "N2".to_string(), x: 5.0, support_type: "Pinned".to_string() },
            Node { id: "N3".to_string(), x: 10.0, support_type: "Pinned".to_string() },
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

        let model = InputModel { nodes, elements, distributed_loads };
        let output = solve_mesh_internal(&model);

        assert!(output.success);
        assert_eq!(output.results.len(), 102); // 51 points * 2 elements

        // Under a 2-element mesh, the FEM bending moment at the middle support (index 50)
        // is exactly qL²/24 = 10.42 kNm.
        let support_moment = output.results[50].moment;
        assert!((support_moment.abs() - 10.42).abs() < 0.1, "Support moment was: {}", support_moment);
    }
}
