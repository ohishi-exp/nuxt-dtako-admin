<script setup lang="ts">
import { getOperation, getOperations, getOperationCsv, deleteOperation } from '~/utils/api'
import type { Operation, CsvJsonResponse, CsvType } from '~/types'
import { filterValidGpsPoints, filterPointsByRange, buildSpeedColoredSegments, buildNet780SearchLink } from '~/utils/net780'
import {
  summarizeSelectedRows,
  selectedRowsLocationRange,
  proposeEventRowRange,
  proposeCarriedEventRowRange,
  rowIndicesInTimeRanges,
  type CarriedEventRowRange,
  type CarriedProposeResult,
  type SelectedRowsSummary,
  type SelectedRowsLocationRange,
} from '~/utils/event-data-table'
import { extractAllowanceLegs, extractCarryInUnloads } from '~/utils/allowance-trips'
import { pickNextOperationForCarry, carryStartLabel } from '~/utils/allowance-report'
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
import {
  buildOperationRoute,
  buildOverlayTrack,
  splitTrackByWindows,
  parseRouteMapLayers,
  serializeRouteMapLayers,
  ROUTE_MAP_LAYERS_KEY,
  type OperationRoute,
  type RouteMapLayers,
  type RouteSegment,
} from '~/utils/operation-route-map'
import { operationTrackNote, operationRouteMapTitle } from '~/utils/operation-detail-view'

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
/**
 * CSV が**引けなかった**理由 (種類ごと)。`loadCsv` は失敗を空 CSV
 * (`{ headers: [], rows: [] }`) で握り潰すので、これが無いと経路地図が
 * 「取得に失敗した」と「GPS 列が無い / 行が無い」を**同じ見た目**で出してしまう
 * (Refs #873)。表 (`EventDataTable` / `CsvDataTable`) の挙動は変えない — 読むだけ足す。
 */
const csvError = ref<Record<string, string>>({})

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

/**
 * 金額。**`-0` を `+0` に畳んでから出す** (Refs #843)。`Math.round` は `-0.5 ≤ v < 0` で
 * **`-0`** を返し、**`(-0).toLocaleString()` は `"-0"`** なので、そのままだと売上が
 * ちょうど 0 の便に **`¥-0`** と出る。`-0 + 0` は IEEE 754 で `+0`。
 * **変わるのはその窓の回だけ** — `-0.6` は `Math.round` が `-1` を返すので `¥-1` のまま
 * (本当に負の額は負のまま出る)。仕掛けの詳細は `profit/margin.vue` の `yen` に同じ。
 */
const yen = (v: number) => `¥${(Math.round(v) + 0).toLocaleString()}`

