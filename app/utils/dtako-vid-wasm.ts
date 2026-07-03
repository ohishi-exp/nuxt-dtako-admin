/**
 * NET780 (.vdf) ドラレコ映像デコーダの wasm ラッパー。
 *
 * 実体は ohishi-exp/dtako_vid_wasm (private repo) の Rust/wasm-pack ビルド成果物を
 * vendor/dtako-vid-wasm/ に vendor し、`dtako-vid-wasm` という file: 依存として
 * package.json から参照している (alc-app の fc1200-wasm と同じパターン)。
 * public/ 配下への生 URL 動的 import は Nitro/Wrangler の server 側 esbuild
 * バンドルが static に解決しようとして `Could not resolve` で fail するため使わない
 * (Refs ohishi-exp/dtako-scraper#20)。
 */

export interface GRecord {
  ts: number
  sub_us: number
  g_front_back: number
  g_left_right: number
  g_up_down: number
}

export interface GpsRecord {
  ts: number
  sub_us: number
  fix: string
  lat: number
  lon: number
  heading_deg: number
}

export interface SpeedRpmRecord {
  ts: number
  sub_us: number
  speed_kmh: number
  rpm: number
}

export interface EventRecord {
  ts: number
  sub_us: number
  code: number
}

export interface VdfTelemetry {
  vehicle: string
  driver: string
  g: GRecord[]
  speed_rpm: SpeedRpmRecord[]
  gps: GpsRecord[]
  events: EventRecord[]
  front_frame_count: number
  rear_frame_count: number
  /** Absolute capture time (`ts + sub_us/1e6`) of the first video frame. */
  video_start_ts: number
}

/** Convert a record's absolute capture time to a MP4 `<video>.currentTime`-relative offset (seconds). */
export function recordOffsetSeconds(
  record: { ts: number, sub_us: number },
  telemetry: Pick<VdfTelemetry, 'video_start_ts'>,
): number {
  return record.ts + record.sub_us / 1e6 - telemetry.video_start_ts
}

export interface VdfDecodeResult {
  hasFront: boolean
  hasRear: boolean
  frontMp4: Uint8Array<ArrayBuffer>
  rearMp4: Uint8Array<ArrayBuffer>
  telemetry: VdfTelemetry
}

interface WasmVdfResult {
  readonly hasFront: boolean
  readonly hasRear: boolean
  readonly frontMp4: Uint8Array<ArrayBuffer>
  readonly rearMp4: Uint8Array<ArrayBuffer>
  readonly telemetryJson: string
}

interface DtakoVidWasmModule {
  default: (input?: unknown) => Promise<unknown>
  parseVdfToMp4: (data: Uint8Array) => WasmVdfResult
}

let modulePromise: Promise<DtakoVidWasmModule> | null = null

function loadModule(): Promise<DtakoVidWasmModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = (await import('dtako-vid-wasm')) as unknown as DtakoVidWasmModule
      await mod.default()
      return mod
    })().catch((e) => {
      modulePromise = null // 失敗時は次回リトライできるようキャッシュを捨てる
      throw e
    })
  }
  return modulePromise
}

/** `.vdf` バイナリを demux し、前方/後方 MP4 + テレメトリを返す。 */
export async function decodeVdf(data: Uint8Array): Promise<VdfDecodeResult> {
  const mod = await loadModule()
  const result = mod.parseVdfToMp4(data)
  return {
    hasFront: result.hasFront,
    hasRear: result.hasRear,
    frontMp4: result.frontMp4,
    rearMp4: result.rearMp4,
    telemetry: JSON.parse(result.telemetryJson) as VdfTelemetry,
  }
}
