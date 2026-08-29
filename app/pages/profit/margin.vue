<script setup lang="ts">
/**
 * 粗利 (売上 − 手当 − 経費) ページ。
 *
 * 運行手当タブで**売上と手当は揃った** (2026-07 / 帯広5台で手当表PDF 313 便と
 * 突合し、差は PDF 側の誤り 1 件のみ)。**残っていたのは経費**で、
 * rust-ichibanboshi#305 が `経費明細` を読む口を足したので、ここで運行 1 本ごとの
 * 粗利まで持っていく (Refs #760)。
 *
 * **運行手当タブとは独立したタブ**にしてある (オーナー決定)。あちらの中の節にすると、
 * ただでさえ長い画面がさらに縦に伸びて、手当の突合と粗利のどちらを見ているのか
 * 分からなくなる。
 *
 * ## 粗利に入れないもの (オーナー決定)
 *
 * - **`01 燃料ｵｲﾙ代` / `15 アドブルー`** … 一番星から取らず、
 *   **走行距離 ÷ 燃費 × 単価**で出す。給油日と運行日がずれるので、一番星の燃料費を
 *   そのまま運行に乗せると給油した日の運行だけが赤くなる
 * - **`08 給与(人件費)` / `11 賞与・調整金`** … 運行手当と二重になる。
 *   **別枠で「一番星の人件費」と「運行手当」を並べて出し**、どちらが正しいかは人が判断する
 *
 * ## 按分
 *
 * **固定費と、日・車輌が運行に一致しない経費は走行距離の比で按分する** (オーナー決定)。
 * 分母はその月・その車輌の運行の走行距離の合計、分子はその運行の走行距離。
 * **どちらも表に出す** — 按分は人が検算できないと信用されない。
 * **分母が 0 なら按分しない** (0 除算を粗利に混ぜるくらいなら「配れなかった額」と書く)。
 *
 * ## 燃費と単価
 *
 * 既定値は**一番星の燃料実績** (`Σamount ÷ Σquantity` と `ΣtotalKm ÷ Σquantity`)。
 * 単月では給油日と運行日のずれで燃費が振れるので、**確定値は人が入れられる**
 * (localStorage、`allowance-provisional.ts` と同じ方式)。
 * **分母が 0 の車輌は燃料代を出さず、粗利も `-` にする。**
 */
import { getOperations, getOperationCsv, getDrivers, postNet780Archive, currentAccessToken } from '~/utils/api'
import { fetchAllPages } from '~/utils/paged-fetch'
import type { Driver, OperationListItem } from '~/types'
import { extractAllowanceLegs, extractCarryInUnloads, allowanceForLegs } from '~/utils/allowance-trips'
import { extractOperationIdle, type LegKmDetail } from '~/utils/allowance-idle'
import {
  legPointsByLegSeq,
  buildRebuildOperationInputs,
  parseLegPoints,
  serializeLegPoints,
  MARGIN_LEG_POINTS_KEY,
  type LegPoints,
  type LegPointsCache,
} from '~/utils/margin-rebuild-input'
import {
  buildOperationRoute,
  buildOverlayTrack,
  pickLegsFromRoute,
  mergeRoutes,
  splitTrackByWindows,
  parseRouteMapLayers,
  serializeRouteMapLayers,
  ROUTE_MAP_LAYERS_KEY,
  type OperationRoute,
  type LegWindow,
  type RouteSegment,
  type RouteMapLayers,
} from '~/utils/operation-route-map'
import { driverShareBars } from '~/utils/margin-driver-share'
import { routeOperationRows, runDatesByUnkoNo } from '~/utils/margin-route-operations'
import {
  OPERATION_LEG_SALES_KEY,
  buildOperationLegSales,
  serializeOperationLegSales,
  type LegSalesInput,
  type OperationLegSalesByUnko,
} from '~/utils/operation-leg-sales'
import { filterValidGpsPoints } from '~/utils/net780'
import { NET780_ARCHIVE_BATCH_SIZE, chunk, remainingNet780ArchiveTargets, summarizeNet780ArchiveResults, formatNet780ArchiveSummary, type Net780ArchiveResultItem } from '~/utils/net780-archive'
import { parseTargets, serializeTargets, toggleTarget, driverLabel } from '~/utils/allowance-targets'
import {
  applyCarryOver,
  buildMonthlyAllowanceByOperationDate,
  monthReadingRange,
  toReportRows,
  type OperationAllowance,
  type AllowanceReportRow,
  type MonthlyAllowance,
  type CrossMonthLegs,
} from '~/utils/allowance-report'
import {
  FORCE_MATCH_KEY,
  parseForceMatch,
  forceMatchKey,
  resolveForceMatches,
  applyForcedLegs,
  type ForcedLeg,
} from '~/utils/allowance-force-match'
import { fetchVehicleDailySlips, fetchDriverDailySlips, epochToYmd, type VehicleDailySlip } from '~/utils/ichiban'
import { PROVISIONAL_KEY, parseProvisional, provisionalFor, type ProvisionalMap } from '~/utils/allowance-provisional'
import {
  UNCOVERED_BY_DRIVER_KEY,
  buildAllowanceBase,
  parseUncoveredByDriver,
  serializeUncoveredByDriver,
  sumUncoveredByDriver,
  type AllowanceBaseRow,
} from '~/utils/profit-allowance-base'
import {
  MIN_DAILY_WAGE_YEN,
  MIN_HOURLY_WAGE_YEN,
  TRAVEL_RATE_PRESETS,
  WAGE_MIX_METHOD_LABELS,
  computeWageMixRow,
  defaultWageMixSettings,
  minWageWarning,
  summarizeWageMix,
  travelRateLabel,
  type WageMixMethod,
  type WageMixRestraint,
} from '~/utils/profit-wage-mix'
import { wageMixBaseFormula, wageMixOvertimeFormula } from '~/utils/profit-wage-formula'
import { fetchActualWageByDriver } from '~/utils/profit-actual-wage'
import { EXCLUDED_KEY, parseExcluded, isExcluded, type ExcludedMap } from '~/utils/allowance-excluded'
import { LAST_SEARCH_KEY, parseLastSearch, serializeLastSearch } from '~/utils/allowance-last-search'
import { savedAtLabel } from '~/utils/allowance-cache'
import {
  reconcileVehicles,
  tradableSlips,
  slipDateRange,
  vehicleCodeFromUnkoNo,
  legKey,
  POOL_VEHICLE,
  type VehicleReconcileInput,
  type LegReconcile,
} from '~/utils/allowance-ichiban'
import {
  FUEL_RATE_KEY,
  MARGIN_CACHE_KEY,
  monthCostRange,
  fetchVehicleCosts,
  parseFuelRates,
  serializeFuelRates,
  setFuelRate,
  parseMarginCache,
  serializeMarginCache,
  buildOperationMargins,
  summarizeMargins,
  groupMarginsByDriver,
  marginRate,
  salesPerHaulKm,
  marginRateTone,
  kmMismatch,
  noMarginReason,
  summarizeNoMarginReasons,
  buildUncoveredLegs,
  summarizeUncoveredLegs,
  marginCsvLines,
  marginLegCsvLines,
  customersOfSlips,
  summarizeByCustomerRoute,
  customerRouteCsvLines,
  parseRunCostShareMode,
  RUN_COST_SHARE_MODE_LABELS,
  customerShareBars,
  SHARE_SEGMENT_LABELS,
  operationDirectCostTitle,
  driverDirectCostTitle,
  type CostRow,
  type DriverMargin,
  type FuelRateMap,
  type KmBreakdown,
  type MarginCache,
  type MarginOperationInput,
  type MarginLegInput,
  type CustomerSummary,
  type LegCustomerShare,
  type LegRef,
  type OperationMargin,
  type RouteSummary,
  type RunCostShareMode,
  type ShareSegmentKey,
  type UncoveredDriverInput,
  type UncoveredTotals,
} from '~/utils/margin'
import { describeApiError, describeCaughtError } from '~/utils/api-error'

import {
  ALLOWANCE_RATE_ENDPOINT,
  allowanceRateNoticeForMargin,
  allowanceRateReadError,
  allowanceRateRows,
  cachedRateVersionOf,
  marginCacheRateStatus,
  resolveAllowanceRateMaster,
  type AllowanceRateState,
  type CachedRateVersion,
  type MarginCacheRateMatch,
} from '~/utils/allowance-rate-source'
import type { RateRow } from '~/utils/allowance-rate-master'
import {
  buildMarginSummaryInput,
  marginSummarySaveNote,
  type MarginSummarySaveResult,
} from '~/utils/margin-r2'
import {
  marginVersionOmittedNote,
  marginVersionUnreadableNote,
  MARGIN_VERSION_TOTALS_STATE_LABELS,
  MARGIN_VERSION_TOTALS_STATE_TITLES,
  type MarginVersionItem,
  type MarginVersionListResult,
} from '~/utils/margin-versions'
import {
  buildMarginDiff,
  marginDiffLegCountNote,
  marginDiffNeedsMoreVersionsNote,
  MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE,
  type MarginDiff,
  type MarginDiffRow,
  type MarginDiffSnapshot,
} from '~/utils/margin-diff'
import { buildKushiroBranchView, readViewerCompId } from '~/utils/kushiro-branch-view'
import { b64urlUtf8 } from '~/composables/useTheearthSession'
import type { MinWageMaster } from '~/utils/restraint-wage-view'

/**
 * **この画面の「やり直し方」** (Refs #1008)。`describeCaughtError` の `retry` は
 * **その画面に実在するボタンの表記そのまま**を渡す規約
 * (`tests/components/next-step-retry-labels.test.ts` が template と突き合わせる)。
 *
 * 集計の素材 (手当マスタ / 売上 / 経費 / 最低賃金マスタ / R2 の版) はすべて
 * `run()` が読み直すので、やり直し方は「集計」1 つに畳める。
 */
const RETRY_AGGREGATE = '「集計」を押してください'

/**
 * 賃金構成タブの素材 (拘束時間・実支給) だけは**専用の取り直しボタン**を持つ
 * (`reloadWageMixSources`)。「集計」では取り直らないので分けている (Refs #1008)。
 */
const RETRY_RELOAD_WAGE_MIX = '「拘束時間・実支給を再読込」を押してください'

/** イベントCSV を同時に引く本数。alc を叩きすぎないための上限 (運行手当タブと同じ)。 */
const CSV_CONCURRENCY = 4
/** 対象乗務員 (乗務員CD)。**運行手当タブと同じキーを読む** — 対象は同じ人たちなので、
 * 2 つの画面で別々に選び直させる意味が無い。 */
const TARGETS_KEY = 'dtako:allowance:driver-cds'
/** 運行経費の配分の比 (走行km比 / 便数比 / 拘束時間比)。**この画面だけの設定**。 */
const RUN_COST_SHARE_MODE_KEY = 'dtako:margin:runCostShareMode'

