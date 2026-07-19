// NET780 デジタコ生データ ZIP を net780-wasm (ohishi-exp/net780-wasm、
// ohishi-exp/dtako-scraper の crates/net780 を wasm-bindgen で公開したもの) 経由で
// ブラウザ内完結パースするための薄いラッパー。フォーマット仕様・パースロジックは
// dtako-scraper の crates/net780 (Rust) 側が SoT。

import JSZip from 'jszip'

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

/**
 * theearth F-VOS3020 の一括ダウンロード ZIP (`{車輌CD}/{タイムスタンプ}-0-0-
 * {車輌CD}/*.{cfg,dsd,evd,gpd,inf,rvd,spd,fin}` の1階層ネスト構造、複数運行を
 * 含みうる) から、単一運行分のサブフォルダだけを取り出し、`parseNet780Zip` が
 * 読める形 (`.inf/.spd/.dsd/.gpd/.evd` がトップレベル直下) の ZIP に組み直す。
 *
 * 複数運行が含まれる ZIP を渡した場合は先頭の1件のみを対象にする (呼び出し側は
 * 単一運行を選んだ時だけこの関数を呼ぶ想定)。
 */
export async function extractSingleOperationZip(bulkZipBytes: Uint8Array): Promise<Uint8Array> {
  const bulkZip = await JSZip.loadAsync(bulkZipBytes)
  const files = Object.values(bulkZip.files).filter(f => !f.dir)
  if (files.length === 0) {
    throw new Error('ZIP 内にファイルが見つかりません')
  }
  const firstPath = files[0]!.name
  const lastSlash = firstPath.lastIndexOf('/')
  const prefix = lastSlash >= 0 ? firstPath.slice(0, lastSlash + 1) : ''

  const out = new JSZip()
  for (const file of files) {
    if (prefix && !file.name.startsWith(prefix)) continue
    const basename = file.name.slice(prefix.length)
    if (!basename) continue
    const content = await file.async('uint8array')
    out.file(basename, content)
  }
  return out.generateAsync({ type: 'uint8array' })
}

/**
 * `/net780` (一括ダウンロード検索) への遷移リンクを組み立てる。読取日 (ReadNo) 基準
 * 固定 (Refs #311、運行日を渡すと1日ズレて0件になることがある、Refs #316) で、
 * 車輌CD・乗務員CD が分かっていればあわせて渡し絞り込んだ状態で開けるようにする。
 * `Net780OperationSummary.vue` (NET780タブ未アーカイブ時) と運行詳細ページのイベント
 * タブ (速度カラー Map 未アーカイブ時) の両方で共用する。
 */
export function buildNet780SearchLink(params: {
  readingDate?: string | null
  vehicleCd?: string | null
  driverCd?: string | null
}): string {
  const search = new URLSearchParams()
  if (params.readingDate) search.set('readingDate', params.readingDate)
  if (params.vehicleCd) search.set('vehicleCd', params.vehicleCd)
  if (params.driverCd) search.set('driverCd', params.driverCd)
  const q = search.toString()
  return `/net780${q ? `?${q}` : ''}`
}

export interface Net780Summary {
  vehicleCode: number | null
  driverCode: number | null
  startAt: string | null
  endAt: string | null
  distanceKm: number | null
  distanceTotalM: number | null
  storagePath: string | null
  deviceId: string | null
}

/** パース結果からサマリ情報を組み立てる (`/net780` ビューアと `/operations/*`
 * の NET780 タブで共用、Refs #299)。header/inf のどちらか埋まっている方を使う。 */
