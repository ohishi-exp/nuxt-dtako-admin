<script setup lang="ts">
import { getOperation, getOperationCsv, deleteOperation } from '~/utils/api'
import type { Operation, CsvJsonResponse, CsvType } from '~/types'
import { filterValidGpsPoints, filterPointsByRange, buildSpeedColoredSegments, buildNet780SearchLink } from '~/utils/net780'
import {
  summarizeSelectedRows,
  selectedRowsLocationRange,
  proposeEventRowRange,
  rowIndicesInTimeRanges,
  type SelectedRowsSummary,
  type SelectedRowsLocationRange,
} from '~/utils/event-data-table'
import { extractAllowanceLegs } from '~/utils/allowance-trips'
import { fetchVehicleDailySlips } from '~/utils/ichiban'
import { shiftYmd } from '~/utils/profit-compare'
import {
  OPERATION_LEG_SALES_KEY,
  LEG_SALES_TITLE,
  LEG_SALES_PANEL_NOTE,
  parseOperationLegSales,
  lookupOperationLegSales,
  legSaleYen,
  type OperationLegSalesLookup,
} from '~/utils/operation-leg-sales'
import {
  legSalesYmCandidates,
  pickBestR2LegSales,
  resolveLegSalesPanel,
  shouldLoadLegSalesFromR2,
  type LegSalesR2Fetch,
  type OperationLegSalesR2,
} from '~/utils/operation-leg-sales-r2'
import { operationRunDate } from '~/utils/allowance-report'

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

// --- 便ごとの「粗利タブの計上額」 (突合一本化 PR-1、Refs #820) ---------------
// **突合はここでやり直さない。** `reconcileVehicles` は明細のプールを順に消費するので、
// 1 運行だけで突合し直すと月次の突合が別の運行に割り当てた明細に当たり得る (粗利タブと
// 違う金額が出る画面になる)。**粗利タブが突合したときに別キーへ書いた要約を読むだけ。**
//
// **画面には数字が 2 か所に出るが、別のエンジンではない** (#849 で変わった)。こちらが
// 「粗利タブの計上額」(①が月全体を回した結果のうちこの運行のぶん)、画面下の
// `ProfitPanel` が**その①への人の上書き** (`FORCE_MATCH_KEY`)。**結ぶとこちらも動く**
// — ただし**次に粗利タブで集計してから**なので、`LEG_SALES_PANEL_NOTE` で毎回
// 「結んだ直後に動かないのは正常」まで言う (#851)。
//
// 「一番星の伝票から区間を提案」も**別のもの** (伝票から区間を当てる提案で、突合結果
// ではない)。区画も見出しも分けてある。
const legSales = ref<OperationLegSalesLookup>({ status: 'missing' })

/** 粗利タブが書いた要約。**読めなければ `missing`** (「粗利タブで集計すると出ます」)。 */
function readLegSales(): OperationLegSalesLookup {
  try {
    return lookupOperationLegSales(parseOperationLegSales(localStorage.getItem(OPERATION_LEG_SALES_KEY)), unkoNo)
  }
  catch {
    // localStorage 自体が読めない環境。突合し直して埋めることはしない。
    return { status: 'missing' }
  }
}

// --- この端末で集計していないときの落とし先 (R2 の版、Refs #865 / #867) -------
// **必要なデータは既に R2 にある** (`MarginCache.operations[].legs` が #826 で
// `margin-summary` に入っている)。読む経路が無かっただけなので、**読むだけ**足す。
// **localStorage を先に見る順序は変えない** (集計直後の値が即反映される挙動を壊さない)。
// **出どころは画面で言い分ける** — 版は古いことがある (最後に誰かが集計した時点)。
// **落ちるのは `missing` だけではない** (#867)。この端末に**別の月**の突合結果がある
// (`not-aggregated`) ときも「この端末に答えが無い」ことに変わりはないので R2 を見る。
const legSalesR2 = ref<LegSalesR2Fetch>({ state: 'loading' })