function currentYm(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const ym = ref(currentYm())
const vehicle = ref('')
const shownYm = ref('')

type Status = 'idle' | 'loading' | 'ready' | 'error'
const status = ref<Status>('idle')

// --- 運行手当マスタの出どころ (R2 → 無ければ同梱の初期値。Refs #805 PR-2) -----
// **粗利の「手当」はこのマスタから出ている** (`allowanceForLegs` / `buildUncoveredLegs`)
// ので、運行手当タブと**同じ判定を、この画面にも出す**。バッジを片方にだけ置くと、
// 粗利タブが初期値の金額を注記なしで出し続ける (memory `shared-notice-lies-on-second-screen`)。
// 判定そのものは `allowance-rate-source.ts` (pure) が持ち、ここは通信とゲートだけ。

/** まだ 1 度も読んでいなければ `null`。読んだ後は 3 状態のどれか。 */
const rateState = ref<AllowanceRateState | null>(null)

/**
 * 引き当てに渡す配列。**`undefined` は「まだ決まっていない / 読めなかった」間だけ**で、
 * そのとき集計もキャッシュ復元も止めてある (`run` / `onMounted` の頭)。
 * **ここを「読めなかったときの逃げ道」に使わないこと** — 渡さないと下層の既定
 * (`RATE_MASTER` = 同梱の初期値) で黙って計算される。
 */
const rateRows = computed<RateRow[] | undefined>(() =>
  (rateState.value === null ? null : allowanceRateRows(rateState.value)) ?? undefined)

/**
 * **キャッシュを作ったときの手当マスタの版** (`MarginCache.rateVersion` / `rateUpdatedAt`、
 * Refs #1017 ③)。復元していない回は空 (突き合わせる相手が無い)。
 * **「刻まれていない」を「いまの版」で埋めないこと** — 埋めると全部「一致」になる。
 */
const restoredRate = ref<CachedRateVersion>({})

/**
 * 刻んだ版といまの版の突き合わせ。**復元していない回は `null`。**
 * 文 (`rateNotice`) と色 (`rateVersionUnsure`) の**両方がこれを見る** — 判定を 2 つ持つと
 * 片方だけ直したときに黙ってずれる。
 */
const cacheRateMatch = computed<MarginCacheRateMatch | null>(() => (
  rateState.value === null || !restoredFromCache.value
    ? null
    : marginCacheRateStatus(rateState.value, restoredRate.value)))

/**
 * **言い切れない回** (`mismatch` / `unknown`)。注記の色を上げるためだけで、金額には効かない。
 * 「一致」を出すようになると、**印の無い画面が「壊れている」と読まれる**逆方向の誤読が
 * 起きるので、**色でも 3 状態を分ける** (一致 = 既定色 / 言い切れない = amber)。
 */
const rateVersionUnsure = computed(() => cacheRateMatch.value !== null && cacheRateMatch.value !== 'match')

/** 画面に出す 1 文。**キャッシュから出している回は、刻んだ版といまの版の突き合わせを足す。** */
const rateNotice = computed(() => (rateState.value === null
  ? ''
  : allowanceRateNoticeForMargin(rateState.value, restoredFromCache.value, restoredRate.value)))

/**
 * 運行手当マスタを R2 から読む (`GET /restraint-api/allowance-rate`、PR-1 の口)。
 * 会社ID と JWT の借り方は下の `loadKushiroMinWageMaster` と同じ。
 * **借りられなければ初期値へ倒さず理由を出す。**
 */
async function loadRateMaster(): Promise<AllowanceRateState> {
  const compId = readViewerCompId(localStorage)
  const token = currentAccessToken()
  if (!compId || !token) {
    return allowanceRateReadError('会社IDまたはログイン情報が分かりません。拘束時間・賃金タブを一度開いてください')
  }
  try {
    const res = await $fetch<unknown>(ALLOWANCE_RATE_ENDPOINT, {
      headers: {
        'X-Theearth-Comp-Id': compId,
        'X-Theearth-User-B64': b64urlUtf8('viewer'),
        'Authorization': `Bearer ${token}`,
      },
    })
    return resolveAllowanceRateMaster(res)
  }
  catch (e) {
    // `/restraint-api/**` は Nitro ではなく relay worker へ転送される (Refs #890)。
    // **「次に何をすればいいか」まで出す** (Refs #1008)。マスタは `ensureRateMaster`
    // が集計のたびに読み直すので、やり直し方は「集計」を押すこと。
    return allowanceRateReadError(describeCaughtError(e, RETRY_AGGREGATE))
  }
}

/**
 * マスタが決まるまで待つ。**決まらなければ `false`** で、呼び出し側は集計しない。
 * `error` の回は次に呼ばれたらもう一度試す (mount 時に JWT が揃っていないことがある)。
 */
async function ensureRateMaster(): Promise<boolean> {
  if (rateState.value === null || rateState.value.status === 'error') {
    rateState.value = await loadRateMaster()
  }
  return rateState.value.status !== 'error'
}
const errorMessage = ref<string | null>(null)
const salesError = ref<string | null>(null)
const costError = ref<string | null>(null)
const cacheNote = ref<string | null>(null)
const progress = ref('')
/** 前回の集計をキャッシュから出しているだけ (= 通信していない) か。画面に出す。 */
const restoredFromCache = ref(false)
const savedAt = ref('')
/**
 * R2 に版として残した結果 (Refs #826)。**どちらが正かを画面に出す**ために持つ —
 * localStorage は端末ローカルの写しで、「いつ変わったか」を辿れるのは R2 の版の方。
 * 集計する前は空文字 (何も出さない)。
 */
const marginR2Note = ref('')
/** 上の注記が「残せなかった」側か。色を分けるためだけ (数字には効かない)。 */
const marginR2Failed = ref(false)
/**
 * **R2 に残っている版の一覧** (Refs #833)。「いつ変わったのか追えるようにしたい」の
 * 読む側。**この一覧は粗利の数字に 1 円も効かない** — 既に残っている版を並べるだけで、
 * 突合も集計もやり直さない。
 */
const marginVersions = ref<MarginVersionItem[]>([])
/** 上限 (`MARGIN_VERSION_BODY_LIMIT`) に当たって金額を省いた旨。省いていなければ空文字。 */
const marginVersionsNote = ref('')
/**
 * **本文を読めなかった版がある旨** (Refs #833)。上の「省いた」注記と**分けて持つ** —
 * 省いたのは正常 (次に読めば出る)、読めなかったのは異常。混ぜると異常が流れる。
 */
const marginVersionsUnreadableNote = ref('')
/** 一覧を読めなかった理由。**黙らない** — 空の一覧を「版が無い」と誤読させないため。 */
const marginVersionsError = ref('')
/** 一覧を読んでいる最中か (0 本と「まだ読んでいない」を画面で分けるため)。 */
const marginVersionsLoading = ref(false)
/**
 * **選んだ 2 版の差分** (Refs #834)。「いつ変わったのか追えるようにしたい」の後半。
 * **この差分も粗利の数字に 1 円も効かない** — 保存済みの版どうしを引き算するだけで、
 * 突合も集計もやり直さない (`buildOperationMargins` は呼ばない)。
 */
const marginDiffBeforeLabel = ref('')
const marginDiffAfterLabel = ref('')
const marginDiff = ref<MarginDiff | null>(null)
const marginDiffLoading = ref(false)
/** 差分を出せなかった理由。**黙らない** — 空の差分を「変わっていない」と誤読させないため。 */
const marginDiffError = ref('')
/**
 * 差分の運行行の開閉 (**開いたときだけ便を展開する**、Refs #834)。
 * **取引先行の `openCustomers` / 経路行の `openRoutes` と同じ流儀** (既定は畳んだ状態)。
 */
const openDiffOps = reactive<Record<string, boolean>>({})
/**
 * **版が 2 本に足りないときに何が足りないかを言う** (本番 2026-07 は版が 1 本しかない)。
 * 選択肢が 1 つしか無い画面を**黙って空にしない**。
 */
const marginDiffNeedsMore = computed(() => marginDiffNeedsMoreVersionsNote(marginVersions.value.length))
/**
 * **この bundle を作ったコードの版** (`nuxt.config.ts` のビルド時定数、Refs #826)。
 * タグリリース以外のビルドでは空で、保存側が `unknown` に倒す。
 *
 * **setup のうちに読んでおく** — `useRuntimeConfig()` は nuxt instance を要るので、
 * 集計 (何度も await した後) の中から呼ぶのは筋が悪い。
 */
const codeVersion = useRuntimeConfig().public.codeVersion

/** 粗利の入力 (運行 1 本 = 1 行) と、対象月・対象車輌の経費明細。 */
const inputs = ref<MarginOperationInput[]>([])
const costs = ref<CostRow[]>([])
/**
 * 運行NO → 便 (`seq`) → 積地・卸地の実測 GPS (Refs #760 の 35)。**粗利の数字には
 * 1 円も効かない** — 釧路営業所の組み直し試算 (`rebuildInputs`) の材料にするだけ。
 * `MARGIN_CACHE_KEY` とは**別のキー**に保存する (粗利の集計は GPS を 1 つも見ない
 * ので、片方が壊れてももう片方は動く)。
 */
const legPointsByUnko = ref<Map<string, Map<number, LegPoints>>>(new Map())
/** 車輌C → 人が入れた燃費・単価 (localStorage)。既定値は実績。 */
const fuelRates = ref<FuelRateMap>({})
/**
 * 運行経費 (直課 + 固定費按分) を便に配る比 (Refs #760 の 22)。**既定は今までどおり
 * 走行km比** — 切り替えても運行の段・乗務員の段の数字は 1 円も動かない。
 */
const runCostShareMode = ref<RunCostShareMode>(parseRunCostShareMode(null))
/**
 * **粗利の対象外になっている便**の合計 (`buildUncoveredLegs`)。1 便も無ければ null。
 *
 * 粗利には入れない — **数えて画面に出すためだけ**に持つ。
 */
const uncovered = ref<UncoveredTotals | null>(null)
/**
 * **乗務員CD → 粗利の対象外になっている便の手当** (Refs #760 の 40)。旅費の母数に要る。
 *
 * `uncovered` (合計) と同じ材料 (`buildUncoveredLegs` の返り値) から畳むが、**器を
 * 分ける** — 合計の形は `MarginCache` (`margin.ts`) にあり、あちらは粗利の不変条件が
 * 乗る中核なので触らない。保存先も `MARGIN_CACHE_KEY` とは**別のキー**にして、
 * 片方が壊れてももう片方は動くようにする (`MARGIN_LEG_POINTS_KEY` と同じ作法)。
 *
 * **集計前 / 古いキャッシュ / 月違いは `null`。0 に倒さない** — 0 として足すと、
 * 対象外便の多い乗務員 (2026-07 の西島は手当の 4 割) の旅費が黙って低く出る。
 */
const uncoveredByDriver = ref<Record<string, number> | null>(null)
/**
 * **運行NO → 便ごとに当たった一番星の売上の要約** (Refs #820)。運行詳細
 * (`/operations/{運行NO}`) が読む — この画面には 1 文字も出ない。
 *
 * 粗利の数字には **1 円も効かない**。`MARGIN_CACHE_KEY` とは**別のキー**
 * (`OPERATION_LEG_SALES_KEY`) に書く — `MarginCache` は明細を持たない (量が桁違い)
 * 形のまま変えず、片方が壊れてももう片方は動くようにする
 * (`MARGIN_LEG_POINTS_KEY` / `UNCOVERED_BY_DRIVER_KEY` と同じ作法)。
 *
 * **一番星が落ちて突合できなかったときは `null`** = 書かない。空を書くと、運行詳細が
 * 「突合済みで 1 便も当たらなかった」と読んでしまう。
 */
const legSalesByUnko = ref<OperationLegSalesByUnko | null>(null)
/**
 * **運行が月を跨いだぶん** (Refs #760 の 16)。集計前 / 古いキャッシュからは null。
 *
 * 粗利には効かない — 「この月に何が入って何が入っていないか」を書くためだけ。
 */
const crossMonth = ref<CrossMonthLegs | null>(null)

const targets = ref<string[]>([])
const drivers = ref<Driver[]>([])
const pendingDriver = ref('')

/** 粗利を出せない運行だけに絞る (燃費が出せない / 経費が配れない)。 */
const onlyIssues = ref(false)

/**
 * ★ **`+ 0` は `-0` を `+0` に寄せるためのもの (Refs #840)。消さないこと。**
 *
 * `Math.round` は `-0.5 < v ≤ 0` で **`-0`** を返し、**`(-0).toLocaleString()` は `"-0"`**
 * (`(0).toLocaleString()` は `"0"`。テンプレートリテラルの `${-0}` は `"0"` なので、この癖は
 * `toLocaleString` にしか無い — 隣の `km()` / `pct()` / `pct1()` は影響を受けない)。
 * 粗利がちょうど 0 の行の `marginYen` は按分の足し順のぶん `-4.66e-10` のような
 * **尾つきの負**になる (それ自体は正常) ので、そのまま出すと積み上げ棒の title や
 * 表の粗利に **`¥-0`** と出ていた。`-0 + 0` は IEEE 754 で `+0`。
 * **変わるのは `-0.5 < v ≤ 0` の回だけ** (`¥-0` → `¥0`)。`-0.6` は `Math.round` が `-1` を
 * 返すので **`¥-1` のまま**で、本当に −1 円の行は消えない。
 */
const yen = (v: number | null) => (v === null ? '-' : `¥${(Math.round(v) + 0).toLocaleString()}`)
const km = (v: number) => `${Math.round(v * 10) / 10}km`
const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 1000) / 10}%`)
const num = (v: number | null, digits = 1) => (v === null ? '-' : String(Math.round(v * 10 ** digits) / 10 ** digits))
/** 走行km の内訳は 1 桁でも読み切れないので整数で出す (列を増やさず 2 行目に畳むため)。 */
const kmInt = (v: number) => String(Math.round(v))
/**
 * 内訳の各項が走行km 全体に占める割合 (整数 %)。
 * **分母が 0 の運行では呼ばない** (`NaN%` を見せないため、テンプレート側で `v-if` を掛ける)。
 */
const kmPct = (part: number, totalKm: number) => `${Math.round((part / totalKm) * 100)}%`
/**
 * 金額の列 (手当 / 燃料代 / 回送燃料 / 直課経費 / 固定費按分) がその行の売上に占める割合 (整数 %)。
 * `kmPct` と同じ流儀で、**売上が 0 以下の行・金額が null の列では呼ばない**
 * (`NaN%` / `Infinity%` を見せないため、テンプレート側で `v-if` を掛ける)。
 */
const yenPct = (part: number, salesYen: number) => `${Math.round((part / salesYen) * 100)}%`
/**
 * 粗利率のセルの色 (Refs #760 の 20)。**取引先の行と経路の行で同じ式**なので関数に出す
 * (テンプレートで `marginRate` を 2 度呼ばないため)。`marginRateTone` は % で受けるので 100 倍する。
 */
const MARGIN_TONE_CLASS: Record<'high' | 'low', string> = {
  high: 'text-emerald-600 dark:text-emerald-400 font-medium',
  low: 'text-red-600 dark:text-red-400 font-medium',
}
const marginRateClass = (salesYen: number, marginYen: number | null): string => {
  const rate = marginRate({ salesYen, marginYen })
  const tone = marginRateTone(rate === null ? null : rate * 100)
  return tone === null ? '' : MARGIN_TONE_CLASS[tone]
}
/** 内訳の見出しの意味。**列を増やさない**代わりに、数字の意味をここで説明する。 */
const KM_BREAKDOWN_TITLE = '積前=始業→最初の積み / 売上=積み→降し / 便間=降し→次の積み / 降後=最後の降し→終業'
const OTHER_KM_TITLE = '降しが記録されていない便の走行 (分類不能)'
/** 月の切り方の注記の title (Refs #760 の 16)。 */
const MONTH_CUT_TITLE
  = '粗利タブは運行の開始日 (イベントCSV の 運行開始) でその運行をどの月に数えるかを決め、'
    + '選んだ運行の便は日付で切らずに全部この月に入れます。'
    + '燃料代が運行まるごとの走行km から出るので、便だけを月で切ると月跨ぎの運行で必ず検算が合わないためです'

const FUEL_HAUL_TITLE = '売上走行 (積み→降し) の走行ぶんの燃料代 = 燃料代 × 売上走行km ÷ 走行km'
const FUEL_DEADHEAD_TITLE
  = '回送 (始業→積み・便間・降し→終業・分類不能) の走行ぶんの燃料代。'
    + '売上が立たない移動の経費なので、これを按分として見せています (燃料代 − 売上走行ぶん)'
const FUEL_UNSPLIT_TITLE
  = '区間距離が無い運行 (運行一覧の総走行距離で代用したもの) の燃料代。'
    + '売上走行と回送に分けられないので、0 に倒さず別に出しています'
const FUEL_UNSPLIT_CELL_TITLE = '区間距離が無い運行なので売上走行と回送に分けられません'
const FIXED_POOL_TITLE
  = 'リース・保険・通信などの固定費と、運行の無い日の修繕など直課できない経費を、'
    + '月・その車輌の総走行距離で割ったもの'

/** 燃料代の 2 列の title。**分けられない運行だけ理由を出す。** */
function fuelCellTitle(m: OperationMargin): string {
  if (m.fuelYen === null) return 'この車輌の燃費が出せないので燃料代を出していません'
  if (m.fuelHaulYen === null) return FUEL_UNSPLIT_CELL_TITLE
  return `燃料代 ${yen(m.fuelYen)} を 売上走行km ${kmInt(m.kmBreakdown.haulKm)} / 走行km ${kmInt(m.totalKm)} で割ったもの`
}

/**
 * **固定費按分の中身**を title に列挙する。
 *
 * 額は乗務員 (運行) に配ったぶんだが、ここに出すのは**車輌の月ぶんの一覧**
 * (何を按分しているのかが分からないと、人は数字を信用できない)。走行距離の比で
 * 配っていることを頭に書いて、取り違えないようにする。
 */
function fixedPoolTitle(operations: OperationMargin[]): string {
  const vehicles = [...new Set(operations.map(m => m.vehicleCode))].sort()
  const rows = vehicles.flatMap(code => result.value.fixedPoolByVehicle.get(code) ?? [])
  if (rows.length === 0) return '按分に回った経費はありません'
  const body = rows.map(r => (r.isFixed
    ? `${r.costKindName} ${yen(r.yen)}`
    : `${r.date.slice(5)} ${r.costName}(変動) ${yen(r.yen)} (運行の無い日)`)).join(' / ')
  return `固定費按分の中身 — 車輌${vehicles.join('･')} の月ぶん (走行距離の比で配っています)\n${body}`
}

/**
 * **直課経費の中身**を title に列挙する (Refs #760 の 14)。本体は pure に `margin.ts` へ
 * 置いてテストしている — ここは `result` の Map を渡すだけ (`fixedPoolTitle` と同じ流儀)。
 */
function directCostTitle(m: OperationMargin): string {
  return operationDirectCostTitle(m, result.value.directRowsByUnko)
}

/** 乗務員行の直課経費セルの title。種別ごとの合計と、金額の大きい順の上位 10 行。 */
function driverDirectTitle(d: DriverMargin): string {
  return driverDirectCostTitle(d, result.value.directRowsByUnko)
}

/**
 * 走行km が運行一覧の 総走行距離 とずれた運行に出す注意 (`kmMismatch` が true の行)。
 *
 * 2 つは一致するはずの値 (`DISTANCE_EVENT_NAMES` の和 = KUDGURI の 総走行距離)。
 * ずれるのは**イベント名の仕分けが実データに追いついていない**とき。
 */
function kmMismatchTitle(m: OperationMargin): string {
  return `CSV の走行km ${num(m.totalKm)} / 運行一覧の総走行距離 ${num(m.listedTotalKm)}`
    + ' — 区間距離の数え方が合っていない (未知のイベント名の疑い)'
}

onMounted(async () => {
  targets.value = parseTargets(localStorage.getItem(TARGETS_KEY))
  const last = parseLastSearch(localStorage.getItem(LAST_SEARCH_KEY))
  if (last) {
    ym.value = last.ym
    vehicle.value = last.vehicle
  }
  fuelRates.value = parseFuelRates(localStorage.getItem(FUEL_RATE_KEY))
  runCostShareMode.value = parseRunCostShareMode(localStorage.getItem(RUN_COST_SHARE_MODE_KEY))
  routeMapLayers.value = parseRouteMapLayers(localStorage.getItem(ROUTE_MAP_LAYERS_KEY))
  // **手当マスタは乗務員マスタより先に読む。** どの版で計算しているかの注記は alc の
  // 応答に依存しないので、`getDrivers()` の後ろに置くと乗務員マスタが遅い間ずっと
  // 注記が出ない (運行手当タブで実際にそうなった)。
  const masterOk = await ensureRateMaster()
  try {
    drivers.value = await getDrivers()
  }
  catch {
    // 乗務員マスタが引けなくても CD だけで動く (表示が CD のままになるだけ)
  }
  // **キャッシュを読むことと、キャッシュの金額を出すことは別** (Refs #1017)。
  // 金額はマスタが決まるまで出さない (下) が、**R2 の版の一覧は手当マスタと
  // 無関係で金額も持たない** — マスタが読めないことを理由に一緒に伏せると、
  // 「いつ変わったかを追える記録」まで画面から消える。
  const cache = readMarginCache()
  if (cache && cache.ym === ym.value) {
    // **マスタが決まらないうちはキャッシュの金額を戻さない。** 粗利のキャッシュは
    // **計算済みの金額**を持っているので、出どころを言えないまま出すと
    // 「初期値に倒した」のと同じことになる。
    if (masterOk) restoreFromCache(cache)
    // **キャッシュから出しただけの回にも版の一覧は読む** (Refs #833)。端末のキャッシュは
    // 写しで、いつ変わったかを追える記録は R2 の版の方 — ここで読まないと、
    // 集計し直すまで**追える記録が画面に出ない**。
    // **マスタが `error` の回もここは読む** (Refs #1017) — 金額を伏せている回こそ、
    // R2 に何が残っているかは見えていてよい (一覧に金額の判断は 1 つも要らない)。
    void loadMarginVersions(cache.ym)
  }
  // 釧路区画の最低賃金。**粗利の集計とは独立**なので await しない (失敗しても粗利は出る)。
  loadKushiroMinWageMaster()
})

/**
 * **前回の集計を読むだけ** (画面には何も出さない)。壊れていれば理由を注記に出して `null`。
 *
 * **金額を出す判断からは切り離してある** (Refs #1017) — マスタが `error` の回でも
 * 「どの月のキャッシュがあるか」は知る必要があり、そこから R2 の版の一覧を読む。
 * 月が使えるかの判定 (`cache.ym === ym.value`) は呼び出し側。
 */
function readMarginCache(): MarginCache | null {
  try {
    return parseMarginCache(localStorage.getItem(MARGIN_CACHE_KEY))
  }
  catch (e) {
    cacheNote.value = `キャッシュを読めませんでした — ${e instanceof Error ? e.message : String(e)}`
    return null
  }
}

/**
 * **前回の集計をそのまま出す (通信しない)。** 読むのは `readMarginCache()` で、
 * ここは**金額を画面に出す側**だけ — 呼ぶ前にマスタが決まっていること。
 */
function restoreFromCache(cache: MarginCache) {
  inputs.value = cache.operations
  costs.value = cache.costs
  legPointsByUnko.value = restoredLegPoints(cache.ym)
  uncoveredByDriver.value = restoredUncoveredByDriver(cache.ym)
  uncovered.value = cache.uncovered
  crossMonth.value = cache.crossMonth
  // **刻んであるものをそのまま持つ** (Refs #1017 ③)。欄が無ければ `parseMarginCache` が
  // null にしてあるので、ここで「いまの版」に埋め直さない。
  restoredRate.value = { source: cache.rateSource, version: cache.rateVersion, updatedAt: cache.rateUpdatedAt }
  shownYm.value = cache.ym
  savedAt.value = cache.savedAt
  restoredFromCache.value = true
  status.value = 'ready'
}

/**
 * 保存済みの便ごとの GPS。**読めなくても粗利の画面は 1 円も変わらない**ので、
 * 注記も出さずに空で返す (組み直し試算が「座標の欠測」として数える)。
 */
function restoredLegPoints(ym: string): Map<string, Map<number, LegPoints>> {
  let stored: LegPointsCache | null = null
  try {
    stored = parseLegPoints(localStorage.getItem(MARGIN_LEG_POINTS_KEY))
  }
  catch {
    return new Map()
  }
  // **月が違うキャッシュは使わない** (`MarginCache` と同じ判断)。
  if (!stored || stored.ym !== ym) return new Map()
  return stored.points
}

/**
 * 保存済みの乗務員別の対象外便 (Refs #760 の 40)。**読めなければ `null`** —
 * 旅費の母数が「当月運行の便のみ」に倒れ、画面がそう断る。0 には倒さない。
 */
function restoredUncoveredByDriver(ym: string): Record<string, number> | null {
  let stored: ReturnType<typeof parseUncoveredByDriver> = null
  try {
    stored = parseUncoveredByDriver(localStorage.getItem(UNCOVERED_BY_DRIVER_KEY))
  }
  catch {
    return null
  }
  // **月が違うキャッシュは使わない** (`MarginCache` / `LegPointsCache` と同じ判断)。
  if (!stored || stored.ym !== ym) return null
  return stored.byDriver
}

/**
 * いま画面に出ている集計を `MarginCache` の形にする。**localStorage の写しと R2 の版で
 * 同じ中身を使う**ための 1 か所 (Refs #826) — 2 か所で組むと、片方だけ項目を足したときに
 * 黙って中身の違う 2 つが残る。**この関数が `MarginCache` を組む唯一の場所**なので、
 * 欄を足すときもここだけを直す (Refs #1017 ③ で `rateVersion` / `rateUpdatedAt` を足した)。
 */
function currentMarginCache(savedAtIso: string): MarginCache {
  const rate = cachedRateVersionOf(rateState.value)
  return {
    ym: shownYm.value,
    savedAt: savedAtIso,
    operations: inputs.value,
    costs: costs.value,
    uncovered: uncovered.value,
    crossMonth: crossMonth.value,
    // **どの手当マスタの版で計算したか** (Refs #1017 ③)。`r2` 以外は版が無いので null。
    // R2 の版 (`buildMarginSummaryInput`) にも同じ中身が入る — 保存の口は 1 か所。
    rateSource: rate.source,
    rateVersion: rate.version,
    rateUpdatedAt: rate.updatedAt,
  }
}

function writeCache() {
  const now = new Date().toISOString()
  try {
    localStorage.setItem(MARGIN_CACHE_KEY, serializeMarginCache(currentMarginCache(now)))
    savedAt.value = now
  }
  catch (e) {
    // 容量超過が現実的な失敗。次回また全部引くだけで、画面の数字は正しい。
    cacheNote.value = `キャッシュを保存できませんでした (次回も取り直します) — ${e instanceof Error ? e.message : String(e)}`
  }
  // **GPS は別のキー・別の try** (Refs #760 の 35)。ここが溢れても粗利の
  // キャッシュは残す — 粗利の集計は GPS を 1 つも見ないため。
  try {
    localStorage.setItem(MARGIN_LEG_POINTS_KEY, serializeLegPoints({ ym: shownYm.value, points: legPointsByUnko.value }))
  }
  catch {
    // 保存できなくても画面の数字は正しい (組み直し試算だけが取り直しになる)。
  }
  // **乗務員別の対象外便も別のキー・別の try** (Refs #760 の 40)。ここが溢れても
  // 粗利のキャッシュは残す — 粗利の集計はこの値を 1 円も見ない。
  // **取れていない (null) ときは書かない** — 空を書くと「対象外 0 円」として
  // 読み戻され、旅費の母数が黙って低くなる。
  if (uncoveredByDriver.value !== null) {
    try {
      localStorage.setItem(UNCOVERED_BY_DRIVER_KEY, serializeUncoveredByDriver({ ym: shownYm.value, byDriver: uncoveredByDriver.value }))
    }
    catch {
      // 保存できなくても画面の数字は正しい (次に集計すればまた埋まる)。
    }
  }
  // **便ごとの売上要約も別のキー・別の try** (Refs #820)。運行詳細だけが読むので、
  // ここが溢れても粗利のキャッシュは残す。**突合できていない (null) ときは書かない** —
  // 空を書くと運行詳細が「突合済みで 1 便も当たらなかった」と読む。
  if (legSalesByUnko.value !== null) {
    try {
      localStorage.setItem(
        OPERATION_LEG_SALES_KEY,
        serializeOperationLegSales({ ym: shownYm.value, byUnko: legSalesByUnko.value }),
      )
    }
    catch {
      // 保存できなくても粗利タブの数字は正しい (運行詳細が「集計すると出ます」に戻るだけ)。
    }
  }
}

function toggle(cd: string) {
  targets.value = toggleTarget(targets.value, cd)
  localStorage.setItem(TARGETS_KEY, serializeTargets(targets.value))
}

watch(pendingDriver, (cd) => {
  if (!cd) return
  toggle(cd)
  pendingDriver.value = ''
})

function labelOf(cd: string): string {
  return driverLabel(drivers.value, cd)
}

const driverCdByName = computed(() => {
  const map = new Map<string, string>()
  for (const d of drivers.value) map.set(d.driver_name.trim(), d.driver_cd.trim())
  return map
})

/** 燃費・単価の上書きを保存する。保存に失敗しても画面の数字は正しいので握る。 */
function onFuelRateInput(vehicleCode: string, field: 'yenPerLiter' | 'kmPerLiter', raw: string) {
  fuelRates.value = setFuelRate(fuelRates.value, vehicleCode, field, Number(raw) || 0)
  try {
    localStorage.setItem(FUEL_RATE_KEY, serializeFuelRates(fuelRates.value))
  }
  catch (e) {
    cacheNote.value = `燃費・単価の上書きを保存できませんでした — ${e instanceof Error ? e.message : String(e)}`
  }
}

// --- 集計 ---

/** 1 乗務員ぶんの運行をページングで全部取る。 */
function fetchOperationsFor(range: { from: string, to: string }, driverCd?: string) {
  return fetchAllPages<OperationListItem>(async (page) => {
    const res = await getOperations({
      date_from: range.from,
      date_to: range.to,
      driver_cd: driverCd,
      vehicle_cd: vehicle.value.trim() || undefined,
      page,
      per_page: 200,
    })
    return { items: res.operations, total: res.total }
  })
}

/** 1 運行ぶんの解決結果 (便 + 走行距離 + その内訳)。 */
interface ResolvedOperation {
  allowance: OperationAllowance
  /**
   * 運行開始の epoch 秒 (`OperationIdle.startTs`)。**月の切り方の鍵** (Refs #760 の 16) —
   * 粗利タブは運行の開始日で月を切る。CSV が無い / 読めない運行では null で、
   * `operationRunDate` が運行日 → 運行NO に落とす。
   */
  startTs: number | null
  /** 運行終了の epoch 秒。**一番星の明細を引く期間の上端**に使う (翌月へ食い込むため)。 */
  endTs: number | null
  totalKm: number
  /** 運行一覧 (KUDGURI) の `総走行距離`。`totalKm` と突き合わせるためだけに運ぶ。 */
  listedTotalKm: number | null
  kmBreakdown: KmBreakdown
  /**
   * 便ごとの走行距離の内訳 (Refs #760 の 13)。`extractAllowanceLegs` (=
   * `allowance.legs`) と同じ順・同じ本数。**`区間距離` の列が無い CSV / CSV を
   * 読めなかった運行では空配列** (`legKm` と同じ扱い)。
   */
  legKmDetail: LegKmDetail[]
  /**
   * 便ごとの積地・卸地の実測 GPS (Refs #760 の 35)。**同じ CSV から `buildOperationRoute`
   * の marker を畳んだだけ**で、追加の fetch も新しい CSV 解析も無い。粗利の数字には
   * 1 円も効かない — 釧路営業所の組み直し試算 (`kushiro-doto-rebuild.ts`) の入力にする。
   * CSV が無い / 読めなかった運行、GPS 列の無い CSV では空。
   */
  legPoints: Map<number, LegPoints>
}

/** CSV を読めなかった運行の内訳。**距離 0 と同じ扱い** (`totalKm: 0` と揃える)。 */
function emptyKmBreakdown(): KmBreakdown {
  return { preLoadKm: 0, haulKm: 0, betweenKm: 0, postUnloadKm: 0, otherKm: 0 }
}

/**
 * 1 運行ぶんのイベントCSV を引いて、**便 (手当) と走行距離を一度に**取り出す。
 *
 * `extractAllowanceLegs` と `extractOperationIdle` は同じ CSV を読むので、
 * 2 回引かない (運行手当タブの実測で 90 本引くのに数分かかる)。
 */
async function resolveOperation(op: OperationListItem): Promise<ResolvedOperation> {
  // **運行一覧の `総走行距離`。** CSV から数えた `totalKm` と一致するはずの値
  // (`DISTANCE_EVENT_NAMES` の和 = KUDGURI。2026-07 帯広5台 90 運行で全件一致)。
  const listedTotalKm = op.total_distance
  const base: OperationAllowance = {
    unkoNo: op.unko_no,
    readingDate: op.reading_date,
    operationDate: op.operation_date,
    driverName: op.driver_name,
    vehicleName: op.vehicle_name,
    legs: [],
    carryIn: { cities: [], toTs: null },
    error: null,
  }
  if (!op.has_kudgivt) {
    // **CSV が無い運行は突き合わせない** (`listedTotalKm: null`) — 数え方のずれでは
    // なく CSV が来ていないだけなので、注意を出しても直しようが無い。
    return {
      allowance: { ...base, error: 'イベントCSV が未取り込み (has_kudgivt=false)' },
      startTs: null,
      endTs: null,
      totalKm: 0,
      listedTotalKm: null,
      kmBreakdown: emptyKmBreakdown(),
      legKmDetail: [],
      legPoints: new Map(),
    }
  }
  try {
    const csv = await getOperationCsv(op.unko_no, 'events')
    const idle = extractOperationIdle(csv.headers, csv.rows)
    return {
      allowance: {
        ...base,
        legs: allowanceForLegs(extractAllowanceLegs(csv.headers, csv.rows), rateRows.value),
        // **積んだまま帰庫した便の卸地は、次の運行の先頭の降しにある。**
        // ここで CSV から取らないと `applyCarryOver` が空の `carryIn` しか見られず、
        // 引き継ぎが 1 便も当たらない (2026-07 / 帯広5台で 10 運行・手当 ¥89,000・
        // 売上 ¥268,484 が粗利タブだけ落ちていた。運行手当タブ側は L1171 で同じことを
        // している)。
        carryIn: extractCarryInUnloads(csv.headers, csv.rows),
      },
      // 運行開始・運行終了 (月の切り方と、一番星を引く期間に使う。Refs #760 の 16)。
      startTs: idle.startTs,
      endTs: idle.endTs,
      // **`区間距離` の列が無い CSV は運行一覧の `総走行距離` を受け皿にする。**
      // 列が 1 つ無いだけで按分の分子を 0 にすると、その運行だけ経費が付かない
      // (`legKm` が空 かつ `totalKm` が 0 が「列が無い」の印。`kmBreakdown` は
      // 内訳を作れないので 0 のまま — 合計と内訳がずれるが、内訳は按分に効かない)。
      totalKm: idle.legKm.length === 0 && idle.totalKm === 0 ? (listedTotalKm ?? 0) : idle.totalKm,
      listedTotalKm,
      // 按分の分子の中身。**画面に出すだけ**で、按分そのものは `totalKm` のまま。
      kmBreakdown: {
        preLoadKm: idle.preLoadKm,
        haulKm: idle.haulKm,
        betweenKm: idle.betweenKm,
        postUnloadKm: idle.postUnloadKm,
        otherKm: idle.otherKm,
      },
      // 便ごとの回送内訳 (Refs #760 の 13)。`legKm` と同じ順・同じ本数。
      legKmDetail: idle.legKmDetail,
      // 便ごとの積地・卸地 GPS (Refs #760 の 35)。**便の切り方は `extractOperationIdle`
      // と同じ行**なので `legSeq` は `legKmDetail` の index + 1 と一致する。
      // 降しの記録が無い最終便は、`legPointsByLegSeq` が**運行終了の位置を卸地として
      // 代用**する (Refs #760 の 38)。代用したかは `LegPoints.unloadFromOperationEnd`
      // に残る — **km には 1 つも効かない** (座標だけ)。
      legPoints: legPointsByLegSeq(buildOperationRoute(csv.headers, csv.rows)),
    }
  }
  catch (e) {
    // CSV を読めなかった運行も同じ (数え方の問題ではない)。
    return {
      allowance: { ...base, error: e instanceof Error ? e.message : String(e) },
      startTs: null,
      endTs: null,
      totalKm: 0,
      listedTotalKm: null,
      kmBreakdown: emptyKmBreakdown(),
      legKmDetail: [],
      legPoints: new Map(),
    }
  }
}

/**
 * 運行NO → その運行の便。**手当は運行手当タブと同じ基準にする** — 除外した便は落とす。
 * 基準がずれると「手当タブと粗利タブで手当が違う」という直しようのない話になる。
 */
function rowsByUnkoOf(monthly: MonthlyAllowance, excluded: ExcludedMap): Map<string, AllowanceReportRow[]> {
  const map = new Map<string, AllowanceReportRow[]>()
  for (const d of monthly.drivers) {
    for (const op of d.operations) map.set(op.unkoNo, op.rows.filter(r => !isExcluded(r, excluded)))
  }
  return map
}

/** 除外を抜いた便を全部。 */
function rowsOf(monthly: MonthlyAllowance, excluded: ExcludedMap): AllowanceReportRow[] {
  return [...rowsByUnkoOf(monthly, excluded).values()].flat()
}

/** 便 1 本の「払う手当」= マスタで決まった額、無ければ暫定。どちらも無ければ 0。 */
function legPayYen(row: AllowanceReportRow, provisional: ProvisionalMap): number {
  return row.allowanceYen ?? provisionalFor(row, provisional) ?? 0
}

/**
 * 運行 1 本ぶんの便を `MarginLegInput[]` に組み立てる (Refs #760 の 13)。
 *
 * `rows` は運行手当タブと同じ基準で既に除外・対象月外を落としたもの (`rowsByUnko`)。
 * `legKmDetail` が短い/空 (`区間距離` の列が無い CSV・除外で便数がずれた等) なら
 * その便の km は 0 — **黙って全便を落とさない** (手当・売上は出す)。
 */
function buildMarginLegs(
  rows: AllowanceReportRow[],
  legKmDetail: LegKmDetail[],
  salesByLeg: Map<string, number>,
  customersByLeg: Map<string, LegCustomerShare[]>,
  provisional: ProvisionalMap,
): MarginLegInput[] {
  return rows.map((r) => {
    const detail = legKmDetail[r.seq - 1]
    return {
      seq: r.seq,
      date: r.date,
      originCity: r.originCity,
      destCity: r.destCity,
      salesYen: salesByLeg.get(legKey(r)) ?? 0,
      allowanceYen: legPayYen(r, provisional),
      haulKm: detail?.haulKm ?? 0,
      deadheadKm: detail ? detail.approachKm + detail.tailKm + detail.otherKm : 0,
      // 秒は**読めなければ null のまま運ぶ** (0 に倒すと「拘束 0 分の便」に化けて、
      // 拘束時間比がその便に 1 円も配らない画面になる。Refs #760 の 22)。
      haulSec: detail?.haulSec ?? null,
      deadheadSec: detail && detail.approachSec !== null && detail.tailSec !== null
        ? detail.approachSec + detail.tailSec
        : null,
      // 売上に当たった一番星の取引先 (Refs #760 の 15)。当たっていない便は `[]`。
      customers: customersByLeg.get(legKey(r)) ?? [],
    }
  })
}

/** 一番星を乗務員CD で引けるか。**車番で引くと別の車番で走った日の売上が丸ごと落ちる。** */
function canFetchByDriver(names: string[]): boolean {
  return targets.value.length > 0 && names.every(name => driverCdByName.value.has(name))
}

/** 便を乗務員ごとに分けて乗務員CD の昇順に並べる (突合の入力の順を固定する)。 */
function orderedDriverRows(rows: AllowanceReportRow[]): [string, AllowanceReportRow[]][] {
  const groups = new Map<string, AllowanceReportRow[]>()
  for (const row of rows) {
    const cd = driverCdByName.value.get(row.driverName) ?? ''
    const list = groups.get(cd) ?? []
    list.push(row)
    groups.set(cd, list)
  }
  return [...groups].sort((a, b) => (a[0] > b[0] ? 1 : -1))
}

/** 便を車輌C ごとに分けて車輌C の昇順に並べる。 */
function orderedVehicleRows(rows: AllowanceReportRow[]): [string, AllowanceReportRow[]][] {
  const groups = new Map<string, AllowanceReportRow[]>()
  for (const row of rows) {
    const code = vehicleCodeFromUnkoNo(row.unkoNo)
    const list = groups.get(code) ?? []
    list.push(row)
    groups.set(code, list)
  }
  return [...groups].sort((a, b) => (a[0] > b[0] ? 1 : -1))
}

/** 引いた一番星の明細。 */
interface SalesSlips {
  /** 突合の入力の鍵 (乗務員CD か 車輌C) → 明細。 */
  byKey: Record<string, VehicleDailySlip[]>
  /** 受け皿 (`POOL_VEHICLE`) の明細。車番で引いたときだけ入る。 */
  pool: VehicleDailySlip[]
}

/** 1 日 (秒)。半開区間の上端を「終了日の翌日」にするのに使う。 */
const ONE_DAY_SECONDS = 24 * 60 * 60

/**
 * 一番星の明細を引く期間 (`from` 以上 `to` 未満)。**運行の開始日〜終了日を覆う**まで
 * 広げる (Refs #760 の 16)。
 *
 * 月の切り方が**運行の開始日**になったので、対象月の運行は翌月の日付の便を持ちうる。
 * その便の売上が引けないと、便には売上が付かないのに運行の段には燃料が乗る
 * (= 取引先別の検算がまた合わない)。
 *
 * **`slipDateRange(ym)` (月の前後 1 日) より狭くしない。** 対象外の枠
 * (一番星から起こした便) の範囲がここで決まっているので、狭めるとその額が動く。
 * 日数を足し込んで当てるのではなく、**運行終了の実日付**の翌日を上端にする
 * (`to` は「未満」なので、終了日そのものを含めるには翌日が要る)。
 */
function slipRangeForOperations(ym: string, resolved: ResolvedOperation[], picked: Set<string>): { from: string, to: string } {
  const base = slipDateRange(ym)
  let from = base.from
  let to = base.to
  for (const r of resolved) {
    if (!picked.has(r.allowance.unkoNo)) continue
    if (r.startTs !== null && epochToYmd(r.startTs) < from) from = epochToYmd(r.startTs)
    if (r.endTs !== null && epochToYmd(r.endTs + ONE_DAY_SECONDS) > to) to = epochToYmd(r.endTs + ONE_DAY_SECONDS)
  }
  return { from, to }
}

/**
 * 一番星の明細を引く。**取得はここだけ** — 突合 (`reconcileSales`) は引いたものを
 * 使い回して通信しない。
 *
 * **強制突合より先に引く必要がある**。人が便に結んだ相手は明細の `rowId` なので、
 * 明細を持っていないと `resolveForceMatches` が 1 件も解けない。
 */
async function fetchSlips(rows: AllowanceReportRow[], byDriver: boolean, range: { from: string, to: string }): Promise<SalesSlips> {
  const byKey: Record<string, VehicleDailySlip[]> = {}
  if (byDriver) {
    for (const [cd] of orderedDriverRows(rows)) {
      progress.value = `一番星の売上を取得中 ${labelOf(cd)}`
      byKey[cd] = tradableSlips(await fetchDriverDailySlips(cd, range.from, range.to))
    }
    return { byKey, pool: [] }
  }
  for (const [code] of orderedVehicleRows(rows)) {
    progress.value = `一番星の売上を取得中 車輌${code}`
    byKey[code] = tradableSlips(await fetchVehicleDailySlips(code, range.from, range.to))
  }
  progress.value = `一番星の売上を取得中 受け皿(${POOL_VEHICLE})`
  return { byKey, pool: tradableSlips(await fetchVehicleDailySlips(POOL_VEHICLE, range.from, range.to)) }
}

/** 一番星の明細を `rowId` で引く。強制突合が結んだ相手を取り出すのに使う。 */
function slipByRowId(byKey: Record<string, VehicleDailySlip[]>): Map<string, VehicleDailySlip> {
  const map = new Map<string, VehicleDailySlip>()
  for (const list of Object.values(byKey)) {
    for (const slip of list) map.set(slip.rowId, slip)
  }
  return map
}

/**
 * **強制突合で結んだ便の売上を突合結果に上書きする** (運行手当タブの `byLeg` と同じ)。
 *
 * 降しが 1 つも無い便は自動では当たらないので、人が結んだ明細をここで `matched` に
 * して初めて売上が付く。**上書きした結果をそのまま `buildUncoveredLegs` にも渡す** —
 * 結んだ明細を「デジタコ便に当たった」扱いにしないと、同じ売上が粗利と対象外の
 * 両方に出る。
 */
function applyForcedSales(
  rows: AllowanceReportRow[],
  base: Map<string, LegReconcile>,
  forced: Map<string, ForcedLeg>,
): Map<string, LegReconcile> {
  if (forced.size === 0) return base
  const out = new Map(base)
  for (const row of rows) {
    const hit = forced.get(forceMatchKey(row))
    if (hit === undefined) continue
    out.set(legKey(row), {
      key: legKey(row),
      status: 'matched',
      slips: hit.slips,
      quantity: hit.quantity,
      salesYen: hit.salesYen,
      split: false,
      fromPool: false,
    })
  }
  return out
}

/**
 * 便 → 売上。**引いてある明細だけで突合する (通信しない)。**
 *
 * **同じ突合の結果から「粗利の対象外の便」も数える** (`buildUncoveredLegs`)。
 * デジタコに運行が無い日の便は粗利に載せられないが、**落ちていることは言う**。
 * 別々に引き直すと、売上の突合とずれた数字を並べることになる。
 */
function reconcileSales(
  rows: AllowanceReportRow[],
  slips: SalesSlips,
  byDriver: boolean,
  forced: Map<string, ForcedLeg>,
  provisional: ProvisionalMap,
): {
  salesByLeg: Map<string, number>
  /** 便 → 売上に当たった明細の取引先 (Refs #760 の 15)。**`salesByLeg` と同じ突合結果から畳む。** */
  customersByLeg: Map<string, LegCustomerShare[]>
  uncovered: UncoveredTotals | null
  /** 乗務員CD → 対象外便の手当 (Refs #760 の 40)。旅費の母数に使う。 */
  uncoveredByDriver: Record<string, number>
  /**
   * 運行NO → 便ごとの売上要約 (Refs #820)。**運行詳細が別キーから読むためだけ**に
   * 畳む — この画面の数字には 1 円も効かない。
   */
  legSales: OperationLegSalesByUnko
} {
  const ordered = byDriver ? orderedDriverRows(rows) : orderedVehicleRows(rows)
  const inputsForReconcile: VehicleReconcileInput[] = ordered
    .map(([key, groupRows]) => ({ vehicle: key, rows: groupRows, slips: slips.byKey[key] ?? [] }))
  const byLeg = applyForcedSales(rows, reconcileVehicles(inputsForReconcile, slips.pool).byLeg, forced)
  const salesByLeg = new Map<string, number>()
  const customersByLeg = new Map<string, LegCustomerShare[]>()
  // 運行詳細に渡す便ごとの要約 (Refs #820)。**同じ突合結果・同じ `customersOfSlips` から
  // 作る** — 別に畳むと粗利タブと違う金額を出す画面になる。
  const legSalesInputs: LegSalesInput[] = []
  for (const [key, hit] of byLeg) {
    salesByLeg.set(key, hit.salesYen)
    const customers = customersOfSlips(hit.slips)
    customersByLeg.set(key, customers)
    legSalesInputs.push({ key, customers, slipIds: hit.slips.map(s => s.rowId) })
  }
  // **乗務員で引けているときだけ対象外の便を起こす。** 車番引きでは、その乗務員が
  // 別の車番で走った日の明細を持っていないので、起こすべき便が見えない
  // (運行手当タブの `ichibanLegs` と同じ条件)。
  const uncoveredInputs: UncoveredDriverInput[] = byDriver
    ? ordered.map(([key, groupRows]) => ({
        driverName: groupRows[0]!.driverName,
        rows: groupRows,
        slips: slips.byKey[key] ?? [],
      }))
    : []
  const legs = buildUncoveredLegs(
    uncoveredInputs, [...byLeg.values()], shownYm.value, provisional, rateRows.value,
  )
  return {
    salesByLeg,
    customersByLeg,
    uncovered: summarizeUncoveredLegs(legs),
    // **乗務員別も同時に畳む** (Refs #760 の 40)。`UncoveredTotals` は合計しか持たず、
    // その形は `margin.ts` (触らない) にあるので、別の器で持つ。旅費の母数に要る。
    uncoveredByDriver: sumUncoveredByDriver(legs, driverCdByName.value),
    // **運行詳細のための要約** (Refs #820)。突合はここでやり直さない。
    legSales: buildOperationLegSales(legSalesInputs),
  }
}

async function run() {
  status.value = 'loading'
  restoredFromCache.value = false
  // **前回の版の名札を残したまま集計しない。** 集計後は `writeCache()` が刻み直す。
  restoredRate.value = {}
  errorMessage.value = null
  salesError.value = null
  costError.value = null
  cacheNote.value = null
  marginR2Note.value = ''
  marginR2Failed.value = false
  // **前の月の版を残したまま集計しない** (一覧は集計の最後に読み直す)。
  marginVersions.value = []
  marginVersionsNote.value = ''
  marginVersionsUnreadableNote.value = ''
  marginVersionsError.value = ''
  // **前の月の差分も一緒に捨てる** — 別の月の版どうしの差が残ると、月を跨いだ数字に見える。
  resetMarginDiff()
  inputs.value = []
  costs.value = []
  legPointsByUnko.value = new Map()
  uncovered.value = null
  uncoveredByDriver.value = null
  legSalesByUnko.value = null
  crossMonth.value = null
  progress.value = '運行手当マスタを確認中...'
  // **マスタの出どころが決まらないと集計しない。** 手当が決まらなければ粗利
  // (売上 − 手当 − 経費) も決まらないので、同梱の初期値へ黙って倒さず何も出さない。
  // 理由は上の注記に出る。
  if (!await ensureRateMaster()) {
    status.value = 'idle'
    progress.value = ''
    // **既に出ていた版の一覧まで消さない** (Refs #1017)。上で一覧を空にしてから
    // ここへ来るので、読み直さないと `onMounted` で出した版が画面から消え、
    // **ページを開き直すまで戻らない**。金額を伏せている回こそ「いつ変わったかを
    // 追える記録」は要る、という `onMounted` 側と同じ判断。
    //
    // **鍵は `shownYm` ではなく `ym.value`** — 版の一覧は**いま画面で見ている月**に
    // 付く。集計していないので `shownYm` は空 (マスタが error のままのセッション) か
    // 前回集計した月で、利用者が入力欄で選び直した月とは限らない。
    // **上で空にするのは正しいので残す** — 月を変えて押した回に前の月の版が
    // 残っていると、入力欄と一覧が違う月を指す。
    //
    // **月が空 / 形が違う回は呼ばない。** `<input type="month">` は空にできて、
    // 読み口 (`margin-snapshots.get.ts`) は `400 ym (YYYY-MM) が必要です` を返すので、
    // 月を消しただけの回に「一覧を読めませんでした」という別の失敗が画面に出る。
    if (/^\d{4}-\d{2}$/.test(ym.value)) void loadMarginVersions(ym.value)
    return
  }
  progress.value = '運行を検索中...'
  try {
    localStorage.setItem(LAST_SEARCH_KEY, serializeLastSearch({ ym: ym.value, vehicle: vehicle.value }))
    const range = monthReadingRange(ym.value)
    const found: OperationListItem[] = []
    if (targets.value.length === 0) {
      found.push(...await fetchOperationsFor(range))
    }
    else {
      for (const cd of targets.value) {
        progress.value = `運行を検索中 ${labelOf(cd)}`
        found.push(...await fetchOperationsFor(range, cd))
      }
    }

    const resolved: ResolvedOperation[] = []
    for (let i = 0; i < found.length; i += CSV_CONCURRENCY) {
      progress.value = `イベントCSV を取得中 ${resolved.length}/${found.length}`
      resolved.push(...await Promise.all(found.slice(i, i + CSV_CONCURRENCY).map(resolveOperation)))
    }
    const kmByUnko = new Map(resolved.map(r => [r.allowance.unkoNo, r.totalKm]))
    // 運行一覧の 総走行距離 (突き合わせ用)。**引けなかった運行は null で、比べない。**
    const listedKmByUnko = new Map(resolved.map(r => [r.allowance.unkoNo, r.listedTotalKm]))
    const kmBreakdownByUnko = new Map(resolved.map(r => [r.allowance.unkoNo, r.kmBreakdown]))
    // 便ごとの回送内訳 (Refs #760 の 13)。
    const legKmDetailByUnko = new Map(resolved.map(r => [r.allowance.unkoNo, r.legKmDetail]))
    // 便ごとの積地・卸地 GPS (Refs #760 の 35)。**同じ CSV から取っていて追加の fetch は無い。**
    legPointsByUnko.value = new Map(resolved.map(r => [r.allowance.unkoNo, r.legPoints]))
    // 積んだまま帰庫した便の卸地は次の運行の先頭にある。全運行を引き終えてから当てる。
    const ops = applyCarryOver(resolved.map(r => r.allowance), rateRows.value)
    shownYm.value = ym.value

    // **手当は運行手当タブと同じ基準にする** — 暫定を足し、除外した便は落とす。
    // 基準がずれると「手当タブと粗利タブで手当が違う」という直しようのない話になる。
    const provisional = parseProvisional(localStorage.getItem(PROVISIONAL_KEY))
    const excluded: ExcludedMap = parseExcluded(localStorage.getItem(EXCLUDED_KEY))
    // **月の切り方は運行の開始日** (Refs #760 の 16)。運行手当タブ (便の積み日) とは
    // わざと違う — 粗利は運行を単位にしていて燃料代が運行まるごとの走行km から出るので、
    // 便だけ月で切ると月跨ぎの運行で必ず検算が合わない。CSV から取れた `運行開始` を
    // 渡し、取れない運行は `operationRunDate` が 運行日 → 運行NO に落とす。
    const startTsByUnko = new Map(resolved.map(r => [r.allowance.unkoNo, r.startTs]))
    // **強制突合を当てる前の集計。** 一番星をどう引くか (乗務員 / 車番) と、どの
    // 乗務員・車輌ぶんを引くかを決めるのに使う。強制突合は便の卸地・手当を書き換える
    // だけで、運行も乗務員も増減しないので、ここで決めた引き先は当てた後も変わらない。
    const base = buildMonthlyAllowanceByOperationDate(ops, shownYm.value, startTsByUnko)
    const byDriver = canFetchByDriver(base.drivers.map(d => d.driverName))

    // 一番星が落ちていても経費と手当は出せる。売上だけ諦めて理由を画面に残す。
    let monthly = base
    let salesByLeg = new Map<string, number>()
    let customersByLeg = new Map<string, LegCustomerShare[]>()
    try {
      // **明細を先に引く。** 強制突合は明細の `rowId` で結ばれているので、
      // 集計より前に引いておかないと 1 件も解けない。取得はこの 1 回だけ。
      // **明細の期間は選んだ運行の 開始日〜終了日 まで広げる** — 翌月日付の便の売上も要る。
      const picked = new Set(base.drivers.flatMap(d => d.operations.map(o => o.unkoNo)))
      const slips = await fetchSlips(
        rowsOf(base, excluded), byDriver, slipRangeForOperations(shownYm.value, resolved, picked))
      // **強制突合は乗務員で引けているときだけ効かせる** (運行手当タブと同じ条件)。
      // 車番引きでは、その乗務員が別の車番で走った日の明細を持っていないので、
      // 人が結んだ相手が引けない。
      // **対象月の外の便も含めて引く** (`toReportRows(ops)`) — 月で切ってから引くと、
      // 月末の運行に結んだぶんが集計に映らない。
      const forced = byDriver
        ? resolveForceMatches(
            toReportRows(ops),
            parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY)),
            slipByRowId(slips.byKey),
            provisional,
            rateRows.value,
          )
        : new Map<string, ForcedLeg>()
      // **集計の前に便へ重ねる** — 卸地・手当・便数・経路キーが 1 か所から追従する。
      // 結んだ便が無ければ `applyForcedLegs` は同じ配列を返すので、集計し直さない。
      const opsForced = applyForcedLegs(ops, forced)
      if (opsForced !== ops) monthly = buildMonthlyAllowanceByOperationDate(opsForced, shownYm.value, startTsByUnko)
      const sales = reconcileSales(rowsOf(monthly, excluded), slips, byDriver, forced, provisional)
      salesByLeg = sales.salesByLeg
      customersByLeg = sales.customersByLeg
      uncovered.value = sales.uncovered
      uncoveredByDriver.value = sales.uncoveredByDriver
      legSalesByUnko.value = sales.legSales
    }
    catch (e) {
      // **`e.message` は使わない** (Refs #890)。売上は `/api/ichiban/**` (自前の
      // server route) 越しなので、proxy が投げる 502/503 の日本語は JSON 本文にしか
      // 載らない。本番は HTTP/3 で reason phrase 自体が無く、`e.message` は
      // `[GET] "…": 503` で終わる。
      salesError.value = describeCaughtError(e, RETRY_AGGREGATE)
    }

    // 運行が月を跨いだぶんの注記 (Refs #760 の 16)。**キャッシュにも入れる。**
    crossMonth.value = monthly.crossMonth
    const rowsByUnko = rowsByUnkoOf(monthly, excluded)
    inputs.value = monthly.drivers.flatMap(d => d.operations.map((op) => {
      const rows = rowsByUnko.get(op.unkoNo) ?? []
      return {
        unkoNo: op.unkoNo,
        // **経費の `運行年月日` と突き合わせる鍵**。便の日付 (積みの時刻) を使う。
        date: rows[0]?.date ?? op.readingDate,
        driverName: d.driverName,
        vehicleCode: vehicleCodeFromUnkoNo(op.unkoNo),
        totalKm: kmByUnko.get(op.unkoNo) ?? 0,
        listedTotalKm: listedKmByUnko.get(op.unkoNo) ?? null,
        kmBreakdown: kmBreakdownByUnko.get(op.unkoNo) ?? emptyKmBreakdown(),
        salesYen: rows.reduce((sum, r) => sum + (salesByLeg.get(legKey(r)) ?? 0), 0),
        allowanceYen: rows.reduce((sum, r) => sum + legPayYen(r, provisional), 0),
        legs: buildMarginLegs(rows, legKmDetailByUnko.get(op.unkoNo) ?? [], salesByLeg, customersByLeg, provisional),
      }
    }))

    // 経費は車輌ごとに引く (按分の分母が「月・その車輌の Σ走行距離」なので対応が取れる)。
    const costRange = monthCostRange(shownYm.value)
    const vehicles = [...new Set(inputs.value.map(i => i.vehicleCode))].sort()
    const gathered: CostRow[] = []
    try {
      for (const code of vehicles) {
        progress.value = `一番星の経費を取得中 車輌${code}`
        gathered.push(...await fetchVehicleCosts(code, costRange.from, costRange.to))
      }
      costs.value = gathered
    }
    catch (e) {
      // 売上と同じ理由で本文から読む (Refs #890)。経費も `/api/ichiban/**` 越し。
      costError.value = describeCaughtError(e, RETRY_AGGREGATE)
    }

    status.value = 'ready'
    progress.value = ''
    writeCache()
    // **R2 の版はここで残す** (Refs #826)。確定ボタンは無く、再計算するたびに送って
    // 内容が同じなら版は増えない。**await しない** — R2 が落ちていても粗利の画面は
    // 出し切る (端末のキャッシュだけが残る旨を注記が言う)。
    void saveMarginSummaryToR2()
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
  }
}

// --- 表示 ---

const result = computed(() => buildOperationMargins(inputs.value, costs.value, fuelRates.value, runCostShareMode.value))

/**
 * **釧路営業所発の組み直し試算 (`kushiro-doto-rebuild.ts`) の入力** (Refs #760 の 35)。
 *
 * 粗利の集計 (`result`) とは**独立**で、画面には 1 文字も出ない — 次の PR の
 * 釧路営業所タブが prop で受け取る。`inputs` (= `MarginLegInput` に `haulSec` /
 * `deadheadSec` が生きている側) から組む: 計算結果の `LegMargin` には秒が無い。
 */
