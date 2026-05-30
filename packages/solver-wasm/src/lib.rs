use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

// =============================================================================
// Data Structures — JSON Contract (structurai-schema-v1)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub x: f64,
    pub z: f64,
    #[serde(default)]
    pub support: Option<String>, // "pinned", "roller_x", "fixed", or None (free)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Element {
    pub id: String,
    #[serde(rename = "startNode")]
    pub start_node: String,
    #[serde(rename = "endNode")]
    pub end_node: String,
    pub section_id: String,
    pub material_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Load {
    #[serde(rename = "type")]
    pub load_type: String, // "distributed", "point"
    pub element: String,
    pub value: f64,         // kN/m for distributed, kN for point
    pub direction: String,  // "global_Z", "global_X"
    #[serde(default)]
    pub position: Option<f64>, // For point loads: position along element (0.0 to 1.0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Geometry {
    pub nodes: Vec<Node>,
    pub elements: Vec<Element>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuralModel {
    pub project_id: String,
    pub geometry: Geometry,
    pub loads: Vec<Load>,
}

// =============================================================================
// Results Structures
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeamResults {
    pub element_id: String,
    pub length: f64,
    pub reaction_left: f64,    // kN (vertical reaction at start node)
    pub reaction_right: f64,   // kN (vertical reaction at end node)
    pub max_moment: f64,       // kNm (maximum bending moment)
    pub max_moment_position: f64, // m (position of max moment from left)
    pub max_shear: f64,        // kN (maximum shear force)
    pub max_deflection: f64,   // mm (maximum deflection)
    /// Bending moment values at 21 stations along the beam (0%, 5%, 10%, ..., 100%)
    pub moment_diagram: Vec<f64>,
    /// Shear force values at 21 stations along the beam
    pub shear_diagram: Vec<f64>,
    /// Deflection values at 21 stations along the beam (mm)
    pub deflection_diagram: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolverOutput {
    pub success: bool,
    pub error: Option<String>,
    pub results: Vec<BeamResults>,
}

// =============================================================================
// Section Properties Database (Minimal PoC)
// =============================================================================

struct SectionProps {
    _name: &'static str,
    _area: f64,        // cm² -> converted to m²
    inertia: f64,      // cm⁴ -> converted to m⁴
    _height: f64,      // mm
}

fn get_section_props(section_id: &str) -> SectionProps {
    match section_id {
        "IPE200" => SectionProps {
            _name: "IPE 200",
            _area: 28.48,
            inertia: 1943.0,
            _height: 200.0,
        },
        "IPE300" => SectionProps {
            _name: "IPE 300",
            _area: 53.81,
            inertia: 8356.0,
            _height: 300.0,
        },
        "IPE400" => SectionProps {
            _name: "IPE 400",
            _area: 84.46,
            inertia: 23130.0,
            _height: 400.0,
        },
        "HEB200" => SectionProps {
            _name: "HEB 200",
            _area: 78.08,
            inertia: 5696.0,
            _height: 200.0,
        },
        "HEB300" => SectionProps {
            _name: "HEB 300",
            _area: 149.1,
            inertia: 25170.0,
            _height: 300.0,
        },
        _ => SectionProps {
            _name: "Default",
            _area: 28.48,
            inertia: 1943.0,
            _height: 200.0,
        },
    }
}

fn get_youngs_modulus(material_id: &str) -> f64 {
    match material_id {
        "S235" | "S275" | "S355" => 210_000_000.0, // kN/m² (210 GPa)
        _ => 210_000_000.0,
    }
}

// =============================================================================
// Solver: Simple Beam (Analytical Formulas — Phase 0 PoC)
// =============================================================================

/// Solves a simply supported beam with a uniformly distributed load.
/// Uses classical analytical formulas (no FEM matrices yet).
///
/// For a beam of length L with UDL of intensity q:
///   - Reactions: R_A = R_B = qL/2
///   - Moment at x: M(x) = (qLx/2) - (qx²/2)
///   - Max moment: M_max = qL²/8 at x = L/2
///   - Shear at x: V(x) = qL/2 - qx
///   - Deflection at x: δ(x) = (q / (24EI)) * x * (L³ - 2Lx² + x³)
///   - Max deflection: δ_max = 5qL⁴ / (384EI) at x = L/2
fn solve_simply_supported_udl(
    element_id: &str,
    length: f64,
    q: f64,   // kN/m (positive = downward in our convention, input negative = downward)
    e: f64,   // Young's modulus in kN/m²
    i: f64,   // Moment of inertia in m⁴
) -> BeamResults {
    let q_abs = q.abs(); // Work with positive magnitude

    let reaction = q_abs * length / 2.0;
    let max_moment = q_abs * length * length / 8.0;
    let max_shear = reaction;
    let max_deflection = (5.0 * q_abs * length.powi(4)) / (384.0 * e * i) * 1000.0; // Convert m to mm

    let num_stations = 21;
    let mut moment_diagram = Vec::with_capacity(num_stations);
    let mut shear_diagram = Vec::with_capacity(num_stations);
    let mut deflection_diagram = Vec::with_capacity(num_stations);

    for idx in 0..num_stations {
        let t = idx as f64 / (num_stations as f64 - 1.0);
        let x = t * length;

        // M(x) = (q*L*x)/2 - (q*x²)/2
        let moment = (q_abs * length * x / 2.0) - (q_abs * x * x / 2.0);
        moment_diagram.push((moment * 1000.0).round() / 1000.0);

        // V(x) = q*L/2 - q*x
        let shear = q_abs * length / 2.0 - q_abs * x;
        shear_diagram.push((shear * 1000.0).round() / 1000.0);

        // δ(x) = (q / (24*E*I)) * x * (L³ - 2*L*x² + x³)
        let deflection = if e * i > 0.0 {
            (q_abs / (24.0 * e * i)) * x * (length.powi(3) - 2.0 * length * x * x + x.powi(3))
        } else {
            0.0
        };
        let deflection_mm = deflection * 1000.0; // Convert m to mm
        deflection_diagram.push((deflection_mm * 1000.0).round() / 1000.0); // Round to 3 decimal places
    }

    // Round to 3 decimal places helper
    let round3 = |v: f64| (v * 1000.0).round() / 1000.0;

    BeamResults {
        element_id: element_id.to_string(),
        length,
        reaction_left: round3(reaction),
        reaction_right: round3(reaction),
        max_moment: round3(max_moment),
        max_moment_position: length / 2.0,
        max_shear: round3(max_shear),
        max_deflection: round3(max_deflection),
        moment_diagram,
        shear_diagram,
        deflection_diagram,
    }
}

// =============================================================================
// WASM-Bindgen Entry Point
// =============================================================================

/// Main solver entry point exposed to JavaScript.
/// Takes a JSON string conforming to structurai-schema-v1 and returns results as JSON.
#[wasm_bindgen]
pub fn solve_structure(input_json: &str) -> String {
    let model: StructuralModel = match serde_json::from_str(input_json) {
        Ok(m) => m,
        Err(e) => {
            let err_output = SolverOutput {
                success: false,
                error: Some(format!("JSON parse error: {}", e)),
                results: vec![],
            };
            return serde_json::to_string(&err_output).unwrap_or_default();
        }
    };

    let mut results = Vec::new();

    for element in &model.geometry.elements {
        // Find start and end nodes
        let start_node = model.geometry.nodes.iter().find(|n| n.id == element.start_node);
        let end_node = model.geometry.nodes.iter().find(|n| n.id == element.end_node);

        let (start, end) = match (start_node, end_node) {
            (Some(s), Some(e)) => (s, e),
            _ => {
                let err_output = SolverOutput {
                    success: false,
                    error: Some(format!(
                        "Element {} references unknown nodes: {} or {}",
                        element.id, element.start_node, element.end_node
                    )),
                    results: vec![],
                };
                return serde_json::to_string(&err_output).unwrap_or_default();
            }
        };

        // Calculate element length
        let dx = end.x - start.x;
        let dz = end.z - start.z;
        let length = (dx * dx + dz * dz).sqrt();

        if length < 1e-10 {
            let err_output = SolverOutput {
                success: false,
                error: Some(format!("Element {} has zero length", element.id)),
                results: vec![],
            };
            return serde_json::to_string(&err_output).unwrap_or_default();
        }

        // Get section properties
        let section = get_section_props(&element.section_id);
        let e_modulus = get_youngs_modulus(&element.material_id);
        let inertia_m4 = section.inertia * 1e-8; // cm⁴ -> m⁴

        // Find loads on this element
        let element_loads: Vec<&Load> = model.loads.iter()
            .filter(|l| l.element == element.id)
            .collect();

        // For PoC: sum all distributed loads on this element
        let total_q: f64 = element_loads.iter()
            .filter(|l| l.load_type == "distributed")
            .map(|l| l.value)
            .sum();

        let beam_result = solve_simply_supported_udl(
            &element.id,
            length,
            total_q,
            e_modulus,
            inertia_m4,
        );

        results.push(beam_result);
    }

    let output = SolverOutput {
        success: true,
        error: None,
        results,
    };

    serde_json::to_string(&output).unwrap_or_default()
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_beam_5m_udl_10() {
        // Simply supported beam, L=5m, q=10 kN/m (IPE200, S235)
        let input = r#"{
            "project_id": "test-001",
            "geometry": {
                "nodes": [
                    { "id": "N1", "x": 0.0, "z": 0.0, "support": "pinned" },
                    { "id": "N2", "x": 5.0, "z": 0.0, "support": "roller_x" }
                ],
                "elements": [
                    { "id": "E1", "startNode": "N1", "endNode": "N2", "section_id": "IPE200", "material_id": "S235" }
                ]
            },
            "loads": [
                { "type": "distributed", "element": "E1", "value": -10.0, "direction": "global_Z" }
            ]
        }"#;

        let result_json = solve_structure(input);
        let output: SolverOutput = serde_json::from_str(&result_json).unwrap();

        assert!(output.success);
        assert_eq!(output.results.len(), 1);

        let r = &output.results[0];
        // Reactions: qL/2 = 10*5/2 = 25 kN
        assert!((r.reaction_left - 25.0).abs() < 0.01);
        assert!((r.reaction_right - 25.0).abs() < 0.01);
        // Max moment: qL²/8 = 10*25/8 = 31.25 kNm
        assert!((r.max_moment - 31.25).abs() < 0.01);
        // Max deflection: 5qL⁴/(384EI) = 5*10*625/(384*210e6*1943e-8)
        // = 31250 / (384 * 210e6 * 1.943e-5) = 31250 / 1568.16 ≈ 19.93 mm
        assert!(r.max_deflection > 15.0, "Deflection too small: {}", r.max_deflection);
        assert!(r.max_deflection < 25.0, "Deflection too large: {}", r.max_deflection);
    }

    #[test]
    fn test_invalid_json() {
        let result_json = solve_structure("not valid json");
        let output: SolverOutput = serde_json::from_str(&result_json).unwrap();
        assert!(!output.success);
        assert!(output.error.is_some());
    }

    #[test]
    fn test_moment_diagram_symmetry() {
        let input = r#"{
            "project_id": "test-sym",
            "geometry": {
                "nodes": [
                    { "id": "N1", "x": 0.0, "z": 0.0, "support": "pinned" },
                    { "id": "N2", "x": 4.0, "z": 0.0, "support": "roller_x" }
                ],
                "elements": [
                    { "id": "E1", "startNode": "N1", "endNode": "N2", "section_id": "IPE300", "material_id": "S235" }
                ]
            },
            "loads": [
                { "type": "distributed", "element": "E1", "value": -5.0, "direction": "global_Z" }
            ]
        }"#;

        let result_json = solve_structure(input);
        let output: SolverOutput = serde_json::from_str(&result_json).unwrap();

        assert!(output.success);
        let r = &output.results[0];

        // Moment diagram should be symmetric: M[i] ≈ M[20-i]
        for i in 0..10 {
            assert!(
                (r.moment_diagram[i] - r.moment_diagram[20 - i]).abs() < 0.01,
                "Moment diagram not symmetric at station {}: {} vs {}",
                i, r.moment_diagram[i], r.moment_diagram[20 - i]
            );
        }

        // Shear should be antisymmetric: V[i] ≈ -V[20-i]
        for i in 0..10 {
            assert!(
                (r.shear_diagram[i] + r.shear_diagram[20 - i]).abs() < 0.01,
                "Shear diagram not antisymmetric at station {}: {} vs {}",
                i, r.shear_diagram[i], r.shear_diagram[20 - i]
            );
        }
    }
}
