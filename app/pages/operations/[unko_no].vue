<script setup lang="ts">
import { getOperation, getOperationCsv, deleteOperation } from '~/utils/api'
import type { Operation, CsvJsonResponse, CsvType } from '~/types'
import { filterValidGpsPoints, filterPointsByRange, buildSpeedColoredSegments, buildNet780SearchLink } from '~/utils/net780'
import {
  summarizeSelectedRows,
  selectedRowsLocationRange,
  proposeEventRowRange,
  groupLegsByDate,
  rowIndicesInTimeRange,
  type SelectedRowsSummary,
  type SelectedRowsLocationRange,
} from '~/utils/event-data-table'
import type { ProfitPanelLegGroup } from '~/utils/profit-r2'
import { fetchVehicleDailySlips } from '~/utils/ichiban'
import { shiftYmd } from '~/utils/profit-compare'

const route = useRoute()
const router = useRouter()
const unkoNo = route.params.unko_no as string

// Data
const operations = ref<Operation[]>([])
const loading = ref(true)
const deleteConfirm = ref(false)
const deleting = ref(false)

// CSV tabs
const csvTabs = [
  { key: 'events' as CsvType, label: 'イベント' },
  { key: 'kudguri' as CsvType, label: '拘束データ' },
  { key: 'tolls' as CsvType, label: '料金' },
  { key: 'ferries' as CsvType, label: 'フェリー' },
  { key: 'speed' as CsvType, label: '速度' },
]
/** NET780 タブは CSV エンドポイント (getOperationCsv) を経由しないため
 * CsvType には含めず、表示切替専用の別値として扱う (Refs #299)。 */
const allTabs: { key: CsvType | 'net780'; label: string }[] = [
  ...csvTabs,
  { key: 'net780', label: 'NET780' },
]
const activeTab = ref<CsvType | 'net780'>('events')
const csvData = ref<Record<string, CsvJsonResponse>>({})
const csvLoading = ref(false)

// Fetch operation detail
onMounted(async () => {
  try {
    operations.value = await getOperation(unkoNo)
  } catch (e) {
    console.error('Failed to fetch operation:', e)
  } finally {
    loading.value = false
  }
  if (activeTab.value !== 'net780') await loadCsv(activeTab.value)
})

async function loadCsv(csvType: CsvType) {
  if (csvData.value[csvType]) return
  csvLoading.value = true
  try {
    csvData.value[csvType] = await getOperationCsv(unkoNo, csvType)
  } catch (e) {
    console.error(`Failed to load ${csvType}:`, e)
    csvData.value[csvType] = { headers: [], rows: [] }
  } finally {
    csvLoading.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab !== 'net780') loadCsv(tab)
})

const primary = computed(() => operations.value[0])

/** NET780 検索 (/net780) の車輌CD/乗務員CD 事前入力用。Operation.vehicle_id/
 * driver_id は rust-alc-api の内部UUID (vehicles/employees テーブルのPK) で
 * CDとは別物だが、raw_data (取込元 KUDGURI.csv の生カラムをそのまま保持した
 * もの) に "車輌CD"/"対象乗務員CD"(無ければ"乗務員CD1") が文字列で入っている
 * ため、これを直接読む (別途一覧取得は不要、Refs #299)。 */
function rawDataString(raw: Record<string, unknown> | undefined, key: string): string | null {
  const v = raw?.[key]
  return typeof v === 'string' && v !== '' ? v : null
}
const net780VehicleCd = computed(() => rawDataString(primary.value?.raw_data, '車輌CD'))
const net780DriverCd = computed(() =>
  rawDataString(primary.value?.raw_data, '対象乗務員CD') ?? rawDataString(primary.value?.raw_data, '乗務員CD1'),
)

// --- イベントタブ: 行選択 (複数可) → 右下に速度カラー Map ---

/** イベントタブでの選択に応じてのみ lazy fetch する (composable がモジュールcacheで
 * NET780 タブと dedup する)。 */
const net780Data = useNet780OperationData(() => unkoNo)
const selectedEventRange = ref<{ fromTs: number, toTs: number } | null>(null)
const selectedEventSummary = ref<SelectedRowsSummary | null>(null)
const selectedEventLocation = ref<SelectedRowsLocationRange | null>(null)
/** ProfitPanel だけを閉じる (デジタコ実績パネルとは独立、選択が変わったら再表示する)。 */
const profitPanelDismissed = ref(false)

watch(activeTab, (tab) => {
  if (tab !== 'events') {
    selectedEventRange.value = null
    selectedEventSummary.value = null
    selectedEventLocation.value = null
  }
})

