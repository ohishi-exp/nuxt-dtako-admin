export interface CrewGroup {
  label: string
  crewRole: string
  driverName: string
  driverCd: string
  officeName: string
  vehicleName: string
  rows: string[][]
}

export const eventHeaders = ['開始日時', '終了日時', 'イベントCD', 'イベント名', '区間時間', '区間距離', '開始市町村名', '終了市町村名']

export const driveEventNames = new Set(['一般道空車', '一般道実車', '専用道', '高速道'])

export const IDLE_EVENT_NAME = 'アイドリング'

export const eventCellStyleMap: Record<string, string> = {
  '休息': 'text-purple-600 dark:text-purple-400 font-medium',
  '休憩': 'text-teal-600 dark:text-teal-400 font-medium',
  '積み': 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 font-medium',
  '降し': 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300 font-medium',
}

export const eventRowStyleMap: Record<string, string> = {
  '積み': 'bg-green-50/50 dark:bg-green-950/30',
  '降し': 'bg-yellow-50/50 dark:bg-yellow-950/30',
  '休息': 'bg-purple-50/50 dark:bg-purple-950/30',
}

const centerHeaders = new Set(['イベントCD', 'イベント名'])
const rightHeaders = new Set(['区間時間', '区間距離'])

export function colIndex(headers: string[], name: string): number {
  return headers.indexOf(name)
}

export function formatTime(val: string): string {
  if (!val) return ''
  const parts = val.split(' ')
  if (parts.length < 2) return val
  const dateParts = parts[0]!.split('/')
  if (dateParts.length === 3) {
    return `${dateParts[1]}/${dateParts[2]} ${parts[1]}`
  }
  return val
}

export function formatDuration(val: string): string {
  if (!val) return ''
  const num = parseInt(val)
  if (isNaN(num)) return val
  const h = Math.floor(num / 60)
  const m = num % 60
  return h > 0 ? `${h}時間${m}分` : `${m}分`
}

export function formatCell(header: string, val: string): string {
  if (header === '開始日時' || header === '終了日時') return formatTime(val)
  if (header === '区間時間') return formatDuration(val)
  if (header === '区間距離') return val || ''
  return val
}

export function columnAlignClass(header: string): string {
  if (centerHeaders.has(header)) return 'text-center'
  if (rightHeaders.has(header)) return 'text-right'
  return 'text-left'
}

export function eventColorClass(headers: string[], row: string[]): string {
  const idx = colIndex(headers, 'イベント名')
  if (idx < 0) return ''
  const name = (row[idx] ?? '').trim()
  return eventCellStyleMap[name] ?? ''
}

export function eventRowClass(headers: string[], row: string[]): string {
  const idx = colIndex(headers, 'イベント名')
  if (idx < 0) return ''
  const name = (row[idx] ?? '').trim()
  return eventRowStyleMap[name] ?? ''
}

// GPS値を緯度経度に変換（度分形式: 32534932 → 32度53.4932分 → 32.891553）
export function toLatLng(raw: string): number | null {
  if (!raw) return null
  const n = parseInt(raw)
  if (isNaN(n) || n === 0) return null
  const deg = Math.floor(n / 1000000)
  const min = (n % 1000000) / 10000
  return deg + min / 60
}

export function getGpsForCell(
  headers: string[],
  row: string[],
  header: string,
): { lat: number; lng: number } | null {
  const isStart = header === '開始市町村名'
  const latIdx = colIndex(headers, isStart ? '開始GPS緯度' : '終了GPS緯度')
  const lngIdx = colIndex(headers, isStart ? '開始GPS経度' : '終了GPS経度')
  const validIdx = colIndex(headers, isStart ? '開始GPS有効' : '終了GPS有効')

  if (latIdx < 0 || lngIdx < 0) return null
  if (validIdx >= 0 && row[validIdx]?.trim() === '0') return null

  const lat = toLatLng(row[latIdx] ?? '')
  const lng = toLatLng(row[lngIdx] ?? '')
  if (lat === null || lng === null) return null
  return { lat, lng }
}

export function isLocationColumn(header: string): boolean {
  return header === '開始市町村名' || header === '終了市町村名'
}

export function groupByCrewRole(headers: string[], rows: string[][]): CrewGroup[] {
  if (!headers.length || !rows.length) return []

  const roleIdx = colIndex(headers, '対象乗務員区分')
  const driverNameIdx = colIndex(headers, '乗務員名１')
  const driverCdIdx = colIndex(headers, '乗務員CD1')
  const officeIdx = colIndex(headers, '事業所名')
  const vehicleIdx = colIndex(headers, '車輌名')

  if (roleIdx < 0) {
    return [{
      label: '乗務員',
      crewRole: '1',
      driverName: rows[0]?.[driverNameIdx] ?? '',
      driverCd: rows[0]?.[driverCdIdx] ?? '',
      officeName: rows[0]?.[officeIdx] ?? '',
      vehicleName: rows[0]?.[vehicleIdx] ?? '',
      rows,
    }]
  }

  const map = new Map<string, CrewGroup>()
  for (const row of rows) {
    const role = row[roleIdx] ?? '1'
    if (!map.has(role)) {
      map.set(role, {
        label: role === '1' ? '1番乗務員' : `${role}番乗務員`,
        crewRole: role,
        driverName: row[driverNameIdx] ?? '',
        driverCd: row[driverCdIdx] ?? '',
        officeName: row[officeIdx] ?? '',
        vehicleName: row[vehicleIdx] ?? '',
        rows: [],
      })
    }
    map.get(role)!.rows.push(row)
  }

  return [...map.values()].sort((a, b) => a.crewRole.localeCompare(b.crewRole))
}