// Fetch operation detail
onMounted(async () => {
  legSales.value = readLegSales()
  try {
    // 地図のレイヤは粗利タブと同じキーを共有する (Refs #873)。読めない環境なら既定のまま。
    routeMapLayers.value = parseRouteMapLayers(localStorage.getItem(ROUTE_MAP_LAYERS_KEY))
  }
  catch {
    // localStorage が読めなくても地図は既定のレイヤで出る。
  }
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
    // **引けなかったことを覚える** (Refs #873)。表は従来どおり空で出すが、経路地図は
    // 「取得に失敗した」と「GPS が無い」を言い分けられるようになる。
    csvError.value = { ...csvError.value, [csvType]: e instanceof Error ? e.message : String(e) }
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

/** 提案できなかった状態は**原因ごとに 5 つに分ける** (Refs #822 ①②-1)。同じ文言に
 * 丸めると、押した人が**間違った場所を探しに行く**。**「探す先」で分けている**:
 *
 * - `'error'` … 呼んで落ちた (イベント行が引けなかった場合を含む)。
 *   **押し直せば変わりうる** (赤)
 * - `'not-found'` … 一番星を呼んだが**伝票が 1 件も無い**。探す先は一番星 (灰)
 * - `'no-events'` … **この運行にイベント行が 1 行も無い**。伝票は**見てすらいない**ので
 *   一番星に行かせてはいけない。探す先は取込元 (デジタコ) (琥珀)
 * - `'no-event-match'` … **伝票はあるのに**、その積地・卸地に対応する積み降しが
 *   イベント行に無い (`proposeEventRowRange` が全件 null)。探す先は**イベント表**で、
 *   一番星を見に行っても伝票はちゃんとある。押し直しても変わらない (琥珀)
 * - `'unavailable'` … **呼ぶための材料 (車輌CD / 運行日) がそもそも無い**。
 *   一番星は呼んですらいない。押し直しても変わらない (琥珀)
 * - `'carried-choice'` … **卸地を次の運行の先頭の降しで代用した候補がある** (Refs #926)。
 *   `'ambiguous'` (実データの候補が複数) と**別に持つ** — 代用は 1 件でも自動適用せず、
 *   人のクリックを 1 回挟む。1 件しか無いのに「複数の配送先候補」と言うのも嘘になる
 *
 * 押し直しても変わらない 3 つ (`'no-events'` / `'no-event-match'` / `'unavailable'`) を
 * `'error'` の赤と同じ見た目にすると「もう一度押せば直るかも」と読ませてしまうので
 * 色も分ける。ただし**この 3 つも互いに別物** — イベントが無いのか、材料が無いのか、
 * 材料はあるが対応が取れないのか。 */
type ProposeStatus = 'idle' | 'loading' | 'done' | 'not-found' | 'error' | 'ambiguous' | 'unavailable' | 'no-event-match' | 'no-events' | 'carried-choice'
const proposeStatus = ref<ProposeStatus>('idle')
/** `'unavailable'` のとき**何が欠けているか**。車輌CD と運行日は片方だけ欠けることも
 * 両方欠けることもあり、どちらか分からないと直しようがないので文言を出し分ける。 */
const proposeUnavailableReason = ref('')
/** `'no-event-match'` のとき**伝票が何件あったか**。「伝票が無い」(`'not-found'`) と
 * 読み違えられないよう、**件数を数えて画面に言わせる** (0 件ならこの状態にならない)。 */
const proposeNoMatchSlipCount = ref(0)
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
  /** **卸地を次の運行の先頭の降しで代用した候補**なら中身が入る (Refs #926)。
   * 実データから出た候補と**同じ見た目で並べない**ための印。 */
  carried?: CarriedEventRowRange
}
/** 複数の別得意先向け配送が同じ運行に混在し、それぞれ独立に区間が見つかった場合の
 * 候補一覧 (実運用回帰: 標茶町向けと上士幌町向けが同一運行にあり、最初にマッチした
 * 伝票の配送先をそのまま採用すると無関係な配送まで union してしまっていた)。
 * 2件以上あれば自動適用せず、ユーザーにどちらを反映するか選ばせる。 */
const proposeCandidates = ref<ProposeCandidate[]>([])

// --- 降しイベントが無い最終便を「次の運行の先頭の降し」で代用する (Refs #926 / #822 ②)
//
//     ①(粗利タブ・運行手当タブ) の `carryOverDest` (`allowance-trips.ts`) と**同じ現象**を
//     ②(区間提案) 側で扱う。**①には 1 バイトも触っていない** — 発生条件も解決手段も違う
//     ものを 1 つの関数にまとめると、帯広市内 (川西 / 富士 / 札内) の罠を踏み直す (#822)。
//
//     ★ **お金は動かない。** ここが変えるのは「候補の出し方」だけで、`FORCE_MATCH_KEY`
//     (①への人の上書き) に書くのは `ProfitPanel` と運行手当タブの**人のクリック**だけ。

/** 次の運行を探す窓 (運行日から何日先まで)。
 *
 * **「翌日まで」では足りない。** `allowance-trips.ts` の doc にある実測 (2026-07 の
 * 1109、オンプレ `dtako_events` の 14 運行) では、07-06 開始の運行の代用元が
 * **07-08 開始**で、開始日で 2 日空いている。 */
const CARRY_LOOKAHEAD_DAYS = 3

// ★ **暦月では切らない。**「月をまたぐと確度が落ちる」機序は無い — 代用の規則は
//   「同一乗務員 + 車輌で運行NO順に隣接する次の運行の先頭の降し」で、暦月と無関係。
//   ①(`applyCarryOver`) が暦月で切れるのは**その月ぶんしか fetch していない実装の
//   副作用**であって仕様ではない (`allowance-report.ts` の doc がそう書いている)。
//   実測でも 07-31 開始の運行の卸地が 08-01 の運行の先頭にある (`allowance-trips.ts`
//   の doc、#926 の代表例)。月末だけ提案が出ない穴を残す方が読めない。
//   **またいだ事実は `carriedFromNextMonth` で注記に出す。**
//
// ★ **代用の候補は自動で反映しない** (下の `'carried-choice'`)。代用が外れていた
//   ときの害は「人がそのまま確定してしまう」ことなので、**人のクリックを 1 回必ず
//   挟む**。範囲を狭めずにその害だけを潰せる。

/** 代用の結果。**代用したことと、できなかったことの両方**を画面に出すための材料。
 *
 * **代用を試したなら 0 件でも「0 件」と出す。** 空欄は「該当なし」と「そもそも見て
 * いない」を区別できない — この repo で最も多い欠陥 (出ているものが別の意味に読める)。 */
interface CarryOutcome {
  /** 代用を試した伝票 (積地・卸地の組) の件数。 */
  tried: number
  /** 代用できた件数。 */
  carried: number
  /** 代用できなかった理由と件数 (同じ理由は畳む)。 */
  skips: { reason: string, count: number }[]
}
/** `null` = **代用を試していない** (通常の提案が当たったか、そもそも押していない)。 */
const proposeCarry = ref<CarryOutcome | null>(null)
/**
 * 直近に**適用した提案が代用だった**ときの中身。次に「提案」を押すまで出し続ける。
 *
 * ★ **「いま選択中の区間」と突き合わせて出し分けない。** 一度そう書いて外した:
 * EventCrewPanel が返す選択範囲は**カテゴリで絞った行から derive し直したもの**
 * (`selectedRowsTimeRange(headers, filteredRows, selectedRows)`) なので、代用の
 * 区間に含まれる休息が既定カテゴリから外れるだけで `toTs` が縮み、**適用した
 * 直後に注記が消える**。消えたら「実測だ」と読まれるので、これは倒す向きが逆。
 *
 * だから注記は**「この提案は代用だった」という提案についての文**にしてある。
 * 人がその後チェックを手で足し引きしても、文として嘘にならない。
 */
const proposeAppliedCarried = ref<CarriedEventRowRange | null>(null)
const proposeCarrySkipped = computed(() =>
  proposeCarry.value ? proposeCarry.value.tried - proposeCarry.value.carried : 0)

/** 代用元の運行を人が特定できる形にする — 「(08-01 04:12 開始)」。
 * 運行NO だけだと桁を目で追うことになるので、開始日時を添える。 */
function carriedSourceSuffix(carried: CarriedEventRowRange): string {
  const started = carryStartLabel(carried.carriedFromUnkoNo)
  return started === null ? '' : ` (${started} 開始)`
}

function countSkip(outcome: CarryOutcome, reason: string, n = 1) {
  const hit = outcome.skips.find(s => s.reason === reason)
  if (hit) hit.count += n
  else outcome.skips.push({ reason, count: n })
}

/** 代用できなかった理由の文言。**探す先が違うので 1 つに丸めない** (#822 ① と同じ流儀)。 */
function carrySkipReason(result: CarriedProposeResult, nextUnkoNo: string): string {
  if (result.status === 'has-unload') return 'この便には降しイベントがあるため代用の対象外です'
  if (result.status === 'no-loading') return '伝票の積地に一致する積みが最終便にありません'
  if (result.status === 'no-carry-in') return `次の運行 ${nextUnkoNo} の先頭にも降しがありません`
  if (result.status === 'city-mismatch') return `次の運行の先頭の降し (${result.carriedDestCity}) が伝票の卸地と一致しません`
  return '伝票の積地・卸地、またはイベントCSV の列が読めません'
}

/**
 * 通常の提案が 1 件も当たらなかった伝票に、**次の運行の先頭の降し**を当てて候補を作る。
 *
 * **通信は当たらなかったときだけ。** 通常の提案が当たる運行では
 * `getOperations` も追加の CSV も引かないので、押した瞬間の待ち時間は増えない。
 */
async function buildCarriedCandidates(
  csv: CsvJsonResponse,
  routes: { originCity: string, destCity: string }[],
  vehicleCode: string,
  opDate: string,
): Promise<ProposeCandidate[]> {
  const outcome: CarryOutcome = { tried: routes.length, carried: 0, skips: [] }
  const found = await collectCarriedCandidates(csv, routes, vehicleCode, opDate, outcome)
  // ★ **中身を全部詰めてから ref に入れる。** 先に `proposeCarry.value = outcome` して
  // から生オブジェクトを触ると、Vue の proxy を経由しない更新になり `proposeCarrySkipped`
  // が古い値をキャッシュしたままになる (実際に踏んだ: 1 件代用できているのに
  // 「代用もできなかった便 1件」と出た)。
  proposeCarry.value = outcome
  return found
}

async function collectCarriedCandidates(
  csv: CsvJsonResponse,
  routes: { originCity: string, destCity: string }[],
  vehicleCode: string,
  opDate: string,
  outcome: CarryOutcome,
): Promise<ProposeCandidate[]> {
  // ★ 運行一覧 (`OperationListItem`) は `raw_data` を持たず車輌CD/乗務員CD が読めない。
  //   **引く時点で絞る** — ①の `applyCarryOver` が 乗務員 + 車輌 で束ねるのと同じキー。
  const driverCode = net780DriverCd.value
  let candidates: { unkoNo: string }[]
  try {
    const list = await getOperations({
      vehicle_cd: vehicleCode,
      ...(driverCode ? { driver_cd: driverCode } : {}),
      date_from: opDate,
      date_to: shiftYmd(opDate, CARRY_LOOKAHEAD_DAYS),
    })
    candidates = list.operations.map(o => ({ unkoNo: o.unko_no }))
  }
  catch {
    // **全体を `'error'` に倒さない** — 通常の提案が当たらなかったことは確定していて、
    // そちらの理由は別に出ている。ここは「代用が引けなかった」だけを言う。
    countSkip(outcome, '次の運行の一覧を引けませんでした (押し直すと変わることがあります)', routes.length)
    return []
  }

  const pick = pickNextOperationForCarry(unkoNo, candidates)
  if (pick.status === 'none' || pick.unkoNo === null) {
    countSkip(outcome, `同じ乗務員・車輌の次の運行が運行日から${CARRY_LOOKAHEAD_DAYS}日以内に見つかりません`, routes.length)
    return []
  }

  let nextCsv: CsvJsonResponse
  try {
    nextCsv = await getOperationCsv(pick.unkoNo, 'events')
  }
  catch {
    countSkip(outcome, `次の運行 ${pick.unkoNo} のイベントを引けませんでした (押し直すと変わることがあります)`, routes.length)
    return []
  }

  const carryIn = extractCarryInUnloads(nextCsv.headers, nextCsv.rows)
  const found: ProposeCandidate[] = []
  for (const route of routes) {
    const result = proposeCarriedEventRowRange(csv.headers, csv.rows, route.originCity, route.destCity, {
      unkoNo: pick.unkoNo,
      crossesMonth: pick.crossesMonth,
      cities: carryIn.cities,
      toTs: carryIn.toTs,
    })
    if (result.status === 'ok') {
      outcome.carried += 1
      found.push({ originCity: route.originCity, destCity: route.destCity, range: result.range, carried: result.range })
      continue
    }
    countSkip(outcome, carrySkipReason(result, pick.unkoNo))
  }
  return found
}

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
  // **適用した後も「代用した区間だ」と読めるようにする。** 提案の瞬間だけ出して
  // 消すと、人が確定ボタンを押す時点では推定だと分からない (Refs #926)。
  proposeAppliedCarried.value = candidate.carried ?? null
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
  // 一番星の検索キーが無い運行 (raw_data に `車輌CD` が入っていない等)。**黙って
  // return すると、押しても表示が一切変わらず「ボタンが壊れている」としか読めない**
  // (Refs #822 ①)。`proposeStatus` を立てる前に return していたのが原因なので、
  // 立ててから理由まで出す。押し直しても変わらないことが伝わるよう `'error'` には
  // 相乗りさせない。
  if (!vehicleCode || !opDate) {
    const missing = [!vehicleCode ? '車輌CD' : null, !opDate ? '運行日' : null].filter(Boolean).join('と')
    proposeUnavailableReason.value = `この運行は${missing}が無いため提案できません`
    proposeStatus.value = 'unavailable'
    return
  }
  proposeStatus.value = 'loading'
  proposeCandidates.value = []
  proposeCarry.value = null
  proposeAppliedCarried.value = null
  try {
    await loadCsv('events')
    const csv = csvData.value.events
    if (!csv || csv.rows.length === 0) {
      // **伝票を見てすらいないのに「伝票が見つかりません」と言っていた** (Refs #822 ②-1)。
      // ここに来るのは「この運行にイベント行が無い」ときで、探す先は取込元 (デジタコ) —
      // 一番星ではない。ただし**引けなかっただけ**なら押し直す意味があるので、
      // それは `'error'` (赤) に倒す (`csvError` は #873 で「引けなかった」と「無い」を
      // 言い分けるために持っている。琥珀にすると「押しても無駄」と読ませてしまう)。
      proposeStatus.value = csvError.value.events ? 'error' : 'no-events'
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
    // 代用 (Refs #926) は**同じ重複除去済みの組**に当てる — 伝票の生の件数で数えると
    // 「同じ区間を 3 回落とした」を 3 件と数えてしまう。
    const routes: { originCity: string, destCity: string }[] = []
    for (const slip of slips) {
      const originCity = slip.originAreaName || slip.origin
      const destCity = slip.destAreaName || slip.dest
      const routeKey = `${originCity} ${destCity}`
      if (seenRoutes.has(routeKey)) continue
      seenRoutes.add(routeKey)
      routes.push({ originCity, destCity })
      const range = proposeEventRowRange(csv.headers, csv.rows, originCity, destCity)
      if (range) candidates.push({ originCity, destCity, range })
    }
    if (candidates.length === 0) {
      // **原因が 2 つあるのに 1 つの文言に丸めない** (Refs #822 ②-1)。伝票が 1 件も
      // 無いのか、伝票はあるが `proposeEventRowRange` が全件 null (積地に一致する
      // 積みが無い / その積みの後に卸地の降しが無い) なのかで、**押した人が探しに
      // 行く場所が違う** — 前者は一番星、後者はこの運行のイベント表。後者で
      // 「伝票が見つかりません」と出すと、ちゃんとある伝票を探しに行かせてしまう。
      if (slips.length === 0) {
        proposeStatus.value = 'not-found'
        return
      }
      // ★ ここから代用 (Refs #926)。**降しイベントが無い最終便**は、その卸地が
      // **次の運行の先頭**に記録されている (積んだまま帰庫し翌朝降ろす形)。
      // ①`carryOverDest` と同じ現象・同じ条件で当てる。当たらなかったぶんは
      // `proposeCarry` に理由ごとに数えて残し、画面に出す。
      const carriedCandidates = await buildCarriedCandidates(csv, routes, vehicleCode, opDate)
      if (carriedCandidates.length > 0) {
        // ★ **1 件でも自動適用しない** (`'ambiguous'` ではなく `'carried-choice'`)。
        // 代用が外れていたときの害は「人がそのまま確定してしまう」ことなので、
        // **人のクリックを 1 回必ず挟む**。文言も「複数候補」とは別に持つ —
        // 1 件しか無いのに「複数の配送先候補が見つかりました」は嘘になる。
        proposeCandidates.value = carriedCandidates
        proposeStatus.value = 'carried-choice'
        return
      }
      proposeNoMatchSlipCount.value = slips.length
      proposeStatus.value = 'no-event-match'
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

// --- 運行全体の経路地図 (Refs #873) ------------------------------------------
//
// **粗利タブ (`margin.vue`) の運行行「地図」と同じものを、運行詳細からも開けるようにする。**
// これまで運行詳細にあった地図は `EventSpeedMapPanel` (イベントタブで行を選んだときだけ出る
// 速度カラー地図) だけで、**運行全体を便で区切った経路** (色は種別、便は marker の数字) は
// 粗利タブにしかなかった。
//
// **どう出すか = ヘッダの常設ボタン → 既存 `OperationRouteMap.vue` をモーダルで開く。**理由:
//
// 1. `OperationRouteMap.vue` は `fixed inset-0` + 背景クリック + Esc の**モーダル前提の作り**。
//    タブや常設パネルに埋めるにはあのコンポーネントを改造することになり、**粗利タブの地図の
//    見た目まで動く** (触ってはいけない側に波及する)。**改造ゼロで再利用できるのはモーダルだけ**
// 2. 経路地図は「運行全体」の話で、イベントタブの持ち物ではない。タブに紐づけず、どのタブから
//    でも開ける常設ボタンにする
//
// **経路の組み立て・便の切り方・色分けは `operation-route-map.ts` (pure) が正**で、ここでは
// 作り直さない — 画面の「便」とお金の「便」を別の意味にしないため。**追加の fetch も無い**
// (イベントタブが既に読んでいる CSV をそのまま渡す。他タブから開いたときだけ `loadCsv` が 1 回)。
const routeMapOpen = ref(false)
const routeMapLoading = ref(false)

/** 地図のレイヤ (`margin.vue` と同じ localStorage キーを共有 = 片方で切り替えたら両方に効く)。 */
const routeMapLayers = ref<RouteMapLayers>(parseRouteMapLayers(null))

function setRouteMapLayers(layers: RouteMapLayers) {
  routeMapLayers.value = layers
  try {
    localStorage.setItem(ROUTE_MAP_LAYERS_KEY, serializeRouteMapLayers(layers))
  }
  catch {
    // 保存できなくても今の地図は切り替わる (次に開いたとき既定に戻るだけ)。
  }
}

/** イベントCSV から組み立てた運行全体の経路。CSV をまだ読んでいなければ null。 */
const operationRoute = computed<OperationRoute | null>(() => {
  const csv = csvData.value.events
  return csv ? buildOperationRoute(csv.headers, csv.rows) : null
})

/**
 * NET780 の道なり軌跡 (`margin.vue` の `fetchNet780Track` と同じ形)。アーカイブがある
 * (`ready`) ときだけ、有効な GPS を便の時間窓で切って出す。
 */
const routeNet780Track = computed<RouteSegment[]>(() => {
  const route = operationRoute.value
  const result = net780Data.result.value
  if (!route || net780Data.status.value !== 'ready' || result === null) return []
  const points = filterValidGpsPoints(result.gps, result.events).map(p => ({ ts: p.ts, lat: p.lat, lng: p.lon }))
  return splitTrackByWindows(points, route.windows)
})

/** NET780 が無い運行のための、重ね掛け行も混ぜたイベント軌跡 (同じ CSV から作る)。 */
const routeEventTrack = computed<RouteSegment[]>(() => {
  const csv = csvData.value.events
  const route = operationRoute.value
  if (!csv || !route) return []
  return splitTrackByWindows(buildOverlayTrack(csv.headers, csv.rows), route.windows)
})

/**
 * 軌跡の出どころを言う 1 行 (判断は pure 側 `operationTrackNote`)。
 * **NET780 が無い運行で黙って線を消さない** — 消えると「走っていない」に読める。
 */
const routeTrackNote = computed(() => operationTrackNote({
  status: net780Data.status.value,
  net780Segments: routeNet780Track.value.length,
  eventSegments: routeEventTrack.value.length,
}))

/** 地図に渡す経路 (イベント線 + 軌跡)。NET780 が採れた運行はそれを、無ければイベント軌跡を敷く。 */
const routeMapRoute = computed<OperationRoute | null>(() => {
  const route = operationRoute.value
  if (!route) return null
  const track = routeNet780Track.value.length > 0 ? routeNet780Track.value : routeEventTrack.value
  return { ...route, segments: [...route.segments, ...track] }
})

const routeMapTitle = computed(() => operationRouteMapTitle({
  unkoNo,
  readingDate: primary.value?.reading_date,
  legCount: operationRoute.value?.legCount ?? null,
}))

/** イベントCSV が**引けなかった**ときだけ理由を出す (GPS が無いのとは別物)。 */
const routeMapError = computed(() => csvError.value.events ?? null)

async function openRouteMap() {
  routeMapOpen.value = true
  // イベントタブを開いていれば既に読み込み済み (`loadCsv` は冪等なので追加 fetch は無い)。
  routeMapLoading.value = true
  await loadCsv('events')
  routeMapLoading.value = false
  // NET780 は後から重なる (軌跡が来るまではイベント軌跡で描いておく)。
  // dedup は composable 任せ (`ready` / `loading` は再 fetch しない)。
  void net780Data.ensureLoaded()
}

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
            <div class="flex items-center gap-3 mb-4 flex-wrap">
              <h2 class="text-xl font-bold">運行 {{ unkoNo }}</h2>
              <!-- 運行全体の経路地図 (Refs #873)。**どのタブからでも開ける常設ボタン** —
                   経路はイベントタブの持ち物ではなく運行全体の話なので、タブに紐づけない。
                   中身は粗利タブと同じ `OperationRouteMap` (線の分かれ目 = 便 / 色 = 種別 /
                   便の名乗り = 数字、も同じ規則)。
                   **削除ボタンの隣には置かない** — 削除は戻せない操作なので、その隣に
                   押す用のボタンを増やすと誤クリックの的になる。見出しの側に置く。 -->
              <UButton
                label="経路地図"
                icon="i-lucide-map"
                variant="outline"
                size="xs"
                @click="openRouteMap"
              />
            </div>
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
            <!-- 「呼んで駄目だった」(赤/灰) と**色も文も分ける** — 押し直しても変わらない。 -->
            <span v-else-if="proposeStatus === 'unavailable'" class="text-xs text-amber-600 dark:text-amber-400">{{ proposeUnavailableReason }}</span>
            <!-- 伝票は**見てすらいない** — 一番星ではなく取込元 (デジタコ) を見る話。 -->
            <span v-else-if="proposeStatus === 'no-events'" class="text-xs text-amber-600 dark:text-amber-400">この運行にはイベントの記録が無いため提案できません</span>
            <!-- 「伝票が無い」(灰) と**別の文**にする — 伝票はあるので探す先はイベント表。 -->
            <span v-else-if="proposeStatus === 'no-event-match'" class="text-xs text-amber-600 dark:text-amber-400">伝票{{ proposeNoMatchSlipCount }}件に対応する積み降しが無く提案できません</span>
            <span v-else-if="proposeStatus === 'done' && proposedLegCount > 1" class="text-xs text-amber-600 dark:text-amber-400">
              同一区間のレグが{{ proposedLegCount }}件見つかったため全て選択範囲に含めました
            </span>
            <!-- ★ 代用の候補は**自動で反映しない** (Refs #926)。1 件でも押させる。
                 `'ambiguous'` と文言を分ける — 1 件しか無いのに「複数の配送先候補」は嘘。 -->
            <span v-else-if="proposeStatus === 'carried-choice'" class="text-xs text-sky-700 dark:text-sky-300 flex items-center gap-1.5 flex-wrap">
              <span class="px-1 rounded bg-sky-100 dark:bg-sky-900/50">降し無し・代用 (推定)</span>
              <b>自動では反映しません</b>。内容を確かめて押してください:
              <button
                v-for="c in proposeCandidates"
                :key="`carried-${c.originCity}-${c.destCity}`"
                class="px-1.5 py-0.5 rounded border border-sky-400 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-950/40"
                @click="selectProposeCandidate(c)"
              >
                {{ c.originCity }} → {{ c.destCity }}
                <span v-if="c.carried">(代用元 {{ c.carried.carriedFromUnkoNo }}{{ carriedSourceSuffix(c.carried) }})</span>
              </button>
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
                <!-- ★ 代用の候補と実データの候補が**並ぶ**のがいちばん危ない。
                     選ばせる時点で文言で区別する (色だけにしない、Refs #926)。 -->
                <span v-if="c.carried" class="ml-1 px-1 rounded bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">降し無し・代用</span>
              </button>
            </span>
            <!-- ★ 代用 (次の運行の先頭の降し、Refs #926) の**結果**。
                 `proposeCarry` が null = 代用を試していない ので何も出さない。
                 試したなら**代用できた件数も、できなかった件数も、0 件でも出す** —
                 空欄は「該当なし」と「そもそも見ていない」を区別できない。 -->
            <span v-if="proposeCarry" class="text-xs text-sky-700 dark:text-sky-300 flex items-center gap-1.5 flex-wrap">
              <span class="px-1 rounded bg-sky-100 dark:bg-sky-900/50">降し無し・代用 (推定)</span>
              伝票{{ proposeCarry.tried }}件のうち{{ proposeCarry.carried }}件を「次の運行の先頭の降し」で代用しました /
              代用もできなかった便 {{ proposeCarrySkipped }}件
              <span v-for="s in proposeCarry.skips" :key="s.reason" class="text-gray-500 dark:text-gray-400">・{{ s.reason }} {{ s.count }}件</span>
            </span>
            <!-- ★ 適用した後も出し続ける。**人が確定ボタンを押す前に「これは推測だ」と
                 読める**ことが要件 (Refs #926)。色だけでなく文言で言う。 -->
            <span v-if="proposeAppliedCarried" class="text-xs text-sky-700 dark:text-sky-300 flex items-center gap-1.5 flex-wrap">
              <span class="px-1 rounded bg-sky-100 dark:bg-sky-900/50">降し無し・代用 (推定)</span>
              <b>この提案は代用です</b> — この運行に降しイベントが無いため、卸地を次の運行
              <NuxtLink :to="`/operations/${proposeAppliedCarried.carriedFromUnkoNo}`" class="underline">{{ proposeAppliedCarried.carriedFromUnkoNo }}</NuxtLink>
              の先頭の降し ({{ proposeAppliedCarried.carriedDestCity }}) で代用しました。<b>実測ではありません</b>。
              <b v-if="proposeAppliedCarried.carriedFromNextMonth">代用元は<u>翌月</u>の運行です{{ carriedSourceSuffix(proposeAppliedCarried) }}。</b>
              実際の降しは次の運行の中なので、<b>提案した区間の終わりはこの運行の帰庫まで</b>です
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

    <!-- 運行全体の経路地図 (Refs #873)。粗利タブと同じモーダル・同じレイヤ設定を共有する。
         `net780-missing-count` は渡さない — NET780 の一括取得 (relay へ投げる) は粗利タブの
         仕事で、ここでは**読むだけ**。 -->
    <OperationRouteMap
      v-if="routeMapOpen"
      :route="routeMapRoute"
      :title="routeMapTitle"
      :loading="routeMapLoading"
      :error="routeMapError"
      :track-note="routeTrackNote.text"
      :layers="routeMapLayers"
      @close="routeMapOpen = false"
      @update:layers="setRouteMapLayers"
    />

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
