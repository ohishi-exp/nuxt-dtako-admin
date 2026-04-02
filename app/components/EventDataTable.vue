<script setup lang="ts">
import type { CsvJsonResponse } from '~/types'

const props = defineProps<{
  data: CsvJsonResponse
  loading?: boolean
}>()

// ヘッダーから列インデックスを取得
function colIndex(name: string): number {
  return props.data.headers.indexOf(name)
}

// イベント固有の表示列
const eventHeaders = ['開始日時', '終了日時', 'イベントCD', 'イベント名', '区間時間', '区間距離', '開始市町村名', '終了市町村名']

// 走行系イベント（通常はフィルタで除外、トグルで表示）
const driveEventNames = new Set(['一般道空車', 'アイドリング', '一般道実車', '専用道', '高速道'])
const showDriveEvents = ref(false)

// 乗務員区分でグループ化
interface CrewGroup {
  label: string
  crewRole: string
  driverName: string
  driverCd: string
  officeName: string
  vehicleName: string
  rows: string[][]
}

const crewGroups = computed<CrewGroup[]>(() => {
  const { headers, rows } = props.data
  if (!headers.length) return []

  const roleIdx = colIndex('対象乗務員区分')
  const driverNameIdx = colIndex('乗務員名１')
  const driverCdIdx = colIndex('乗務員CD1')
  const officeIdx = colIndex('事業所名')
  const vehicleIdx = colIndex('車輌名')

  if (roleIdx < 0) {
    // 区分列がなければ全データを1グループに
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
})

const activeCrewRole = ref('1')

// 初期値を最初のグループに合わせる
watch(crewGroups, (groups) => {
  if (groups.length && !groups.find(g => g.crewRole === activeCrewRole.value)) {
    activeCrewRole.value = groups[0]!.crewRole
  }
}, { immediate: true })

const activeGroup = computed(() => crewGroups.value.find(g => g.crewRole === activeCrewRole.value))

// フィルタ済み行
const filteredRows = computed(() => {
  if (!activeGroup.value) return []
  const eventNameIdx = colIndex('イベント名')
  if (eventNameIdx < 0) return activeGroup.value.rows
  return activeGroup.value.rows.filter(row => {
    const name = (row[eventNameIdx] ?? '').trim()
    const isDrive = driveEventNames.has(name)
    return showDriveEvents.value ? isDrive : !isDrive
  })
})

const driveEventCount = computed(() => {
  if (!activeGroup.value) return 0
  const eventNameIdx = colIndex('イベント名')
  if (eventNameIdx < 0) return 0
  return activeGroup.value.rows.filter(row => driveEventNames.has((row[eventNameIdx] ?? '').trim())).length
})

const otherEventCount = computed(() => {
  if (!activeGroup.value) return 0
  return activeGroup.value.rows.length - driveEventCount.value
})

// 表示用のヘッダーとインデックス
const displayColumns = computed(() => {
  const cols: { header: string; index: number }[] = []
  for (const h of eventHeaders) {
    const idx = colIndex(h)
    if (idx >= 0) cols.push({ header: h, index: idx })
  }
  return cols
})

// 日時フォーマット (2026/03/07 8:16:22 → 03/07 08:16:22)
function formatTime(val: string): string {
  if (!val) return ''
  const parts = val.split(' ')
  if (parts.length < 2) return val
  const dateParts = parts[0]!.split('/')
  if (dateParts.length === 3) {
    return `${dateParts[1]}/${dateParts[2]} ${parts[1]}`
  }
  return val
}

// イベント名の色・背景クラス（セル単位）
const eventCellStyleMap: Record<string, string> = {
  '休息': 'text-purple-600 dark:text-purple-400 font-medium',
  '休憩': 'text-teal-600 dark:text-teal-400 font-medium',
  '積み': 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 font-medium',
  '降し': 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300 font-medium',
}
// 行全体の背景
const eventRowStyleMap: Record<string, string> = {
  '積み': 'bg-green-50/50 dark:bg-green-950/30',
  '降し': 'bg-yellow-50/50 dark:bg-yellow-950/30',
  '休息': 'bg-purple-50/50 dark:bg-purple-950/30',
}

function eventColorClass(row: string[]): string {
  const idx = colIndex('イベント名')
  if (idx < 0) return ''
  const name = (row[idx] ?? '').trim()
  return eventCellStyleMap[name] ?? ''
}

function eventRowClass(row: string[]): string {
  const idx = colIndex('イベント名')
  if (idx < 0) return ''
  const name = (row[idx] ?? '').trim()
  return eventRowStyleMap[name] ?? ''
}

// 区間時間を分:秒に変換
function formatDuration(val: string): string {
  if (!val) return ''
  const num = parseInt(val)
  if (isNaN(num)) return val
  const h = Math.floor(num / 60)
  const m = num % 60
  return h > 0 ? `${h}時間${m}分` : `${m}分`
}

function formatCell(header: string, val: string): string {
  if (header === '開始日時' || header === '終了日時') return formatTime(val)
  if (header === '区間時間') return formatDuration(val)
  if (header === '区間距離') return val || ''
  return val
}

// 列ごとの配置クラス
const centerHeaders = new Set(['イベントCD', 'イベント名'])
const rightHeaders = new Set(['区間時間', '区間距離'])

function columnAlignClass(header: string): string {
  if (centerHeaders.has(header)) return 'text-center'
  if (rightHeaders.has(header)) return 'text-right'
  return 'text-left'
}

// GPS列のインデックス
const gpsColumns = computed(() => ({
  startLat: colIndex('開始GPS緯度'),
  startLng: colIndex('開始GPS経度'),
  startValid: colIndex('開始GPS有効'),
  endLat: colIndex('終了GPS緯度'),
  endLng: colIndex('終了GPS経度'),
  endValid: colIndex('終了GPS有効'),
}))

// GPS値を緯度経度に変換（度分形式: 32534932 → 32度53.4932分 → 32.891553）
function toLatLng(raw: string): number | null {
  if (!raw) return null
  const n = parseInt(raw)
  if (isNaN(n) || n === 0) return null
  const deg = Math.floor(n / 1000000)
  const min = (n % 1000000) / 10000
  return deg + min / 60
}

// 市町村名セルのGPS情報を取得
function getGpsForCell(row: string[], header: string): { lat: number; lng: number } | null {
  const g = gpsColumns.value
  const isStart = header === '開始市町村名'
  const latIdx = isStart ? g.startLat : g.endLat
  const lngIdx = isStart ? g.startLng : g.endLng
  const validIdx = isStart ? g.startValid : g.endValid

  if (latIdx < 0 || lngIdx < 0) return null
  // GPS有効フラグチェック（ない場合はスキップ）
  if (validIdx >= 0 && row[validIdx]?.trim() === '0') return null

  const lat = toLatLng(row[latIdx] ?? '')
  const lng = toLatLng(row[lngIdx] ?? '')
  if (lat === null || lng === null) return null
  return { lat, lng }
}

function openGoogleMap(row: string[], header: string) {
  const gps = getGpsForCell(row, header)
  if (!gps) return
  window.open(`https://www.google.com/maps?q=${gps.lat},${gps.lng}`, '_blank')
}

function isLocationColumn(header: string): boolean {
  return header === '開始市町村名' || header === '終了市町村名'
}

function hasGps(row: string[], header: string): boolean {
  return getGpsForCell(row, header) !== null
}
</script>

<template>
  <div class="overflow-auto">
    <div v-if="loading" class="flex items-center justify-center py-8">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 mr-2" />
      <span class="text-gray-400">読み込み中...</span>
    </div>

    <template v-else-if="crewGroups.length">
      <!-- 乗務員タブ（2名以上の場合のみ表示） -->
      <div v-if="crewGroups.length > 1" class="border-b border-gray-200 dark:border-gray-800 flex px-4">
        <button
          v-for="g in crewGroups"
          :key="g.crewRole"
          class="px-3 py-2 text-xs font-medium transition-colors border-b-2"
          :class="activeCrewRole === g.crewRole
            ? 'border-blue-500 text-blue-600'
            : 'border-transparent text-gray-500 hover:text-gray-700'"
          @click="activeCrewRole = g.crewRole"
        >
          {{ g.label }} ({{ g.driverName }})
        </button>
      </div>

      <!-- 共通情報 + フィルタ -->
      <div v-if="activeGroup" class="px-4 py-3 flex flex-wrap gap-4 items-center text-xs text-gray-500 border-b border-gray-100 dark:border-gray-800">
        <span>{{ activeGroup.officeName }}</span>
        <span>{{ activeGroup.vehicleName }}</span>
        <span>{{ activeGroup.driverCd }} {{ activeGroup.driverName }}</span>
        <div class="ml-auto flex items-center gap-2">
          <button
            class="px-2 py-1 rounded text-xs transition-colors"
            :class="!showDriveEvents
              ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
              : 'text-gray-400 hover:text-gray-600'"
            @click="showDriveEvents = false"
          >
            イベント ({{ otherEventCount }})
          </button>
          <button
            class="px-2 py-1 rounded text-xs transition-colors"
            :class="showDriveEvents
              ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
              : 'text-gray-400 hover:text-gray-600'"
            @click="showDriveEvents = true"
          >
            走行 ({{ driveEventCount }})
          </button>
        </div>
      </div>

      <!-- イベントテーブル -->
      <table v-if="activeGroup && displayColumns.length" class="w-full text-xs">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th class="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">#</th>
            <th
              v-for="col in displayColumns"
              :key="col.header"
              class="px-3 py-2 font-medium text-gray-500 whitespace-nowrap"
              :class="columnAlignClass(col.header)"
            >
              {{ col.header }}<span v-if="col.header === '区間距離'" class="text-[10px] text-gray-400 ml-0.5">(km)</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, ri) in filteredRows"
            :key="ri"
            class="border-t border-gray-100 dark:border-gray-800"
            :class="eventRowClass(row)"
          >
            <td class="px-3 py-1.5 text-gray-400">{{ ri + 1 }}</td>
            <td
              v-for="col in displayColumns"
              :key="col.header"
              class="px-3 py-1.5 whitespace-nowrap"
              :class="[columnAlignClass(col.header), col.header === 'イベント名' ? eventColorClass(row) : '']"
            >
              <button
                v-if="isLocationColumn(col.header) && hasGps(row, col.header)"
                class="text-blue-500 hover:text-blue-700 hover:underline cursor-pointer inline-flex items-center gap-0.5"
                @click="openGoogleMap(row, col.header)"
              >
                {{ row[col.index] ?? '' }}
                <UIcon name="i-lucide-map-pin" class="size-3" />
              </button>
              <span v-else>{{ formatCell(col.header, row[col.index] ?? '') }}</span>
            </td>
          </tr>
          <tr v-if="filteredRows.length === 0">
            <td :colspan="displayColumns.length + 1" class="px-3 py-8 text-center text-gray-400">
              データがありません
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <div v-else class="py-8 text-center text-gray-400">
      データがありません
    </div>
  </div>
</template>
