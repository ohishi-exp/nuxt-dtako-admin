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

export const driveEventNames = new Set(['一般道空車', 'アイドリング', '一般道実車', '専用道', '高速道'])

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

export function filterRows(
  rows: string[][],
  eventNameIdx: number,
  showDrive: boolean,
): string[][] {
  if (eventNameIdx < 0) return rows
  return rows.filter((row) => {
    const name = (row[eventNameIdx] ?? '').trim()
    const isDrive = driveEventNames.has(name)
    return showDrive ? isDrive : !isDrive
  })
}

export function getDisplayColumns(headers: string[]): { header: string; index: number }[] {
  const cols: { header: string; index: number }[] = []
  for (const h of eventHeaders) {
    const idx = colIndex(headers, h)
    if (idx >= 0) cols.push({ header: h, index: idx })
  }
  return cols
}