const rebuildInputs = computed(() => buildRebuildOperationInputs(inputs.value, legPointsByUnko.value))

// --- 釧路積み (釧路営業所試算) の区画 (Refs #760 の 36) ---------------------
// **粗利の数字には 1 円も効かない。** 入力は上の `rebuildInputs` だけで、
// `result` / `totals` / `customerSummary` は 1 つも読まない。計算は
// `kushiro-branch-view.ts` (さらにその下は `kushiro-doto-rebuild.ts`) が持ち、
// `KushiroBranchPanel.vue` は返ってきた plain object を並べるだけ。

/** スライダーで選んだ 便/日。**`null` = 実測平均** (既定値を定数で持たない)。 */
const kushiroLegsPerDay = ref<number | null>(null)
/**
 * 最低賃金マスタ (`GET /restraint-api/min-wage`)。取れるまで `null` で、
 * **取れなくても区画は出す** (額の列だけ「−」になる)。
 */
const kushiroMinWageMaster = ref<MinWageMaster | null>(null)
/** マスタを読めなかった理由 (画面に出す。黙って「−」にしない)。 */
const kushiroMinWageError = ref('')

/**
 * 最低賃金マスタを読む。**会社ID は拘束時間・賃金タブが localStorage に残したものを借りる**
 * — 粗利タブは theearth ログインを持たないので、ここで新しいログイン導線は作らない。
 *
 * **成功したときだけ「読んだ」と印を付ける** — mount の時点では JWT がまだ入って
 * いないことがあるので、集計が終わったタイミングでもう一度呼べるようにしてある。
 */
async function loadKushiroMinWageMaster() {
  if (kushiroMinWageMaster.value !== null) return
  const compId = readViewerCompId(localStorage)
  const token = currentAccessToken()
  if (!compId || !token) {
    kushiroMinWageError.value = '最低賃金マスタを読めませんでした — 会社IDが分かりません。拘束時間・賃金タブを一度開いてください'
    return
  }
  try {
    const res = await $fetch<{ exists: boolean, data: MinWageMaster | null }>('/restraint-api/min-wage', {
      headers: {
        'X-Theearth-Comp-Id': compId,
        'X-Theearth-User-B64': b64urlUtf8('viewer'),
        'Authorization': `Bearer ${token}`,
      },
    })
    kushiroMinWageMaster.value = res.data
    kushiroMinWageError.value = res.data === null ? '最低賃金マスタが R2 にありません (拘束時間・賃金タブの単価マスタで登録できます)' : ''
  }
  catch (e) {
    // **`/restraint-api/**` は Nitro ではない** (Refs #890)。`worker/index.ts` が
    // relay worker (`SCRAPER_RELAY`) へ転送しており、本文は Nitro の
    // `{error: true, …}` ではなく relay の **`{error: '<日本語>'}`**
    // (`dtako-scraper-relay-do.ts` の `dvrJsonError`)。`describeCaughtError` が中で
    // 呼ぶ `describeApiError` は `d.error` を最初に見るので、この形なら 1 発で拾える。
    kushiroMinWageError.value = `最低賃金マスタを読めませんでした — ${describeCaughtError(e, RETRY_AGGREGATE)}`
  }
}

// 集計が終わった時点でもう一度だけ試す (mount 時に JWT が揃っていないことがある)。
watch(status, (s) => {
  if (s === 'ready') loadKushiroMinWageMaster()
})

const kushiroView = computed(() => buildKushiroBranchView(rebuildInputs.value, {
  ym: shownYm.value,
  legsPerDay: kushiroLegsPerDay.value,
  minWageMaster: kushiroMinWageMaster.value,
}))

/** 配分の比を変える。**保存に失敗しても画面の数字は正しい**ので握る (燃費の上書きと同じ)。 */
function onRunCostShareModeChange(raw: string) {
  runCostShareMode.value = parseRunCostShareMode(raw)
  try {
    localStorage.setItem(RUN_COST_SHARE_MODE_KEY, runCostShareMode.value)
  }
  catch (e) {
    cacheNote.value = `運行経費の配分の設定を保存できませんでした — ${e instanceof Error ? e.message : String(e)}`
  }
}

/** select の title と、便の段の列見出しに出す「いまどの比で配っているか」。 */
const RUN_COST_SHARE_MODE_TITLE = [
  '運行経費 (直課 + 固定費按分) を便に配る比:',
  '走行km比 = (売上走行km + 回送km) ÷ 運行の全便の和',
  '便数比 = 1 ÷ 運行の便数',
  '拘束時間比 = (売上時間 + 回送時間) ÷ 運行の全便の和',
].join('\n')
const totals = computed(() => summarizeMargins(result.value.operations))
/**
 * **いま画面に出ている集計を R2 に版として残す** (Refs #826)。確定ボタンは作らず、
 * 再計算のたびに送る — 内容が同じなら `putVersionedProfit` の sha256 差分検知が
 * 版を増やさない (R2 の容量は「変わった回数」ぶんしか伸びない)。
 *
 * **粗利の数字は 1 円も作り直さない。** 送るのは localStorage に書くのと同じ
 * `MarginCache` と、画面に出ている `totals` (`summarizeMargins` の結果) そのまま。
 *
 * ★ **形式 2 からは「この端末の設定」も一緒に送る** (Refs #886) — 燃費の上書き
 * (`fuelRates`) と運行経費の配分の比 (`runCostShareMode`)。どちらも localStorage 由来で
 * **この端末にしか無い**ので、送らないと**版が増えた理由が版のどこにも残らない**。
 * **これで版が増える条件が 1 つ増える**: 配分の比だけを変えて集計し直すと、
 * `totals` は 1 円も動かないのに版が 1 本増える (便の内訳は実際に変わっているので、それが正しい)。
 *
 * **投げない**: 失敗しても画面は落とさず注記だけ出す。localStorage の写しは
 * 残っているので、R2 が使えなくても画面は死なない。
 */