export function buildNet780Summary(result: Net780ParseResult): Net780Summary {
  const inf = result.inf
  const header = result.header
  return {
    vehicleCode: inf?.vehicle_code ?? header?.vehicle_code ?? null,
    driverCode: inf?.driver_code ?? header?.driver_code ?? null,
    startAt: inf?.start_at ?? header?.start_at ?? null,
    endAt: inf?.end_at ?? header?.end_at ?? null,
    distanceKm: inf?.distance_km ?? header?.distance_km ?? null,
    distanceTotalM: result.distance_total_m,
    storagePath: inf?.storage_path ?? null,
    deviceId: header?.device_id ?? null,
  }
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

/**
 * 速度時系列をチャート描画用に間引く (点数が多いと SVG 描画が重くなるため)。
 *
 * 単純な等間隔インデックス抽出だと、急減速やごく短い一時停止・逆に長い停車
 * (速度 0 が続く期間) がバケット内に埋もれて間引かれてしまい、実際には
 * 存在しない緩やかな斜め線 (= 抽出されなかった山/谷を直線で飛び越えた結果)
 * として描画されてしまう。バケットごとに最小値・最大値の 2 点を残す方式
 * (簡易 min/max decimation) にすることで、停止 (速度 0 の谷) や急な速度変化の
 * 山を取りこぼさないようにする。
 */
export function downsampleSpeed(points: Net780SpeedPoint[], maxPoints = 600): Net780SpeedPoint[] {
  if (points.length <= maxPoints) return points

  const bucketCount = Math.max(1, Math.floor(maxPoints / 2))
  const bucketSize = points.length / bucketCount
  const out: Net780SpeedPoint[] = []

  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * bucketSize)
    const end = b === bucketCount - 1 ? points.length : Math.floor((b + 1) * bucketSize)
    if (end <= start) continue

    let minP = points[start]!
    let maxP = points[start]!
    for (let i = start + 1; i < end; i++) {
      const p = points[i]!
      if (p.speed_kmh < minP.speed_kmh) minP = p
      if (p.speed_kmh > maxP.speed_kmh) maxP = p
    }

    if (minP === maxP) {
      out.push(minP)
      continue
    }
    // バケット内で時系列順を保つため、時刻が早い方を先に push する。
    const minTime = minP.record_start_ts + minP.offset_secs
    const maxTime = maxP.record_start_ts + maxP.offset_secs
    if (minTime <= maxTime) out.push(minP, maxP)
    else out.push(maxP, minP)
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
export function net780DateKey(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** JST 暦日キー (`YYYY-MM-DD`) のその日 00:00:00 の UNIX epoch 秒を返す。 */
export function net780DateStartTs(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!) / 1000
}

export interface DailySpeedChart {
  /** JST 暦日 (`YYYY-MM-DD`) */
  date: string
  chart: SpeedChartData
  /** その日 00:00:00 (JST) の UNIX epoch 秒。チャート x 座標の逆算 (シーク) に使う。 */
  dayStart: number
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
    if (chart) result.push({ date, chart, dayStart })
  }
  return result
}

export interface DailyGpsPoints {
  /** JST 暦日 (`YYYY-MM-DD`) */
  date: string
  points: Net780GpsPoint[]
}

/** イベントコード: 通信断 / 通信復帰 (net780-wasm の evd description と対応)。 */
const EVENT_CODE_COMM_LOST = 0xB8
const EVENT_CODE_COMM_RESTORED = 0xB9

/**
 * イベント列から「通信断 (0xB8) 〜 通信復帰 (0xB9)」の時間区間を抽出する。
 * 通信断中は測位が収束せず、実座標と無関係な位置 (無線基地局や直前ロック位置
 * 付近をふらつく等) を記録し続けることがあり、GPS 軌跡が海上・市街地外など
 * ありえない場所へ直線的に飛んで見える原因になる。対応する通信復帰が無い
 * (ZIP の記録範囲が通信断中で終わっている) 場合は `end` を `Infinity` にし、
 * 記録終端まで通信断が continuing しているとみなす。
 */
export function extractCommOutageRanges(events: Net780EventSummary[]): Array<{ start: number, end: number }> {
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const ranges: Array<{ start: number, end: number }> = []
  let openTs: number | null = null
  for (const e of sorted) {
    if (e.code === EVENT_CODE_COMM_LOST) {
      openTs = e.ts
    } else if (e.code === EVENT_CODE_COMM_RESTORED && openTs !== null) {
      ranges.push({ start: openTs, end: e.ts })
      openTs = null
    }
  }
  if (openTs !== null) ranges.push({ start: openTs, end: Infinity })
  return ranges
}

