declare module 'solver-wasm' {
  export default function init(module_or_path?: string | URL | Request | Response): Promise<any>;
  export function initSync(module: BufferSource | WebAssembly.Module): any;
  export function solve_mesh(input_val: any): any;
  export function solve_mesh_3d(input_val: any): any;
  export function optimize_sections(input_val: any): any;
  export function design_rc_section(m_ed_k_nm: number, profile_val: any): any;
}
