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

/** 結合対象の 1 ファイル分。`duration` は実際にデコードした MP4 の再生時間 (秒)。 */
export interface TelemetrySegment {
  telemetry: VdfTelemetry
  duration: number
}

/**
 * 複数ファイル分のテレメトリを、動画を連結再生した時の単一タイムライン上に
 * マージする。各セグメントの `ts` を `delta = 累積オフセット + 先頭セグメントの
 * video_start_ts - 自分の video_start_ts` だけシフトすることで、
 * `recordOffsetSeconds(record, { video_start_ts: 先頭セグメントの video_start_ts })`
 * が「連結後の合計 currentTime」を返すようになる (`VidTelemetryChart` /
 * `VidMap` 側のロジックは変更不要)。
 */
export function mergeTelemetrySegments(segments: TelemetrySegment[]): VdfTelemetry {
  const empty: VdfTelemetry = {
    vehicle: '',
    driver: '',
    g: [],
    speed_rpm: [],
    gps: [],
    events: [],
    front_frame_count: 0,
    rear_frame_count: 0,
    video_start_ts: 0,
  }
  if (segments.length === 0) return empty

  const globalVideoStartTs = segments[0]!.telemetry.video_start_ts
  const g: GRecord[] = []
  const speedRpm: SpeedRpmRecord[] = []
  const gps: GpsRecord[] = []
  const events: EventRecord[] = []
  let frontFrameCount = 0
  let rearFrameCount = 0
  let cumulative = 0

  function shift<T extends { ts: number }>(records: T[], delta: number): T[] {
    return records.map(r => ({ ...r, ts: r.ts + delta }))
  }

  for (const seg of segments) {
    const delta = cumulative + globalVideoStartTs - seg.telemetry.video_start_ts
    g.push(...shift(seg.telemetry.g, delta))
    speedRpm.push(...shift(seg.telemetry.speed_rpm, delta))
    gps.push(...shift(seg.telemetry.gps, delta))
    events.push(...shift(seg.telemetry.events, delta))
    frontFrameCount += seg.telemetry.front_frame_count
    rearFrameCount += seg.telemetry.rear_frame_count
    cumulative += seg.duration
  }

  return {
    vehicle: segments[0]!.telemetry.vehicle,
    driver: segments[0]!.telemetry.driver,
    g,
    speed_rpm: speedRpm,
    gps,
    events,
    front_frame_count: frontFrameCount,
    rear_frame_count: rearFrameCount,
    video_start_ts: globalVideoStartTs,
  }
}

/**
 * 一時 `<video>` でメタデータだけ読み込み、実際の再生時間 (秒) を取得する。
 *
 * H.264 デコーダを持たないブラウザ (このプロジェクトの CI/開発サンドボックスで
 * 使う headless Chromium ビルドがまさにこれ、`canPlayType('...avc1...')` が
 * 空文字を返す) では `error` イベントが発火し得る。実ユーザー環境
 * (Chrome/Edge/Firefox/Safari 等、MP4/H.264 再生はほぼ標準対応) では通常
 * 発生しないが、失敗しても呼び出し側の複数ファイル結合処理全体を止めないよう
 * `0` にフォールバックする (呼び出し側で warn ログを出す)。
 */
export function probeVideoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement('video')
    el.preload = 'metadata'
    el.src = url
    el.onloadedmetadata = () => {
      const d = el.duration
      el.src = ''
      resolve(Number.isFinite(d) ? d : 0)
    }
    el.onerror = () => {
      el.src = ''
      resolve(0)
    }
  })
}
