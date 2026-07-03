/* net780-wasm stub type definitions for CI (where the local wasm pkg is unavailable) */
declare module 'net780-wasm' {
  export function init_panic_hook(): void
  export function parse_net780_zip(bytes: Uint8Array): unknown
  export default function init(): Promise<{ memory: WebAssembly.Memory }>
}
