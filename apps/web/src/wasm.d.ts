declare module 'solver-wasm' {
  export default function init(module_or_path?: string | URL | Request | Response): Promise<any>;
  export function initSync(module: BufferSource | WebAssembly.Module): any;
  export function solve_mesh(input_val: any): any;
  export function optimize_sections(input_val: any): any;
}