/** 速度超過イベント名は道路種別 (一般道/専用道/高速道) ごとに
 * `「○○速度オーバー」` という接尾辞付きの名前で記録される (例: 「一般道速度オーバー」、
 * イベントCD 405)。単一の固定文字列と完全一致させると実データを取りこぼすため、
 * この接尾辞での判定にする。 */
export const OVERSPEED_EVENT_SUFFIX = '速度オーバー'

export function isOverspeedEventName(name: string): boolean {
  return name.trim().endsWith(OVERSPEED_EVENT_SUFFIX)
}

/** イベント表の表示タブ分類。走行 (一般道/専用道/高速道の実移動) とアイドリングは
 * 見た目が近いイベントCDでも運行実態が異なる (Refs ユーザーからの実データ指摘:
 * 走行タブにアイドリングが混在していた) ため別タブに分ける。速度超過も走行中の
 * 異常イベントとして別タブで確認できるようにする。 */
export type EventCategory = 'event' | 'drive' | 'idle' | 'overspeed'

export const EVENT_CATEGORY_ORDER: EventCategory[] = ['event', 'drive', 'idle', 'overspeed']

export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = {
  event: 'イベント',
  drive: '走行',
  idle: 'アイドリング',
  overspeed: '速度超過',
}

export function classifyEventName(name: string): EventCategory {
  const trimmed = name.trim()
  if (isOverspeedEventName(trimmed)) return 'overspeed'
  if (trimmed === IDLE_EVENT_NAME) return 'idle'
  if (driveEventNames.has(trimmed)) return 'drive'
  return 'event'
}

export function filterRowsByCategory(
  rows: string[][],
  eventNameIdx: number,
  category: EventCategory,
): string[][] {
  if (eventNameIdx < 0) return rows
  return rows.filter(row => classifyEventName(row[eventNameIdx] ?? '') === category)
}

export function countRowsByCategory(
  rows: string[][],
  eventNameIdx: number,
  category: EventCategory,
): number {
  if (eventNameIdx < 0) return 0
  return rows.filter(row => classifyEventName(row[eventNameIdx] ?? '') === category).length
}

export function getDisplayColumns(headers: string[]): { header: string; index: number }[] {
  const cols: { header: string; index: number }[] = []
  for (const h of eventHeaders) {
    const idx = colIndex(headers, h)
    if (idx >= 0) cols.push({ header: h, index: idx })
  }
  return cols
}

// --- 行選択 → 速度カラー Map (NET780) 用の時刻レンジ算出 ---

// 時刻部分は "8:00:00" のようにゼロ埋めされていない実データがあるため 1-2 桁を許容する
// (formatTime のテストフィクスチャ `'2026/03/07 8:16:22'` 参照)。
const EVENT_DATETIME_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/

/**
 * イベントCSVの `開始日時`/`終了日時` (`"YYYY/MM/DD HH:MM:SS"`) を、net780 の `ts` と
 * 同じ規約 (JST壁時計の数字をそのまま UNIX epoch として読む、TZシフトしない) で
 * epoch秒に変換する。`new Date(val).getTime()` はブラウザのローカルTZで解釈されて
 * ズレる (このプロジェクトはDDMM座標変換等でTZ絡みのズレ事故を繰り返し踏んでいる)
 * ため使わない。パースできない場合は null。
 */
export function parseEventDatetimeToTs(val: string): number | null {
  const m = EVENT_DATETIME_RE.exec(val.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as [number, number, number, number, number, number, number]
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000
}

/**
 * 選択行 (`selectedIdx`、`rows` に対するindex) の `開始日時`→最小、`終了日時`→最大で
 * 時刻レンジを算出する。パース失敗行はスキップする。有効行が1件も無ければ null。
 */
export function selectedRowsTimeRange(
  headers: string[],
  rows: string[][],
  selectedIdx: Iterable<number>,
): { fromTs: number, toTs: number } | null {
  const startIdx = colIndex(headers, '開始日時')
  const endIdx = colIndex(headers, '終了日時')
  if (startIdx < 0 || endIdx < 0) return null

  let fromTs: number | null = null
  let toTs: number | null = null
  for (const idx of selectedIdx) {
    const row = rows[idx]
    if (!row) continue
    const start = parseEventDatetimeToTs(row[startIdx] ?? '')
    const end = parseEventDatetimeToTs(row[endIdx] ?? '')
    if (start !== null && (fromTs === null || start < fromTs)) fromTs = start
    if (end !== null && (toTs === null || end > toTs)) toTs = end
  }

  if (fromTs === null && toTs === null) return null
  const lo = fromTs ?? toTs!
  const hi = toTs ?? fromTs!
  return lo <= hi ? { fromTs: lo, toTs: hi } : { fromTs: hi, toTs: lo }
}