function isWithinRanges(ts: number, ranges: Array<{ start: number, end: number }>): boolean {
  return ranges.some(r => ts >= r.start && ts <= r.end)
}

/** 2 点間の距離 (km、Haversine 公式)。 */
function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** この実装速度 (km/h) を超え、かつ MIN_JUMP_DIST_KM 以上移動していたら物理的にありえないジャンプとみなす。 */
const MAX_PLAUSIBLE_SPEED_KMH = 150
/** 至近距離の GPS ノイズ (揺らぎ) を誤検出しないための最小距離しきい値 (km)。 */
const MIN_JUMP_DIST_KM = 0.3
/** 異常判定中の隣接生点間の連続性チェックが有効な最大時間差 (秒)。.gpd の
 *  サンプリングは概ね 60 秒間隔で、これを大きく超える間隔では低速に見えても
 *  連続走行の根拠にならない (長時間経過すれば任意の 2 点間が低速に見えるため)。 */
const TREND_MAX_GAP_SECS = 180
/** 異常判定中に保留した点列を「再開した実走行トレンド」として採用し直すのに
 *  必要な、トレンド起点からの累積移動距離 (km)。静止した異常クラスタ (移動
 *  しないので隣接点間速度は常に妥当に見える) を誤ってトレンド認定しないための下限。 */
const TREND_MIN_TRAVEL_KM = 1.0

/**
 * 時系列順の GPS 点列から、直前の「採用済み」点との実装速度が物理的にありえない
 * (`MAX_PLAUSIBLE_SPEED_KMH` 超) ジャンプを検出し、そのジャンプ先の点を除外する。
 *
 * 通信断 (0xB8/0xB9) や作業状態 ON/OFF (0x11/0x21) 付近で GPS モジュールが実座標と
 * 無関係な位置 (海上・市街地外等) を記録することがあるが、イベントコードとの
 * 時間窓ベースの相関は運行ごとに一致しないケースが多く実効性が低かった
 * (実データ検証: 0x11/0x21 前後 120 秒を除外しても 14 件中 12 件のジャンプが残存)。
 * 座標そのものの物理的整合性を見るこの方式なら原因コードによらず直接検出できる。
 *
 * 直前の「採用済み」点だけを基準にする単純な貪欲法には抜け穴があった: 異常座標が
 * 同じ場所に長時間 (数十分) 留まり続けるケースでは、経過時間が伸びるにつれ
 * 同じ距離でも計算上の速度が下がっていき、いずれ `MAX_PLAUSIBLE_SPEED_KMH` を
 * 下回って誤って採用されてしまう (実データ検証で発覚、採用された瞬間にその点が
 * 新しい基準点になり、以降の異常クラスタも道連れで誤採用され続けた)。これを防ぐ
 * ため、直前の「生の」点との距離もあわせて追跡するヒステリシス方式にした:
 * 直前の生の点が異常判定されていて、かつ現在の点がその生の点から
 * `MIN_JUMP_DIST_KM` 未満しか離れていない (= 同じ異常クラスタに留まっている) 場合は、
 * 基準点との計算上の速度に関わらず異常判定を継続する。クラスタから実際に離れる
 * (生の点間の距離が動く) までは採用を再開しない。
 * 実データ検証: 07-03/07-04・07-17/07-18 の両運行で異常座標が完全に (0 件まで) 除去された。
 *
 * さらに別の失敗モードも見つかった: ジャンプ後のクラスタが静止せず「移動し続ける」
 * ケース (記録欠落等でタイムスタンプ上わずかな間に実位置が大きく飛び、その後
 * 実走行がそのまま続くデータ)。各生点は毎ステップ `MIN_JUMP_DIST_KM` 以上動くため
 * 上記ヒステリシスは効かず、毎回 stale な基準点との比較に落ちる。基準点が固定の
 * まま経過時間だけが伸びるので、実距離が大きいままでも計算上の速度がいずれ
 * `MAX_PLAUSIBLE_SPEED_KMH` を下回り、軌跡の途中の任意の 1 点が誤って新基準点として
 * 採用される (それまでの実在の点は全て捨てられる)。結果、古い基準点からその途中点へ
 * 一直線の長い偽セグメントが描画されていた。対策として、異常判定中は点列を保留
 * (pending) に積み、隣接生点間の速度が妥当 (`TREND_MAX_GAP_SECS` 以内かつ
 * `MAX_PLAUSIBLE_SPEED_KMH` 以下) なまま累積 `TREND_MIN_TRAVEL_KM` 以上実移動したら
 * 「再開した実走行トレンド」と確定し、保留分をまとめて採用して基準点をトレンドの
 * 現在点へ再同期する。静止クラスタは累積移動が増えないのでトレンド認定されず、
 * 従来どおり除外され続ける。
 */