function onSelectedRangeChange(range: { fromTs: number, toTs: number } | null) {
  selectedEventRange.value = range
  if (range) net780Data.ensureLoaded()
}

function onSelectedSummaryChange(summary: SelectedRowsSummary | null) {
  selectedEventSummary.value = summary
  profitPanelDismissed.value = false
}

function onSelectedLocationChange(location: SelectedRowsLocationRange | null) {
  selectedEventLocation.value = location
}

// --- 一番星の伝票から積み〜降し区間を提案 (Refs #330 実運用フィードバック:
//     「同じ得意先ならだいたい同じ売上・同じ区間になるのだから、提案してユーザーは
//     確認するだけでいいはず」)。イベント表を手動で1行ずつ探して選択する代わりに、
//     この運行の車輌・日付で一番星の伝票を検索し、伝票の積地・卸地に対応する
//     イベント行区間を自動検出して選択状態に反映する。`proposedEventRange` を
//     EventCrewPanel に渡し、対応する filteredRows のチェックボックスにも反映する
//     (以前はページ側の ref だけ更新してチェックボックスが連動しない実運用回帰があった)。

type ProposeStatus = 'idle' | 'loading' | 'done' | 'not-found' | 'error'
const proposeStatus = ref<ProposeStatus>('idle')
/** 直近の提案で union した積み/降しペアの件数 (Refs #356: 同日往復2回等で2以上に
 * なる場合、レグを1本しか提案できていないと誤解されないよう画面に通知する)。 */
const proposedLegCount = ref(0)
/** EventCrewPanel へ「この区間を選択状態にして」と伝える外部指示チャネル。
 * `selectedEventRange` (EventCrewPanel からの emit で更新される、下流表示用) とは
 * 別に持つ — 同じ ref を双方向に使うと EventCrewPanel 側の emit が上書きし合い
 * 無限ループ/競合の元になる。 */
const proposedEventRange = ref<{ fromTs: number, toTs: number } | null>(null)
/** 日付をまたぐレグがある場合の日付ごとのデジタコ実績 (Refs #356 派生要望:
 * 「日付が違う部分を分けて別々に登録したい」)。ProfitPanel に渡し、伝票候補を
 * 日付ごとにグループ化して個別に保存できるようにする。日付が1つしか無ければ
 * (同日往復のみ、または通常の単一レグ) 空配列にし、ProfitPanel は従来通りの
 * 単一保存フローのままにする。 */
const proposedLegGroups = ref<ProfitPanelLegGroup[]>([])

function applyProposedRange(headers: string[], rows: string[][], range: { fromTs: number, toTs: number }) {
  const idx = rowIndicesInTimeRange(headers, rows, range.fromTs, range.toTs)
  selectedEventRange.value = range
  selectedEventSummary.value = summarizeSelectedRows(headers, rows, idx)
  selectedEventLocation.value = selectedRowsLocationRange(headers, rows, idx)
  proposedEventRange.value = range
  profitPanelDismissed.value = false
  net780Data.ensureLoaded()
}

/** `プロポーズしたレグを日付ごとに union し、それぞれの区間のデジタコ実績を計算する。
 * 日付が1つだけなら (同日往復のみ) 分割保存の余地が無いため空配列を返す。 */
function buildLegGroups(headers: string[], rows: string[][], legs: { fromTs: number, toTs: number }[]): ProfitPanelLegGroup[] {
  const dateGroups = groupLegsByDate(legs)
  if (dateGroups.length <= 1) return []
  return dateGroups.map(({ date, fromTs, toTs }) => ({
    date,
    range: { fromTs, toTs },
    summary: summarizeSelectedRows(headers, rows, rowIndicesInTimeRange(headers, rows, fromTs, toTs)),
  }))
}

async function proposeFromSlips() {
  const vehicleCode = net780VehicleCd.value
  const opDate = primary.value?.operation_date ?? primary.value?.reading_date
  if (!vehicleCode || !opDate) return
  proposeStatus.value = 'loading'
  try {
    await loadCsv('events')
    const csv = csvData.value.events
    if (!csv || csv.rows.length === 0) {
      proposeStatus.value = 'not-found'
      return
    }
    // reading_date/operation_date (タコグラフ読取日) は一番星の売上年月日と1日前後
    // ずれうる (翌朝読み取り等、profit-compare.ts の operationSearchDateRange と同じ
    // 理由) ため前後1日を広げて検索する。
    const slips = await fetchVehicleDailySlips(vehicleCode, shiftYmd(opDate, -1), shiftYmd(opDate, 2))
    for (const slip of slips) {
      const originCity = slip.originAreaName || slip.origin
      const destCity = slip.destAreaName || slip.dest
      const range = proposeEventRowRange(csv.headers, csv.rows, originCity, destCity)
      if (range) {
        applyProposedRange(csv.headers, csv.rows, range)
        activeTab.value = 'events'
        proposedLegCount.value = range.legs.length
        proposedLegGroups.value = buildLegGroups(csv.headers, csv.rows, range.legs)
        proposeStatus.value = 'done'
        return
      }
    }
    proposeStatus.value = 'not-found'
  }
  catch {
    proposeStatus.value = 'error'
  }
}