async function saveMarginSummaryToR2() {
  const input = buildMarginSummaryInput({
    cache: currentMarginCache(savedAt.value),
    totals: totals.value,
    codeVersion,
    // ★ **`result` (= `buildOperationMargins`) に渡したのと同じ 2 つ** (Refs #886)。
    // ここで既定に倒したり作り直したりしない — 版が名乗る指紋は
    // **その数字を実際に作った設定**でなければ意味が無い。
    fuelRateOverrides: fuelRates.value,
    runCostShareMode: runCostShareMode.value,
  })
  try {
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — server route が
    // `requireAuth` を通すようになった (Refs #988)。`postNet780Archive` と同じ扱い。
    const token = currentAccessToken()
    const res = await $fetch<MarginSummarySaveResult>('/api/profit/margin-summary', {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: input,
    })
    marginR2Note.value = marginSummarySaveNote(res, null)
    marginR2Failed.value = false
  }
  catch (e) {
    // **`e.message` は使わない** (Refs #890)。ofetch は HTTP の reason phrase から
    // message を組むので、`createError` に書いた日本語がそこで丸ごと落ちる
    // (「cache (ym 一致)」が「cache (ym )」になる)。理由は JSON 本文に残っている。
    // ★ **ここは `describeCaughtError` に通さない** (Refs #1008 PR-2)。
    //   `marginSummarySaveNote` が**自前の「次の一手」を末尾に持っている**ので、
    //   status ごとの一手を足すと**指示が 2 つ並ぶ**。実測した合成後の 1 文:
    //
    //   `… (401 Unauthorized — ログインが切れています。再ログインしてから「集計」を押してください (…))`
    //   `— 記録はこの端末のキャッシュだけです。… まず画面を開き直してください — …`
    //   ⇒ **「集計を押せ」と「画面を開き直せ」が食い違う。**
    //
    //   「理由は共通・やり直し方は画面ごと (= 1 つ)」を崩さないため、理由だけを渡す。
    marginR2Note.value = marginSummarySaveNote(null, describeApiError(e))
    marginR2Failed.value = true
  }
  // **保存の成否によらず一覧を読み直す。** 保存が失敗した回でも、それより前に残した版は
  // R2 にある — 読まないと「版が 1 つも無い」ように見える。
  await loadMarginVersions(shownYm.value)
}

/**
 * **R2 に残っている版の一覧を読む** (Refs #833)。金額まで出るのは新しい方から
 * `MARGIN_VERSION_BODY_LIMIT` 本ぶんで、それより古いのはラベル (時刻) だけ
 * — **省いたことは注記で言う** (黙って切ると「全部出ている」と誤読される)。
 *
 * **投げない**: 読めなくても粗利の画面は落とさず、理由を注記に出す。
 */
async function loadMarginVersions(ymValue: string) {
  marginVersionsLoading.value = true
  try {
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — この読み口が
    // `requireAuth` を通すようになった (Refs #988)。`snapshot.delete.ts` と同じ扱い。
    const token = currentAccessToken()
    const res = await $fetch<MarginVersionListResult>('/api/profit/margin-snapshots', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      query: { ym: ymValue },
    })
    marginVersions.value = res.items
    marginVersionsNote.value = marginVersionOmittedNote(res.omitted, res.bodyLimit)
    marginVersionsUnreadableNote.value = marginVersionUnreadableNote(res.unreadable)
    marginVersionsError.value = ''
  }
  catch (e) {
    // **空の一覧に倒さない** — 「読めなかった」と「版が無い」は別のこと。
    marginVersions.value = []
    marginVersionsNote.value = ''
    marginVersionsUnreadableNote.value = ''
    // 理由は JSON 本文から読む (Refs #890)。`e.message` だと status しか出ない。
    marginVersionsError.value = `R2 に残した版の一覧を読めませんでした — ${describeCaughtError(e, RETRY_AGGREGATE)}`
  }
  finally {
    marginVersionsLoading.value = false
    // 一覧が入れ替わったら、選んでいた版はもう一覧に無いかもしれない。**選び直す。**
    resetMarginDiff()
    pickDefaultMarginDiffVersions()
  }
}

/**
 * **差分の状態をまるごと捨てる** (Refs #834)。月を替えたとき・一覧を読み直したときに呼ぶ。
 * 選んだ版のラベルは残さない — 一覧に無い版を選んだままにすると、押した瞬間 404 になる。
 */
function resetMarginDiff() {
  marginDiff.value = null
  marginDiffError.value = ''
  marginDiffBeforeLabel.value = ''
  marginDiffAfterLabel.value = ''
  for (const key of Object.keys(openDiffOps)) delete openDiffOps[key]
}

/**
 * **既定は「いちばん新しい 2 本」** (一覧は新しい順)。よく見たいのは直近の変化なので、
 * 毎回 2 回選ばせない。版が 2 本に足りなければ選ばない (`marginDiffNeedsMore` が言う)。
 */
function pickDefaultMarginDiffVersions() {
  const items = marginVersions.value
  const [newest, previous] = items
  if (newest === undefined || previous === undefined) return
  marginDiffAfterLabel.value = newest.label
  marginDiffBeforeLabel.value = previous.label
}

/**
 * **選んだ 2 版の本文を読んで突き合わせる** (Refs #834)。
 *
 * **差分を作るのはここ (画面) で、server route は本文を返すだけ。**
 * `buildOperationMargins` は呼ばない — **この画面は保存された値を引き算するだけ**で、
 * 粗利を計算し直さないため。**形式 2 の版は燃費の上書きと運行経費の配分を指紋として
 * 持っている**ので原理的には計算し直せるが、**形式 1 の版は指紋そのものを持たない**
 * (集計した端末の localStorage にしか無く、保存した時点で失われている) ので、
 * **そちらは永久に運行 1 本の粗利を厳密に再現できない** (Refs #886)。
 * 指紋を突き合わせて差の理由まで言うのは別 PR。
 *
 * **投げない**: 読めなくても粗利の画面は落とさず、理由を注記に出す。
 */
async function runMarginDiff() {
  marginDiffLoading.value = true
  marginDiffError.value = ''
  try {
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — この読み口が
    // `requireAuth` を通すようになった (Refs #988)。`snapshot.delete.ts` と同じ扱い。
    const token = currentAccessToken()
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
    const [before, after] = await Promise.all([
      $fetch<MarginDiffSnapshot>('/api/profit/margin-snapshot', {
        headers,
        query: { ym: shownYm.value, version: marginDiffBeforeLabel.value },
      }),
      $fetch<MarginDiffSnapshot>('/api/profit/margin-snapshot', {
        headers,
        query: { ym: shownYm.value, version: marginDiffAfterLabel.value },
      }),
    ])
    marginDiff.value = buildMarginDiff(
      { label: marginDiffBeforeLabel.value, snapshot: before },
      { label: marginDiffAfterLabel.value, snapshot: after },
    )
  }
  catch (e) {
    // **空の差分に倒さない** — 「読めなかった」と「変わっていない」は別のこと。
    marginDiff.value = null
    // 理由は JSON 本文から読む (Refs #890)。
    marginDiffError.value = `選んだ版の本文を読めませんでした — ${describeCaughtError(e, '「差分を出す」を押してください')}`
  }
  finally {
    marginDiffLoading.value = false
  }
}

/** 差分の 1 項目の値。**書式は表と同じ `yen()` / `km()`** (差分だけ別の丸め方にしない)。 */
function marginDiffValueText(row: MarginDiffRow, value: number): string {
  if (row.unit === 'yen') return yen(value)
  if (row.unit === 'km') return km(value)
  return String(value)
}

/** 差そのもの。**符号を必ず付ける** — `¥-500` ではどちらへ動いたか読み違える。 */
function marginDiffDeltaText(row: MarginDiffRow): string {
  if (row.delta === 0) return '±0'
  const sign = row.delta > 0 ? '+' : '-'
  return `${sign}${marginDiffValueText(row, Math.abs(row.delta))}`
}

/** 粗利を出せなかった理由と件数。**畳まれた表の中に隠さず月の合計の横に出す。** */
const noMarginGroups = computed(() => summarizeNoMarginReasons(result.value.operations))
/** 粗利率の分母は**粗利を出せた運行ぶんの売上**。全体の売上で割ると、経費が来ていない
 * 車輌がいるだけで粗利率が実際より低く見える。 */
const monthMarginRate = computed(() => marginRate({
  salesYen: totals.value.marginSalesYen,
  marginYen: totals.value.marginYen,
}))

/** 車輌ごとの燃費・単価の欄 (実績と上書き)。**車輌C 順に固定する。** */
const vehicleRates = computed(() => [...result.value.kmByVehicle.keys()].sort().map(code => ({
  code,
  totalKm: result.value.kmByVehicle.get(code)!,
  derived: result.value.derivedByVehicle.get(code)!,
  effective: result.value.ratesByVehicle.get(code)!,
  override: fuelRates.value[code],
})))

/** 粗利を出せなかった運行 (燃費が出せない / その車輌の経費が 1 件も無い)。 */
function hasIssue(m: OperationMargin): boolean {
  return m.marginYen === null
}

/**
 * 表示する乗務員。**社員番号 (乗務員CD) 順に並べる** — `margin.ts` は乗務員CD を
 * 持っていないので氏名順で返す。給与まわりの画面としては社員番号順が自然。
 */
const visibleDrivers = computed(() => {
  const groups = groupMarginsByDriver(onlyIssues.value
    ? result.value.operations.filter(hasIssue)
    : result.value.operations)
  const keyOf = (name: string) => {
    const cd = driverCdByName.value.get(name)
    return cd === undefined ? `9${name}` : `0${cd.padStart(8, '0')}`
  }
  return [...groups].sort((a, b) => (keyOf(a.driverName) > keyOf(b.driverName) ? 1 : -1))
})

const openDrivers = reactive<Record<string, boolean>>({})

/**
 * 乗務員ごとの 100% 積み上げ棒 (乗務員/運行 の表の直後、Refs #760 の 39)。
 * **表と同じ `visibleDrivers`** から出す (並びも絞り込みも表と揃う)。
 */
const driverBars = computed(() => driverShareBars(visibleDrivers.value))

// ---------------------------------------------------------------------------
// 乗務員別の賃金構成 (基本給 ＋ 残業 ＋ 旅費、Refs #760 の 40)
// ---------------------------------------------------------------------------
//
// 帯広の給与は、いま**運行手当がそのまま基本給として支給され、上に全員一律
// ¥10,000 の残業代が乗っているだけ**で、帳簿上「残業がほぼ無い」姿になっている。
// これを三段に組み直すとどうなるかを、この画面で振れるようにする。
//
// **粗利の数字には 1 円も効かない** — 運行・便・取引先・経費のどの集計もこの区画を
// 読まない。旅費の母数として手当を**読む**だけ。

/** 賃金構成の設定 (方式・単価・日額・旅費率・現状の一律残業代)。 */
const wageMix = ref(defaultWageMixSettings())

/** 切り替えボタンに並べる方式 (template から `as const` を書かずに済ませる)。 */
const WAGE_MIX_METHODS: WageMixMethod[] = ['hours', 'days']

/**
 * 拘束時間サマリ (乗務員CD → 分)。**素材は R2 のアーカイブ
 * (`/restraint-api/archive/summaries`)。**
 *
 * **GCP (`day_summaries`) は使わない。行が欠けている** — 2026-07 の実測で
 * 柳井が 86.5h (実績 264.5h の 33%)、5 名とも 77〜91% しか入っていなかった。
 * この口は MCP `get_restraint_summary` と**同一の R2 キー**を読むことを本番で実測済み
 * (柳井 restraintMinutes 15867 / workingMinutes 15517 / overtimeMinutes 4611 /
 * nightMinutes 7884 / workDays 23 が MCP の返り値と 1 分の狂いもなく一致)。
 *
 * **拘束×賃金タブの `wage-report` (「現行」) とは経路が違う** — あちらは ichiban の
 * 写し (`wage-source`) を読む。2026-07 が 0 行になり「アーカイブにありません」と
 * 出ていたのは**未同期だからではなく、同期済み (`synced_at` 非 null) なのに写しが
 * 空**で、R2 に在るのに読みに行かなかったため (#812 で relay 側にフォールバックを
 * 足し、文言も切り分け可能なものへ直した)。この口は昔から R2 直読みなので無関係。
 */
const restraintByCd = ref<Map<string, WageMixRestraint> | null>(null)
const loadingRestraint = ref(false)
/** 拘束を読めなかった理由。**黙って空にしない** (画面に出す)。 */
const restraintError = ref('')
/** アーカイブの取得時刻 (`fetched_at`)。いつの写しを見ているかを画面に出す。 */
const restraintFetchedAt = ref('')
/** 読み込み済みの月 (月を変えたら取り直す)。 */
const restraintYm = ref('')

/** `/restraint-api/archive/summaries` の応答のうち、賃金構成が読む列だけ。 */
interface ArchiveSummaryWire {
  data: {
    driverCd: string
    workingMinutes: number | null
    overtimeMinutes: number | null
    nightMinutes: number | null
    workDays: number
  }
  fetchedAt: string | null
}

/**
 * 拘束時間サマリを読む。**認証は拘束×賃金タブの `authHeaders()` と同じ 3 ヘッダ** —
 * cookie (`logi_auth_token`) だけだと 401 になる (本番で実測)。
 *
 * **失敗しても 0 分に倒さない。** 理由を `restraintError` に残し、表は金額を出さない。
 */
async function loadRestraint(force = false) {
  const target = shownYm.value
  if (!target) return
  if (!force && restraintYm.value === target && restraintByCd.value !== null) return
  const compId = readViewerCompId(localStorage)
  const token = currentAccessToken()
  if (!compId || !token) {
    restraintError.value = '拘束時間を読めませんでした — 会社IDが分かりません。拘束時間・賃金タブを一度開いてください'
    return
  }
  loadingRestraint.value = true
  restraintError.value = ''
  try {
    const res = await $fetch<{ summaries: ArchiveSummaryWire[] }>('/restraint-api/archive/summaries', {
      headers: {
        'X-Theearth-Comp-Id': compId,
        'X-Theearth-User-B64': b64urlUtf8('viewer'),
        'Authorization': `Bearer ${token}`,
      },
      query: { month: target },
    })
    // 月を変えた後に古い応答が返ってきたら捨てる (latest-wins)。
    if (shownYm.value !== target) return
    const map = new Map<string, WageMixRestraint>()
    let fetchedAt = ''
    for (const s of res.summaries) {
      map.set(s.data.driverCd, {
        workingMinutes: s.data.workingMinutes,
        overtimeMinutes: s.data.overtimeMinutes,
        nightMinutes: s.data.nightMinutes,
        workDays: s.data.workDays,
      })
      if (s.fetchedAt && s.fetchedAt > fetchedAt) fetchedAt = s.fetchedAt
    }
    restraintByCd.value = map
    restraintFetchedAt.value = fetchedAt
    restraintYm.value = target
  }
  catch (e) {
    if (shownYm.value !== target) return
    restraintByCd.value = null
    // 最低賃金マスタと同じ relay 経由 (`{error: '<日本語>'}`、Refs #890)。
    restraintError.value = `拘束時間を読めませんでした — ${describeCaughtError(e, RETRY_RELOAD_WAGE_MIX)}`
  }
  finally {
    loadingRestraint.value = false
  }
}

/** 旅費の母数 (乗務員別)。粗利タブの手当 − 翌月日付の便 + 対象外便。 */
const allowanceBase = computed<AllowanceBaseRow[]>(() =>
  buildAllowanceBase(inputs.value, shownYm.value, driverCdByName.value, uncoveredByDriver.value))

/**
 * **実支給** (乗務員CD → 円、Refs #814)。素材は一番星の経費明細の
 * **経費種別 `08 給与(人件費)`** を乗務員CD で畳んだ額。
 *
 * **粗利のために引いている経費 (`costs`) は使わない** — あちらは**車番**で引くので、
 * その月に粗利へ乗っていない車輌に給与が付いている乗務員を取りこぼす。中村・柳井・
 * 西島は車輌をまたいで給与の行が 2 本に分かれる (2026-07 実測)。**乗務員CD で引く。**
 *
 * **引けなければ null のまま。0 に倒さない** — 賃金構成の行が推計に落ちて理由が出る。
 */
const actualPayByCd = ref<Map<string, number> | null>(null)
const loadingActualPay = ref(false)
/** 実支給を読めなかった理由。**黙って空にしない** (画面に出す)。 */
const actualPayError = ref('')
/** 読み込み済みの月 (月を変えたら取り直す)。 */
const actualPayYm = ref('')

/**
 * 実支給を読む。**乗務員CD を引けた乗務員だけ**を対象にする
 * (CD が無ければ経費明細を絞れないので、その行は推計に落ちる)。
 *
 * **失敗しても 0 に倒さない。** 理由を `actualPayError` に残し、表は推計に落ちる。
 */
async function loadActualPay(force = false) {
  const target = shownYm.value
  if (!target) return
  if (!force && actualPayYm.value === target && actualPayByCd.value !== null) return
  const cds = [...new Set(allowanceBase.value.map(row => row.driverCd))].filter(cd => cd !== '')
  if (cds.length === 0) return
  loadingActualPay.value = true
  actualPayError.value = ''
  try {
    const range = monthCostRange(target)
    const byDriver = await fetchActualWageByDriver(cds, range.from, range.to)
    // 月を変えた後に古い応答が返ってきたら捨てる (latest-wins、拘束と同じ)。
    if (shownYm.value !== target) return
    actualPayByCd.value = new Map(Object.entries(byDriver))
    actualPayYm.value = target
  }
  catch (e) {
    if (shownYm.value !== target) return
    actualPayByCd.value = null
    // `/api/ichiban/**` 越しなので本文から読む (Refs #890)。
    actualPayError.value = `実支給 (一番星の経費明細 08 給与) を読めませんでした — ${describeCaughtError(e, RETRY_RELOAD_WAGE_MIX)}`
  }
  finally {
    loadingActualPay.value = false
  }
}

/** 賃金構成の素材 (拘束時間・実支給) をまとめて取り直す。 */
function reloadWageMixSources() {
  loadRestraint(true)
  loadActualPay(true)
}

/** 実支給が**月ぜんぶ**引けていないときの理由 (行ごとの理由を差し替える)。 */
const actualPayMonthReason = computed(() => actualPayByCd.value === null
  ? '実支給が取れていない (一番星の経費明細を読めていない — 「再読込」で取り直せます)'
  : undefined)

/** 賃金構成の行。拘束が引けない乗務員は金額 `null` (0 に倒さない)。 */
const wageMixRows = computed(() => allowanceBase.value.map(base => computeWageMixRow({
  driverCd: base.driverCd,
  driverName: base.driverName,
  allowanceBaseYen: base.baseYen,
  restraint: restraintByCd.value?.get(base.driverCd) ?? null,
  actualPayYen: actualPayByCd.value?.get(base.driverCd) ?? null,
  actualPayReason: actualPayMonthReason.value,
}, wageMix.value)))

const wageMixTotals = computed(() => summarizeWageMix(wageMixRows.value))
const wageMixWarning = computed(() => minWageWarning(wageMix.value))

/** 母数の内訳 (合計)。画面に「何を母数にしているか」を必ず出すために使う。 */
const allowanceBaseTotals = computed(() => {
  let operationYen = 0
  let nextMonthYen = 0
  let uncoveredYen = 0
  let complete = allowanceBase.value.length > 0
  for (const row of allowanceBase.value) {
    operationYen += row.operationYen
    nextMonthYen += row.nextMonthYen
    uncoveredYen += row.uncoveredYen ?? 0
    if (!row.complete) complete = false
  }
  return { operationYen, nextMonthYen, uncoveredYen, complete, baseYen: operationYen - nextMonthYen + uncoveredYen }
})

/** 数値入力を受ける (負・NaN は 0 に倒す。クランプは**しない** — 警告で出す)。 */
function onWageMixNumber(field: 'hourlyRateYen' | 'dailyRateYen' | 'flatOvertimeYen', raw: string) {
  wageMix.value = { ...wageMix.value, [field]: Math.max(0, Number(raw) || 0) }
}

function setWageMixMethod(method: WageMixMethod) {
  wageMix.value = { ...wageMix.value, method }
}

function setTravelRate(rate: number) {
  wageMix.value = { ...wageMix.value, travelRate: rate }
}

/** 時間の表示 (`209.6h`)。分は出さない — 判断に効かない桁なので。 */
function hours(v: number | null): string {
  return v === null ? '-' : `${Math.round(v * 10) / 10}h`
}

/** 符号付きの金額 (`+¥12,345` / `−¥12,345`)。差の列に使う。 */
function signedYen(v: number | null): string {
  if (v === null) return '-'
  const r = Math.round(v)
  return `${r < 0 ? '−' : '+'}¥${Math.abs(r).toLocaleString()}`
}

// 集計が終わった / キャッシュから復元した / 月が変わったら拘束を取りに行く。
// **運行が 1 本も無いうちは読まない** — 見ていない区画のために上流を叩かない
// (拘束×賃金タブの GCP 取得と同じ判断)。
watch([() => inputs.value.length, shownYm], ([count]) => {
  if (count === 0) return
  loadRestraint()
  loadActualPay()
})

/**
 * 運行行の「地図」モーダル (Refs #760 の 18)。イベントCSV を **その場で 1 回引く**
 * (`resolveOperation` の集計とは別の呼び出し。運行 1 本の 1 呼び出しなので cache には
 * 入れない — **明細は `MarginCache` に入れない**。量が桁違いで、R2 の版の容量が
 * 運行本数×月で膨らむ)。描く形への変換は
 * `buildOperationRoute` (pure)、描画は `OperationRouteMap.vue` (dumb)。
 */
const routeModal = ref<{
  /** 何を開いているか (`op:<運行NO>` / `route:<取引先C>:<積地>→<卸地>` / `customer:<取引先C>`)。
   *  待っている間に別のを開いた / 閉じたときに、古い結果で上書きしないための鍵。 */
  key: string
  title: string
  route: OperationRoute | null
  loading: boolean
  error: string | null
  /** 軌跡の内訳 (`NET780 軌跡: N 運行ぶん / イベント軌跡: M 運行ぶん`)。引き終わるまで null。 */
  trackNote: string | null
  /**
   * NET780 のアーカイブが **無かった** (`not-found`) 運行NO (Refs #760 の 27)。見出しの
   * 「NET780 を取得 (未取得 N 運行)」の N と、押したときに relay へ渡す対象。NET780 を
   * 引き終わるまで undefined (`error` の運行は入れない — 取りに行っても直らない)。
   */
  net780Missing?: string[]
} | null>(null)

/**
 * 地図のレイヤ (Refs #760 の 25)。既定は軌跡 ON / 直線 OFF / マーカー ON
 * (`DEFAULT_ROUTE_MAP_LAYERS`)。localStorage `ROUTE_MAP_LAYERS_KEY` に保存し、
 * 不正値は `parseRouteMapLayers` が既定に倒す。描画側の絞り込みは `OperationRouteMap.vue`
 * (`filterRouteByLayers`)。
 */
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

/**
 * いま開いている地図を**同じ引数で開き直す**関数 (Refs #760 の 27)。`openRouteMap` /
 * `openLegRefsMap` が自分を束縛して置き、NET780 取得が終わったあとに呼んで NET780 軌跡に
 * 切り替える (`useNet780OperationData` の cache は `not-found` を毎回 fetch し直す設計
 * なので、新しく archive された運行は開き直せば `ready` になる)。
 */
let routeModalReopen: (() => Promise<void>) | null = null

/**
 * 運行 1 本の NET780 の道なり軌跡 (Refs #760 の 21)。アーカイブがあれば (`ready`) 有効な
 * GPS を便の時間窓 (`route.windows`) で切って `trackHaul` / `trackDeadhead` の区切りにする。
 * **404 (`not-found`) は正常系** — 2026-07 帯広 5 台 91 運行のうちアーカイブがあるのは
 * 2 本だけ。`error` も軌跡無し扱い (地図はイベント線で出ている)。どちらも `track: null`。
 * `missing` は 404 (`not-found`) のときだけ true — 「NET780 を取得」(Refs #760 の 27) の対象。
 * wasm parse が走るのは ready の運行だけ (composable が 404 で早期 return する)。
 */
async function fetchNet780Track(unkoNo: string, windows: LegWindow[]): Promise<{ track: RouteSegment[] | null, missing: boolean }> {
  const net780 = useNet780OperationData(unkoNo)
  await net780.ensureLoaded()
  const result = net780.result.value
  // `missing` = アーカイブが無い (404)。「NET780 を取得」の対象 (Refs #760 の 27)。
  const missing = net780.status.value === 'not-found'
  if (net780.status.value !== 'ready' || result === null) return { track: null, missing }
  const points = filterValidGpsPoints(result.gps, result.events).map(p => ({ ts: p.ts, lat: p.lat, lng: p.lon }))
  return { track: splitTrackByWindows(points, windows), missing }
}

/** イベント線の route に軌跡 (NET780 / イベント) の区切りを足す (pointCount はイベント線の点数のまま)。 */
function appendTrack(route: OperationRoute, track: RouteSegment[]): OperationRoute {
  return { ...route, segments: [...route.segments, ...track] }
}

/**
 * 軌跡をどちらで敷いたかの内訳 (Refs #760 の 24)。運行ごとに **NET780 が優先**で、
 * 無い運行だけイベント軌跡になるので、両方が並ぶことがある (経路を重ねた地図)。
 */
function trackNoteFor(net780: number, overlay: number): string {
  const parts: string[] = []
  if (net780 > 0) parts.push(`NET780 軌跡: ${net780} 運行ぶん`)
  if (overlay > 0) parts.push(`イベント軌跡: ${overlay} 運行ぶん`)
  return parts.length === 0 ? '軌跡なし' : parts.join(' / ')
}

/**
 * **重ね掛け行も混ぜたイベント軌跡** (Refs #760 の 24)。地図を開くときに引いた
 * **同じ CSV** から作るので追加の fetch は無い。`buildOperationRoute` のイベント線が
 * `DISTANCE_EVENT_NAMES` の行だけを結ぶのに対し、こちらは重ね掛け行 (高速道の出入口・
 * 速度オーバー区間の両端 …) の GPS も混ぜるので、折れ点が増えて経路のスケッチが密になる。
 *
 * **NET780 のアーカイブがある運行では使わない** (2026-07 帯広 91 運行中 2 本)。
 * 道なりの実測が既にあるところに同じ道をもう 1 本敷いても読めなくなるだけなので、
 * `openRouteMap` / `openLegRefsMap` は NET780 が引けた運行だけ NET780 を採る。
 */
function buildEventTrack(headers: string[], rows: string[][], windows: LegWindow[]): RouteSegment[] {
  return splitTrackByWindows(buildOverlayTrack(headers, rows), windows)
}