/** 計上額パネルが出すもの (中身 / 出どころ / 出せない理由)。判断は pure 側 (テスト済み)。 */
const legSalesPanel = computed(() => resolveLegSalesPanel(legSales.value, legSalesR2.value))
/** 突合結果が無いときに出す一言。あるときは `null` (便を並べる)。 */
const legSalesMissingNote = computed(() => legSalesPanel.value.note)
/** 突合結果があるときだけの中身 (template で union を絞らずに読むため)。 */
const legSalesReady = computed(() => legSalesPanel.value.ready)
/**
 * 便ごとの表示行。**`yen` が `null` の便は「当たっていません」**と出す —
 * ¥0 と出すと「売上 0 円の便」に読めてしまう。
 */
const legSaleRows = computed(() =>
  (legSalesReady.value?.legs ?? []).map(leg => ({ ...leg, yen: legSaleYen(leg) })))

/**
 * R2 の版を見に行く。**この端末にこの運行の結果があるときは 1 回も叩かない**
 * (`ready` = 古い版で上書きしない)。
 *
 * **`missing` 以外を全部止めない** (#867)。`not-aggregated` (この端末は別の月を集計して
 * ある) は**この運行の答えを持っていない**ので、R2 に版があれば出せる。止めていたせいで、
 * 2026-06 を集計した端末で 2026-07 の運行を開くと**R2 に版があるのに**
 * 「この運行はありません」しか出なかった。
 *
 * 月は `operationRunDate` (粗利タブと同じ月の切り方の材料) から出し、**前後 1 日ぶんの月も
 * 候補にする** — 粗利タブは運行の開始日で月を切るので、読取日とは 1 日ずれうる
 * (月末・月初の運行を 1 か月だけ見ると「版にこの運行はありません」と嘘をつく)。
 */
async function loadLegSalesFromR2() {
  // 判断は pure 側 1 か所 (`shouldLoadLegSalesFromR2`) — **両側をテストで固定してある**。
  // ここが壊れると集計直後の結果を古い版で上書きする (一番危ない事故)。
  if (!shouldLoadLegSalesFromR2(legSales.value)) return
  const date = operationRunDate(null, primary.value?.operation_date ?? null, unkoNo)
  const yms = legSalesYmCandidates(date)
  if (yms.length === 0) {
    legSalesR2.value = { state: 'no-date' }
    return
  }
  try {
    const results = await Promise.all(yms.map(ym =>
      $fetch<OperationLegSalesR2>('/api/profit/operation-leg-sales', { query: { ym, unkoNo } })))
    // 候補が空になることはない (`yms.length > 0` を上で見ている) ので `pickBest` は必ず値を返す。
    legSalesR2.value = { state: 'done', result: pickBestR2LegSales(results)!, checkedYms: yms }
  }
  catch (e) {
    // **黙って「集計されていません」に倒さない。** 読めなかったことを画面で言う。
    // **どの月を見に行って失敗したのかまで言う** (#867) — 失敗の文言は本文に月を
    // 書かないので、`checkedYms` が無いと「見に行かなかった」と区別が付かない。
    legSalesR2.value = {
      state: 'failed',
      message: e instanceof Error ? e.message : String(e),
      checkedYms: yms,
    }
  }
}

const yen = (v: number) => `¥${Math.round(v).toLocaleString()}`