/** ProfitPanel に渡す日付グループ。手動でイベント選択を変えた後は提案時のレグ
 * 情報が現在の選択と対応しなくなるため (提案区間そのままの間だけ有効)、
 * `selectedEventRange` が `proposedEventRange` と一致する間だけ渡す。 */
const profitPanelLegGroups = computed(() => {
  const proposed = proposedEventRange.value
  const selected = selectedEventRange.value
  if (!proposed || !selected) return []
  if (proposed.fromTs !== selected.fromTs || proposed.toTs !== selected.toTs) return []
  return proposedLegGroups.value
})

/** 選択区間の積地・卸地で `/profit/compare` (類似運行検索) に飛ぶためのクエリ。
 * 車輌は含めない (「似た運行」は他車輌も含めて探したいため)。積地・卸地とも
 * 空なら (市町村名が取れない選択) リンク自体を出さない。 */
const similarOperationsQuery = computed(() => {
  const loc = selectedEventLocation.value
  if (!loc) return null
  const origin = loc.originCity.trim()
  const dest = loc.destCity.trim()
  if (!origin && !dest) return null
  const query: Record<string, string> = {}
  if (origin) query.origin = origin
  if (dest) query.dest = dest
  return query
})

const eventMapSegments = computed(() => {
  const result = net780Data.result.value
  const range = selectedEventRange.value
  if (!result || !range) return []
  const valid = filterValidGpsPoints(result.gps, result.events)
  const ranged = filterPointsByRange(valid, range.fromTs, range.toTs)
  return buildSpeedColoredSegments(ranged, result.speed)
})

/** 選択範囲内の .spd サンプル。EventSpeedMapPanel の Map 下の速度チャートに渡す。 */
const eventMapSpeedPoints = computed(() => {
  const result = net780Data.result.value
  const range = selectedEventRange.value
  if (!result || !range) return []
  return result.speed.filter((p) => {
    const t = p.record_start_ts + p.offset_secs
    return t >= range.fromTs && t <= range.toTs
  })
})

const net780SearchLink = computed(() => buildNet780SearchLink({
  readingDate: primary.value?.reading_date,
  vehicleCd: net780VehicleCd.value,
  driverCd: net780DriverCd.value,
}))

async function handleDelete() {
  deleting.value = true
  try {
    await deleteOperation(unkoNo)
    router.push('/operations')
  } catch (e) {
    console.error('Failed to delete:', e)
  } finally {
    deleting.value = false
    deleteConfirm.value = false
  }
}

function formatDatetime(val: string | null): string {
  if (!val) return '-'
  return new Date(val).toLocaleString('ja-JP')
}
</script>