export function filterImplausibleGpsJumps(points: Net780GpsPoint[]): Net780GpsPoint[] {
  if (points.length === 0) return []
  const kept: Net780GpsPoint[] = [points[0]!]
  let anchor = points[0]!
  let prevRaw = points[0]!
  let prevRawAnomalous = false
  /** 異常判定中に保留している点列 (トレンド確定時にまとめて採用する)。 */
  let pending: Net780GpsPoint[] = []
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!

    const distFromPrevRawKm = haversineDistanceKm(prevRaw.lat, prevRaw.lon, p.lat, p.lon)
    if (prevRawAnomalous && distFromPrevRawKm < MIN_JUMP_DIST_KM) {
      // 直前の異常クラスタに留まったまま: 経過時間で速度が下がって見えても採用しない。
      // ただし移動トレンドの一時停止 (信号待ち等) の可能性もあるため保留には積んでおく
      // (静止のままなら累積移動が増えず、トレンド確定には至らない)。
      pending.push(p)
      prevRaw = p
      continue
    }

    if (prevRawAnomalous) {
      // 異常判定中に prevRaw から実際に移動した: 隣接生点間の速度が妥当なら
      // 「ジャンプ後に再開した実走行トレンド」の候補として保留を継続する。
      const dtPrevSec = p.ts - prevRaw.ts
      const pairwisePlausible = dtPrevSec > 0
        && dtPrevSec <= TREND_MAX_GAP_SECS
        && distFromPrevRawKm / (dtPrevSec / 3600) <= MAX_PLAUSIBLE_SPEED_KMH
      if (pairwisePlausible) {
        pending.push(p)
        prevRaw = p
        const trendStart = pending[0]!
        if (haversineDistanceKm(trendStart.lat, trendStart.lon, p.lat, p.lon) >= TREND_MIN_TRAVEL_KM) {
          // トレンド確定: 保留分を採用し、基準点を現在点へ再同期する。
          kept.push(...pending)
          pending = []
          anchor = p
          prevRawAnomalous = false
        }
        continue
      }
      // トレンド不成立 (大きく飛んだ / 時間が空きすぎた): 保留を破棄し基準点判定へ。
      pending = []
    }

    const dtSec = p.ts - anchor.ts
    if (dtSec <= 0) {
      kept.push(p)
      anchor = p
      prevRaw = p
      prevRawAnomalous = false
      continue
    }
    const distFromAnchorKm = haversineDistanceKm(anchor.lat, anchor.lon, p.lat, p.lon)
    const speedKmh = distFromAnchorKm / (dtSec / 3600)
    if (speedKmh > MAX_PLAUSIBLE_SPEED_KMH && distFromAnchorKm > MIN_JUMP_DIST_KM) {
      prevRaw = p
      prevRawAnomalous = true
      pending = [p]
      continue
    }
    kept.push(p)
    anchor = p
    prevRaw = p
    prevRawAnomalous = false
    pending = []
  }
  return kept
}

/**
 * GPS 点列から (0,0) プレースホルダー・通信断区間・物理的にありえないジャンプを
 * 除外した有効点列を返す (暦日分割なし版)。`buildDailyGpsPoints` の除外ロジックを
 * 抽出したもの (SoT 一本化、イベント行選択の速度カラー Map でも共用する)。
 */