// Fetch operation detail
onMounted(async () => {
  legSales.value = readLegSales()
  try {
    operations.value = await getOperation(unkoNo)
  } catch (e) {
    console.error('Failed to fetch operation:', e)
  } finally {
    loading.value = false
  }
  // 運行が読めてからでないと月を決められない (`operation_date`)。**画面の描画は待たせない。**
  void loadLegSalesFromR2()
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

type ProposeStatus = 'idle' | 'loading' | 'done' | 'not-found' | 'error' | 'ambiguous'
const proposeStatus = ref<ProposeStatus>('idle')
/** 直近の提案で union した積み/降しペアの件数 (Refs #356: 同日往復2回等で2以上に
 * なる場合、レグを1本しか提案できていないと誤解されないよう画面に通知する)。 */
const proposedLegCount = ref(0)
/** EventCrewPanel へ「この区間を選択状態にして」と伝える外部指示チャネル。
 * `selectedEventRange` (EventCrewPanel からの emit で更新される、下流表示用) とは
 * 別に持つ — 同じ ref を双方向に使うと EventCrewPanel 側の emit が上書きし合い
 * 無限ループ/競合の元になる。 */
const proposedEventRange = ref<{ fromTs: number, toTs: number, legs?: { fromTs: number, toTs: number }[] } | null>(null)
interface ProposeCandidate {
  originCity: string
  destCity: string
  range: { fromTs: number, toTs: number, legs: { fromTs: number, toTs: number }[] }
}
/** 複数の別得意先向け配送が同じ運行に混在し、それぞれ独立に区間が見つかった場合の
 * 候補一覧 (実運用回帰: 標茶町向けと上士幌町向けが同一運行にあり、最初にマッチした
 * 伝票の配送先をそのまま採用すると無関係な配送まで union してしまっていた)。
 * 2件以上あれば自動適用せず、ユーザーにどちらを反映するか選ばせる。 */
const proposeCandidates = ref<ProposeCandidate[]>([])

function applyProposedRange(
  headers: string[],
  rows: string[][],
  range: { fromTs: number, toTs: number, legs?: { fromTs: number, toTs: number }[] },
) {
  // レグごとに選んで union する。全レグを 1 区間に潰すと、レグの間に挟まった
  // 無関係な別レグ (別の卸地・休息) まで選択に入る (Refs rowIndicesInTimeRanges)。
  const idx = rowIndicesInTimeRanges(headers, rows, range.legs ?? [range])
  selectedEventRange.value = range
  selectedEventSummary.value = summarizeSelectedRows(headers, rows, idx)
  selectedEventLocation.value = selectedRowsLocationRange(headers, rows, idx)
  proposedEventRange.value = range
  profitPanelDismissed.value = false
  net780Data.ensureLoaded()
}

/** 提案の適用本体。区間・レグ日付グループを反映し `proposeStatus` を確定させる。
 * 候補が1件だけの通常ケースと、複数候補からユーザーが選んだケースの両方から呼ぶ。 */
function applyProposeCandidate(headers: string[], rows: string[][], candidate: ProposeCandidate) {
  applyProposedRange(headers, rows, candidate.range)
  activeTab.value = 'events'
  proposedLegCount.value = candidate.range.legs.length
  proposeCandidates.value = []
  proposeStatus.value = 'done'
}

/** 複数候補の中からユーザーが選んだ配送先を適用する。 */
function selectProposeCandidate(candidate: ProposeCandidate) {
  const csv = csvData.value.events
  if (!csv) return
  applyProposeCandidate(csv.headers, csv.rows, candidate)
}

async function proposeFromSlips() {
  const vehicleCode = net780VehicleCd.value
  const opDate = primary.value?.operation_date ?? primary.value?.reading_date
  if (!vehicleCode || !opDate) return
  proposeStatus.value = 'loading'
  proposeCandidates.value = []
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
    // 同じ運行に複数の別得意先向け配送が混在することがある (実運用回帰: 標茶町向けと
    // 上士幌町向け)。伝票を1件見つけた時点で確定せず、積地・卸地の組ごとに重複を
    // 除いた上で全件試し、複数の別配送が見つかった場合はユーザーに選ばせる。
    const seenRoutes = new Set<string>()
    const candidates: ProposeCandidate[] = []
    for (const slip of slips) {
      const originCity = slip.originAreaName || slip.origin
      const destCity = slip.destAreaName || slip.dest
      const routeKey = `${originCity} ${destCity}`
      if (seenRoutes.has(routeKey)) continue
      seenRoutes.add(routeKey)
      const range = proposeEventRowRange(csv.headers, csv.rows, originCity, destCity)
      if (range) candidates.push({ originCity, destCity, range })
    }
    if (candidates.length === 0) {
      proposeStatus.value = 'not-found'
      return
    }
    if (candidates.length === 1) {
      applyProposeCandidate(csv.headers, csv.rows, candidates[0]!)
      return
    }
    proposeCandidates.value = candidates
    proposeStatus.value = 'ambiguous'
  }
  catch {
    proposeStatus.value = 'error'
  }
}

/**
 * **この運行の便** (`extractAllowanceLegs` = 積みイベント 1 つ = 1 便、Refs #848)。
 * 収支パネルが「選択区間に入る便」を出して、そこに一番星の明細を結ぶのに使う。
 * **便の切り方も鍵も①(粗利タブ・運行手当タブ)と同じ関数**で作る — 別に切り直すと
 * 結んだ相手が①に届かない。
 */
const eventLegs = computed(() => {
  const csv = csvData.value.events
  if (!csv) return []
  return extractAllowanceLegs(csv.headers, csv.rows)
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
            <span v-else-if="proposeStatus === 'ambiguous'" class="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5 flex-wrap">
              複数の配送先候補が見つかりました:
              <button
                v-for="c in proposeCandidates"
                :key="`${c.originCity}-${c.destCity}`"
                class="px-1.5 py-0.5 rounded border border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/40"
                @click="selectProposeCandidate(c)"
              >
                {{ c.originCity }} → {{ c.destCity }} ({{ c.range.legs.length }}レグ)
              </button>
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
        <!-- 便ごとに当たった一番星の売上 (Refs #820)。粗利タブの突合結果を読むだけで、
             この画面では突合し直さない。上の「区間を提案」(提案) とは別物。 -->
        <div
          v-if="activeTab === 'events'"
          class="border-b border-gray-200 dark:border-gray-800 px-4 py-3 text-xs"
        >
          <div class="flex items-baseline gap-2 flex-wrap">
            <span class="font-medium text-gray-700 dark:text-gray-300">{{ LEG_SALES_TITLE }}</span>
            <!-- **出どころを必ず見出しに出す** (Refs #865)。この端末で集計した結果と R2 に
                 保存された版は別物で、版は古いことがある。黙って差し替えると数字が変わった
                 理由が読めなくなる。 -->
            <span v-if="legSalesReady" class="text-gray-400">便ごと / {{ legSalesPanel.sourceLabel }}</span>
            <span v-if="legSalesReady" class="ml-auto">
              <template v-if="legSalesReady.salesYen !== null">
                合計 <b class="tabular-nums">{{ yen(legSalesReady.salesYen) }}</b>
              </template>
              <span v-else class="text-gray-400">どの便も一番星の明細に当たっていません</span>
            </span>
          </div>
          <p v-if="legSalesMissingNote" class="text-gray-400 mt-1">
            {{ legSalesMissingNote }}
          </p>
          <ul v-else class="mt-1 space-y-0.5">
            <li v-for="leg in legSaleRows" :key="leg.seq" class="flex items-baseline gap-2 flex-wrap">
              <span class="text-gray-500 shrink-0">便{{ leg.seq }}</span>
              <template v-if="leg.yen !== null">
                <span class="font-medium tabular-nums">{{ yen(leg.yen) }}</span>
                <span class="text-gray-600 dark:text-gray-300">
                  <template v-for="(c, i) in leg.customers" :key="i">
                    <span v-if="i > 0" class="text-gray-300 dark:text-gray-600"> / </span>
                    <span>{{ c.name }}</span>
                    <!-- 取引先が 2 つ以上ある便だけ内訳の金額も出す (1 つなら便の金額と同じ)。
                         **`&nbsp;` で離す** — 素の空白は template のコンパイル時に落ちて
                         「△△商事¥50,000」と繋がる (mount で実測)。 -->
                    <span
                      v-if="leg.customers.length > 1"
                      class="text-gray-500 tabular-nums"
                    >&nbsp;{{ yen(c.yen) }}</span>
                  </template>
                </span>
                <span v-if="leg.slipIds.length > 0" class="text-gray-400">伝票 {{ leg.slipIds.join(', ') }}</span>
              </template>
              <span v-else class="text-gray-400">一番星の明細に当たっていません</span>
            </li>
          </ul>
          <!-- R2 の版から読んだ回だけの注記 (Refs #865)。版の古さと、伝票番号が版に
               入っていないこと (= 「伝票 …」が出ない理由) を言う。 -->
          <p v-if="legSalesPanel.sourceNote" class="text-gray-400 mt-1.5">
            {{ legSalesPanel.sourceNote }}
          </p>
          <!-- 突合の数字が 2 つ並ぶので、**どちらが計上値か**を毎回言う (混ぜると誤読される)。
               計上額を出しているときだけ添える (何も出ていない区画に他の区画の話は要らない)。 -->
          <p v-if="legSalesReady" class="text-gray-400 mt-1.5">
            {{ LEG_SALES_PANEL_NOTE }}
          </p>
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
      :unko-no="unkoNo"
      :driver-cd="net780DriverCd"
      :range="selectedEventRange"
      :location="selectedEventLocation"
      :summary="selectedEventSummary"
      :legs="eventLegs"
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
