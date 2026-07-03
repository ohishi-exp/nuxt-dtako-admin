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

/** .spd のサンプリング周期 (秒)。net780 crate (dtako-scraper crates/net780/src/spd.rs)
 *  の SAMPLE_INTERVAL_SECS と同じ固定値。 */
const SPD_SAMPLE_INTERVAL_SECS = 0.5

/**
 * 折れ線を分断する閾値 (秒)。record 内は常に SPD_SAMPLE_INTERVAL_SECS ぴったりの
 * 間隔だが、record 境界 (休憩・休息・エンジン停止等で記録が途切れた期間) では
 * それより大きく空くことがある。これを跨いで直線で結ぶと「緩やかに減速/加速した」
 * ような誤った斜め線が描画されてしまうため、この閾値を超えたら線を分割する。
 * 数秒程度の record 境界の端数差は連続とみなし、明らかな空白期間 (数十秒〜) だけを
 * 分割対象にする。
 */
const SPEED_GAP_THRESHOLD_SECS = 5

export interface SpeedChartData {
  /** 連続区間 (record 境界の空白期間で分割済み) ごとの SVG polyline points 文字列。 */
  segments: string[]
  maxSpeed: number
  maxSecs: number
  pointCount: number
}

/**
 * 速度時系列を SVG polyline 用の座標文字列 (区間ごと) に変換する。
 *
 * - `.spd` は複数レコードの列で、record が切り替わるたびに `offset_secs` が 0 から
 *   再スタートする (net780 crate の `SpdRecord::speed_series` 参照)。`offset_secs`
 *   だけを x 軸に使うとレコード境界で x が原点に巻き戻るため、
 *   `record_start_ts + offset_secs` の絶対時刻を x 軸に使う。
 * - record 境界に実際の空白期間 (`SPEED_GAP_THRESHOLD_SECS` 超) がある場合は
 *   `segments` を分けて誤った直線補間を避ける (呼び出し側は区間ごとに別の
 *   `<polyline>` を描画すること)。
 *
 * `fixedMinTime` / `fixedMaxTime` を渡すと x 軸の正規化範囲をデータの min/max
 * ではなく固定範囲にできる (例: 暦日の 00:00〜24:00 で揃えて複数日のチャートを
 * 同じスケールで並べたい場合)。
 */
export function buildSpeedChartData(
  points: Net780SpeedPoint[],
  chartWidth: number,
  chartHeight: number,
  padding: number,
  maxTotalPoints = 600,
  fixedMinTime?: number,
  fixedMaxTime?: number,
): SpeedChartData | null {
  if (points.length < 2) return null

  const times = points.map(p => p.record_start_ts + p.offset_secs)
  const minTime = fixedMinTime ?? Math.min(...times)
  const maxTime = fixedMaxTime ?? Math.max(...times)
  const timeRange = maxTime - minTime || 1
  const maxSpeed = Math.max(...points.map(p => p.speed_kmh)) || 1
  const innerW = chartWidth - padding * 2
  const innerH = chartHeight - padding * 2

  // 実ギャップ (空白期間) で連続区間に分割する。
  const runs: Net780SpeedPoint[][] = []
  let current: Net780SpeedPoint[] = []
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && times[i]! - times[i - 1]! > SPEED_GAP_THRESHOLD_SECS) {
      if (current.length) runs.push(current)
      current = []
    }
    current.push(points[i]!)
  }
  if (current.length) runs.push(current)

  const totalRaw = points.length
  let pointCount = 0
  const segments: string[] = []
  for (const run of runs) {
    if (run.length < 2) continue
    const runMaxPoints = Math.max(2, Math.round((maxTotalPoints * run.length) / totalRaw))
    const sampled = downsampleSpeed(run, runMaxPoints)
    pointCount += sampled.length
    const seg = sampled
      .map((p) => {
        const t = p.record_start_ts + p.offset_secs
        const x = padding + ((t - minTime) / timeRange) * innerW
        const y = padding + innerH - (p.speed_kmh / maxSpeed) * innerH
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    segments.push(seg)
  }

  if (!segments.length) return null

  return { segments, maxSpeed, maxSecs: timeRange, pointCount }
}

/** JST 暦日キー (`YYYY-MM-DD`) を UNIX epoch 秒から求める。
 *  net780 の ts は「JST 壁時計をそのまま UNIX epoch として格納した値」
 *  (formatNet780Ts 参照) なので TZ シフトせず UTC getter で読む。 */
function net780DateKey(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** JST 暦日キー (`YYYY-MM-DD`) のその日 00:00:00 の UNIX epoch 秒を返す。 */
function net780DateStartTs(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!) / 1000
}

export interface DailySpeedChart {
  /** JST 暦日 (`YYYY-MM-DD`) */
  date: string
  chart: SpeedChartData
}

/**
 * 速度時系列を JST 暦日ごとに分割してチャートデータを作る。
 *
 * 実物の運行記録計 (紙のタコグラフ) は 1 日 (0〜24時) を 1 行として表示し、
 * 複数日分の運行を 1 ZIP にまとめて持つことがある。1 本の連続チャートに
 * すると日をまたぐ休憩・休息期間 (数時間〜半日) が挟まり、表示が間延びして
 * 読みづらくなる (SPEED_GAP_THRESHOLD_SECS による線分割だけでは解決しない)
 * ため、実物と同じ暦日単位のチャートに分ける。各日のチャートは 0:00〜24:00
 * を固定範囲として正規化するので、日をまたいでも時刻軸のスケールが揃う。
 */
export function buildDailySpeedCharts(
  points: Net780SpeedPoint[],
  chartWidth: number,
  chartHeight: number,
  padding: number,
  maxPointsPerDay = 600,
): DailySpeedChart[] {
  if (points.length === 0) return []

  const byDate = new Map<string, Net780SpeedPoint[]>()
  for (const p of points) {
    const date = net780DateKey(p.record_start_ts + p.offset_secs)
    let arr = byDate.get(date)
    if (!arr) {
      arr = []
      byDate.set(date, arr)
    }
    arr.push(p)
  }

  const result: DailySpeedChart[] = []
  for (const date of [...byDate.keys()].sort()) {
    const dayPoints = byDate.get(date)!
    const dayStart = net780DateStartTs(date)
    const chart = buildSpeedChartData(
      dayPoints,
      chartWidth,
      chartHeight,
      padding,
      maxPointsPerDay,
      dayStart,
      dayStart + 24 * 60 * 60,
    )
    if (chart) result.push({ date, chart })
  }
  return result
}
