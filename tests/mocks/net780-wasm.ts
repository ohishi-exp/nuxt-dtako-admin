// Mock for net780-wasm WASM module (vitest.config.ts alias). vendor/net780-wasm/
// has the real wasm-pack pkg output, but its wasm binary fetch() init doesn't
// work under vitest/happy-dom, so tests always use this mock instead.

interface MockParseResult {
  header: unknown
  inf: unknown
  distance_total_m: number | null
  speed: unknown[]
  gps: unknown[]
  events: unknown[]
  warnings: string[]
}

function emptyResult(): MockParseResult {
  return {
    header: null,
    inf: null,
    distance_total_m: null,
    speed: [],
    gps: [],
    events: [],
    warnings: [],
  }
}

let mockResult: unknown = emptyResult()
let mockError: Error | null = null

/** テストから任意の parse_net780_zip 戻り値を差し込む。 */
export function __setMockResult(result: unknown) {
  mockResult = result
  mockError = null
}

/** テストから parse_net780_zip が throw するエラーを差し込む。 */
export function __setMockError(error: Error) {
  mockError = error
}

/** 各テスト後の後始末用。 */
export function __reset() {
  mockError = null
  mockResult = emptyResult()
}

export function parse_net780_zip(_bytes: Uint8Array) {
  if (mockError) throw mockError
  return mockResult
}

export function init_panic_hook() {}

export default function init() {
  return Promise.resolve({
    memory: {} as WebAssembly.Memory,
  })
}