async function openRouteMap(m: OperationMargin) {
  const key = `op:${m.unkoNo}`
  const title = `運行 ${m.date} ${m.driverName} 車輌 ${m.vehicleCode} — 便 ${m.legs.length} 本`
  routeModal.value = { key, title, route: null, loading: true, error: null, trackNote: null }
  routeModalReopen = () => openRouteMap(m)
  let route: OperationRoute | null = null
  let eventTrack: RouteSegment[] = []
  let error: string | null = null
  try {
    const csv = await getOperationCsv(m.unkoNo, 'events')
    route = buildOperationRoute(csv.headers, csv.rows)
    eventTrack = buildEventTrack(csv.headers, csv.rows, route.windows)
  }
  catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  // 待っている間に別の運行を開いた / 閉じたなら、古い結果で上書きしない。
  if (routeModal.value?.key !== key) return
  routeModal.value = { key, title, route, loading: false, error, trackNote: null }
  if (route === null) return
  // NET780 は後から重ねる (遅くても地図は先にイベント線で出す)。**NET780 が無い運行だけ**
  // 重ね掛け行のイベント軌跡を敷く (Refs #760 の 24。二重に敷かない)。
  const { track, missing } = await fetchNet780Track(m.unkoNo, route.windows)
  if (routeModal.value?.key !== key) return
  routeModal.value = {
    ...routeModal.value,
    route: appendTrack(route, track ?? eventTrack),
    trackNote: trackNoteFor(track === null ? 0 : 1, track === null && eventTrack.length > 0 ? 1 : 0),
    net780Missing: missing ? [m.unkoNo] : [],
  }
}

/**
 * **この経路 (取引先) の便を全部重ねた地図** (Refs #760 の 19)。オーナー: 「粗利率の高い
 * 短距離経路と低い長距離経路の形を、便を重ねて比べたい」。
 *
 * `legRefs` を運行ごとにまとめ、運行 1 本につきイベントCSV を 1 回引いて
 * (`CSV_CONCURRENCY` で並列)、`pickLegsFromRoute` でその運行の**該当する便だけ**を
 * 残してから `mergeRoutes` で 1 枚に重ねる。**運行行の地図と同じモーダル**
 * (`routeModal`) に出す。cache には入れない (**明細は `MarginCache` に入れない** — 量が桁違い)。
 *
 * 引けなかった運行はそのぶんを抜いて描き、何本落としたかを `error` に出す
 * (**黙って少ない本数を重ねない** — 形を比べるのが目的なので、欠けを見せる)。
 */
async function openLegRefsMap(key: string, title: string, legRefs: LegRef[]) {
  const byUnkoNo = new Map<string, number[]>()
  for (const ref of legRefs) {
    const seqs = byUnkoNo.get(ref.unkoNo) ?? []
    seqs.push(ref.seq)
    byUnkoNo.set(ref.unkoNo, seqs)
  }
  const entries = [...byUnkoNo.entries()]
  const withProgress = (done: number) => `${title} (読み込み中 ${done}/${entries.length})`
  routeModal.value = { key, title: withProgress(0), route: null, loading: true, error: null, trackNote: null }
  routeModalReopen = () => openLegRefsMap(key, title, legRefs)

  const picked: Array<{ unkoNo: string, route: OperationRoute, eventTrack: RouteSegment[] }> = []
  let failed = 0
  for (let i = 0; i < entries.length; i += CSV_CONCURRENCY) {
    const results = await Promise.all(entries.slice(i, i + CSV_CONCURRENCY).map(async ([unkoNo, seqs]) => {
      try {
        const csv = await getOperationCsv(unkoNo, 'events')
        // イベント軌跡もここで作る (同じ CSV。**この運行の該当する便の窓だけ**で切る)。
        const route = pickLegsFromRoute(buildOperationRoute(csv.headers, csv.rows), seqs)
        return { unkoNo, route, eventTrack: buildEventTrack(csv.headers, csv.rows, route.windows) }
      }
      catch {
        return null
      }
    }))
    // 待っている間に別のを開いた / 閉じたなら、古い結果で上書きしない (残りも引かない)。
    if (routeModal.value?.key !== key) return
    for (const r of results) {
      if (r === null) failed += 1
      else picked.push(r)
    }
    routeModal.value = { key, title: withProgress(picked.length + failed), route: null, loading: true, error: null, trackNote: null }
  }
  const error = failed === 0 ? null : `運行 ${entries.length} 本のうち ${failed} 本のイベントCSVが引けませんでした`
  routeModal.value = { key, title, route: picked.length === 0 ? null : mergeRoutes(picked.map(p => p.route)), loading: false, error, trackNote: null }
  if (picked.length === 0) return

  // NET780 は後から重ねる (Refs #760 の 21)。運行ごとに引き (CSV と同じ並列数)、アーカイブが
  // ある運行 (ready) だけ軌跡を足す。404 が大半で軽い。揃ったら route を差し替える。
  const tracks = new Map<string, RouteSegment[]>()
  const net780Missing: string[] = []
  for (let i = 0; i < picked.length; i += CSV_CONCURRENCY) {
    const batch = picked.slice(i, i + CSV_CONCURRENCY)
    const results = await Promise.all(batch.map(p => fetchNet780Track(p.unkoNo, p.route.windows)))
    if (routeModal.value?.key !== key) return
    batch.forEach((p, j) => {
      const r = results[j]
      if (r?.track) tracks.set(p.unkoNo, r.track)
      if (r?.missing) net780Missing.push(p.unkoNo)
    })
    routeModal.value = { ...routeModal.value, trackNote: `NET780 確認中 ${Math.min(i + CSV_CONCURRENCY, picked.length)}/${picked.length}` }
  }
  // NET780 が引けた運行はそれを、引けなかった運行は重ね掛け行のイベント軌跡を敷く
  // (Refs #760 の 24)。同じ運行に 2 本敷かない。
  const overlaid = picked.map(p => ({ p, net780: tracks.get(p.unkoNo) ?? null }))
  routeModal.value = {
    ...routeModal.value,
    route: mergeRoutes(overlaid.map(o => appendTrack(o.p.route, o.net780 ?? o.p.eventTrack))),
    trackNote: trackNoteFor(tracks.size, overlaid.filter(o => o.net780 === null && o.p.eventTrack.length > 0).length),
    net780Missing,
  }
}

/**
 * 地図モーダルの「NET780 を取得 (未取得 N 運行)」(Refs #760 の 27)。オーナー:
 * 「relay と取れてない奴 一括ダウンロード機能も付けて」。
 *
 * いま開いている地図で NET780 が無かった運行 (`routeModal.net780Missing`) を
 * `POST /api/net780/archive` (→ relay の `/kintai-relay/net780-archive`、#760-26) に
 * **`NET780_ARCHIVE_BATCH_SIZE` 件ずつ直列**で投げ、relay が theearth から取って R2 に
 * 保存する。relay は 1 運行ずつ (同時 1、1 運行 約 5 秒) 処理するので、**1 回に載せる
 * 件数がそのまま「進捗が動かない時間」**になる — 上限の 20 件を投げると 12 運行で
 * 1 分以上 `0/12` のまま止まって見えた (オーナー 2026-08-23「進まないのかわからない」)。
 * 進捗 (`k/N` と押してからの経過秒) を見出し横に出し、終わったら結果 (`archived a /
 * already b / not_found c / error d`) を出して**同じ地図を開き直す** (`routeModalReopen`) —
 * 取れた運行の軌跡が NET780 に切り替わる。
 *
 * relay が時間切れで途中までしか処理しないこと (`truncated`) があるので、`results` に
 * 載らなかった運行は続けて投げる。**1 回の応答で 1 件も進まなければ止める** (無限ループ
 * 防止。relay が全件を error にした場合は `results` に載るので「進んだ」扱い — 再投入せず
 * 結果に error として数える)。
 *
 * モーダルを閉じた / 別の地図を開いたら (key が変わる) 進捗は出さず、開き直しもしない
 * (relay 側の処理は止まらない — 次に開けば R2 にあるぶんは `ready` になる)。
 */
const net780Archive = ref<{ key: string, running: boolean, text: string } | null>(null)

/**
 * 走行中の 1 行 (`NET780 取得中 4/12 (経過 21秒、1 運行 約 5 秒)`)。**経過秒は 1 秒ごとに
 * 動く** — バッチの途中 (最大 20 秒) は `k/N` が止まったままなので、動いている目印が
 * これしか無い。`done` は済んだバッチの `results.length` の和。
 */
function net780ArchiveProgressText(done: number, total: number, elapsedMs: number): string {
  return `NET780 取得中 ${done}/${total} (経過 ${Math.floor(elapsedMs / 1000)}秒、1 運行 約 5 秒)`
}

async function archiveRouteModalNet780() {
  const modal = routeModal.value
  const targets = modal?.net780Missing ?? []
  if (modal === null || targets.length === 0 || net780Archive.value?.running) return
  const key = modal.key
  const reopen = routeModalReopen
  const total = targets.length
  const all: Net780ArchiveResultItem[] = []
  let queue: string[] = [...targets]
  let stalled = false
  let failure: string | null = null
  const startedAt = Date.now()
  // 済んだ件数と経過秒を今の値で書き直す (1 秒ごと + バッチが返るたび)。
  const tick = () => {
    net780Archive.value = { key, running: true, text: net780ArchiveProgressText(all.length, total, Date.now() - startedAt) }
  }
  tick()
  // 終了・失敗のどちらでも必ず止める (finally)。
  const timer = setInterval(tick, 1000)
  try {
    while (queue.length > 0) {
      const batch = chunk(queue, NET780_ARCHIVE_BATCH_SIZE)[0] ?? []
      const res = await postNet780Archive(batch)
      all.push(...res.results)
      const rest = remainingNet780ArchiveTargets(queue, res.results)
      if (rest.length === queue.length) {
        stalled = true
        break
      }
      queue = rest
      tick()
    }
  }
  catch (e) {
    failure = e instanceof Error ? e.message : String(e)
  }
  finally {
    clearInterval(timer)
  }
  const parts = [`NET780 取得: ${formatNet780ArchiveSummary(summarizeNet780ArchiveResults(all))}`]
  if (stalled) parts.push(`進まないため中断 (残り ${queue.length} 運行)`)
  if (failure !== null) parts.push(`失敗 — ${failure} (残り ${queue.length} 運行)`)
  net780Archive.value = { key, running: false, text: parts.join(' / ') }
  // 同じ地図がまだ開いているときだけ開き直す (閉じた / 別のを開いたなら触らない)。
  if (routeModal.value?.key === key && reopen !== null) await reopen()
}

/** 見出し横に出す NET780 取得の進捗 / 結果 (いま開いている地図のぶんだけ)。 */
const net780ArchiveProgress = computed(() => {
  const a = net780Archive.value
  return a !== null && a.key === routeModal.value?.key ? a.text : null
})
/** いま開いている地図の NET780 取得が走っている (ボタンを押せなくする)。 */
const net780Archiving = computed(() => {
  const a = net780Archive.value
  return a !== null && a.running && a.key === routeModal.value?.key
})

/** 経路行の「地図」。タイトルは `取引先 積地 → 卸地 — 便 N 本 (運行 M 本)`。 */
function openRouteLegsMap(c: CustomerSummary, r: RouteSummary) {
  const operations = new Set(r.legRefs.map(ref => ref.unkoNo)).size
  const title = `${c.name} ${r.from} → ${r.to} — 便 ${r.legRefs.length} 本 (運行 ${operations} 本)`
  return openLegRefsMap(`route:${c.code}:${r.from}→${r.to}`, title, r.legRefs)
}

/** 取引先行の「地図」。その取引先の**全経路**を 1 枚に重ねる。 */
function openCustomerLegsMap(c: CustomerSummary) {
  const operations = new Set(c.legRefs.map(ref => ref.unkoNo)).size
  const title = `${c.name} — 便 ${c.legRefs.length} 本 (経路 ${c.routes.length} 本・運行 ${operations} 本)`
  return openLegRefsMap(`customer:${c.code}`, title, c.legRefs)
}
/** 運行行の開閉 (3 段目の便を出す)。**乗務員行の `openDrivers` と同じ流儀。** */
const openOperations = reactive<Record<string, boolean>>({})

/**
 * 取引先別 × 経路別 (Refs #760 の 15)。**月の全運行から出す** (「粗利を出せない運行だけ
 * 表示」の絞り込みは乗務員の表だけ) — 検算の右辺が粗利タブの粗利そのものでないと
 * 意味が無い。
 */
const customerSummary = computed(() => summarizeByCustomerRoute(result.value.operations))
/** 検算の左辺 = Σ取引先の粗利 (出せない取引先は 0)。 */
const customerGrossSum = computed(() => customerSummary.value.customers.reduce((sum, c) => sum + (c.grossMarginYen ?? 0), 0))
/** 検算が 1 円未満で合っているか。合わなければ amber で出す。 */
const customerCheckOk = computed(() => Math.abs(customerSummary.value.diffYen) < 1)
/** 売上の検算の左辺 = Σ取引先の売上 (便ぜんぶ。2 取引先の便は比で分けた後の和なので便の売上に戻る)。 */
const customerSalesSum = computed(() => customerSummary.value.customers.reduce((sum, c) => sum + c.salesYen, 0))
/** 売上の検算: Σ取引先の売上 + 便の無い運行の売上 = 粗利タブの売上 (運行ぜんぶの `totals.salesYen`)。 */
const customerSalesCheckOk = computed(() => Math.abs(customerSalesSum.value + customerSummary.value.noLegOperations.salesYen - totals.value.salesYen) < 1)
/** 取引先行の開閉 (経路の行を出す)。鍵は取引先C (突合なしは空文字)。 */
const openCustomers = reactive<Record<string, boolean>>({})

/**
 * 経路行の開閉 (**その経路の売上が出た運行**を出す、Refs #818)。
 * **取引先行の `openCustomers` と同じ流儀** (既定は畳んだ状態なので印刷には出ない)。
 */
const openRoutes = reactive<Record<string, boolean>>({})
/** 経路行の鍵 (`v-for` の `:key` と同じ)。 */
const routeKey = (c: CustomerSummary, r: RouteSummary) => `${c.code}|${r.from}|${r.to}`
/** 運行NO → 運行日。**表と同じ `result.operations`** から引く (取れない運行は鍵が無い)。 */
const runDates = computed(() => runDatesByUnkoNo(result.value.operations))
/** その経路の便が入っている運行 (運行日の昇順、`legRefs` を畳むだけ。数字には効かない)。 */
const routeOperations = (r: RouteSummary) => routeOperationRows(r.legRefs, runDates.value)

/** 売上の内訳の棒 (取引先別の表の下、Refs #760 の 17)。表と同じ `customerSummary` から出す。 */
const shareBars = computed(() => customerShareBars(customerSummary.value))

/** 棒の区分の色 (凡例と同じ)。Tailwind の既存クラスだけ (chart ライブラリは入れない)。 */
const SHARE_SEGMENT_CLASS: Record<ShareSegmentKey, string> = {
  allowance: 'bg-amber-400 dark:bg-amber-500',
  fuelHaul: 'bg-sky-500 dark:bg-sky-600',
  fuelDeadhead: 'bg-sky-300 dark:bg-sky-400',
  runCost: 'bg-violet-400 dark:bg-violet-500',
  margin: 'bg-emerald-500 dark:bg-emerald-600',
}

const shareSegmentLabel = (key: ShareSegmentKey) => SHARE_SEGMENT_LABELS.find(s => s.key === key)!.label

/** 棒の title 用 (小数 1 桁)。`pct` は比 (0〜1) を受けるので別に持つ。 */
const pct1 = (v: number) => `${Math.round(v * 10) / 10}%`