<template>
  <div class="space-y-6">
    <!-- Back button -->
    <UButton label="一覧に戻る" icon="i-lucide-arrow-left" variant="ghost" to="/operations" />

    <div v-if="loading" class="flex items-center justify-center py-12">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-6" />
    </div>

    <template v-else-if="primary">
      <!-- Header -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
        <div class="flex items-start justify-between">
          <div>
            <h2 class="text-xl font-bold mb-4">運行 {{ unkoNo }}</h2>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span class="text-gray-500 block">読取日</span>
                {{ primary.reading_date }}
              </div>
              <div>
                <span class="text-gray-500 block">出発</span>
                {{ formatDatetime(primary.departure_at) }}
              </div>
              <div>
                <span class="text-gray-500 block">帰着</span>
                {{ formatDatetime(primary.return_at) }}
              </div>
              <div>
                <span class="text-gray-500 block">走行距離</span>
                {{ primary.total_distance?.toFixed(1) ?? '-' }} km
              </div>
              <div>
                <span class="text-gray-500 block">安全スコア</span>
                <span :class="(primary.safety_score ?? 0) >= 80 ? 'text-green-600' : 'text-yellow-600'">
                  {{ primary.safety_score?.toFixed(1) ?? '-' }}
                </span>
              </div>
              <div>
                <span class="text-gray-500 block">省エネスコア</span>
                <span :class="(primary.economy_score ?? 0) >= 80 ? 'text-green-600' : 'text-yellow-600'">
                  {{ primary.economy_score?.toFixed(1) ?? '-' }}
                </span>
              </div>
              <div>
                <span class="text-gray-500 block">総合スコア</span>
                <span :class="(primary.total_score ?? 0) >= 80 ? 'text-green-600' : 'text-yellow-600'">
                  {{ primary.total_score?.toFixed(1) ?? '-' }}
                </span>
              </div>
            </div>
          </div>

          <UButton
            label="削除"
            icon="i-lucide-trash-2"
            color="error"
            variant="outline"
            @click="deleteConfirm = true"
          />
        </div>
      </div>

      <!-- CSV Tabs -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
        <div class="border-b border-gray-200 dark:border-gray-800 flex">
          <button
            v-for="tab in allTabs"
            :key="tab.key"
            class="px-4 py-3 text-sm font-medium transition-colors border-b-2"
            :class="activeTab === tab.key
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
          </button>
          <div v-if="activeTab === 'events'" class="ml-auto self-center mr-4 flex items-center gap-3 whitespace-nowrap">
            <button
              class="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50 disabled:no-underline"
              :disabled="proposeStatus === 'loading'"
              @click="proposeFromSlips"
            >
              {{ proposeStatus === 'loading' ? '提案中...' : '一番星の伝票から区間を提案' }}
            </button>
            <span v-if="proposeStatus === 'not-found'" class="text-xs text-gray-400">一致する伝票が見つかりませんでした</span>
            <span v-else-if="proposeStatus === 'error'" class="text-xs text-red-500">提案に失敗しました</span>
            <span v-else-if="proposeStatus === 'done' && proposedLegCount > 1" class="text-xs text-amber-600 dark:text-amber-400">
              同一区間のレグが{{ proposedLegCount }}件見つかったため全て選択範囲に含めました
            </span>
            <NuxtLink
              v-if="similarOperationsQuery"
              :to="{ path: '/profit/compare', query: similarOperationsQuery }"
              class="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              類似運行を探す →
            </NuxtLink>
          </div>
        </div>
        <Net780OperationSummary
          v-if="activeTab === 'net780'"
          :operation-no="unkoNo"
          :reading-date="primary.reading_date"
          :vehicle-cd="net780VehicleCd"
          :driver-cd="net780DriverCd"
        />
        <EventDataTable
          v-else-if="activeTab === 'events'"
          :data="csvData[activeTab] || { headers: [], rows: [] }"
          :loading="csvLoading && !csvData[activeTab]"
          :proposed-range="proposedEventRange"
          @update:selected-range="onSelectedRangeChange"
          @update:selected-summary="onSelectedSummaryChange"
          @update:selected-location="onSelectedLocationChange"
        />
        <CsvDataTable
          v-else
          :headers="csvData[activeTab]?.headers || []"
          :rows="csvData[activeTab]?.rows || []"
          :loading="csvLoading && !csvData[activeTab]"
        />
      </div>
    </template>

    <div v-else class="text-center py-12 text-gray-400">
      運行データが見つかりません
    </div>

    <EventSpeedMapPanel
      v-if="activeTab === 'events' && selectedEventRange"
      :status="net780Data.status.value"
      :error-message="net780Data.error.value"
      :net780-search-link="net780SearchLink"
      :segments="eventMapSegments"
      :speed-points="eventMapSpeedPoints"
      :range="selectedEventRange"
      @close="selectedEventRange = null"
    />

    <EventSelectionSummaryPanel
      v-if="activeTab === 'events' && selectedEventSummary"
      :summary="selectedEventSummary"
      @close="selectedEventSummary = null"
    />

    <ProfitPanel
      v-if="activeTab === 'events' && selectedEventSummary && !profitPanelDismissed"
      :vehicle-code="net780VehicleCd"
      :unko-no="unkoNo"
      :range="selectedEventRange"
      :location="selectedEventLocation"
      :summary="selectedEventSummary"
      :leg-groups="profitPanelLegGroups"
      @close="profitPanelDismissed = true"
    />

    <!-- Delete confirmation modal -->
    <UModal v-model:open="deleteConfirm">
      <template #content>
        <div class="p-6 space-y-4">
          <h3 class="text-lg font-bold">運行データの削除</h3>
          <p class="text-gray-600 dark:text-gray-400">
            運行 {{ unkoNo }} を削除しますか？この操作は取り消せません。
          </p>
          <div class="flex justify-end gap-2">
            <UButton label="キャンセル" variant="outline" @click="deleteConfirm = false" />
            <UButton label="削除" color="error" :loading="deleting" @click="handleDelete" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