export function filterValidGpsPoints(points: Net780GpsPoint[], events: Net780EventSummary[] = []): Net780GpsPoint[] {
  const outageRanges = extractCommOutageRanges(events)
  return filterImplausibleGpsJumps(
    points.filter(p => (p.lat !== 0 || p.lon !== 0) && !isWithinRanges(p.ts, outageRanges)),
  )
}

/**
 * GPS 位置情報を JST 暦日ごとに分割する (buildDailySpeedCharts と同じ日付境界)。
 * GPS 未捕捉時の `(0,0)` プレースホルダー (lat/lon とも 0) は地図表示上ノイズに
 * なるだけなので除外する。
 *
 * `events` を渡すと、通信断 (0xB8) 〜 通信復帰 (0xB9) の区間内に記録された GPS 点も
 * あわせて除外する。さらに、残った点列に対して `filterImplausibleGpsJumps` で
 * 物理的にありえない移動ジャンプを検出・除外する (通信断と無関係に発生する GPS
 * 異常もカバーするための主防御線、詳細は同関数のコメント参照)。
 */
export function buildDailyGpsPoints(points: Net780GpsPoint[], events: Net780EventSummary[] = []): DailyGpsPoints[] {
  const valid = filterValidGpsPoints(points, events)
  if (valid.length === 0) return []

  const byDate = new Map<string, Net780GpsPoint[]>()
  for (const p of valid) {
    const date = net780DateKey(p.ts)
    let arr = byDate.get(date)
    if (!arr) {
      arr = []
      byDate.set(date, arr)
    }
    arr.push(p)
  }

  return [...byDate.keys()].sort().map(date => ({ date, points: byDate.get(date)! }))
}

/**
 * 日次チャート上の x 座標比率 (0..1、viewBox 全幅に対する割合) を、その日の
 * 絶対時刻 (UNIX epoch 秒) に変換する。`buildSpeedChartData` の
 * `x = padding + ((t - dayStart) / 86400) * innerW` の逆変換 (シーク用)。
 * `dayStart` 〜 `dayStart + 86400` にクランプする。
 */
export function chartXRatioToTime(
  ratio: number,
  dayStart: number,
  chartWidth: number,
  padding: number,
): number {
  const innerW = chartWidth - padding * 2
  const x = ratio * chartWidth
  const frac = innerW > 0 ? (x - padding) / innerW : 0
  const clamped = Math.min(1, Math.max(0, frac))
  return dayStart + clamped * 24 * 60 * 60
}

// --- 運行詳細ページ「イベント」タブ: 行選択 → 速度カラー GPS Map ---

/** `ts` を持つ時刻昇順の点列を [fromTs, toTs] (両端含む) で絞り込む。 */
export function filterPointsByRange<T extends { ts: number }>(
  points: T[],
  fromTs: number,
  toTs: number,
): T[] {
  return points.filter(p => p.ts >= fromTs && p.ts <= toTs)
}

export interface SpeedColoredSegment {
  from: Net780GpsPoint
  to: Net780GpsPoint
  /** 区間平均速度。算出不能 (フォールバックの許容範囲も超えて .spd サンプルが無い) 場合は null。 */
  speedKmh: number | null
  color: string
}

/** .spd サンプルを区間内平均で探す際、区間内に1件もサンプルが無い場合にだけ許容する
 *  最寄りサンプルとの時間差 (秒)。.gpd は概ね60秒間隔なので、それより余裕を持たせる。 */
const SPEED_MATCH_TOLERANCE_SECS = 90

