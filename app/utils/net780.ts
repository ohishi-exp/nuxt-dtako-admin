// NET780 デジタコ生データ ZIP を net780-wasm (ohishi-exp/net780-wasm、
// ohishi-exp/dtako-scraper の crates/net780 を wasm-bindgen で公開したもの) 経由で
// ブラウザ内完結パースするための薄いラッパー。フォーマット仕様・パースロジックは
// dtako-scraper の crates/net780 (Rust) 側が SoT。

export interface Net780HeaderSummary {
  device_id: string
  vehicle_code: number
  driver_code: number
  start_at: string
  end_at: string
  distance_km: number
}

export interface Net780InfSummary {
  operation_date: string
  vehicle_code: number
  driver_code: number
  start_at: string
  end_at: string
  distance_km: number
  storage_path: string
}

export interface Net780SpeedPoint {
  record_start_ts: number
  offset_secs: number
  speed_kmh: number
}

export interface Net780GpsPoint {
  ts: number
  lat: number
  lon: number
}

export interface Net780EventSummary {
  ts: number
  code: number
  subcode: number
  description: string | null
  payload_ascii: string | null
  payload_len: number
}

export interface Net780ParseResult {
  header: Net780HeaderSummary | null
  inf: Net780InfSummary | null
  distance_total_m: number | null
  speed: Net780SpeedPoint[]
  gps: Net780GpsPoint[]
  events: Net780EventSummary[]
  warnings: string[]
}

let modPromise: Promise<typeof import('net780-wasm')> | null = null

function loadModule() {
  if (!modPromise) {
    modPromise = import('net780-wasm').then(async (mod) => {
      await mod.default()
      return mod
    })
  }
  return modPromise
}

/** NET780 生データ ZIP (バイト列) をブラウザ内でパースする。 */
export async function parseNet780Zip(bytes: Uint8Array): Promise<Net780ParseResult> {
  const mod = await loadModule()
  return mod.parse_net780_zip(bytes) as Net780ParseResult
}

/** イベントコードを `0xXX` 形式の16進表示にする。 */
export function net780EventCodeHex(code: number): string {
  return `0x${code.toString(16).toUpperCase().padStart(2, '0')}`
}

/**
 * NET780 の ts (u32) を表示用文字列に変換する。
 * docs/net780-binary-format.md: 「JST の壁時計をそのまま UNIX epoch として格納した値」
 * なので、ブラウザのローカルタイムゾーンではなく UTC getter で値をそのまま読む
 * (TZ シフトすると二重にずれる)。
 */
export function formatNet780Ts(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** 速度時系列をチャート描画用に間引く (点数が多いと SVG 描画が重くなるため)。 */
export function downsampleSpeed(points: Net780SpeedPoint[], maxPoints = 600): Net780SpeedPoint[] {
  if (points.length <= maxPoints) return points
  const step = points.length / maxPoints
  const out: Net780SpeedPoint[] = []
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.floor(i * step)]!)
  }
  return out
}

export interface SpeedChartData {
  polyline: string
  maxSpeed: number
  maxSecs: number
  pointCount: number
}

/**
 * 速度時系列を SVG polyline 用の座標文字列に変換する。
 *
 * `.spd` は複数レコードの列で、record が切り替わるたびに `offset_secs` が 0 から
 * 再スタートする (net780 crate の `SpdRecord::speed_series` 参照)。`offset_secs`
 * だけを x 軸に使うとレコード境界で x が原点に巻き戻り折れ線がギザギザになるため、
 * `record_start_ts + offset_secs` の絶対時刻を x 軸に使う。
 */
export function buildSpeedChartData(
  points: Net780SpeedPoint[],
  chartWidth: number,
  chartHeight: number,
  padding: number,
): SpeedChartData | null {
  if (points.length < 2) return null

  const times = points.map(p => p.record_start_ts + p.offset_secs)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const timeRange = maxTime - minTime || 1
  const maxSpeed = Math.max(...points.map(p => p.speed_kmh)) || 1
  const innerW = chartWidth - padding * 2
  const innerH = chartHeight - padding * 2

  const polyline = points
    .map((p, i) => {
      const x = padding + ((times[i]! - minTime) / timeRange) * innerW
      const y = padding + innerH - (p.speed_kmh / maxSpeed) * innerH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return { polyline, maxSpeed, maxSecs: timeRange, pointCount: points.length }
}