function downloadCsv() {
  const rows = visibleDrivers.value.flatMap(d => d.operations)
  const blob = new Blob([`﻿${marginCsvLines(rows).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `粗利_${shownYm.value}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/** 便ごとの CSV (Refs #760 の 13)。**運行の CSV とは別ボタン** — 列がまるで違う。 */
function downloadLegCsv() {
  const rows = visibleDrivers.value.flatMap(d => d.operations)
  const blob = new Blob([`﻿${marginLegCsvLines(rows).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `粗利_便_${shownYm.value}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/** 取引先 × 経路 の CSV (Refs #760 の 15)。 */
function downloadCustomerRouteCsv() {
  const blob = new Blob([`﻿${customerRouteCsvLines(customerSummary.value, runCostShareMode.value).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `粗利_取引先×経路_${shownYm.value}_配分${RUN_COST_SHARE_MODE_LABELS[runCostShareMode.value]}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="p-6">
    <h1 class="text-lg font-semibold mb-1">
      粗利 (売上 − 手当 − 経費)
    </h1>
    <p class="text-xs text-gray-500 mb-4">
      運行 1 本ごとに <b>売上 − 手当 − 燃料代 − 直課経費 − 固定費按分</b> を出します。
      売上は<b>一番星の運転日報明細</b>、手当は<b>料金・給与マスタ</b> (運行手当タブと同じ基準。
      暫定手当を足し、除外した便は落とし、<b>推定卸地の引き継ぎと強制突合も同じに当てます</b>)、
      経費は<b>一番星の経費明細</b>です。
      <b>燃料代は一番星から取らず、走行距離 ÷ 燃費 × 単価で出します</b> —
      給油日と運行日がずれるので、燃料費をそのまま乗せると給油した日の運行だけが赤くなるためです。
      <b>走行距離はデジタコの運転・積み・降し・休憩の行だけを足した値</b>です
      (速度オーバー・専用道などの重ね掛け行は足しません。運行一覧の総走行距離と一致します)。
      <b>固定費と、日・車輌が運行に一致しない経費は走行距離の比で按分</b>します
      (分母・分子とも表に出しているので検算できます)。
      <b>回送燃料 = 始業→積み・便間・降し→終業 の走行ぶんの燃料</b>で、
      <b>売上が立たない移動の経費</b>を按分として見せています
      (燃料代を売上走行ぶんと回送ぶんに割っただけなので、<b>粗利の額は変わりません</b>)。
      運行の行を開くと<b>便ごと</b>の内訳も出ます —
      <b>便の回送燃料 = その便へ向かう移動 (1 便目は始業から、2 便目以降は前の便の降しから)
      の燃料</b>で、<b>最後の便には帰庫ぶんも足します</b>
      (便の「収支」は売上 − 手当 − 燃料だけで、直課経費・固定費按分は運行の段に残るため
      <b>粗利ではありません</b>)。
      <b>固定費按分 = リース・保険・通信と、運行の無い日の修繕など直課できない経費を
      総走行距離で割ったもの</b>です (乗務員の行にカーソルを当てると中身が出ます)。
      <b>燃費が出せない車輌の運行は粗利も「-」</b>にします (0 で割った値を混ぜないため)。
      <b>その車輌・その月の経費を 1 件も引けなかった運行も「-」</b>です —
      経費 0 円として計算すると<b>売上そのままが粗利に見える</b>ので、理由を出して空けます。
    </p>
    <p class="text-xs text-gray-500 mb-4">
      いちばん下の<b>取引先別</b>は、<b>便の売上に当たった一番星の明細の取引先で便を束ねた</b>ものです
      (取引先の行を開くと<b>積地 → 卸地 の経路ごと</b>に分かれます)。
      <b>2 取引先に当たった便は売上の比で分けます。</b>
      <b>直課経費・固定費按分は運行の走行km (売上走行 + 回送) の比で便に配ります</b>
      (便の無い運行は配れないので「便の無い運行」として別に出します)。
      取引先別の粗利 + 便の無い運行の粗利 = 粗利タブの粗利 になるのを頭の 1 行で検算しています。
    </p>

    <!--
      **手当マスタの出どころ** (Refs #805)。粗利の「手当」はこのマスタから出ているので、
      運行手当タブと**両方**に出す — 片方だけだと粗利タブが初期値の金額を注記なしで
      出し続ける。**印刷にも残す** (margin-print-hide を付けない) — 紙で回った金額が
      どの版のものかは、紙の側にこそ要る。
    -->
    <p
      v-if="rateState"
      class="text-xs mb-4 px-3 py-2 rounded border"
      :class="{
        'text-gray-500 border-gray-200 dark:border-gray-700': rateState.status === 'r2' && !rateVersionUnsure,
        'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950': rateState.status === 'seed' || (rateState.status === 'r2' && rateVersionUnsure),
        'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 font-semibold': rateState.status === 'error',
      }"
    >
      {{ rateNotice }}
    </p>

    <div class="margin-print-controls flex flex-wrap gap-3 items-end mb-4">
      <label class="text-xs text-gray-500">月
        <input v-model="ym" type="month" class="block text-sm border rounded px-2 py-1 dark:bg-gray-900">
      </label>
      <label class="text-xs text-gray-500">車輌CD
        <input v-model="vehicle" placeholder="1109" class="block text-sm border rounded px-2 py-1 w-28 dark:bg-gray-900">
      </label>
      <button
        class="text-sm px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
        :disabled="status === 'loading'"
        @click="run"
      >
        {{ status === 'loading' ? '集計中...' : '集計' }}
      </button>
      <button
        v-if="result.operations.length > 0"
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white"
        @click="downloadCsv"
      >
        CSV出力
      </button>
      <button
        v-if="result.operations.length > 0"
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white"
        title="便 (積み→降し) ごとの売上・手当・燃料・収支の CSV"
        @click="downloadLegCsv"
      >
        便CSV
      </button>
      <button
        v-if="result.operations.length > 0"
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white"
        :title="`取引先 × 経路 (積地 → 卸地) ごとの便数・売上・手当・燃料・運行経費の配分・粗利の CSV (配分: ${RUN_COST_SHARE_MODE_LABELS[runCostShareMode]})`"
        @click="downloadCustomerRouteCsv"
      >
        取引先×経路 CSV
      </button>
      <NuxtLink
        to="/profit/allowance"
        class="text-sm px-4 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
        title="手当そのものの突合 (手当表PDF との比較・未確定の便・暫定手当の入力) は運行手当タブです"
      >
        運行手当タブ
      </NuxtLink>
    </div>

    <div class="margin-print-targets mb-4 text-xs">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-gray-500">対象乗務員</span>
        <DriverSearchSelect
          v-model="pendingDriver"
          :drivers="drivers"
          value-key="driver_cd"
          placeholder="乗務員を追加"
        />
        <span v-if="targets.length === 0" class="text-amber-600 dark:text-amber-400">
          未設定 — 全乗務員を集計します (時間がかかります)。売上も車番引きに落ちます
        </span>
        <button
          v-for="cd in targets"
          :key="cd"
          class="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:line-through"
          title="クリックで対象から外す (運行手当タブと共通の設定です)"
          @click="toggle(cd)"
        >
          {{ labelOf(cd) }} <span class="margin-print-hide">✕</span>
        </button>
      </div>
    </div>

    <p v-if="progress" class="text-xs text-gray-400 mb-3">
      {{ progress }}
    </p>
    <p v-if="restoredFromCache" class="text-xs text-sky-600 dark:text-sky-400 mb-3">
      前回の集計 (<b>{{ shownYm }}</b>{{ savedAt ? ` ${savedAtLabel(savedAt)} 保存` : '' }}) を
      <b>この端末のキャッシュ</b>から<b>そのまま表示</b>しています — <b>通信していない</b>ので、
      保存後に取り込み直しがあれば古いままです。最新にするには <b>集計</b> を押してください。
      <b>いつ変わったかを追える記録は R2 の版の方</b>です (この表示はその写しではなく、
      この端末だけに残っている前回の結果です)。
    </p>
    <p
      v-if="marginR2Note"
      class="text-xs mb-3"
      :class="marginR2Failed ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400'"
    >
      {{ marginR2Note }}
    </p>
    <!--
      R2 に残っている版の一覧 (Refs #833)。**保存の注記のすぐ隣**に置く — 「いま残した版」と
      「今まで残っている版」は同じ話で、離すと別々の機能に見える。**印刷には出さない**
      (紙に要るのはその月の数字であって、版の履歴ではない)。
      **何が変わったか (差分) はここには無い** — 版が何本あって、いつ増えたかまで。
    -->
    <section
      v-if="marginVersionsLoading || marginVersionsError !== '' || marginVersions.length > 0"
      class="margin-print-hide mb-3"
    >
      <h3 class="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">
        R2 に残っている版
        <span v-if="marginVersions.length > 0" class="font-normal text-gray-400">({{ marginVersions.length }} 本、新しい順)</span>
      </h3>
      <p v-if="marginVersionsError !== ''" class="text-xs text-amber-600 dark:text-amber-400">
        {{ marginVersionsError }}
      </p>
      <p v-else-if="marginVersionsLoading" class="text-xs text-gray-400">
        版の一覧を読み込み中...
      </p>
      <template v-else>
        <table class="text-xs">
          <thead class="text-gray-500">
            <tr class="border-b border-gray-200 dark:border-gray-800">
              <th class="text-left py-1 pr-3" title="保存した時刻 (JST)。保存の注記に出る版の名前と同じものです">版</th>
              <th class="text-right py-1 px-2">運行</th>
              <th class="text-right py-1 px-2">売上</th>
              <th class="text-right py-1 px-2">手当</th>
              <th class="text-right py-1 pl-2">粗利</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in marginVersions" :key="v.key" class="border-b border-gray-100 dark:border-gray-800/60">
              <td class="py-1 pr-3 font-mono">{{ v.label }}</td>
              <template v-if="v.totals">
                <td class="text-right py-1 px-2">{{ v.totals.operations }} 本</td>
                <td class="text-right py-1 px-2">{{ yen(v.totals.salesYen) }}</td>
                <td class="text-right py-1 px-2">{{ yen(v.totals.allowanceYen) }}</td>
                <td class="text-right py-1 pl-2">{{ yen(v.totals.marginYen) }}</td>
              </template>
              <!--
                金額が無い理由は 2 つある (上限より古いので**読まなかった** /
                **読めなかった**)。**同じ見た目にしない** — 同じだと、読む人には
                なぜその行だけ金額が無いのかが分からない。
              -->
              <td
                v-else
                colspan="4"
                class="text-right py-1 pl-2"
                :class="v.totalsState === 'unreadable' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400'"
                :title="MARGIN_VERSION_TOTALS_STATE_TITLES[v.totalsState]"
              >{{ MARGIN_VERSION_TOTALS_STATE_LABELS[v.totalsState] }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="marginVersionsNote" class="text-xs text-gray-400 mt-1">
          {{ marginVersionsNote }}
        </p>
        <!-- **読めなかったぶんは失敗と分かる色で。** 省いたぶんと同じ灰色にしない。 -->
        <p v-if="marginVersionsUnreadableNote" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
          {{ marginVersionsUnreadableNote }}
        </p>
      </template>
    </section>
    <!--
      **選んだ 2 版の差分** (Refs #834)。「いつ変わったのか追えるようにしたい」の後半で、
      **一覧のすぐ下**に置く (一覧で見つけた版をそのまま選ぶ流れなので、離すと別機能に見える)。
      **印刷には出さない** (紙に要るのはその月の数字であって、版の履歴ではない)。
      **運行 1 本ごとの粗利は出さない** — この画面は保存された値を引き算するだけで、粗利を
      計算し直さないため。**形式 2 の版は燃費の上書きと運行経費の配分を指紋として持つ**が、
      **形式 1 の版には無く、そちらは版から厳密に再現できない** (Refs #886。文言は
      `MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE`)。
    -->
    <section v-if="marginVersions.length > 0" class="margin-print-hide mb-3">
      <h3 class="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">版どうしの差分</h3>
      <!--
        **版が 2 本に足りないときに黙って空にしない** (本番 2026-07 は版が 1 本しかない)。
        何が足りないのか・どうすれば版が増えるのかまで言葉で出す。
      -->
      <p v-if="marginDiffNeedsMore !== ''" class="text-xs text-gray-500 dark:text-gray-400">
        {{ marginDiffNeedsMore }}
      </p>
      <template v-else>
        <div class="flex flex-wrap items-center gap-2 text-xs mb-1">
          <label class="flex items-center gap-1">
            <span class="text-gray-500">旧</span>
            <select
              v-model="marginDiffBeforeLabel"
              class="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-1.5 py-0.5 font-mono"
            >
              <option v-for="v in marginVersions" :key="`b-${v.key}`" :value="v.label">{{ v.label }}</option>
            </select>
          </label>
          <span class="text-gray-400">→</span>
          <label class="flex items-center gap-1">
            <span class="text-gray-500">新</span>
            <select
              v-model="marginDiffAfterLabel"
              class="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-1.5 py-0.5 font-mono"
            >
              <option v-for="v in marginVersions" :key="`a-${v.key}`" :value="v.label">{{ v.label }}</option>
            </select>
          </label>
          <button
            type="button"
            class="rounded border border-gray-300 dark:border-gray-700 px-2 py-0.5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            :disabled="marginDiffLoading"
            @click="runMarginDiff()"
          >差分を出す</button>
        </div>
        <!-- **同じ版どうしを選べてしまう。**「差が 0」を「変わっていない」と誤読させない。 -->
        <p
          v-if="marginDiffBeforeLabel === marginDiffAfterLabel"
          class="text-xs text-gray-500 dark:text-gray-400 mb-1"
        >
          旧と新に同じ版を選んでいます — 差はすべて 0 になります (数字が変わっていないのではなく、同じ版どうしです)。
        </p>
        <p v-if="marginDiffError !== ''" class="text-xs text-amber-600 dark:text-amber-400">
          {{ marginDiffError }}
        </p>
        <p v-else-if="marginDiffLoading" class="text-xs text-gray-400">
          選んだ版の本文を読み込み中...
        </p>
        <p v-else-if="!marginDiff" class="text-xs text-gray-400">
          2 版を選んで <b>差分を出す</b> を押してください。
        </p>
        <div v-else class="text-xs">
          <!-- **形式が違う版は比べない。** 黙って旧形式を無視した差分を出すと数字が動いたように見える。 -->
          <p v-if="marginDiff.blockedNote !== ''" class="text-amber-600 dark:text-amber-400">
            {{ marginDiff.blockedNote }}
          </p>
          <template v-else>
            <!-- 月全体。**保存された実測値そのもの**なので、粗利もここでは出してよい。 -->
            <table class="mb-1">
              <thead class="text-gray-500">
                <tr class="border-b border-gray-200 dark:border-gray-800">
                  <th class="text-left py-1 pr-3">月全体</th>
                  <th class="text-right py-1 px-2 font-mono font-normal">{{ marginDiff.before.label }}</th>
                  <th class="text-right py-1 px-2 font-mono font-normal">{{ marginDiff.after.label }}</th>
                  <th class="text-right py-1 pl-2">差</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in marginDiff.totals" :key="row.key" class="border-b border-gray-100 dark:border-gray-800/60">
                  <td class="py-1 pr-3">{{ row.label }}</td>
                  <td class="text-right py-1 px-2">{{ marginDiffValueText(row, row.before) }}</td>
                  <td class="text-right py-1 px-2">{{ marginDiffValueText(row, row.after) }}</td>
                  <td
                    class="text-right py-1 pl-2"
                    :class="row.delta === 0 ? 'text-gray-400' : 'font-semibold'"
                  >{{ marginDiffDeltaText(row) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="marginDiff.codeVersionNote !== ''" class="text-gray-500 dark:text-gray-400 mt-1">
              {{ marginDiff.codeVersionNote }}
            </p>
            <!-- **端末の設定でも版は増える。** 失敗と分かる色で断る (根本の解は別 PR)。 -->
            <p v-if="marginDiff.overrideCaveat !== ''" class="text-amber-600 dark:text-amber-400 mt-1">
              {{ marginDiff.overrideCaveat }}
            </p>
            <p v-if="marginDiff.uncoveredNote !== ''" class="text-gray-500 dark:text-gray-400 mt-1">
              {{ marginDiff.uncoveredNote }}
            </p>
            <p v-if="marginDiff.crossMonthNote !== ''" class="text-gray-500 dark:text-gray-400 mt-1">
              {{ marginDiff.crossMonthNote }}
            </p>
            <p class="text-gray-500 dark:text-gray-400 mt-1">{{ MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE }}</p>

            <h4 class="font-semibold text-gray-600 dark:text-gray-300 mt-2 mb-1">
              運行
              <span class="font-normal text-gray-400">
                (追加 {{ marginDiff.added.length }} / 削除 {{ marginDiff.removed.length }}
                / 変更 {{ marginDiff.changed.length }} / 変わっていない {{ marginDiff.unchangedOperations }})
              </span>
            </h4>
            <p
              v-if="marginDiff.added.length === 0 && marginDiff.removed.length === 0 && marginDiff.changed.length === 0"
              class="text-gray-500 dark:text-gray-400"
            >
              運行の追加・削除・変更はありません ({{ marginDiff.unchangedOperations }} 本とも同じでした)。
            </p>
            <template v-else>
              <table class="w-full">
                <thead class="text-gray-500">
                  <tr class="border-b border-gray-200 dark:border-gray-800">
                    <th class="text-left py-1 pr-3">運行NO</th>
                    <th class="text-left py-1 px-2">日付</th>
                    <th class="text-left py-1 px-2">乗務員</th>
                    <th class="text-left py-1 pl-2">動いたもの</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="op in marginDiff.added"
                    :key="`add-${op.unkoNo}`"
                    class="border-b border-gray-100 dark:border-gray-800/60"
                  >
                    <td class="py-1 pr-3 font-mono">{{ op.unkoNo }}</td>
                    <td class="py-1 px-2">{{ op.date }}</td>
                    <td class="py-1 px-2">{{ op.driverName }}</td>
                    <td class="py-1 pl-2">
                      <span class="text-emerald-600 dark:text-emerald-400 font-semibold mr-1">追加</span>
                      売上 {{ yen(op.salesYen) }} / 手当 {{ yen(op.allowanceYen) }} / {{ km(op.totalKm) }} / 便 {{ op.legCount }}
                    </td>
                  </tr>
                  <tr
                    v-for="op in marginDiff.removed"
                    :key="`del-${op.unkoNo}`"
                    class="border-b border-gray-100 dark:border-gray-800/60"
                  >
                    <td class="py-1 pr-3 font-mono">{{ op.unkoNo }}</td>
                    <td class="py-1 px-2">{{ op.date }}</td>
                    <td class="py-1 px-2">{{ op.driverName }}</td>
                    <td class="py-1 pl-2">
                      <span class="text-rose-600 dark:text-rose-400 font-semibold mr-1">削除</span>
                      売上 {{ yen(op.salesYen) }} / 手当 {{ yen(op.allowanceYen) }} / {{ km(op.totalKm) }} / 便 {{ op.legCount }}
                    </td>
                  </tr>
                  <!--
                    変更された運行の行と、その下の便の行 (Refs #834) は**同じ `v-for` の中**に
                    置く。便の行を兄弟の `<tr>` にすると `op` が範囲外になる (#818 で踏んだ)。
                  -->
                  <template v-for="op in marginDiff.changed" :key="`chg-${op.unkoNo}`">
                    <tr
                      class="border-b border-gray-100 dark:border-gray-800/60 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/40"
                      title="クリックでこの運行の便の差分を開閉"
                      @click="openDiffOps[op.unkoNo] = !openDiffOps[op.unkoNo]"
                    >
                      <td class="py-1 pr-3 font-mono">
                        <span class="text-gray-400 mr-1">{{ openDiffOps[op.unkoNo] ? '▾' : '▸' }}</span>{{ op.unkoNo }}
                      </td>
                      <td class="py-1 px-2">{{ op.date }}</td>
                      <td class="py-1 px-2">{{ op.driverName }}</td>
                      <td class="py-1 pl-2">
                        <span v-for="row in op.rows" :key="row.key" class="mr-2">
                          {{ row.label }} {{ marginDiffValueText(row, row.before) }} → {{ marginDiffValueText(row, row.after) }}
                          <b>({{ marginDiffDeltaText(row) }})</b>
                        </span>
                        <!-- 運行の合計は同じでも便の間で動いていることがある。**黙って畳まない。** -->
                        <span v-if="op.rows.length === 0" class="text-gray-500 dark:text-gray-400">
                          運行の合計は同じで、便の中身が動いています
                        </span>
                      </td>
                    </tr>
                    <tr v-if="openDiffOps[op.unkoNo]" class="border-b border-gray-100 dark:border-gray-800/60">
                      <td colspan="4" class="py-1 pl-8">
                        <!-- **便数が違えば便ごとの数値は出さない** (seq は積みの順番でしかない)。 -->
                        <p v-if="marginDiffLegCountNote(op.legs) !== ''" class="text-amber-600 dark:text-amber-400">
                          {{ marginDiffLegCountNote(op.legs) }}
                        </p>
                        <p v-else-if="op.legs.legs.length === 0" class="text-gray-500 dark:text-gray-400">
                          便ごとの数値は変わっていません (便数 {{ op.legs.afterCount }})。
                        </p>
                        <template v-else>
                        <p
                          v-for="leg in op.legs.legs"
                          :key="`${op.unkoNo}-${leg.seq}`"
                          class="text-gray-600 dark:text-gray-300"
                        >
                          <span class="text-gray-400 mr-1">便 {{ leg.seq }}</span>
                          <template v-if="leg.routeChanged">
                            <span class="text-amber-600 dark:text-amber-400">{{ leg.beforeLabel }} → {{ leg.afterLabel }} (別の便になっています)</span>
                          </template>
                          <template v-else>{{ leg.afterLabel }}</template>
                          <span v-for="row in leg.rows" :key="row.key" class="ml-2">
                            {{ row.label }} {{ marginDiffValueText(row, row.before) }} → {{ marginDiffValueText(row, row.after) }}
                            <b>({{ marginDiffDeltaText(row) }})</b>
                          </span>
                        </p>
                        </template>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </template>
          </template>
        </div>
      </template>
    </section>
    <p v-if="cacheNote" class="text-xs text-amber-600 dark:text-amber-400 mb-3">
      {{ cacheNote }}
    </p>
    <p v-if="status === 'error'" class="text-sm text-red-600 dark:text-red-400 mb-4">
      {{ errorMessage }}
    </p>
    <p v-if="salesError" class="text-sm text-red-600 dark:text-red-400 mb-4">
      売上 (一番星) が引けませんでした — {{ salesError }} (売上 0 として扱っているので<b>粗利は正しくありません</b>)
    </p>
    <p v-if="costError" class="text-sm text-red-600 dark:text-red-400 mb-4">
      経費 (一番星) が引けませんでした — {{ costError }}
      <b>経費 0 円の粗利は出しません</b> — 該当する車輌の運行は粗利を <b>-</b> にしています
      (売上そのままが粗利に見えるのを避けるため)。
    </p>

    <template v-if="status === 'ready'">
      <p v-if="result.operations.length === 0" class="text-xs text-gray-400">
        {{ shownYm }} に該当する運行が見つかりませんでした
      </p>
      <template v-else>
        <!-- 月の合計 -->
        <div class="margin-print-block mb-2 flex flex-wrap gap-x-6 gap-y-2 text-sm items-center">
          <span class="font-semibold">{{ shownYm }}</span>
          <span>運行 <b>{{ totals.operations }}</b> 本</span>
          <span>走行 <b>{{ km(totals.totalKm) }}</b></span>
          <span>売上 <b>{{ yen(totals.salesYen) }}</b></span>
          <span>手当 <b>{{ yen(totals.allowanceYen) }}</b></span>
          <label class="margin-print-hide text-xs text-gray-500 flex items-center gap-1.5 cursor-pointer select-none">
            <input v-model="onlyIssues" type="checkbox" class="cursor-pointer">
            粗利を出せない運行だけ表示
          </label>
        </div>

        <!-- **粗利の内訳。** ここに出す数だけで引き算がぴったり合うようにしてある
             (上の「売上」は粗利を出せなかった運行のぶんも含むので使わない)。 -->
        <div class="margin-print-block mb-4 p-3 rounded-lg border border-gray-200 dark:border-gray-800">
          <p class="text-xs text-gray-500 mb-2">
            粗利の内訳 — <b>粗利を出せた {{ totals.marginOperations }} 本ぶん</b>だけの数です。
            <b>この行だけで引き算が合います</b> (上の「売上」は粗利を出せなかった運行のぶんも
            含むので、こちらの売上とは一致しません)。
          </p>
          <div class="flex flex-wrap gap-x-3 gap-y-2 text-sm items-center">
            <span>売上 <b>{{ yen(totals.marginSalesYen) }}</b></span>
            <span class="text-gray-400">−</span>
            <span>手当 <b>{{ yen(totals.marginAllowanceYen) }}</b><span v-if="totals.marginSalesYen > 0" class="text-xs text-gray-400"> ({{ yenPct(totals.marginAllowanceYen, totals.marginSalesYen) }})</span></span>
            <span class="text-gray-400">−</span>
            <span :title="FUEL_HAUL_TITLE">燃料代(売上走行) <b>{{ yen(totals.fuelHaulYen) }}</b><span v-if="totals.marginSalesYen > 0" class="text-xs text-gray-400"> ({{ yenPct(totals.fuelHaulYen, totals.marginSalesYen) }})</span></span>
            <span class="text-gray-400">−</span>
            <span :title="FUEL_DEADHEAD_TITLE">回送燃料(按分) <b>{{ yen(totals.fuelDeadheadYen) }}</b><span v-if="totals.marginSalesYen > 0" class="text-xs text-gray-400"> ({{ yenPct(totals.fuelDeadheadYen, totals.marginSalesYen) }})</span></span>
            <!-- **分けられなかった燃料があるときだけ出す。** 0 を常に出すと
                 「分けられている」と読めてしまい、引き算も合わなくなる。 -->
            <template v-if="totals.fuelUnsplitYen > 0">
              <span class="text-gray-400">−</span>
              <span class="text-amber-600 dark:text-amber-400" :title="FUEL_UNSPLIT_TITLE">
                燃料代(未分割) <b>{{ yen(totals.fuelUnsplitYen) }}</b>
              </span>
            </template>
            <span class="text-gray-400">−</span>
            <span>直課経費 <b>{{ yen(totals.directCostYen) }}</b><span v-if="totals.marginSalesYen > 0" class="text-xs text-gray-400"> ({{ yenPct(totals.directCostYen, totals.marginSalesYen) }})</span></span>
            <span class="text-gray-400">−</span>
            <span :title="FIXED_POOL_TITLE">固定費按分 <b>{{ yen(totals.allocatedCostYen) }}</b><span v-if="totals.marginSalesYen > 0" class="text-xs text-gray-400"> ({{ yenPct(totals.allocatedCostYen, totals.marginSalesYen) }})</span></span>
            <span class="text-gray-400">=</span>
            <span>
              粗利
              <b :class="totals.marginYen < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'">
                {{ yen(totals.marginYen) }}
              </b>
              <span class="text-gray-400">({{ pct(monthMarginRate) }})</span>
            </span>
          </div>
          <div v-if="totals.noMarginOperations > 0" class="text-xs text-amber-600 dark:text-amber-400 mt-2">
            <p>
              <b>粗利を出せなかった運行が {{ totals.noMarginOperations }} 本</b>
              (売上 {{ yen(totals.noMarginSalesYen) }})。上の内訳には入っていません。
            </p>
            <ul class="mt-1 ml-4 list-disc">
              <li v-for="g in noMarginGroups" :key="g.reason">
                {{ g.reason }} — <b>{{ g.operations }}</b> 本 (売上 {{ yen(g.salesYen) }})
              </li>
            </ul>
          </div>
          <!-- **粗利の対象外になっている便。** 運行が無いので粗利は出せないが、
               **落ちていることは言う** — 運行手当タブと突き合わせた人が
               「売上が 15% 少ない」理由を読めないのが本当の欠陥だった (Refs #760 の 4)。 -->
          <div v-if="uncovered" class="text-xs text-amber-600 dark:text-amber-400 mt-2">
            <p>
              <b>一番星から起こした便が {{ uncovered.trips }} 便</b>
              (売上 {{ yen(uncovered.salesYen) }} ・ 手当 {{ yen(uncovered.allowanceYen) }})。上の内訳には入っていません。
            </p>
            <p class="mt-1 text-gray-500">
              デジタコに運行が無い日の便です (非搭載の車番 0001、alc に運行が無い 0040 等)。
              <b>運行が無いので走行距離が出せず、燃料代も按分も計算できないため粗利の対象外</b>です。
              この売上・手当は上の合計に入っていません。<b>運行手当タブでは入っています</b> —
              2 つのタブで売上が違うのはこのぶんです。
            </p>
          </div>
          <!-- **月の切り方**。運行手当タブ (便の積み日) と粗利タブ (運行の開始日) で
               わざと違うので、何が入って何が入っていないかを数で書く (Refs #760 の 16)。 -->
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-2" :title="MONTH_CUT_TITLE">
            <b>月の切り方: 運行日 (運行手当タブは便の積み日)</b>。
            <template v-if="crossMonth && (crossMonth.nextMonthLegs > 0 || crossMonth.prevMonthOpsLegsInMonth > 0)">
              翌月日付の便 {{ crossMonth.nextMonthLegs }} 本 (手当 {{ yen(crossMonth.nextMonthAllowanceYen) }}) を含み、
              前月運行の当月便 {{ crossMonth.prevMonthOpsLegsInMonth }} 本 (手当 {{ yen(crossMonth.prevMonthOpsAllowanceYen) }}) を含みません。
            </template>
            <template v-else-if="crossMonth">月またぎなし。</template>
          </p>
          <p
            v-if="result.unallocatedCostYen > 0"
            class="text-xs text-amber-600 dark:text-amber-400 mt-2"
            title="その車輌の運行が 1 本も無い / 走行距離が 0 で按分できなかった経費。上の粗利から抜けています"
          >
            どの運行にも配れなかった経費が <b>{{ yen(result.unallocatedCostYen) }}</b> あります
            (その車輌の運行が 1 本も無い / 走行距離が 0)。上の粗利から抜けています。
          </p>
        </div>

        <!-- 人件費の別枠 -->
        <div class="margin-print-block mb-4 p-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30">
          <p class="text-xs font-medium mb-2">
            人件費 — <b>どちらも上の粗利には入れていません</b>
          </p>
          <div class="flex flex-wrap gap-x-8 gap-y-1 text-sm">
            <span>一番星の人件費 (08 給与 + 11 賞与・調整金) <b>{{ yen(result.ichibanLaborYen) }}</b></span>
            <span>運行手当 <b>{{ yen(totals.allowanceYen) }}</b></span>
            <span class="text-gray-500">差 <b>{{ yen(result.ichibanLaborYen - totals.allowanceYen) }}</b></span>
          </div>
          <p class="text-xs text-gray-500 mt-2">
            この 2 つは<b>同じものを 2 通りに数えたもの</b>で、両方を引くと二重になります。
            上の粗利は<b>運行手当のほうだけ</b>を引いています。
            <b>どちらが正しいかは人が判断してください</b> — 一番星の人件費には運行手当以外
            (基本給・社会保険・賞与) も入っているので、額はふつう一致しません。
            <span v-if="result.unallocatedLaborYen > 0" class="text-amber-600 dark:text-amber-400">
              うち {{ yen(result.unallocatedLaborYen) }} は運行に配れていません
              (その車輌の運行が無い / 走行距離が 0)。
            </span>
          </p>
          <p class="text-xs text-gray-500 mt-1">
            参考 — 一番星の燃料系 (01 燃料ｵｲﾙ代 + 15 アドブルー) の実績は
            <b>{{ yen(result.ichibanFuelYen) }}</b>。上の燃料代
            <b>{{ yen(totals.fuelYen) }}</b> は<b>走行距離から出した額</b>で、これとは別物です。
          </p>
        </div>

        <!-- 燃費・単価 -->
        <div class="margin-print-keep mb-4">
          <p class="text-xs font-medium mb-1">
            燃費・単価 (車輌ごと)
          </p>
          <p class="text-xs text-gray-500 mb-2">
            <b>既定値は一番星の燃料実績</b> (単価 = Σ税抜金額 ÷ Σ給油量、燃費 = Σ走行距離 ÷ Σ給油量)。
            <b>給油日と運行日がずれる</b>ので単月では燃費が振れます。<b>確定値は下の欄に入れてください</b>
            (このブラウザに保存され、実績より優先します。空にすると実績に戻ります)。
            <b>軽油引取税は単価に入っていません。</b>
            ただし <b>2026-07 の実データでは全社 1,427 件すべて ¥0</b> で、税抜でも税込でも
            単価は 122.95 円/L と 1 円も変わりませんでした — <b>この帳簿では別立てで計上されていない</b>
            ので、下の「軽油引取税」列が <b>¥0 なのは異常ではありません</b>
            (0 でない値が出てきたら、そのぶんは単価に足されていないという意味です)。
          </p>
          <div class="margin-print-tablewrap border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="text-left px-3 py-2 font-medium text-gray-500">車輌C</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">月の走行km</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">実績 単価(円/L)</th>
                  <th
                    class="text-right px-3 py-2 font-medium text-gray-500"
                    title="参考表示。単価には入れていません。この帳簿では別立て計上が無く 0 が正常です"
                  >軽油引取税(円/L)</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">実績 燃費(km/L)</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">上書き 単価</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">上書き 燃費</th>
                  <th class="text-left px-3 py-2 font-medium text-gray-500">使う値</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="v in vehicleRates" :key="v.code" class="border-t border-gray-100 dark:border-gray-800">
                  <td class="px-3 py-1.5">{{ v.code }}</td>
                  <td class="px-3 py-1.5 text-right">{{ km(v.totalKm) }}</td>
                  <td class="px-3 py-1.5 text-right">{{ num(v.derived.yenPerLiter) }}</td>
                  <td class="px-3 py-1.5 text-right text-gray-400">
                    {{ num(v.derived.dieselTaxPerLiter) }}
                    <span v-if="v.derived.dieselTaxPerLiter === 0" class="text-gray-400">(別立て計上なし)</span>
                  </td>
                  <td class="px-3 py-1.5 text-right">{{ num(v.derived.kmPerLiter, 2) }}</td>
                  <td class="px-3 py-1.5 text-right">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      class="w-24 text-right border rounded px-1 py-0.5 dark:bg-gray-900"
                      :value="v.override?.yenPerLiter ?? ''"
                      placeholder="実績"
                      @input="onFuelRateInput(v.code, 'yenPerLiter', ($event.target as HTMLInputElement).value)"
                    >
                  </td>
                  <td class="px-3 py-1.5 text-right">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      class="w-24 text-right border rounded px-1 py-0.5 dark:bg-gray-900"
                      :value="v.override?.kmPerLiter ?? ''"
                      placeholder="実績"
                      @input="onFuelRateInput(v.code, 'kmPerLiter', ($event.target as HTMLInputElement).value)"
                    >
                  </td>
                  <td
                    class="px-3 py-1.5"
                    :class="v.effective.kmPerLiter === null || v.effective.yenPerLiter === null
                      ? 'text-amber-600 dark:text-amber-400'
                      : ''"
                  >
                    <template v-if="v.effective.kmPerLiter === null || v.effective.yenPerLiter === null">
                      燃費が出せない — {{ v.derived.yenPerLiter === null
                        ? 'この月・この車輌に燃料 (01) の給油実績がありません'
                        : '走行距離が 0 です' }}。この車輌の運行は燃料代も粗利も「-」になります
                    </template>
                    <template v-else>
                      {{ num(v.effective.yenPerLiter) }} 円/L ・ {{ num(v.effective.kmPerLiter, 2) }} km/L
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 乗務員 → 運行 -->
        <p v-if="visibleDrivers.length === 0" class="text-xs text-gray-400">
          粗利を出せない運行はありません
        </p>
        <div v-else class="margin-print-tablewrap border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th class="text-left px-3 py-2 font-medium text-gray-500">乗務員 / 運行</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">走行km</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">売上</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">手当</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500" :title="FUEL_HAUL_TITLE">
                  燃料代 (売上走行)
                </th>
                <th class="text-right px-3 py-2 font-medium text-gray-500" :title="FUEL_DEADHEAD_TITLE">
                  回送燃料 (按分)
                </th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">直課経費</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500" :title="FIXED_POOL_TITLE">
                  固定費按分
                </th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">粗利</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">粗利率</th>
                <th class="text-left px-3 py-2 font-medium text-gray-500">按分 (分子/分母)</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">人件費(参考)</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="d in visibleDrivers" :key="d.driverName">
                <tr
                  class="border-t border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
                  @click="openDrivers[d.driverName] = !openDrivers[d.driverName]"
                >
                  <td class="px-3 py-2 font-medium">
                    {{ openDrivers[d.driverName] ? '▾' : '▸' }} {{ d.driverName }}
                    <span class="text-gray-400">({{ d.totals.operations }}運行)</span>
                  </td>
                  <td class="px-3 py-2 text-right">
                    {{ km(d.totals.totalKm) }}
                    <span class="block text-xs text-gray-400 dark:text-gray-500" :title="KM_BREAKDOWN_TITLE">
                      積前 {{ kmInt(d.totals.preLoadKm) }}<template v-if="d.totals.totalKm > 0"> ({{ kmPct(d.totals.preLoadKm, d.totals.totalKm) }})</template> / 売上 {{ kmInt(d.totals.haulKm) }}<template v-if="d.totals.totalKm > 0"> ({{ kmPct(d.totals.haulKm, d.totals.totalKm) }})</template>
                      / 便間 {{ kmInt(d.totals.betweenKm) }}<template v-if="d.totals.totalKm > 0"> ({{ kmPct(d.totals.betweenKm, d.totals.totalKm) }})</template> / 降後 {{ kmInt(d.totals.postUnloadKm) }}<template v-if="d.totals.totalKm > 0"> ({{ kmPct(d.totals.postUnloadKm, d.totals.totalKm) }})</template>
                      <span
                        v-if="d.totals.otherKm > 0"
                        class="text-amber-600 dark:text-amber-400"
                        :title="OTHER_KM_TITLE"
                      >/ 他 {{ kmInt(d.totals.otherKm) }}<template v-if="d.totals.totalKm > 0"> ({{ kmPct(d.totals.otherKm, d.totals.totalKm) }})</template></span>
                    </span>
                  </td>
                  <td class="px-3 py-2 text-right">{{ yen(d.totals.salesYen) }}</td>
                  <td class="px-3 py-2 text-right">
                    {{ yen(d.totals.allowanceYen) }}
                    <span v-if="d.totals.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(d.totals.allowanceYen, d.totals.salesYen) }})</span>
                  </td>
                  <td class="px-3 py-2 text-right" :title="FUEL_HAUL_TITLE">
                    {{ yen(d.totals.fuelHaulYen) }}
                    <span v-if="d.totals.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(d.totals.fuelHaulYen, d.totals.salesYen) }})</span>
                    <!-- **分けられなかったぶんは黙って落とさない。** 2 列の和が
                         燃料代に足りない理由がここにしか無い。 -->
                    <span
                      v-if="d.totals.fuelUnsplitYen > 0"
                      class="block text-xs text-amber-600 dark:text-amber-400"
                      :title="FUEL_UNSPLIT_TITLE"
                    >未分割 {{ yen(d.totals.fuelUnsplitYen) }}</span>
                  </td>
                  <td class="px-3 py-2 text-right" :title="FUEL_DEADHEAD_TITLE">
                    {{ yen(d.totals.fuelDeadheadYen) }}
                    <span v-if="d.totals.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(d.totals.fuelDeadheadYen, d.totals.salesYen) }})</span>
                  </td>
                  <td class="px-3 py-2 text-right" :title="driverDirectTitle(d)">
                    {{ yen(d.totals.directCostYen) }}
                    <span v-if="d.totals.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(d.totals.directCostYen, d.totals.salesYen) }})</span>
                  </td>
                  <td class="px-3 py-2 text-right" :title="fixedPoolTitle(d.operations)">
                    {{ yen(d.totals.allocatedCostYen) }}
                    <span v-if="d.totals.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(d.totals.allocatedCostYen, d.totals.salesYen) }})</span>
                  </td>
                  <td
                    class="px-3 py-2 text-right font-medium"
                    :class="d.totals.marginYen < 0 ? 'text-red-600 dark:text-red-400' : ''"
                  >
                    {{ yen(d.totals.marginYen) }}
                  </td>
                  <td class="px-3 py-2 text-right">
                    {{ pct(marginRate({
                      salesYen: d.totals.marginSalesYen,
                      marginYen: d.totals.marginYen,
                    })) }}
                  </td>
                  <td class="px-3 py-2 text-amber-600 dark:text-amber-400">
                    <span v-if="d.totals.noMarginOperations > 0">
                      粗利を出せず {{ d.totals.noMarginOperations }} 本
                    </span>
                  </td>
                  <td class="px-3 py-2 text-right text-gray-400">{{ yen(d.totals.laborYen) }}</td>
                </tr>
                <template v-for="m in (openDrivers[d.driverName] ? d.operations : [])" :key="m.unkoNo">
                  <tr
                    class="border-t border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/40"
                    :title="m.legs.length > 0 ? 'クリックで便の内訳を開閉' : ''"
                    @click="openOperations[m.unkoNo] = !openOperations[m.unkoNo]"
                  >
                    <td class="px-3 py-1.5 pl-8">
                      <span v-if="m.legs.length > 0" class="text-gray-400 mr-1">{{ openOperations[m.unkoNo] ? '▾' : '▸' }}</span>
                      <NuxtLink
                        :to="`/operations/${m.unkoNo}`"
                        target="_blank"
                        class="text-blue-500 hover:text-blue-700 hover:underline"
                        @click.stop
                      >
                        {{ m.date }}
                      </NuxtLink>
                      <span class="text-gray-400 ml-2">車輌{{ m.vehicleCode }}</span>
                      <button
                        type="button"
                        class="ml-2 rounded border border-gray-300 dark:border-gray-700 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                        title="この運行の経路を地図で見る"
                        @click.stop="openRouteMap(m)"
                      >
                        地図
                      </button>
                    </td>
                    <td
                      class="px-3 py-1.5 text-right"
                      :class="kmMismatch(m) ? 'text-amber-600 dark:text-amber-400' : ''"
                      :title="kmMismatch(m) ? kmMismatchTitle(m) : ''"
                    >
                      {{ km(m.totalKm) }}
                      <span v-if="kmMismatch(m)" class="block text-xs text-amber-600 dark:text-amber-400">
                        一覧 {{ num(m.listedTotalKm) }}km とずれ
                      </span>
                      <span class="block text-xs text-gray-400 dark:text-gray-500" :title="KM_BREAKDOWN_TITLE">
                        積前 {{ kmInt(m.kmBreakdown.preLoadKm) }}<template v-if="m.totalKm > 0"> ({{ kmPct(m.kmBreakdown.preLoadKm, m.totalKm) }})</template> / 売上 {{ kmInt(m.kmBreakdown.haulKm) }}<template v-if="m.totalKm > 0"> ({{ kmPct(m.kmBreakdown.haulKm, m.totalKm) }})</template>
                        / 便間 {{ kmInt(m.kmBreakdown.betweenKm) }}<template v-if="m.totalKm > 0"> ({{ kmPct(m.kmBreakdown.betweenKm, m.totalKm) }})</template> / 降後 {{ kmInt(m.kmBreakdown.postUnloadKm) }}<template v-if="m.totalKm > 0"> ({{ kmPct(m.kmBreakdown.postUnloadKm, m.totalKm) }})</template>
                        <span
                          v-if="m.kmBreakdown.otherKm > 0"
                          class="text-amber-600 dark:text-amber-400"
                          :title="OTHER_KM_TITLE"
                        >/ 他 {{ kmInt(m.kmBreakdown.otherKm) }}<template v-if="m.totalKm > 0"> ({{ kmPct(m.kmBreakdown.otherKm, m.totalKm) }})</template></span>
                      </span>
                    </td>
                    <td class="px-3 py-1.5 text-right">{{ yen(m.salesYen) }}</td>
                    <td class="px-3 py-1.5 text-right">
                      {{ yen(m.allowanceYen) }}
                      <span v-if="m.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(m.allowanceYen, m.salesYen) }})</span>
                    </td>
                    <td
                      class="px-3 py-1.5 text-right"
                      :class="m.fuelHaulYen === null ? 'text-amber-600 dark:text-amber-400' : ''"
                      :title="fuelCellTitle(m)"
                    >
                      {{ yen(m.fuelHaulYen) }}
                      <span v-if="m.fuelHaulYen !== null && m.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(m.fuelHaulYen, m.salesYen) }})</span>
                    </td>
                    <td
                      class="px-3 py-1.5 text-right"
                      :class="m.fuelDeadheadYen === null ? 'text-amber-600 dark:text-amber-400' : ''"
                      :title="fuelCellTitle(m)"
                    >
                      {{ yen(m.fuelDeadheadYen) }}
                      <span v-if="m.fuelDeadheadYen !== null && m.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(m.fuelDeadheadYen, m.salesYen) }})</span>
                    </td>
                    <td class="px-3 py-1.5 text-right" :title="directCostTitle(m)">
                      {{ yen(m.directCostYen) }}
                      <span v-if="m.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(m.directCostYen, m.salesYen) }})</span>
                    </td>
                    <td class="px-3 py-1.5 text-right" :title="fixedPoolTitle([m])">
                      {{ yen(m.allocatedCostYen) }}
                      <span v-if="m.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(m.allocatedCostYen, m.salesYen) }})</span>
                    </td>
                    <td
                      class="px-3 py-1.5 text-right font-medium"
                      :class="m.marginYen !== null && m.marginYen < 0 ? 'text-red-600 dark:text-red-400' : ''"
                      :title="noMarginReason(m)"
                    >
                      {{ yen(m.marginYen) }}
                    </td>
                    <td class="px-3 py-1.5 text-right">{{ pct(marginRate(m)) }}</td>
                    <td class="px-3 py-1.5 text-gray-500" :title="'固定費按分 = 車輌の按分対象の経費 × (この運行の走行km ÷ 月・この車輌の走行km)'">
                      {{ num(m.totalKm) }} / {{ num(m.vehicleTotalKm) }} km
                      <span v-if="m.vehicleTotalKm > 0" class="text-gray-400">
                        = {{ pct(m.totalKm / m.vehicleTotalKm) }}
                      </span>
                      <span v-else class="text-amber-600 dark:text-amber-400">— 分母 0 なので按分していません</span>
                      <span v-if="m.marginYen === null" class="block text-amber-600 dark:text-amber-400">
                        粗利 - : {{ noMarginReason(m) }}
                      </span>
                    </td>
                    <td class="px-3 py-1.5 text-right text-gray-400">{{ yen(m.laborYen) }}</td>
                  </tr>
                  <!-- 便 (3 段目)。運行の行をクリックで開閉。Refs #760 の 13 -->
                  <tr
                    v-for="l in (openOperations[m.unkoNo] ? m.legs : [])"
                    :key="`${m.unkoNo}#${l.seq}`"
                    class="border-t border-gray-50 dark:border-gray-800/60 text-gray-500 dark:text-gray-400"
                  >
                    <td class="px-3 py-1 pl-14">
                      便{{ l.seq }} {{ l.originCity }}→{{ l.destCity }}
                    </td>
                    <td class="px-3 py-1 text-right">
                      売上 {{ kmInt(l.haulKm) }} / 回送 {{ kmInt(l.deadheadKm) }}
                    </td>
                    <td class="px-3 py-1 text-right">{{ yen(l.salesYen) }}</td>
                    <td class="px-3 py-1 text-right">{{ yen(l.allowanceYen) }}</td>
                    <td class="px-3 py-1 text-right" :title="FUEL_HAUL_TITLE">{{ yen(l.fuelHaulYen) }}</td>
                    <td class="px-3 py-1 text-right" :title="FUEL_DEADHEAD_TITLE">{{ yen(l.fuelDeadheadYen) }}</td>
                    <td class="px-3 py-1 text-right">—</td>
                    <td class="px-3 py-1 text-right">—</td>
                    <td
                      class="px-3 py-1 text-right"
                      :title="'売上 − 手当 − 燃料。直課・固定費按分は運行の段'"
                    >
                      {{ yen(l.marginYen) }}
                    </td>
                    <td class="px-3 py-1" />
                    <td class="px-3 py-1" />
                    <td class="px-3 py-1" />
                  </tr>
                </template>
              </template>
            </tbody>
          </table>
        </div>

        <!-- 乗務員ごとの 100% 積み上げ棒 (Refs #760 の 39)。**乗務員/運行 の表の直後**。
             区分・色・凡例・先頭に「合計」を置く流儀は「売上の内訳 (取引先ごと)」と同じで、
             素材は `margin-driver-share.ts` (pure) が作る。印刷は `margin-print-keep` で
             **凡例ごと 1 枚に収める**だけにして、**紙は改めない** — 乗務員/運行 の表と
             同じ紙に載るのが自然で、入りきらなければブラウザが次の紙へ送る。 -->
        <div v-if="driverBars.bars.length > 0" class="margin-print-keep mt-3">
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 mb-2">
            <span class="font-medium">売上の内訳 (乗務員ごと、売上 = 100%)</span>
            <span v-for="lg in SHARE_SEGMENT_LABELS" :key="lg.key" class="inline-flex items-center gap-1">
              <span class="inline-block w-3 h-3 rounded-sm" :class="SHARE_SEGMENT_CLASS[lg.key]" />{{ lg.label }}
            </span>
          </div>
          <div class="space-y-1">
            <div
              v-for="bar in driverBars.bars"
              :key="bar.key"
              class="margin-print-bar flex items-center gap-2 text-xs"
              :class="bar.key === 'total' ? 'font-medium' : ''"
            >
              <span class="w-56 shrink-0 truncate" :title="`${bar.label} (運行 ${bar.operations})`">
                {{ bar.label }} <span class="text-gray-400">(運行 {{ bar.operations }})</span>
                <span
                  v-if="bar.noMarginOperations > 0"
                  class="text-amber-600 dark:text-amber-400"
                  :title="`粗利を出せない運行 ${bar.noMarginOperations} 本 — その売上ぶんはどの色にも塗っていません`"
                >*</span>
                <span
                  v-if="bar.fuelUnsplitYen > 0"
                  class="text-amber-600 dark:text-amber-400"
                  :title="`${FUEL_UNSPLIT_TITLE} (${yen(bar.fuelUnsplitYen)})。2 つの燃料区分のどちらにも入っていないので、そのぶん棒が 100% に届きません`"
                >†</span>
              </span>
              <div class="flex-1 flex h-4 rounded overflow-hidden bg-gray-100 dark:bg-gray-800">
                <div
                  v-for="s in bar.segments"
                  :key="s.key"
                  class="h-full text-[10px] leading-4 text-white text-center overflow-hidden whitespace-nowrap"
                  :class="SHARE_SEGMENT_CLASS[s.key]"
                  :style="{ width: `${s.pct}%` }"
                  :title="`${shareSegmentLabel(s.key)} ${yen(s.yen)} (${pct1(s.pct)})`"
                >
                  <template v-if="s.pct >= 7">{{ Math.round(s.pct) }}%</template>
                </div>
              </div>
              <span v-if="bar.overflowPct > 0" class="shrink-0 text-red-600 dark:text-red-400" title="費用 (手当 + 燃料 + 運行経費の配分) が売上を超えた分">赤字 −{{ pct1(bar.overflowPct) }}</span>
            </div>
          </div>
          <p v-if="driverBars.skipped > 0" class="text-xs text-gray-400 mt-1">
            売上 0 の乗務員 {{ driverBars.skipped }} 人は棒にしていません
          </p>
        </div>

        <!-- 乗務員別の賃金構成 (基本給 ＋ 残業 ＋ 旅費、Refs #760 の 40)。
             **乗務員の段の直後**に置く — 母数が乗務員ごとの手当なので、上の表と
             続けて読めるのが自然。印刷は `margin-print-block` (割らない) だけにして
             **紙は改めない** (改ページを足すかはオーナーの指定待ち)。
             **粗利の数字には 1 円も効かない。** -->
        <div class="margin-print-block mt-6 p-3 rounded-lg border border-gray-200 dark:border-gray-800">
          <div class="margin-print-head flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
            <p class="text-xs font-medium">賃金構成の試算 (基本給 ＋ 残業 ＋ 旅費)</p>
            <span class="text-xs text-gray-500">
              いまは運行手当がそのまま基本給として支給され、上に全員一律 {{ yen(wageMix.flatOvertimeYen) }} の残業代が乗っているだけ。
              これを三段に組み直すとどうなるかの試算で、<b>粗利の数字には 1 円も効きません</b>
            </span>
          </div>

          <!-- 操作 (紙には出さない) -->
          <div class="margin-print-controls flex flex-wrap items-center gap-x-4 gap-y-2 text-xs mb-2">
            <span class="flex items-center gap-1">
              <span class="text-gray-500">計算方式:</span>
              <UButton
                v-for="m in WAGE_MIX_METHODS"
                :key="m"
                size="xs"
                :variant="wageMix.method === m ? 'solid' : 'outline'"
                :label="WAGE_MIX_METHOD_LABELS[m]"
                @click="setWageMixMethod(m)"
              />
            </span>
            <label v-if="wageMix.method === 'hours'" class="flex items-center gap-1">
              <span class="text-gray-500">単価 (円/時):</span>
              <input
                type="number"
                step="25"
                min="0"
                class="w-24 text-right border rounded px-1 py-0.5 dark:bg-gray-900"
                :value="wageMix.hourlyRateYen"
                @input="onWageMixNumber('hourlyRateYen', ($event.target as HTMLInputElement).value)"
              >
              <span class="text-gray-400">下限 ¥{{ MIN_HOURLY_WAGE_YEN.toLocaleString() }}</span>
            </label>
            <label v-else class="flex items-center gap-1">
              <span class="text-gray-500">日額 (円/日):</span>
              <input
                type="number"
                step="100"
                min="0"
                class="w-24 text-right border rounded px-1 py-0.5 dark:bg-gray-900"
                :value="wageMix.dailyRateYen"
                @input="onWageMixNumber('dailyRateYen', ($event.target as HTMLInputElement).value)"
              >
              <span class="text-gray-400">下限 ¥{{ MIN_DAILY_WAGE_YEN.toLocaleString() }} (時給 ¥{{ MIN_HOURLY_WAGE_YEN.toLocaleString() }} 相当)</span>
            </label>
            <span class="flex items-center gap-1">
              <span class="text-gray-500">旅費率:</span>
              <UButton
                v-for="r in TRAVEL_RATE_PRESETS"
                :key="r"
                size="xs"
                :variant="wageMix.travelRate === r ? 'solid' : 'outline'"
                :label="travelRateLabel(r)"
                @click="setTravelRate(r)"
              />
            </span>
            <!-- 一律残業代は**実支給を引けなかった乗務員の推計にだけ**効く。
                 全員ぶん引けていれば出さない (使われない入力を置かない) が、
                 **推計が 1 人でも居るときは出す** — 推計の仮定を画面から動かせなく
                 すると後退するため。 -->
            <label
              v-if="wageMixTotals.estimatedDrivers.length > 0"
              class="flex items-center gap-1"
              title="実支給を引けなかった乗務員の推計にだけ効きます (実支給が引けている乗務員には 1 円も効きません)"
            >
              <span class="text-gray-500">推計の一律残業代:</span>
              <input
                type="number"
                step="1000"
                min="0"
                class="w-24 text-right border rounded px-1 py-0.5 dark:bg-gray-900"
                :value="wageMix.flatOvertimeYen"
                @input="onWageMixNumber('flatOvertimeYen', ($event.target as HTMLInputElement).value)"
              >
            </label>
            <UButton
              size="xs" variant="outline" icon="i-lucide-refresh-cw" label="拘束時間・実支給を再読込"
              :loading="loadingRestraint || loadingActualPay"
              @click="reloadWageMixSources"
            />
          </div>

          <!-- 単価が最低賃金を下回っていれば言う。**クランプはしない** -->
          <p v-if="wageMixWarning" class="text-xs text-red-600 dark:text-red-400 mb-1">⚠ {{ wageMixWarning }}</p>
          <p v-if="restraintError" class="text-xs text-red-600 dark:text-red-400 mb-1">⚠ {{ restraintError }}</p>
          <p v-if="actualPayError" class="text-xs text-red-600 dark:text-red-400 mb-1">⚠ {{ actualPayError }}</p>
          <p v-if="loadingRestraint" class="text-xs text-gray-500 mb-1">拘束時間サマリを読み込んでいます…</p>
          <p v-if="loadingActualPay" class="text-xs text-gray-500 mb-1">実支給 (一番星の経費明細 08 給与) を読み込んでいます…</p>

          <!-- 母数を必ず名乗る。どの母数か書いていない数字がいちばん危ない -->
          <p class="text-xs text-gray-500 mb-1">
            <b>旅費の母数</b>: 粗利タブの手当 {{ yen(allowanceBaseTotals.operationYen) }}
            − 翌月日付の便 {{ yen(allowanceBaseTotals.nextMonthYen) }}
            <template v-if="allowanceBaseTotals.complete">
              ＋ 粗利の対象外の便 {{ yen(allowanceBaseTotals.uncoveredYen) }}
              ＝ <b>{{ yen(allowanceBaseTotals.baseYen) }}</b> (運行手当タブ = 実際に支給した基本給と同じ範囲)
            </template>
            <template v-else>
              ＝ <b>{{ yen(allowanceBaseTotals.baseYen) }}</b>
              <span class="text-amber-600 dark:text-amber-400">
                — <b>当月運行の便のみ</b>です。粗利の対象外になっている便が乗務員別に取れていないので、
                実際に支給した額より小さく出ます (「集計」を押すと埋まります)
              </span>
            </template>
          </p>
          <p v-if="restraintFetchedAt" class="text-xs text-gray-400 mb-1">
            拘束時間サマリ (アーカイブ) の取得時刻: {{ restraintFetchedAt }}。
            GCP の日別サマリは行が欠けるので<b>使っていません</b>
          </p>

          <div class="margin-print-tablewrap overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="text-gray-500">
                <tr class="border-b border-gray-200 dark:border-gray-800">
                  <th class="text-left py-1 pr-2">乗務員</th>
                  <th class="text-right py-1 px-2">稼働日</th>
                  <th class="text-right py-1 px-2">法定内</th>
                  <th class="text-right py-1 px-2">割増係数</th>
                  <th class="text-right py-1 px-2">基本給</th>
                  <th class="text-right py-1 px-2">残業</th>
                  <th class="text-right py-1 px-2">旅費</th>
                  <th class="text-right py-1 px-2">計</th>
                  <th class="text-right py-1 px-2" title="一番星の経費明細 経費種別 08 給与(人件費) を乗務員CDで畳んだ実支給">現状 (実支給)</th>
                  <th class="text-right py-1 pl-2">差</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in wageMixRows" :key="`wm-${row.driverCd}-${row.driverName}`" class="border-b border-gray-100 dark:border-gray-900">
                  <td class="py-1 pr-2">
                    {{ row.driverName }}
                    <span v-if="row.driverCd" class="text-gray-400">{{ row.driverCd }}</span>
                    <span
                      v-if="row.missingReason"
                      class="text-amber-600 dark:text-amber-400"
                      :title="row.missingReason"
                    >⚠</span>
                  </td>
                  <td class="text-right py-1 px-2">{{ row.workDays ?? '-' }}</td>
                  <td class="text-right py-1 px-2">{{ hours(row.statutoryHours) }}</td>
                  <td class="text-right py-1 px-2">{{ hours(row.premiumHours) }}</td>
                  <!-- 基本給・残業は**ホバー**でその乗務員の数字を当てはめた式を出す (Refs #816)。
                       行は増やさない — 印刷の紙割りが動くため。式の一般形は表の下の注記に残す -->
                  <td
                    class="text-right py-1 px-2"
                    :class="{ 'cursor-help': row.baseWageYen !== null }"
                    :title="wageMixBaseFormula(row, wageMix) ?? undefined"
                  >{{ yen(row.baseWageYen) }}</td>
                  <td
                    class="text-right py-1 px-2"
                    :class="{ 'cursor-help': row.overtimeYen !== null }"
                    :title="wageMixOvertimeFormula(row, wageMix) ?? undefined"
                  >{{ yen(row.overtimeYen) }}</td>
                  <td class="text-right py-1 px-2">{{ yen(row.travelYen) }}</td>
                  <td class="text-right py-1 px-2 font-medium">{{ yen(row.totalYen) }}</td>
                  <td class="text-right py-1 px-2" :class="row.currentEstimated ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500'">
                    {{ yen(row.currentYen) }}<span v-if="row.currentReason" :title="row.currentReason">*</span>
                  </td>
                  <td
                    class="text-right py-1 pl-2"
                    :class="row.diffYen !== null && row.diffYen < 0 ? 'text-red-600 dark:text-red-400' : ''"
                  >{{ signedYen(row.diffYen) }}</td>
                </tr>
              </tbody>
              <tfoot class="font-medium">
                <tr class="border-t border-gray-300 dark:border-gray-700">
                  <td class="py-1 pr-2">計 ({{ wageMixTotals.computed }} 人)</td>
                  <td class="text-right py-1 px-2">{{ wageMixTotals.workDays }}</td>
                  <td class="text-right py-1 px-2">{{ hours(wageMixTotals.statutoryHours) }}</td>
                  <td class="text-right py-1 px-2">{{ hours(wageMixTotals.premiumHours) }}</td>
                  <td class="text-right py-1 px-2">{{ yen(wageMixTotals.baseWageYen) }}</td>
                  <td class="text-right py-1 px-2">{{ yen(wageMixTotals.overtimeYen) }}</td>
                  <td class="text-right py-1 px-2">{{ yen(wageMixTotals.travelYen) }}</td>
                  <td class="text-right py-1 px-2">{{ yen(wageMixTotals.totalYen) }}</td>
                  <td class="text-right py-1 px-2" :class="wageMixTotals.estimatedDrivers.length > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500'">{{ yen(wageMixTotals.currentYen) }}</td>
                  <td
                    class="text-right py-1 pl-2"
                    :class="wageMixTotals.diffYen < 0 ? 'text-red-600 dark:text-red-400' : ''"
                  >{{ signedYen(wageMixTotals.diffYen) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p v-if="wageMixTotals.missingDrivers.length > 0" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
            ⚠ <b>拘束時間が取れていない乗務員 {{ wageMixTotals.missingDrivers.length }} 人</b>
            ({{ wageMixTotals.missingDrivers.join('・') }}) は<b>金額を出していません</b> — 0 分として計算すると
            「働いていないから安い」という嘘の数字になるためです。この人たちの旅費 {{ yen(wageMixTotals.missingTravelYen) }} も合計に入っていません
          </p>
          <p v-if="wageMixTotals.estimatedDrivers.length > 0" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
            ⚠ <b>実支給を引けなかった乗務員 {{ wageMixTotals.estimatedDrivers.length }} 人</b>
            ({{ wageMixTotals.estimatedDrivers.join('・') }}) の現状は<b>推計 (旅費の母数 ＋ 一律残業代 {{ yen(wageMix.flatOvertimeYen) }})</b> です
            (<code>*</code> を付けた行)。<b>0 円には倒していません</b> — 0 を現状として出すと「試算 − 現状」の差が丸ごと嘘になるためです。
            <template v-if="wageMixTotals.estimatedComputed > 0">
              <b>合計の「現状」{{ yen(wageMixTotals.currentYen) }} は混在です</b> —
              実支給 {{ wageMixTotals.computed - wageMixTotals.estimatedComputed }} 人 {{ yen(wageMixTotals.currentYen - wageMixTotals.estimatedCurrentYen) }}
              ＋ 推計 {{ wageMixTotals.estimatedComputed }} 人 {{ yen(wageMixTotals.estimatedCurrentYen) }}
            </template>
          </p>
          <p class="text-xs text-gray-400 mt-1">
            基本給 = <template v-if="wageMix.method === 'hours'">法定内時間 (実働 − 時間外) × 単価</template><template v-else>日額 × 稼働日数</template>。
            残業 = (時間外 × 1.25 ＋ 深夜 × 0.25) × <template v-if="wageMix.method === 'hours'">単価</template><template v-else>日額 ÷ 8</template>。
            旅費 = 運行手当テーブルの {{ travelRateLabel(wageMix.travelRate) }}。
            <b>現状 (実支給)</b> = 一番星の経費明細の<b>経費種別 08 給与(人件費)</b> を乗務員CDで畳んだ額
            (車輌をまたぐ乗務員は行が分かれるので合算しています)。<b>過払いも調整せずそのまま</b>出します。
            <b>総額を現状に合わせることは要件にしていません</b> — 残業に応じて総額が動くのが判例上の要請のためです (最高裁 2020-03-30)。
            旅費を走行距離に比例させる案は採れません (手当 ¥4,500 で走行 0km の便が実在するため)。
          </p>
        </div>

        <!-- 取引先別 × 経路別 (Refs #760 の 15)。乗務員の表の下。 -->
        <div class="margin-print-page mt-6">
          <div class="margin-print-head flex flex-wrap items-center gap-2 mb-1">
            <p class="text-xs font-medium">
              取引先別 (便を一番星の取引先で束ねたもの)
            </p>
            <!-- 運行経費の配分の比 (Refs #760 の 22)。運行・乗務員の段には効かない。 -->
            <label class="margin-print-hide text-xs text-gray-500 flex items-center gap-1" :title="RUN_COST_SHARE_MODE_TITLE">
              運行経費の配分:
              <select
                class="border border-gray-300 dark:border-gray-700 rounded px-1 py-0.5 bg-white dark:bg-gray-900"
                :value="runCostShareMode"
                @change="onRunCostShareModeChange(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="(label, key) in RUN_COST_SHARE_MODE_LABELS" :key="key" :value="key">{{ label }}</option>
              </select>
            </label>
            <span
              v-if="result.runCostShareFallbackOperations > 0"
              class="text-xs text-amber-600 dark:text-amber-400"
              title="便の拘束時間 (売上時間 + 回送時間) が読めない運行は、走行km比で配っています (0 円は配りません)"
            >
              拘束時間が取れない運行 {{ result.runCostShareFallbackOperations }} 本は走行km比で配分
            </span>
          </div>
          <p
            class="text-xs mb-2"
            :class="customerCheckOk ? 'text-gray-500' : 'text-amber-600 dark:text-amber-400'"
            title="取引先別の粗利 (Σ便の粗利) + 便の無い運行の粗利 = 粗利タブの粗利。便の走行km が取れていない運行があると運行の燃料と Σ便の燃料がずれるぶん差が出ます"
          >
            検算: 取引先別の粗利 <b>{{ yen(customerGrossSum) }}</b>
            + 便の無い運行 <b>{{ yen(customerSummary.noLegOperations.marginYen) }}</b>
            <template v-if="customerSummary.unsplitLegs.legs > 0">
              (+ 粗利が出せない便 {{ customerSummary.unsplitLegs.legs }} 便 ・ 売上 {{ yen(customerSummary.unsplitLegs.salesYen) }})
            </template>
            = 粗利タブの粗利 <b>{{ yen(customerSummary.totalMarginYen) }}</b>
            <span v-if="customerCheckOk">— 合っています</span>
            <span v-else>— <b>{{ yen(customerSummary.diffYen) }} 合いません</b> (便の走行km が取れていない運行がある可能性)</span>
          </p>
          <p
            class="text-xs mb-2"
            :class="customerSalesCheckOk ? 'text-gray-500' : 'text-amber-600 dark:text-amber-400'"
            title="便の売上は運行の売上と同じ突合結果から出ているので、全運行の売上に必ず戻る"
          >
            売上の検算: 取引先別の売上 <b>{{ yen(customerSalesSum) }}</b>
            + 便の無い運行 <b>{{ yen(customerSummary.noLegOperations.salesYen) }}</b>
            = 粗利タブの売上 <b>{{ yen(totals.salesYen) }}</b>
            <span v-if="customerSalesCheckOk">— 合っています</span>
            <span v-else>— <b>{{ yen(customerSalesSum + customerSummary.noLegOperations.salesYen - totals.salesYen) }} 合いません</b></span>
          </p>
          <p v-if="customerSummary.noLegOperations.operations > 0" class="text-xs text-gray-500 mb-2">
            便の無い運行 <b>{{ customerSummary.noLegOperations.operations }}</b> 本
            (売上 {{ yen(customerSummary.noLegOperations.salesYen) }} ・ 手当 {{ yen(customerSummary.noLegOperations.allowanceYen) }}
            ・ 燃料 {{ yen(customerSummary.noLegOperations.fuelYen) }} ・ 直課 {{ yen(customerSummary.noLegOperations.directCostYen) }}
            ・ 固定費按分 {{ yen(customerSummary.noLegOperations.allocatedCostYen) }} ・ 粗利 {{ yen(customerSummary.noLegOperations.marginYen) }})
            は取引先に結べないので下の表には入っていません。
          </p>
          <p v-if="customerSummary.customers.length === 0" class="text-xs text-gray-400">
            便のある運行がありません
          </p>
          <div v-else class="margin-print-tablewrap border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="text-left px-3 py-2 font-medium text-gray-500">取引先 / 積地 → 卸地</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">売上</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">手当</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500" :title="FUEL_HAUL_TITLE">燃料代 (売上走行)</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500" :title="FUEL_DEADHEAD_TITLE">回送燃料</th>
                  <th
                    class="text-right px-3 py-2 font-medium text-gray-500"
                    :title="`運行の直課経費 + 固定費按分 を、運行の便に配った額。いまの配分: ${RUN_COST_SHARE_MODE_LABELS[runCostShareMode]}\n${RUN_COST_SHARE_MODE_TITLE}`"
                  >運行経費の配分 ({{ RUN_COST_SHARE_MODE_LABELS[runCostShareMode] }})</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500" title="売上 − 手当 − 燃料 − 運行経費の配分">粗利</th>
                  <th
                    class="text-right px-3 py-2 font-medium text-gray-500"
                    title="粗利 ÷ 売上。55% 以上は緑、30% 未満は赤"
                  >粗利率</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500" title="売上走行km ÷ 便数">平均 売上走行km</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500" title="回送km ÷ 便数">平均 回送km</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500" title="売上 ÷ 売上走行km">売上/売上走行km</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="c in customerSummary.customers" :key="c.code">
                  <tr
                    class="border-t border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
                    title="クリックで経路 (積地 → 卸地) の内訳を開閉"
                    @click="openCustomers[c.code] = !openCustomers[c.code]"
                  >
                    <td class="px-3 py-2 font-medium">
                      {{ openCustomers[c.code] ? '▾' : '▸' }} {{ c.name }}
                      <span class="text-gray-400">(便 {{ c.legs }}<template v-if="c.code">, {{ c.code }}</template>)</span>
                      <span v-if="c.unsplitLegs > 0" class="text-amber-600 dark:text-amber-400 ml-1">粗利が出せない便 {{ c.unsplitLegs }}</span>
                      <button
                        type="button"
                        class="ml-2 rounded border border-gray-300 dark:border-gray-700 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                        title="この取引先の便を全部重ねて地図で見る"
                        @click.stop="openCustomerLegsMap(c)"
                      >
                        地図
                      </button>
                    </td>
                    <td class="px-3 py-2 text-right">{{ yen(c.salesYen) }}</td>
                    <td class="px-3 py-2 text-right">
                      {{ yen(c.allowanceYen) }}
                      <span v-if="c.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(c.allowanceYen, c.salesYen) }})</span>
                    </td>
                    <td class="px-3 py-2 text-right" :title="FUEL_HAUL_TITLE">
                      {{ yen(c.fuelHaulYen) }}
                      <span v-if="c.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(c.fuelHaulYen, c.salesYen) }})</span>
                    </td>
                    <td class="px-3 py-2 text-right" :title="FUEL_DEADHEAD_TITLE">
                      {{ yen(c.fuelDeadheadYen) }}
                      <span v-if="c.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(c.fuelDeadheadYen, c.salesYen) }})</span>
                    </td>
                    <td class="px-3 py-2 text-right">
                      {{ yen(c.runCostShareYen) }}
                      <span v-if="c.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(c.runCostShareYen, c.salesYen) }})</span>
                    </td>
                    <td
                      class="px-3 py-2 text-right font-medium"
                      :class="c.grossMarginYen !== null && c.grossMarginYen < 0 ? 'text-red-600 dark:text-red-400' : ''"
                    >
                      {{ yen(c.grossMarginYen) }}
                    </td>
                    <td class="px-3 py-2 text-right" :class="marginRateClass(c.salesYen, c.grossMarginYen)">{{ pct(marginRate({ salesYen: c.salesYen, marginYen: c.grossMarginYen })) }}</td>
                    <td class="px-3 py-2 text-right">{{ kmInt(c.haulKm / c.legs) }}</td>
                    <td class="px-3 py-2 text-right">{{ kmInt(c.deadheadKm / c.legs) }}</td>
                    <td class="px-3 py-2 text-right">{{ yen(salesPerHaulKm(c.salesYen, c.haulKm)) }}</td>
                  </tr>
                  <!--
                    経路の行と、その下の運行の行 (Refs #818) は**同じ `v-for` の中**に
                    置く。運行の行を兄弟の `<tr>` にすると `r` が範囲外になる。
                  -->
                  <template v-for="r in (openCustomers[c.code] ? c.routes : [])" :key="`${c.code}|${r.from}|${r.to}`">
                  <tr
                    class="border-t border-gray-50 dark:border-gray-800/60 text-gray-600 dark:text-gray-300 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/40"
                    title="クリックでこの経路の売上が出た運行を開閉"
                    @click="openRoutes[routeKey(c, r)] = !openRoutes[routeKey(c, r)]"
                  >
                    <td class="px-3 py-1.5 pl-8">
                      <span class="text-gray-400 mr-1">{{ openRoutes[routeKey(c, r)] ? '▾' : '▸' }}</span>
                      {{ r.from }} → {{ r.to }}
                      <span class="text-gray-400">(便 {{ r.legs }})</span>
                      <span v-if="r.unsplitLegs > 0" class="text-amber-600 dark:text-amber-400 ml-1">粗利が出せない便 {{ r.unsplitLegs }}</span>
                      <button
                        type="button"
                        class="ml-2 rounded border border-gray-300 dark:border-gray-700 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                        title="この経路の便を全部重ねて地図で見る"
                        @click.stop="openRouteLegsMap(c, r)"
                      >
                        地図
                      </button>
                    </td>
                    <td class="px-3 py-1.5 text-right">{{ yen(r.salesYen) }}</td>
                    <td class="px-3 py-1.5 text-right">
                      {{ yen(r.allowanceYen) }}
                      <span v-if="r.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(r.allowanceYen, r.salesYen) }})</span>
                    </td>
                    <td class="px-3 py-1.5 text-right" :title="FUEL_HAUL_TITLE">
                      {{ yen(r.fuelHaulYen) }}
                      <span v-if="r.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(r.fuelHaulYen, r.salesYen) }})</span>
                    </td>
                    <td class="px-3 py-1.5 text-right" :title="FUEL_DEADHEAD_TITLE">
                      {{ yen(r.fuelDeadheadYen) }}
                      <span v-if="r.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(r.fuelDeadheadYen, r.salesYen) }})</span>
                    </td>
                    <td class="px-3 py-1.5 text-right">
                      {{ yen(r.runCostShareYen) }}
                      <span v-if="r.salesYen > 0" class="block text-xs text-gray-400 dark:text-gray-500">({{ yenPct(r.runCostShareYen, r.salesYen) }})</span>
                    </td>
                    <td
                      class="px-3 py-1.5 text-right font-medium"
                      :class="r.grossMarginYen !== null && r.grossMarginYen < 0 ? 'text-red-600 dark:text-red-400' : ''"
                    >
                      {{ yen(r.grossMarginYen) }}
                    </td>
                    <td class="px-3 py-1.5 text-right" :class="marginRateClass(r.salesYen, r.grossMarginYen)">{{ pct(marginRate({ salesYen: r.salesYen, marginYen: r.grossMarginYen })) }}</td>
                    <td class="px-3 py-1.5 text-right">{{ kmInt(r.haulKm / r.legs) }}</td>
                    <td class="px-3 py-1.5 text-right">{{ kmInt(r.deadheadKm / r.legs) }}</td>
                    <td class="px-3 py-1.5 text-right">{{ yen(salesPerHaulKm(r.salesYen, r.haulKm)) }}</td>
                  </tr>
                  <!--
                    経路の行 → その売上が出た運行 (Refs #818)。**運行日の昇順**に並べる
                    (「実運行を流れで見たい」)。畳む・並べる・文字を作るのは
                    `margin-route-operations.ts` (pure)。数字は 1 つも出さない。
                  -->
                  <tr
                    v-for="op in (openRoutes[routeKey(c, r)] ? routeOperations(r) : [])"
                    :key="`${c.code}|${r.from}|${r.to}|${op.unkoNo}`"
                    class="border-t border-gray-50 dark:border-gray-800/40 text-xs text-gray-500 dark:text-gray-400"
                  >
                    <td class="px-3 py-1 pl-14" colspan="11">
                      <span :class="op.date === null ? 'text-amber-600 dark:text-amber-400' : ''">{{ op.dateLabel }}</span>
                      <NuxtLink
                        :to="`/operations/${op.unkoNo}`"
                        target="_blank"
                        class="ml-2 text-blue-500 hover:text-blue-700 hover:underline"
                        title="この運行の詳細を別のタブで開く"
                      >
                        運行NO {{ op.unkoNo }}
                      </NuxtLink>
                      <span class="ml-2 text-gray-400">{{ op.seqLabel }}</span>
                    </td>
                  </tr>
                  </template>
                </template>
              </tbody>
            </table>
          </div>
          <div v-if="shareBars.bars.length > 0" class="margin-print-page margin-print-keep mt-3">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 mb-2">
              <span class="font-medium">売上の内訳 (取引先ごと、売上 = 100%)</span>
              <span v-for="lg in SHARE_SEGMENT_LABELS" :key="lg.key" class="inline-flex items-center gap-1">
                <span class="inline-block w-3 h-3 rounded-sm" :class="SHARE_SEGMENT_CLASS[lg.key]" />{{ lg.label }}
              </span>
            </div>
            <div class="space-y-1">
              <template v-for="bar in shareBars.bars" :key="bar.key">
                <div class="margin-print-bar flex items-center gap-2 text-xs" :class="bar.key === 'total' ? 'font-medium' : ''">
                  <span class="w-56 shrink-0 truncate" :title="`${bar.label} (便 ${bar.legs})`">
                    {{ bar.label }} <span class="text-gray-400">(便 {{ bar.legs }})</span>
                    <span v-if="bar.unsplitLegs > 0" class="text-amber-600 dark:text-amber-400" :title="`粗利が出せない便 ${bar.unsplitLegs}`">*</span>
                  </span>
                  <div class="flex-1 flex h-4 rounded overflow-hidden bg-gray-100 dark:bg-gray-800">
                    <div
                      v-for="s in bar.segments"
                      :key="s.key"
                      class="h-full text-[10px] leading-4 text-white text-center overflow-hidden whitespace-nowrap"
                      :class="SHARE_SEGMENT_CLASS[s.key]"
                      :style="{ width: `${s.pct}%` }"
                      :title="`${shareSegmentLabel(s.key)} ${yen(s.yen)} (${pct1(s.pct)})`"
                    >
                      <template v-if="s.pct >= 7">{{ Math.round(s.pct) }}%</template>
                    </div>
                  </div>
                  <span v-if="bar.overflowPct > 0" class="shrink-0 text-red-600 dark:text-red-400" title="費用 (手当 + 燃料 + 運行経費の配分) が売上を超えた分">赤字 −{{ pct1(bar.overflowPct) }}</span>
                </div>
                <template v-if="bar.routes && openCustomers[bar.key]">
                  <div
                    v-for="r in bar.routes"
                    :key="r.key"
                    class="margin-print-bar flex items-center gap-2 text-xs pl-6 text-gray-600 dark:text-gray-300"
                  >
                    <span class="w-56 shrink-0 truncate" :title="`${r.label} (便 ${r.legs})`">
                      {{ r.label }} <span class="text-gray-400">(便 {{ r.legs }})</span>
                      <span v-if="r.unsplitLegs > 0" class="text-amber-600 dark:text-amber-400" :title="`粗利が出せない便 ${r.unsplitLegs}`">*</span>
                    </span>
                    <div class="flex-1 flex h-4 rounded overflow-hidden bg-gray-100 dark:bg-gray-800">
                      <div
                        v-for="s in r.segments"
                        :key="s.key"
                        class="h-full text-[10px] leading-4 text-white text-center overflow-hidden whitespace-nowrap"
                        :class="SHARE_SEGMENT_CLASS[s.key]"
                        :style="{ width: `${s.pct}%` }"
                        :title="`${shareSegmentLabel(s.key)} ${yen(s.yen)} (${pct1(s.pct)})`"
                      >
                        <template v-if="s.pct >= 7">{{ Math.round(s.pct) }}%</template>
                      </div>
                    </div>
                    <span v-if="r.overflowPct > 0" class="shrink-0 text-red-600 dark:text-red-400" title="費用 (手当 + 燃料 + 運行経費の配分) が売上を超えた分">赤字 −{{ pct1(r.overflowPct) }}</span>
                  </div>
                </template>
              </template>
            </div>
            <p v-if="shareBars.skipped > 0" class="text-xs text-gray-400 mt-1">
              売上 0 の行 {{ shareBars.skipped }} 本は棒にしていません
            </p>
          </div>
        </div>

        <!-- 釧路積み (釧路営業所試算)。**表示専用のコンポーネントに切り出してある** —
             このページは 2200 行を超えているので、これ以上インラインで足さない。
             数字は `kushiroView` (= `kushiro-branch-view.ts`) が作る -->
        <KushiroBranchPanel
          class="margin-print-page margin-print-kushiro"
          :empty="kushiroView.empty"
          :summary="kushiroView.summary"
          :slider="kushiroView.slider"
          :legs-per-day="kushiroView.legsPerDay"
          :selected="kushiroView.selected"
          :grid="kushiroView.grid"
          :routes="kushiroView.routes"
          :drivers="kushiroView.drivers"
          :min-wage="kushiroView.minWage"
          :min-wage-legs-per-day="kushiroView.minWageLegsPerDay"
          :break-even-legs-per-day="kushiroView.breakEvenLegsPerDay"
          :assumptions="kushiroView.assumptions"
          :master-error="kushiroMinWageError"
          @update:legs-per-day="kushiroLegsPerDay = $event"
          @reset="kushiroLegsPerDay = null"
        />
      </template>
    </template>

    <OperationRouteMap
      v-if="routeModal"
      :route="routeModal.route"
      :title="routeModal.title"
      :loading="routeModal.loading"
      :error="routeModal.error"
      :track-note="routeModal.trackNote"
      :layers="routeMapLayers"
      :net780-missing-count="routeModal.net780Missing?.length ?? 0"
      :net780-archive-progress="net780ArchiveProgress"
      :net780-archiving="net780Archiving"
      @close="routeModal = null"
      @update:layers="setRouteMapLayers"
      @archive-net780="archiveRouteModalNet780"
    />
  </div>
</template>

<style>
/* 印刷: **区画の切れ目で紙を改める**。ただし**強制改ページは最小限**にして、
   5 行の表のために 1 枚使うような紙の無駄を出さない (Refs #760 の 37)。
   小さい区画は `break-inside: avoid` で「割れない」ようにするだけにし、入りきらなければ
   ブラウザに自然に送らせる。**紙を改めるのは、前の紙に食い込むと表が分断される
   4 区画だけ** (取引先別 / 売上の内訳 / 釧路積み / 最低賃金の比較)。
   **どこで改ページするかはオーナーが実際に刷って決めた** — 想定は
   P1 見出し〜人件費 / P2 燃費・単価 + 乗務員・運行 / P3 取引先別 / P4 売上の内訳 /
   P5 釧路積み / P6 最低賃金の比較 + 経路別 + 乗務員別 の 6 枚。
   規則は全部 @media print の中に閉じてあるので、**画面表示は 1px も変わらない**。
   色はページ側で触らない — ダークモード中でもライト配色に倒すのは
   `app/assets/css/main.css` の print ブロックの仕事。
   A4 横向き想定 (`restraint-wage.vue` と同じ。ブラウザの印刷ダイアログで横向きを選ぶ)。
   `@page` は scoped では効かないので、この style は非 scoped。 */
@media print {
  aside { display: none !important; }

  /* 操作用の枠 (月・車輌CD・集計・CSV・リンク・絞り込みチェック・配分の select・
     乗務員の検索欄・対象チップの ✕) は紙に要らない。**対象乗務員の名前そのものは残す** —
     誰を集計したかは紙に要る情報。**便/日 のスライダーも値は判断材料**なので、
     つまみと「実測平均に戻す」だけ消して隣の `〇.〇〇 便/日` のテキストは残す。 */
  .margin-print-controls,
  .margin-print-hide,
  .margin-print-targets input,
  .kushiro-print-slider input[type="range"],
  .kushiro-print-hide { display: none !important; }

  /* **紙を改める区画** (オーナーが刷って決めた 4 つ。Refs #760 の 37):
     取引先別 / 売上の内訳 (棒) / 釧路積み / 最低賃金の比較。
     どれも**前の紙に食い込むと表が分断される**ので紙を改める
     (釧路積みは加えて「実在しない試算」なので実績と混ぜない)。
     それ以外は `break-inside: avoid` だけにして紙の無駄を出さない。
     `break-before: page` には打ち消しを対で置く (この repo の作法) — 区画が紙の
     先頭に来たときに白紙が 1 枚出るのを防ぐ。集計前 (運行 0 本) はこれらの区画
     自体が描画されないので白紙だらけにはならない。 */
  .margin-print-page { break-before: page; }
  .margin-print-page:first-child { break-before: auto; }

  /* 割れると読めなくなる区画 (月の合計・粗利の内訳・人件費・燃費と単価・
     売上の内訳の棒ひとまとまり (取引先ごと / **乗務員ごと** の両方)・2 営業所のカード・
     棒 1 本) は途中で割らない。入りきらなければブラウザが次の紙へ丸ごと送る。
     **乗務員ごとの棒 (Refs #760 の 39) は `break-inside: avoid` だけで、紙は改めない** —
     乗務員/運行 の表と同じ紙に載るのが自然なため (改ページを足すのは上の 4 区画のまま)。 */
  .margin-print-block,
  .margin-print-keep,
  .margin-print-bar,
  .kushiro-print-depots > div { break-inside: avoid; }

  /* 見出し・注記だけが前の紙に取り残されないように */
  .margin-print-head,
  .margin-print-kushiro h3,
  .margin-print-kushiro .kushiro-print-badge,
  .margin-print-kushiro .kushiro-print-note { break-after: avoid; }
  .margin-print-kushiro .kushiro-print-badge,
  .margin-print-kushiro .kushiro-print-note { break-inside: avoid; }

  /* **表は紙の境目で行が割れないようにする。** 横スクロールの器は紙だと中身が
     切れるだけなので可視に戻す。列見出しは Chrome が thead を各ページの頭に
     繰り返してくれる。列数が多いので字を詰める。 */
  .margin-print-tablewrap,
  .margin-print-kushiro .overflow-x-auto { overflow: visible !important; }
  .margin-print-tablewrap tr,
  .margin-print-kushiro tr { break-inside: avoid; }
  .margin-print-tablewrap table,
  .margin-print-kushiro table { font-size: 9px; }
  .margin-print-tablewrap th, .margin-print-tablewrap td,
  .margin-print-kushiro th, .margin-print-kushiro td { padding: 2px 3px; border: 1px solid #999; }

  /* 釧路積みの中: **最低賃金の比較から紙を改める** (表が 2 枚に分断され、残り 1 行の
     ために 9 割余白の紙が出ていた)。**経路別の手前では紙を改めない** — 最低賃金の
     比較が独立した紙になるので、経路別・乗務員別はその続きに載る。
     損益分岐の 1 行は最低賃金の表から切り離さない (次の紙の頭に 1 行だけ
     取り残されていた)。ここも打ち消しを対で置く。 */
  .margin-print-kushiro .kushiro-print-minwage { break-before: page; }
  .margin-print-kushiro .kushiro-print-minwage:first-child { break-before: auto; }
  .margin-print-kushiro .kushiro-print-breakeven { break-before: avoid; break-inside: avoid; }

  @page { size: A4 landscape; margin: 8mm; }
}
</style>