/** ts 昇順の配列から `ts >= target` になる最小indexを二分探索で返す。 */
function lowerBoundByTs(samples: Array<{ ts: number }>, target: number): number {
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (samples[mid]!.ts < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 隣接 GPS 点ペアごとに、その区間 [from.ts, to.ts] に収まる .spd サンプルの平均速度で
 * セグメントを色分けする (GPS 1点への最寄りspeedスナップではなく区間平均にすることで
 * 0.5秒粒度の速度情報を活かし、急加減速でも色が飛ばないようにする)。
 *
 * GPS (`.gpd`、約60秒間隔) と speed (`.spd`、0.5秒粒度) は別サンプリングだが同一時間基底
 * (どちらも「JST壁時計をそのままUNIX epochとして格納した値」、`formatNet780Ts` 参照) の
 * ため絶対時刻で直接突き合わせられる。
 *
 * 区間内に .spd サンプルが1件も無い場合のみ、区間中央に最も近いサンプルを
 * `SPEED_MATCH_TOLERANCE_SECS` 以内であればフォールバックとして採用する。それも無ければ
 * `speedKmh: null` (呼び出し側はグレー描画する、`speedToColor` 参照)。
 *
 * `gps` は時刻昇順であること (`filterValidGpsPoints` + `filterPointsByRange` の出力を想定)。
 */
export function buildSpeedColoredSegments(
  gps: Net780GpsPoint[],
  speed: Net780SpeedPoint[],
): SpeedColoredSegment[] {
  if (gps.length < 2) return []

  const samples = speed
    .map(p => ({ ts: p.record_start_ts + p.offset_secs, speed_kmh: p.speed_kmh }))
    .sort((a, b) => a.ts - b.ts)

  function averageInWindow(fromTs: number, toTs: number): number | null {
    const startIdx = lowerBoundByTs(samples, fromTs)
    let sum = 0
    let count = 0
    for (let i = startIdx; i < samples.length && samples[i]!.ts <= toTs; i++) {
      sum += samples[i]!.speed_kmh
      count++
    }
    if (count > 0) return sum / count

    // フォールバック: 区間の直前・直後で最も近いサンプルを比較する。
    const mid = (fromTs + toTs) / 2
    const before = samples[startIdx - 1]
    const after = samples[startIdx]
    const beforeDiff = before ? Math.abs(before.ts - mid) : Infinity
    const afterDiff = after ? Math.abs(after.ts - mid) : Infinity
    const nearest = beforeDiff <= afterDiff ? before : after
    const nearestDiff = Math.min(beforeDiff, afterDiff)
    if (nearest && nearestDiff <= SPEED_MATCH_TOLERANCE_SECS) return nearest.speed_kmh
    return null
  }

  const segments: SpeedColoredSegment[] = []
  for (let i = 0; i < gps.length - 1; i++) {
    const from = gps[i]!
    const to = gps[i + 1]!
    const speedKmh = averageInWindow(from.ts, to.ts)
    segments.push({ from, to, speedKmh, color: speedToColor(speedKmh) })
  }
  return segments
}

/** 速度カラー勾配のアンカー点 (km/h → HSL色相)。0-20は緑のまま、20-50で緑→黄、
 *  50-80で黄→赤に線形補間し、80以上は赤に固定する。 */
const SPEED_COLOR_STOPS: Array<{ kmh: number, hue: number }> = [
  { kmh: 0, hue: 120 },
  { kmh: 20, hue: 120 },
  { kmh: 50, hue: 60 },
  { kmh: 80, hue: 0 },
]

/** 速度不明を表すグレー。 */
const SPEED_COLOR_UNKNOWN = '#9ca3af'

/** 速度 (km/h) を HSL グラデーション色に変換する。`null`/`NaN` はグレー
 *  (`SPEED_COLOR_UNKNOWN`)。 */
export function speedToColor(kmh: number | null): string {
  if (kmh === null || Number.isNaN(kmh)) return SPEED_COLOR_UNKNOWN

  const first = SPEED_COLOR_STOPS[0]!
  const last = SPEED_COLOR_STOPS[SPEED_COLOR_STOPS.length - 1]!
  const clamped = Math.max(first.kmh, Math.min(last.kmh, kmh))

  for (let i = 0; i < SPEED_COLOR_STOPS.length - 1; i++) {
    const a = SPEED_COLOR_STOPS[i]!
    const b = SPEED_COLOR_STOPS[i + 1]!
    if (clamped >= a.kmh && clamped <= b.kmh) {
      const ratio = b.kmh === a.kmh ? 0 : (clamped - a.kmh) / (b.kmh - a.kmh)
      const hue = a.hue + (b.hue - a.hue) * ratio
      return `hsl(${hue.toFixed(0)}, 85%, 45%)`
    }
  }
  return SPEED_COLOR_UNKNOWN
}
