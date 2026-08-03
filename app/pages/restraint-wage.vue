<script setup lang="ts">
/**
 * 拘束×賃金 (Refs #244)。
 *
 * theearth には触らず、/restraint-fetch が R2 にアーカイブした summary を素材に:
 * ⓪ アーカイブ閲覧 (生 CSV / 版 / 確認履歴、サマリ再計算 — 単月/全月一括)
 * ① 月次集計・印刷 (theearth プレビュー形式 + 時間給の法定区分列、展開トグル、
 *    月範囲 × 乗務員範囲の一括印刷 = 月毎改ページ)
 * ② 最低賃金チェック (単価マスタ換算の理論値一覧。単価マスタ = 最低賃金の運用
 *    (2026-07-18) のため最低賃金換算との差分表示は持たない — Refs #282。
 *    最低賃金の設定カードは給与比較タブの 残業(最低賃金) 列のために同居)
 * ③ 単価マスタ (適用開始日つき履歴、一括変更、CSV 入出力)
 * ⑥ 社員マスタ (D1、会社×給与コード → 乗務員CD + 所属/給与体系の適用開始日つき
 *    履歴。月次集計 CSV の `所属(マスタ)`・`給与体系` 列の供給元、Refs #367)
 *
 * 対象月は「年セレクタ + 月タブ」で選ぶ (アーカイブが存在する月だけ活性、
 * GET /restraint-api/archive/months)。theearth ログインセッションは
 * /restraint-fetch 等と共有 (useRestraintSession)。
 */
import type {
  ArchiveCsvEntry,
  ArchiveHistoryEntry,
  FastBadgeState,
  MinWageCompareRow,
  MinWageMaster,
  MinWageRowAttrs,
  RestraintDriverSummary,
  WageMaster,
  WageReportResponse,
  WageReportRow,
} from '~/utils/restraint-wage-view'
import {
  fastBadgeState,
  groupMinWageRows,
  isTimecardSynced,
  MIN_WAGE_DEFAULT_KEY,
  MIN_WAGE_JOB_GROUP_LABEL,
  minWageCompareRow,
} from '~/utils/restraint-wage-view'
import { buildTimecardSummary, buildTimecardTable, countWorkKinds, employedDaysInMonth } from '~/utils/timecard-view'
import type { KosokuDay } from '~/utils/kosoku-daily'
import {
  buildKosokuTimecardTable,
  countKosokuWorkKinds,
  groupTimecardSheetsByCompany,
  kosokuByCalendarDate,
  mergeKosokuDays,
  parseKosokuDaily,
  sumKosokuMonth,
  timecardJobGroup,
} from '~/utils/kosoku-daily'
import type { SalaryOvertime, TimecardSummaryRow, WorkKindCounts } from '~/utils/timecard-view'
import type {
  OvertimeHoursComparison,
  ParsedSalaryCsv,
  SalaryComparison,
  SalaryItemAmount,
  SalaryItemCategory,
  SalaryItemConfig,
} from '~/utils/salary-compare'
import type { EmployeeMasterEntry, EmployeeMasterGetResponse } from '~/utils/employee-master'
import type { TimecardCompareResponse, TimecardCompareResult, TimecardCompareSummaryRow } from '~/utils/timecard-compare-view'
import {
  timecardCompareHeadline,
  timecardCompareRowClass,
  timecardCompareStatusLabel,
  fmtTimecardCompareCauseDays,
  fmtTimecardCompareDiff,
  fmtTimecardCompareDiffRange,
  fmtTimecardCompareMinutes,
  fmtTimecardCompareUnknown,
  hasFerryMinus,
  sortTimecardCompareSummaryRows,
  summarizeTimecardCompareResults,
  toTimecardCompareRows,
} from '~/utils/timecard-compare-view'
import type {
  KintaiDiffCacheState,
  KintaiDiffCategoryItemRow,
  KintaiDiffCategoryItems,
  KintaiDiffOneSidedFieldRow,
  KintaiDiffPrescription,
  KintaiDiffValueDiffFieldRow,
  KintaiFoldPageView,
  KintaiFoldProgress,
  KintaiRefreshMysqlPreview,
  KintaiWindowReportView,
} from '~/utils/kintai-diff-view'
import {
  buildKintaiDiffPrescriptions,
  fmtKintaiDiffCacheHeadline,
  fmtKintaiDiffCategoryCappedNote,
  fmtKintaiDiffCount,
  fmtKintaiDiffLastVerified,
  fmtKintaiDiffMissingFieldsNote,
  fmtKintaiRefreshMysqlGuarantee,
  foldProgressAppend,
  foldProgressInitial,
  kintaiDiffCacheStateFromLiveResult,
  kintaiDiffOneSidedFieldRows,
  kintaiDiffValueDiffFieldRows,
  KINTAI_DIFF_CATEGORIES,
  parseKintaiDiffApiResponse,
  parseKintaiDiffCacheState,
  parseKintaiDiffCategoryItemsFromResponse,
  parseKintaiDiffDayCoverageFromResponse,
  parseKintaiDiffValueDiffItemsFromResponse,
  parseKintaiFoldPage,
  parseKintaiRefreshMysqlApplyResult,
  parseKintaiRefreshMysqlPreview,
  parseKintaiWindowReport,
} from '~/utils/kintai-diff-view'
import type {
  KintaiCandidateDiffFieldRow,
  KintaiCandidateDiffItemsState,
  KintaiCandidateDiffResult,
} from '~/utils/kintai-candidate-diff'
import {
  buildKintaiCandidateDayCoverage,
  kintaiCandidateDiffFieldRows,
  lookupKintaiCandidateDiff,
} from '~/utils/kintai-candidate-diff'
import type { KintaiStaleMonthBadge, KintaiStaleMonthsResponse } from '~/utils/kintai-stale-months'
import {
  kintaiStaleMonthBadge,
  kintaiStaleMonthEntry,
  kintaiStaleMonthKey,
  parseKintaiStaleMonths,
} from '~/utils/kintai-stale-months'
import type { KintaiUnkoGapDtakoCheckResult, KintaiUnkoGaps } from '~/utils/kintai-unko-gaps'
import {
  kintaiUnkoGapDtakoCheckResultFromLookup,
  kintaiUnkoGapDtakoCheckView,
  kintaiUnkoGapsDeriveStartOpe,
  kintaiUnkoGapsDriverTotalCount,
  kintaiUnkoGapsReadability,
  parseKintaiUnkoGaps,
} from '~/utils/kintai-unko-gaps'
import type { DayEventsLookup } from '~/utils/kintai-day-events-lookup'
import { parseDayEventsLookup } from '~/utils/kintai-day-events-lookup'
import type { KintaiDayOperation } from '~/utils/kintai-day-operations'
import { parseKintaiDayOperations, isKintaiDayOperationUnkoNo23Digit } from '~/utils/kintai-day-operations'
import type { KintaiAlcUploadResult } from '~/utils/kintai-alc-upload'
import { parseKintaiAlcUploadResult } from '~/utils/kintai-alc-upload'

const {
  session: theearthSession,
  restoreSession,
  expireSession: theearthExpireSession,
  lastAccount,
} = useRestraintSession()

// 閲覧モード (Refs #272): このページの全タブは R2-only (worker は theearth に
// 触らない) ので、theearth ログインが無くても auth-worker JWT + 会社ID の
// viewer 経路で読める (worker 側 PR #273)。theearth セッションが有効なら従来
// どおりそのヘッダを使う (後方互換)。会社ID は theearth ログイン履歴 or 手入力。
const VIEWER_COMP_STORAGE_KEY = 'restraint-viewer-comp'
const viewerComp = ref('')
const viewerCompInput = ref('')

const session = computed<{ compId: string, userName: string } | null>(() =>
  theearthSession.value
  ?? (viewerComp.value ? { compId: viewerComp.value, userName: '閲覧' } : null))

/**
 * **常に viewer 経路 (auth-worker JWT) で叩く** (Refs #554)。
 *
 * このページが使う /restraint-api は 30 経路あるが、theearth セッション必須なのは
 * `login` / `logout` / `report` / `csv` の 4 つだけで (`isR2OnlyRestraintPath`)、
 * **その 4 つはこのページから 1 つも呼んでいない** (拘束CSV取得ページの担当)。
 * 以前は theearth セッションがあるとそちらを優先していたが、それだと relay が
 * introspect を通らず**誰が見ているのか (email) が relay に届かない** — 上流
 * キャッシュを email 単位の DO に置くのにこれが要る。
 *
 * `compId` を明示するとその会社に対して投げる (社員マスタの会社横断、Refs #367)。
 * 触れるかどうかの判定は worker 側 (`viewerCompIdsForTenant`) が DTAKO_ACCOUNTS の
 * 逆引きで行うため、ここで会社を絞る必要はない。
 */
function authHeaders(compId?: string): Record<string, string> {
  const token = currentAccessToken()
  return {
    'X-Theearth-Comp-Id': compId ?? session.value?.compId ?? viewerComp.value,
    'X-Theearth-User-B64': b64urlUtf8('viewer'),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** 401 の扱い: theearth セッション時は従来の失効フロー、viewer 時は
 * 「comp が不許可 (DTAKO_ACCOUNTS 未登録) or JWT 失効」なのでエラー表示のみ。 */
function expireSession(message: string) {
  if (theearthSession.value) {
    theearthExpireSession(message)
    return
  }
  pageError.value = `閲覧できません: ${message} (会社IDの許可設定 または 再ログインを確認してください)`
}

function startViewer() {
  const comp = viewerCompInput.value.trim()
  if (!comp) return
  viewerComp.value = comp
  if (import.meta.client) localStorage.setItem(VIEWER_COMP_STORAGE_KEY, comp)
}

const TABS = [
  { key: 'archive', label: 'アーカイブ' },
  { key: 'monthly', label: '月次集計・印刷' },
  { key: 'minwage', label: '最低賃金チェック' },
  { key: 'salary', label: '給与比較' },
  { key: 'items', label: '支給項目区分' },
  { key: 'master', label: '単価マスタ' },
  { key: 'employees', label: '社員マスタ' },
  { key: 'schedule', label: '勤務設定' },
  { key: 'timecard', label: 'タイムカード' },
  { key: 'compare', label: 'タイムカード照合' },
  { key: 'gcpdiff', label: 'オンプレ vs Supabase' },
] as const

/** 対象月が効くタブ。ここに無いタブでは年月バーを出さない (Refs #409)。
 * 単価マスタは選択月時点の単価を出すので対象に含む。 */
const MONTH_AWARE_TABS: string[] = ['archive', 'monthly', 'minwage', 'salary', 'master', 'schedule', 'timecard', 'compare', 'gcpdiff']

type TabKey = typeof TABS[number]['key']
const activeTab = ref<TabKey>('monthly')

const pageError = ref('')

// ---------------------------------------------------------------------------
// 対象月 (年セレクタ + 月タブ)
// ---------------------------------------------------------------------------

/** アーカイブが存在する月 (YYYY-MM、降順)。 */
const archiveMonths = ref<string[]>([])
/** archive/months が解決するまでタブ連動のデータ読み込みを止めるフラグ (Refs #451)。
 * 解決前に読むと、既定月 (アーカイブが無い当月) で wage-report が走り、応答が来た頃に
 * 最新アーカイブ月へ付け替わって読み直し = R2 GET 約300本の fan-out が丸ごと1回無駄になる。
 * 失敗時も true にする (エラー表示した上で従来どおり既定月で動かす — ページを殺さない)。 */
const archiveMonthsLoaded = ref(false)
const selectedYear = ref(new Date().getFullYear())
const selectedMonthNo = ref(new Date().getMonth() + 1)

const month = computed(() => `${selectedYear.value}-${String(selectedMonthNo.value).padStart(2, '0')}`)

const yearOptions = computed(() => {
  const years = new Set<number>(archiveMonths.value.map(ym => parseInt(ym.slice(0, 4), 10)))
  years.add(new Date().getFullYear())
  years.add(selectedYear.value)
  return [...years].sort((a, b) => b - a)
})

function monthHasArchive(year: number, monthNo: number): boolean {
  return archiveMonths.value.includes(`${year}-${String(monthNo).padStart(2, '0')}`)
}

// ---- 月タブの取り込み済みバッジ (Refs #460) ----
// タイムカード = R2 kintai アーカイブの月一覧 (archive/months が同時に返す)。
// 給与 = ichiban の kyuyo_sync_state (どの会社かは問わず「その月に給与が 1 社でも
// 取り込み済みか」で表示 — 月タブは会社を跨いだ作業状況の目安のため)。

/** タイムカード取り込み済みの月 (YYYY-MM)。 */
const kintaiMonths = ref<string[]>([])
/** 給与取り込み済みの月 (YYYY-MM、会社不問)。 */
const kyuyoSyncedMonths = ref<Set<string>>(new Set())
/** 給与アーカイブが有る (給与大臣の会社コード, 勤務月) の組 (`会社|YYYY-MM`)。
 * この組は upstream が SQLite キャッシュだけで返せる = OHKEN を開かないので、
 * ボタンを押さなくても勝手に読んで良い (Refs #369 / rust-ichibanboshi#106)。 */
const kyuyoSyncedKeys = ref<Set<string>>(new Set())
/** 上の 2 つが一度でも解決したか (成否は問わない)。給与比較タブが「まだ読み込み中」と
 * 「取り込まれていない」を取り違えないための門 (Refs #554) — 未解決のうちに
 * 「取り込んでください」を出すと、待てば出るデータに対して取り込みを促してしまう。 */
const kyuyoSyncedLoaded = ref(false)
/** 拘束サマリが ichiban に同期済みの月 (YYYY-MM) = 高速表示できる月 (Refs #460)。 */
const ichibanMonths = ref<string[]>([])
/** timecard 側が ichiban に同期済みの月 (YYYY-MM、#611 の無人同期、Refs #614)。
 * 「高速表示可」バッジの判定 (theearth 基準) には混ぜない — timecard 側は
 * live-build 一本化済みで同期の有無が表示速度に効かないため。バッジのツール
 * チップで timecard 側の同期状況を併記するためだけに使う。 */
const ichibanMonthsTimecard = ref<string[]>([])
/** relay の kintai 上流キャッシュ (daily+kosoku) が揃っている月 (Refs #543 followup)。
 * null = 旧 relay 応答 (フィールド無し) — バッジは従来どおりフル表示に fallback。 */
const kintaiCachedMonths = ref<string[] | null>(null)
/** 月ごとの stale (畳み直しが要るか、Refs #620)。`GET /restraint-api/kintai/stale-months`
 * を月タブ描画のたびに叩き直さないよう、他のバッジと同じく loadArchiveMonths と
 * 同じタイミングで1回だけ取る。null = 未取得 (取得中 or 失敗) — 判定は
 * `app/utils/kintai-stale-months.ts` の pure 関数に寄せる。 */
const kintaiStaleMonths = ref<KintaiStaleMonthsResponse | null>(null)

function monthHasKintai(year: number, monthNo: number): boolean {
  return kintaiMonths.value.includes(`${year}-${String(monthNo).padStart(2, '0')}`)
}

function monthHasKyuyo(year: number, monthNo: number): boolean {
  return kyuyoSyncedMonths.value.has(`${year}-${String(monthNo).padStart(2, '0')}`)
}

function monthIsSynced(year: number, monthNo: number): boolean {
  return ichibanMonths.value.includes(`${year}-${String(monthNo).padStart(2, '0')}`)
}

/** timecard 側が ichiban に同期済みか (#611 の無人同期、Refs #614)。バッジの
 * ツールチップに添えるだけで、バッジ自体の full/synced-only/none 判定は変えない。 */
function monthIsTimecardSynced(year: number, monthNo: number): boolean {
  return isTimecardSynced(`${year}-${String(monthNo).padStart(2, '0')}`, ichibanMonthsTimecard.value)
}

/** 「高速表示可」バッジの 2 段階判定 (Refs #543 followup)。判定は pure な
 * `fastBadgeState` (app/utils/restraint-wage-view.ts) に寄せてある。 */
function monthFastBadge(year: number, monthNo: number): FastBadgeState {
  return fastBadgeState(
    `${year}-${String(monthNo).padStart(2, '0')}`,
    ichibanMonths.value,
    kintaiCachedMonths.value,
  )
}

/** 月タブの「畳み直しが要る月」丸 (Refs #620)。判定は pure な `kintaiStaleMonthBadge`
 * (app/utils/kintai-stale-months.ts) に寄せる — 塗る条件は `stale_drivers > 0` だけ、
 * `total_drivers === 0` (データ無し) は「畳み済みで最新」と別扱いにする。 */
function monthStaleBadge(year: number, monthNo: number): KintaiStaleMonthBadge {
  return kintaiStaleMonthBadge(kintaiStaleMonthKey(year, monthNo), kintaiStaleMonths.value?.months ?? [])
}

/** ツールチップ用に stale/total の実数を出す。応答に無い月は null。 */
function monthStaleEntry(year: number, monthNo: number) {
  return kintaiStaleMonthEntry(kintaiStaleMonthKey(year, monthNo), kintaiStaleMonths.value?.months ?? [])
}

/** stale の丸を押したら「オンプレ vs Supabase」タブへ飛び、その月を選んで
 * 「② GCP 側を畳み直す」セクションまでスクロールする (Refs #620 やること2の理想形)。
 * 押せなくても丸自体は出るので、この導線が無くても機能は成立する。 */
function jumpToGcpFold(year: number, monthNo: number) {
  selectedYear.value = year
  selectedMonthNo.value = monthNo
  activeTab.value = 'gcpdiff'
  if (import.meta.client) {
    nextTick(() => {
      document.getElementById('gcp-fold-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
}

/** 選択中の月がアーカイブ有りなのに未同期 = 表示が遅い状態。バックフィル
 * (全月再計算) への案内を月タブ直下に出す。ichiban 連携が無い環境 (一覧が空) では
 * 全月未同期に見えてしまうので、**1 件でも同期済みがある時だけ**出す。 */
const showBackfillHint = computed(() =>
  ichibanMonths.value.length > 0
  && monthHasArchive(selectedYear.value, selectedMonthNo.value)
  && !monthIsSynced(selectedYear.value, selectedMonthNo.value),
)

/** 給与の sync 済み月を ichiban から引く。月タブのバッジと**アーカイブ自動表示**
 * (`autoLoadArchivedPayroll`) の両方が使う。**失敗しても静かに空のまま** —
 * その場合は従来どおり「給与DBから読み込み」ボタンでの取得だけになる。 */
async function loadKyuyoSyncedMonths() {
  try {
    const token = currentAccessToken()
    if (!token) return
    const res = await $fetch<{ entries: Array<{ company: string, month: string }> }>('/api/kyuyo/synced-months', {
      headers: { Authorization: `Bearer ${token}` },
    })
    kyuyoSyncedMonths.value = new Set(res.entries.map(e => e.month))
    kyuyoSyncedKeys.value = new Set(res.entries.map(e => `${e.company}|${e.month}`))
  }
  catch {
    // バッジが出ないだけ — エラー表示はしない
  }
  finally {
    // 失敗しても「解決済み」にする — 引けない環境で「読み込み中」を出し続けない
    kyuyoSyncedLoaded.value = true
  }
}

/** 月ごとの stale を relay 経由で1回だけ取る (Refs #620)。**フル突合
 * (/restraint-api/kintai/diff、約50秒) はここでは叩かない** — この口は
 * Postgres 1 往復だけの軽い応答で、月タブ描画のたびに叩いても壊れない設計。
 * 失敗しても静かに空のまま — バッジが出ないだけで他の月タブ表示は止めない。 */
async function loadKintaiStaleMonths() {
  try {
    const res = await $fetch<unknown>('/restraint-api/kintai/stale-months', { headers: authHeaders() })
    kintaiStaleMonths.value = parseKintaiStaleMonths(res)
  }
  catch {
    // バッジが出ないだけ — エラー表示はしない (他の月タブバッジと同じ扱い)
  }
}

// ---- 手動キャッシュ warm (Refs #554) ----
// 上流 (rust-ichibanboshi) をデプロイすると版 (etag) が動いて全月が miss になる
// (ohishi-exp/rust-ichibanboshi#191)。次に開いた人が 1.7MB × 2 種を月ぶん払うので、
// 先に押しておける口を用意する。**月を順番に**叩く — 並列にすると 1.7MB 級の取得が
// 重なり、上流の kosoku 同時実行キャップ (rust-ichibanboshi#188) と競合する。

const warming = ref(false)
const warmProgress = ref('')
const warmMessage = ref('')

/** 温める対象 (タイムカード取り込み済みの月、新しい順)。既にキャッシュが揃っている月も
 * 含める — 版が動いていればそこで miss になり、温め直しになるのが狙いのため。 */
const warmTargetMonths = computed(() => [...kintaiMonths.value].sort().reverse())

interface WarmResult { enabled: boolean, daily: string, kosoku: string, ms: number }

async function warmKintaiCache() {
  if (warming.value) return
  const months = warmTargetMonths.value
  if (!months.length) return
  warming.value = true
  warmMessage.value = ''
  pageError.value = ''
  let refetched = 0
  let alreadyFresh = 0
  let failed = 0
  try {
    for (const [i, ym] of months.entries()) {
      warmProgress.value = `${i + 1}/${months.length} ${fmtYm(ym)} を温めています…`
      const res = await $fetch<WarmResult>('/restraint-api/kintai/warm', {
        method: 'POST',
        headers: authHeaders(),
        query: { month: ym },
      })
      if (!res.enabled) {
        warmMessage.value = 'キャッシュが無効です (relay の UPSTREAM_CACHE=off、'
          + 'またはログイン情報から利用者を特定できませんでした)'
        return
      }
      const states = [res.daily, res.kosoku]
      if (states.includes('error') || states.includes('live')) failed += 1
      else if (states.includes('miss')) refetched += 1
      else alreadyFresh += 1
    }
    warmMessage.value = `${months.length} ヶ月を温めました — `
      + `取り直し ${refetched} / 既に最新 ${alreadyFresh}`
      + (failed ? ` / 失敗 ${failed} (上流が応答しない月)` : '')
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    warming.value = false
    warmProgress.value = ''
    // 「高速表示可」バッジを取り直す
    await loadArchiveMonths()
  }
}

/** loadArchiveMonths の in-flight ガード (Refs #451)。onMounted (restoreSession 直後、同期) と
 * watch(session) (同 flush の microtask) がほぼ同時に呼ぶため、走行中の再入は捨てる。 */
let archiveMonthsLoading = false

async function loadArchiveMonths() {
  if (!session.value || archiveMonthsLoading) return
  archiveMonthsLoading = true
  try {
    const res = await $fetch<{ months: string[], kintai_months?: string[], ichiban_months?: string[], ichiban_months_timecard?: string[], kintai_cached_months?: string[] }>('/restraint-api/archive/months', { headers: authHeaders() })
    archiveMonths.value = res.months
    // タイムカード取り込み済み月 (relay 旧版は返さない — その間はバッジ非表示)
    kintaiMonths.value = res.kintai_months ?? []
    // 拘束サマリ同期済み月 (= 高速表示可、Refs #460)
    ichibanMonths.value = res.ichiban_months ?? []
    // timecard 側の無人同期済み月 (旧 relay 応答には無い、Refs #614)
    ichibanMonthsTimecard.value = res.ichiban_months_timecard ?? []
    // kintai 上流キャッシュ有りの月 (Refs #543 followup)。旧 relay はフィールド
    // 自体が無い → null のままにしてバッジを従来どおりフル表示に fallback
    kintaiCachedMonths.value = res.kintai_cached_months ?? null
    // 給与バッジも同じタイミングで更新 (失敗は静かに無視)
    void loadKyuyoSyncedMonths()
    // 月ごとの stale バッジも同じタイミングで1回だけ (失敗は静かに無視、Refs #620)
    void loadKintaiStaleMonths()
    // 初期選択: アーカイブのある最新月
    if (res.months.length > 0 && !monthHasArchive(selectedYear.value, selectedMonthNo.value)) {
      const latest = res.months[0]!
      selectedYear.value = parseInt(latest.slice(0, 4), 10)
      selectedMonthNo.value = parseInt(latest.slice(5, 7), 10)
    }
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    archiveMonthsLoading = false
    archiveMonthsLoaded.value = true
  }
}

// タブ・対象月はリロードで失われないよう sessionStorage に保持する (Refs #253)。
// localStorage でなく sessionStorage — ブラウザを閉じたら既定 (月次集計・当月) に戻す。
const TAB_STORE_KEY = 'restraint-wage:tab'
const MONTH_STORE_KEY = 'restraint-wage:month'

onMounted(() => {
  const savedTab = sessionStorage.getItem(TAB_STORE_KEY)
  if (savedTab && TABS.some(t => t.key === savedTab)) {
    activeTab.value = savedTab as TabKey
  }
  const savedMonth = sessionStorage.getItem(MONTH_STORE_KEY)?.match(/^(\d{4})-(\d{2})$/) ?? null
  if (savedMonth) {
    selectedYear.value = parseInt(savedMonth[1]!, 10)
    selectedMonthNo.value = parseInt(savedMonth[2]!, 10)
  }
  restoreSalaryImports()
  restoreSession()
  // theearth 未ログインなら閲覧モードを準備: 前回の閲覧 comp → theearth ログイン
  // 履歴の comp の順で prefill。どちらも無ければ会社ID入力パネルが出る。
  if (!theearthSession.value) {
    viewerComp.value = localStorage.getItem(VIEWER_COMP_STORAGE_KEY) || lastAccount().compId
    viewerCompInput.value = viewerComp.value
  }
  // watch(session) 側も同 flush で呼ぶが、in-flight ガードで 1 本に潰れる (Refs #451)。
  // ここを消して watcher に全寄せしない — session が変化しない再マウント経路
  // (localStorage 不調で restoreSession が no-op の時) で archive が読めなくなる
  if (session.value) loadArchiveMonths()
})

watch(activeTab, (tab) => {
  if (import.meta.client) sessionStorage.setItem(TAB_STORE_KEY, tab)
})
watch(month, (ym) => {
  if (import.meta.client) sessionStorage.setItem(MONTH_STORE_KEY, ym)
})

watch(session, (s) => {
  if (!s) {
    report.value = null
    archiveEntries.value = []
    archiveHistory.value = {}
    printBatch.value = null
    // 貼り付け中の給与データはメモリ上にしか無い — ログアウトで破棄する
    clearSalaryPaste()
    dbImports.value = []
    payrollDbMessage.value = ''
    salaryConfigLoaded.value = false
    employeeMasterLoaded.value = false
    // 他社分も含めて破棄する (会社横断表示、Refs #367)
    employeeMasterByComp.value = {}
    // 飛んでいる取得も忘れる — 残したままだと再ログイン後の呼び出しが
    // 前のセッションの Promise を共有して取り直さない (Refs #501)
    employeeMasterInflight.clear()
    minWageMasterLoaded.value = false
    // 再ログイン時に archive/months の解決を待ち直す (Refs #451)
    archiveMonthsLoaded.value = false
    // ドライバーの拘束・深夜 (Refs #472)。月を覚えたままだと再ログイン後に
    // 取り直さず、前の会社の値が残る
    kosokuByDriver.value = new Map()
    kosokuPrevByDriver.value = new Map()
    kosokuMonth.value = ''
  }
  else {
    loadArchiveMonths()
  }
})

function handleApiError(e: unknown): void {
  if (restraintErrorStatus(e) === 401) {
    expireSession(restraintErrorMessage(e))
    return
  }
  pageError.value = restraintErrorMessage(e)
}

// ---------------------------------------------------------------------------
// ① 月次集計・印刷 / ② 最低賃金チェック (データ源は共通の wage-report)
// ---------------------------------------------------------------------------

const report = ref<WageReportResponse | null>(null)
const loadingReport = ref(false)
const expandWage = ref(false)

/**
 * 取得中なのに前回の行を表示している状態 (= 画面の数字が「取得前のもの」)。
 *
 * 月タブを切り替えた直後や「再計算」中に、前の月の表がそのまま残るのが見間違いの
 * もとになっていた (2026-07-25 指摘)。行を消すとスクロール位置と列幅を失うので
 * 消さずに薄くし、表の上にスピナーを出して「これは今の値ではない」と分かるようにする。
 */
const staleReport = computed(() => loadingReport.value && (report.value?.rows.length ?? 0) > 0)
/** 古い数字だと分かるように薄くし、誤操作も止める。 */
const STALE_CLASS = 'opacity-40 pointer-events-none select-none'
/** 月別 wage-report のキャッシュ (一括印刷で再利用)。 */
const reportCache = new Map<string, WageReportResponse>()

/**
 * 直近の wage-report が上流キャッシュを使えたか (Refs #554)。relay が
 * `X-Upstream-Cache: hit|miss|live` をヘッダで返す (本文に入れると hit/miss で
 * 本文が変わり、弱 ETag が動いて 304 が効かなくなる)。
 *
 * - `hit`  … 版が一致してキャッシュを再利用した (速い)
 * - `miss` … **上流の版 (sha) が変わっていたので取り直した** — 画面に出す
 * - `live` … 版が引けずキャッシュ不使用 / キャッシュ無効
 */
const upstreamCacheState = ref<'hit' | 'miss' | 'live' | null>(null)
/** 直近の wage-report にかかった時間 (ms)。miss の説明に添える。 */
const reportElapsedMs = ref(0)

async function fetchWageReport(ym: string): Promise<WageReportResponse> {
  const cached = reportCache.get(ym)
  if (cached) return cached
  const startedAt = Date.now()
  // ヘッダを読むため raw で受ける ($fetch は本文しか返さない)
  const res = await $fetch.raw<WageReportResponse>('/restraint-api/wage-report', {
    headers: authHeaders(),
    query: { month: ym },
  })
  reportElapsedMs.value = Date.now() - startedAt
  const state = res.headers.get('x-upstream-cache')
  upstreamCacheState.value = state === 'hit' || state === 'miss' || state === 'live' ? state : null
  const body = res._data as WageReportResponse
  reportCache.set(ym, body)
  return body
}

/** loadWageReport の世代。タブ/月の切り替え連打で in-flight が複数になった時、
 * **最後に発火した読み込みだけ**が画面に触れる (latest-wins、Refs #456)。
 * ガード無しだと遅く返った古い月の応答が新しい月の表を上書きする。 */
let reportEpoch = 0

async function loadWageReport() {
  if (!session.value || !month.value) return
  const epoch = ++reportEpoch
  const ym = month.value
  loadingReport.value = true
  pageError.value = ''
  try {
    reportCache.delete(ym) // 再計算ボタンは常に最新を取り直す
    const res = await fetchWageReport(ym)
    if (epoch !== reportEpoch) return // 選択が変わった後に届いた古い応答は捨てる
    report.value = res
  }
  catch (e) {
    if (epoch !== reportEpoch) return
    report.value = null
    handleApiError(e)
  }
  finally {
    // 新しい読み込みが走っている間はスピナーを消さない
    if (epoch === reportEpoch) loadingReport.value = false
  }
}

/** 金額 ÷ 時間(分) の実額按分平均単価 (円/h)。時間が 0 や金額が null なら null。 */
function ratePerHour(pay: number | null, minutes: number): number | null {
  if (pay == null || minutes <= 0) return null
  return Math.round(pay / (minutes / 60))
}

// ---------------------------------------------------------------------------
// タイムカード表 (Refs #424 PR-E)
// ---------------------------------------------------------------------------
// 打刻を持つのは**タイムカード由来の行だけ** (theearth の拘束 CSV に打刻は無い)。
// wage-report は既に読んでいるので、そこから source で絞って表に畳む。

/** タイムカード由来の行 (乗務員CD の数値順)。 */
const timecardRows = computed(() =>
  (report.value?.rows ?? []).filter(r => r.source === 'timecard'),
)

/** 表示対象の乗務員CD (空 = 全員)。カンマ区切りで絞れる。 */
const timecardFilter = ref('')

/** `timecardFilter` の正規化キー集合 (空 = 絞り込みなし)。 */
const timecardFilterCds = computed(() => timecardFilter.value
  .split(/[,、\s]+/)
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => String(Number(s))))

function matchesTimecardFilter(driverCd: string): boolean {
  return !timecardFilterCds.value.length || timecardFilterCds.value.includes(String(Number(driverCd)))
}

const timecardSheets = computed(() => {
  const [year, monthNo] = [selectedYear.value, selectedMonthNo.value]
  return timecardRows.value
    .filter(r => matchesTimecardFilter(r.summary.driverCd))
    .map(r => {
      // 拘束時間上の残業・勤怠日数は summary から常に出せる。給与側 (基礎単価・
      // 残業計上額・勤怠日数) は給与比較タブで CSV を取り込んでいる時だけ埋まる
      // (Refs #441)
      const driverKey = String(Number(r.summary.driverCd))
      const paid = paidOvertimeByDriver.value.get(driverKey) ?? null
      const paidAttendance = paidAttendanceByDriver.value.get(driverKey) ?? null
      const counts = countWorkKinds(r.summary.days)
      // 出勤日数 (拘束側) は「公休・有休・欠勤以外は出勤」で数える — 給与明細の
      // 出勤日数と同じ数え方 (実測: 30日 − 公休5日 = 25日で一致)。打刻エラーの日や
      // 打刻が全く無い日 (upstream に行自体が無い日) も出勤から引かない — 賃金計算
      // から外れているだけで、来ていないと確定したわけではないため (Refs #441)。
      // `counts` の内訳合計 (normal+overtime+holidayWork+punchError) だとタイムカードに
      // 行自体が無い日を出勤に数え損ねる。
      //
      // 引く元は月日数ではなく**在籍日数** (Refs #445) — 途中入社・途中退職の人は
      // 在籍していない日まで出勤に数えられていた。入社日が未取り込みの社員は
      // employedDaysInMonth が月日数を返すので、従来と同じ値のまま
      const employed = employedDaysInMonth(year, monthNo, employmentByDriver.value.get(driverKey)
        ?? { hireDate: null, retireDate: null })
      const workDaysSys = employed - counts.publicHoliday - counts.paidLeave - counts.absence
      // **打刻基準の日別サマリ (kosoku-daily) があれば時間はそちらで出す** (2026-07-28 決定)。
      // 打刻由来サマリは「始業 → 次の終業」で 1 勤務を組むため、長距離のように出発時と
      // 帰着時にしか打刻しない人は数日が 1 勤務になり、所定を超えた分が全部 時間外に
      // なる (実測: 乗務員 1104 / 2026-04 で 8 日間 1 勤務・残業 321h04m)。上流は
      // 打刻が無い区間を休息イベントで割るので、そちらが実態に合う (同 26 勤務・
      // 残業 34h30m、紙のタイムカードと日別まで一致)。
      const kosoku = kosokuDaysOf(driverKey)
      const byDate = kosoku ? kosokuByCalendarDate(kosoku, month.value) : null
      // 勤務日の区分は kosoku 側で数え直し、**休暇 (公休・有休・欠勤) は打刻側を残す** —
      // 運行イベントには休暇が無いので、ここだけは打刻が唯一の出どころ
      const mergedCounts = kosoku
        ? { ...counts, ...pickWorkDayKinds(countKosokuWorkKinds(kosoku, month.value)) }
        : counts
      const sysOvertimeMinutes = byDate
        ? [...byDate.values()].reduce((s, p) => s + p.overtimeMinutes + p.overtimeNightMinutes, 0)
        : (r.summary.overtimeMinutes ?? 0) + (r.summary.overtimeNightMinutes ?? 0)
      return {
        driverCd: r.summary.driverCd,
        driverName: r.summary.driverName,
        rows: kosoku
          ? buildKosokuTimecardTable(kosoku, year, monthNo)
          : buildTimecardTable(r.summary.days, year, monthNo),
        counts: mergedCounts,
        overtimeCompare: overtimeHoursComparison({
          sysOvertimeMinutes,
          csvOvertimeHours: paid?.csvOvertimeHours ?? null,
        }),
        attendanceCompare: {
          work: { sys: workDaysSys, csv: paidAttendance?.work ?? null },
          holidayWork: { sys: mergedCounts.holidayWork, csv: null },
          publicHoliday: { sys: counts.publicHoliday, csv: paidAttendance?.publicHoliday ?? null },
        },
        // 月の拘束と深夜 (Refs #472 PR-D)。日別の 8 列は増やさずヘッダに出す
        restraint: kosoku
          ? sumKosokuMonth(kosoku, month.value)
          : {
              restraintMinutes: r.summary.restraintMinutes ?? 0,
              nightMinutes: r.summary.nightMinutes ?? 0,
              overtimeNightMinutes: r.summary.overtimeNightMinutes ?? 0,
              // 法定区分は wage-report が classifyMonth で出した値 (月次集計と同じ)
              overtimeMinutes: r.wage.minutes.overtime,
              legalHolidayMinutes: r.wage.minutes.legalHoliday + r.wage.minutes.legalHolidayNight,
            },
      }
    })
})

/** 勤務日の区分だけを抜く (休暇・自主出勤・打刻エラーは打刻側の値を残すため)。 */
function pickWorkDayKinds(c: WorkKindCounts): Pick<WorkKindCounts, 'normal' | 'overtime' | 'holidayWork'> {
  return { normal: c.normal, overtime: c.overtime, holidayWork: c.holidayWork }
}

// ---- ドライバーの拘束・深夜 (打刻基準の日別サマリ、Refs #472 PR-B / PR-C) ----
// ドライバーは打刻を持たない (theearth の拘束 CSV 由来) ので wage-report の
// `source === 'timecard'` に出てこない。別経路で取って同じ 8 列の表に混ぜる。

/** 乗務員CD → その月の勤務日 (打刻基準)。取得前・失敗時は空。 */
const kosokuByDriver = ref<Map<string, KosokuDay[]>>(new Map())
/** 同じく**前月**の勤務日。月初に終わる勤務の退社を出すために要る (下記)。 */
const kosokuPrevByDriver = ref<Map<string, KosokuDay[]>>(new Map())
/** `kosokuByDriver` がどの月のものか (未取得は空文字)。 */
const kosokuMonth = ref('')
const loadingKosoku = ref(false)

/** wage-report と同じ latest-wins ガード (遅れて返った前の月で上書きさせない)。 */
let kosokuEpoch = 0

/**
 * その乗務員の打刻基準の勤務日 (当月 + 前月に始業して当月に終わる分)。
 * 未取得・その人の分が無ければ null — 呼び出し側は打刻由来サマリへ落ちる。
 */
function kosokuDaysOf(driverKey: string): KosokuDay[] | null {
  if (kosokuMonth.value !== month.value) return null
  const current = kosokuByDriver.value.get(driverKey)
  if (!current) return null
  return mergeKosokuDays(kosokuPrevByDriver.value.get(driverKey) ?? [], current)
}

/**
 * 打刻基準の日別サマリを全乗務員ぶん取る (当月 + 前月を並行して 2 リクエスト)。
 *
 * **前月も取るのは月初の退社を出すため。** 上流は勤務を**始業日**で月に振り分けるので、
 * 前月末に始業して当月 1 日に終業した勤務は当月の応答に入らない。当月分だけだと
 * 1 日の行の退社が空欄になり「退社が取れていない」ように見える (実測: 乗務員 1194 の
 * 2026-04-01 は `終業 17:07` の打刻があるのに、その勤務の始業が 3/31 なので 4 月には
 * 来ない)。**直列にせず並行**で投げる — 1 か月ぶんが約 0.9 MB / 2〜6 秒あるため。
 *
 * **失敗しても画面を止めない** — ドライバー行が出ないだけで、事務員のタイムカード表は
 * 従来どおり出る。ここで pageError を立てると既存の表示まで巻き添えになる。
 */
async function loadKosokuDaily() {
  if (!session.value || !month.value) return
  const epoch = ++kosokuEpoch
  const ym = month.value
  const prevMonthYm = prevYm(ym)
  loadingKosoku.value = true
  const fetchMonth = (target: string) => $fetch<unknown>('/restraint-api/kintai/kosoku-daily', {
    headers: authHeaders(),
    query: { month: target },
  })
  try {
    // 前月は「あれば使う」補助なので、落ちても当月の表示は続ける
    const [res, prev] = await Promise.all([
      fetchMonth(ym),
      fetchMonth(prevMonthYm).catch((e) => {
        console.warn('[kosoku-daily] 前月を取得できませんでした:', restraintErrorMessage(e))
        return null
      }),
    ])
    if (epoch !== kosokuEpoch) return
    kosokuByDriver.value = parseKosokuDaily(res, ym).byDriver
    kosokuPrevByDriver.value = prev ? parseKosokuDaily(prev, prevMonthYm).byDriver : new Map()
    kosokuMonth.value = ym
  }
  catch (e) {
    if (epoch !== kosokuEpoch) return
    kosokuByDriver.value = new Map()
    kosokuPrevByDriver.value = new Map()
    kosokuMonth.value = ym // 同じ月で無限に取り直さない
    console.warn('[kosoku-daily] 取得できませんでした:', restraintErrorMessage(e))
  }
  finally {
    if (epoch === kosokuEpoch) loadingKosoku.value = false
  }
}

/**
 * ドライバーのタイムカード表 (Refs #472 PR-C)。
 *
 * **既に表に出ている乗務員CD は除く。** `kosoku-daily` は打刻を持つ人を全員返すので、
 * 事務員も含まれる (2026-04 実測: 事務員 27 名のうち 25 名が両方に居た)。そのまま
 * 混ぜると二重に並ぶ。両方に居る人は `timecardSheets` 側が担当し、**そこでも時間は
 * kosoku-daily を使う** (2026-07-28 決定) — 休暇・自主出勤・打刻エラー・給与突合という
 * この画面固有の判定は打刻由来サマリにしか無いので、行そのものは向こうに残す。
 * ここに来るのは打刻由来サマリを持たない人 (デジタコにしか居ない乗務員) だけ。
 *
 * **乗務員CD 0 は落とす** (実測で返ってくる。社員マスタに居ない番号)。
 *
 * **打刻をまったく持たない乗務員も出さない** (ユーザー決定 2026-07-27)。表は打刻から
 * 作る勤務表で、列に出せる時刻が 1 つも無いため。拘束は運行イベントから出せるが、
 * それは拘束時間管理表の役目。
 */
const kosokuDriverSheets = computed(() => {
  const [year, monthNo] = [selectedYear.value, selectedMonthNo.value]
  const shown = new Set(timecardRows.value.map(r => String(Number(r.summary.driverCd))))
  return [...kosokuByDriver.value.keys()]
    .filter(driverCd => driverCd !== '0' && !shown.has(driverCd))
    .filter(driverCd => matchesTimecardFilter(driverCd))
    .map((driverCd) => {
      // 前月に始業して当月に終業した勤務も混ぜる — 表側が「終業は起きた日の行」に
      // 置くので、月初の退社が空欄になるのを防ぐ。併せて月境界に残る休息由来の
      // 欠片を落とす (実測: 乗務員 1194 / 2026-04-01)
      const merged = mergeKosokuDays(
        kosokuPrevByDriver.value.get(driverCd) ?? [],
        kosokuByDriver.value.get(driverCd) ?? [],
      )
      // **打刻をまったく持たない乗務員は出さない** (ユーザー決定 2026-07-27)。
      // 表は打刻から作る勤務表で、列に出せる時刻が 1 つも無いため
      if (!merged.some(d => d.punches.length)) return null
      // 日数も拘束・深夜も**按分後の暦日**から数える (ユーザー指摘 2026-07-27)。
      // 前月に始業した勤務も渡す — 当月に落ちる分だけが拾われる
      const counts = countKosokuWorkKinds(merged, month.value)
      return {
        driverCd,
        driverName: driverNameByCd.value.get(driverCd) ?? '',
        rows: buildKosokuTimecardTable(merged, year, monthNo),
        counts,
        restraint: sumKosokuMonth(merged, month.value),
        // 残業の給与突合はドライバーには出さない (給与明細の突合キーが要る)
        overtimeCompare: null,
        // 出勤・休日出勤は数えられる。**公休・有休・欠勤は打刻にしか無いので 0 のまま**
        // だが、表示側が 0 の区分を出さないので「公休 0 日」とは並ばない
        attendanceCompare: {
          work: { sys: counts.normal + counts.overtime, csv: null },
          holidayWork: { sys: counts.holidayWork, csv: null },
          publicHoliday: { sys: 0, csv: null },
        },
      }
    })
    .filter(sheet => sheet !== null)
})

/** 乗務員CD → 氏名 (読み込み済みの全会社の社員マスタから)。 */
const driverNameByCd = computed(() => {
  const map = new Map<string, string>()
  for (const entries of Object.values(employeeMasterByComp.value)) {
    for (const e of entries) {
      if (!e.driverCd) continue
      const key = normalizeDriverCdKey(e.driverCd)
      if (!map.has(key)) map.set(key, e.name)
    }
  }
  return map
})

/**
 * 乗務員CD → 給与大臣の会社コードと所属 (営業所・職種、対象月末時点)。
 * **タイムカード表と最低賃金チェックの並べ替えで共有**する。
 *
 * 表の区切りが**給与の会社コード**になった (ユーザー決定 2026-07-28) ので、
 * dtako 会社ID ではなく社員マスタの `company` を引く。同じ人が複数会社に在籍
 * しうる (Refs #403) ので**会社コードの小さい方**に寄せる — 表の並びが月によって
 * 入れ替わらないようにする。所属は寄せた側の会社の属性行から採る。
 */
const employeeOrderAttrsByDriver = computed(() => {
  const map = new Map<string, MinWageRowAttrs & { company: string }>()
  for (const entries of Object.values(employeeMasterByComp.value)) {
    for (const e of entries) {
      if (!e.driverCd) continue
      const key = normalizeDriverCdKey(e.driverCd)
      const cur = map.get(key)
      if (cur && cur.company <= e.company) continue
      const attrs = resolveAttrsAt(e, month.value)
      map.set(key, {
        company: e.company,
        branchCode: attrs?.branchCode ?? null,
        branchName: attrs?.branchName ?? null,
        jobName: attrs?.jobName ?? null,
      })
    }
  }
  return map
})

/**
 * 給与会社コードごとに区切ったタイムカード表 (ユーザー決定 2026-07-28)。
 *
 * 会社コード昇順 → 職種 (事務 → 作業 → 整備 → 乗務 → その他) → 乗務員CD 順。
 * 社員マスタで会社が引けない乗務員CD は末尾の「会社不明」へ (落とすとマスタ
 * 未登録の人が黙って消える)。
 */
const timecardSections = computed(() =>
  groupTimecardSheetsByCompany(
    [...timecardSheets.value, ...kosokuDriverSheets.value],
    driverCd => employeeOrderAttrsByDriver.value.get(driverCd)?.company ?? null,
    driverCd => timecardJobGroup(employeeOrderAttrsByDriver.value.get(driverCd)?.jobName),
  ))

/** 表に出す人が 1 人でも居るか (事務員・ドライバーどちらでも)。 */
const hasTimecardSheets = computed(() =>
  timecardSections.value.some(s => s.sheets.length > 0))

/**
 * 表示が**1 人だけ**か (乗務員CD で絞り込んだ時)。true の間は 1 列に伸ばして
 * 内訳列 (拘束 / 休憩 / 時間外 / 時間外深夜 / 深夜) も出す (2026-07-28 指示)。
 * 3 人横並びでは紙幅に入らないので、その時は従来の 9 列のまま。
 */
const singleTimecardSheet = computed(() =>
  timecardSections.value.reduce((n, s) => n + s.sheets.length, 0) === 1)

/**
 * タイムカード表を**全部描く**か (Refs #472)。
 *
 * 画面では見えているシートだけ描く (`RenderWhenVisible`) — 134 人 × 30 日 × 8 列を一度に
 * DOM へ載せるとメインスレッドが止まり、スクロールも効かなくなるため。**紙は一覧が
 * 揃っていないと意味が無い**ので、印刷のときだけ全部描く。
 *
 * `beforeprint` で立てても Vue の描画は次のフレームなので間に合わない。**印刷ダイアログを
 * 開く前に立てて 1 フレーム待つ** (`printTimecards`)。Ctrl+P で直接開かれた場合の保険と
 * して `beforeprint` でも立てる — その回の紙は欠けるが、次からは揃う。
 */
const renderAllTimecards = ref(false)

async function printTimecards() {
  renderAllTimecards.value = true
  await nextTick()
  // 描画が済むまで 1 フレーム待つ (nextTick は DOM 反映まで、描画完了までは待たない)
  await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
  window.print()
}

onMounted(() => {
  if (import.meta.client) window.addEventListener('beforeprint', () => { renderAllTimecards.value = true })
})

/**
 * 打刻を 1 つも持たない = **サマリが sessions を持つ前より前に取り込まれたまま**。
 * 表が全部空欄になるので、再取り込みが要ることを画面から言う (Refs #424 PR-E 1/2)。
 */
const timecardNeedsRefetch = computed(() =>
  timecardRows.value.length > 0
  && timecardRows.value.every(r => r.summary.days.every(d => !d.sessions?.length)),
)

// ---- nginx のタイムカード表との突合 (Refs #492 PR-B、月×全乗務員一覧は #606-8) ----
//
// 社内 CakePHP が出している紙のタイムカード表 (拘束列) と、この画面の拘束を暦日ごとに
// 引き算して並べる。**判定は relay 側が済ませてある** — 両側で判定すると必ずずれるので、
// ここは表示だけ。突合するのは拘束だけで、残業は定義が別物なので比較しない。
//
// 「タイムカード照合」タブの担当。以前は `timecard` タブに 1 vs 1 (乗務員CD で
// 絞れている時だけ) の突合ブロックが埋まっていたが、月全体で「誰のどこが変か」を
// 見る手段が無かったため、月 × 全乗務員の一覧 + 1 人へのドリルダウンに置き換えた
// (Refs #606-8)。旧ブロックはここへ統合し、`timecard` タブからは削除した
// (同じ突合が 2 か所に出ていると「どちらが正か」の質問が必ず出るため)。

/**
 * 月 × 全乗務員ぶんの突合結果 (`driver` を付けずに取った生の応答)。
 *
 * `only_anomalies=1` でも 129 名で 54 万文字返る (relay 側コメント参照) ので、
 * **日別を含むこの生データは DOM に出さない** — 1 乗務員 1 行に畳んだ
 * `compareSummaryRows` だけを一覧に出し、選択した 1 人ぶんだけ `compareRows` で
 * 日別テーブルへ展開する。
 */
const compareAllResults = ref<TimecardCompareResult[]>([])
const compareAllLoading = ref(false)
const compareAllError = ref('')
const compareAllLoaded = ref(false)
/** 上流 (kosoku-daily) が落ちていた場合。片側だけの表になるので画面から言う。 */
const compareOursAvailable = ref(true)

/** 一覧の 1 行。既定は未説明の残差 (`unknownMinutes`) が大きい順 (ユーザー決定 2026-08-03)。 */
const compareSummaryRows = computed(() =>
  sortTimecardCompareSummaryRows(summarizeTimecardCompareResults(compareAllResults.value)))

/** ドリルダウン中の乗務員CD。一覧の行を選ぶとセットする。 */
const compareSelectedDriverCd = ref<string | null>(null)

/** 選択した乗務員の突合結果 (日別込み)。既に取得済みの `compareAllResults` から探すだけ — 再取得しない。 */
const compareResult = computed(() =>
  compareAllResults.value.find(r => r.driverCd === compareSelectedDriverCd.value) ?? null)

const compareRows = computed(() =>
  compareResult.value ? toTimecardCompareRows(compareResult.value.days) : [])

/**
 * フェリー控除の列を出すか。**その月に 1 日でもあれば出す** — 控除は差の主因なので
 * 額そのものを確かめられるようにする (合計が正のままの日もあり、負値だけ見ていると
 * 見落とす: 1726 / 2026-03-21 は 677 分 + 控除 78 分)。無い月に空列は出さない。
 */
const showCompareFerry = computed(() =>
  compareResult.value ? hasFerryMinus(compareResult.value) : false)

/**
 * 押した時だけ取る。月タブを切り替えるたびに社内 LAN へ往復させたくないのと、
 * 「いま nginx が何を出しているか」を見るのが目的で自動更新に意味が無いため
 * (`timecard` タブの旧 1 vs 1 突合と同じ方針)。`driver` を付けずに `only_anomalies=1`
 * を渡し、月内で差分も異常も無い乗務員は上流側で落とす。
 */
async function loadTimecardCompareAll() {
  if (!month.value) return
  compareAllLoading.value = true
  compareAllError.value = ''
  compareSelectedDriverCd.value = null
  try {
    const res = await $fetch<TimecardCompareResponse>('/restraint-api/timecard-compare', {
      headers: authHeaders(),
      query: { month: month.value, only_anomalies: 1 },
    })
    compareAllResults.value = res.results
    compareOursAvailable.value = res.oursAvailable
    compareAllLoaded.value = true
  }
  catch (e) {
    compareAllResults.value = []
    compareAllLoaded.value = false
    compareAllError.value = restraintErrorMessage(e)
  }
  finally {
    compareAllLoading.value = false
  }
}

// 月が変わったら前の結果を消す — 別の月の一覧が残ると誤読する
watch(month, () => {
  compareAllResults.value = []
  compareAllLoaded.value = false
  compareAllError.value = ''
  compareSelectedDriverCd.value = null
})

/** 一覧の行を選ぶ (トグル)。もう一度同じ行を選ぶと閉じる。 */
function selectCompareDriver(row: TimecardCompareSummaryRow) {
  compareSelectedDriverCd.value = compareSelectedDriverCd.value === row.driverCd ? null : row.driverCd
}

// ---- 勤怠 (タイムカード) の取り込み (Refs #433) ----
// ルート自体は #424 PR-A で作ったが**画面から叩く導線が無かった**ため、
// 打刻エラー判定・公休の取り込みといった後続の変更を入れても、誰も再取り込みできず
// 古いサマリが表示され続けていた。期間指定は給与DB バーと同じ作法。

const kintaiRangeFrom = ref('')
const kintaiRangeTo = ref('')
const fetchingKintai = ref(false)
const kintaiMessage = ref('')

// 既定は選択中の月だけ。月タブを移ったら期間もそこへ戻す (給与DB バーと同じ理由)
watch(month, (ym) => {
  kintaiRangeFrom.value = ym
  kintaiRangeTo.value = ym
}, { immediate: true })

/** 取り込む勤務月の一覧。期間が不正なら選択中の月だけ。 */
const kintaiTargetMonths = computed(() => {
  const range = monthRange(kintaiRangeFrom.value, kintaiRangeTo.value)
  return range.length ? range : [month.value]
})

interface KintaiFetchResult {
  month: string
  rows: number
  drivers: number
  summaries_updated: number
  warnings?: string[]
}

/**
 * 勤怠を取り込む。**冪等** — 同じ内容なら R2 の版は増えず lastVerifiedAt だけ進む。
 * 複数月は逐次に投げる (per-comp DO で直列化されるので並列にしても速くならない)。
 */
async function fetchKintai() {
  if (!session.value) return
  const months = kintaiTargetMonths.value
  fetchingKintai.value = true
  kintaiMessage.value = ''
  pageError.value = ''
  const done: KintaiFetchResult[] = []
  try {
    for (const ym of months) {
      kintaiMessage.value = months.length > 1
        ? `${fmtYm(ym)} を取り込んでいます… (${done.length + 1}/${months.length})`
        : `${fmtYm(ym)} を取り込んでいます…`
      const res = await $fetch<KintaiFetchResult>('/restraint-api/kintai/fetch', {
        method: 'POST',
        headers: authHeaders(),
        query: { month: ym },
      })
      done.push(res)
    }
    const rows = done.reduce((n, r) => n + r.rows, 0)
    const updated = done.reduce((n, r) => n + r.summaries_updated, 0)
    const warnings = done.flatMap(r => r.warnings ?? [])
    kintaiMessage.value
      = `${months.length} ヶ月 / ${rows} 行を取り込みました (サマリ更新 ${updated} 件)`
        + (warnings.length ? ` — 警告 ${warnings.length} 件: ${warnings.slice(0, 3).join(' / ')}` : '')
    // **取り込んだ月のキャッシュを全部捨てる**。`loadWageReport` は選択中の月しか
    // 捨てないので、期間取り込みの後に期間サマリー・一括印刷を開くと、選択中の月
    // 以外は取り込み前の数字のまま出る (2026-07-26 実測: 4〜5月を再取り込みしたのに
    // 公休が空欄・夜勤者が自主出勤のままで、リロードして初めて直った)
    for (const ym of months) reportCache.delete(ym)
    // 表は wage-report 由来なので取り込み後に読み直す
    await loadWageReport()
  }
  catch (e) {
    handleApiError(e)
    kintaiMessage.value = ''
  }
  finally {
    fetchingKintai.value = false
  }
}

// ---------------------------------------------------------------------------
// オンプレ vs Supabase 比較タブ (Refs #615-5)
// ---------------------------------------------------------------------------
// サーバ側の4口 (#618) は完成済み。ここは表示 + 取り直し3ボタンの二段階UIだけ。
// **原因を断定しない** (docs/plan-615-onprem-gcp-diff.md 決定1) — 差の5区分と
// 観測値、「どの操作で直りうるか」という処方の候補までを出し、「押せば直る」とは
// 書かない (保証の有無は MySQL 取り直しが対象ごとに別に持つ)。

const gcpDiffLoading = ref(false)
const gcpDiffError = ref('')

// 突合結果のキャッシュ (Refs #620-3)。フル突合 (`/kintai/diff`、約50秒) は
// 「取り直す」ボタンを押した時だけ叩く (自動では走らせない) — 画面に自動で
// 出すのは R2 read だけの軽い口 (`/kintai/diff-cache`) から読んだ保存分。
// 「未確認」「読めなかった」「確認済み (差0件を含む)」の3状態を混同しないため、
// 表示は summary/observations 単体ではなく必ずこの `KintaiDiffCacheState` 経由で扱う
// (kintai-diff-view.ts の docs 参照)。
const gcpDiffCacheState = ref<KintaiDiffCacheState>({ status: 'none' })
const gcpDiffCacheLoading = ref(false)

// テンプレートでの discriminated union の絞り込みは vue-tsc で効かないことがあるため、
// 表示用に平らな computed へ分ける (ローカル変数に一度受けてから絞り込む — 同じ式内で
// `.value` を読み直す形は絞り込みが効かないことがある)
const gcpDiffSummary = computed(() => {
  const state = gcpDiffCacheState.value
  return state.status === 'ok' ? state.summary : null
})
const gcpDiffObservations = computed(() => {
  const state = gcpDiffCacheState.value
  return state.status === 'ok' ? state.observations : null
})
const gcpDiffObservationsError = computed(() => {
  const state = gcpDiffCacheState.value
  return state.status === 'ok' ? state.observationsError : null
})
const gcpDiffCacheHeadline = computed(() => fmtKintaiDiffCacheHeadline(gcpDiffCacheState.value))

const gcpDiffPrescriptions = computed<KintaiDiffPrescription[]>(() =>
  buildKintaiDiffPrescriptions(gcpDiffSummary.value, gcpDiffObservations.value))

// 取り込み漏れ候補との突き合わせ (Refs #633-1)。値差の items は**ライブ取得
// (「取り直す」を押した直後) にしか無い** — 保存分のキャッシュ読み込み
// (loadGcpDiffCache) では触らない。まだライブ取得していない/読めなかった月は
// 「未確認」のまま (`KintaiCandidateDiffItemsState` の3状態、kintai-candidate-diff.ts
// の docs 参照)。
const gcpDiffItemsState = ref<KintaiCandidateDiffItemsState>({ status: 'none' })

/** 候補1件 (乗務員CD + 運行NO) ぶんの突き合わせ結果。 */
function candidateDiffFor(driverCd: string, unkoNo: string): KintaiCandidateDiffResult {
  return lookupKintaiCandidateDiff(driverCd, unkoNo, gcpDiffItemsState.value)
}

// 5区分の明細 (Refs #633-6): 「38件ある」まで分かっても、どの乗務員のどの日かが
// 画面から辿れないという指摘に応える。値差 items (gcpDiffItemsState、#633-1) と
// 同じ理由で**ライブ応答にしか乗らない** — 保存分のキャッシュだけを読んでいる状態
// (gcpDiffCacheState が cache 由来) では 'none'/'unreadable' のまま残し、
// 「明細は取り直すと出ます」と表示する (「差はありません」に化けさせない)。
const gcpDiffCategoryItemsState = ref<
  { status: 'none' } | { status: 'unreadable' } | { status: 'ok', categories: KintaiDiffCategoryItems[] }
>({ status: 'none' })

/** テンプレートでの discriminated union の絞り込みは vue-tsc で効かないことがあるため
 * (このファイル冒頭 `gcpDiffSummary` 等と同じ理由)、`row.kind` で分岐する処理は
 * ここ (plain な .ts 関数) で済ませ、テンプレートには `side`/フィールド行だけを渡す。 */
interface KintaiDiffCategoryRowView {
  driverCd: string
  date: string
  start: string
  /** `null` は value_diff 行 (両側の値を持つ)。非 null は one_sided 行 (片側のみ)。 */
  side: 'gcp' | 'onprem' | null
  valueDiffFieldRows: KintaiDiffValueDiffFieldRow[]
  oneSidedFieldRows: KintaiDiffOneSidedFieldRow[]
}

function toKintaiDiffCategoryRowView(row: KintaiDiffCategoryItemRow): KintaiDiffCategoryRowView {
  if (row.kind === 'value_diff') {
    return {
      driverCd: row.driverCd,
      date: row.date,
      start: row.start,
      side: null,
      valueDiffFieldRows: kintaiDiffValueDiffFieldRows(row),
      oneSidedFieldRows: [],
    }
  }
  return {
    driverCd: row.driverCd,
    date: row.date,
    start: row.start,
    side: row.side,
    valueDiffFieldRows: [],
    oneSidedFieldRows: kintaiDiffOneSidedFieldRows(row.values),
  }
}

/** `KINTAI_DIFF_CATEGORIES` の `key` → 表示用行、の形にまとめた computed。
 * `gcpDiffCategoryItemsState` が `ok` でなければ空 (テンプレート側は
 * `gcpDiffCategoryItemsState.status` を先に見て「取り直すと出ます」を出すため、
 * ここが空でも「差が無い」と読まれることはない)。 */
const gcpDiffCategoryItemsByKey = computed<Record<string, KintaiDiffCategoryRowView[]>>(() => {
  const state = gcpDiffCategoryItemsState.value
  if (state.status !== 'ok') return {}
  const out: Record<string, KintaiDiffCategoryRowView[]> = {}
  for (const c of state.categories) out[c.key] = c.rows.map(toKintaiDiffCategoryRowView)
  return out
})

// ---- 突合明細から運行1件をalcへ上げ直す (Refs #633-17) ----
// ★ 自動実行しない・複数運行あっても自動で1件を選ばない (親判断1,2、
// day-events-lookup の ambiguous と同じ理由)。「運行を引く」を押した行にだけ、
// その日の運行を全部並べる。「alcへ上げ直す」は運行1件ごとのボタンで、押した
// ときだけ叩く。5区分すべての行 (driverCd+date を持つ) がこの1本を共有する。

interface DiffRowDayOperationsState {
  status: 'loading' | 'ok' | 'error'
  operations: KintaiDayOperation[]
  error: string
}

/** key は `driverCd|date`。同じ乗務員・同じ日の行が複数区分に跨っても
 * 1回引けば全区分で共有できる。 */
const diffRowDayOperations = ref<Map<string, DiffRowDayOperationsState>>(new Map())

function diffRowKey(driverCd: string, date: string): string {
  return `${driverCd}|${date}`
}

function diffRowDayOperationsFor(driverCd: string, date: string): DiffRowDayOperationsState | null {
  return diffRowDayOperations.value.get(diffRowKey(driverCd, date)) ?? null
}

/** 「運行を引く」ボタン。読むだけ・副作用なし・何度でも安全 (day-events-lookup
 * と同じ設計)。 */
async function lookupDayOperationsForDiffRow(driverCd: string, date: string) {
  const key = diffRowKey(driverCd, date)
  diffRowDayOperations.value.set(key, { status: 'loading', operations: [], error: '' })
  try {
    const res = await $fetch<unknown>('/restraint-api/kintai/day-operations', {
      headers: authHeaders(),
      query: { driver_cd: driverCd, date },
    })
    const parsed = parseKintaiDayOperations(res)
    diffRowDayOperations.value.set(key, { status: 'ok', operations: parsed.operations, error: '' })
  }
  catch (e) {
    diffRowDayOperations.value.set(key, { status: 'error', operations: [], error: restraintErrorMessage(e) })
  }
}

interface DiffRowAlcUploadState {
  status: 'loading' | 'ok' | 'error'
  result: KintaiAlcUploadResult | null
  error: string
}

/** key は unkoNo (運行ごとに一意)。 */
const diffRowAlcUpload = ref<Map<string, DiffRowAlcUploadState>>(new Map())

function diffRowAlcUploadFor(unkoNo: string): DiffRowAlcUploadState | null {
  return diffRowAlcUpload.value.get(unkoNo) ?? null
}

/** 運行1件をalcへ上げ直す (書き込み。preview は無い — `dtako-alc-upload.ts` の
 * module doc 参照)。**同じ運行を続けて2回押せないよう、投入中はボタン側で
 * disabled にする** (親判断7 — 並列に叩くと同一comp_idのtheearthセッション
 * ロックでhang/500になり得る、呼び出し側は `diffRowAlcUploadFor(...)?.status
 * === 'loading'` を見て disabled を出す)。畳み直し (fold) はここではしない —
 * 応答表示側で別途案内する (親判断6)。 */
async function uploadOperationToAlc(op: KintaiDayOperation) {
  if (diffRowAlcUploadFor(op.unkoNo)?.status === 'loading') return
  diffRowAlcUpload.value.set(op.unkoNo, { status: 'loading', result: null, error: '' })
  try {
    const res = await $fetch<unknown>('/restraint-api/kintai/alc-upload', {
      method: 'POST',
      headers: authHeaders(),
      body: { ope_no: op.opeNo, start_ope: op.startOpe },
    })
    diffRowAlcUpload.value.set(op.unkoNo, { status: 'ok', result: parseKintaiAlcUploadResult(res), error: '' })
  }
  catch (e) {
    diffRowAlcUpload.value.set(op.unkoNo, { status: 'error', result: null, error: restraintErrorMessage(e) })
  }
}

/** alcへ上げ直した後の「畳み直しが別途必要」案内から、既存の畳み直しセクション
 * (`jumpToGcpFold` と同じ id) へスクロールするだけ — 新しい畳み直しボタンは
 * 作らない (親判断6)。既にこのタブ・この月を見ている前提なので、tab/month の
 * 切り替えはしない。 */
function scrollToFoldSection() {
  if (import.meta.client) {
    document.getElementById('gcp-fold-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

/** テンプレートでの discriminated union の絞り込みは vue-tsc で効かないことがあるため
 * (このファイル冒頭 `gcpDiffSummary` 等と同じ理由)、表示用に平らな形へ潰す。
 * `fieldRows` は `match`/`mismatch` 以外では空配列、`side` は `one_sided` 以外では
 * `null` (テンプレート側で `.length`/`!== null` だけ見ればよい)。 */
interface UnkoGapCandidateDiffView {
  kind: KintaiCandidateDiffResult['kind']
  /** `MM-DD` 表示用 (day_absent/one_sided の文言に使う)。運行NOの桁数が不正で
   * 運行日を作れなかった場合だけ null。 */
  dayShort: string | null
  lastVerified: string | null
  fieldRows: KintaiCandidateDiffFieldRow[]
  side: 'gcp' | 'onprem' | null
}

function candidateDiffViewFor(driverCd: string, unkoNo: string): UnkoGapCandidateDiffView {
  const result = candidateDiffFor(driverCd, unkoNo)
  const lastVerified = result.kind === 'unconfirmed' ? null : fmtKintaiDiffLastVerified(result.lastVerifiedAt)
  const fieldRows = result.kind === 'match' || result.kind === 'mismatch' ? kintaiCandidateDiffFieldRows(result.item) : []
  const side = result.kind === 'one_sided' ? result.side : null
  const dayShort = result.date ? result.date.slice(5) : null
  return { kind: result.kind, dayShort, lastVerified, fieldRows, side }
}

/** 保存済みスナップショットだけを読む軽い口 (R2 read のみ、突合は実行しない)。
 * タブを開いた/月を変えた時に自動で叩いてよい (Refs #620-3)。 */
async function loadGcpDiffCache() {
  if (!month.value) return
  gcpDiffCacheLoading.value = true
  try {
    const res = await $fetch<unknown>('/restraint-api/kintai/diff-cache', {
      headers: authHeaders(),
      query: { month: month.value },
    })
    gcpDiffCacheState.value = parseKintaiDiffCacheState(res)
  }
  catch {
    // 保存分の読み出し自体が失敗 (ネットワーク等) — 「未確認」と混同しないよう
    // 「読めなかった」扱いにする。「取り直す」ボタン自体は生きているので、
    // ここではエラーメッセージを別途出さない (他の自動読み込み系バッジと同じ
    // 「静かに諦める」扱い)。
    gcpDiffCacheState.value = { status: 'unreadable' }
  }
  finally {
    gcpDiffCacheLoading.value = false
  }
}

/** フル突合 (約50秒)。**「取り直す」ボタンを押した時だけ**叩く — 自動では走らせない。 */
async function loadGcpDiff() {
  if (!month.value) return
  gcpDiffLoading.value = true
  gcpDiffError.value = ''
  try {
    const res = await $fetch<unknown>('/restraint-api/kintai/diff', {
      headers: authHeaders(),
      query: { month: month.value },
    })
    const parsed = parseKintaiDiffApiResponse(res)
    // 保存直後の値をそのまま「最終確認」表示に反映する — 二度目の read
    // (`/kintai/diff-cache`) を打たない (Refs #620-3)。
    gcpDiffCacheState.value = kintaiDiffCacheStateFromLiveResult(parsed)
    // 値差の items + compared_days (取り込み漏れ候補との突き合わせ用、Refs #633-1/#633-3)
    // はライブ応答にしか乗っていない — ここで拾う。`parsed.summary` が無い (壊れた応答)
    // 場合は「読めなかった」扱いにし、「差はありません」に化けさせない。
    // `dayCoverage` は `compared_days` が応答に無ければ (古いキャッシュ・将来の形変更)
    // `null` になる — `lookupKintaiCandidateDiff` がそれを「未確認」に倒す
    // (compared_days を「一致した日」と誤読しないための必須の一手間、Refs #633-3)。
    gcpDiffItemsState.value = parsed.summary
      ? {
          status: 'ok',
          items: parseKintaiDiffValueDiffItemsFromResponse(res),
          dayCoverage: buildKintaiCandidateDayCoverage(parseKintaiDiffDayCoverageFromResponse(res)),
          lastVerifiedAt: parsed.lastVerifiedAt,
        }
      : { status: 'unreadable' }
    // 5区分の明細 (Refs #633-6)。上と同じ理由でライブ応答にしか乗らない。
    gcpDiffCategoryItemsState.value = parsed.summary
      ? { status: 'ok', categories: parseKintaiDiffCategoryItemsFromResponse(res) }
      : { status: 'unreadable' }
  }
  catch (e) {
    // 失敗しても直前まで表示していた保存分 (gcpDiffCacheState/gcpDiffItemsState) は
    // そのまま残す — 「取り直しに失敗した」ことと「差が消えた」ことは別なので、
    // 古い値を黙って消さない (エラーはアラートで別途出す)。
    gcpDiffError.value = restraintErrorMessage(e)
  }
  finally {
    gcpDiffLoading.value = false
  }
}

// 月が変わったら前の結果を消す (「タイムカード照合」タブと同じ理由 — 別月の
// 差分・保証が残ると誤読する)。gcpDiffCacheState/gcpDiffItemsState も同時に消す —
// 前の月の「最終確認: …」や値差 items を新しい月の候補と突き合わせてはいけない
// (Refs #620-3 やること★、#633-1 も同型)。
watch(month, () => {
  gcpDiffError.value = ''
  gcpDiffCacheState.value = { status: 'none' }
  gcpDiffItemsState.value = { status: 'none' }
  gcpDiffCategoryItemsState.value = { status: 'none' }
  // 別月の明細行に対する「運行を引く」「alcへ上げ直す」の結果も同時に消す
  // (driverCd+date/unkoNo は月をまたいで衝突しうるため、Refs #633-17)。
  diffRowDayOperations.value = new Map()
  diffRowAlcUpload.value = new Map()
})

// このタブを見ている間だけ、タブを開いた/月が変わるたびに保存分を自動で読み直す
// (R2 read だけの軽い口、Refs #620-3)。フル突合はここでは絶対に叩かない。
watch([activeTab, month], ([tab]) => {
  if (tab === 'gcpdiff') loadGcpDiffCache()
}, { immediate: true })

// ---- ① 打刻の運び直し (窓ぶん。続きは無い、1回で運びきる) ----

const timecardRefreshPreview = ref<KintaiWindowReportView | null>(null)
const timecardRefreshLoading = ref(false)
const timecardRefreshError = ref('')

async function callTimecardRefresh(apply: boolean) {
  timecardRefreshLoading.value = true
  timecardRefreshError.value = ''
  try {
    const res = await $fetch<unknown>('/restraint-api/kintai/refresh/timecard', {
      method: 'POST',
      headers: authHeaders(),
      query: apply ? { month: month.value, apply: true } : { month: month.value },
    })
    timecardRefreshPreview.value = parseKintaiWindowReport(res)
  }
  catch (e) {
    timecardRefreshError.value = restraintErrorMessage(e)
  }
  finally {
    timecardRefreshLoading.value = false
  }
}

/** まず dry-run で「何件変わるか」を見せる (既定 apply なし)。 */
function previewTimecardRefresh() {
  timecardRefreshPreview.value = null
  callTimecardRefresh(false)
}

/** **preview (dry-run) を経由した後だけ**実行できる (いきなり apply しない、やること4)。
 * 一度実行すると `dryRun: false` に変わるので、続けて押しても弾く — 再実行するには
 * もう一度「確認」を押させる (fold の二段階と同じ安全策)。 */
function applyTimecardRefresh() {
  if (!timecardRefreshPreview.value || !timecardRefreshPreview.value.dryRun) return
  callTimecardRefresh(true)
}

watch(month, () => {
  timecardRefreshPreview.value = null
  timecardRefreshError.value = ''
})

// ---- ② GCP 側の畳み直し (fold recalc)。next_after_driver_cd が null になるまで
//      **front が回し切る** (やること4)。1ページ = 最大50人 (受け側の既定)。 ----

const foldStaleOnly = ref(false)
const foldProgress = ref<KintaiFoldProgress | null>(null)
const foldRunning = ref(false)
const foldError = ref('')
/** true なら直前のループが apply=true (実行) だった。preview と実行を UI で区別する。 */
const foldApplied = ref(false)

async function fetchFoldPage(afterDriverCd: number | undefined, apply: boolean): Promise<KintaiFoldPageView> {
  const query: Record<string, string | number | boolean> = { month: month.value }
  if (afterDriverCd !== undefined) query.after_driver_cd = afterDriverCd
  if (foldStaleOnly.value) query.stale_only = true
  if (apply) query.apply = true
  const res = await $fetch<unknown>('/restraint-api/kintai/refresh/fold', {
    method: 'POST',
    headers: authHeaders(),
    query,
  })
  return parseKintaiFoldPage(res)
}

/** ページングの本体。preview (apply=false) にも実行 (apply=true) にも使う共通処理。
 * `next_after_driver_cd` が返る限り、前ページの値を `after_driver_cd` に積んで叩き直す。 */
async function runFoldPaging(apply: boolean) {
  foldRunning.value = true
  foldError.value = ''
  foldApplied.value = apply
  let progress = foldProgressInitial()
  foldProgress.value = progress
  let after: number | undefined
  try {
    // 安全弁: 応答が壊れて next_after_driver_cd が回らなくても無限ループにしない
    // (50人/ページ × 200 = 1万人ぶん。実在の乗務員数を大きく超える)
    for (let i = 0; i < 200; i++) {
      const page = await fetchFoldPage(after, apply)
      progress = foldProgressAppend(progress, page)
      foldProgress.value = progress
      if (page.nextAfterDriverCd === null) break
      after = page.nextAfterDriverCd
    }
  }
  catch (e) {
    foldError.value = restraintErrorMessage(e)
  }
  finally {
    foldRunning.value = false
  }
}

/** まず dry-run で全ページ回し、合計「何件変わるか」を見せる。 */
function previewFoldRefresh() {
  runFoldPaging(false)
}

/** **preview (回しきった dry-run) を経由した後だけ**実行できる。 */
function applyFoldRefresh() {
  if (!foldProgress.value || foldApplied.value) return
  runFoldPaging(true)
}

watch(month, () => {
  foldProgress.value = null
  foldError.value = ''
  foldApplied.value = false
})

// ---- ③ MySQL (dtako) 側の取り直し。運行1件 (unko_no) 単位。
//      「押しても直る保証」の有無を必ず併記する (やること5) ----

const mysqlRefreshUnkoNo = ref('')
/** 保証判定 (guarantee) 用の任意入力。両方揃ったときだけサーバが判定する。 */
const mysqlRefreshDriverCd = ref('')
const mysqlRefreshResetTimecard = ref(false)
const mysqlRefreshPreview = ref<KintaiRefreshMysqlPreview | null>(null)
const mysqlRefreshLoading = ref(false)
const mysqlRefreshError = ref('')
const mysqlRefreshApplyResult = ref('')

const mysqlRefreshGuaranteeText = computed(() => fmtKintaiRefreshMysqlGuarantee(mysqlRefreshPreview.value))

async function postMysqlRefresh(apply: boolean) {
  const driverCd = mysqlRefreshDriverCd.value.trim()
  return $fetch<unknown>('/restraint-api/kintai/refresh/mysql', {
    method: 'POST',
    headers: authHeaders(),
    body: {
      unko_no: mysqlRefreshUnkoNo.value.trim(),
      // driver_cd/month は保証判定にしか使わない (サーバ側は両方揃った時だけ判定する)。
      // 片方だけ送っても判定されないだけで、実行の可否には影響しない
      driver_cd: driverCd || undefined,
      month: driverCd ? month.value : undefined,
      reset_timecard: mysqlRefreshResetTimecard.value,
      apply,
    },
  })
}

async function previewMysqlRefresh() {
  if (!mysqlRefreshUnkoNo.value.trim()) return
  mysqlRefreshLoading.value = true
  mysqlRefreshError.value = ''
  mysqlRefreshApplyResult.value = ''
  mysqlRefreshPreview.value = null
  try {
    mysqlRefreshPreview.value = parseKintaiRefreshMysqlPreview(await postMysqlRefresh(false))
  }
  catch (e) {
    mysqlRefreshError.value = restraintErrorMessage(e)
  }
  finally {
    mysqlRefreshLoading.value = false
  }
}

/** **preview を経由した後だけ**実行できる。保証が無くても実行はブロックしない
 * (サーバ側もブロックしていない、決定2) — 実行の可否と保証の有無は別軸。
 * 実行後は preview を消す — 続けて押しても再実行させない (再実行するにはもう一度
 * 「確認」を押させる、fold/timecard と同じ安全策)。 */
async function applyMysqlRefresh() {
  if (!mysqlRefreshPreview.value) return
  mysqlRefreshLoading.value = true
  mysqlRefreshError.value = ''
  try {
    const res = parseKintaiRefreshMysqlApplyResult(await postMysqlRefresh(true))
    mysqlRefreshApplyResult.value
      = `取得 ${res.bytes ?? '?'} bytes / ${res.entriesCount ?? '?'} ファイル、`
        + `push応答 ${res.httpStatus ?? '?'} (取込 ${res.autoloadHttpStatus ?? '?'}`
        + (mysqlRefreshResetTimecard.value ? ` / 再登録 ${res.resetHttpStatus ?? '?'}` : '')
        + ')'
    mysqlRefreshPreview.value = null
  }
  catch (e) {
    mysqlRefreshError.value = restraintErrorMessage(e)
  }
  finally {
    mysqlRefreshLoading.value = false
  }
}

// ---- ②の後、取り込み漏れ候補 (22桁) から実物の23桁を引く (Refs #625) ----
// ★ CSV を解凍して読む必要はない — ②(上のボタン)で取り込んだ直後は、その運行は
// オンプレに存在するので、乗務員CD+日付 (day-events) で引ける。②を再実行しない
// 読むだけの口なので、何回でも安全に呼べる — ②直後に反映されるかは未確認
// (親の0段目コメント参照) なので、ここでは自動リトライをしない。「①②実行」→
// 「引く」→ 見つからなければ時間をおいてもう一度「引く」を人が判断して押す。

const dayEventsLookup = ref<DayEventsLookup | null>(null)
const dayEventsLookupLoading = ref(false)
const dayEventsLookupError = ref('')

const mysqlRefreshUnkoNoIs22Digit = computed(() => /^\d{22}$/.test(mysqlRefreshUnkoNo.value.trim()))

async function lookupDayEventsForMysqlRefreshCandidate() {
  const opeNo = mysqlRefreshUnkoNo.value.trim()
  const driverCd = mysqlRefreshDriverCd.value.trim()
  if (!/^\d{22}$/.test(opeNo) || !driverCd) return
  dayEventsLookupLoading.value = true
  dayEventsLookupError.value = ''
  dayEventsLookup.value = null
  try {
    const res = await $fetch<unknown>('/restraint-api/kintai/day-events-lookup', {
      headers: authHeaders(),
      query: { driver_cd: driverCd, ope_no: opeNo },
    })
    dayEventsLookup.value = parseDayEventsLookup(res)
  }
  catch (e) {
    dayEventsLookupError.value = restraintErrorMessage(e)
  }
  finally {
    dayEventsLookupLoading.value = false
  }
}

/** 引いた23桁 (found、または ambiguous の中から人が選んだ1件) を運行NO欄へ渡す。
 * **自動では選ばない** — この関数は人がクリックしたときだけ呼ばれる。 */
function useDayEventsLookupUnkoNo(unkoNo: string | null) {
  if (!unkoNo) return
  mysqlRefreshUnkoNo.value = unkoNo
}

// 対象 (unko_no) を変えたら古い preview / lookup 結果を消す (別対象の保証・
// 別対象の23桁候補を見せ続けない)
watch(mysqlRefreshUnkoNo, () => {
  mysqlRefreshPreview.value = null
  mysqlRefreshApplyResult.value = ''
  dayEventsLookup.value = null
  dayEventsLookupError.value = ''
})
watch(month, () => {
  mysqlRefreshPreview.value = null
  mysqlRefreshApplyResult.value = ''
})

// ---- 取り込み漏れ候補の運行NO一覧 (Refs #623-2) ----
// ★ この口は遅い (alc への etags 往復を含む、所要時間の保証なし)。**自動実行しない** —
// 「運行NO を出す」ボタンを押したときだけ叩く。押すと乗務員ごとに運行NOを一覧し、
// 各行の「①② の欄に入れる (22桁)」で③のフォーム (①②の欄を共用) へ値を渡す —
// ③自体は実行しない、22桁のままなので③は拒否される (自動実行はしない、人が確認して
// から「① 確認」を押す)。

const unkoGapsResult = ref<KintaiUnkoGaps | null>(null)
const unkoGapsLoading = ref(false)
const unkoGapsError = ref('')
const unkoGapsLoaded = ref(false)

const unkoGapsReadability = computed(() => unkoGapsResult.value ? kintaiUnkoGapsReadability(unkoGapsResult.value) : null)
const unkoGapsDriverTotal = computed(() => unkoGapsResult.value ? kintaiUnkoGapsDriverTotalCount(unkoGapsResult.value) : 0)

// ---- 候補ごとの「オンプレにデジタコが在るか」チェック (Refs #633-1 条件8〜14) ----
// ★ 親の実測 (2026-08-04) で確定した原因への対応 — unko-gaps の候補は
// `time_card_dtako` の有無しか見ておらず、デジタコ自体 (`dtako_events`) は
// 取り込み済みでも候補に出る (1445 の実例)。**新しい判定はしない** —
// 既存の口 (day-events-lookup) の `status` をそのまま3値に倒すだけ
// (`kintai-unko-gaps.ts` の `kintaiUnkoGapDtakoCheckResultFromLookup` docs 参照)。
// **押した時だけ、候補を直列で1件ずつ**引く (自動実行しない、やること9)。
const dtakoPresenceResults = ref<Map<string, KintaiUnkoGapDtakoCheckResult>>(new Map())
const dtakoPresenceChecking = ref(false)
const dtakoPresenceProgress = ref<{ done: number, total: number } | null>(null)

function dtakoPresenceKey(driverCd: string, unkoNo: string): string {
  return `${driverCd}|${unkoNo}`
}

/** 候補1件ぶんの表示 (未実行/ambiguous/エラーは全部「調べられていない」に倒す —
 * `kintaiUnkoGapDtakoCheckView` の docs 参照、やること12)。 */
function dtakoPresenceViewFor(driverCd: string, unkoNo: string) {
  return kintaiUnkoGapDtakoCheckView(dtakoPresenceResults.value.get(dtakoPresenceKey(driverCd, unkoNo)))
}

/** 候補一覧 (乗務員ごとの unkoNos) 全件を、直列で1件ずつ day-events-lookup へ
 * 投げる。**「候補一覧の下の一括ボタン」からのみ呼ばれる** — 自動実行はしない。 */
async function checkDtakoPresenceForAllCandidates() {
  if (!unkoGapsResult.value || dtakoPresenceChecking.value) return
  const candidates: Array<{ driverCd: string, unkoNo: string }> = []
  for (const d of unkoGapsResult.value.drivers) {
    for (const no of d.unkoNos) candidates.push({ driverCd: d.driverCd, unkoNo: no })
  }
  if (!candidates.length) return
  dtakoPresenceChecking.value = true
  dtakoPresenceProgress.value = { done: 0, total: candidates.length }
  for (const c of candidates) {
    const key = dtakoPresenceKey(c.driverCd, c.unkoNo)
    try {
      const res = await $fetch<unknown>('/restraint-api/kintai/day-events-lookup', {
        headers: authHeaders(),
        query: { driver_cd: c.driverCd, ope_no: c.unkoNo },
      })
      const lookup = parseDayEventsLookup(res)
      dtakoPresenceResults.value.set(
        key,
        kintaiUnkoGapDtakoCheckResultFromLookup(lookup.status, lookup.unkoNo, lookup.candidates),
      )
    }
    catch {
      // 1件の失敗で全体を止めない — この候補だけ「調べられていない」に倒し、続きを回す。
      dtakoPresenceResults.value.set(key, { status: 'inconclusive', unkoNo23: null, candidates: [] })
    }
    dtakoPresenceProgress.value = { done: (dtakoPresenceProgress.value?.done ?? 0) + 1, total: candidates.length }
  }
  dtakoPresenceChecking.value = false
}

async function loadUnkoGaps() {
  if (!month.value) return
  unkoGapsLoading.value = true
  unkoGapsError.value = ''
  // 新しく候補を取り直すと乗務員CD/運行NOの組が変わりうるため、前回のチェック結果は
  // 古い候補と紐付かない — 一緒に消す。
  dtakoPresenceResults.value = new Map()
  dtakoPresenceProgress.value = null
  try {
    const res = await $fetch<unknown>('/restraint-api/kintai/unko-gaps', {
      headers: authHeaders(),
      query: { month: month.value },
    })
    unkoGapsResult.value = parseKintaiUnkoGaps(res)
    unkoGapsLoaded.value = true
  }
  catch (e) {
    unkoGapsResult.value = null
    unkoGapsLoaded.value = false
    unkoGapsError.value = restraintErrorMessage(e)
  }
  finally {
    unkoGapsLoading.value = false
  }
}

watch(month, () => {
  unkoGapsResult.value = null
  unkoGapsLoaded.value = false
  unkoGapsError.value = ''
  dtakoPresenceResults.value = new Map()
  dtakoPresenceProgress.value = null
})

/**
 * 候補の行から③のフォームへ値を渡す (Refs #623-2、親判断 2026-08-03 — 一度 (b) に
 * 差し替えたが、オンプレ側の実コード確認で前提が変わり (a) に戻した)。
 * **自動実行はしない** — 欄に値が入るだけで、「① 確認」は人が押す。
 *
 * ★ 渡すのは受け口が返す **22桁 (GCP側)** の運行NOそのまま。23桁 (オンプレ側、
 * 末尾1桁 = 対象CD) を機械的に作って捏造することはしない。
 *
 * `rust-ichibanboshi` の `dtako_autoload.rs::parse_unko_no` は12桁以上の数字を
 * 通す (22桁の実例をテストが確認済み) — **① (zip取得) と ② (オンプレ取り込み) は
 * 22桁のまま実行できる** (`unko_no` は取り込み対象を決める鍵ではなく歯止め・監査
 * ラベル、対象を決めているのは zip の中身)。**23桁が本当に要るのは
 * ③ (勤務時間再登録、`resetby-unko-no/{unko_no}`) だけ** — 対象CDで2マンの
 * 何人目かを表すため、無いと別の乗務員の行を指す。
 *
 * relay側のガード (`isUnkoNoAcceptable`) は reset_timecard の有無で必要桁数を
 * 分けている (#625/#627、マージ済み) — 22桁のまま渡しても①②はそのまま実行できる。
 *
 * ★ ②実行後は、`lookupDayEventsForMysqlRefreshCandidate` (Refs #625) で実物の
 * 23桁を引ける — ②でオンプレに生まれた運行を day-events (乗務員CD+日付) から
 * 引くだけで、CSVを解凍して読む必要はない。見つかった23桁を運行NO欄に入れ直せば
 * 「勤務時間再登録まで行う」を使える。
 */
function applyUnkoGapCandidateToMysqlForm(driverCd: string, unkoNo: string) {
  mysqlRefreshUnkoNo.value = unkoNo
  mysqlRefreshDriverCd.value = driverCd
  if (import.meta.client) {
    document.getElementById('gcp-mysql-refresh-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

/**
 * 明細 (day-operations で引いた運行) の23桁 unkoNo を③のフォームへ渡す
 * (Refs #633-17b)。`applyUnkoGapCandidateToMysqlForm` と同じことを23桁でやる —
 * 違いは渡す桁数だけ (あちらは22桁のまま、こちらは day-operations が返す
 * 23桁をそのまま)。**自動実行はしない** — 欄に入れてスクロールするだけで、
 * ③ (勤務時間再登録) の実行は人が「勤務時間再登録まで行う」を確認してから押す。
 */
function applyDayOperationToMysqlResetForm(driverCd: string, unkoNo: string) {
  mysqlRefreshUnkoNo.value = unkoNo
  mysqlRefreshDriverCd.value = driverCd
  if (import.meta.client) {
    document.getElementById('gcp-mysql-refresh-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

// ---- 期間サマリー印刷 (Refs #443) ----
// タイムカード表は「1 人 1 枚 × 日別」なので、期間分の日数を突き合わせたい総務には
// 枚数が多すぎる。こちらは「1 ヶ月 1 枚 × 1 人 1 行」で、日別の打刻を出さない。

const summaryFrom = ref('')
const summaryTo = ref('')
/** `reports` は一覧の行を作った元の wage-report 行 (タイムカード由来のみ)。
 * 行クリックで日別表を出すのに日別サマリが要るので、一覧と一緒に持っておく
 * (再取得すると、見ている一覧と中身がずれうる)。 */
const summaryBatch = ref<Array<{ ym: string, rows: TimecardSummaryRow[], reports: WageReportRow[] }> | null>(null)
const summaryProgress = ref('')
const buildingSummary = ref(false)

// 期間の既定は選択中の月だけ (勤怠取り込みと同じ作法)
watch(month, (ym) => {
  summaryFrom.value = ym
  summaryTo.value = ym
}, { immediate: true })

const summaryTargetMonths = computed(() => {
  const range = monthRange(summaryFrom.value, summaryTo.value)
  return range.length ? range : [month.value]
})

/**
 * その勤務月の 乗務員CD → 給与明細の残業手当。
 *
 * 突合は給与比較タブと同じ `compareSalaryMonth` に任せる (社員マスタ経由の
 * 引き当て・同名別人の扱いを 2 箇所に持たない)。明細が未取り込みの月は空の Map で、
 * 列は空欄になる — **ここで給与DBを取りに行かない** (1 社 10〜20 秒かかるので、
 * 期間分を印刷ボタンに巻き込むと待たされる。取得は上部の給与DB バーの責務)。
 */
function salaryOvertimeMapFor(ym: string, rows: WageReportRow[]): Map<string, SalaryOvertime> {
  const map = new Map<string, SalaryOvertime>()
  const csvRows = (salaryParsed.value?.rows ?? []).filter(r => r.month === nextYm(ym))
  if (!csvRows.length) return map
  const compared = compareSalaryMonth(csvRows, rows, salaryItemConfig.value, salaryCdMap.value)
  for (const r of compared.rows) {
    map.set(String(Number(r.mappedDriverCd ?? r.driverCd)), { amount: r.csvOvertime, hours: r.csvOvertimeHours })
  }
  return map
}

/**
 * 期間サマリーを組んで**画面に開く** (印刷ダイアログは出さない、2026-07-26 要望)。
 *
 * 月次集計の一括印刷が即 `window.print()` するのと違い、こちらは中身を確かめてから
 * 印刷したい — 給与明細の取り込み漏れ (残業(給与) が空欄) や乗務員CD の絞り込み
 * ミスは、印刷ダイアログが被さった状態では気付けない。印刷はプレビュー上の
 * 「印刷」ボタンから。
 */
async function openTimecardSummary() {
  if (buildingSummary.value || !session.value) return
  buildingSummary.value = true
  pageError.value = ''
  try {
    // 区分と突合マスタが**揃ってから**組む。タブの watch でも読んでいるが、開いた
    // 直後にボタンを押されると間に合わず、残業(給与) が静かに 0 円になる
    // (未読込 = 全項目が既定区分に落ちる。給与比較との食い違いとして本番で露見)
    if (!salaryConfigLoaded.value) await loadSalaryItemConfig()
    if (!employeeMasterLoaded.value) await loadEmployeeMaster()
    const months = summaryTargetMonths.value
    const batch: Array<{ ym: string, rows: TimecardSummaryRow[], reports: WageReportRow[] }> = []
    for (const ym of months) {
      summaryProgress.value = `${fmtYm(ym)} を集計中... (${batch.length + 1}/${months.length})`
      const res = await fetchWageReport(ym)
      const timecard = res.rows.filter(r => r.source === 'timecard' && matchesTimecardFilter(r.summary.driverCd))
      const rows = buildTimecardSummary(
        timecard,
        Number(ym.slice(0, 4)),
        Number(ym.slice(5, 7)),
        salaryOvertimeMapFor(ym, res.rows),
        employmentByDriver.value,
      )
      batch.push({ ym, rows, reports: timecard })
    }
    summaryBatch.value = batch
    summaryProgress.value = ''
  }
  catch (e) {
    handleApiError(e)
    summaryProgress.value = ''
  }
  finally {
    buildingSummary.value = false
  }
}

// ---- 一覧の行クリック → その人のその月の日別表 (2026-07-26 要望) ----
// 一覧の数字が腑に落ちない時 (打刻エラー 2 日、有休 1.5 等) に、タブへ戻って月を
// 選び直さずその場で根拠を見られるようにする。**印刷には出さない** — 一覧を
// 印刷するための画面なので、開いたまま印刷しても紙は一覧のままにする。

const summaryDetail = ref<{ ym: string, driverCd: string } | null>(null)
const summaryDetailOpen = computed({
  get: () => summaryDetail.value !== null,
  set: (v: boolean) => { if (!v) summaryDetail.value = null },
})

/** 開いている日別表 (1 人分)。対象が見つからなければ null。 */
const summaryDetailSheet = computed(() => {
  const target = summaryDetail.value
  if (!target) return null
  const page = summaryBatch.value?.find(p => p.ym === target.ym)
  const row = page?.reports.find(r => r.summary.driverCd === target.driverCd)
  if (!row) return null
  const year = Number(target.ym.slice(0, 4))
  const monthNo = Number(target.ym.slice(5, 7))
  return {
    ym: target.ym,
    driverCd: row.summary.driverCd,
    driverName: row.summary.driverName,
    rows: buildTimecardTable(row.summary.days, year, monthNo),
    counts: countWorkKinds(row.summary.days),
  }
})

/** 計算単価の表示 ("@1,206")。null は空文字 (空 div は高さ 0 で潰れる)。 */
function fmtAt(rate: number | null): string {
  return rate == null ? '' : `@${fmtYen(rate)}`
}

/** 計算単価の表示 ("@1,206")。実額按分 (金額 ÷ 時間) が出せない時は空文字。 */
function fmtAtRate(pay: number | null, minutes: number): string {
  return fmtAt(ratePerHour(pay, minutes))
}

/** 実働 − 表に出ている区分時間の合計 (法定内 + 時間外 + 週40超過 + 時間外深夜 +
 * 法定休日(通常+深夜) + 法定外休日(通常+深夜))。週40超過は法定内から控除済み
 * (案B Refs #282) のため加算対象。**9 区分すべてを引く** (法定外休日を落としていて
 * 「表に出ていないのに差分が出る」状態だった、Refs #566)。0 以外 = 日別データ不整合か、
 * ここに無い区分へ分類された時間がある印 — 検算用 (Refs #282)。 */
function unaccountedMinutes(row: WageReportRow): number | null {
  const working = row.summary.workingMinutes
  if (working == null) return null
  const m = row.wage.minutes
  return working - (m.statutory + m.overtime + m.weekly40Excess + m.overtimeNight
    + m.legalHoliday + m.legalHolidayNight + m.nonLegalHoliday + m.nonLegalHolidayNight)
}

/**
 * その月に**法定外休日**の実働がある人が 1 人でも居るか (Refs #566)。
 *
 * 土曜は平日扱い (2026-07-18 決定) なので通常は 0 だが、**祝日・会社指定休に出勤した日**は
 * 打刻側の休日区分が `non_legal` になり、この区分へ入る (2026-01 の実測は成人の日の 1 名
 * 4h38m だけ)。金額は合計(計算)に入っているのに時間の列が無く、差分列にだけ姿を現していた。
 * **常時 1 列増やすと表が広がるので、有る月だけ出す。**
 */
const hasNonLegalHolidayWork = computed(() =>
  (report.value?.rows ?? []).some(r =>
    r.wage.minutes.nonLegalHoliday + r.wage.minutes.nonLegalHolidayNight > 0))

/** 最低賃金チェックの表の列数 (区画見出しの colspan 用)。 */
const minWageColumnCount = computed(() => (hasNonLegalHolidayWork.value ? 13 : 12))

/** 符号つき分表示 ("-1h30m")。fmtMinutes は負値を想定しないため絶対値に符号を付ける。 */
function fmtSignedMinutes(minutes: number | null): string {
  if (minutes == null) return '-'
  return (minutes < 0 ? '-' : '') + fmtMinutes(Math.abs(minutes))
}

/** null 許容の加算 (両方 null なら null、片方だけ null は 0 扱い)。
 * 給与明細の「残業代」は通常残業+深夜残業をまとめた 1 項目のため、
 * 実データとの比較用に合計を出す。 */
function sumNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null
  return (a ?? 0) + (b ?? 0)
}

const missingRateRows = computed(() => (report.value?.rows ?? []).filter(r => r.wage.hourlyRate === null))

/** 月次集計テーブルを CSV (UTF-8 BOM) で保存する (全列)。
 *
 * `所属(マスタ)`・`給与体系` は社員マスタ (D1) 由来 — 乗務員CD で逆引きし、
 * **対象月の末日時点**で効いている属性行を採る (`buildDriverAttrIndex`、Refs #367)。
 * 未突合・未設定は空欄。dtako 由来の `事業所` 列は別ソース (summary) なので残す。
 * 複数会社に在籍する人は `joinDriverAttr` で連結表示する (Refs #403)。 */
function downloadMonthlyCsv() {
  if (!report.value) return
  const attrIndex = buildDriverAttrIndex(employeeMaster.value, report.value.month)
  const header = [
    '年月', '乗務員CD', '氏名', '事業所', '所属(マスタ)', '給与体系', '稼働日数', '休日数',
    '運転', '荷役', '休憩', '拘束合計', '年度累計(前月まで)', '当月超過', '15時間超過日数', '平均運転9h超過回数',
    // 時間区分は画面 (月次集計・最低賃金チェック) と同じ classifyMonth の結果を出す
    '実働', '時間外', '週40超過', '深夜', '時間外深夜', '法定休日', '法定休日深夜', '法定外休日', '法定外休日深夜', '単価',
    ...WAGE_COLUMNS.map(c => `${c.label}(円)`), '合計(円)', '換算時給', '最低賃金', '最低賃金差',
  ]
  const lines = [header.join(',')]
  for (const row of report.value.rows) {
    const s = row.summary
    const w = row.wage
    const attrs = attrIndex.get(normalizeDriverCdKey(s.driverCd))
    lines.push([
      report.value.month, s.driverCd, s.driverName, s.branchName,
      joinDriverAttr(attrs, 'branch'), joinDriverAttr(attrs, 'payScheme'),
      String(s.workDays), String(s.restDays),
      fmtMinutes(s.drivingMinutes), fmtMinutes(s.loadingMinutes), fmtMinutes(s.breakMinutes), fmtMinutes(s.restraintMinutes),
      fmtMinutes(s.fiscalCumulativeMinutes), fmtMinutes(s.excessRestraintMinutes), String(s.over15hDays), String(s.avgDriving9hOverCount),
      fmtMinutes(s.workingMinutes),
      fmtMinutes(w.minutes.overtime), fmtMinutes(w.minutes.weekly40Excess),
      fmtMinutes(w.minutes.night), fmtMinutes(w.minutes.overtimeNight),
      fmtMinutes(w.minutes.legalHoliday), fmtMinutes(w.minutes.legalHolidayNight),
      fmtMinutes(w.minutes.nonLegalHoliday), fmtMinutes(w.minutes.nonLegalHolidayNight),
      w.hourlyRate == null ? '' : String(w.hourlyRate),
      ...WAGE_COLUMNS.map(c => (w.amounts ? String(w.amounts[c.key]) : '')),
      w.totalAmount == null ? '' : String(w.totalAmount),
      w.hourlyEquivalent == null ? '' : String(w.hourlyEquivalent),
      w.minWage.rate == null ? '' : String(w.minWage.rate),
      w.minWageDiff == null ? '' : String(w.minWageDiff),
    ].map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(','))
  }
  triggerDownload(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `拘束賃金集計_${month.value}.csv`)
}

// ---------------------------------------------------------------------------
// 一括印刷 (月範囲 × 乗務員CD範囲、月毎改ページ)
// ---------------------------------------------------------------------------

const printFrom = ref('')
const printTo = ref('')
const printDriverFrom = ref('')
const printDriverTo = ref('')
const printBatch = ref<Array<{ ym: string, rows: WageReportRow[] }> | null>(null)
const printProgress = ref('')
const printing = ref(false)

/** 印刷対象の月一覧 (アーカイブ存在月のうち from〜to、昇順)。 */
const printMonths = computed(() => {
  if (!printFrom.value || !printTo.value) return []
  return [...archiveMonths.value]
    .filter(ym => ym >= printFrom.value && ym <= printTo.value)
    .sort((a, b) => a.localeCompare(b))
})

function filterByDriverRange(rows: WageReportRow[]): WageReportRow[] {
  if (!printDriverFrom.value && !printDriverTo.value) return rows
  const lo = printDriverFrom.value ? Number(printDriverFrom.value) : Number.NEGATIVE_INFINITY
  const hi = printDriverTo.value ? Number(printDriverTo.value) : Number.POSITIVE_INFINITY
  return rows.filter((r) => {
    const cd = Number(r.summary.driverCd)
    return Number.isFinite(cd) && cd >= lo && cd <= hi
  })
}

function printNow() {
  window.print()
}

async function runBatchPrint() {
  if (printing.value || printMonths.value.length === 0) return
  printing.value = true
  pageError.value = ''
  try {
    const batch: Array<{ ym: string, rows: WageReportRow[] }> = []
    for (const ym of printMonths.value) {
      printProgress.value = `${ym} を計算中... (${batch.length + 1}/${printMonths.value.length})`
      const res = await fetchWageReport(ym)
      batch.push({ ym, rows: filterByDriverRange(res.rows) })
    }
    printBatch.value = batch
    printProgress.value = ''
    await nextTick()
    printNow()
  }
  catch (e) {
    handleApiError(e)
    printProgress.value = ''
  }
  finally {
    printing.value = false
  }
}

// ---------------------------------------------------------------------------
// ⓪ アーカイブ閲覧 + サマリ再計算 (単月 / 全月一括)
// ---------------------------------------------------------------------------

const archiveEntries = ref<ArchiveCsvEntry[]>([])
const archiveNoData = ref<string[]>([])
const archiveSummaryCount = ref(0)
const loadingArchive = ref(false)
const archiveHistory = ref<Record<string, ArchiveHistoryEntry[]>>({})

/** loadArchive の世代 (latest-wins、Refs #456。reportEpoch と同じ理由)。 */
let archiveEpoch = 0

async function loadArchive() {
  if (!session.value || !month.value) return
  const epoch = ++archiveEpoch
  const ym = month.value
  loadingArchive.value = true
  pageError.value = ''
  try {
    const csvList = await $fetch<{ entries: ArchiveCsvEntry[] }>('/restraint-api/archive/csv-list', {
      headers: authHeaders(),
      query: { month: ym },
    })
    const summaries = await $fetch<{ summaries: unknown[], no_data_drivers: string[] }>('/restraint-api/archive/summaries', {
      headers: authHeaders(),
      query: { month: ym },
    })
    if (epoch !== archiveEpoch) return // 古い月の応答は捨てる
    archiveEntries.value = csvList.entries
    archiveSummaryCount.value = summaries.summaries.length
    archiveNoData.value = summaries.no_data_drivers
    archiveHistory.value = {}
  }
  catch (e) {
    if (epoch !== archiveEpoch) return
    archiveEntries.value = []
    handleApiError(e)
  }
  finally {
    if (epoch === archiveEpoch) loadingArchive.value = false
  }
}

const archiveRanges = computed(() => {
  const map = new Map<string, ArchiveCsvEntry[]>()
  for (const entry of archiveEntries.value) {
    const list = map.get(entry.range) ?? []
    list.push(entry)
    map.set(entry.range, list)
  }
  return [...map.entries()].map(([range, entries]) => ({
    range,
    latest: entries.find(e => e.kind === 'latest') ?? null,
    versions: entries.filter(e => e.kind === 'version').sort((a, b) => b.file.localeCompare(a.file)),
  }))
})

interface ResummarizeResult { csv_processed: number, summaries_written: number, summaries_new_version: number, errors: string[] }

const resummarizing = ref(false)
const resummarizeMessage = ref('')
/** 全月一括再計算の進捗行。 */
const resummarizeProgress = ref<Array<{ ym: string, status: 'pending' | 'running' | 'done' | 'error', detail?: string }>>([])

async function resummarizeOne(ym: string): Promise<ResummarizeResult> {
  const res = await $fetch<ResummarizeResult>('/restraint-api/archive/resummarize', {
    method: 'POST',
    headers: authHeaders(),
    query: { month: ym },
  })
  reportCache.delete(ym)
  return res
}

/** 表示中の月だけ再計算。 */
async function resummarizeCurrent() {
  if (!session.value || !month.value) return
  resummarizing.value = true
  resummarizeMessage.value = ''
  resummarizeProgress.value = []
  pageError.value = ''
  try {
    const res = await resummarizeOne(month.value)
    resummarizeMessage.value
      = `${fmtYm(month.value)}: CSV ${res.csv_processed} 件からサマリ ${res.summaries_written} 名分を再計算 (更新 ${res.summaries_new_version} 件)`
      + (res.errors.length ? ` / エラー ${res.errors.length} 件` : '')
    await loadArchive()
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    resummarizing.value = false
  }
}

/** アーカイブが存在する全月を順に再計算 (月ごとに進捗表示)。 */
async function resummarizeAll() {
  if (!session.value || resummarizing.value) return
  resummarizing.value = true
  resummarizeMessage.value = ''
  pageError.value = ''
  await loadArchiveMonths()
  const months = [...archiveMonths.value].sort((a, b) => a.localeCompare(b))
  resummarizeProgress.value = months.map(ym => ({ ym, status: 'pending' as const }))
  let totalWritten = 0
  let totalNew = 0
  try {
    for (const item of resummarizeProgress.value) {
      item.status = 'running'
      try {
        const res = await resummarizeOne(item.ym)
        totalWritten += res.summaries_written
        totalNew += res.summaries_new_version
        item.status = 'done'
        item.detail = `${res.summaries_written} 名 (更新 ${res.summaries_new_version})${res.errors.length ? ` / エラー ${res.errors.length}` : ''}`
      }
      catch (e) {
        item.status = 'error'
        item.detail = restraintErrorMessage(e)
        if (restraintErrorStatus(e) === 401) {
          expireSession(restraintErrorMessage(e))
          return
        }
      }
    }
    resummarizeMessage.value = `全 ${months.length} ヶ月の再計算が完了: サマリ ${totalWritten} 件 (更新 ${totalNew} 件)`
    await loadArchive()
  }
  finally {
    resummarizing.value = false
  }
}

async function toggleHistory(range: string) {
  if (archiveHistory.value[range]) {
    const { [range]: _removed, ...rest } = archiveHistory.value
    archiveHistory.value = rest
    return
  }
  try {
    const res = await $fetch<{ entries: ArchiveHistoryEntry[] }>('/restraint-api/archive/history', {
      headers: authHeaders(),
      query: { month: month.value, range },
    })
    archiveHistory.value = { ...archiveHistory.value, [range]: [...res.entries].reverse() }
  }
  catch (e) {
    handleApiError(e)
  }
}

async function downloadArchiveCsv(entry: ArchiveCsvEntry) {
  try {
    const blob = await $fetch<Blob>('/restraint-api/archive/csv', {
      headers: authHeaders(),
      query: { key: entry.key },
      responseType: 'blob',
    })
    triggerDownload(blob, `拘束時間管理表_${month.value}_${entry.range}_${entry.file}`)
  }
  catch (e) {
    handleApiError(e)
  }
}

// ---------------------------------------------------------------------------
// ④ 給与比較 (Refs #253)
// 貼り付けた給与明細 CSV はブラウザ内でのみ解析・比較する (サーバーへ送信・
// 保存しない)。サーバーに保存するのは支給項目 → 基本給/残業 の区分設定だけ。
// ---------------------------------------------------------------------------

const salaryPaste = ref('')
/** 取り込み済み CSV (複数可、Refs #253)。サーバーへは送らず、タブを閉じるまで
 * (sessionStorage) 保持する — リロードしても再取り込み不要にする。
 * company: 取り込み元の会社ラベル (1 ファイル = 1 社を想定)。給与システムの
 * 社員コードは会社毎に別体系で衝突しうるため、乗務員CDへの引き当てに使う
 * (Refs #253)。 */
const salaryImports = ref<Array<{ id: number, name?: string, company: string, text: string, parsed: ParsedSalaryCsv }>>([])
let salaryImportSeq = 0
const SALARY_IMPORTS_STORE_KEY = 'restraint-wage:salary-imports'

/** 現在の取り込み一覧 (原文 CSV/TSV テキスト + 会社ラベル) を sessionStorage に
 * 保存する。解析結果はテキスト+会社から再現できるので保存しない。 */
function persistSalaryImports() {
  if (!import.meta.client) return
  try {
    const stored = salaryImports.value.map(i => ({ id: i.id, name: i.name, company: i.company, text: i.text }))
    sessionStorage.setItem(SALARY_IMPORTS_STORE_KEY, JSON.stringify(stored))
  }
  catch {
    // 容量超過等で保存できなくても致命的ではない (メモリ上のデータはそのまま使える)
  }
}

/** sessionStorage から取り込み済み CSV を復元し、原文 (+会社ラベル) を再解析する。 */
function restoreSalaryImports() {
  if (!import.meta.client) return
  const raw = sessionStorage.getItem(SALARY_IMPORTS_STORE_KEY)
  if (!raw) return
  let stored: Array<{ id: number, name?: string, company?: string, text: string }>
  try {
    stored = JSON.parse(raw)
  }
  catch {
    return
  }
  const restored: typeof salaryImports.value = []
  let maxId = 0
  for (const item of stored) {
    try {
      const company = item.company ?? ''
      restored.push({ id: item.id, name: item.name, company, text: item.text, parsed: parseSalaryCsv(item.text, company) })
      maxId = Math.max(maxId, item.id)
    }
    catch {
      // 保存後に内容が壊れて再解析できない場合はスキップ (他の取り込みは維持)
    }
  }
  salaryImports.value = restored
  salaryImportSeq = maxId
}

/** 取り込み 1 件の会社ラベルを変更する (Refs #253)。テキストは変わらないので
 * CSV を再パースし直さず、既に解析済みの行へ会社ラベルを付け替えるだけにする
 * (大きい CSV だと再パースが重く、入力のたびに全文字で走らせるとタイピングが
 * 詰まる — テンプレート側でも @change (blur/確定時) でしか呼ばない)。 */
function setImportCompany(id: number, company: string) {
  salaryImports.value = salaryImports.value.map((i) => {
    if (i.id !== id) return i
    return { ...i, company, parsed: { ...i.parsed, rows: i.parsed.rows.map(r => ({ ...r, company })) } }
  })
}

watch(salaryImports, persistSalaryImports)
const salaryParseError = ref('')
/** 全取り込みを合算した解析結果 (行連結・項目名の和集合)。 */
/**
 * 給与DB (`/api/kyuyo/payroll`) から読み込んだ明細 (Refs #369 PR-B2)。
 *
 * 貼り付け CSV と**併存**させる — 取得元をユーザーが選べる状態を保つ (#369 決定 4)。
 * 保存先は `/kyuyo-fetch` と同じ sessionStorage (`kyuyo-payroll:{会社}:{月}`) を
 * 共有するので、キャッシュが二重にならない。
 */
const dbImports = ref<Array<{ company: string, month: string, parsed: ParsedSalaryCsv }>>([])
const loadingPayrollDb = ref(false)
const payrollDbMessage = ref('')


const salaryParsed = computed<ParsedSalaryCsv | null>(() => {
  const parsed = [...salaryImports.value.map(i => i.parsed), ...dbImports.value.map(i => i.parsed)]
  return parsed.length ? mergeParsedSalaryCsv(parsed) : null
})
const salaryItemConfig = ref<SalaryItemConfig>({ items: {} })
const salaryConfigLoaded = ref(false)
const savingSalaryConfig = ref(false)
const salaryConfigMessage = ref('')

/** 支給項目の 5 区分 (割増基礎 (労基法37条) × 最低賃金 (4条3項) の 2 軸、Refs #278)。 */
const SALARY_CATEGORY_OPTIONS: Array<{ label: string, value: SalaryItemCategory }> = [
  { label: '基本給・算入手当 (割増基礎○ / 最低賃金○)', value: 'base' },
  { label: '割増 (残業・深夜・休日出勤)', value: 'overtime' },
  { label: '最低賃金のみ算入 (住宅・別居・子女教育)', value: 'minwage-only' },
  { label: '割増基礎のみ算入 (精皆勤)', value: 'premium-base-only' },
  { label: '両方除外 (通勤・家族・臨時・賞与)', value: 'excluded' },
]

async function loadSalaryItemConfig() {
  if (!session.value) return
  try {
    const res = await $fetch<{ exists: boolean, data: SalaryItemConfig | null }>(
      '/restraint-api/salary-item-config',
      { headers: authHeaders() },
    )
    salaryItemConfig.value = res.data ?? { items: {} }
    salaryConfigLoaded.value = true
  }
  catch (e) {
    handleApiError(e)
  }
}

function importSalaryPaste() {
  salaryParseError.value = ''
  salaryConfigMessage.value = ''
  try {
    const text = salaryPaste.value
    const parsed = parseSalaryCsv(text, '')
    salaryImports.value = [...salaryImports.value, { id: ++salaryImportSeq, company: '', text, parsed }]
    // 取り込んだら入力欄を空にして次の CSV の貼り付けを受け付ける
    salaryPaste.value = ''
  }
  catch (e) {
    salaryParseError.value = e instanceof Error ? e.message : String(e)
  }
}

/** ローカル mock (seed:local) 専用のデモ明細読込を出すか。import.meta.dev は
 * 本番ビルドで false 定数になり、下の分岐ごと dead-code として消える。 */
const isDevMode = import.meta.dev

/** ローカル mock 専用 (Refs #268): 共有 fixture の給与明細 CSV (seed:local と同じ
 * 4 乗務員 + 9999) をワンクリックで取り込む — 毎回の手貼り付けを省く。 */
async function importDemoSalaryCsv() {
  if (!import.meta.dev) return
  salaryParseError.value = ''
  salaryConfigMessage.value = ''
  try {
    const raw = (await import('../../tests/fixtures/restraint-wage/salary-2026-07.csv?raw')).default
    salaryImports.value = [...salaryImports.value, {
      id: ++salaryImportSeq,
      name: 'fixture: salary-2026-07.csv',
      company: '',
      text: raw,
      parsed: parseSalaryCsv(raw, ''),
    }]
  }
  catch (e) {
    salaryParseError.value = e instanceof Error ? e.message : String(e)
  }
}

const salaryFileInput = ref<HTMLInputElement | null>(null)

/** 給与明細ファイル (XLS/XLSX/CSV/TSV、複数選択可) をブラウザ内で読み込んで取り込む。 */
async function importSalaryFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  salaryParseError.value = ''
  salaryConfigMessage.value = ''
  const errors: string[] = []
  for (const file of files) {
    try {
      const text = salaryFileToText(new Uint8Array(await file.arrayBuffer()))
      const parsed = parseSalaryCsv(text, '')
      salaryImports.value = [...salaryImports.value, { id: ++salaryImportSeq, name: file.name, company: '', text, parsed }]
    }
    catch (e) {
      errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (errors.length) salaryParseError.value = errors.join(' / ')
  input.value = ''
}

function removeSalaryImport(id: number) {
  salaryImports.value = salaryImports.value.filter(i => i.id !== id)
}

function clearSalaryPaste() {
  salaryPaste.value = ''
  salaryImports.value = []
  salaryParseError.value = ''
}

/** 取り込み 1 件の見出し (行数・月範囲)。 */
function salaryImportLabel(parsed: ParsedSalaryCsv): string {
  const months = parsed.months
  const range = months.length === 0
    ? '月なし'
    : months.length === 1 ? fmtYm(months[0]!) : `${fmtYm(months[0]!)}〜${fmtYm(months[months.length - 1]!)}`
  return `${parsed.rows.length} 行 / 支給項目 ${parsed.itemLabels.length} 件 / ${range}`
}

/** 区分設定の対象項目 (貼り付けから検出した項目 ∪ 保存済み設定のキー)。 */
const salaryItemRows = computed(() => {
  const labels = [...(salaryParsed.value?.itemLabels ?? [])]
  for (const label of Object.keys(salaryItemConfig.value.items)) {
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.map(label => ({
    label,
    category: effectiveCategory(label, salaryItemConfig.value),
    saved: label in salaryItemConfig.value.items,
    inCsv: salaryParsed.value?.itemLabels.includes(label) ?? false,
  }))
})

function setSalaryItemCategory(label: string, category: SalaryItemCategory) {
  salaryItemConfig.value = { items: { ...salaryItemConfig.value.items, [label]: category } }
  salaryConfigMessage.value = ''
}

async function saveSalaryItemConfig() {
  if (!session.value) return
  savingSalaryConfig.value = true
  pageError.value = ''
  try {
    // 表示中の全項目の実効区分を明示保存する (未設定項目の推定既定値も確定させる)
    const items: Record<string, SalaryItemCategory> = { ...salaryItemConfig.value.items }
    for (const row of salaryItemRows.value) items[row.label] = row.category
    const res = await $fetch<{ changed: boolean, data: SalaryItemConfig }>('/restraint-api/salary-item-config', {
      method: 'PUT',
      headers: authHeaders(),
      body: { items },
    })
    salaryItemConfig.value = res.data
    salaryConfigMessage.value = res.changed ? '項目区分を保存しました (新しい版を作成)' : '項目区分を保存しました (内容は前回と同一)'
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    savingSalaryConfig.value = false
  }
}

// ---- 社員マスタ (D1、給与コード×会社 → 乗務員CD、Refs #367) ----
// 給与システムの社員コードは会社毎に別体系で乗務員CDと一致しないため、
// マスタ (D1) で引き当てる。氏名一致による自動提案つき。突合ロジック本体
// (compareSalaryMonth/suggestCdMapEntries) は変更していない — employeeMaster
// (D1 の生データ) から buildCdMapEntries() で従来の SalaryCdMap 形へ変換して
// 橋渡しする。
//
// D1 行単位 upsert のため、旧 R2 版が持っていた楽観排他 (baseVersion) /
// sessionStorage ドラフト退避 / beforeunload 警告は不要 (last-write-wins、
// Refs #367 決定事項)。

// 社員マスタは D1 で **会社ID (comp) スコープ**に保存される (migration 0007)。
// 給与比較・月次集計は「今開いている会社」の分だけを使うが、社員マスタタブは
// 管理者が両社をまとめて面倒を見るため**会社横断で表示・編集**できる
// (Refs #367)。そのため保持は comp_id をキーにした辞書にし、
// `employeeMaster` (= 現在の会社の分) は そこから引く computed にする。
const employeeMasterByComp = ref<Record<string, EmployeeMasterEntry[]>>({})
const employeeMasterLoaded = ref(false)
const savingEmployeeMaster = ref(false)
const employeeMasterMessage = ref('')
/** 給与DB取り込みで得た会社名 (CONAME1) の書き戻し待ち (compId → {payrollCompany, name})。
 * **表示専用**で突合には使わない (突合キーは会社コード、Refs #405)。「保存」で送る。 */
const pendingPayrollCompanyNames = ref<Record<string, { payrollCompany: string, name: string }>>({})
/** 社員マスタタブでローカル削除した属性行・社員行 (「保存」で確定、Refs #367)。 */
const pendingAttrDeletes = ref<Array<{ compId: string, company: string, payrollCd: string, effectiveFrom: string }>>([])
const pendingEmployeeDeletes = ref<Array<{ compId: string, company: string, payrollCd: string }>>([])

/** 現在開いている会社の社員マスタ (給与比較・月次集計 CSV が読む)。 */
const employeeMaster = computed<EmployeeMasterEntry[]>(() =>
  (session.value ? employeeMasterByComp.value[session.value.compId] : undefined) ?? [])

/** 突合ロジックが読む SalaryCdMap 形 (driverCd 未設定の行は除外)。 */
const salaryCdMap = computed(() => buildCdMapEntries(employeeMaster.value))

/**
 * 乗務員CD → 在籍期間 (入社日/退社日、Refs #445)。
 *
 * 同じ人が複数会社に在籍しうる (Refs #403) ので、**入社日は最も古い方・退社日は
 * 最も新しい方**を採る。グループ内の異動で在籍が途切れていない人を、片方の会社の
 * 入社日だけで途中入社扱いにしないため。
 */
const employmentByDriver = computed(() => {
  const map = new Map<string, { hireDate: string | null, retireDate: string | null }>()
  for (const e of employeeMaster.value) {
    if (!e.driverCd) continue
    const key = normalizeDriverCdKey(e.driverCd)
    const cur = map.get(key)
    const hire = e.hireDate ?? null
    const retire = e.retireDate ?? null
    map.set(key, {
      hireDate: cur?.hireDate && (!hire || cur.hireDate < hire) ? cur.hireDate : hire,
      // 片方でも「在籍中 (null)」なら在籍中として扱う
      retireDate: !cur ? retire : (cur.retireDate === null || retire === null ? null : (cur.retireDate > retire ? cur.retireDate : retire)),
    })
  }
  return map
})

function setEmployeeMasterEntries(compId: string, entries: EmployeeMasterEntry[]) {
  employeeMasterByComp.value = { ...employeeMasterByComp.value, [compId]: entries }
}

/** 進行中の取得を会社ごとに共有する (Refs #501)。
 *
 * `employeeMasterLoaded` も `employeeMasterByComp` も **await の後**にしか立たない
 * ので、同じ tick で走る呼び出し (タイムカードタブは `loadAllEmployeeMasters` と
 * 現在会社の 2 経路) が全部「未読込」を見て同じ GET を重複発行していた。relay の
 * per-comp DO は直列化するので後続ほど待たされ、**ページ全体のクリティカルパス**に
 * なる — 本番実測 (2026-07-28) で同じ URL が 3 本、2.1 / 5.5 / 5.9 秒。 */
const employeeMasterInflight = new Map<string, Promise<void>>()

/** 1 会社分を読む。`compId` 省略時は今開いている会社。
 * 同じ会社の取得が飛んでいる間は**それを共有**する (上の Map)。 */
function loadEmployeeMaster(compId?: string): Promise<void> {
  if (!session.value) return Promise.resolve()
  const target = compId ?? session.value.compId
  const inflight = employeeMasterInflight.get(target)
  if (inflight) return inflight
  const p = fetchEmployeeMaster(target).finally(() => {
    employeeMasterInflight.delete(target)
  })
  employeeMasterInflight.set(target, p)
  return p
}

/** 他社の読み込みは fail-soft — テナントが許可されていない会社は 401/403 に
 * なるが、それは「見えないのが正しい」ので画面全体のエラーにはしない。 */
async function fetchEmployeeMaster(target: string) {
  const isCurrent = target === session.value?.compId
  try {
    const res = await $fetch<EmployeeMasterGetResponse>('/restraint-api/employee-master', {
      headers: authHeaders(target),
    })
    setEmployeeMasterEntries(target, res.employees)
    if (isCurrent) employeeMasterLoaded.value = true
  }
  catch (e) {
    if (isCurrent) handleApiError(e)
    else setEmployeeMasterEntries(target, [])
  }
}

/** 既知の全会社 + 開いている会社の社員マスタを読む (Refs #472 PR-C)。
 *
 * タイムカード表のドライバー行は `kosoku-daily` 由来で**会社で絞られていない**ため、
 * 会社の見出しに振り分けるには全会社のマスタが要る。読み込み済みの会社は飛ばす
 * (タブを開くたびに全社ぶん取り直さない)。見えない会社は `loadEmployeeMaster` が
 * 空で埋めるので、その人たちは「会社不明」に落ちる。 */
function loadAllEmployeeMasters() {
  if (!session.value) return
  const targets = new Set([session.value.compId, ...DTAKO_COMPS.map(c => c.compId)])
  for (const compId of targets) {
    if (employeeMasterByComp.value[compId]) continue
    loadEmployeeMaster(compId)
  }
}

// ---- 給与DBからの社員取り込み (Refs #367) ----
// 会社対応表 (dtako 会社ID → 給与大臣の会社コード) は D1 が正 —
// `GET /restraint-api/comp-map` で取る (同じテナントの会社だけ返る)。
// 取り込み自体は rust-ichibanboshi の identity-only API
// (`/api/kyuyo/employees`) で、**金額は一切ブラウザに来ない**。

const compMap = ref<CompMapEntry[]>([])
/** comp-map が一度でも解決したか (成否は問わない、Refs #554)。`kyuyoSyncedLoaded` と
 * 同じ理由 — 会社が分かる前は「アーカイブが無い」の判定自体ができない。 */
const compMapLoaded = ref(false)
const importPayrollCompany = ref('')
const importingPayroll = ref(false)

// ---- 一番星社員ﾏｽﾀからの突合 (Refs #403) ----
// 乗務員CD は一番星 [社員ﾏｽﾀ].社員C と同一体系なので、未突合行を氏名で照合して
// 埋められる。金額は一切関与しない (`GET /api/employees` は社員C/社員N/社員R だけ)。
const matchingIchiban = ref(false)
/** 直前の突合で決められなかった行 (人が判断する分)。 */
const ichibanUnresolved = ref<IchibanMatchPlan | null>(null)

async function loadCompMap() {
  if (!session.value) return
  try {
    compMap.value = parseCompMap(await $fetch('/restraint-api/comp-map', { headers: authHeaders() }))
  }
  catch {
    compMap.value = [] // 取れなければ取り込みカードを出さない (fail-soft)
  }
  finally {
    compMapLoaded.value = true
  }
}

/** いま社員マスタタブで編集対象にしている会社 (全社表示なら閲覧中の会社)。 */
const importTargetComp = computed(() =>
  (employeeMasterScope.value === 'all' ? session.value?.compId : employeeMasterScope.value) ?? '')

/**
 * 給与明細 CSV 取り込みの会社選択肢 (Refs #405)。
 *
 * 会社は突合キー `会社|給与コード|氏名` の一部なので、自由入力だと表記揺れで
 * キーが分裂する。社員マスタが保持しているのと同じ**給与大臣の会社コード**を
 * 選ばせる (表示は会社名つき)。未選択 (空文字) は「会社未設定」のまま許容する —
 * 1 社しか扱わない運用では会社無しでも突合できるため (旧 2 部キー)。
 */
const salaryImportCompanyOptions = computed(() => {
  const entry = compMap.value.find(c => c.compId === (session.value?.compId ?? ''))
  return [
    { label: '(会社未設定)', value: '' },
    ...(entry?.payrollCompanies ?? []).map(p => ({
      label: p.payrollCompanyName ? `${p.payrollCompany} (${p.payrollCompanyName})` : p.payrollCompany,
      value: p.payrollCompany,
    })),
  ]
})

/** 取り込み元に選べる給与DB会社 (対象 comp の対応行)。 */
const importPayrollOptions = computed(() => {
  const entry = compMap.value.find(c => c.compId === importTargetComp.value)
  return (entry?.payrollCompanies ?? []).map(p => ({
    label: p.payrollCompanyName ? `${p.payrollCompany} (${p.payrollCompanyName})` : p.payrollCompany,
    value: p.payrollCompany,
  }))
})

watch(importPayrollOptions, (options) => {
  if (!options.some(o => o.value === importPayrollCompany.value)) {
    importPayrollCompany.value = options[0]?.value ?? ''
  }
}, { immediate: true })

// ---- 給与DB取得の期間指定 (上部バー) ----
// 指定する月は**勤務月** — 画面の月タブと同じ基準で、`/api/kyuyo/payroll?month=`
// もこれを取る。応答行は支給日 (勤務月+1) で自己ラベルされるので、突合側
// (salaryMonthRows) はそのままで良い。から/まで が同じ月なら従来の 1 ヶ月動作。
const payrollRangeFrom = ref('')
const payrollRangeTo = ref('')

// 既定は「選択中の月だけ」= 従来の 1 ヶ月動作。月タブを切り替えたら期間もそこへ
// 戻す — 6月の範囲指定を残したまま 1月へ移ると、何を取るのか分からなくなる。
watch(month, (ym) => {
  payrollRangeFrom.value = ym
  payrollRangeTo.value = ym
  // 前の月の結果メッセージは消す — 「4月を見ているのに 5月支給分を読み込みました」
  // が残り続けると、今の月のデータが有るのか無いのか読み取れない
  payrollDbMessage.value = ''
}, { immediate: true })

/** 期間セレクタの選択肢 (前年1月〜選択年12月の勤務月)。
 * **空文字の option は作らない** — Reka UI の `SelectItem` は value に空文字を
 * 取れず、描画が 500 になる (2026-07-25 にローカルで踏んだ)。「1 ヶ月だけ」は
 * から/まで を同じ月にすることで表す。 */
const payrollMonthOptions = computed(() => {
  const items: Array<{ label: string, value: string }> = []
  for (const year of [selectedYear.value - 1, selectedYear.value]) {
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}-${String(m).padStart(2, '0')}`
      items.push({ label: fmtYm(ym), value: ym })
    }
  }
  return items
})

/** 取得する勤務月の一覧。期間が未指定 (片方だけでも) なら選択中の月だけ。 */
const payrollTargetMonths = computed(() => {
  const range = monthRange(payrollRangeFrom.value, payrollRangeTo.value)
  return range.length ? range : [month.value]
})

/** 上部バーに出す「何を取るか」の説明 (支給月ベース = 給与大臣側の見え方)。 */
const payrollRangeHint = computed(() => {
  const months = payrollTargetMonths.value
  const first = fmtYm(nextYm(months[0]!))
  const last = fmtYm(nextYm(months[months.length - 1]!))
  const span = months.length > 1 ? `${first}〜${last} 支給分 (${months.length} ヶ月)` : `${first} 支給分`
  return `${span} × ${importPayrollOptions.value.length} 社`
})

/**
 * 一番星社員ﾏｽﾀで未突合行の社員CD を埋める (ローカル反映 → 「保存」で確定、Refs #403)。
 *
 * proxy の base に `/api` が含まれないため `/api/ichiban/api/employees` と二重に書く
 * (`/api/ichiban/health` だけは rust 側が root ルートなので例外)。
 */
async function matchFromIchiban() {
  const compId = importTargetComp.value
  if (!compId) return
  matchingIchiban.value = true
  pageError.value = ''
  try {
    const res = await $fetch<{ data: IchibanEmployeeRow[] }>('/api/ichiban/api/employees')
    const entries = employeeMasterByComp.value[compId] ?? []
    const plan = planIchibanMatch(res.data ?? [], entries)
    const personCdByKey = new Map(plan.matched.map(m => [`${m.company}|${m.payrollCd}`, m.personCd]))
    setEmployeeMasterEntries(compId, entries.map((e) => {
      const personCd = personCdByKey.get(`${e.company}|${e.payrollCd}`)
      return personCd ? { ...e, driverCd: personCd } : e
    }))

    ichibanUnresolved.value = plan.ambiguous.length || plan.notFound.length ? plan : null
    employeeMasterMessage.value
      = `一番星の社員ﾏｽﾀから ${plan.matched.length} 名の社員CD を埋めました `
        + `(同名複数 ${plan.ambiguous.length} 名 / 一番星に無し ${plan.notFound.length} 名 は手入力してください)。`
        + '「保存」で確定します'
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    matchingIchiban.value = false
  }
}

/**
 * 給与DB から対象月の明細を読み込み、給与比較へ流す (Refs #369 PR-B2)。
 *
 * 対象は「今開いている会社に対応する給与大臣の会社」全部 × **支給月** (勤務月の翌月)。
 * サーバー側 `KyuyoLimiter` が同時 1 本なので**直列**で回す (1 件 12〜16 秒かかるのは
 * 古い PC + AUTO_CLOSE のため正常)。
 *
 * 取得済みデータは `/kyuyo-fetch` と**同じ sessionStorage キー**を共有する —
 * 一度取れば両方の画面で使い回せ、キャッシュが二重にならない。
 */
/** sessionStorage の (会社, 支給月) を読む。壊れていたら null (取り直させる)。 */
function readStoredPayroll(payrollCompany: string, payMonth: string): StoredPayroll | null {
  if (!import.meta.client) return null
  const cached = sessionStorage.getItem(payrollStorageKey(payrollCompany, payMonth))
  if (!cached) return null
  try {
    return JSON.parse(cached) as StoredPayroll
  }
  catch {
    return null
  }
}

/** 取得済み明細を dbImports へ反映する。同じ (会社, 支給月) だけ差し替え、
 * それ以外の既取得分は残す — 月を切り替えながら押しても前の月が消えない
 * (突合は月で絞るので混ざらない)。 */
function applyDbImports(loaded: typeof dbImports.value) {
  const replaced = new Set(loaded.map(i => `${i.company}|${i.month}`))
  dbImports.value = [...dbImports.value.filter(i => !replaced.has(`${i.company}|${i.month}`)), ...loaded]
}

async function loadPayrollFromDb() {
  const compId = session.value?.compId
  if (!compId) return
  const companies = compMap.value.find(c => c.compId === compId)?.payrollCompanies ?? []
  if (!companies.length) return
  const workMonths = payrollTargetMonths.value
  loadingPayrollDb.value = true
  payrollDbMessage.value = ''
  pageError.value = ''
  const loaded: typeof dbImports.value = []
  const totalFetches = workMonths.length * companies.length
  let done = 0
  try {
    const token = currentAccessToken()
    for (const workMonth of workMonths) {
      const payMonth = nextYm(workMonth)
      for (const { payrollCompany } of companies) {
        done += 1
        let stored: StoredPayroll | null = readStoredPayroll(payrollCompany, payMonth)
        if (!stored) {
          // 取得済みの月は sessionStorage から返るので、期間を伸ばしても
          // 既に取った分は待たされない (キーは会社×支給月)
          payrollDbMessage.value = totalFetches > 1
            ? `${done}/${totalFetches} ${payrollCompany} / ${fmtYm(payMonth)} 支給分 を取得しています… (1 社あたり 10〜20 秒)`
            : `${payrollCompany} を取得しています… (1 社あたり 10〜20 秒)`
          const body = await $fetch(`/api/kyuyo/payroll`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            query: { company: payrollCompany, month: workMonth },
          })
          stored = toStoredPayroll(body, new Date().toISOString())
          if (!stored) {
            payrollDbMessage.value = `${payrollCompany} / ${fmtYm(payMonth)} の応答形式が想定外でした`
            continue
          }
          if (import.meta.client) sessionStorage.setItem(payrollStorageKey(payrollCompany, payMonth), JSON.stringify(stored))
        }
        const parsed = payrollToParsedSalary(stored.rows as KyuyoPayrollRow[], payrollCompany)
        loaded.push({ company: payrollCompany, month: payMonth, parsed })
      }
    }
    applyDbImports(loaded)
    const total = loaded.reduce((n, i) => n + i.parsed.rows.length, 0)
    const payLabel = loaded.length
      ? `${fmtYm(nextYm(workMonths[0]!))}${workMonths.length > 1 ? `〜${fmtYm(nextYm(workMonths[workMonths.length - 1]!))}` : ''} 支給分`
      : ''
    payrollDbMessage.value = loaded.length
      ? `給与DB から ${companies.length} 社 / ${workMonths.length} ヶ月 / ${total} 行を読み込みました (${payLabel})`
      : '給与DB から読み込める明細がありませんでした'
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    loadingPayrollDb.value = false
  }
}

/**
 * 選択中の月に**給与アーカイブがある会社だけ**、ボタンを押さずに読み込む
 * (2026-07-28 要望「給与アーカイブあるのであれば、取り込みせずとも表示して」)。
 *
 * 対象は `kyuyo_sync_state` に (会社, 勤務月) がある組か、既に sessionStorage に
 * ある組だけ — この 2 つは upstream が SQLite / ブラウザキャッシュだけで返せるので
 * **給与大臣 (OHKEN) を開かない** = 待ち時間もロックも発生しない。アーカイブが
 * 無い会社は従来どおり「給与DBから読み込み」ボタン (1 社 10〜20 秒) の担当のまま。
 */
/** 自動読み込みの走行中フラグ。**ref にしてある** — 給与比較タブの「読み込み中」表示が
 * これを見るため (Refs #554)。素の let にすると表示が更新されない。 */
const autoPayrollLoading = ref(false)
let autoPayrollRerun = false

async function autoLoadArchivedPayroll() {
  // 手動取得 (全社を取る = 自動読みの上位互換) が走っている間は譲る。自動読み同士は
  // 「後から来た方をもう一度回す」— compMap と synced-months が別タイミングで
  // 解決するので、片方だけ見て終わると残りの会社が読まれない
  if (loadingPayrollDb.value) return
  if (autoPayrollLoading.value) {
    autoPayrollRerun = true
    return
  }
  const compId = session.value?.compId
  if (!compId) return
  const workMonth = month.value
  const payMonth = nextYm(workMonth)
  const companies = (compMap.value.find(c => c.compId === compId)?.payrollCompanies ?? [])
    .filter(({ payrollCompany }) =>
      // 既に画面に載っている組は読み直さない (押した直後の再取得を避ける)
      !dbImports.value.some(i => i.company === payrollCompany && i.month === payMonth)
      && (kyuyoSyncedKeys.value.has(`${payrollCompany}|${workMonth}`)
        || readStoredPayroll(payrollCompany, payMonth) !== null),
    )
  if (!companies.length) return
  autoPayrollLoading.value = true
  const loaded: typeof dbImports.value = []
  try {
    const token = currentAccessToken()
    for (const { payrollCompany } of companies) {
      let stored = readStoredPayroll(payrollCompany, payMonth)
      if (!stored) {
        const body = await $fetch(`/api/kyuyo/payroll`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          query: { company: payrollCompany, month: workMonth },
        })
        stored = toStoredPayroll(body, new Date().toISOString())
        if (!stored) continue // 形式が想定外 = ボタンで取り直す。自動読みは黙って諦める
        if (import.meta.client) sessionStorage.setItem(payrollStorageKey(payrollCompany, payMonth), JSON.stringify(stored))
      }
      loaded.push({
        company: payrollCompany,
        month: payMonth,
        parsed: payrollToParsedSalary(stored.rows as KyuyoPayrollRow[], payrollCompany),
      })
    }
    if (!loaded.length) return
    // 応答を待つ間に月を動かされていたら捨てる (古い月の明細を載せない)
    if (month.value !== workMonth) return
    applyDbImports(loaded)
    const total = loaded.reduce((n, i) => n + i.parsed.rows.length, 0)
    payrollDbMessage.value
      = `給与アーカイブから ${loaded.length} 社 / ${total} 行を表示しました `
        + `(${fmtYm(payMonth)} 支給分 — 取り込み操作は不要です)`
  }
  catch {
    // 自動読みの失敗はボタンでの取得を妨げない — エラー表示はしない
  }
  finally {
    autoPayrollLoading.value = false
    if (autoPayrollRerun) {
      autoPayrollRerun = false
      void autoLoadArchivedPayroll()
    }
  }
}

/** 給与DBの社員一覧を社員マスタへ取り込む (ローカル反映 → 「保存」で確定)。 */
async function importFromPayrollDb() {
  const compId = importTargetComp.value
  const payrollCompany = importPayrollCompany.value
  if (!compId || !payrollCompany) return
  importingPayroll.value = true
  pageError.value = ''
  try {
    const token = currentAccessToken()
    const res = await $fetch<KyuyoEmployeesResponse>('/api/kyuyo/employees', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      query: { company: payrollCompany, month: month.value },
    })
    const legacyLabel = compMap.value
      .find(c => c.compId === compId)?.payrollCompanies
      .find(p => p.payrollCompany === payrollCompany)?.legacyLabel ?? null
    const plan = planPayrollDbImport(res, employeeMasterByComp.value[compId] ?? [], month.value, legacyLabel)

    let entries = employeeMasterByComp.value[compId] ?? []
    // 旧ラベル行は統合済みなのでローカルから除き、削除指示に積む
    for (const d of plan.deleteEmployees) {
      entries = entries.filter(e => !(e.company === d.company && e.payrollCd === d.payrollCd))
      pendingEmployeeDeletes.value = [...pendingEmployeeDeletes.value, { compId, ...d }]
    }
    for (const emp of plan.employees) {
      const idx = entries.findIndex(e => e.company === emp.company && e.payrollCd === emp.payrollCd)
      entries = idx === -1
        ? [...entries, { ...emp, attrs: [] }]
        // 入社日は上流が返した時だけ上書きする (古い rust なら null で来るので、
        // 取り込み済みの値を消さない — worker の COALESCE と同じ理由、Refs #445)
        : entries.map((e, i) => (i === idx
          ? {
              ...e,
              name: emp.name,
              driverCd: emp.driverCd,
              hireDate: emp.hireDate ?? e.hireDate ?? null,
              retireDate: emp.retireDate ?? e.retireDate ?? null,
            }
          : e))
    }
    for (const attr of plan.attrs) {
      const idx = entries.findIndex(e => e.company === attr.company && e.payrollCd === attr.payrollCd)
      if (idx === -1) continue
      const { effectiveFrom, branch, payScheme, branchCode, branchName, jobName, payKubun } = attr
      entries = entries.map((e, i) => (i === idx
        ? { ...e, attrs: upsertAttrRow(e.attrs, { effectiveFrom, branch, payScheme, branchCode, branchName, jobName, payKubun }) }
        : e))
    }
    setEmployeeMasterEntries(compId, entries)

    // 会社名 (CONAME1) は表示専用として対応表へ書き戻す (Refs #405)
    pendingPayrollCompanyNames.value = {
      ...pendingPayrollCompanyNames.value,
      [compId]: { payrollCompany, name: res.company_name },
    }

    const warn = res.warnings.length ? ` / warnings: ${res.warnings.join(' / ')}` : ''
    employeeMasterMessage.value
      = `給与DB (${payrollCompany} ${res.company_name}) から ${plan.employees.length} 名を取り込みました `
        + `(新規 ${plan.added} 名 / 旧ラベルから統合 ${plan.merged} 名 / 所属・体系の更新 ${plan.attrs.length} 件)。`
        + `「保存」で確定します${warn}`
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    importingPayroll.value = false
  }
}

/** 社員マスタタブの表示範囲 ('all' = 全社)。空文字は使わない —
 * Nuxt UI の USelect は value が空文字の項目を拒否する (実機で 500、Refs #367)。 */
const employeeMasterScope = ref('all')

/** 表示範囲に必要な会社を読む。
 * `force` = false (タブ切替時) は**読み込み済みの会社をそのまま使う** —
 * 未保存のローカル編集を消さないため。`force` = true (「再読込」ボタン) は
 * 範囲内の全会社をサーバーから取り直す。 */
async function loadEmployeeMasterScope(force = false) {
  if (!session.value) return
  const current = session.value.compId
  if (force || !employeeMasterLoaded.value) await loadEmployeeMaster()
  if (employeeMasterScope.value !== 'all') {
    if (employeeMasterScope.value !== current) await loadEmployeeMaster(employeeMasterScope.value)
    return
  }
  const others = DTAKO_COMPS.map(c => c.compId).filter(id => id !== current)
  await Promise.all(others.map(id => loadEmployeeMaster(id)))
}

/** company+payrollCd が一致する行を更新、無ければ新規追加する (ローカル即時反映)。
 * `compId` 省略時は今開いている会社。 */
function upsertEmployeeMasterEntry(
  company: string,
  payrollCd: string,
  name: string,
  driverCd: string | null,
  compId?: string,
) {
  if (!session.value) return
  const target = compId ?? session.value.compId
  const entries = employeeMasterByComp.value[target] ?? []
  const idx = entries.findIndex(e => e.company === company && e.payrollCd === payrollCd)
  setEmployeeMasterEntries(
    target,
    idx === -1
      ? [...entries, { company, payrollCd, name, driverCd, attrs: [] }]
      : entries.map((e, i) => (i === idx ? { ...e, name, driverCd } : e)),
  )
}

/** 読み込み済みの会社ごとに PUT する (upsert のみ・冪等なので全件送って問題ない)。
 * ローカルで消した属性行・社員行は所属会社の PUT に削除指示として同送する
 * (worker 側は upsert → 削除の順に実行するので、同じキーがあれば削除が勝つ)。
 * **会社をまたぐ 1 回の PUT は無い** — worker はセッションの会社IDでしか
 * 書かないため、会社ごとにヘッダを変えて投げる必要がある。 */
async function saveEmployeeMaster(message: string) {
  if (!session.value) return
  savingEmployeeMaster.value = true
  pageError.value = ''
  const targets = new Set<string>([
    ...Object.keys(employeeMasterByComp.value),
    ...pendingAttrDeletes.value.map(d => d.compId),
    ...pendingEmployeeDeletes.value.map(d => d.compId),
  ])
  try {
    for (const compId of targets) {
      const entries = employeeMasterByComp.value[compId] ?? []
      const deleteAttrs = pendingAttrDeletes.value.filter(d => d.compId === compId)
      const deleteEmployees = pendingEmployeeDeletes.value.filter(d => d.compId === compId)
      if (!entries.length && !deleteAttrs.length && !deleteEmployees.length) continue
      await $fetch('/restraint-api/employee-master', {
        method: 'PUT',
        headers: authHeaders(compId),
        body: {
          // 入社日・退社日も送る (Refs #445)。手編集の保存では null のままだが、
          // worker の upsert が COALESCE なので取り込み済みの値は潰れない
          employees: entries.map(e => ({
            company: e.company,
            payrollCd: e.payrollCd,
            name: e.name,
            driverCd: e.driverCd,
            hireDate: e.hireDate ?? null,
            retireDate: e.retireDate ?? null,
          })),
          attrs: collectAttrRows(entries),
          deleteAttrs: deleteAttrs.map(({ company, payrollCd, effectiveFrom }) => ({ company, payrollCd, effectiveFrom })),
          deleteEmployees: deleteEmployees.map(({ company, payrollCd }) => ({ company, payrollCd })),
          payrollCompanyName: pendingPayrollCompanyNames.value[compId] ?? null,
        },
      })
    }
    pendingAttrDeletes.value = []
    pendingEmployeeDeletes.value = []
    pendingPayrollCompanyNames.value = {}
    await loadCompMap() // 会社名を書き戻したので表示用の対応表を取り直す
    employeeMasterMessage.value = message
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    savingEmployeeMaster.value = false
  }
}

// R2 の旧突合マスタ (salary-cd-map) からの取り込みボタンは、本番移行の完了を
// 確認したうえで撤去した (2026-07-25、Refs #367)。社員の登録経路は
// 「給与DBから取り込み」と給与明細 CSV の「未登録 N 名をマスタへ登録」の 2 本。

/** 給与明細 CSV に現れた行のうち、社員マスタにまだ (会社・給与コード) が
 * 存在しない = 一度も登録されたことがない行 (Refs #367)。 */
const unregisteredEmployees = computed(() => findUnregistered(salaryParsed.value?.rows ?? [], employeeMaster.value))

/** 未登録行をマスタへ一括登録する。送るのはコード・氏名・会社のみ (乗務員CD
 * 突合はまだ付けない — 金額は一切送信しない)。 */
async function registerUnregistered() {
  if (!session.value || !unregisteredEmployees.value.length) return
  // unregisteredEmployees は computed — upsert 後は再評価されて 0 になるため、
  // メッセージ用の件数は upsert 前にスナップショットしておく (Refs #367 実機検証)
  const targets = unregisteredEmployees.value
  for (const u of targets) upsertEmployeeMasterEntry(u.company, u.payrollCd, u.name, null)
  await saveEmployeeMaster(`${targets.length} 名をマスタへ登録しました (コード・氏名・会社のみ、金額は送信しません)`)
}

/** 氏名の完全一致 (両側で一意) から未突合行の乗務員CDを一括提案して設定する。 */
function autoSuggestCdMap() {
  if (!report.value) return
  const suggested = suggestCdMapEntries(salaryMonthRows.value, report.value.rows, salaryCdMap.value)
  const count = Object.keys(suggested).length
  if (count === 0) {
    employeeMasterMessage.value = '氏名一致で自動設定できる行はありませんでした'
    return
  }
  for (const [key, driverCd] of Object.entries(suggested)) {
    const parsed = splitCdMapKey(key)
    upsertEmployeeMasterEntry(parsed.company, parsed.payrollCd, parsed.name, driverCd)
  }
  employeeMasterMessage.value = `${count} 名を氏名一致で自動設定しました。「マスタを保存」で確定します`
}

function setCdMapEntry(payrollCd: string, name: string, driverCd: string, company = '') {
  upsertEmployeeMasterEntry(company, payrollCd, name, driverCd)
  employeeMasterMessage.value = ''
}

/** key は "会社|給与コード" (salaryCdMapRows が組み立てる表示用キー)。乗務員CD
 * 突合だけを解除する — 社員としての識別情報 (会社・給与コード・氏名) 自体は
 * 消さない (取り消しても社員マスタの登録は残す)。 */
function removeCdMapEntry(key: string) {
  if (!session.value) return
  const [company, payrollCd] = key.split('|')
  setEmployeeMasterEntries(
    session.value.compId,
    employeeMaster.value.map(e =>
      (e.company === company && e.payrollCd === payrollCd ? { ...e, driverCd: null } : e)),
  )
}

/** 乗務員CD選択肢 (未突合 = システム計算のみ の乗務員だけ、CD 昇順)。
 * 突合済みは除外する — 付け替えたい時は登録済みから削除して選び直す。 */
const salaryCdOptions = computed(() =>
  [...(salaryComparison.value?.reportOnly ?? [])]
    .sort((a, b) => a.driverCd.localeCompare(b.driverCd, undefined, { numeric: true }))
    .map(d => ({ label: `${d.driverCd} ${d.driverName}`, value: d.driverCd })))

/** 登録済み (乗務員CD突合済み) の社員マスタ表示行。key は "会社|給与コード"
 * (removeCdMapEntry に渡す)。 */
const salaryCdMapRows = computed(() =>
  employeeMaster.value
    .filter(e => e.driverCd)
    .map(e => ({ key: `${e.company}|${e.payrollCd}`, company: e.company, payrollCd: e.payrollCd, name: e.name, driverCd: e.driverCd! }))
    .sort((a, b) => a.payrollCd.localeCompare(b.payrollCd, undefined, { numeric: true })))

// ---- 社員マスタタブ (一覧・乗務員CD 編集・所属/給与体系の履歴、Refs #367) ----
// 単価マスタと同じ操作感: ローカル編集 → 「保存」でサーバー確定。属性 (所属・
// 給与体系) は適用開始日つき履歴で、対象月の**末日時点**で効いている行が
// 月次集計 CSV の 所属(マスタ)/給与体系 列になる (resolveAttrsAt)。

/** 属性の新規入力欄 (キー = "会社ID|会社|給与コード")。 */
const newAttrInputs = ref<Record<string, { from: string, branch: string, payScheme: string }>>({})

/** 社員マスタタブの会社セレクタ (全社 + 既知の会社 + 閲覧中の会社)。 */
const employeeMasterScopeOptions = computed(() => {
  const known = DTAKO_COMPS.map(c => c.compId)
  const current = session.value?.compId
  const ids = current && !known.includes(current) ? [...known, current] : known
  return [{ label: '全社', value: 'all' }, ...ids.map(id => ({ label: dtakoCompDisplay(id), value: id }))]
})

/** 表示対象の会社ID (全社なら読み込み済みの全会社)。 */
const employeeMasterScopeComps = computed(() =>
  (employeeMasterScope.value === 'all'
    ? Object.keys(employeeMasterByComp.value).sort()
    : [employeeMasterScope.value]))

/** 一覧行 (会社ID → 会社 → 給与コード順、対象月末時点の現行属性 + 履歴は新しい順)。
 * key は "会社ID|会社|給与コード" — 会社横断で一意にするため会社IDを含める。 */
const employeeMasterRows = computed(() =>
  employeeMasterScopeComps.value.flatMap(compId =>
    sortEmployeeEntries(employeeMasterByComp.value[compId] ?? []).map(e => ({
      key: `${compId}|${e.company}|${e.payrollCd}`,
      compId,
      compLabel: dtakoCompLabel(compId),
      // 会社は突合キーとして給与大臣の会社コードを保持しているので、表示は
      // 会社名つきに直す (Refs #405)。名前が未取得ならコードのまま。
      companyLabel: payrollCompanyLabel(compMap.value, compId, e.company),
      entry: e,
      current: resolveAttrsAt(e, month.value),
      history: [...e.attrs].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)),
    }))))

/** 属性履歴モーダルの対象 (key = "会社ID|会社|給与コード"、null = 閉)。 */
const attrHistoryKey = ref<string | null>(null)
const attrHistoryOpen = computed({
  get: () => attrHistoryKey.value !== null,
  set: (open: boolean) => {
    if (!open) attrHistoryKey.value = null
  },
})
const attrHistoryRow = computed(() =>
  attrHistoryKey.value === null ? null : employeeMasterRows.value.find(r => r.key === attrHistoryKey.value) ?? null)

/** 一覧行の key を (会社ID, 会社, 給与コード) に分解する。会社ラベルに `|` は
 * 入らない前提 (worker 側で NFKC + trim 済みの自由文字列)。 */
function splitEmployeeRowKey(key: string): { compId: string, company: string, payrollCd: string } {
  const [compId = '', company = '', payrollCd = ''] = key.split('|')
  return { compId, company, payrollCd }
}

function findEmployeeByRowKey(key: string): EmployeeMasterEntry | undefined {
  const { compId, company, payrollCd } = splitEmployeeRowKey(key)
  return (employeeMasterByComp.value[compId] ?? []).find(e => e.company === company && e.payrollCd === payrollCd)
}

/** 社員 1 件をローカル更新する (key = "会社ID|会社|給与コード")。 */
function patchEmployeeEntry(key: string, patch: Partial<EmployeeMasterEntry>) {
  const { compId, company, payrollCd } = splitEmployeeRowKey(key)
  setEmployeeMasterEntries(
    compId,
    (employeeMasterByComp.value[compId] ?? []).map(e =>
      (e.company === company && e.payrollCd === payrollCd ? { ...e, ...patch } : e)),
  )
}

/** 乗務員CD の手入力 (空 = 突合解除)。数字以外は弾く (worker 側の検証と同一規則)。 */
function setEmployeeDriverCd(key: string, value: string) {
  const trimmed = value.trim()
  if (trimmed && !/^\d{1,8}$/.test(trimmed)) {
    employeeMasterMessage.value = `社員CD は数字 (最大8桁) で入力してください (${trimmed})`
    return
  }
  patchEmployeeEntry(key, { driverCd: trimmed ? String(Number(trimmed)) : null })
  employeeMasterMessage.value = ''
}

/** 氏名の手直し (R2 突合マスタ由来の行は正規化済み氏名しか持たない、Refs #367)。 */
function setEmployeeName(key: string, value: string) {
  const trimmed = value.trim()
  if (!trimmed) return
  patchEmployeeEntry(key, { name: trimmed })
}

/** 新規入力欄の値で属性履歴を 1 行 upsert する (「保存」で確定)。 */
function addEmployeeAttr(key: string) {
  const input = newAttrInputs.value[key]
  if (!input?.from) return
  // 手入力の行は所属コード・営業所名・職種名を持たない (給与大臣由来ではないため)。
  // null のままにすると拠点は表示名からの前方一致で引かれる (Refs #409)。
  // 給与区分 (payKubun) は手入力しない — 給与大臣の `SHAIN3.KKUBUN` が正で、
  // 「給与DBから取り込み」でのみ埋まる (Refs #429)。手入力で埋めると次回の
  // 取り込みで上書きされ、その間だけ基本給(計算)が違う式で出る。
  const row = {
    effectiveFrom: input.from,
    branch: input.branch.trim() || null,
    payScheme: input.payScheme.trim() || null,
    branchCode: null,
    branchName: null,
    jobName: null,
    payKubun: null,
  }
  const entry = findEmployeeByRowKey(key)
  if (!entry) return
  patchEmployeeEntry(key, { attrs: upsertAttrRow(entry.attrs, row) })
  // 適用開始日は連続入力しやすいよう残す (単価マスタの addRate と同じ作法)
  newAttrInputs.value = { ...newAttrInputs.value, [key]: { from: input.from, branch: '', payScheme: '' } }
  employeeMasterMessage.value = `${entry.name} に ${row.effectiveFrom} からの所属/体系を設定しました。「保存」で確定します`
}

/** 属性履歴 1 件をローカル削除する (「保存」で D1 からも消える)。 */
function removeEmployeeAttr(key: string, effectiveFrom: string) {
  const entry = findEmployeeByRowKey(key)
  if (!entry) return
  const { compId } = splitEmployeeRowKey(key)
  patchEmployeeEntry(key, { attrs: removeAttrRow(entry.attrs, effectiveFrom) })
  pendingAttrDeletes.value = [
    ...pendingAttrDeletes.value,
    { compId, company: entry.company, payrollCd: entry.payrollCd, effectiveFrom },
  ]
  employeeMasterMessage.value = `${entry.name} の ${effectiveFrom} の履歴を削除しました。「保存」で確定します`
}

/** 社員 1 件をローカル削除する (属性履歴ごと。「保存」で D1 からも消える)。 */
function removeEmployeeEntry(key: string) {
  const entry = findEmployeeByRowKey(key)
  if (!entry) return
  const { compId, company, payrollCd } = splitEmployeeRowKey(key)
  setEmployeeMasterEntries(
    compId,
    (employeeMasterByComp.value[compId] ?? []).filter(e => !(e.company === company && e.payrollCd === payrollCd)),
  )
  pendingEmployeeDeletes.value = [...pendingEmployeeDeletes.value, { compId, company, payrollCd }]
  if (attrHistoryKey.value === key) attrHistoryKey.value = null
  employeeMasterMessage.value = `${dtakoCompLabel(compId)} ${company} ${payrollCd} ${entry.name} を削除しました。「保存」で確定します`
}

/** 選択中の勤務月に対応する CSV 行。CSV の「給与・賞与名」の年月は**支給月**ラベル
 * (月末締め・翌月払い → 勤務月 + 1) なので、翌月ラベルの行を突合する (Refs #282)。 */
const salaryMonthRows = computed(() =>
  (salaryParsed.value?.rows ?? []).filter(r => r.month === nextYm(month.value)))

const salaryComparison = computed<SalaryComparison | null>(() => {
  if (!salaryParsed.value || !report.value || report.value.month !== month.value) return null
  return compareSalaryMonth(salaryMonthRows.value, report.value.rows, salaryItemConfig.value, salaryCdMap.value)
})

// ---- 給与比較タブの表示状態 (Refs #554) ----
// 「比較結果」カードは元々 `v-if="salaryParsed"` だったため、給与アーカイブの自動読み込みが
// 終わるまで**カードごと存在しなかった** = 文字通り「給与比較が出ない」。読み込み中なのか
// 取り込まれていないのかを画面から読み取れるよう、状態を 1 つの computed に集約する。

/** 閲覧中の会社に対応する給与大臣の会社 (= 給与DB取得・自動読み込みの対象)。 */
const sessionPayrollCompanies = computed(() =>
  compMap.value.find(c => c.compId === (session.value?.compId ?? ''))?.payrollCompanies ?? [])

/** まだ明細が増えうる状態 (自動読み込み待ち・取得中・判定材料が未解決)。 */
const payrollLoading = computed(() => {
  // 会社対応表と給与アーカイブの一覧が解決するまでは「無い」と判定できない
  if (!compMapLoaded.value || !kyuyoSyncedLoaded.value) return true
  if (loadingPayrollDb.value || autoPayrollLoading.value) return true
  // 自動読み込みの対象がまだ画面に載っていない (watch 発火待ち) 間も読み込み中扱い
  const payMonth = nextYm(month.value)
  return sessionPayrollCompanies.value.some(({ payrollCompany }) =>
    kyuyoSyncedKeys.value.has(`${payrollCompany}|${month.value}`)
    && !dbImports.value.some(i => i.company === payrollCompany && i.month === payMonth))
})

type SalaryStatus = 'loading-payroll' | 'no-payroll' | 'no-pay-month' | 'loading-report' | 'no-report' | 'ready'

/** 給与比較カードの中身の出し分け。**明細が既に有る月は読み込み中でも表を出す** —
 * 1 社分でも見えている方が「何も出ない」より役に立つ (残りは自動で足される)。 */
const salaryStatus = computed<SalaryStatus>(() => {
  if (salaryMonthRows.value.length) {
    if (loadingReport.value) return 'loading-report'
    return salaryComparison.value ? 'ready' : 'no-report'
  }
  if (payrollLoading.value) return 'loading-payroll'
  return salaryParsed.value ? 'no-pay-month' : 'no-payroll'
})

// ---- 給与比較の絞り込み・並べ替え (Refs #449) ----
// 単価マスタ・社員マスタと同じ作法。100 人超を素の並びで読むのは無理で、
// 見たいのは「37条を下回っている人」なので**差の小さい順**を既定の武器にする。

const salaryFilterText = ref('')
const salaryOnlyShortfall = ref(false)
const salarySortKey = ref<'cd' | 'shortfall' | 'overtime' | 'name'>('cd')

/** 表示する比較行 (絞り込み → 並べ替え)。 */
const salaryComparisonRows = computed(() => {
  const all = salaryComparison.value?.rows ?? []
  const q = salaryFilterText.value.normalize('NFKC').trim()
  const rows = all.filter((r) => {
    // 37条の差が負 = 実際の基礎単価に対する法定割増を下回っている人だけ
    if (salaryOnlyShortfall.value && !((r.diffCsvVsBaseRateOvertime ?? 0) < 0)) return false
    if (!q) return true
    // 乗務員CD と氏名のどちらでも引ける (総務は名前で探す)
    return `${r.driverCd} ${r.mappedDriverCd ?? ''} ${r.driverName}`.normalize('NFKC').includes(q)
  })
  const cd = (r: SalaryComparison['rows'][number]) =>
    String(r.mappedDriverCd ?? r.driverCd)
  const byCd = (a: SalaryComparison['rows'][number], b: SalaryComparison['rows'][number]) =>
    cd(a).localeCompare(cd(b), undefined, { numeric: true })
  return [...rows].sort((a, b) => {
    if (salarySortKey.value === 'shortfall') {
      // **下回りが大きい順** (負の絶対値が大きい順)。判定できない行 (基礎単価が
      // 出せない = null) は後ろへ — 0 扱いにすると健全な行に紛れる
      const av = a.diffCsvVsBaseRateOvertime
      const bv = b.diffCsvVsBaseRateOvertime
      return (av === null ? 1 : 0) - (bv === null ? 1 : 0) || (av ?? 0) - (bv ?? 0) || byCd(a, b)
    }
    if (salarySortKey.value === 'overtime') return b.sysOvertimeMinutes - a.sysOvertimeMinutes || byCd(a, b)
    if (salarySortKey.value === 'name') return a.driverName.localeCompare(b.driverName, 'ja') || byCd(a, b)
    return byCd(a, b)
  })
})

/** CSV の支給月ラベルをクリック → 対応する勤務月 (前月) を選択する。 */
function selectSalaryMonth(ym: string) {
  const work = prevYm(ym)
  selectedYear.value = parseInt(work.slice(0, 4), 10)
  selectedMonthNo.value = parseInt(work.slice(5, 7), 10)
}

/** 乗務員CD (正規化キー) → 給与明細 CSV の支払い実績 (基本給扱い / 割増扱いの合計)。
 * 給与比較タブで取り込んだ CSV から引く (支給月ラベル = 勤務月+1 の行、
 * salaryMonthRows 参照) — 未取り込みの月は空 (Refs #282)。 */
const paidByDriver = computed(() => {
  const map = new Map<string, {
    base: number
    overtime: number
    /** 内訳 (支給項目ごと)。ホバーで見せる (2026-07-30 要望)。 */
    baseItems: SalaryItemAmount[]
    overtimeItems: SalaryItemAmount[]
  }>()
  for (const r of salaryComparison.value?.rows ?? []) {
    map.set(String(Number(r.mappedDriverCd ?? r.driverCd)), {
      base: r.csvBase,
      overtime: r.csvOvertime,
      baseItems: r.csvBaseItems,
      overtimeItems: r.csvOvertimeItems,
    })
  }
  return map
})

function paidFor(driverCd: string) {
  return paidByDriver.value.get(String(Number(driverCd))) ?? null
}

/**
 * 給与 (支払い実績) の内訳ツールチップ (2026-07-30 要望)。
 * 「基本給: 項目名 金額円 / …」— 給与比較タブの `fmtItemsTitle` と同じ書式。
 * 未取り込みの月は空文字 (title 属性を出さない)。
 */
function minWagePaidTitle(driverCd: string): string {
  const paid = paidFor(driverCd)
  if (!paid) return ''
  const lines: string[] = []
  if (paid.baseItems.length) lines.push(`基本給 ${fmtYen(paid.base)}円 = ${fmtItemsTitle(paid.baseItems)}`)
  if (paid.overtimeItems.length) lines.push(`残業代 ${fmtYen(paid.overtime)}円 = ${fmtItemsTitle(paid.overtimeItems)}`)
  return lines.join('\n')
}

/**
 * 最低賃金チェックの表を **会社 → 職員区分 (事務員 → 作業員 → 整備 → 乗務員 → その他)**
 * で区切り、中を **営業所 → 乗務員CD** で並べる (ユーザー決定 2026-07-30)。
 *
 * 素の応答順 (乗務員CD 順) では会社も職種も混ざるので、100 人超を上から読んで
 * 「どの職員区分の人が下回っているか」を追えなかった。営業所の順は
 * 「その営業所が持つ最小の所属コード」— 詳細は `groupMinWageRows` の doc。
 */
const minWageSections = computed(() =>
  groupMinWageRows(
    report.value?.rows ?? [],
    row => row.summary.driverCd,
    row => minWageAttrsFor(row.summary.driverCd),
  ))

/**
 * 乗務員CD (正規化キー) → 右端の比較ブロック (計算 3 列 / 給与 2 列 / 比較 3 列、
 * ユーザー決定 2026-07-30)。
 *
 * 基本給(法定内) は左の内訳列 (対象時間 / @単価 / 金額) とここで**2 回出る** —
 * 左は時間の内訳を読む列、ここは金額を給与実績と突き合わせる列なので、
 * 比較ブロックを右端に揃えるために重複はそのまま残す (ユーザー了承)。
 */
const minWageCompareByDriver = computed(() => {
  const map = new Map<string, MinWageCompareRow>()
  for (const row of report.value?.rows ?? []) {
    const key = normalizeDriverCdKey(row.summary.driverCd)
    map.set(key, minWageCompareRow(
      {
        base: row.wage.amounts?.statutory ?? null,
        // 残業代合計 = 残業 (時間外+週40超過) + 深夜残業 (時間外深夜)
        overtime: sumNullable(row.wage.actualOvertimePay, row.wage.actualNightOvertimePay),
        total: row.wage.totalAmount,
      },
      paidFor(row.summary.driverCd),
    ))
  }
  return map
})

/** 比較ブロックの 1 行 (report に無い乗務員は全 null 相当)。 */
function minWageCompare(driverCd: string): MinWageCompareRow {
  return minWageCompareByDriver.value.get(normalizeDriverCdKey(driverCd))
    ?? minWageCompareRow({ base: null, overtime: null, total: null }, null)
}

/** 乗務員CD → 並べ替え・表示に使う所属 (社員マスタで引けない人は null)。 */
function minWageAttrsFor(driverCd: string): MinWageRowAttrs | null {
  return employeeOrderAttrsByDriver.value.get(normalizeDriverCdKey(driverCd)) ?? null
}

/** 氏名の下に出す営業所名 (`SHOZOKU.NAME1`)。**最低賃金は営業所の県で決まる**
 * (Refs #409) ので、並びの根拠と判定の根拠を同じ場所で見せる。 */
function minWageBranchLabel(driverCd: string): string {
  return minWageAttrsFor(driverCd)?.branchName ?? ''
}

/** 乗務員CD (正規化キー) → 給与明細の残業計上額 + 基礎単価(実績) (タイムカード表の
 * 残業「時間」比較用、Refs #441)。salaryComparison が無くても拘束側の時間は
 * summary から常に出せるので、ここが空でも「支給分」欄だけが "-" になる。 */
const paidOvertimeByDriver = computed(() => {
  const map = new Map<string, { csvOvertimeHours: number | null }>()
  for (const r of salaryComparison.value?.rows ?? []) {
    // 給与明細の勤怠欄にある残業時間そのもの。金額からの逆算はしない (2026-07-28)
    map.set(String(Number(r.mappedDriverCd ?? r.driverCd)), { csvOvertimeHours: r.csvOvertimeHours })
  }
  return map
})

/** 乗務員CD (正規化キー) → 給与明細【勤怠】セクションの出勤日数・公休日数
 * (タイムカード表の勤怠日数比較用、Refs #441)。欄が無ければ undefined のまま
 * (`SalaryComparisonRow.attendanceDays.csv` と同じ規則)。休日出勤日数は給与明細の
 * 様式に列が無いため突合しない (常に "-")。 */
const paidAttendanceByDriver = computed(() => {
  const map = new Map<string, { work?: number, publicHoliday?: number }>()
  for (const r of salaryComparison.value?.rows ?? []) {
    map.set(String(Number(r.mappedDriverCd ?? r.driverCd)), {
      work: r.attendanceDays.csv.work,
      publicHoliday: r.attendanceDays.csv.publicHoliday,
    })
  }
  return map
})

/** 基礎単価(実績) の表示 (円/h、整数丸め。null は "-")。 */
function fmtRatePerHour(v: number | null): string {
  return v == null ? '-' : Math.round(v).toLocaleString('ja-JP')
}

/** 差額表示 (0 は "±0"、正負は符号つき)。 */
function fmtDiff(v: number | null): string {
  if (v == null) return '-'
  if (v === 0) return '±0'
  return (v > 0 ? '+' : '') + v.toLocaleString('ja-JP')
}

/** 基本給計/残業計の内訳ツールチップ ("項目名: 金額円 / 項目名: 金額円")。 */
function fmtItemsTitle(items: Array<{ label: string, amount: number }>): string {
  return items.map(i => `${i.label}: ${fmtYen(i.amount)}円`).join(' / ')
}

// ---------------------------------------------------------------------------
// ③ 単価マスタ
// ---------------------------------------------------------------------------

const master = ref<WageMaster>({ drivers: {} })
const masterUpdatedAt = ref<string | null>(null)
const loadingMaster = ref(false)
const savingMaster = ref(false)
const newRates = ref<Record<string, { rate: string, from: string }>>({})
const selectedCds = ref<Set<string>>(new Set())
const bulkRate = ref('')
const bulkFrom = ref('')
const masterMessage = ref('')

async function loadMaster() {
  if (!session.value) return
  loadingMaster.value = true
  pageError.value = ''
  try {
    const res = await $fetch<{ exists: boolean, data: WageMaster | null, updated_at?: string | null }>(
      '/restraint-api/wage-master',
      { headers: authHeaders() },
    )
    master.value = res.data ?? { drivers: {} }
    masterUpdatedAt.value = res.updated_at ?? null
    if (month.value) {
      try {
        const s = await $fetch<{ summaries: Array<{ data: RestraintDriverSummary }> }>(
          '/restraint-api/archive/summaries',
          { headers: authHeaders(), query: { month: month.value } },
        )
        for (const row of s.summaries) {
          const cd = row.data.driverCd
          if (cd && !master.value.drivers[cd]) {
            master.value.drivers[cd] = { name: row.data.driverName, rates: [] }
          }
        }
      }
      catch {
        // summary 未取得の月でもマスタ編集自体は可能 (補完のみスキップ)
      }
    }
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    loadingMaster.value = false
  }
}

/** 乗務員CD → 社員マスタの会社/所属 (選択月時点)。単価マスタの絞り込みと
 * 並べ替えに使う (Refs #409)。 */
const employeeByDriverCd = computed(() => {
  const map = new Map<string, { company: string, companyLabel: string, branch: string, branchCode: number | null }>()
  for (const row of employeeMasterRows.value) {
    const cd = row.entry.driverCd
    if (!cd) continue
    map.set(cd, {
      company: row.entry.company,
      companyLabel: row.companyLabel,
      branch: row.current?.branch ?? '',
      // 所属コード (SHOZOKU.INCODE) = 給与大臣の所属順。並べ替えの基準 (Refs #409)
      branchCode: row.current?.branchCode ?? null,
    })
  }
  return map
})

/** 単価マスタの会社フィルタ ('all' = 全社)。 */
const masterCompanyFilter = ref('all')
/** 単価マスタの並べ替えキー。 */
const masterSortKey = ref<'cd' | 'branch' | 'rate'>('cd')

const masterCompanyOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const v of employeeByDriverCd.value.values()) {
    if (v.company && !seen.has(v.company)) seen.set(v.company, v.companyLabel || v.company)
  }
  return [
    { label: '全社', value: 'all' },
    ...[...seen].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([value, label]) => ({ label, value })),
  ]
})

/** 単価マスタの一覧。`current` は**選択中の年月時点**で有効な単価 (Refs #409)。
 * 以前は常に最新の 1 件を出していたため、1月を選んでいるのに 6月適用の単価が
 * 出て混乱した (2026-07-25 指摘)。月次集計の単価列と同じ基準に揃える。 */
const masterRows = computed(() => {
  const anchor = `${selectedYear.value}-${String(selectedMonthNo.value).padStart(2, '0')}-01`
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const rows = Object.entries(master.value.drivers)
    .map(([cd, driver]) => {
      const sorted = [...driver.rates].sort((a, b) => cmp(b.effectiveFrom, a.effectiveFrom))
      const emp = employeeByDriverCd.value.get(cd)
      return {
        cd,
        driver,
        current: sorted.find(r => r.effectiveFrom <= anchor) ?? null,
        history: sorted,
        company: emp?.company ?? '',
        companyLabel: emp?.companyLabel ?? '',
        branch: emp?.branch ?? '',
        branchCode: emp?.branchCode ?? null,
      }
    })
    .filter(r => masterCompanyFilter.value === 'all' || r.company === masterCompanyFilter.value)
  // localeCompare は ICU の照合順が OS 間で揺れるので、数値順が要る乗務員CD 以外は
  // 単純な大小比較で並べる
  return rows.sort((a, b) => {
    if (masterSortKey.value === 'branch') {
      // 所属コード (INCODE) 順 = 給与大臣が持つ所属の並び (Refs #409)。以前は所属名の
      // 文字コード順だったので `佐賀` が `本社` より先に来ていた。コード未取得の行
      // (再取り込み前・手入力) は後ろに寄せて名前順にする
      return (a.branchCode === null ? 1 : 0) - (b.branchCode === null ? 1 : 0)
        || (a.branchCode ?? 0) - (b.branchCode ?? 0)
        || cmp(a.branch, b.branch)
        || a.cd.localeCompare(b.cd, undefined, { numeric: true })
    }
    if (masterSortKey.value === 'rate') {
      const av = a.current?.hourlyRate ?? -1
      const bv = b.current?.hourlyRate ?? -1
      return bv - av || a.cd.localeCompare(b.cd, undefined, { numeric: true })
    }
    return a.cd.localeCompare(b.cd, undefined, { numeric: true })
  })
})

// ---- 単価履歴モーダル (Refs #253) ----

/** 履歴モーダルの対象乗務員CD (null = 閉)。 */
const rateHistoryCd = ref<string | null>(null)
const rateHistoryOpen = computed({
  get: () => rateHistoryCd.value !== null,
  set: (open: boolean) => {
    if (!open) rateHistoryCd.value = null
  },
})
const rateHistoryRow = computed(() =>
  rateHistoryCd.value === null ? null : masterRows.value.find(r => r.cd === rateHistoryCd.value) ?? null)

/** 履歴 1 件をローカル削除する (「保存」で確定)。 */
function removeRateEntry(cd: string, effectiveFrom: string) {
  const driver = master.value.drivers[cd]
  if (!driver) return
  driver.rates = driver.rates.filter(r => r.effectiveFrom !== effectiveFrom)
  masterMessage.value = `乗務員 ${cd} の ${effectiveFrom} の単価履歴を削除しました。「保存」で確定します`
}

function addRate(cd: string) {
  const input = newRates.value[cd]
  if (!input || !input.rate || !input.from) return
  const rate = Number(input.rate)
  if (!Number.isFinite(rate) || rate < 0) {
    masterMessage.value = `単価が不正です (${cd})`
    return
  }
  const driver = master.value.drivers[cd]
  if (!driver) return
  const existing = driver.rates.findIndex(r => r.effectiveFrom === input.from)
  if (existing >= 0) driver.rates[existing] = { effectiveFrom: input.from, hourlyRate: rate }
  else driver.rates.push({ effectiveFrom: input.from, hourlyRate: rate })
  driver.rates.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  newRates.value = { ...newRates.value, [cd]: { rate: '', from: input.from } }
}

// ---- 単価マスタに居ない乗務員を足す (Refs #568) ----
//
// 一覧は R2 の単価マスタ (`master.drivers`) から作るので、**まだ 1 件も履歴が無い人は
// 行が無く、単価を登録する手段が画面に無かった** (最低賃金チェックの「単価未設定:
// … 単価マスタタブで登録してください」に従っても登録できない)。CSV 取込か
// 「単価マスタへ一括設定」でしか入らないのは遠回りなので、行を足せるようにする。

/**
 * 追加できる候補 = 単価マスタにまだ居ない人。2 つの供給元を混ぜる:
 *
 * - **社員マスタ**の乗務員CD (このタブで読んでいる。会社・所属列の供給元と同じ)
 * - **読み込み済みの賃金集計に居る乗務員** — 最低賃金チェックの「単価未設定」警告に
 *   出る人は社員マスタに乗務員CD が無いことがあり (実測: 警告 2 名のうち 1 名)、
 *   社員マスタだけでは候補に出ず登録できない。**追加の fetch はしない** (集計が
 *   まだ無ければその分だけ候補に出ないだけ)
 */
const masterAddCandidates = computed(() => {
  const seen = new Map<string, string>()
  const add = (cd: string | null | undefined, name: string) => {
    if (!cd || master.value.drivers[cd]) return
    // 同じ人が複数会社に居ることがある (Refs #403) ので先勝ちで 1 つに畳む
    if (!seen.has(cd)) seen.set(cd, name ? `${cd} ${name}` : cd)
  }
  for (const row of employeeMasterRows.value) add(row.entry.driverCd, row.entry.name)
  for (const row of report.value?.rows ?? []) {
    add(normalizeDriverCdKey(row.summary.driverCd), row.summary.driverName)
  }
  return [...seen.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([value, label]) => ({ label, value }))
})

const newDriver = ref({ cd: '', rate: '', from: '' })

/** USelectMenu の選択値から乗務員CD を取り出す (文字列でも `{value}` でも受ける)。 */
function selectedDriverCd(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && 'value' in v) return String((v as { value: unknown }).value ?? '')
  return ''
}

/** 候補を選ぶと単価マスタに行を足す (**「保存」で確定**、他の編集と同じ作法)。 */
function addDriverToMaster() {
  const cd = newDriver.value.cd.trim()
  if (!cd || !newDriver.value.rate || !newDriver.value.from) return
  const rate = Number(newDriver.value.rate)
  if (!Number.isFinite(rate) || rate < 0) {
    masterMessage.value = `単価が不正です (${cd})`
    return
  }
  if (master.value.drivers[cd]) {
    masterMessage.value = `乗務員 ${cd} は既に一覧にあります (行の「新規単価」から追加してください)`
    return
  }
  // 氏名は社員マスタ → 賃金集計の順で引く (単価マスタ側は表示用にしか使わない)
  const name = employeeMasterRows.value.find(r => r.entry.driverCd === cd)?.entry.name
    ?? report.value?.rows.find(r => normalizeDriverCdKey(r.summary.driverCd) === cd)?.summary.driverName
  master.value = {
    ...master.value,
    drivers: {
      ...master.value.drivers,
      [cd]: { ...(name ? { name } : {}), rates: [{ effectiveFrom: newDriver.value.from, hourlyRate: rate }] },
    },
  }
  masterMessage.value = `乗務員 ${cd}${name ? ` ${name}` : ''} を単価 ${rate} 円 (適用 ${newDriver.value.from}) で追加しました。「保存」で確定します`
  // 適用開始日は連続入力しやすいよう残す (addRate と同じ作法)
  newDriver.value = { cd: '', rate: '', from: newDriver.value.from }
}

function toggleSelect(cd: string) {
  const next = new Set(selectedCds.value)
  if (next.has(cd)) next.delete(cd)
  else next.add(cd)
  selectedCds.value = next
}

function applyBulk() {
  if (!bulkRate.value || !bulkFrom.value || selectedCds.value.size === 0) return
  const rate = Number(bulkRate.value)
  if (!Number.isFinite(rate) || rate < 0) {
    masterMessage.value = '一括変更の単価が不正です'
    return
  }
  for (const cd of selectedCds.value) {
    const driver = master.value.drivers[cd]
    if (!driver) continue
    const existing = driver.rates.findIndex(r => r.effectiveFrom === bulkFrom.value)
    if (existing >= 0) driver.rates[existing] = { effectiveFrom: bulkFrom.value, hourlyRate: rate }
    else driver.rates.push({ effectiveFrom: bulkFrom.value, hourlyRate: rate })
    driver.rates.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  }
  masterMessage.value = `${selectedCds.value.size} 名に単価 ${rate} 円 (適用 ${bulkFrom.value}) を設定しました。保存で確定します`
}

async function saveMaster() {
  if (!session.value) return
  savingMaster.value = true
  pageError.value = ''
  try {
    const res = await $fetch<{ changed: boolean, data: WageMaster }>('/restraint-api/wage-master', {
      method: 'PUT',
      headers: authHeaders(),
      body: master.value,
    })
    master.value = res.data
    masterMessage.value = res.changed ? '保存しました (新しい版を作成)' : '保存しました (内容は前回と同一)'
    reportCache.clear()
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    savingMaster.value = false
  }
}

function exportMasterCsv() {
  const lines = ['乗務員CD,乗務員名,基本時間単価,適用開始日']
  const flat = masterRows.value.flatMap(row =>
    row.history.map(rate => ({ cd: row.cd, name: row.driver.name ?? '', rate })))
  // 適用開始日 降順 → 乗務員CD 昇順 (最新の改定グループが上に並ぶ)
  flat.sort((a, b) =>
    b.rate.effectiveFrom.localeCompare(a.rate.effectiveFrom)
    || a.cd.localeCompare(b.cd, undefined, { numeric: true }))
  for (const r of flat) {
    lines.push([r.cd, r.name, String(r.rate.hourlyRate), r.rate.effectiveFrom].join(','))
  }
  triggerDownload(new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), '単価マスタ.csv')
}

const csvFileInput = ref<HTMLInputElement | null>(null)

async function importMasterCsv(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  pageError.value = ''
  try {
    const text = await file.text()
    const res = await $fetch<{ changed: boolean, data: WageMaster }>('/restraint-api/wage-master/csv', {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'text/plain; charset=utf-8' },
      body: text.replace(/^﻿/, ''),
    })
    master.value = res.data
    masterMessage.value = res.changed ? 'CSV を取り込みました (新しい版を作成)' : 'CSV を取り込みました (変更なし)'
    reportCache.clear()
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    if (csvFileInput.value) csvFileInput.value.value = ''
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// 最低賃金 (単価マスタタブ内、全社共通 1 本の履歴、Refs #253)
// 乗務員の基本時間単価 (会社が決めた支給額) とは別に、法定の下限である
// 最低賃金 (国が都道府県ごとに定める) が要る。都道府県別マッピングまではせず、
// 全社共通の 1 履歴として単価マスタと同じタブで管理する。
// ---------------------------------------------------------------------------

const minWageMaster = ref<MinWageMaster>({ prefectures: {}, branchToPrefecture: {} })
const minWageMasterLoaded = ref(false)
const savingMinWage = ref(false)
const minWageMessage = ref('')
const newMinWageRate = ref('')
const newMinWageFrom = ref('')

async function loadMinWageMaster() {
  if (!session.value) return
  try {
    const res = await $fetch<{ exists: boolean, data: MinWageMaster | null }>(
      '/restraint-api/min-wage',
      { headers: authHeaders() },
    )
    minWageMaster.value = res.data ?? { prefectures: {}, branchToPrefecture: {} }
    minWageMasterLoaded.value = true
  }
  catch (e) {
    handleApiError(e)
  }
}

/** 全社共通の履歴 (新しい順)。 */
const minWageRows = computed(() =>
  [...(minWageMaster.value.prefectures[MIN_WAGE_DEFAULT_KEY] ?? [])].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)))

function addMinWageRate() {
  if (!newMinWageRate.value || !newMinWageFrom.value) return
  const rate = Number(newMinWageRate.value)
  if (!Number.isFinite(rate) || rate < 0) {
    minWageMessage.value = '最低賃金が不正です'
    return
  }
  const entries = [...(minWageMaster.value.prefectures[MIN_WAGE_DEFAULT_KEY] ?? [])]
  const existing = entries.findIndex(e => e.effectiveFrom === newMinWageFrom.value)
  if (existing >= 0) entries[existing] = { effectiveFrom: newMinWageFrom.value, rate }
  else entries.push({ effectiveFrom: newMinWageFrom.value, rate })
  entries.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  minWageMaster.value = {
    prefectures: { [MIN_WAGE_DEFAULT_KEY]: entries },
    branchToPrefecture: {},
    defaultPrefecture: MIN_WAGE_DEFAULT_KEY,
  }
  newMinWageRate.value = ''
  minWageMessage.value = ''
}

function removeMinWageRate(effectiveFrom: string) {
  const entries = (minWageMaster.value.prefectures[MIN_WAGE_DEFAULT_KEY] ?? []).filter(e => e.effectiveFrom !== effectiveFrom)
  minWageMaster.value = {
    prefectures: { [MIN_WAGE_DEFAULT_KEY]: entries },
    branchToPrefecture: {},
    defaultPrefecture: entries.length ? MIN_WAGE_DEFAULT_KEY : undefined,
  }
  minWageMessage.value = `${effectiveFrom} の最低賃金を削除しました。「保存」で確定します`
}

async function saveMinWageMaster() {
  if (!session.value) return
  savingMinWage.value = true
  pageError.value = ''
  try {
    const res = await $fetch<{ changed: boolean, data: MinWageMaster }>('/restraint-api/min-wage', {
      method: 'PUT',
      headers: authHeaders(),
      body: minWageMaster.value,
    })
    minWageMaster.value = res.data
    minWageMessage.value = res.changed ? '最低賃金を保存しました (新しい版を作成)' : '最低賃金を保存しました (内容は前回と同一)'
    reportCache.clear()
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    savingMinWage.value = false
  }
}

// ---------------------------------------------------------------------------
// 都道府県別の最低賃金 (Refs #409)
//
// 全社共通 1 本 (Refs #253) では拠点をまたぐ実態を表せない — 本番の拠点は
// 長崎・佐賀・福岡・大阪・北海道・広島に散っており、令和7年度で最大 147 円
// 開く。厚労省から 47 都道府県を取り込み、拠点ごとに県を割り当てる。
//
// **県は推定しない。** 「本社」が長崎県であるように拠点名から県は決まらない
// ため、初期値は入れず必ず人が選ぶ。未設定は未設定のまま警告する。
// ---------------------------------------------------------------------------

interface MinWageBranchGroup {
  prefix: string
  /** 所属コード (SHOZOKU.INCODE)。並びの根拠。表示名から推定したグループは null。 */
  branchCode: number | null
  branches: string[]
  employees: number
  prefecture: string | null
  matchedKey: string | null
}

const branchGroups = ref<MinWageBranchGroup[]>([])
const branchGroupsLoaded = ref(false)
const prefectureOptions = ref<string[]>([])
const minWagePrefectureCount = ref(0)
const importingMinWage = ref(false)
const loadingBranchGroups = ref(false)

async function loadBranchGroups() {
  if (!session.value) return
  loadingBranchGroups.value = true
  try {
    const res = await $fetch<{
      groups: MinWageBranchGroup[]
      unmapped: number
      prefectures: string[]
      minWagePrefectures: number
    }>('/restraint-api/min-wage/branches', { headers: authHeaders() })
    branchGroups.value = res.groups
    prefectureOptions.value = res.prefectures
    minWagePrefectureCount.value = res.minWagePrefectures
    branchGroupsLoaded.value = true
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    loadingBranchGroups.value = false
  }
}

/** 都道府県が未設定の拠点 (この分は最低賃金を引けない)。 */
const unmappedBranchGroups = computed(() => branchGroups.value.filter(g => g.prefecture === null))

async function importMinWageFromMhlw() {
  if (!session.value) return
  importingMinWage.value = true
  pageError.value = ''
  minWageMessage.value = ''
  try {
    const res = await $fetch<{
      changed: boolean
      prefectures: number
      added: number
      updated: number
      unchanged: number
      data: MinWageMaster
    }>('/restraint-api/min-wage/import-mhlw', { method: 'POST', headers: authHeaders() })
    minWageMaster.value = res.data
    minWagePrefectureCount.value = Object.keys(res.data.prefectures).length
    minWageMessage.value = res.changed
      ? `厚労省から ${res.prefectures} 都道府県を取り込みました (新規 ${res.added} / 更新 ${res.updated})`
      : `厚労省から ${res.prefectures} 都道府県を確認しました (改定なし)`
    reportCache.clear()
    await loadBranchGroups()
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    importingMinWage.value = false
  }
}

// 最低賃金を単価マスタへ一括設定する (「単価マスタ = 最低賃金」運用 Refs #282 / #409)。
// 月次集計に ⚠ 単価未設定 が並ぶと時間給が計算できないので、拠点の最低賃金を
// 既定値として流し込む。既に単価がある乗務員は既定で触らない。

interface MinWageApplyItem {
  driverCd: string
  branch: string
  prefecture: string | null
  rate: number | null
  /** その県の最低賃金の発効日 (厚労省が定めた日 = そのまま適用開始日にする)。 */
  rateEffectiveFrom: string | null
  status: 'add' | 'overwrite' | 'keep' | 'unmapped' | 'no-rate'
}
interface MinWageApplyResult {
  asOf: string
  added: number
  overwritten: number
  kept: number
  unresolved: number
  items: MinWageApplyItem[]
  saved: boolean
  changed: boolean
}


const applyOverwrite = ref(false)
const applyPreview = ref<MinWageApplyResult | null>(null)
const applyingMinWage = ref(false)

/** プレビューを県ごとにまとめる。発効日が県ごとに違うので、何がいつから入るのかを
 * 一覧で確認できるようにする (Refs #409)。 */
const applyPreviewByPrefecture = computed(() => {
  const map = new Map<string, { prefecture: string, rate: number, effectiveFrom: string, count: number }>()
  for (const it of applyPreview.value?.items ?? []) {
    if (!it.prefecture || it.rate == null || !it.rateEffectiveFrom) continue
    const cur = map.get(it.prefecture)
    if (cur) cur.count += 1
    else map.set(it.prefecture, { prefecture: it.prefecture, rate: it.rate, effectiveFrom: it.rateEffectiveFrom, count: 1 })
  }
  return [...map.values()].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0))
})

async function runApplyMinWage(dryRun: boolean) {
  if (!session.value) return
  applyingMinWage.value = true
  pageError.value = ''
  try {
    const res = await $fetch<MinWageApplyResult>('/restraint-api/min-wage/apply-to-wage-master', {
      method: 'POST',
      headers: authHeaders(),
      // asOf は「どの版の最低賃金か」と「所属を引く月」を決めるだけ。
      // 適用開始日は厚労省が定めた県ごとの発効日をそのまま使う
      body: { asOf: `${month.value}-01`, overwrite: applyOverwrite.value, dryRun },
    })
    if (dryRun) {
      applyPreview.value = res
      minWageMessage.value = ''
    }
    else {
      applyPreview.value = null
      minWageMessage.value = `単価マスタへ ${res.added} 名を新規設定しました (適用開始日は県ごとの発効日)`
        + (res.overwritten ? ` / ${res.overwritten} 名を上書き` : '')
        + (res.kept ? ` (既存単価あり ${res.kept} 名は据え置き)` : '')
      reportCache.clear()
      await loadMaster()
      if (report.value) await loadWageReport()
    }
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    applyingMinWage.value = false
  }
}

/** 拠点に都道府県を割り当てる (保存は「保存」ボタン)。 */
function setBranchPrefecture(prefix: string, prefecture: string | null) {
  const next = { ...minWageMaster.value.branchToPrefecture }
  if (prefecture) next[prefix] = prefecture
  else delete next[prefix]
  minWageMaster.value = { ...minWageMaster.value, branchToPrefecture: next }
  const group = branchGroups.value.find(g => g.prefix === prefix)
  if (group) {
    group.prefecture = prefecture
    group.matchedKey = prefecture ? prefix : null
  }
  minWageMessage.value = '「保存」で確定します'
}

// ---------------------------------------------------------------------------
// 勤務設定 — 所定労働時間 + 休日出勤の承認 (Refs #424 PR-C)
// ---------------------------------------------------------------------------
// どちらもタイムカード (社内 CakePHP) 由来の勤務を法定区分へ振り分けるための入力で、
// デジタコ (theearth) 由来の乗務員には効かない — 時間外は拘束時間 CSV がそのまま
// 持っているため。所定労働時間は「実働がこれを超えた分 = 時間外」の基準、休日出勤の
// 承認は「休日の打刻を割増対象にするか (= 休日出勤) / 賃金計算から外すか (= 自主出勤)」
// の判定に使う。
//
// **休憩の所定値は持たない** — 事務員は昼休憩で打刻を切っているため、休憩は打刻の
// 中抜けギャップと 12:00-13:00 の和集合から算出する (取り込み側の責務)。

interface WorkScheduleRow {
  effectiveFrom: string
  /** null = 全拠点 */
  branchCode: number | null
  /** null = 全職種 */
  jobName: string | null
  dailyWorkMinutes: number
}
interface HolidayWorkEntry { driverCd: string, workDate: string, reason: string | null }

const workSchedules = ref<WorkScheduleRow[]>([])
const workScheduleLoaded = ref(false)
const savingWorkSchedule = ref(false)
const workScheduleMessage = ref('')
const scheduleForm = ref({ effectiveFrom: '', branchCode: '', jobName: '', dailyWorkMinutes: '480' })

const holidayWorks = ref<HolidayWorkEntry[]>([])
const holidayWorkLoaded = ref(false)
const savingHolidayWork = ref(false)
const holidayWorkMessage = ref('')
const holidayForm = ref({ driverCd: '', workDate: '', reason: '' })

/** 分 → 「8.0 時間」表示 (入力は分だが、人が読むのは時間のため併記する)。 */
function fmtWorkHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} 時間`
}

async function loadWorkSchedule() {
  if (!session.value) return
  try {
    const res = await $fetch<{ schedules: WorkScheduleRow[] }>('/restraint-api/work-schedule', {
      headers: authHeaders(),
    })
    workSchedules.value = res.schedules
    workScheduleLoaded.value = true
  }
  catch (e) {
    handleApiError(e)
  }
}

/** loadHolidayWork の世代 (latest-wins、Refs #456。reportEpoch と同じ理由)。 */
let holidayWorkEpoch = 0

async function loadHolidayWork() {
  if (!session.value || !month.value) return
  const epoch = ++holidayWorkEpoch
  const ym = month.value
  try {
    const res = await $fetch<{ approvals: HolidayWorkEntry[] }>('/restraint-api/holiday-work', {
      headers: authHeaders(),
      query: { month: ym },
    })
    if (epoch !== holidayWorkEpoch) return // 古い月の応答は捨てる
    holidayWorks.value = res.approvals
    holidayWorkLoaded.value = true
  }
  catch (e) {
    if (epoch !== holidayWorkEpoch) return
    handleApiError(e)
  }
}

async function putWorkSchedule(body: Record<string, unknown>, message: string) {
  if (!session.value) return
  savingWorkSchedule.value = true
  pageError.value = ''
  try {
    await $fetch('/restraint-api/work-schedule', { method: 'PUT', headers: authHeaders(), body })
    workScheduleMessage.value = message
    await loadWorkSchedule()
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    savingWorkSchedule.value = false
  }
}

async function addWorkSchedule() {
  const minutes = Number(scheduleForm.value.dailyWorkMinutes)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduleForm.value.effectiveFrom)) {
    pageError.value = '適用開始日は YYYY-MM-DD で入力してください'
    return
  }
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) {
    pageError.value = '所定労働時間は 1〜1440 の整数 (分) で入力してください'
    return
  }
  await putWorkSchedule({
    schedules: [{
      effectiveFrom: scheduleForm.value.effectiveFrom,
      branchCode: scheduleForm.value.branchCode ? Number(scheduleForm.value.branchCode) : null,
      jobName: scheduleForm.value.jobName || null,
      dailyWorkMinutes: minutes,
    }],
  }, '所定労働時間を保存しました')
}

async function deleteWorkSchedule(row: WorkScheduleRow) {
  await putWorkSchedule({
    deleteSchedules: [{
      effectiveFrom: row.effectiveFrom,
      branchCode: row.branchCode,
      jobName: row.jobName,
    }],
  }, '所定労働時間の設定を削除しました')
}

async function putHolidayWork(body: Record<string, unknown>, message: string) {
  if (!session.value) return
  savingHolidayWork.value = true
  pageError.value = ''
  try {
    await $fetch('/restraint-api/holiday-work', { method: 'PUT', headers: authHeaders(), body })
    holidayWorkMessage.value = message
    await loadHolidayWork()
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    savingHolidayWork.value = false
  }
}

async function addHolidayWork() {
  if (!/^\d{1,8}$/.test(holidayForm.value.driverCd.trim())) {
    pageError.value = '乗務員CD は数字 (最大8桁) で入力してください'
    return
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayForm.value.workDate)) {
    pageError.value = '出勤日は YYYY-MM-DD で入力してください'
    return
  }
  await putHolidayWork({
    approvals: [{
      driverCd: holidayForm.value.driverCd.trim(),
      workDate: holidayForm.value.workDate,
      reason: holidayForm.value.reason || null,
    }],
  }, '休日出勤を承認しました')
}

async function deleteHolidayWork(entry: HolidayWorkEntry) {
  await putHolidayWork({
    deleteApprovals: [{ driverCd: entry.driverCd, workDate: entry.workDate }],
  }, '休日出勤の承認を取り消しました (この日は自主出勤に戻ります)')
}

// ---- 勤怠日数の突合列 (Refs #433 PR-E) ----
// 上段 = 打刻から数えた日数、下段 = 給与明細【勤怠】の日数。**差の判定はしない** —
// 事務員が実残業をつけていない運用があるのと同じで、日数の付け方にも運用差がある。
// 並べて見せるのが目的なので、色も警告も付けない (#424 の「差は出るのが前提」と同方針)。

const ATTENDANCE_COLUMNS = [
  { key: 'work' },
  { key: 'publicHoliday' },
  { key: 'paidLeave' },
  { key: 'absence' },
] as const

/** 日数の表示。**0 も「-」**にする — データを持たない行と 0 日をこの列で区別しても
 * 意味がないため。半休の 0.5 があるので小数は 1 桁残す。 */
function fmtDays(n: number | undefined): string {
  if (!n) return '-'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// ---- 夜勤者マスタ (Refs #433 PR-A) ----
// 日跨ぎ打刻を「打刻エラー」とみなす判定からの除外リスト。事務職の打刻が翌日に
// またがるのは通常 終業の押し忘れだが、夜勤者は正常に日をまたぐ。
// 併せて**未承認の休日打刻を自主出勤にしない**リストでもある (職種は問わない) —
// 夜勤ローテーションでは日曜も通常の勤務日なので平日として通常計上する。
// 履歴 (適用開始日 + 夜勤/解除) を持つのは、過去月を再取り込みした時に当時の姿を
// 再現するため — 行を消すと当時は正常だった打刻が一斉にエラーになる。

interface NightShiftEntry { driverCd: string, effectiveFrom: string, isNight: boolean }

const nightShifts = ref<NightShiftEntry[]>([])
const nightShiftLoaded = ref(false)
const savingNightShift = ref(false)
const nightShiftMessage = ref('')
const nightShiftForm = ref({ driverCd: '', effectiveFrom: '', isNight: true })

/** 乗務員CD → 氏名 (社員マスタから引く)。社員マスタ未読込・未登録なら空文字 —
 * 表示の補助でしかないので、引けなくても登録・解除は妨げない。 */
function driverNameOf(driverCd: string): string {
  return employeeMaster.value.find(e => e.driverCd === driverCd)?.name ?? ''
}

async function loadNightShift() {
  if (!session.value) return
  try {
    const res = await $fetch<{ workers: NightShiftEntry[] }>('/restraint-api/night-shift', {
      headers: authHeaders(),
    })
    nightShifts.value = res.workers
    nightShiftLoaded.value = true
  }
  catch (e) {
    handleApiError(e)
  }
}

async function putNightShift(body: Record<string, unknown>, message: string) {
  if (!session.value) return
  savingNightShift.value = true
  pageError.value = ''
  try {
    await $fetch('/restraint-api/night-shift', { method: 'PUT', headers: authHeaders(), body })
    nightShiftMessage.value = message
    await loadNightShift()
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    savingNightShift.value = false
  }
}

async function addNightShift() {
  if (!/^\d{1,8}$/.test(nightShiftForm.value.driverCd.trim())) {
    pageError.value = '乗務員CD は数字 (最大8桁) で入力してください'
    return
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nightShiftForm.value.effectiveFrom)) {
    pageError.value = '適用開始日は YYYY-MM-DD で入力してください'
    return
  }
  await putNightShift({
    workers: [{
      driverCd: nightShiftForm.value.driverCd.trim(),
      effectiveFrom: nightShiftForm.value.effectiveFrom,
      isNight: nightShiftForm.value.isNight,
    }],
  }, nightShiftForm.value.isNight ? '夜勤者に登録しました' : '夜勤者から解除しました')
}

async function deleteNightShift(entry: NightShiftEntry) {
  await putNightShift({
    deleteWorkers: [{ driverCd: entry.driverCd, effectiveFrom: entry.effectiveFrom }],
  }, '履歴の行を削除しました')
}

watch([activeTab, month, session, archiveMonthsLoaded], () => {
  if (!session.value || !month.value) return
  // archive/months の解決前は撃たない — 既定月 (アーカイブ無し) で wage-report が走る
  // 捨てフェッチと、その裏の R2 GET fan-out が同一 DO 上で他リクエストと競合するのを防ぐ。
  // 解決時に archiveMonthsLoaded が true へ変わり (月の付け替えも同 flush)、ここが一度だけ
  // 正しい月で発火する (Refs #451)
  if (!archiveMonthsLoaded.value) return
  // 上部バーの「給与DBから読み込み」はどのタブからでも押せるようにしている。
  // ボタンの活殺は compMap 由来 (importPayrollOptions) なので、タブに関係なく読む
  if (!compMap.value.length) loadCompMap()
  // 給与アーカイブがある会社は押さずに表示する (compMap / synced-months が後から
  // 解決するので、下の watch でも同じ関数を叩く)
  void autoLoadArchivedPayroll()
  if (activeTab.value === 'monthly' || activeTab.value === 'minwage') {
    if (!report.value || report.value.month !== month.value) loadWageReport()
    // 最低賃金 (法定下限) の設定カードは minwage タブに同居 (Refs #268 PR-E)
    if (activeTab.value === 'minwage' && !minWageMasterLoaded.value) loadMinWageMaster()
    // 拠点 → 都道府県の割り当て表 (Refs #409)
    if (activeTab.value === 'minwage' && !branchGroupsLoaded.value) loadBranchGroups()
    // 支払い実績 (給与) 列の分類・突合に使う (Refs #282)
    if (activeTab.value === 'minwage' && !salaryConfigLoaded.value) loadSalaryItemConfig()
    // minwage は突合 (支払い実績列)、monthly は CSV の 所属(マスタ)/給与体系 列で使う
    if (!employeeMasterLoaded.value) loadEmployeeMaster()
  }
  else if (activeTab.value === 'salary') {
    if (!report.value || report.value.month !== month.value) loadWageReport()
    if (!salaryConfigLoaded.value) loadSalaryItemConfig()
    if (!employeeMasterLoaded.value) loadEmployeeMaster()
  }
  else if (activeTab.value === 'items') {
    if (!salaryConfigLoaded.value) loadSalaryItemConfig()
  }
  // タイムカード表は wage-report の timecard 由来の行だけを使う (Refs #424 PR-E)。
  // **ここで読み込まないとタブを直接開いた時に空表になる** — 月次集計を先に開いて
  // いれば report が残っているので気付きにくい (dev の実機確認で踏んだ)
  else if (activeTab.value === 'timecard') {
    if (!report.value || report.value.month !== month.value) loadWageReport()
    // ドライバーの拘束・深夜は wage-report に乗らない別経路 (Refs #472)
    if (kosokuMonth.value !== month.value) loadKosokuDaily()
    // ドライバー行の会社と氏名は社員マスタで引く。`kosoku-daily` は会社で絞られて
    // いないので、**開いている会社だけ読むと他社の人が全員「会社不明」になる**
    // (Refs #472 PR-C)。他社は fail-soft (見えない会社は 401 で空のまま)
    loadAllEmployeeMasters()
    // 期間サマリーの 残業(給与) は給与比較と同じ `compareSalaryMonth` を通す。
    // **支給項目区分を読まないと全項目が既定区分に落ちて残業が 0 円になる** —
    // 給与比較タブでは 110,000 円なのにサマリーでは 0 という食い違いを本番で踏んだ
    // (2026-07-26)。社員マスタも突合キー (給与コード → 乗務員CD) の供給元なので要る
    if (!salaryConfigLoaded.value) loadSalaryItemConfig()
    if (!employeeMasterLoaded.value) loadEmployeeMaster()
  }
  else if (activeTab.value === 'archive') {
    loadArchive()
  }
  else if (activeTab.value === 'master') {
    if (Object.keys(master.value.drivers).length === 0) loadMaster()
    // 会社フィルタ・所属列・営業所順の並べ替えに使う (Refs #409)
    if (!employeeMasterLoaded.value) loadEmployeeMaster()
  }
  else if (activeTab.value === 'employees') {
    // 会社横断表示のため、選択中の範囲に必要な会社をまとめて読む (Refs #367)
    loadEmployeeMasterScope()
  }
  else if (activeTab.value === 'schedule') {
    // 所定・夜勤者は履歴全件なので 1 回だけ。承認簿は月で絞るので月が変わるたびに引き直す
    if (!workScheduleLoaded.value) loadWorkSchedule()
    if (!nightShiftLoaded.value) loadNightShift()
    // 夜勤者・承認簿の一覧に氏名を出すため (乗務員CD だけでは誰か分からない)
    if (!employeeMasterLoaded.value) loadEmployeeMaster()
    loadHolidayWork()
  }
}, { immediate: false })

// 給与アーカイブの自動表示は compMap (対応する給与大臣の会社) と synced-months
// (どの組がキャッシュ済みか) の**両方**が要る。どちらも上の watch より後に解決
// しうるので、揃った時点でもう一度叩く (中身は冪等 — 既に載っている組は飛ばす)。
watch([compMap, kyuyoSyncedKeys], () => {
  if (!session.value || !archiveMonthsLoaded.value) return
  void autoLoadArchivedPayroll()
})
</script>

<template>
  <div>
    <!-- 一括印刷ビュー (実行中はこれだけを表示 = 印刷対象) -->
    <div v-if="printBatch" class="p-4">
      <div class="flex items-center gap-3 mb-4 print:hidden">
        <span class="font-semibold">一括印刷プレビュー ({{ printBatch.length }} ヶ月)</span>
        <UButton size="xs" icon="i-lucide-printer" label="印刷" @click="printNow" />
        <UButton size="xs" variant="soft" icon="i-lucide-x" label="閉じる" @click="printBatch = null" />
      </div>
      <section v-for="page in printBatch" :key="page.ym" class="print-month-page mb-8">
        <h1 class="text-lg font-bold mb-2">乗務員拘束時間・時間給集計表 ({{ fmtYm(page.ym) }})</h1>
        <p v-if="!page.rows.length" class="text-sm text-gray-500">対象乗務員のデータがありません</p>
        <RestraintWageMonthlyTable v-else :rows="page.rows" :expand-wage="expandWage" />
      </section>
    </div>

    <!-- 期間サマリー印刷ビュー (実行中はこれだけを表示 = 印刷対象、Refs #443) -->
    <div v-else-if="summaryBatch" class="p-4">
      <div class="flex items-center gap-3 mb-4 print:hidden">
        <span class="font-semibold">期間サマリー ({{ summaryBatch.length }} ヶ月)</span>
        <UButton size="xs" icon="i-lucide-printer" label="印刷" @click="printNow" />
        <UButton size="xs" variant="soft" icon="i-lucide-x" label="閉じる" @click="summaryBatch = null" />
        <span class="text-xs text-gray-500">行をクリックすると、その人の日別表 (打刻) を開いて数字の根拠を確かめられます</span>
      </div>
      <section v-for="page in summaryBatch" :key="page.ym" class="print-month-page mb-8">
        <h1 class="text-lg font-bold mb-2">タイムカード集計表 ({{ fmtYm(page.ym) }})</h1>
        <p v-if="!page.rows.length" class="text-sm text-gray-500">この月にタイムカード由来の勤務がありません</p>
        <TimecardSummaryTable v-else :rows="page.rows" @select="cd => summaryDetail = { ym: page.ym, driverCd: cd }" />
      </section>

      <!-- 行クリックで開く日別表。印刷対象にしない (紙は一覧のまま) -->
      <UModal v-model:open="summaryDetailOpen" :ui="{ content: 'max-w-2xl' }" class="print:hidden">
        <template #content>
          <div v-if="summaryDetailSheet" class="p-6 max-h-[85vh] overflow-y-auto">
            <TimecardTable
              :driver-cd="summaryDetailSheet.driverCd"
              :driver-name="summaryDetailSheet.driverName"
              :month="summaryDetailSheet.ym"
              :rows="summaryDetailSheet.rows"
              :counts="summaryDetailSheet.counts"
            />
            <div class="mt-3 flex justify-end">
              <UButton size="sm" variant="soft" label="閉じる" @click="summaryDetail = null" />
            </div>
          </div>
        </template>
      </UModal>
    </div>

    <template v-else>
      <div class="print:hidden">
        <TheearthSessionHeader title="拘束×賃金 (集計・単価・印刷)" api-prefix="/restraint-api" wide />
      </div>

      <div class="p-6 space-y-4">
        <!-- 機能タブ -->
        <div class="flex flex-wrap items-center gap-3">
          <UButton
            v-for="tab in TABS"
            :key="tab.key"
            size="sm"
            :variant="activeTab === tab.key ? 'solid' : 'soft'"
            :label="tab.label"
            @click="activeTab = tab.key"
          />
        </div>

        <!-- 対象月: 年セレクタ + 月タブ。
             月が効かないタブ (支給項目区分・社員マスタ) では出さない — 選んでも
             何も変わらないのに操作できると、単価マスタで「1月を選んだのに 6月適用の
             単価が出る」ように誤解を招く (2026-07-25 指摘)。 -->
        <div v-if="MONTH_AWARE_TABS.includes(activeTab)" class="flex flex-wrap items-center gap-2 border border-gray-200 dark:border-gray-800 rounded-lg p-2">
          <USelect
            v-model="selectedYear"
            :items="yearOptions.map(y => ({ label: `${y}年`, value: y }))"
            size="sm"
            class="w-28"
          />
          <div class="flex flex-wrap gap-1">
            <!-- 各月の下に取り込み済みバッジ (Refs #460): ● タイムカード / ● 給与。
                 月を開かずに「どの月が作業済みか」を判断できるようにする -->
            <div v-for="m in 12" :key="m" class="flex flex-col items-center gap-0.5">
              <UButton
                size="xs"
                :variant="selectedMonthNo === m ? 'solid' : monthHasArchive(selectedYear, m) ? 'soft' : 'ghost'"
                :class="!monthHasArchive(selectedYear, m) && selectedMonthNo !== m ? 'opacity-40' : ''"
                :label="`${m}月`"
                @click="selectedMonthNo = m"
              />
              <span class="flex gap-0.5 h-1.5">
                <span
                  v-if="monthHasKintai(selectedYear, m)"
                  class="w-1.5 h-1.5 rounded-full bg-sky-500"
                  title="タイムカード取り込み済み"
                />
                <span
                  v-if="monthHasKyuyo(selectedYear, m)"
                  class="w-1.5 h-1.5 rounded-full bg-amber-500"
                  title="給与取り込み済み"
                />
                <!-- 高速表示可は 2 段階 (Refs #543 followup): フル = 同期済み +
                     kintai キャッシュ有り / 弱 (opacity-50) = 同期済みのみ。
                     キャッシュ有りでも上流の版が動けば読み直すため「目安」表示 -->
                <span
                  v-if="monthFastBadge(selectedYear, m) !== 'none'"
                  class="w-1.5 h-1.5 rounded-full bg-emerald-500"
                  :class="monthFastBadge(selectedYear, m) === 'synced-only' ? 'opacity-50' : ''"
                  :title="(monthFastBadge(selectedYear, m) === 'full'
                    ? '高速表示可 (拘束サマリ同期済み・キャッシュ有り)'
                    : '高速表示可 (拘束サマリ同期済み)')
                    + (monthIsTimecardSynced(selectedYear, m)
                      ? ' / タイムカードも同期済み'
                      : ' / タイムカードは未同期 (夜間バッチ待ち、表示自体には影響しません)')"
                />
                <!-- オンプレ vs GCP の畳み直し状況 (Refs #620)。**塗るのは
                     stale_drivers > 0 だけ** — 「GCPにしか無い運行」は混ぜない
                     (#620 の決定、毎月点灯する無意味な警告を避ける)。
                     total_drivers === 0 (データ無し) は「畳み済みで最新」とは
                     別の見た目 (灰) にする — 混同すると未取り込みの月が
                     収束済みに見える (#620 が解こうとしている問題そのもの) -->
                <button
                  v-if="monthStaleBadge(selectedYear, m) === 'stale'"
                  type="button"
                  class="w-1.5 h-1.5 rounded-full bg-red-500 cursor-pointer"
                  :title="`畳み直しが要ります (${monthStaleEntry(selectedYear, m)?.staleDrivers ?? '?'}名 / ${monthStaleEntry(selectedYear, m)?.totalDrivers ?? '?'}名中) — クリックで『オンプレ vs Supabase』タブへ`"
                  @click="jumpToGcpFold(selectedYear, m)"
                />
                <span
                  v-else-if="monthStaleBadge(selectedYear, m) === 'no_data'"
                  class="w-1.5 h-1.5 rounded-full bg-gray-400"
                  title="データ無し (GCP側にこの月の day_summaries が1行も無い — 未取り込み/対象外。畳み直しの警告ではありません)"
                />
              </span>
            </div>
          </div>
          <span class="text-xs text-gray-500 ml-auto">
            薄い月はアーカイブなし ・
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-sky-500 align-middle" /> タイムカード
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle ml-1" /> 給与
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 align-middle ml-1" /> 高速表示可 (キャッシュ有り)
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 opacity-50 align-middle ml-1" /> 同期のみ
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500 align-middle ml-1" /> 畳み直しが要る (オンプレ vs GCP)
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-gray-400 align-middle ml-1" /> GCP側データ無し
          </span>
        </div>

        <!-- 手動キャッシュ warm (Refs #554)。上流をデプロイすると版が変わって全月の
             キャッシュが miss になるので、開く前に押しておける口を出す -->
        <div v-if="warmTargetMonths.length" class="flex flex-wrap items-center gap-2 print:hidden">
          <UButton
            size="xs"
            variant="soft"
            icon="i-lucide-flame"
            :label="`キャッシュを温める (${warmTargetMonths.length} ヶ月)`"
            :loading="warming"
            :disabled="warming"
            title="上流の版が変わると全月のキャッシュが無効になります。月を順番に取り直して「高速表示可」に戻します (1 ヶ月あたり数秒)"
            @click="warmKintaiCache"
          />
          <span v-if="warmProgress" class="text-xs text-gray-500">{{ warmProgress }}</span>
          <span v-else-if="warmMessage" class="text-xs text-green-700 dark:text-green-400">{{ warmMessage }}</span>
          <span v-else class="text-xs text-gray-500">
            上流をデプロイした後は版が変わってキャッシュが効きません。押しておくと次から速くなります
          </span>
        </div>

        <!-- 上流の版が変わって取り直した時だけ出す (Refs #554)。「なぜ今回だけ遅かったのか」
             を画面で説明する — 出さないと「たまに遅い」が原因不明のままになる -->
        <UAlert
          v-if="MONTH_AWARE_TABS.includes(activeTab) && upstreamCacheState === 'miss' && !loadingReport"
          color="warning"
          variant="soft"
          class="print:hidden"
          icon="i-lucide-refresh-cw"
          :title="`上流のデータ版が変わっていたため取り直しました (${(reportElapsedMs / 1000).toFixed(1)} 秒)`"
          description="勤怠の元データか計算ロジックが更新されると、キャッシュしていた版は使えなくなります。この月はもう温まったので、次に開くときは速くなります。"
        />

        <!-- 未同期月を開いている時のバックフィル案内 (Refs #460)。「なぜこの月は
             遅いのか / どうすれば速くなるのか」を画面で説明する -->
        <UAlert
          v-if="MONTH_AWARE_TABS.includes(activeTab) && showBackfillHint"
          color="info"
          variant="soft"
          class="print:hidden"
          icon="i-lucide-zap"
          :title="`${fmtYm(month)} は同期前のため表示に数秒かかります`"
          description="アーカイブタブの「全月再計算」を 1 回実行すると全月が同期され、月切替が速くなります (theearth には接続しません)。"
        />

        <!-- 給与DBから読み込み: 全タブ共通の上部バー (2026-07-25 要望)。
             読み込んだ明細は最低賃金チェックの「基本給(給与)/残業代(給与)」列と
             給与比較タブの両方が使うので、タブを移動せずここで取れるようにする。
             期間は**勤務月**で指定する (画面の月タブと同じ基準)。 -->
        <div v-if="session" class="flex flex-wrap items-center gap-2 border border-sky-200 dark:border-sky-900 rounded-lg p-2">
          <span class="text-sm font-medium">給与DB</span>
          <USelect
            v-model="payrollRangeFrom"
            :items="payrollMonthOptions"
            size="xs"
            class="w-36"
            :aria-label="'給与DB取得の勤務月 (から)'"
          />
          <span class="text-xs text-gray-500">〜</span>
          <USelect
            v-model="payrollRangeTo"
            :items="payrollMonthOptions"
            size="xs"
            class="w-36"
            :aria-label="'給与DB取得の勤務月 (まで)'"
          />
          <UButton
            size="xs"
            icon="i-lucide-database"
            label="給与DBから読み込み"
            :loading="loadingPayrollDb"
            :disabled="!importPayrollOptions.length"
            :title="importPayrollOptions.length
              ? '給与大臣から支給明細を直接取得します (支給項目のみ・サーバーには保存しません)'
              : '会社対応表 (comp_payroll_map) にこの会社の給与会社が登録されていないため取得できません'"
            @click="loadPayrollFromDb"
          />
          <span class="text-xs text-gray-500">{{ payrollRangeHint }}</span>
          <span
            v-if="payrollDbMessage"
            class="text-xs ml-auto" :class="dbImports.length ? 'text-green-700 dark:text-green-400' : 'text-gray-500'"
          >{{ payrollDbMessage }}</span>
        </div>

        <p v-if="pageError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
          {{ pageError }}
        </p>

        <!-- 閲覧モードの会社ID選択 (Refs #272): このページは保存済みデータ (R2) の
             閲覧・設定のみで theearth ログイン不要。 -->
        <UCard v-if="!session" class="max-w-md">
          <template #header>
            <span class="font-medium">閲覧する会社IDを指定</span>
          </template>
          <div class="flex items-center gap-2">
            <UInput v-model="viewerCompInput" placeholder="会社ID (例: 1000)" class="w-40" @keyup.enter="startViewer" />
            <UButton label="閲覧開始" :disabled="!viewerCompInput.trim()" @click="startViewer" />
          </div>
          <p class="text-xs text-gray-500 mt-2">
            このページは取得済みアーカイブ・単価マスタ・給与比較の閲覧/設定のみで、theearth ログインは不要です
            (アーカイブの新規取得は /restraint-fetch で行います)。
          </p>
        </UCard>

        <!-- ⓪ アーカイブ閲覧 -->
        <template v-if="activeTab === 'archive'">
          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">アーカイブ ({{ fmtYm(month) }})</span>
                <span class="text-xs text-gray-500">summary {{ archiveSummaryCount }} 名 / データなし {{ archiveNoData.length }} 名</span>
                <div class="flex-1" />
                <UButton
                  size="xs"
                  variant="soft"
                  icon="i-lucide-calculator"
                  label="この月を再計算"
                  title="R2 に保存済みの生 CSV からサマリを作り直します (theearth には接続しません)"
                  :loading="resummarizing"
                  :disabled="!archiveRanges.length"
                  @click="resummarizeCurrent"
                />
                <UButton
                  size="xs"
                  variant="soft"
                  icon="i-lucide-layers"
                  label="全月一括再計算"
                  title="アーカイブが存在する全月のサマリを順に再計算します"
                  :loading="resummarizing"
                  @click="resummarizeAll"
                />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再読込" :loading="loadingArchive" @click="loadArchive" />
              </div>
            </template>
            <p v-if="resummarizeMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
              {{ resummarizeMessage }}
            </p>
            <!-- 全月一括再計算の進捗 -->
            <ul v-if="resummarizeProgress.length" class="space-y-1 text-sm mb-3 max-h-48 overflow-y-auto">
              <li v-for="item in resummarizeProgress" :key="item.ym" class="flex items-center gap-2">
                <span
                  class="size-2 rounded-full shrink-0"
                  :class="{
                    'bg-gray-300': item.status === 'pending',
                    'bg-blue-500 animate-pulse': item.status === 'running',
                    'bg-green-500': item.status === 'done',
                    'bg-red-500': item.status === 'error',
                  }"
                />
                <span>{{ fmtYm(item.ym) }}</span>
                <span v-if="item.detail" class="text-xs text-gray-500">{{ item.detail }}</span>
              </li>
            </ul>
            <p v-if="!archiveRanges.length && !loadingArchive" class="text-sm text-gray-500">
              この月のアーカイブはありません (/restraint-fetch で取得するとここに貯まります)
            </p>
            <div v-for="group in archiveRanges" :key="group.range" class="border border-gray-200 dark:border-gray-800 rounded-lg p-3 mb-3">
              <div class="flex flex-wrap items-center gap-3 text-sm">
                <span class="font-medium">取得範囲: {{ group.range === 'all' ? '全乗務員' : `乗務員 ${group.range}` }}</span>
                <template v-if="group.latest">
                  <span class="text-xs text-gray-500">
                    最新: {{ fmtArchiveTs(group.latest.fetched_at) }} 取得 /
                    <b>{{ fmtArchiveTs(group.latest.last_verified_at) }} まで同一内容を確認</b> /
                    {{ (group.latest.size / 1024).toFixed(1) }}KB
                  </span>
                  <UButton size="xs" variant="soft" icon="i-lucide-file-down" label="latest" @click="downloadArchiveCsv(group.latest)" />
                </template>
                <UButton
                  size="xs"
                  variant="ghost"
                  :icon="archiveHistory[group.range] ? 'i-lucide-chevron-up' : 'i-lucide-history'"
                  :label="`確認履歴${archiveHistory[group.range] ? 'を閉じる' : ''}`"
                  @click="toggleHistory(group.range)"
                />
              </div>
              <div v-if="group.versions.length" class="mt-2 flex flex-wrap gap-2">
                <UButton
                  v-for="v in group.versions"
                  :key="v.key"
                  size="xs"
                  variant="outline"
                  icon="i-lucide-file-clock"
                  :label="`版 ${fmtArchiveTs(v.fetched_at) !== '-' ? fmtArchiveTs(v.fetched_at) : v.file}`"
                  @click="downloadArchiveCsv(v)"
                />
              </div>
              <table v-if="archiveHistory[group.range]" class="w-full text-xs mt-3">
                <thead>
                  <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th class="px-2 py-1">確認日時</th>
                    <th class="px-2 py-1">結果</th>
                    <th class="px-2 py-1 text-right">サイズ</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(h, i) in archiveHistory[group.range]" :key="i" class="border-b border-gray-100 dark:border-gray-800">
                    <td class="px-2 py-1">{{ fmtArchiveTs(h.ts) }}</td>
                    <td
                      class="px-2 py-1"
                      :class="{
                        'text-green-600': h.result === 'new-version',
                        'text-gray-500': h.result === 'unchanged',
                        'text-amber-600': h.result === 'no-data',
                      }"
                    >
                      {{ HISTORY_RESULT_LABEL[h.result ?? ''] ?? h.raw ?? h.result }}
                    </td>
                    <td class="px-2 py-1 text-right">{{ h.bytes ? `${(h.bytes / 1024).toFixed(1)}KB` : '-' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="archiveNoData.length" class="text-xs text-amber-600 dark:text-amber-400">
              該当データなし (途中入社・休職・未集計 等): 乗務員 {{ archiveNoData.join(', ') }}
            </p>
          </UCard>
        </template>

        <!-- ① 月次集計・印刷 / ② 最低賃金チェック -->
        <template v-else-if="activeTab === 'monthly' || activeTab === 'minwage'">
          <!-- 一括印刷の条件 (①のみ) -->
          <UCard v-if="activeTab === 'monthly'">
            <div class="flex flex-wrap items-end gap-3">
              <span class="text-sm font-medium">一括印刷:</span>
              <UFormField label="月 (から)">
                <USelect
                  v-model="printFrom"
                  :items="[...archiveMonths].sort().map(ym => ({ label: fmtYm(ym), value: ym }))"
                  size="sm"
                  class="w-36"
                  placeholder="選択"
                />
              </UFormField>
              <UFormField label="月 (まで)">
                <USelect
                  v-model="printTo"
                  :items="[...archiveMonths].sort().map(ym => ({ label: fmtYm(ym), value: ym }))"
                  size="sm"
                  class="w-36"
                  placeholder="選択"
                />
              </UFormField>
              <UFormField label="乗務員CD (から)">
                <UInput v-model="printDriverFrom" size="sm" class="w-24" placeholder="空=全員" />
              </UFormField>
              <UFormField label="乗務員CD (まで)">
                <UInput v-model="printDriverTo" size="sm" class="w-24" placeholder="空=全員" />
              </UFormField>
              <UButton
                size="sm"
                icon="i-lucide-printer"
                :label="printing ? printProgress || '準備中...' : `一括印刷 (${printMonths.length} ヶ月)`"
                :loading="printing"
                :disabled="printMonths.length === 0"
                @click="runBatchPrint"
              />
              <span class="text-xs text-gray-500">月毎に改ページして印刷します (時間給内訳は下の展開状態を反映)</span>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">{{ activeTab === 'monthly' ? '月次集計' : '最低賃金チェック' }} ({{ fmtYm(month) }})</span>
                <span v-if="month" class="text-xs text-gray-500">月末締め・翌月払い — 支給月: {{ fmtYm(nextYm(month)) }}</span>
                <div class="flex-1" />
                <template v-if="activeTab === 'monthly'">
                  <UButton
                    size="xs"
                    variant="soft"
                    :icon="expandWage ? 'i-lucide-chevrons-left' : 'i-lucide-chevrons-right'"
                    :label="expandWage ? '時間給内訳を閉じる' : '時間給内訳を展開'"
                    @click="expandWage = !expandWage"
                  />
                  <UButton size="xs" variant="soft" icon="i-lucide-file-down" label="CSV" :disabled="!report?.rows.length" @click="downloadMonthlyCsv" />
                </template>
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再計算" :loading="loadingReport" @click="loadWageReport" />
              </div>
            </template>

            <p v-for="w in report?.warnings ?? []" :key="w" class="text-xs text-amber-600 dark:text-amber-400 mb-1">⚠ {{ w }}</p>
            <p v-if="missingRateRows.length" class="text-xs text-amber-600 dark:text-amber-400 mb-1">
              ⚠ 単価未設定: {{ missingRateRows.map(r => `${r.summary.driverCd} ${r.summary.driverName}`).join(', ') }} (単価マスタタブで登録してください)
            </p>

            <p v-if="!report?.rows.length && !loadingReport" class="text-sm text-gray-500">
              この月の summary がアーカイブにありません (/restraint-fetch で取得するか、アーカイブタブで再計算してください)
            </p>

            <!-- 初回読み込み中 (report がまだ無い) は下の staleReport に該当せず、
                 カードの中身が**丸ごと空**だった (Refs #554)。ヘッダーだけのカードが
                 十数秒出る状態は「壊れている」と読まれるので、ここで言い切る。 -->
            <div v-if="!report && loadingReport" class="flex items-center gap-2 text-sm text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
              集計を読み込んでいます… ({{ fmtYm(month) }})
            </div>

            <!-- 更新中は「古い数字を今の値として読ませない」(2026-07-25 指摘)。
                 スピナーがボタン側だけだと、月を切り替えた直後や再取得中に前の月の表が
                 そのまま残っていることに気付けず、見間違いのもとになる。表を薄くして
                 スピナーを重ね、操作も止める (行を消すと位置を失うので消さずに薄くする)。
                 給与比較タブは元から読み込み中は表を出さない実装なので対象外。 -->
            <div
              v-if="staleReport"
              class="sticky top-0 z-10 mb-1 flex items-center justify-center gap-2 rounded bg-amber-50/95 dark:bg-amber-950/95 py-2"
            >
              <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-primary" />
              <span class="text-sm font-medium">更新中 — 表示中の数字は取得前のものです</span>
            </div>

            <template v-if="activeTab === 'monthly' && report?.rows.length">
              <RestraintWageMonthlyTable
                :rows="report.rows"
                :expand-wage="expandWage"
                :class="staleReport ? STALE_CLASS : ''"
              />
              <p class="text-xs text-gray-500 mt-2">
                時間外・週40超過・深夜・時間外深夜・法定休日は<b>最低賃金チェックタブと同じ法定区分</b>です
                (2026-07-28 に統一)。<b>法定休日 (既定 日曜) の実働は時間外に入りません</b> —
                労基法上その日に時間外の概念は無く、割増は休日割増 1.35 倍 (深夜は 1.6 倍) に一本化されるためで、
                法定休日列に丸ごと出ます。深夜は残業ではない通常勤務中の分だけ (実働の内数)。
                区分ごとの単価・金額と検算 (差分列) は最低賃金チェックタブで見られます。
              </p>
            </template>

            <div
              v-else-if="activeTab === 'minwage' && report?.rows.length"
              class="overflow-auto max-h-[75vh] print:max-h-none print:overflow-visible"
              :class="staleReport ? STALE_CLASS : ''"
            >
              <table class="minwage-table w-full text-sm">
                <!-- 右端の突合ブロックは**縦 3 段** (ユーザー決定 2026-07-30):
                     1 列 = 1 つの金額 (基本給 / 残業代合計 / 合計) で、中を
                     計算 → 給与 → 差 の 3 行に積む。横 8 列に開くと 17 列になって
                     紙にも画面にも収まらないため。左の区分列は時間の内訳を読む列で、
                     金額の突合はここだけで完結させる (基本給が 2 回出るのは承知の上) -->
                <thead>
                  <!-- **ヘッダーは常に表示** (2026-07-30 要望)。100 人超をスクロールすると
                       どの列を見ているか分からなくなるため。表側を縦スクロールの容れ物
                       (max-h + overflow-auto) にして thead を sticky にする — 親が
                       overflow-x-auto だけだと縦方向も暗黙にスクロール容器になり、
                       ページスクロールでは固定されない。**印刷時は解除** (紙は一覧が
                       途切れると読めない) -->
                  <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 align-bottom">乗務員CD</th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 align-bottom">氏名<br><span class="font-normal text-xs">(営業所)</span></th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom">実働</th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom border-l border-gray-200 dark:border-gray-700" title="法定時間内賃金 (深夜・残業等の割増区分を含まない基本部分)。対象時間 = 実働 − 時間外 − 時間外深夜 − 週40超過 − 法定休日実働。「給与比較」タブの基本給(計算)と同じ値">基本給(法定内)<br><span class="font-normal text-xs">(対象時間 / @単価 / 金額)</span></th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom" title="残業ではない通常勤務中の深夜加算分 (0.25倍、基本給とは別枠の上乗せ)。@ は計算単価 (加算分 0.25 倍のみ)">深夜(通常)<br><span class="font-normal text-xs">(対象時間 / @単価 / 金額)</span></th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom border-l border-gray-200 dark:border-gray-700" title="対象時間 = 時間外 + 週40超過 (2段表示)。@ は残業単価 (基礎時給 + 割増加算分の実額按分、基礎込み)。月60時間超過は時間が橙色">残業代<br><span class="font-normal text-xs">(時間外 / 週40超過 / @単価 / 金額)</span></th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom" title="対象時間 = 時間外深夜。@ は深夜残業単価 (基礎時給 + 割増加算分の実額按分、基礎込み)">深夜残業代<br><span class="font-normal text-xs">(対象時間 / @単価 / 金額)</span></th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom border-l border-gray-200 dark:border-gray-700" title="法定休日 (既定 日曜) の実働すべて (1.35倍、深夜分は1.6倍)。@ は通常+深夜合算の実額按分">法定休日<br><span class="font-normal text-xs">(通常 / 深夜 / @単価 / 金額)</span></th>
                    <!-- 祝日・会社指定休に出勤した日だけ入る区分。有る月だけ列を出す (Refs #566) -->
                    <th v-if="hasNonLegalHolidayWork" class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom" title="法定外休日 (祝日・会社指定休に出勤した日) の実働すべて。土曜は平日扱いなのでここには入らない (2026-07-18 決定)。@ は通常+深夜合算の実額按分">法定外休日<br><span class="font-normal text-xs">(通常 / 深夜 / @単価 / 金額)</span></th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom" title="実働 − (法定内 + 時間外 + 週40超過 + 時間外深夜 + 法定休日 + 法定外休日)。9 区分すべてを引いているので、0 以外 = 日別データの不整合 — 検算用">差分<br><span class="font-normal text-xs">(実働 − 表合計)</span></th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom border-l-2 border-gray-300 dark:border-gray-600" title="単価マスタ × 拘束時間データの換算理論値。上段=基本給(法定内) / 中段=残業代合計 (残業+深夜残業) / 下段=合計 (全区分合計)">計算<br><span class="font-normal text-xs">(基本給 / 残業代 / 合計)</span></th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom border-l border-gray-200 dark:border-gray-700" title="給与比較タブで取り込んだ給与明細の実績 (勤務月+1 の支給月ラベルで突合)。上段=基本給扱い項目の合計 / 中段=割増扱い項目 (残業・深夜・休日出勤) の合計 / 下段=その 2 つの合計">給与<br><span class="font-normal text-xs">(基本給 / 残業代 / 合計)</span></th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 print:static px-2 py-2 text-right align-bottom border-l border-gray-200 dark:border-gray-700" title="給与 − 計算。マイナス (赤) = 支払いが換算理論値を下回っている。どちらか欠けている行は「-」">差<br><span class="font-normal text-xs">(基本給 / 残業代 / 合計)</span></th>
                  </tr>
                </thead>
                <!-- **会社 → 職員区分**で区切り、中は 営業所 (所属コード) → 乗務員CD 順
                     (ユーザー決定 2026-07-30)。区切りが無いと 100 人超の並びで
                     「どの職員区分が下回っているか」を追えない。最低賃金は営業所の県で
                     決まる (Refs #409) ので営業所も氏名の下に出す -->
                <!-- 1 tbody = 1 分類。印刷は分類ごとに改ページ (`.minwage-section`) -->
                <tbody
                  v-for="section in minWageSections"
                  :key="`${section.company ?? 'unknown'}|${section.jobGroup}`"
                  class="minwage-section"
                >
                  <tr class="minwage-section-head bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
                    <td :colspan="minWageColumnCount" class="px-2 py-1.5 text-xs font-semibold">
                      {{ section.company ? payrollCompanyLabelOf(compMap, section.company) : '会社不明 (社員マスタに乗務員CDの登録なし)' }}
                      <span class="mx-1 text-gray-400">/</span>
                      {{ MIN_WAGE_JOB_GROUP_LABEL[section.jobGroup] }}
                      <span class="ml-1 font-normal text-gray-500">{{ section.rows.length }} 名</span>
                    </td>
                  </tr>
                  <tr
                    v-for="row in section.rows"
                    :key="row.summary.driverCd"
                    class="border-b border-gray-100 dark:border-gray-800"
                  >
                    <td class="px-2 py-1.5">{{ row.summary.driverCd }}</td>
                    <td class="px-2 py-1.5">
                      <div>{{ row.summary.driverName }}</div>
                      <div v-if="minWageBranchLabel(row.summary.driverCd)" class="text-xs text-gray-500">
                        {{ minWageBranchLabel(row.summary.driverCd) }}
                      </div>
                    </td>
                    <td class="px-2 py-1.5 text-right">{{ fmtMinutes(row.summary.workingMinutes) }}</td>
                    <td class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700">
                      <div class="text-xs text-gray-500">{{ fmtMinutes(row.wage.minutes.statutory) }}</div>
                      <div class="text-xs text-gray-400">{{ fmtAtRate(row.wage.amounts?.statutory ?? null, row.wage.minutes.statutory) }}</div>
                      <div class="font-medium">{{ fmtYen(row.wage.amounts?.statutory ?? null) }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-right">
                      <div class="text-xs text-gray-500">{{ fmtMinutes(row.wage.minutes.night) }}</div>
                      <div class="text-xs text-gray-400">{{ fmtAtRate(row.wage.amounts?.night ?? null, row.wage.minutes.night) }}</div>
                      <div class="font-medium">{{ fmtYen(row.wage.amounts?.night ?? null) }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700">
                      <div class="text-xs" :class="row.wage.overtimeMinutes > 60 * 60 ? 'text-amber-600 font-medium' : 'text-gray-500'">{{ fmtMinutes(row.wage.minutes.overtime) }}</div>
                      <div class="text-xs" :class="row.wage.overtimeMinutes > 60 * 60 ? 'text-amber-600' : 'text-gray-500'">{{ fmtMinutes(row.wage.minutes.weekly40Excess) }}</div>
                      <div class="text-xs text-gray-400">{{ fmtAtRate(row.wage.actualOvertimePay, row.wage.overtimeMinutes) }}</div>
                      <div class="font-medium">{{ fmtYen(row.wage.actualOvertimePay) }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-right">
                      <div class="text-xs text-gray-500">{{ fmtMinutes(row.wage.nightOvertimeMinutes) }}</div>
                      <div class="text-xs text-gray-400">{{ fmtAtRate(row.wage.actualNightOvertimePay, row.wage.nightOvertimeMinutes) }}</div>
                      <div class="font-medium">{{ fmtYen(row.wage.actualNightOvertimePay) }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700">
                      <div class="text-xs text-gray-500">{{ fmtMinutes(row.wage.minutes.legalHoliday) }}</div>
                      <div class="text-xs text-gray-500">{{ fmtMinutes(row.wage.minutes.legalHolidayNight) }}</div>
                      <div class="text-xs text-gray-400">{{ fmtAtRate(sumNullable(row.wage.amounts?.legalHoliday ?? null, row.wage.amounts?.legalHolidayNight ?? null), row.wage.minutes.legalHoliday + row.wage.minutes.legalHolidayNight) }}</div>
                      <div class="font-medium">{{ fmtYen(sumNullable(row.wage.amounts?.legalHoliday ?? null, row.wage.amounts?.legalHolidayNight ?? null)) }}</div>
                    </td>
                    <td v-if="hasNonLegalHolidayWork" class="px-2 py-1.5 text-right">
                      <div class="text-xs text-gray-500">{{ fmtMinutes(row.wage.minutes.nonLegalHoliday) }}</div>
                      <div class="text-xs text-gray-500">{{ fmtMinutes(row.wage.minutes.nonLegalHolidayNight) }}</div>
                      <div class="text-xs text-gray-400">{{ fmtAtRate(sumNullable(row.wage.amounts?.nonLegalHoliday ?? null, row.wage.amounts?.nonLegalHolidayNight ?? null), row.wage.minutes.nonLegalHoliday + row.wage.minutes.nonLegalHolidayNight) }}</div>
                      <div class="font-medium">{{ fmtYen(sumNullable(row.wage.amounts?.nonLegalHoliday ?? null, row.wage.amounts?.nonLegalHolidayNight ?? null)) }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-right">
                      <span :class="unaccountedMinutes(row) === 0 ? 'text-xs text-gray-400' : 'text-red-600 font-bold'">
                        {{ fmtSignedMinutes(unaccountedMinutes(row)) }}
                      </span>
                    </td>
                    <!-- 右端の突合ブロック: 1 列 = 計算 / 給与 / 差、中を
                         基本給 → 残業代合計 → 合計 の 3 段に積む (ユーザー決定 2026-07-30、
                         金額を列にした版の縦横を入れ替えたもの — 同じ金額どうしが横に
                         並ぶので差を目で追える)。差はマイナス (支払いが理論値より少ない)
                         だけ赤 — プラスは手当等の上乗せで珍しくないため色を付けない
                         (給与比較タブと同じ扱い) -->
                    <td class="px-2 py-1.5 text-right border-l-2 border-gray-300 dark:border-gray-600">
                      <div class="text-xs text-gray-500">{{ fmtYen(minWageCompare(row.summary.driverCd).calcBase) }}</div>
                      <div class="text-xs text-gray-500">{{ fmtYen(minWageCompare(row.summary.driverCd).calcOvertime) }}</div>
                      <div class="font-medium">{{ fmtYen(minWageCompare(row.summary.driverCd).calcTotal) }}</div>
                    </td>
                    <!-- 給与はホバーで支給項目の内訳を見せる (2026-07-30 要望)。
                         どの項目が基本給扱い / 割増扱いに入ったかは「支給項目区分」の
                         設定で決まるので、金額だけだと確かめようが無い -->
                    <td
                      class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700"
                      :title="minWagePaidTitle(row.summary.driverCd)"
                    >
                      <div class="text-xs text-gray-500">{{ fmtYen(minWageCompare(row.summary.driverCd).paidBase) }}</div>
                      <div class="text-xs text-gray-500">{{ fmtYen(minWageCompare(row.summary.driverCd).paidOvertime) }}</div>
                      <div class="font-medium">{{ fmtYen(minWageCompare(row.summary.driverCd).paidTotal) }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700">
                      <div
                        class="text-xs"
                        :class="(minWageCompare(row.summary.driverCd).diffBase ?? 0) < 0 ? 'text-red-600 font-medium' : 'text-gray-500'"
                      >
                        {{ fmtDiff(minWageCompare(row.summary.driverCd).diffBase) }}
                      </div>
                      <div
                        class="text-xs"
                        :class="(minWageCompare(row.summary.driverCd).diffOvertime ?? 0) < 0 ? 'text-red-600 font-medium' : 'text-gray-500'"
                      >
                        {{ fmtDiff(minWageCompare(row.summary.driverCd).diffOvertime) }}
                      </div>
                      <div
                        class="font-medium"
                        :class="(minWageCompare(row.summary.driverCd).diffTotal ?? 0) < 0 ? 'text-red-600' : 'text-gray-500'"
                      >
                        {{ fmtDiff(minWageCompare(row.summary.driverCd).diffTotal) }}
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p class="text-xs text-amber-600 dark:text-amber-400 mb-2">
                ⚠ この表は「単価マスタに登録した単価」をデジタコの拘束時間データで換算した<b>理論値</b>です。
                実際に支払われた給与 (振込額) を検証するものではありません。支払い済み金額の検証は「給与比較」タブをご利用ください。
                単価は「単価マスタ」タブで管理します。
              </p>
              <p class="text-xs text-gray-500 mt-2">
                並びは<b>給与大臣の会社コード → 職員区分 (事務員 → 作業員 → 整備 → 乗務員 → その他) → 営業所 → 乗務員CD</b> 順。
                職員区分は社員マスタの職種名 (<code>SHOZOKU.NAME2</code>、対象月末時点) から判定し、タイムカード表と同じ区分を使う。
                営業所の順は<b>その営業所が持つ最小の所属コード</b> (<code>SHOZOKU.INCODE</code>) — 1 つの営業所が職種ごとに別コードを持つため
                (<code>本社 乗務員</code> と <code>本社 乗務員(トレーラ)</code>)、コードそのまま並べると同じ営業所が区分の中で割れる。
                氏名の下は営業所名 (<code>SHOZOKU.NAME1</code>) — 最低賃金は就業地の都道府県で決まるため、同じ営業所の人は同じ下限で判定される。
                社員マスタで会社が引けない人は末尾の「会社不明」にまとめている (落とすと未登録の人が黙って消えるため)。<br>
                右端は<b>金額の突合ブロック</b> — 1 列 = <b>計算 / 給与 (支払い実績) / 差 (給与 − 計算)</b> で、中を
                <b>上段 基本給 → 中段 残業代合計 → 下段 合計</b> の 3 段に積んでいる (同じ金額どうしが横に並ぶ)。
                差はマイナス = 支払いが換算理論値を下回っている印 (赤)。プラスは各種手当の上乗せで珍しくないため色は付けない。
                どちらか片方が無い行 (給与明細 未取り込み・単価未設定) は 0 ではなく「-」。
                合計 差 は <b>(基本給+残業代)(給与) − 合計(計算)</b> で、計算側の合計には深夜・法定休日も入る。
                <b>基本給は左の内訳列と右のブロックで 2 回出る</b> — 左は対象時間・@単価つきで時間の内訳を読む列、右は金額を給与実績と並べる列。<br>
                合計(計算) = 基本給 + 深夜 + 残業代合計 + 法定休日 (全区分合計、「給与比較」タブの合計(計算)と同じ値)。<br>
                給与側は<b>支払い済み給与の実績</b> — 給与比較タブで取り込んだ給与明細 CSV の基本給扱い / 割増扱い項目の合計。CSV の年月ラベルは支給月なので、勤務月+1 (翌月支給) の行を突合している。
                月末締め・翌月払いのため実際の支給は翌月 (ヘッダの支給月表示)。CSV 未取り込みの月は「-」。項目の区分は「支給項目区分」の設定に従う。<br>
                <b>実働 = 基本給(法定内)の対象時間 + 時間外 + 週40超過 + 時間外深夜 + 法定休日(通常+深夜) + 法定外休日(通常+深夜)</b>。
                法定外休日は<b>祝日・会社指定休に出勤した日</b>だけ入る区分で、有る月だけ列が出る (土曜は平日扱い — 2026-07-18 決定)。
                深夜(通常) だけは上記の<b>内数</b> (0.25 加算のための別枠計上) なので、実働の足し算には含めない。
                差分列はこの検算 (実働 − 表合計) で、<b>9 区分すべてを引いている</b>ので 0 以外 (赤) は日別データの不整合を指す。<br>
                土曜は平日扱い (法定外休日は使わない — 2026-07-18 決定)。法定休日は日曜のみ。<br>
                各金額の上の @ は計算単価 (円/h、金額 ÷ 対象時間の実額按分)。基本給の @ は基礎単価そのもの、深夜(通常) の @ は加算分 0.25 倍のみの単価。単価未設定の乗務員は計算されません。<br>
                基本給(法定内) の対象時間 = 実働 − 時間外 − 時間外深夜 − 週40超過 − 法定休日実働 (時間外・週40超過の基礎1.0は残業代の1.25側にのみ含まれる — 2026-07-18 案B 決定で週40超過の二重計上を解消)。
                深夜(通常) の対象時間は基本給の対象時間にも含まれており (基礎1.0は基本給側)、深夜列は 0.25 加算分だけを別枠計上する。
                合計は「実働全体 × 基礎単価 + 割増分 (時間外0.25 / 週40超過0.25 / 時間外深夜0.5 / 深夜0.25 / 法定休日の超過分)」と恒等で、基礎の2重計上はありません。<br>
                残業は「残業 (時間外+週40超過)」と「深夜残業 (時間外深夜)」の2列に分けて表示。月60時間の時間外割増判定はこの2つを合算した時間で行うが、
                60時間の枠は残業列から先に消費する扱いとして按分している (表示上の割り振りであり、順序を変えても2列合計の理論値は変わらない)。<br>
                残業代・深夜残業代の @ 単価は「基礎時給 + 割増加算分」を合成した実額按分平均 (換算理論値 ÷ 時間) — 基本給・深夜(通常) の @ と違い基礎部分も含む金額であることに注意 (深夜残業の @ は基礎1.0倍を含むため、60時間超過が絡まない月は基礎単価×1.5 に一致する)。
              </p>
            </div>
          </UCard>

          <!-- 最低賃金 (全社共通 1 本の履歴、Refs #253):
               乗務員の基本時間単価は会社が決めた支給額。最低賃金は国が定める
               法定の下限で、それとは別に設定が必要 (都道府県別マッピングまではせず
               全社共通の 1 履歴として扱う)。 -->
          <UCard v-if="activeTab === 'minwage'">
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">最低賃金</span>
                <span class="text-xs text-gray-500">基本時間単価 (会社が決めた支給額) とは別に、法定の下限として全社共通で設定します</span>
                <div class="flex-1" />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再読込" :loading="!minWageMasterLoaded" @click="loadMinWageMaster" />
                <UButton size="xs" icon="i-lucide-save" label="保存" :loading="savingMinWage" @click="saveMinWageMaster" />
              </div>
            </template>

            <!-- 都道府県別 (Refs #409)。全社共通 1 本では拠点をまたぐ実態を表せない
                 ため、厚労省から 47 都道府県を取り込んで拠点ごとに割り当てる。
                 最低賃金には公的な API が無く、提供は PDF / Excel / HTML のみ。 -->
            <div class="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div class="flex flex-wrap items-center gap-3 mb-2">
                <span class="font-semibold text-sm">都道府県別</span>
                <span v-if="minWagePrefectureCount" class="text-xs text-gray-500">
                  {{ minWagePrefectureCount }} 都道府県ぶん取り込み済み
                </span>
                <span v-else class="text-xs text-amber-600 dark:text-amber-400">未取り込み</span>
                <div class="flex-1" />
                <UButton
                  size="xs" variant="soft" icon="i-lucide-download"
                  label="厚労省から取り込む" :loading="importingMinWage"
                  @click="importMinWageFromMhlw"
                />
                <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" label="拠点を再読込" :loading="loadingBranchGroups" @click="loadBranchGroups" />
              </div>

              <p v-if="unmappedBranchGroups.length" class="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950 rounded p-2 mb-2">
                都道府県が未設定の拠点が {{ unmappedBranchGroups.length }} 件あります。設定するまでこの拠点の乗務員には最低賃金を適用しません
                (誤った県で判定するより、判定しないほうが安全なため)。<b>拠点名から県は推測できません</b> — 実際の就業地で選んでください。
              </p>

              <table v-if="branchGroups.length" class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th class="px-2 py-1.5 text-right">所属CD</th>
                    <th class="px-2 py-1.5">拠点 (営業所)</th>
                    <th class="px-2 py-1.5 text-right">人数</th>
                    <th class="px-2 py-1.5">都道府県</th>
                    <th class="px-2 py-1.5">含まれる所属 (社員マスタ)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="group in branchGroups" :key="group.prefix"
                    class="border-b border-gray-100 dark:border-gray-800"
                    :class="group.prefecture === null ? 'bg-amber-50 dark:bg-amber-950/40' : ''"
                  >
                    <td class="px-2 py-1.5 text-right text-xs text-gray-500">{{ group.branchCode ?? '-' }}</td>
                    <td class="px-2 py-1.5 font-medium">{{ group.prefix }}</td>
                    <td class="px-2 py-1.5 text-right">{{ group.employees }}</td>
                    <td class="px-2 py-1.5">
                      <USelectMenu
                        :model-value="group.prefecture ?? ''"
                        :items="prefectureOptions"
                        :search-input="{ placeholder: '都道府県で検索' }"
                        size="xs" class="w-36" placeholder="未設定"
                        @update:model-value="(v: unknown) => setBranchPrefecture(group.prefix, v ? String(v) : null)"
                      />
                    </td>
                    <td class="px-2 py-1.5 text-xs text-gray-500">{{ group.branches.join('、') }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="branchGroups.length" class="mt-1 text-xs text-gray-500">
                並びは給与大臣の所属コード (SHOZOKU.INCODE) 順です。拠点は営業所名 (NAME1) をそのまま使います。
                所属CD が空の拠点は所属の表示名から推定したもの — 「社員マスタ」タブで給与DBから取り込み直すとコードと営業所名が入ります。
              </p>
              <p v-else-if="branchGroupsLoaded" class="text-sm text-gray-500">
                社員マスタに所属が登録されていません。先に「社員マスタ」タブで取り込んでください。
              </p>

              <!-- 単価マスタへの一括設定 (単価マスタ = 最低賃金の運用、Refs #282 / #409)。
                   既に単価がある乗務員は既定で触らない — 会社が決めた支給単価を
                   最低賃金で潰さないため。必ずプレビューしてから確定させる。 -->
              <div v-if="branchGroups.length" class="mt-4 pt-3 border-t border-gray-200 dark:border-gray-700">
                <div class="flex flex-wrap items-end gap-3">
                  <span class="font-semibold text-sm self-center">単価マスタへ一括設定</span>
                  <UCheckbox v-model="applyOverwrite" label="既存の単価も上書きする" class="self-center" />
                  <UButton
                    size="sm" variant="soft" icon="i-lucide-list-checks"
                    label="プレビュー" :loading="applyingMinWage"
                    @click="runApplyMinWage(true)"
                  />
                </div>
                <p class="text-xs text-gray-500 mt-1">
                  拠点の最低賃金を乗務員の基本時間単価として入れます。<b>適用開始日は厚労省が定めた県ごとの発効日</b>をそのまま使います
                  ({{ fmtYm(month) }} 時点で有効な額)。<b>既に単価がある人は既定で据え置き</b>です。
                </p>

                <div v-if="applyPreview" class="mt-3 rounded-lg bg-gray-50 dark:bg-gray-900 p-3">
                  <!-- 県ごとに発効日が違うので、何がいつから入るのかを一覧で見せる -->
                  <table v-if="applyPreviewByPrefecture.length" class="text-sm mb-2">
                    <thead>
                      <tr class="text-left text-gray-500">
                        <th class="pr-4 py-1">都道府県</th>
                        <th class="pr-4 py-1 text-right">最低賃金</th>
                        <th class="pr-4 py-1">発効日 (= 適用開始日)</th>
                        <th class="py-1 text-right">人数</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="p in applyPreviewByPrefecture" :key="p.prefecture">
                        <td class="pr-4 py-0.5">{{ p.prefecture }}</td>
                        <td class="pr-4 py-0.5 text-right">{{ fmtYen(p.rate) }}</td>
                        <td class="pr-4 py-0.5">{{ p.effectiveFrom }}</td>
                        <td class="py-0.5 text-right">{{ p.count }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p class="text-sm">
                    新規 <b>{{ applyPreview.added }}</b> 名
                    <span v-if="applyPreview.overwritten"> / 上書き <b>{{ applyPreview.overwritten }}</b> 名</span>
                    <span v-if="applyPreview.kept"> / 既存単価あり (据え置き) {{ applyPreview.kept }} 名</span>
                    <span v-if="applyPreview.unresolved" class="text-amber-700 dark:text-amber-400">
                      / 引けなかった {{ applyPreview.unresolved }} 名
                    </span>
                  </p>
                  <p v-if="applyPreview.unresolved" class="text-xs text-amber-700 dark:text-amber-400 mt-1">
                    引けなかった分は拠点の都道府県が未設定か、{{ fmtYm(month) }} 時点の額が無い県です。
                  </p>
                  <div class="flex items-center gap-2 mt-2">
                    <UButton
                      size="sm" icon="i-lucide-check"
                      :label="`確定 (${applyPreview.added + applyPreview.overwritten} 名に反映)`"
                      :disabled="applyPreview.added + applyPreview.overwritten === 0"
                      :loading="applyingMinWage"
                      @click="runApplyMinWage(false)"
                    />
                    <UButton size="sm" variant="ghost" label="やめる" @click="applyPreview = null" />
                  </div>
                </div>
              </div>
            </div>
            <p v-if="minWageMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
              {{ minWageMessage }}
            </p>
            <div class="flex flex-wrap items-end gap-3 mb-3">
              <UFormField label="最低賃金 (円)">
                <UInput v-model="newMinWageRate" size="sm" type="number" class="w-28" />
              </UFormField>
              <UFormField label="適用開始日">
                <UInput v-model="newMinWageFrom" size="sm" type="date" />
              </UFormField>
              <UButton size="sm" variant="soft" icon="i-lucide-plus" label="追加" :disabled="!newMinWageRate || !newMinWageFrom" @click="addMinWageRate" />
            </div>
            <table v-if="minWageRows.length" class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                  <th class="px-2 py-1.5">適用開始日</th>
                  <th class="px-2 py-1.5 text-right">最低賃金 (円)</th>
                  <th class="px-2 py-1.5 w-12" />
                </tr>
              </thead>
              <tbody>
                <tr v-for="(rate, i) in minWageRows" :key="rate.effectiveFrom" class="border-b border-gray-100 dark:border-gray-800">
                  <td class="px-2 py-1.5">
                    {{ rate.effectiveFrom }}
                    <span v-if="i === 0" class="text-xs text-green-600 dark:text-green-400">(現行)</span>
                  </td>
                  <td class="px-2 py-1.5 text-right font-medium">{{ fmtYen(rate.rate) }}</td>
                  <td class="px-2 py-1.5 text-right">
                    <UButton size="xs" variant="ghost" icon="i-lucide-trash-2" @click="removeMinWageRate(rate.effectiveFrom)" />
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-else class="text-sm text-gray-500">未設定です。上の欄から追加してください。</p>
          </UCard>
        </template>

        <!-- ④ 給与比較 (Refs #253) -->
        <template v-else-if="activeTab === 'salary'">
          <!-- 社員マスタの操作結果 (取り込み・保存・自動設定)。「社員コード突合マスタ」
               カードは給与明細 CSV を取り込むまで描画されないため、メッセージはタブ
               直下に独立して置く — でないと CSV 未取り込みで「R2突合マスタから取り込み」
               を押した時に成功した実感が何も出ない (Refs #367、本番移行時に実際に
               「何も起きなかった」ように見えた) -->
          <p v-if="employeeMasterMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2">
            {{ employeeMasterMessage }}
          </p>

          <!-- 取得ボタンは全タブ共通の上部バーへ移した (2026-07-25)。ここは
               「何が取れるのか」の説明だけ残す — ボタンが 2 箇所にあると
               どちらを押したか分からなくなるため。 -->
          <UCard class="border-sky-300 dark:border-sky-800 mb-3">
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-sm font-medium">給与DBから読み込み</span>
              <span class="text-xs text-gray-500">
                <b>上部の「給与DB」バー</b>から取得します (期間指定も可)。この画面では {{ fmtYm(nextYm(month)) }} 支給分を突合します
              </span>
            </div>
            <p class="text-xs text-gray-500 mt-2">
              <b>給与アーカイブ (取り込み済み) がある会社は、押さなくても自動で表示されます</b> —
              月タブの<span class="text-amber-500">●</span>が目印です。ボタンは<b>アーカイブが無い会社を取りに行く</b>ときに使います。
            </p>
            <p class="text-xs text-gray-500 mt-2">
              取得するのは<b>支給項目だけ</b>です (控除は API 側で分離済み)。1 社あたり 10〜20 秒かかります —
              給与大臣 PC が古く DB を都度開くためで、異常ではありません。
              取得結果はタブを閉じるまで保持され、<code>/kyuyo-fetch</code> と共有されます (サーバーには保存しません)。
              下の貼り付けと<b>併用できます</b> — 両方あれば合算して突合します。
            </p>
          </UCard>

          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">給与明細の貼り付け</span>
                <span class="text-xs text-gray-500">貼り付けたデータはブラウザ内でのみ比較され、サーバーへ送信・保存されません</span>
                <div class="flex-1" />
                <UButton size="xs" variant="soft" icon="i-lucide-eraser" label="全てクリア" :disabled="!salaryPaste && !salaryImports.length" @click="clearSalaryPaste" />
                <label class="inline-flex">
                  <input
                    ref="salaryFileInput"
                    type="file"
                    accept=".csv,.tsv,.txt,.xls,.xlsx"
                    multiple
                    class="hidden"
                    @change="importSalaryFiles"
                  >
                  <UButton size="xs" icon="i-lucide-file-up" label="ファイル読み込み" @click="salaryFileInput?.click()" />
                </label>
                <UButton size="xs" variant="soft" icon="i-lucide-file-plus" label="貼り付けを取り込み" :disabled="!salaryPaste.trim()" @click="importSalaryPaste" />
                <UButton v-if="isDevMode" size="xs" variant="soft" color="warning" icon="i-lucide-flask-conical" label="デモ明細を読み込み (fixture)" @click="importDemoSalaryCsv" />
              </div>
            </template>
            <UTextarea
              v-model="salaryPaste"
              :rows="6"
              class="w-full font-mono"
              placeholder="給与システムの給与明細一覧 (ヘッダー行を含む) を Excel からコピーするか、CSV の中身をそのまま貼り付けてください。「取り込み」後に別の CSV (年度違い等) を続けて貼り付けて追加できます"
            />
            <p v-if="salaryParseError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-2 mt-2">
              {{ salaryParseError }}
            </p>
            <!-- 取り込み済み CSV の一覧 (複数可) -->
            <div v-for="(imp, idx) in salaryImports" :key="imp.id" class="border border-gray-200 dark:border-gray-800 rounded-lg p-2 mt-2">
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <span class="font-medium">{{ imp.name ?? `貼り付け ${idx + 1}` }}</span>
                <span class="text-xs text-gray-500">{{ salaryImportLabel(imp.parsed) }}</span>
                <!-- 会社は突合キーそのもの。自由入力だと表記揺れでキーが分裂するため
                     会社対応表 (comp-map) 由来の選択式にする (Refs #405) -->
                <USelect
                  :model-value="imp.company"
                  :items="salaryImportCompanyOptions"
                  value-key="value"
                  size="xs"
                  class="w-56"
                  placeholder="会社を選択"
                  title="社員コードは会社毎に別体系のため、取り込みごとに会社を選んでください (Refs #253/#405)"
                  @update:model-value="(v: unknown) => setImportCompany(imp.id, String(v))"
                />
                <div class="flex-1" />
                <UButton size="xs" variant="ghost" icon="i-lucide-trash-2" label="削除" @click="removeSalaryImport(imp.id)" />
              </div>
              <ul v-if="imp.parsed.warnings.length" class="text-xs text-amber-600 dark:text-amber-400 mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                <li v-for="(w, i) in imp.parsed.warnings" :key="i">⚠ {{ w }}</li>
              </ul>
            </div>
            <p v-if="salaryImports.length > 1 && salaryImports.some(i => !i.company)" class="text-xs text-amber-600 dark:text-amber-400 mt-2">
              ⚠ 複数の取り込みがありますが会社名が未設定のものがあります。社員コードは会社毎に別体系のため、
              未設定のままだと別会社の社員コードが偶然一致した時に取り違えが起こりえます (Refs #253)。
            </p>
            <template v-if="salaryParsed">
              <p class="text-sm text-gray-600 dark:text-gray-300 mt-2">
                合計 {{ salaryParsed.rows.length }} 行 / 支給項目 {{ salaryParsed.itemLabels.length }} 件を検出しました
              </p>
              <div class="flex flex-wrap items-center gap-1 mt-1">
                <span class="text-xs text-gray-500">検出した支給月 (クリックで対応する勤務月 = 前月に切替):</span>
                <UButton
                  v-for="ym in salaryParsed.months"
                  :key="ym"
                  size="xs"
                  :variant="month && ym === nextYm(month) ? 'solid' : 'soft'"
                  :label="fmtYm(ym)"
                  @click="selectSalaryMonth(ym)"
                />
              </div>
            </template>
          </UCard>

          <!-- カードは**常設**する (Refs #554)。以前は `v-if="salaryParsed"` だったため、
               給与アーカイブの自動読み込みが終わるまでカードごと存在せず、「給与比較が
               出ない」という報告になった。読み込み中なのか取り込まれていないのかを
               必ずこの中で言い切る。 -->
          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">比較結果 ({{ fmtYm(month) }})</span>
                <span class="text-xs text-gray-500">給与明細の区分集計 vs 給与明細の単価 × システム集計 (基本単価×稼働日数 / 残業単価×時間外)</span>
                <div class="flex-1" />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再計算" :loading="loadingReport" @click="loadWageReport" />
              </div>
            </template>

            <p v-for="w in report?.warnings ?? []" :key="w" class="text-xs text-amber-600 dark:text-amber-400 mb-1">⚠ {{ w }}</p>

            <div v-if="salaryStatus === 'loading-payroll'" class="flex items-center gap-2 text-sm text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
              {{ fmtYm(nextYm(month)) }} 支給分の給与明細を読み込んでいます…
            </div>

            <!-- 明細が無い = 待っても出ない。何が足りないかと、取り込みの導線を出す -->
            <div
              v-else-if="salaryStatus === 'no-payroll' || salaryStatus === 'no-pay-month'"
              class="text-sm bg-amber-50 dark:bg-amber-950 rounded-lg p-3 space-y-2"
            >
              <p class="text-amber-700 dark:text-amber-400">
                ⚠ <b>{{ fmtYm(nextYm(month)) }} 支給分</b>の給与明細がまだ取り込まれていません
                ({{ fmtYm(month) }} の勤務分は翌月払いのため {{ fmtYm(nextYm(month)) }} 支給分と突合します)。
                給与比較にはこの明細が要ります。
              </p>
              <div v-if="salaryStatus === 'no-pay-month' && salaryParsed?.months.length" class="flex flex-wrap items-center gap-1">
                <span class="text-xs text-gray-500">取り込み済みの支給月 (クリックで対応する勤務月に切替):</span>
                <UButton
                  v-for="ym in salaryParsed.months"
                  :key="ym"
                  size="xs"
                  variant="soft"
                  :label="fmtYm(ym)"
                  @click="selectSalaryMonth(ym)"
                />
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <UButton
                  size="xs"
                  icon="i-lucide-database"
                  label="給与DBから読み込み"
                  :loading="loadingPayrollDb"
                  :disabled="!sessionPayrollCompanies.length"
                  @click="loadPayrollFromDb"
                />
                <span class="text-xs text-gray-500">
                  上部の「給与DB」バーと同じ取得です ({{ sessionPayrollCompanies.length }} 社 / 1 社あたり 10〜20 秒)。
                  上の貼り付け・ファイル読み込みでも構いません
                </span>
              </div>
            </div>

            <div v-else-if="salaryStatus === 'loading-report'" class="flex items-center gap-2 text-sm text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
              システム計算 (wage-report) を読み込んでいます… ({{ fmtYm(month) }})
            </div>

            <p v-else-if="!salaryComparison" class="text-sm text-gray-500">
              この月の summary がアーカイブにありません (/restraint-fetch で取得するか、アーカイブタブで再計算してください)
            </p>
            <template v-else>
              <!-- 絞り込み・並べ替え (Refs #449)。単価マスタ・社員マスタと同じ作法 -->
              <div class="flex flex-wrap items-center gap-3 mb-3">
                <UFormField label="絞り込み">
                  <UInput v-model="salaryFilterText" size="sm" class="w-56" placeholder="乗務員CD / 氏名" />
                </UFormField>
                <UFormField label="並べ替え">
                  <USelect
                    v-model="salarySortKey" size="sm" class="w-64"
                    :items="[
                      { label: '乗務員CD 順', value: 'cd' },
                      { label: '見直し優先度順 (37条との差が大きい順)', value: 'shortfall' },
                      { label: '残業時間の長い順', value: 'overtime' },
                      { label: '氏名順', value: 'name' },
                    ]"
                  />
                </UFormField>
                <UCheckbox
                  v-model="salaryOnlyShortfall"
                  label="見直し候補だけ"
                  class="self-end pb-1"
                  title="残業計(給与) が 残業(基礎単価) に届いていない人。違反の検出ではなく、割増基礎 (基本給+算入手当) と固定残業の配分を見直す対象を絞るための絞り込みです"
                />
                <span class="text-xs text-gray-500 self-end pb-1">
                  {{ salaryComparisonRows.length }} / {{ salaryComparison.rows.length }} 名
                </span>
              </div>

              <ul v-if="salaryComparison.warnings.length" class="text-xs text-amber-600 dark:text-amber-400 mb-2 space-y-0.5">
                <li v-for="(w, i) in salaryComparison.warnings" :key="i">⚠ {{ w }}</li>
              </ul>
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                      <th class="px-2 py-2">乗務員CD</th>
                      <th class="px-2 py-2">氏名</th>
                      <th class="px-2 py-2 text-right">基本給計(給与)</th>
                      <th class="px-2 py-2 text-right" title="給与明細の基本単価 (日額) × システム計算の稼働日数">基本給(計算)</th>
                      <th class="px-2 py-2 text-right">差</th>
                      <th class="px-2 py-2 text-right">残業計(給与)</th>
                      <th class="px-2 py-2 text-right" title="給与明細の残業単価 (時給) × システム計算の時間外+時間外深夜。固定残業 (月給者) には当てはまらない">残業(計算)</th>
                      <th class="px-2 py-2 text-right" title="残業計(給与) − 残業(計算)。固定残業 (月給者) は定額なので差に意味が無く「固定」と出す — 判定は右の 37条 の差を見る">差</th>
                      <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700" title="割増基礎に算入する支給項目の合計 ÷ デジタコ法定内時間 (円/h)。単価マスタの時給との検算にもなる">基礎単価(実績)</th>
                      <th class="px-2 py-2 text-right" title="基礎単価(実績) を基礎額とした割増残業代の理論値 (労基法37条。月60時間までは1.25倍・超過分は1.5倍・深夜分は常時+0.25倍)">残業(基礎単価)</th>
                      <th class="px-2 py-2 text-right" title="残業計(給与) − 残業(基礎単価)。負なら実際の基礎単価に対する法定割増 (37条) を下回っている — 主判定">差</th>
                      <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700" title="最低賃金を基礎額とみなした割増残業代の理論値 (単価マスタは使わず、デジタコ拘束時間データ×最低賃金で算出)。絶対下限として併記">残業(最低賃金)</th>
                      <th class="px-2 py-2 text-right" title="残業計(給与) − 残業(最低賃金)。負なら実際に支払われた残業代が最低賃金換算の絶対下限すら下回っている">差</th>
                      <th class="px-2 py-2 text-right">支給計(給与)</th>
                      <th class="px-2 py-2 text-right">合計(計算)</th>
                      <th class="px-2 py-2 text-right">差</th>
                      <!-- 勤怠日数 (Refs #433)。上段 = 打刻から数えた日数、下段 = 給与明細の
                           【勤怠】欄。**差は判定しない** — 日数の付け方には運用差があり、
                           並べて見せるのが目的 -->
                      <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700" title="上: 打刻から数えた出勤日数 / 下: 給与明細【勤怠】の出勤日数。差は異常判定しません">出勤<br><span class="font-normal text-xs">(計算 / 給与)</span></th>
                      <th class="px-2 py-2 text-right" title="上: 打刻から数えた公休日数 (公休/泊休/積置泊休/指休) / 下: 給与明細【勤怠】の公休日数">公休<br><span class="font-normal text-xs">(計算 / 給与)</span></th>
                      <th class="px-2 py-2 text-right" title="上: 打刻から数えた有休日数 (有休=1.0、前休/後休=0.5) / 下: 給与明細【勤怠】の有休日数">有休<br><span class="font-normal text-xs">(計算 / 給与)</span></th>
                      <th class="px-2 py-2 text-right" title="上: 打刻から数えた欠勤日数 / 下: 給与明細【勤怠】の欠勤日数">欠勤<br><span class="font-normal text-xs">(計算 / 給与)</span></th>
                      <th class="px-2 py-2 text-right" title="打刻が翌日にまたがっていた日数 (終業の押し忘れ)。この日の時間は賃金計算から外れているので、上の金額の差もその分ずれる">打刻<br>エラー</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in salaryComparisonRows"
                      :key="row.driverCd"
                      class="border-b border-gray-100 dark:border-gray-800"
                    >
                      <td class="px-2 py-1.5">
                        {{ row.driverCd }}
                        <span v-if="row.mappedDriverCd" class="text-xs text-gray-500" title="社員コード突合マスタで引き当て">→ {{ row.mappedDriverCd }}</span>
                      </td>
                      <td class="px-2 py-1.5">
                        {{ row.driverName }}
                        <!-- 複数会社の給与行を 1 人として合算した行 (Refs #403) -->
                        <UBadge
                          v-if="row.mergedFrom"
                          size="sm"
                          color="warning"
                          variant="subtle"
                          :title="`${row.mergedFrom.length} 社の給与行を合算: ${row.mergedFrom.map(m => `${m.company || '会社未設定'} ${m.driverCd}`).join(' / ')}`"
                        >
                          {{ row.mergedFrom.length }} 社合算
                        </UBadge>
                      </td>
                      <td class="px-2 py-1.5 text-right" :title="fmtItemsTitle(row.csvBaseItems)">{{ fmtYen(row.csvBase) }}</td>
                      <td class="px-2 py-1.5 text-right" :title="row.sysBase !== null ? `基本単価 × 稼働 ${row.sysWorkDays} 日` : undefined">
                        <template v-if="row.sysBase !== null">{{ fmtYen(row.sysBase) }}</template>
                        <span v-else class="text-xs text-gray-500">単価なし</span>
                      </td>
                      <td class="px-2 py-1.5 text-right" :class="(row.diffBase ?? 0) !== 0 ? 'text-red-600 font-medium' : 'text-gray-400'">
                        {{ fmtDiff(row.diffBase) }}
                      </td>
                      <td class="px-2 py-1.5 text-right" :title="fmtItemsTitle(row.csvOvertimeItems)">{{ fmtYen(row.csvOvertime) }}</td>
                      <td class="px-2 py-1.5 text-right">
                        <template v-if="row.sysOvertime !== null">
                          <div>{{ fmtYen(row.sysOvertime) }}</div>
                          <div class="text-xs text-gray-500">{{ fmtMinutes(row.sysOvertimeMinutes) }}</div>
                        </template>
                        <span v-else class="text-xs text-gray-500">単価なし</span>
                      </td>
                      <!-- 固定残業 (月給者) は定額 × 時間ではないので差を出さない (Refs #449)。
                           正の差を「多く払っている = 問題なし」と読まれるのを止める -->
                      <td
                        v-if="row.overtimeFixed"
                        class="px-2 py-1.5 text-right text-xs text-gray-500"
                        title="月給者 = 固定残業とみなしています。定額と「単価×時間」の差は判定に使えないので出しません。労基法37条の判定は右の「残業(基礎単価)」との差を見てください"
                      >固定</td>
                      <td v-else class="px-2 py-1.5 text-right" :class="(row.diffOvertime ?? 0) !== 0 ? 'text-red-600 font-medium' : 'text-gray-400'">
                        {{ fmtDiff(row.diffOvertime) }}
                      </td>
                      <td class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700" :title="`割増基礎算入計 ${fmtYen(row.csvPremiumBase)}円 (${fmtItemsTitle(row.csvPremiumBaseItems)}) ÷ 法定内 ${fmtMinutes(row.statutoryMinutes)}`">
                        <template v-if="row.baseRateActual !== null">
                          <div>{{ fmtRatePerHour(row.baseRateActual) }}</div>
                          <div class="text-xs text-gray-500">÷ {{ fmtMinutes(row.statutoryMinutes) }}</div>
                        </template>
                        <span v-else class="text-xs text-gray-500">算出不可</span>
                      </td>
                      <td class="px-2 py-1.5 text-right">
                        <template v-if="row.baseRateOvertimePay !== null">
                          <div>{{ fmtYen(row.baseRateOvertimePay) }}</div>
                          <div class="text-xs text-gray-500">{{ fmtMinutes(row.minWageOvertimeMinutes) }}</div>
                        </template>
                        <span v-else class="text-xs text-gray-500">算出不可</span>
                      </td>
                      <td class="px-2 py-1.5 text-right" :class="(row.diffCsvVsBaseRateOvertime ?? 0) < 0 ? 'text-red-600 font-bold' : 'text-gray-400'">
                        {{ fmtDiff(row.diffCsvVsBaseRateOvertime) }}
                      </td>
                      <td class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700">
                        <template v-if="row.minWageOvertimePay !== null">
                          <div>{{ fmtYen(row.minWageOvertimePay) }}</div>
                          <div class="text-xs text-gray-500">{{ fmtMinutes(row.minWageOvertimeMinutes) }}</div>
                        </template>
                        <span v-else class="text-xs text-gray-500">最低賃金未設定</span>
                      </td>
                      <td class="px-2 py-1.5 text-right" :class="(row.diffCsvVsMinWageOvertime ?? 0) < 0 ? 'text-red-600 font-bold' : 'text-gray-400'">
                        {{ fmtDiff(row.diffCsvVsMinWageOvertime) }}
                      </td>
                      <td class="px-2 py-1.5 text-right" :title="row.csvReportedTotal != null && row.csvReportedTotal !== row.csvTotal ? `支給合計額列は ${fmtYen(row.csvReportedTotal)} 円 (項目計と不一致)` : undefined">
                        {{ fmtYen(row.csvTotal) }}
                        <span v-if="row.csvReportedTotal != null && row.csvReportedTotal !== row.csvTotal" class="text-amber-600">*</span>
                      </td>
                      <td class="px-2 py-1.5 text-right">{{ fmtYen(row.sysTotal) }}</td>
                      <td class="px-2 py-1.5 text-right" :class="(row.diffTotal ?? 0) !== 0 ? 'text-red-600 font-medium' : 'text-gray-400'">
                        {{ fmtDiff(row.diffTotal) }}
                      </td>
                      <!-- 勤怠日数 (Refs #433)。上段 = 計算 (打刻)、下段 = 給与明細。
                           色は付けない — 差が出るのは前提で、異常ではない -->
                      <td
                        v-for="col in ATTENDANCE_COLUMNS"
                        :key="col.key"
                        class="px-2 py-1.5 text-right"
                        :class="col.key === 'work' ? 'border-l border-gray-200 dark:border-gray-700' : ''"
                      >
                        <div>{{ fmtDays(row.attendanceDays.sys[col.key]) }}</div>
                        <div class="text-xs text-gray-500">{{ fmtDays(row.attendanceDays.csv[col.key]) }}</div>
                      </td>
                      <td
                        class="px-2 py-1.5 text-right"
                        :class="row.attendanceDays.sys.punchError > 0 ? 'text-red-600 font-bold dark:text-red-400' : 'text-gray-400'"
                      >
                        {{ fmtDays(row.attendanceDays.sys.punchError) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="text-xs text-gray-500 mt-2">
                差 = 給与明細 − 計算。計算 = 給与明細【 補助 】の 基本単価 (日額) × システム稼働日数、
                残業単価 (時給) × システム時間外。給与明細に単価が無い行は「単価なし」(独自の按分計算はしません)。
                基本給計/残業計にカーソルを合わせると支給項目の内訳を表示します。
                * は 支給合計額 列と支給項目の合算が一致しない行。<br>
                基礎単価(実績) = 割増基礎に算入する支給項目 (支給項目区分タブで「割増基礎○」の区分) の合計 ÷ デジタコ法定内時間。
                残業(基礎単価) = 基礎単価(実績) を基礎額とした割増残業代の理論値 (時間外+時間外深夜+週40超過、月60時間までは1.25倍・超過分は1.5倍・深夜分は常時+0.25倍)。
                <b>「残業計(給与) − 残業(基礎単価)」が労基法37条の主判定です</b> — 負なら実際の基礎単価に対する法定割増を下回っています。
                <b>これは違反の検出ではなく、賃金の内訳を見直すための材料です</b> — 割増基礎 (基本給 + 算入手当) が高いほど理論値も上がるため、
                最低賃金を満たしていても差は負に出ます。支給総額を変えずに基本給と固定残業の配分を見直すと差は縮みます
                (「見直し候補だけ」の絞り込みと「見直し優先度順」はそのための導線です)。
                残業(最低賃金) は同じ計算を最低賃金を基礎額として行った絶対下限の併記で、単価マスタ設定の妥当性チェックである「最低賃金チェック」タブとは異なります。<br>
                注: 週40超過分は summary v2 の日別データ (days) からの自前計算のため、旧形式 (v1、days なし) のアーカイブ月は週40超過が計算できません — 対象月をアーカイブタブで再計算 (resummarize) してから使ってください。
              </p>
              <p v-if="salaryComparison.reportOnly.length" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
                システム計算のみ (給与明細なし): {{ salaryComparison.reportOnly.map(d => `${d.driverCd} ${d.driverName}`).join(', ') }}
              </p>
            </template>
          </UCard>

          <!-- 同名別人の疑い (氏名不一致で同じ乗務員CDに解決、Refs #253/#403) -->
          <UCard v-if="salaryComparison && salaryComparison.conflicts.length" class="border-red-300 dark:border-red-800">
            <template #header>
              <span class="font-semibold text-red-600 dark:text-red-400">同名別人の疑い ({{ salaryComparison.conflicts.length }} 件)</span>
            </template>
            <p class="text-sm text-gray-600 dark:text-gray-300 mb-3">
              同じ乗務員CDに<b>氏名の異なる</b>給与コードが解決されました。社員コードは会社毎に別体系なので偶然の一致か登録ミスです。
              機械的に決められないので比較対象から外しています — 下から会社ごとに正しい乗務員CDを選び直してください。<br>
              <span class="text-xs">氏名が一致する複数会社の行は同一人物として自動で合算するため、ここには出ません (一覧の「N 社合算」バッジで確認できます)。</span>
            </p>
            <div v-for="c in salaryComparison.conflicts" :key="c.driverCd" class="border border-red-200 dark:border-red-900 rounded-lg p-2 mb-2">
              <p class="text-xs text-gray-500 mb-1">乗務員CD {{ c.driverCd }} へ解決:</p>
              <div v-for="e in c.entries" :key="`${e.company}|${e.driverCd}|${e.driverName}`" class="flex items-center gap-2 text-sm mb-1">
                <span class="flex-1 truncate">{{ e.company || '会社未設定' }}: {{ e.driverCd }} {{ e.driverName }}</span>
                <USelectMenu
                  model-value=""
                  value-key="value"
                  :items="salaryCdOptions"
                  :search-input="{ placeholder: '乗務員CD・氏名で検索' }"
                  size="xs"
                  class="w-48 shrink-0"
                  placeholder="正しい乗務員CDを選択"
                  @update:model-value="(v: unknown) => setCdMapEntry(e.driverCd, e.driverName, String(v), e.company)"
                />
              </div>
            </div>
          </UCard>

          <!-- 未登録の給与明細行 (社員マスタに会社+給与コードが無い、Refs #367) -->
          <UCard v-if="unregisteredEmployees.length" class="border-blue-300 dark:border-blue-800">
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-sm">給与明細に社員マスタ未登録の社員が {{ unregisteredEmployees.length }} 名います (コード・氏名・会社のみ登録、金額は送信しません)。</span>
              <div class="flex-1" />
              <UButton size="xs" icon="i-lucide-user-plus" :label="`未登録 ${unregisteredEmployees.length} 名をマスタへ登録`" :loading="savingEmployeeMaster" @click="registerUnregistered" />
            </div>
          </UCard>

          <!-- 社員コード突合マスタ (会社|給与コード|氏名 → 乗務員CD、Refs #367) -->
          <UCard v-if="salaryComparison && (salaryComparison.csvOnly.length || salaryCdMapRows.length)">
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">社員コード突合マスタ</span>
                <span class="text-xs text-gray-500">給与システムの社員コードは会社毎に別体系のため、会社+氏名つきで乗務員CDへ引き当てます</span>
                <div class="flex-1" />
                <UButton
                  size="xs"
                  variant="soft"
                  icon="i-lucide-wand-sparkles"
                  label="氏名一致で自動設定"
                  :disabled="!salaryComparison.csvOnly.length"
                  @click="autoSuggestCdMap"
                />
                <UButton size="xs" icon="i-lucide-save" label="マスタを保存" :loading="savingEmployeeMaster" @click="saveEmployeeMaster('突合マスタを保存しました')" />
              </div>
            </template>

            <!-- 操作結果メッセージはタブ直下に 1 箇所だけ置く (このカード内には出さない) -->

            <template v-if="salaryComparison.csvOnly.length">
              <p class="text-sm font-medium mb-1">未突合の給与明細 ({{ salaryComparison.csvOnly.length }} 名) — 乗務員CDを選択:</p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 mb-3">
                <div v-for="d in salaryComparison.csvOnly" :key="`${d.company}|${d.driverCd}|${d.driverName}`" class="flex items-center gap-2 text-sm">
                  <span class="flex-1 truncate">{{ d.company ? `${d.company}: ` : '' }}{{ d.driverCd }} {{ d.driverName }}</span>
                  <USelectMenu
                    model-value=""
                    value-key="value"
                    :items="salaryCdOptions"
                    :search-input="{ placeholder: '乗務員CD・氏名で検索' }"
                    size="xs"
                    class="w-48 shrink-0"
                    placeholder="乗務員CDを選択"
                    @update:model-value="(v: unknown) => setCdMapEntry(d.driverCd, d.driverName, String(v), d.company)"
                  />
                </div>
              </div>
            </template>

            <template v-if="salaryCdMapRows.length">
              <p class="text-sm font-medium mb-1">登録済み ({{ salaryCdMapRows.length }} 件):</p>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
                <div v-for="row in salaryCdMapRows" :key="row.key" class="flex items-center gap-2 text-sm">
                  <span class="flex-1 truncate">{{ row.company ? `${row.company}: ` : '' }}{{ row.payrollCd }} {{ row.name }} → {{ row.driverCd }}</span>
                  <UButton size="xs" variant="ghost" icon="i-lucide-x" @click="removeCdMapEntry(row.key)" />
                </div>
              </div>
            </template>
            <p class="text-xs text-gray-500 mt-2">
              設定は即座に比較へ反映されます (「マスタを保存」でサーバーに確定)。給与明細の内容自体は保存されません。
            </p>
          </UCard>
        </template>

        <!-- ⑤ 支給項目区分 (Refs #253) -->
        <template v-else-if="activeTab === 'items'">
          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">支給項目の区分 (割増基礎 × 最低賃金の 2 軸、5 区分)</span>
                <span class="text-xs text-gray-500">この区分設定だけがサーバーに保存されます</span>
                <div class="flex-1" />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再読込" :loading="!salaryConfigLoaded" @click="loadSalaryItemConfig" />
                <UButton size="xs" icon="i-lucide-save" label="区分を保存" :disabled="!salaryItemRows.length" :loading="savingSalaryConfig" @click="saveSalaryItemConfig" />
              </div>
            </template>
            <p v-if="salaryConfigMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
              {{ salaryConfigMessage }}
            </p>
            <p v-if="!salaryItemRows.length" class="text-sm text-gray-500">
              まだ項目がありません。給与比較タブで CSV/ファイルを取り込むと支給項目が自動検出されます
              (すでに保存済みの区分があればここに一覧表示されます)。
            </p>
            <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
              <div v-for="row in salaryItemRows" :key="row.label" class="flex items-center gap-2 text-sm">
                <span class="flex-1 truncate" :class="row.inCsv ? '' : 'text-gray-400'" :title="row.label">
                  {{ row.label }}
                  <span v-if="!row.inCsv" class="text-xs">(貼り付けに無い項目)</span>
                </span>
                <span v-if="!row.saved" class="text-xs text-amber-600 dark:text-amber-400 shrink-0" title="保存済みの区分が無いため項目名からの推定値を表示しています">未保存</span>
                <USelect
                  :model-value="row.category"
                  :items="SALARY_CATEGORY_OPTIONS"
                  size="xs"
                  class="w-72 shrink-0"
                  @update:model-value="(v: unknown) => setSalaryItemCategory(row.label, v as SalaryItemCategory)"
                />
              </div>
            </div>
            <p class="text-xs text-gray-500 mt-3">
              区分は法令上の 2 軸の組合せです:
              <b>割増賃金の基礎</b> (労基法37条5項・施行規則21条 — 除外できるのは家族・通勤・別居・子女教育・住宅手当、臨時の賃金、1ヶ月超ごとの賃金の限定列挙 7 種のみ。職務手当・無事故手当等は算入必須) と
              <b>最低賃金の対象賃金</b> (最低賃金法4条3項 — 臨時・賞与・割増賃金・精皆勤/通勤/家族手当を除外)。
              「割増基礎○」の項目の合計が給与比較タブの 基礎単価(実績) の分子、「最低賃金○」の項目の合計が最低賃金の法定チェックの分子になります (Refs #278)。
            </p>
          </UCard>
        </template>

        <!-- ③ 単価マスタ -->
        <template v-else-if="activeTab === 'master'">
          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">単価マスタ</span>
                <span v-if="masterUpdatedAt" class="text-xs text-gray-500">最終更新: {{ fmtArchiveTs(masterUpdatedAt) }}</span>
                <div class="flex-1" />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再読込" :loading="loadingMaster" @click="loadMaster" />
                <UButton size="xs" variant="soft" icon="i-lucide-file-down" label="CSV出力" @click="exportMasterCsv" />
                <label class="inline-flex">
                  <input ref="csvFileInput" type="file" accept=".csv,text/csv" class="hidden" @change="importMasterCsv">
                  <UButton size="xs" variant="soft" icon="i-lucide-file-up" label="CSV取込" @click="csvFileInput?.click()" />
                </label>
                <UButton size="xs" icon="i-lucide-save" label="保存" :loading="savingMaster" @click="saveMaster" />
              </div>
            </template>

            <p v-if="masterMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
              {{ masterMessage }}
            </p>

            <!-- 絞り込み・並べ替え (Refs #409)。会社と所属は社員マスタから引く。 -->
            <div class="flex flex-wrap items-center gap-3 mb-3">
              <UFormField label="会社">
                <USelect v-model="masterCompanyFilter" :items="masterCompanyOptions" size="sm" class="w-56" />
              </UFormField>
              <UFormField label="並べ替え">
                <USelect
                  v-model="masterSortKey" size="sm" class="w-56"
                  :items="[
                    { label: '乗務員CD 順', value: 'cd' },
                    { label: '所属 (営業所) 順 → 乗務員CD', value: 'branch' },
                    { label: '単価の高い順 → 乗務員CD', value: 'rate' },
                  ]"
                />
              </UFormField>
              <span class="text-xs text-gray-500 self-end pb-1">{{ masterRows.length }} 名</span>
            </div>

            <!-- 単価マスタにまだ居ない人を足す (Refs #568)。一覧は R2 の単価マスタから
                 作るので、履歴が 1 件も無い人は行が無く登録する手段が無かった -->
            <div class="flex flex-wrap items-end gap-3 border border-gray-200 dark:border-gray-800 rounded-lg p-3 mb-3">
              <span class="text-sm font-medium">乗務員を追加:</span>
              <UFormField label="乗務員 (社員マスタから)">
                <!-- 選択値は文字列 (乗務員CD) で受ける。`value-key` があっても項目
                     オブジェクトが飛んでくる版があるため、どちらでも CD を取り出す -->
                <USelectMenu
                  :model-value="newDriver.cd"
                  :items="masterAddCandidates"
                  :search-input="{ placeholder: '乗務員CD / 氏名で検索' }"
                  value-key="value"
                  size="sm" class="w-64" placeholder="選択"
                  @update:model-value="(v: unknown) => newDriver = { ...newDriver, cd: selectedDriverCd(v) }"
                />
              </UFormField>
              <UFormField label="基本時間単価 (円)">
                <UInput v-model="newDriver.rate" size="sm" type="number" class="w-28" />
              </UFormField>
              <UFormField label="適用開始日">
                <UInput v-model="newDriver.from" size="sm" type="date" />
              </UFormField>
              <UButton
                size="sm" variant="soft" label="追加"
                :disabled="!newDriver.cd || !newDriver.rate || !newDriver.from"
                @click="addDriverToMaster"
              />
              <span v-if="masterAddCandidates.length" class="text-xs text-gray-500">
                候補 {{ masterAddCandidates.length }} 名 (社員マスタ・読み込み済みの集計に居て単価マスタに無い人)。追加後に「保存」で確定
              </span>
              <span v-else class="text-xs text-gray-500">
                社員マスタの乗務員はすべて単価マスタに登録済みです
              </span>
            </div>

            <div class="flex flex-wrap items-end gap-3 border border-gray-200 dark:border-gray-800 rounded-lg p-3 mb-4">
              <span class="text-sm font-medium">一括変更 (選択 {{ selectedCds.size }} 名):</span>
              <UFormField label="基本時間単価 (円)">
                <UInput v-model="bulkRate" size="sm" type="number" class="w-28" />
              </UFormField>
              <UFormField label="適用開始日">
                <UInput v-model="bulkFrom" size="sm" type="date" />
              </UFormField>
              <UButton size="sm" variant="soft" label="選択行に適用" :disabled="!bulkRate || !bulkFrom || !selectedCds.size" @click="applyBulk" />
              <span class="text-xs text-gray-500">適用後に「保存」で確定 (R2 に 1 版として記録されます)</span>
            </div>

            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th class="px-2 py-2 w-8" />
                    <th class="px-2 py-2">乗務員CD</th>
                    <th class="px-2 py-2">乗務員名</th>
                    <th class="px-2 py-2">会社</th>
                    <th class="px-2 py-2">所属 (社員マスタ)</th>
                    <th class="px-2 py-2 text-right">単価 ({{ fmtYm(month) }}時点)</th>
                    <th class="px-2 py-2">適用開始日</th>
                    <th class="px-2 py-2">根拠</th>
                    <th class="px-2 py-2">履歴</th>
                    <th class="px-2 py-2">新規単価 / 適用開始日</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in masterRows" :key="row.cd" class="border-b border-gray-100 dark:border-gray-800" :class="row.driver.retiredAt ? 'text-gray-400' : ''">
                    <td class="px-2 py-1.5">
                      <UCheckbox :model-value="selectedCds.has(row.cd)" @update:model-value="toggleSelect(row.cd)" />
                    </td>
                    <td class="px-2 py-1.5">{{ row.cd }}</td>
                    <td class="px-2 py-1.5">
                      {{ row.driver.name ?? '' }}
                      <span v-if="row.driver.retiredAt" class="text-xs">({{ row.driver.retiredAt }} 退職)</span>
                    </td>
                    <td class="px-2 py-1.5 text-xs">{{ row.companyLabel || '-' }}</td>
                    <td class="px-2 py-1.5 text-xs">{{ row.branch || '-' }}</td>
                    <td class="px-2 py-1.5 text-right font-medium">{{ row.current ? fmtYen(row.current.hourlyRate) : '未設定' }}</td>
                    <td class="px-2 py-1.5">{{ row.current?.effectiveFrom ?? '-' }}</td>
                    <td class="px-2 py-1.5 text-xs">
                      <!-- 根拠県が無い = 一括設定より前に入った単価。手入力とは
                           限らない (この機能の初期版が根拠を残していなかった) ので
                           断定はしない -->
                      <span v-if="row.current?.prefecture" class="text-gray-500">{{ row.current.prefecture }} 最低賃金</span>
                      <span v-else class="text-gray-400">-</span>
                    </td>
                    <td class="px-2 py-1.5">
                      <UButton
                        size="xs"
                        variant="soft"
                        icon="i-lucide-history"
                        :label="`履歴 (${row.history.length})`"
                        :disabled="!row.history.length"
                        @click="rateHistoryCd = row.cd"
                      />
                    </td>
                    <td class="px-2 py-1.5">
                      <div class="flex items-center gap-1.5">
                        <UInput
                          :model-value="newRates[row.cd]?.rate ?? ''"
                          size="xs"
                          type="number"
                          placeholder="円"
                          class="w-24"
                          @update:model-value="(v: string | number) => newRates = { ...newRates, [row.cd]: { rate: String(v), from: newRates[row.cd]?.from ?? '' } }"
                        />
                        <UInput
                          :model-value="newRates[row.cd]?.from ?? ''"
                          size="xs"
                          type="date"
                          @update:model-value="(v: string | number) => newRates = { ...newRates, [row.cd]: { rate: newRates[row.cd]?.rate ?? '', from: String(v) } }"
                        />
                        <UButton size="xs" variant="ghost" icon="i-lucide-plus" @click="addRate(row.cd)" />
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="!masterRows.length && !loadingMaster" class="text-sm text-gray-500">
              マスタが空です。対象月の summary がアーカイブにあれば「再読込」で乗務員一覧を自動補完します
            </p>
          </UCard>

          <p class="text-xs text-gray-500">
            最低賃金 (法定下限、全社共通) の設定は「最低賃金チェック」タブに移動しました — 単価マスタは会社が決めた支給単価のみを管理します (Refs #268)。
          </p>

          <!-- 単価履歴モーダル (Refs #253) -->
          <UModal v-model:open="rateHistoryOpen" :ui="{ content: 'max-w-lg' }">
            <template #content>
              <div class="p-6 space-y-3 max-h-[80vh] overflow-y-auto">
                <h3 class="text-lg font-bold">
                  単価履歴 — {{ rateHistoryCd }} {{ rateHistoryRow?.driver.name ?? '' }}
                </h3>
                <p class="text-xs text-gray-500">新しい順。削除はローカル反映のみ — マスタの「保存」で確定します</p>
                <table class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                      <th class="px-2 py-1.5">適用開始日</th>
                      <th class="px-2 py-1.5 text-right">基本時間単価 (円)</th>
                      <th class="px-2 py-1.5 w-12" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(rate, i) in rateHistoryRow?.history ?? []"
                      :key="rate.effectiveFrom"
                      class="border-b border-gray-100 dark:border-gray-800"
                    >
                      <td class="px-2 py-1.5">
                        {{ rate.effectiveFrom }}
                        <span v-if="i === 0" class="text-xs text-green-600 dark:text-green-400">(現行)</span>
                      </td>
                      <td class="px-2 py-1.5 text-right font-medium">{{ fmtYen(rate.hourlyRate) }}</td>
                      <td class="px-2 py-1.5 text-right">
                        <UButton size="xs" variant="ghost" icon="i-lucide-trash-2" @click="removeRateEntry(rateHistoryCd!, rate.effectiveFrom)" />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="!rateHistoryRow?.history.length" class="text-sm text-gray-500">履歴がありません</p>
                <div class="flex justify-end">
                  <UButton size="sm" variant="soft" label="閉じる" @click="rateHistoryOpen = false" />
                </div>
              </div>
            </template>
          </UModal>
        </template>

        <!-- ⑥ 社員マスタ (D1、Refs #367) -->
        <template v-else-if="activeTab === 'employees'">
          <!-- 給与DBから社員を取り込む (CSV 不要、金額は来ない、Refs #367) -->
          <UCard v-if="importPayrollOptions.length" class="border-emerald-300 dark:border-emerald-800">
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-sm font-medium">給与DBから取り込み</span>
              <span class="text-xs text-gray-500">
                {{ dtakoCompLabel(importTargetComp) }} ← 給与大臣の会社
              </span>
              <USelect
                v-model="importPayrollCompany"
                :items="importPayrollOptions"
                value-key="value"
                size="xs"
                class="w-32"
              />
              <span class="text-xs text-gray-500">対象月: {{ fmtYm(month) }} の年度DB</span>
              <div class="flex-1" />
              <UButton
                size="xs"
                icon="i-lucide-database"
                label="社員を取り込み"
                :loading="importingPayroll"
                :disabled="!importPayrollCompany"
                @click="importFromPayrollDb"
              />
            </div>
            <p class="text-xs text-gray-500 mt-2">
              社員番号・氏名・所属・給与体系だけを取得します (金額は API の応答にも含まれません)。
              旧ラベル ("有"/"株") の行があれば乗務員CD突合を引き継いで統合します。取り込み後「保存」で確定してください。
            </p>
          </UCard>

          <!-- 一番星社員ﾏｽﾀから社員CD を埋める (Refs #403) -->
          <UCard class="border-sky-300 dark:border-sky-800">
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-sm font-medium">一番星から突合</span>
              <span class="text-xs text-gray-500">社員CD が空の行を氏名で照合します</span>
              <div class="flex-1" />
              <UButton
                size="xs"
                icon="i-lucide-link"
                label="一番星から突合"
                :loading="matchingIchiban"
                :disabled="!importTargetComp"
                @click="matchFromIchiban"
              />
            </div>
            <p class="text-xs text-gray-500 mt-2">
              社員CD は一番星の <code>社員ﾏｽﾀ.社員C</code> と同じ番号体系なので、非乗務員 (役員・事務員・作業員) も突合できます。
              取得するのは社員C・氏名だけです (金額は API の応答に含まれません)。
              <b>氏名が一意に決まる行だけ</b>自動で埋めます — 同名が複数いる行と一番星に無い行は下に一覧で出すので手入力してください。
              既に社員CD が入っている行は上書きしません。取り込み後「保存」で確定してください。
            </p>
            <div v-if="ichibanUnresolved" class="mt-3 text-xs space-y-2">
              <div v-if="ichibanUnresolved.ambiguous.length">
                <p class="font-medium text-amber-700 dark:text-amber-400">
                  同名が複数いて決められません ({{ ichibanUnresolved.ambiguous.length }} 名) — 候補から選んで手入力してください
                </p>
                <ul class="list-disc list-inside text-gray-600 dark:text-gray-300">
                  <li v-for="a in ichibanUnresolved.ambiguous" :key="`${a.company}|${a.payrollCd}`">
                    {{ a.company }} {{ a.payrollCd }} {{ a.name }} → 候補 {{ a.candidates.join(' / ') }}
                  </li>
                </ul>
              </div>
              <div v-if="ichibanUnresolved.notFound.length">
                <p class="font-medium text-gray-600 dark:text-gray-300">
                  一番星に見つかりません ({{ ichibanUnresolved.notFound.length }} 名) — 異体字・カタカナ表記の違い、または一番星未登録
                </p>
                <p class="text-gray-500">
                  {{ ichibanUnresolved.notFound.map(n => `${n.company} ${n.payrollCd} ${n.name}`).join('、') }}
                </p>
              </div>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">社員マスタ ({{ employeeMasterRows.length }} 名)</span>
                <span class="text-xs text-gray-500">所属・給与体系は「{{ fmtYm(month) }} の末日時点」で解決した値を表示しています</span>
                <div class="flex-1" />
                <USelect
                  v-model="employeeMasterScope"
                  :items="employeeMasterScopeOptions"
                  value-key="value"
                  size="xs"
                  class="w-56"
                  @update:model-value="() => loadEmployeeMasterScope()"
                />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再読込" @click="loadEmployeeMasterScope(true)" />
                <UButton size="xs" icon="i-lucide-save" label="保存" :loading="savingEmployeeMaster" @click="saveEmployeeMaster('社員マスタを保存しました')" />
              </div>
            </template>

            <p v-if="employeeMasterMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
              {{ employeeMasterMessage }}
            </p>
            <p v-if="pendingAttrDeletes.length || pendingEmployeeDeletes.length" class="text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950 rounded-lg p-2 mb-3">
              未保存の削除があります (履歴 {{ pendingAttrDeletes.length }} 件 / 社員 {{ pendingEmployeeDeletes.length }} 名) — 「保存」で確定します
            </p>

            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th v-if="employeeMasterScope === 'all'" class="px-2 py-2">会社ID</th>
                    <th class="px-2 py-2">会社</th>
                    <th class="px-2 py-2">給与コード</th>
                    <th class="px-2 py-2">氏名</th>
                    <th class="px-2 py-2" title="一番星 社員ﾏｽﾀ.社員C と同一体系。乗務員以外にも番号がある">社員CD</th>
                    <th class="px-2 py-2">所属 ({{ fmtYm(month) }})</th>
                    <th class="px-2 py-2">給与体系</th>
                    <th class="px-2 py-2">適用開始日</th>
                    <th class="px-2 py-2">履歴</th>
                    <th class="px-2 py-2">所属 / 給与体系 / 適用開始日 を追加</th>
                    <th class="px-2 py-2 w-10" />
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in employeeMasterRows" :key="row.key" class="border-b border-gray-100 dark:border-gray-800">
                    <td v-if="employeeMasterScope === 'all'" class="px-2 py-1.5 whitespace-nowrap">{{ row.compLabel }}</td>
                    <td class="px-2 py-1.5">{{ row.companyLabel }}</td>
                    <td class="px-2 py-1.5">{{ row.entry.payrollCd }}</td>
                    <td class="px-2 py-1.5">
                      <UInput
                        :model-value="row.entry.name"
                        size="xs"
                        class="w-32"
                        @change="(e: Event) => setEmployeeName(row.key, (e.target as HTMLInputElement).value)"
                      />
                    </td>
                    <td class="px-2 py-1.5">
                      <UInput
                        :model-value="row.entry.driverCd ?? ''"
                        size="xs"
                        class="w-24"
                        placeholder="未突合"
                        @change="(e: Event) => setEmployeeDriverCd(row.key, (e.target as HTMLInputElement).value)"
                      />
                    </td>
                    <!-- 所属CD (INCODE) を並記する — 取り込みでコードと営業所名が
                         入ったかを画面で確かめられるようにする (Refs #409) -->
                    <td class="px-2 py-1.5">
                      {{ row.current?.branch ?? '-' }}
                      <span v-if="row.current?.branchCode" class="ml-1 text-xs text-gray-500">({{ row.current.branchCode }})</span>
                    </td>
                    <td class="px-2 py-1.5">{{ row.current?.payScheme ?? '-' }}</td>
                    <td class="px-2 py-1.5">{{ row.current?.effectiveFrom ?? '-' }}</td>
                    <td class="px-2 py-1.5">
                      <UButton
                        size="xs"
                        variant="soft"
                        icon="i-lucide-history"
                        :label="`履歴 (${row.history.length})`"
                        :disabled="!row.history.length"
                        @click="attrHistoryKey = row.key"
                      />
                    </td>
                    <td class="px-2 py-1.5">
                      <div class="flex items-center gap-1.5">
                        <UInput
                          :model-value="newAttrInputs[row.key]?.branch ?? ''"
                          size="xs"
                          placeholder="所属"
                          class="w-28"
                          @update:model-value="(v: string | number) => newAttrInputs = { ...newAttrInputs, [row.key]: { from: newAttrInputs[row.key]?.from ?? '', branch: String(v), payScheme: newAttrInputs[row.key]?.payScheme ?? '' } }"
                        />
                        <UInput
                          :model-value="newAttrInputs[row.key]?.payScheme ?? ''"
                          size="xs"
                          placeholder="給与体系"
                          class="w-28"
                          @update:model-value="(v: string | number) => newAttrInputs = { ...newAttrInputs, [row.key]: { from: newAttrInputs[row.key]?.from ?? '', branch: newAttrInputs[row.key]?.branch ?? '', payScheme: String(v) } }"
                        />
                        <UInput
                          :model-value="newAttrInputs[row.key]?.from ?? ''"
                          size="xs"
                          type="date"
                          @update:model-value="(v: string | number) => newAttrInputs = { ...newAttrInputs, [row.key]: { from: String(v), branch: newAttrInputs[row.key]?.branch ?? '', payScheme: newAttrInputs[row.key]?.payScheme ?? '' } }"
                        />
                        <UButton size="xs" variant="ghost" icon="i-lucide-plus" :disabled="!newAttrInputs[row.key]?.from" @click="addEmployeeAttr(row.key)" />
                      </div>
                    </td>
                    <td class="px-2 py-1.5 text-right">
                      <UButton size="xs" variant="ghost" icon="i-lucide-trash-2" @click="removeEmployeeEntry(row.key)" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="!employeeMasterRows.length" class="text-sm text-gray-500">
              社員マスタが空です。上の「給与DBから取り込み」で登録するか、給与比較タブで給与明細 CSV を取り込み「未登録 N 名をマスタへ登録」してください
            </p>
            <p class="text-xs text-gray-500 mt-2">
              保存されるのは識別情報 (会社・給与コード・氏名・社員CD) と所属/給与体系だけです — 支給金額・明細は送信しません。
              所属・給与体系は月次集計 CSV の「所属(マスタ)」「給与体系」列になります (対象月の末日時点で効いている行)。
              社員マスタは**会社ID (dtako) ごと**に保存され、「全社」表示では権限のある会社をまとめて編集できます — 保存は会社ごとに分けて送られます。
            </p>
          </UCard>

          <!-- 所属/給与体系の履歴モーダル (Refs #367) -->
          <UModal v-model:open="attrHistoryOpen" :ui="{ content: 'max-w-lg' }">
            <template #content>
              <div class="p-6 space-y-3 max-h-[80vh] overflow-y-auto">
                <h3 class="text-lg font-bold">
                  所属・給与体系の履歴 — {{ attrHistoryRow?.companyLabel }} {{ attrHistoryRow?.entry.payrollCd }} {{ attrHistoryRow?.entry.name }}
                </h3>
                <p class="text-xs text-gray-500">新しい順。削除はローカル反映のみ — 「保存」で確定します</p>
                <table class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                      <th class="px-2 py-1.5">適用開始日</th>
                      <th class="px-2 py-1.5">所属</th>
                      <th class="px-2 py-1.5">給与体系</th>
                      <th class="px-2 py-1.5 w-12" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="attr in attrHistoryRow?.history ?? []"
                      :key="attr.effectiveFrom"
                      class="border-b border-gray-100 dark:border-gray-800"
                    >
                      <td class="px-2 py-1.5">
                        {{ attr.effectiveFrom }}
                        <span v-if="attrHistoryRow?.current?.effectiveFrom === attr.effectiveFrom" class="text-xs text-green-600 dark:text-green-400">({{ fmtYm(month) }} 適用)</span>
                      </td>
                      <td class="px-2 py-1.5">{{ attr.branch ?? '-' }}</td>
                      <td class="px-2 py-1.5">{{ attr.payScheme ?? '-' }}</td>
                      <td class="px-2 py-1.5 text-right">
                        <UButton size="xs" variant="ghost" icon="i-lucide-trash-2" @click="removeEmployeeAttr(attrHistoryKey!, attr.effectiveFrom)" />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div class="flex justify-end">
                  <UButton size="sm" variant="soft" label="閉じる" @click="attrHistoryOpen = false" />
                </div>
              </div>
            </template>
          </UModal>
        </template>

        <!-- ⑤ 勤務設定 (所定労働時間 + 休日出勤の承認、Refs #424 PR-C) -->
        <template v-else-if="activeTab === 'schedule'">
          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">所定労働時間</span>
                <span class="text-xs text-gray-500">タイムカード由来の勤務で「実働がこれを超えた分 = 時間外」の基準</span>
                <div class="flex-1" />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再読込" :loading="savingWorkSchedule" @click="loadWorkSchedule" />
              </div>
            </template>

            <p v-if="workScheduleMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
              {{ workScheduleMessage }}
            </p>

            <div class="flex flex-wrap items-end gap-2 mb-4">
              <UFormField label="適用開始日" size="xs">
                <UInput v-model="scheduleForm.effectiveFrom" type="date" size="xs" class="w-40" />
              </UFormField>
              <UFormField label="所定 (分)" size="xs" :help="`= ${fmtWorkHours(Number(scheduleForm.dailyWorkMinutes) || 0)}`">
                <UInput v-model="scheduleForm.dailyWorkMinutes" type="number" min="1" max="1440" size="xs" class="w-28" />
              </UFormField>
              <UFormField label="拠点コード" size="xs" help="空欄 = 全拠点">
                <UInput v-model="scheduleForm.branchCode" type="number" min="1" size="xs" class="w-28" placeholder="全拠点" />
              </UFormField>
              <UFormField label="職種" size="xs" help="空欄 = 全職種">
                <UInput v-model="scheduleForm.jobName" size="xs" class="w-36" placeholder="全職種" />
              </UFormField>
              <UButton size="xs" icon="i-lucide-plus" label="追加・更新" :loading="savingWorkSchedule" @click="addWorkSchedule" />
            </div>

            <p v-if="!workSchedules.length" class="text-sm text-gray-500">
              まだ所定労働時間が設定されていません。まずは拠点・職種を空欄にした<b>全社の既定値</b>を 1 行入れてください
              (例: 適用開始日 = 運用開始月の 1 日、所定 = 480 分)。
            </p>
            <table v-else class="w-full text-sm">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="px-2 py-2 text-left">適用開始日</th>
                  <th class="px-2 py-2 text-left">拠点</th>
                  <th class="px-2 py-2 text-left">職種</th>
                  <th class="px-2 py-2 text-right">所定労働時間</th>
                  <th class="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in workSchedules" :key="`${row.effectiveFrom}|${row.branchCode ?? ''}|${row.jobName ?? ''}`" class="border-t border-gray-200 dark:border-gray-700">
                  <td class="px-2 py-1">{{ row.effectiveFrom }}</td>
                  <td class="px-2 py-1">{{ row.branchCode ?? '全拠点' }}</td>
                  <td class="px-2 py-1">{{ row.jobName ?? '全職種' }}</td>
                  <td class="px-2 py-1 text-right">{{ row.dailyWorkMinutes }} 分<span class="text-xs text-gray-500 ml-1">({{ fmtWorkHours(row.dailyWorkMinutes) }})</span></td>
                  <td class="px-2 py-1 text-right">
                    <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" :loading="savingWorkSchedule" @click="deleteWorkSchedule(row)" />
                  </td>
                </tr>
              </tbody>
            </table>

            <p class="text-xs text-gray-500 mt-3">
              対象月に効く行は「<b>適用開始日が月末以前</b>」のうち<b>最も具体的なスコープ</b>のもの
              (拠点+職種 &gt; 拠点 &gt; 職種 &gt; 全社既定)。具体度が同じなら適用開始日が新しい行が勝ちます。
              具体度を先に見るのは、全社既定を後から更新した時に拠点別の設定が消えないようにするためです。<br>
              <b>休憩は設定しません</b> — 打刻の中抜けと 12:00〜13:00 の和集合を休憩として実働から差し引きます
              (事務員は昼休憩で打刻を切っているため、固定値より実態に合います)。<br>
              デジタコ (theearth) 由来の乗務員には影響しません。時間外は拘束時間 CSV の値をそのまま使うためです。
            </p>
          </UCard>

          <UCard class="mt-4">
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">休日出勤の承認 ({{ fmtYm(month) }})</span>
                <span class="text-xs text-gray-500">ここに登録した日だけが割増賃金の対象になります</span>
                <div class="flex-1" />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再読込" :loading="savingHolidayWork" @click="loadHolidayWork" />
              </div>
            </template>

            <p v-if="holidayWorkMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
              {{ holidayWorkMessage }}
            </p>

            <div class="flex flex-wrap items-end gap-2 mb-4">
              <UFormField label="乗務員CD" size="xs">
                <UInput v-model="holidayForm.driverCd" size="xs" class="w-28" />
              </UFormField>
              <UFormField label="出勤日" size="xs" help="日跨ぎ勤務は始業日">
                <UInput v-model="holidayForm.workDate" type="date" size="xs" class="w-40" />
              </UFormField>
              <UFormField label="理由・備考" size="xs">
                <UInput v-model="holidayForm.reason" size="xs" class="w-64" placeholder="任意" />
              </UFormField>
              <UButton size="xs" icon="i-lucide-plus" label="承認を追加" :loading="savingHolidayWork" @click="addHolidayWork" />
            </div>

            <p v-if="!holidayWorks.length" class="text-sm text-gray-500">
              {{ fmtYm(month) }} に承認済みの休日出勤はありません
              (この月の休日の打刻はすべて<b>自主出勤</b>として賃金計算から外れ、時間だけが記録されます)。
            </p>
            <table v-else class="w-full text-sm">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="px-2 py-2 text-left">乗務員CD</th>
                  <th class="px-2 py-2 text-left">出勤日</th>
                  <th class="px-2 py-2 text-left">理由・備考</th>
                  <th class="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in holidayWorks" :key="`${entry.driverCd}|${entry.workDate}`" class="border-t border-gray-200 dark:border-gray-700">
                  <td class="px-2 py-1">{{ entry.driverCd }}</td>
                  <td class="px-2 py-1">{{ entry.workDate }}</td>
                  <td class="px-2 py-1">{{ entry.reason ?? '' }}</td>
                  <td class="px-2 py-1 text-right">
                    <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" :loading="savingHolidayWork" @click="deleteHolidayWork(entry)" />
                  </td>
                </tr>
              </tbody>
            </table>

            <p class="text-xs text-gray-500 mt-3">
              休日 (法定休日 = 日曜 / 法定外休日 = 指定休・祝日) に打刻がある日のうち、<b>この表に載っている日だけ</b>が
              休日出勤として割増賃金の対象になります。載っていない日は<b>自主出勤</b>として賃金計算から外れますが、
              <b>時間は記録され画面にも出ます</b> — 後からこの表に日付を足せば休日出勤へ昇格します。<br>
              休日出勤は運用上ほとんど発生しない前提のため、日付を明示登録する方式にしています。
            </p>
          </UCard>

          <UCard class="mt-4">
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">夜勤者</span>
                <span class="text-xs text-gray-500">日跨ぎを打刻エラーにせず、休日の打刻も自主出勤にしません (職種は問いません)</span>
                <div class="flex-1" />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再読込" :loading="savingNightShift" @click="loadNightShift" />
              </div>
            </template>

            <p v-if="nightShiftMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
              {{ nightShiftMessage }}
            </p>

            <div class="flex flex-wrap items-end gap-2 mb-4">
              <UFormField label="乗務員CD" size="xs" :help="driverNameOf(nightShiftForm.driverCd.trim()) || ' '">
                <UInput v-model="nightShiftForm.driverCd" size="xs" class="w-28" />
              </UFormField>
              <UFormField label="適用開始日" size="xs" help="この日から">
                <UInput v-model="nightShiftForm.effectiveFrom" type="date" size="xs" class="w-40" />
              </UFormField>
              <UFormField label="区分" size="xs" help="解除も履歴として残します">
                <USelect
                  v-model="nightShiftForm.isNight"
                  size="xs"
                  class="w-32"
                  :items="[{ label: '夜勤者', value: true }, { label: '解除', value: false }]"
                />
              </UFormField>
              <UButton size="xs" icon="i-lucide-plus" label="追加・更新" :loading="savingNightShift" @click="addNightShift" />
            </div>

            <p v-if="!nightShifts.length" class="text-sm text-gray-500">
              夜勤者が登録されていません。この状態で勤怠を取り込むと、<b>事務職の日跨ぎ打刻はすべて打刻エラー</b>になります。
              夜勤で日をまたぐ人は先にここへ登録してください。
            </p>
            <table v-else class="w-full text-sm">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="px-2 py-2 text-left">乗務員CD</th>
                  <th class="px-2 py-2 text-left">氏名</th>
                  <th class="px-2 py-2 text-left">適用開始日</th>
                  <th class="px-2 py-2 text-left">区分</th>
                  <th class="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in nightShifts" :key="`${entry.driverCd}|${entry.effectiveFrom}`" class="border-t border-gray-200 dark:border-gray-700">
                  <td class="px-2 py-1">{{ entry.driverCd }}</td>
                  <td class="px-2 py-1">{{ driverNameOf(entry.driverCd) }}</td>
                  <td class="px-2 py-1">{{ entry.effectiveFrom }}</td>
                  <td class="px-2 py-1">
                    <span :class="entry.isNight ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-500'">
                      {{ entry.isNight ? '夜勤者' : '解除' }}
                    </span>
                  </td>
                  <td class="px-2 py-1 text-right">
                    <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" :loading="savingNightShift" @click="deleteNightShift(entry)" />
                  </td>
                </tr>
              </tbody>
            </table>

            <p class="text-xs text-gray-500 mt-3">
              事務職の打刻が翌日にまたがっていたら通常は<b>終業の押し忘れ</b>です (実データでは 35 時間の拘束になり、
              翌日の打刻ごと巻き添えにして消えます)。ただし<b>夜勤者は正常に日をまたぐ</b>ため、ここに載っている人は
              判定から外します。<br>
              <b>休日 (日曜・祝日・指定休) の打刻も自主出勤にしません</b> — 夜勤ローテーションでは日曜も通常の勤務日なので、
              未承認でも<b>平日として通常計上</b>します (割増なし)。休日出勤の承認簿に日付を入れた日は、夜勤者でも
              従来どおり割増の対象です。<b>職種は問いません</b> — 同じ日曜夜勤を事務職と作業員で違う扱いにしないためです。<br>
              <b>行は消さずに「解除」を足してください</b> — 対象月に効くのは<b>適用開始日が月末以前の最新行</b>なので、
              解除を履歴として残せば過去月を再取り込みしても当時の姿で計算されます。行そのものを削除すると、
              当時は正常だった打刻が過去にさかのぼってエラーになります。<br>
              デジタコ (theearth) 由来の乗務員には影響しません — 打刻ではなく拘束時間 CSV を使うためです。
            </p>
          </UCard>
        </template>

        <!-- タイムカード (Refs #424 PR-E) -->
        <template v-else-if="activeTab === 'timecard'">
          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-2 print:hidden">
                <span class="font-semibold">タイムカード ({{ fmtYm(month) }})</span>
                <span class="text-xs text-gray-500">
                  打刻から作った勤務表。社内の既存 PDF と同じ 8 列
                </span>
                <div class="flex-1" />
                <UInput
                  v-model="timecardFilter"
                  size="xs"
                  class="w-48"
                  placeholder="乗務員CD (空欄=全員)"
                />
                <!-- 画面は見えているシートだけ描いているので、印刷前に全部描いてから
                     ダイアログを開く (Refs #472) -->
                <UButton size="xs" variant="soft" icon="i-lucide-printer" label="印刷" @click="printTimecards" />
              </div>
              <!-- 勤怠の取り込み (Refs #433)。ルートは #424 PR-A からあったが導線が無く、
                   打刻エラー判定・公休の追加を入れても誰も再取り込みできなかった -->
              <div class="mt-2 flex flex-wrap items-center gap-2 print:hidden">
                <span class="text-xs text-gray-500">勤怠取り込み</span>
                <USelect v-model="kintaiRangeFrom" size="xs" class="w-32" :items="payrollMonthOptions" />
                <span class="text-xs text-gray-500">〜</span>
                <USelect v-model="kintaiRangeTo" size="xs" class="w-32" :items="payrollMonthOptions" />
                <UButton
                  size="xs"
                  icon="i-lucide-download"
                  label="タイムカードを取り込み"
                  :loading="fetchingKintai"
                  :disabled="fetchingKintai"
                  @click="fetchKintai"
                />
                <span class="text-xs text-gray-500">
                  {{ kintaiTargetMonths.length > 1 ? `${fmtYm(kintaiTargetMonths[0]!)}〜${fmtYm(kintaiTargetMonths[kintaiTargetMonths.length - 1]!)} (${kintaiTargetMonths.length} ヶ月)` : fmtYm(kintaiTargetMonths[0]!) }}
                  の打刻を社内タイムカードから取り直します (同じ内容なら版は増えません)
                </span>
                <span v-if="kintaiMessage" class="text-xs text-green-700 dark:text-green-400">{{ kintaiMessage }}</span>
              </div>
              <!-- 期間サマリー印刷 (Refs #443)。上の「印刷」は 1 人 1 枚の日別表なので、
                   期間の日数を突き合わせたい時は枚数が多すぎる -->
              <div class="mt-2 flex flex-wrap items-center gap-2 print:hidden">
                <span class="text-xs text-gray-500">期間サマリー</span>
                <USelect v-model="summaryFrom" size="xs" class="w-32" :items="payrollMonthOptions" :aria-label="'期間サマリーの勤務月 (から)'" />
                <span class="text-xs text-gray-500">〜</span>
                <USelect v-model="summaryTo" size="xs" class="w-32" :items="payrollMonthOptions" :aria-label="'期間サマリーの勤務月 (まで)'" />
                <UButton
                  size="xs"
                  variant="soft"
                  icon="i-lucide-table"
                  :label="buildingSummary ? summaryProgress || '集計中...' : `サマリーを開く (${summaryTargetMonths.length} ヶ月)`"
                  :loading="buildingSummary"
                  :disabled="buildingSummary"
                  @click="openTimecardSummary"
                />
                <span class="text-xs text-gray-500">
                  月毎に 1 枚・1 人 1 行の一覧を開きます (日別の打刻は出ません)。中身を確かめてから印刷できます。
                  残業(給与) は上の給与DBバーで対象期間を読み込むと入ります
                </span>
              </div>
            </template>

            <p v-for="w in report?.warnings ?? []" :key="w" class="text-xs text-amber-600 dark:text-amber-400 mb-1">⚠ {{ w }}</p>

            <UAlert
              v-if="timecardNeedsRefetch"
              color="warning"
              variant="soft"
              class="mb-3 print:hidden"
              icon="i-lucide-alert-triangle"
              title="打刻が保存されていません"
              description="この月のサマリは打刻区間を持つ前に取り込まれたものです。勤怠を再取り込みすると表に時刻が入ります。"
            />

            <!-- 月切替で見出しだけ先に新しい月へ変わり、下の表が前の月のまま残る
                 (Refs #456 追加報告 2026-07-27)。月次集計と同じ「更新中」帯 + 薄化で
                 「表示中の表は前の月のもの」と分かるようにし、誤操作も止める -->
            <div
              v-if="staleReport"
              class="sticky top-0 z-10 mb-1 flex items-center justify-center gap-2 rounded bg-amber-50/95 dark:bg-amber-950/95 py-2"
            >
              <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-primary" />
              <span class="text-sm font-medium">更新中 — 表示中のタイムカードは切り替え前の月のものです</span>
            </div>

            <!-- 取得中に「勤務がありません」を出すと、取り込みが要るように見える
                 (2026-07-27 本番で指摘)。ドライバーは取り込み不要で、ただ取得に
                 数秒かかっているだけ -->
            <div v-if="!hasTimecardSheets && loadingKosoku" class="flex items-center gap-2 text-sm text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
              勤務を読み込んでいます…
            </div>
            <p v-else-if="!hasTimecardSheets" class="text-sm text-gray-500">
              この月に勤務がありません。
            </p>

            <!-- **給与大臣の会社コード**ごとに区切り、中は 事務 → 作業 → 整備 → 乗務
                 → その他 → 乗務員CD 順 (ユーザー決定 2026-07-28)。dtako 会社ID 単位
                 (Refs #472 PR-C) だと 0100/0200/0300 の 3 社が 1 区画に混ざる。
                 ドライバーの供給元も会社で絞られていないので、見出しが無いと
                 他社の人が混ざったまま並ぶ -->
            <div v-if="hasTimecardSheets">
              <div
                v-for="section in timecardSections"
                :key="section.company ?? 'unknown'"
                class="mb-6 last:mb-0"
              >
                <h3 class="mb-2 border-b border-gray-300 pb-1 text-sm font-semibold dark:border-gray-600">
                  {{ section.company ? payrollCompanyLabelOf(compMap, section.company) : '会社不明 (社員マスタに乗務員CDの登録なし)' }}
                  <span class="ml-1 font-normal text-gray-500">{{ section.sheets.length }} 名</span>
                </h3>
                <div
                  class="grid gap-4"
                  :class="[
                    staleReport ? STALE_CLASS : '',
                    // 1 人だけの時は横に伸ばして内訳列を読ませる
                    singleTimecardSheet ? 'grid-cols-1' : 'print:grid-cols-3 md:grid-cols-2 xl:grid-cols-3',
                  ]"
                >
                  <RenderWhenVisible
                    v-for="sheet in section.sheets"
                    :key="sheet.driverCd"
                    :force="renderAllTimecards"
                    min-height="34rem"
                  >
                    <TimecardTable
                      :driver-cd="sheet.driverCd"
                      :driver-name="sheet.driverName"
                      :month="report?.month ?? month"
                      :rows="sheet.rows"
                      :counts="sheet.counts"
                      :overtime-compare="sheet.overtimeCompare"
                      :attendance-compare="sheet.attendanceCompare"
                      :restraint="sheet.restraint"
                      :detailed="singleTimecardSheet"
                    />
                  </RenderWhenVisible>
                </div>
              </div>
            </div>
          </UCard>
        </template>

        <!-- タイムカード照合 (Refs #606-8)。月 × 全乗務員で「誰のどこが変か」を一覧し、
             行を選ぶとその乗務員の日別 (旧 timecard タブの 1 vs 1 突合と同じ表) へ
             ドリルダウンする。1 vs 1 突合は元々ここに埋まっていたが、月全体を見る
             手段が無かったため専用タブへ切り出した (旧ブロックは timecard タブから
             削除済み)。 -->
        <template v-else-if="activeTab === 'compare'">
          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-2 print:hidden">
                <span class="font-semibold">タイムカード照合 ({{ fmtYm(month) }})</span>
                <span class="text-xs text-gray-500">
                  社内タイムカード表 (nginx) の拘束と、こちらの拘束を暦日ごとに突き合わせます。
                  判定は relay 側で済ませてあり、ここは表示だけです。突き合わせるのは<b>拘束だけ</b> —
                  残業は定義が別物なので比較しません。
                </span>
                <div class="flex-1" />
                <UButton
                  size="xs"
                  icon="i-lucide-git-compare"
                  :label="compareAllLoaded ? '再照合' : '月 × 全乗務員を照合'"
                  :loading="compareAllLoading"
                  :disabled="compareAllLoading"
                  @click="loadTimecardCompareAll"
                />
              </div>
            </template>

            <UAlert
              v-if="compareAllError"
              color="error"
              variant="soft"
              class="mb-3"
              icon="i-lucide-alert-triangle"
              title="突合できませんでした"
              :description="compareAllError"
            />
            <UAlert
              v-else-if="compareAllLoaded && !compareOursAvailable"
              color="warning"
              variant="soft"
              class="mb-3"
              icon="i-lucide-alert-triangle"
              title="こちら側の拘束が取れていません"
              description="上流 (kosoku-daily) が落ちているため、nginx 側だけの表になっています。差分は当てになりません。"
            />

            <p v-if="!compareAllLoaded && !compareAllLoading && !compareAllError" class="text-sm text-gray-500">
              「月 × 全乗務員を照合」を押すと、この月の全乗務員を社内タイムカード表 (nginx) と
              突き合わせます (差分・異常のどちらも無い乗務員は一覧から落とします)。社内 LAN へ
              往復するので、月タブを切り替えるだけでは自動更新しません。
            </p>
            <div v-else-if="compareAllLoading" class="flex items-center gap-2 text-sm text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
              照合しています…
            </div>
            <template v-else-if="compareAllLoaded">
              <p v-if="compareSummaryRows.length === 0" class="text-sm text-gray-500">
                差分・異常のある乗務員はいません。
              </p>
              <div v-else class="overflow-x-auto">
                <table class="min-w-full text-sm border-collapse">
                  <thead class="bg-gray-100 dark:bg-gray-800">
                    <tr>
                      <th class="px-2 py-1 text-left">乗務員CD</th>
                      <th class="px-2 py-1 text-left">氏名</th>
                      <th class="px-2 py-1 text-right" title="拘束の差が許容誤差を超えた暦日の数">差あり日数</th>
                      <th class="px-2 py-1 text-right" title="nginx 側の値そのものの異常 (負の拘束など)">異常件数</th>
                      <th class="px-2 py-1 text-right" title="差の原因を検知できなかった日数と、その残差の合計。検知の抜けを測る数字">未説明 (日数/分)</th>
                      <th class="px-2 py-1 text-right" title="差あり日の diffMinutes の最小〜最大">差の幅</th>
                      <th class="px-2 py-1 text-left" title="差を説明できた原因ごとの日数 (relay の生の分類名)">推定原因の内訳</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="srow in compareSummaryRows" :key="srow.driverCd">
                      <tr
                        class="cursor-pointer border-t border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/60"
                        :class="compareSelectedDriverCd === srow.driverCd ? 'bg-primary-50 dark:bg-primary-950/40' : ''"
                        @click="selectCompareDriver(srow)"
                      >
                        <td class="px-2 py-1 tabular-nums">{{ srow.driverCd }}</td>
                        <td class="px-2 py-1">{{ srow.name || '(nginx に居ません)' }}</td>
                        <td class="px-2 py-1 text-right tabular-nums">{{ srow.mismatchCount }}</td>
                        <td class="px-2 py-1 text-right tabular-nums">{{ srow.anomalyCount }}</td>
                        <td class="px-2 py-1 text-right tabular-nums">{{ fmtTimecardCompareUnknown(srow) }}</td>
                        <td class="px-2 py-1 text-right tabular-nums">{{ fmtTimecardCompareDiffRange(srow.diffRange) }}</td>
                        <td class="px-2 py-1 text-xs">{{ fmtTimecardCompareCauseDays(srow.causeDays) }}</td>
                      </tr>
                      <tr v-if="compareSelectedDriverCd === srow.driverCd">
                        <td colspan="7" class="border-t-0 bg-gray-50 px-2 py-3 dark:bg-gray-900/40">
                          <!-- 日別ドリルダウン。選択した 1 人ぶんだけを DOM に出す
                               (全員ぶんの日別は取得済みだが持っているだけで描かない、Refs #606-8) -->
                          <div v-if="compareResult">
                            <div class="text-xs">
                              <b>{{ compareResult.name || compareResult.driverCd }}</b> —
                              {{ timecardCompareHeadline(compareResult) }}
                              <span class="text-gray-500">
                                (許容誤差 {{ compareResult.toleranceMinutes }} 分 /
                                月計 nginx {{ fmtTimecardCompareMinutes(compareResult.totals.nginxMinutes) }} vs
                                こちら {{ fmtTimecardCompareMinutes(compareResult.totals.oursMinutes) }} =
                                {{ fmtTimecardCompareDiff(compareResult.totals.diffMinutes) }})
                              </span>
                            </div>
                            <div class="mt-2 overflow-x-auto">
                              <table class="min-w-full text-sm border-collapse">
                                <thead class="bg-gray-100 dark:bg-gray-800">
                                  <tr>
                                    <th class="px-2 py-1 text-right w-10">日</th>
                                    <th class="px-2 py-1 text-center w-8">曜</th>
                                    <th class="px-2 py-1 text-right border-l border-gray-200 dark:border-gray-700">
                                      nginx 拘束
                                    </th>
                                    <th class="px-2 py-1 text-right">拘束 (こちら)</th>
                                    <th class="px-2 py-1 text-right border-l border-gray-200 dark:border-gray-700">差</th>
                                    <th
                                      v-if="showCompareFerry"
                                      class="px-2 py-1 text-right"
                                      title="nginx がその日にフェリー控除で引いた分。控除前の値がこちらと一致するので、二重に引いています"
                                    >
                                      フェリー控除
                                    </th>
                                    <th class="px-2 py-1 text-left">状態</th>
                                    <th class="px-2 py-1 text-left">nginx 側の異常</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <tr
                                    v-for="drow in compareRows"
                                    :key="drow.date"
                                    class="border-t border-gray-200 dark:border-gray-700"
                                    :class="[timecardCompareRowClass(drow), drow.isSunday ? 'font-medium' : '']"
                                  >
                                    <td class="px-2 py-1 text-right tabular-nums">{{ drow.day }}</td>
                                    <td class="px-2 py-1 text-center" :class="drow.isSunday ? 'text-red-600 dark:text-red-400' : ''">
                                      {{ drow.weekdayLabel }}
                                    </td>
                                    <td class="px-2 py-1 text-right tabular-nums border-l border-gray-200 dark:border-gray-700">
                                      {{ fmtTimecardCompareMinutes(drow.nginxMinutes) }}
                                    </td>
                                    <td class="px-2 py-1 text-right tabular-nums">{{ fmtTimecardCompareMinutes(drow.oursMinutes) }}</td>
                                    <td class="px-2 py-1 text-right tabular-nums border-l border-gray-200 dark:border-gray-700">
                                      {{ fmtTimecardCompareDiff(drow.diffMinutes) }}
                                    </td>
                                    <td v-if="showCompareFerry" class="px-2 py-1 text-right tabular-nums text-red-700 dark:text-red-400">
                                      {{ drow.ferryMinusMinutes === null ? '' : `-${drow.ferryMinusMinutes}` }}
                                    </td>
                                    <td class="px-2 py-1 text-xs">{{ timecardCompareStatusLabel(drow.status) }}</td>
                                    <td class="px-2 py-1 text-xs text-red-700 dark:text-red-400">
                                      {{ drow.anomalies.map(a => a.message).join(' / ') }}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                              <p
                                v-for="a in compareResult.anomalies.filter(x => x.date === null)"
                                :key="a.field ?? ''"
                                class="mt-1 text-xs text-red-700 dark:text-red-400"
                              >
                                {{ a.message }}
                              </p>
                              <p class="mt-1 text-xs text-gray-500">
                                突き合わせるのは<b>拘束だけ</b>です。残業は nginx 側が旅費由来 + 手入力の加算補正で、
                                こちらの所定超とは定義が別物なので比較していません。
                                「nginx 側の異常」は差分と独立に出ます (両者が一致していても nginx が負なら報告します)。
                                <template v-if="showCompareFerry">
                                  <br>
                                  <b>フェリー控除は nginx 側の欠陥</b>です — <b>控除前の値がこちらと一致</b>し、控除ぶんだけが差になります
                                  (実測: 1726 / 2026-03 の 3/14 は控除 433 分で控除前 321 分、3/21 は控除 78 分で控除前 755 分。同月の他の日は ±1 分)。
                                  控除額は nginx からもらうしかありません — フェリーはデジタコのイベント名が一定せず (休息だったり休憩だったり)、
                                  <code>dtako_ferry_rows</code> を見ないと見分けられないためです。
                                </template>
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
            </template>
          </UCard>
        </template>

        <template v-else-if="activeTab === 'gcpdiff'">
          <UCard>
            <template #header>
              <div class="flex flex-wrap items-center gap-2 print:hidden">
                <span class="font-semibold">オンプレ vs Supabase ({{ fmtYm(month) }})</span>
                <span class="text-xs text-gray-500">
                  勤怠の日別サマリを、オンプレ (MariaDB 生読み) と GCP (Supabase の畳み込み) で
                  突き合わせます。<b>同じ実装なので「なぜ違うか」はここでは判定しません</b> — 差の区分と
                  観測値、「どの操作で直りうるか」の候補までを出します。
                </span>
                <div class="flex-1" />
                <!-- 保存分の「最終確認」— 突合そのもの (50秒) は右のボタンでしか走らない
                     (Refs #620-3)。古い値を現在の値に見せないよう、月ごとに必ず出す。 -->
                <UBadge
                  :color="gcpDiffCacheState.status === 'ok' ? 'neutral' : 'warning'"
                  variant="subtle"
                  size="sm"
                >
                  {{ gcpDiffCacheLoading ? '確認状況を確認中…' : gcpDiffCacheHeadline }}
                </UBadge>
                <UButton
                  size="xs"
                  icon="i-lucide-git-compare"
                  label="取り直す (約50秒)"
                  :loading="gcpDiffLoading"
                  :disabled="gcpDiffLoading"
                  title="この場で本物の突合をやり直します。約50秒かかります — 自動では走りません。"
                  @click="loadGcpDiff"
                />
              </div>
            </template>

            <UAlert
              v-if="gcpDiffError"
              color="error"
              variant="soft"
              class="mb-3"
              icon="i-lucide-alert-triangle"
              title="取り直しに失敗しました"
              :description="gcpDiffError"
            />

            <div v-if="gcpDiffLoading" class="mb-3 flex items-center gap-2 text-sm text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
              取り直しています… 約50秒かかります (オンプレ・GCP 双方から取得し、GCP recalc の dry-run も走らせるため)。
            </div>

            <div v-if="gcpDiffCacheLoading && gcpDiffCacheState.status === 'none' && !gcpDiffLoading" class="flex items-center gap-2 text-sm text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
              保存分を確認しています…
            </div>
            <p v-else-if="gcpDiffCacheState.status === 'none' && !gcpDiffLoading" class="text-sm text-gray-500">
              この月はまだ一度も突合していません (<b>未確認</b>)。「取り直す」を押すと、この月の日別サマリを
              オンプレ・GCP 双方から1回ずつ取得して突き合わせます (約50秒)。
              <b>乗務員での絞り込みはできません</b> (月全体を1回取得するほうが絞り込みより速い実測があるため —
              見たい乗務員は取得後に手元の一覧から探してください)。
            </p>
            <UAlert
              v-else-if="gcpDiffCacheState.status === 'unreadable' && !gcpDiffLoading"
              color="warning"
              variant="soft"
              icon="i-lucide-alert-triangle"
              title="保存分を読めませんでした"
              description="「差はありません」という意味ではありません — 「取り直す」を押して突合し直してください。"
            />
            <template v-else-if="gcpDiffCacheState.status === 'ok' && gcpDiffSummary">
              <UAlert
                v-if="gcpDiffSummary.onpremUnreadable"
                color="warning"
                variant="soft"
                class="mb-3"
                icon="i-lucide-alert-triangle"
                title="オンプレの応答の形が読めませんでした"
                description="このため「GCPのみ」の件数は当てになりません — オンプレ側が本当に空なのか、応答の形が読めなかっただけなのか区別できていません。"
              />
              <!-- Refs #633-4: 「差0件」と「その項目を比較できていない」を混同しない -->
              <UAlert
                v-if="fmtKintaiDiffMissingFieldsNote(gcpDiffSummary.missingFields)"
                color="warning"
                variant="soft"
                class="mb-3"
                icon="i-lucide-alert-triangle"
                title="一部項目を比較していません"
                :description="fmtKintaiDiffMissingFieldsNote(gcpDiffSummary.missingFields) ?? ''"
              />

              <div class="mb-3 text-xs text-gray-500">
                GCP {{ gcpDiffSummary.gcpRows }} 行 / オンプレ {{ gcpDiffSummary.onpremRows }} 行
              </div>

              <!-- 差の5区分 -->
              <div class="overflow-x-auto mb-4">
                <table class="min-w-full text-sm border-collapse">
                  <thead class="bg-gray-100 dark:bg-gray-800">
                    <tr>
                      <th class="px-2 py-1 text-left">区分</th>
                      <th class="px-2 py-1 text-right">件数</th>
                      <th class="px-2 py-1 text-left">注記</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="cat in KINTAI_DIFF_CATEGORIES" :key="cat.key" class="border-t border-gray-200 dark:border-gray-700">
                      <td class="px-2 py-1">{{ cat.label }}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{{ fmtKintaiDiffCount(gcpDiffSummary[cat.key]) }}</td>
                      <td class="px-2 py-1 text-xs text-gray-500">{{ cat.note }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- 5区分の明細 (Refs #633-6): 件数だけでは「どの乗務員のどの日か」が
                   画面から辿れないという指摘に応える。既定は details 要素で畳んでおき、
                   押した時だけ開く。0件の区分は出さない。 -->
              <div class="mb-4">
                <h4 class="font-semibold text-sm mb-1">明細</h4>
                <p v-if="gcpDiffCategoryItemsState.status !== 'ok'" class="text-sm text-gray-500">
                  明細は取り直すと出ます (保存分のキャッシュは明細を持っていません — 「取り直す」を押してください)。
                </p>
                <template v-else>
                  <template v-for="cat in KINTAI_DIFF_CATEGORIES" :key="cat.key">
                    <details
                      v-if="gcpDiffSummary[cat.key].total > 0"
                      class="mb-2 rounded border border-gray-200 dark:border-gray-700 p-2"
                    >
                      <summary class="cursor-pointer text-sm font-medium">
                        {{ cat.label }} の明細 ({{ fmtKintaiDiffCount(gcpDiffSummary[cat.key]) }})
                      </summary>
                      <div class="mt-2 space-y-2">
                        <UAlert
                          v-if="fmtKintaiDiffCategoryCappedNote(gcpDiffSummary[cat.key])"
                          color="warning"
                          variant="soft"
                          icon="i-lucide-alert-triangle"
                          title="明細が切れています"
                          :description="fmtKintaiDiffCategoryCappedNote(gcpDiffSummary[cat.key]) ?? ''"
                        />
                        <!-- Refs #633-6 条件6: missing_fields の注記を明細の近くにも出す
                             (件数表の近くだけでなく)。value_diff_* の項目自体がここから漏れうるため。 -->
                        <p
                          v-if="(cat.key === 'valueDiffRestraintMatch' || cat.key === 'valueDiffRestraintMismatch')
                            && fmtKintaiDiffMissingFieldsNote(gcpDiffSummary.missingFields)"
                          class="text-xs text-warning"
                        >
                          {{ fmtKintaiDiffMissingFieldsNote(gcpDiffSummary.missingFields) }}
                        </p>
                        <ul class="divide-y divide-gray-200 dark:divide-gray-700 text-sm">
                          <li v-for="(row, i) in (gcpDiffCategoryItemsByKey[cat.key] ?? [])" :key="i" class="py-1">
                            <div class="text-xs text-gray-500">
                              乗務員CD {{ row.driverCd }} / {{ row.date }} / {{ row.start }}
                              <span v-if="row.side">({{ row.side === 'gcp' ? 'GCP' : 'オンプレ' }}のみ)</span>
                            </div>
                            <!-- value_diff 行: 差のある項目だけを並べる (差の無い項目で薄めない) -->
                            <div v-for="fr in row.valueDiffFieldRows" :key="fr.field" class="text-xs">
                              {{ fr.label }}: GCP {{ fr.gcp }} ←→ オンプレ {{ fr.onprem }}
                            </div>
                            <!-- one_sided 行: 比較対象が無い片側だけの値 (非0項目だけ) -->
                            <div v-for="fr in row.oneSidedFieldRows" :key="fr.field" class="text-xs">
                              {{ fr.label }}: {{ fr.value }}
                            </div>

                            <!-- alcへ上げ直す導線 (Refs #633-17)。★ 押しただけでは何も投入
                                 しない — 「運行を引く」は day-operations を読むだけ、
                                 「alcへ上げ直す」は運行1件ごとのボタンで人が選んで押す
                                 (複数運行を自動で選ばない、親判断1,2)。 -->
                            <div class="mt-1">
                              <UButton
                                size="xs"
                                variant="soft"
                                label="運行を引く"
                                :loading="diffRowDayOperationsFor(row.driverCd, row.date)?.status === 'loading'"
                                @click="lookupDayOperationsForDiffRow(row.driverCd, row.date)"
                              />
                              <UAlert
                                v-if="diffRowDayOperationsFor(row.driverCd, row.date)?.status === 'error'"
                                color="error"
                                variant="soft"
                                class="mt-1"
                                :description="diffRowDayOperationsFor(row.driverCd, row.date)?.error ?? ''"
                              />
                              <p
                                v-else-if="diffRowDayOperationsFor(row.driverCd, row.date)?.status === 'ok'
                                  && (diffRowDayOperationsFor(row.driverCd, row.date)?.operations.length ?? 0) === 0"
                                class="text-xs text-gray-500 mt-1"
                              >
                                この日に運行が見つかりませんでした。
                              </p>
                              <ul
                                v-else-if="diffRowDayOperationsFor(row.driverCd, row.date)?.status === 'ok'"
                                class="mt-1 space-y-1"
                              >
                                <li
                                  v-for="op in (diffRowDayOperationsFor(row.driverCd, row.date)?.operations ?? [])"
                                  :key="op.unkoNo"
                                  class="rounded border border-gray-200 dark:border-gray-700 p-1"
                                >
                                  <div class="text-xs">
                                    {{ op.vehicle ?? '(車両不明)' }} / 出庫 {{ op.startOpe }}
                                    <span v-if="op.runStart" class="text-gray-500">(運行開始 {{ op.runStart }})</span>
                                  </div>
                                  <!-- 押す前に見せる注意 (親判断5): 押した後では遅い -->
                                  <p class="text-xs text-warning">
                                    ⚠ 投入するとこの運行は読み取り側から一時的に消えます (has_kudgivt が一時的に FALSE に戻ります)。
                                  </p>
                                  <UButton
                                    size="xs"
                                    color="error"
                                    variant="soft"
                                    label="alcへ上げ直す"
                                    :loading="diffRowAlcUploadFor(op.unkoNo)?.status === 'loading'"
                                    :disabled="diffRowAlcUploadFor(op.unkoNo)?.status === 'loading'"
                                    @click="uploadOperationToAlc(op)"
                                  />
                                  <!-- ③ (勤務時間再登録) の欄へ渡す導線 (Refs #633-17b)。day-operations が
                                       返す23桁 (対象CD込み) をそのまま渡す — ここで③は実行しない、
                                       欄に入れてスクロールするだけ (人が確認して押す)。23桁が引けて
                                       いない運行 (壊れた形で front が防御的に落とした場合) はボタンごと
                                       出さない — 「押せるのに失敗する」を作らない。 -->
                                  <UButton
                                    v-if="isKintaiDayOperationUnkoNo23Digit(op.unkoNo)"
                                    size="xs"
                                    variant="soft"
                                    label="③ の欄に入れる (23桁)"
                                    class="ml-1"
                                    @click="applyDayOperationToMysqlResetForm(row.driverCd, op.unkoNo)"
                                  />
                                  <UAlert
                                    v-if="diffRowAlcUploadFor(op.unkoNo)?.status === 'error'"
                                    color="error"
                                    variant="soft"
                                    class="mt-1"
                                    :description="diffRowAlcUploadFor(op.unkoNo)?.error ?? ''"
                                  />
                                  <div v-else-if="diffRowAlcUploadFor(op.unkoNo)?.status === 'ok'" class="text-xs mt-1 space-y-0.5">
                                    <!-- operations_count は黙って隠さない (2なら2マンで主・助手の両方が入った、親判断3) -->
                                    <p>
                                      upload_id: {{ diffRowAlcUploadFor(op.unkoNo)?.result?.uploadId ?? '(なし)' }} /
                                      operations_count: {{ diffRowAlcUploadFor(op.unkoNo)?.result?.operationsCount ?? '?' }}
                                    </p>
                                    <!-- split_failed: 0 を「成功」と表示しない — notes.split をそのまま出す (親判断4) -->
                                    <p class="text-warning">{{ diffRowAlcUploadFor(op.unkoNo)?.result?.notes.split }}</p>
                                    <p class="text-warning">{{ diffRowAlcUploadFor(op.unkoNo)?.result?.notes.hasKudgivt }}</p>
                                    <p>
                                      畳み直し (recalc) が別途必要です —
                                      <button type="button" class="underline" @click="scrollToFoldSection">
                                        「② GCP 側の畳み直し」
                                      </button>
                                      から実行してください (このボタンは投入するだけで畳み直しはしません、親判断6)。
                                    </p>
                                  </div>
                                </li>
                              </ul>
                            </div>
                          </li>
                        </ul>
                      </div>
                    </details>
                  </template>
                </template>
              </div>

              <!-- 観測値 (判定材料であって原因ではない) -->
              <div class="mb-4">
                <h4 class="font-semibold text-sm mb-1">観測値</h4>
                <UAlert
                  v-if="gcpDiffObservationsError"
                  color="warning"
                  variant="soft"
                  class="mb-2"
                  icon="i-lucide-alert-triangle"
                  title="観測値を取得できませんでした"
                  :description="gcpDiffObservationsError"
                />
                <ul v-else-if="gcpDiffObservations" class="text-sm space-y-1">
                  <li>stale (現行ロジック未反映) の乗務員数: <b>{{ gcpDiffObservations.staleDrivers ?? '不明' }}</b></li>
                  <li>畳み直すと変わる乗務員数 (dry-run 1ページぶん): <b>{{ gcpDiffObservations.foldWouldWriteDrivers ?? '不明' }}</b></li>

                  <!-- GCP にしか無い運行の内訳 (Refs #615-7)。also_in_month (取り込み漏れの候補) を
                       主役にし、never_onprem (構造的なもの) は副次的に畳んで出す。 -->
                  <li v-if="gcpDiffObservations.unkoDiffGcpOnlyInMonth === null">
                    対象月に GCP にしか無い運行数: <b>不明</b>
                  </li>
                  <li v-else>
                    <div>
                      取り込み漏れの候補 (当月オンプレにも居る乗務員の運行):
                      <b class="text-base">{{ gcpDiffObservations.unkoDiffGcpOnlyDriverSplit.alsoInMonthOps }}</b>
                      <span class="text-xs text-gray-500">
                        (乗務員 {{ gcpDiffObservations.unkoDiffGcpOnlyDriverSplit.alsoInMonthDrivers }}名)
                      </span>
                    </div>

                    <!-- 取り込み漏れ候補の運行NO一覧 (Refs #623-2)。★ 遅い口 — 押した時だけ叩く -->
                    <div class="mt-2">
                      <UButton
                        size="xs"
                        variant="soft"
                        icon="i-lucide-list"
                        :label="unkoGapsLoaded ? '運行NO を出し直す' : '運行NO を出す'"
                        :loading="unkoGapsLoading"
                        :disabled="unkoGapsLoading"
                        @click="loadUnkoGaps"
                      />
                      <span class="text-xs text-gray-500 ml-2">
                        ★ 遅い口です (alc への etags 往復を含み、所要時間の保証はありません)。押した時だけ取得します。
                      </span>
                      <p class="text-xs text-gray-500 mt-1">
                        ★ この候補判定はオンプレの <code>time_card_dtako</code> に在るかだけを見ています。
                        デジタコ自体 (<code>dtako_events</code>) は取り込み済みでも、ここに出ることがあります
                        (下の「オンプレのデジタコ在否を調べる」で1件ずつ区別できます)。
                      </p>

                      <UAlert
                        v-if="unkoGapsError"
                        color="error"
                        variant="soft"
                        class="mt-2"
                        icon="i-lucide-alert-triangle"
                        title="取得できませんでした"
                        :description="unkoGapsError"
                      />

                      <div v-else-if="unkoGapsLoading" class="flex items-center gap-2 text-sm text-gray-500 mt-2">
                        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
                        取得しています… (数十秒かかることがあります)
                      </div>

                      <template v-else-if="unkoGapsLoaded && unkoGapsResult">
                        <!-- ★「候補なし」と「引けていない」を混同しない (issue #623-2 の必須条件) -->
                        <UAlert
                          v-if="unkoGapsReadability === 'etags_unavailable'"
                          color="warning"
                          variant="soft"
                          class="mt-2"
                          icon="i-lucide-alert-triangle"
                          title="GCP側の運行一覧が引けませんでした"
                          description="「候補なし」ではなく「引けていない」状態です。下の一覧は当てになりません — 時間をおいて出し直してください。"
                        />
                        <UAlert
                          v-else-if="unkoGapsReadability === 'driver_cds_unavailable'"
                          color="warning"
                          variant="soft"
                          class="mt-2"
                          icon="i-lucide-alert-triangle"
                          title="乗務員別の内訳が引けませんでした"
                          description="alc が driver_cds を返していません (正常に空のこともあります) — 「取り込み漏れ0件」と断定できません。"
                        />

                        <div v-if="unkoGapsResult.drivers.length" class="mt-2 space-y-2">
                          <div
                            v-for="d in unkoGapsResult.drivers"
                            :key="d.driverCd"
                            class="text-sm border border-gray-200 dark:border-gray-700 rounded p-2"
                          >
                            <div class="font-medium">
                              乗務員CD {{ d.driverCd }}
                              <span class="text-xs text-gray-500">
                                ({{ d.unkoNos.length }}件{{ d.truncated ? ' 以上 — 上限で打ち切り' : '' }})
                              </span>
                            </div>
                            <!-- 運行NOはコピー用テキスト (select-all) としても出しつつ、
                                 「①② の欄に入れる (22桁)」で mysqlRefreshUnkoNo/driverCd 欄へも渡す
                                 (Refs #623-2。#625/#627 マージ済みで22桁のまま①②が実行できる。
                                 ③自体はこの22桁では拒否される — ラベルは Refs #633-17b で明確化) -->
                            <ul class="mt-1 space-y-2">
                              <li v-for="no in d.unkoNos" :key="no">
                                <div class="flex flex-wrap items-center gap-2">
                                  <code class="text-xs select-all">{{ no }}</code>
                                  <span class="text-xs text-gray-500">
                                    ({{ unkoGapsResult.unkoNoDigits ?? no.length }}桁、GCP側) —
                                    start_ope目安: {{ kintaiUnkoGapsDeriveStartOpe(no) ?? '不明' }}
                                  </span>
                                  <UButton
                                    size="xs"
                                    variant="soft"
                                    label="①② の欄に入れる (22桁)"
                                    @click="applyUnkoGapCandidateToMysqlForm(d.driverCd, no)"
                                  />
                                </div>

                                <!-- オンプレにデジタコが在るか (Refs #633-1 条件8〜14、#633-2 で multiple を追加)。
                                     ★ 押した時だけ一括で調べる (下のボタン) — ここは結果があれば表示するだけ。 -->
                                <p
                                  class="mt-1 text-xs"
                                  :class="{
                                    'text-green-700 dark:text-green-400': dtakoPresenceViewFor(d.driverCd, no).status === 'present',
                                    'text-amber-700 dark:text-amber-400': dtakoPresenceViewFor(d.driverCd, no).status === 'multiple',
                                    'text-gray-500': dtakoPresenceViewFor(d.driverCd, no).status === 'absent' || dtakoPresenceViewFor(d.driverCd, no).status === 'inconclusive',
                                  }"
                                >
                                  {{ dtakoPresenceViewFor(d.driverCd, no).message }}
                                  <template v-if="dtakoPresenceViewFor(d.driverCd, no).unkoNo23">
                                    実物: <code class="select-all">{{ dtakoPresenceViewFor(d.driverCd, no).unkoNo23 }}</code>
                                  </template>
                                </p>
                                <!-- multiple: 人が目で見て選ぶための候補一覧。★ 自動で1件を選ばない —
                                     ③フォームへの「使う」ボタンはここには置かない (どれが正しい対象CDかは
                                     front には判別できないため、親判断 2026-08-04)。 -->
                                <ul
                                  v-if="dtakoPresenceViewFor(d.driverCd, no).candidates.length"
                                  class="mt-0.5 ml-4 text-xs text-gray-500 list-disc list-inside"
                                >
                                  <li v-for="c in dtakoPresenceViewFor(d.driverCd, no).candidates" :key="c">
                                    <code class="select-all">{{ c }}</code>
                                  </li>
                                </ul>

                                <!-- その日の両側の差 (Refs #633-1)。★ 候補が複数あっても価値は
                                     1件ずつ違う (issue #633 実測: 1740は40分差あり・1445は一致) —
                                     一律に「取り込むべき」とは出さず、その日の実測を並べるだけ。 -->
                                <div class="mt-1 pl-1 border-l-2 border-gray-200 dark:border-gray-700">
                                  <p
                                    v-if="candidateDiffViewFor(d.driverCd, no).kind === 'unconfirmed'"
                                    class="text-xs text-gray-500"
                                  >
                                    その日の差分は未確認です — この月の「オンプレ vs Supabase」をまだ取り直していません
                                    (取り直すと分かります)。
                                  </p>
                                  <p
                                    v-else-if="candidateDiffViewFor(d.driverCd, no).kind === 'no_diff'"
                                    class="text-xs text-gray-500"
                                  >
                                    その日は両側一致しています (差分リストに無し。最終確認:
                                    {{ candidateDiffViewFor(d.driverCd, no).lastVerified ?? '不明' }})。
                                    取り込む必要が無いと決まったわけではありません — 日別サマリに出ない形の
                                    欠けもあり得ます。
                                  </p>
                                  <!-- day_absent (Refs #633-3): 運行の開始日と勤怠の暦日がずれる日跨ぎ
                                       勤務で、その日は両側とも突き合わせていない。「一致」と混同しない。 -->
                                  <p
                                    v-else-if="candidateDiffViewFor(d.driverCd, no).kind === 'day_absent'"
                                    class="text-xs text-gray-500"
                                  >
                                    {{ candidateDiffViewFor(d.driverCd, no).dayShort }} の勤務行は両側とも存在しません —
                                    この運行は別の日に始まった勤務に含まれている可能性があります (日跨ぎ)。
                                    突き合わせていないので、一致とも不一致とも言えません (最終確認:
                                    {{ candidateDiffViewFor(d.driverCd, no).lastVerified ?? '不明' }})。
                                  </p>
                                  <!-- one_sided (Refs #633-3): 片側にしか勤務行が無い日。事実だけ出す。 -->
                                  <p
                                    v-else-if="candidateDiffViewFor(d.driverCd, no).kind === 'one_sided'"
                                    class="text-xs text-amber-700 dark:text-amber-400"
                                  >
                                    {{ candidateDiffViewFor(d.driverCd, no).dayShort }} の勤務行は片側にしかありません
                                    ({{ candidateDiffViewFor(d.driverCd, no).side === 'gcp' ? 'GCP側のみ' : 'オンプレ側のみ' }}、
                                    最終確認: {{ candidateDiffViewFor(d.driverCd, no).lastVerified ?? '不明' }})。
                                  </p>
                                  <div v-else class="text-xs">
                                    <p class="text-gray-700 dark:text-gray-300">
                                      その日は差があります
                                      ({{ candidateDiffViewFor(d.driverCd, no).kind === 'mismatch' ? '拘束も不一致' : '拘束は一致・内訳のみ違います' }}、
                                      最終確認: {{ candidateDiffViewFor(d.driverCd, no).lastVerified ?? '不明' }})。
                                      <span class="text-gray-500">取り込むと揃う可能性がありますが、保証ではありません。</span>
                                    </p>
                                    <table class="mt-1 border-collapse">
                                      <tbody>
                                        <tr v-for="row in candidateDiffViewFor(d.driverCd, no).fieldRows" :key="row.field">
                                          <td class="pr-2 text-gray-500">{{ row.label }}</td>
                                          <td class="text-right pr-1" :class="row.differs ? 'font-semibold' : ''">{{ row.gcp }}</td>
                                          <td class="text-gray-400 px-1">←→</td>
                                          <td class="text-right" :class="row.differs ? 'font-semibold' : ''">{{ row.onprem }}</td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </li>
                            </ul>
                          </div>
                          <p class="text-xs text-gray-400">
                            この一覧の延べ件数 {{ unkoGapsDriverTotal }} 件
                            (上の {{ gcpDiffObservations.unkoDiffGcpOnlyDriverSplit.alsoInMonthOps }} 件と
                            取得タイミングの違いで一致しないことがあります)
                          </p>

                          <!-- オンプレのデジタコ在否の一括チェック (Refs #633-1 条件8〜14)。
                               ★ 押した時だけ、候補を直列で1件ずつ引く (自動実行しない)。 -->
                          <div class="mt-2">
                            <UButton
                              size="xs"
                              variant="soft"
                              icon="i-lucide-search"
                              label="オンプレのデジタコ在否を調べる"
                              :loading="dtakoPresenceChecking"
                              :disabled="dtakoPresenceChecking"
                              @click="checkDtakoPresenceForAllCandidates"
                            />
                            <span v-if="dtakoPresenceProgress" class="text-xs text-gray-500 ml-2">
                              {{ dtakoPresenceProgress.done }} / {{ dtakoPresenceProgress.total }} 件確認
                            </span>
                          </div>
                        </div>
                        <p v-else-if="unkoGapsReadability === 'ok'" class="text-xs text-gray-500 mt-2">
                          候補はありません。
                        </p>

                        <details v-if="unkoGapsResult.unknownDriverUnkoNos.length" class="mt-2 text-xs text-gray-500">
                          <summary class="cursor-pointer select-none">
                            乗務員不明の運行
                            ({{ unkoGapsResult.unknownDriverUnkoNos.length }}件{{ unkoGapsResult.unknownDriverUnkoNosTruncated ? ' 以上' : '' }})
                          </summary>
                          <p class="mt-1">
                            ★ 乗務員CD が無いため、上の「オンプレのデジタコ在否を調べる」の対象外です
                            (day-events-lookup は driver_cd が必須)。
                          </p>
                          <ul class="list-disc list-inside mt-1">
                            <li v-for="no in unkoGapsResult.unknownDriverUnkoNos" :key="no"><code>{{ no }}</code></li>
                          </ul>
                        </details>

                        <p class="text-xs text-gray-400 mt-2">
                          所要 {{ unkoGapsResult.elapsedMs ?? '?' }} ms
                          {{ unkoGapsResult.driversTruncated ? ' / 乗務員一覧は上限で打ち切りあり' : '' }}
                        </p>
                      </template>
                    </div>

                    <details class="mt-1 text-xs text-gray-500">
                      <summary class="cursor-pointer select-none">
                        対象月に GCP にしか無い運行数 (合計 {{ gcpDiffObservations.unkoDiffGcpOnlyInMonth }} = 下3つの和) — 内訳
                      </summary>
                      <ul class="list-disc list-inside mt-1 space-y-0.5">
                        <li>
                          当月オンプレにも居る乗務員の運行 (取り込み漏れの候補、上と同じ数):
                          {{ gcpDiffObservations.unkoDiffGcpOnlyDriverSplit.alsoInMonthOps }}
                          (乗務員 {{ gcpDiffObservations.unkoDiffGcpOnlyDriverSplit.alsoInMonthDrivers }}名)
                        </li>
                        <li>
                          別月にはオンプレに居る乗務員の運行:
                          {{ gcpDiffObservations.unkoDiffGcpOnlyDriverSplit.otherMonthOnlyOps }}
                          (乗務員 {{ gcpDiffObservations.unkoDiffGcpOnlyDriverSplit.otherMonthOnlyDrivers }}名)
                        </li>
                        <li>
                          打刻システムが無い営業所の乗務員 + 乗務員CD=0 (構内移動・回送等) の運行:
                          {{ gcpDiffObservations.unkoDiffGcpOnlyDriverSplit.neverOnpremOps }}
                          (乗務員 {{ gcpDiffObservations.unkoDiffGcpOnlyDriverSplit.neverOnpremDrivers }}名) —
                          構造的なもので差ではありません
                        </li>
                      </ul>
                    </details>
                  </li>

                  <li v-if="gcpDiffObservations.warnings.length">
                    警告:
                    <ul class="list-disc list-inside">
                      <li v-for="(w, i) in gcpDiffObservations.warnings" :key="i" class="text-amber-700 dark:text-amber-400">
                        {{ w }}
                      </li>
                    </ul>
                  </li>
                </ul>
                <p v-else class="text-sm text-gray-500">観測値はありません。</p>
              </div>

              <!-- 処方の候補 (原因ではない) -->
              <div>
                <h4 class="font-semibold text-sm mb-1">処方の候補 (原因の断定ではありません)</h4>
                <p class="text-xs text-gray-500 mb-1">
                  オンプレと GCP は同じ実装なので、差は「入力が違う」= 2つのDBの中身の差でしかなく、
                  どちらが正しいかはここでは判定できません。以下は観測値から機械的に導いた候補であって、
                  <b>「押せば直る」ことを意味しません</b> — 保証の有無は③の対象ごとに個別に確認してください。
                </p>
                <ul class="text-sm space-y-1">
                  <li v-for="p in gcpDiffPrescriptions" :key="p.key" :class="p.relevant ? '' : 'text-gray-400'">
                    <UBadge v-if="p.relevant" color="warning" variant="subtle" size="sm" class="mr-1">該当あり</UBadge>
                    {{ p.action }} — {{ p.observation }}
                  </li>
                </ul>
              </div>
            </template>
          </UCard>

          <!-- 取り直し3ボタン。すべて preview (dry-run) → 実行の二段階 -->
          <UCard class="mt-4">
            <template #header>
              <span class="font-semibold">① 打刻を運び直す (オンプレ → GCP)</span>
            </template>
            <p class="text-xs text-gray-500 mb-2">
              窓 (既定: 当月+前月) ぶんの打刻をオンプレから運び、GCP 側に反映し直します。
              <b>押しても直る保証はありません</b> — 打刻が既に GCP に反映済みなら書き換えは 0 件のままです。
            </p>
            <UAlert
              v-if="timecardRefreshError"
              color="error"
              variant="soft"
              class="mb-2"
              icon="i-lucide-alert-triangle"
              title="失敗しました"
              :description="timecardRefreshError"
            />
            <div class="flex flex-wrap items-center gap-2">
              <UButton
                size="xs"
                label="① 確認 (dry-run)"
                :loading="timecardRefreshLoading"
                :disabled="timecardRefreshLoading"
                @click="previewTimecardRefresh"
              />
              <UButton
                size="xs"
                color="error"
                label="② 実行 (書き込む)"
                :loading="timecardRefreshLoading"
                :disabled="timecardRefreshLoading || !timecardRefreshPreview || !timecardRefreshPreview.dryRun"
                @click="applyTimecardRefresh"
              />
            </div>
            <div v-if="timecardRefreshPreview" class="mt-2 text-sm">
              <span :class="timecardRefreshPreview.dryRun ? 'text-gray-500' : 'font-medium text-green-700 dark:text-green-400'">
                {{ timecardRefreshPreview.dryRun ? '(dry-run — まだ書き込んでいません)' : '(実行しました)' }}
              </span>
              対象月 {{ timecardRefreshPreview.months.join(', ') }} / 乗務員 {{ timecardRefreshPreview.drivers }} 名 /
              行 {{ timecardRefreshPreview.events }} 件 →
              書き換え <b>{{ timecardRefreshPreview.driversWritten }}</b> 名 (日 {{ timecardRefreshPreview.daysWritten }} 件)
              <span v-if="timecardRefreshPreview.misplaced > 0" class="text-red-600 dark:text-red-400">
                / 窓外として弾いた行 {{ timecardRefreshPreview.misplaced }} 件 (0でないと壊れています)
              </span>
            </div>
          </UCard>

          <UCard id="gcp-fold-section" class="mt-4">
            <template #header>
              <span class="font-semibold">② GCP 側を畳み直す (fold recalc)</span>
            </template>
            <p class="text-xs text-gray-500 mb-2">
              GCP 側の日別サマリを全量再計算し直します。<b>押しても直る保証はありません</b>
              (畳み直しても値が変わらないことがあります)。1ページ最大50人ずつ処理し、
              <code>next_after_driver_cd</code> が無くなるまでこの画面が自動で回し切ります。
            </p>
            <UCheckbox v-model="foldStaleOnly" label="stale (現行ロジック未反映) の乗務員だけに絞る" class="mb-2" />
            <UAlert
              v-if="foldError"
              color="error"
              variant="soft"
              class="mb-2"
              icon="i-lucide-alert-triangle"
              title="失敗しました (途中まで進んだページはあります)"
              :description="foldError"
            />
            <div class="flex flex-wrap items-center gap-2">
              <UButton
                size="xs"
                label="① 確認 (dry-run、全ページ回し切る)"
                :loading="foldRunning"
                :disabled="foldRunning"
                @click="previewFoldRefresh"
              />
              <UButton
                size="xs"
                color="error"
                label="② 実行 (書き込む、全ページ回し切る)"
                :loading="foldRunning"
                :disabled="foldRunning || !foldProgress || foldApplied"
                @click="applyFoldRefresh"
              />
            </div>
            <div v-if="foldProgress" class="mt-2 text-sm">
              <span :class="foldApplied ? 'font-medium text-green-700 dark:text-green-400' : 'text-gray-500'">
                {{ foldApplied ? '(実行' : '(dry-run' }}{{ foldProgress.done ? ' — 完了)' : foldRunning ? ' — 進行中)' : ' — 中断)' }}
              </span>
              {{ foldProgress.pages }} ページ処理 / 通算 <b>{{ foldProgress.driversWrittenTotal }}</b> 名ぶん
              {{ foldApplied ? '書き換え' : '変わる見込み' }}
              <ul v-if="foldProgress.warnings.length" class="list-disc list-inside text-amber-700 dark:text-amber-400 mt-1">
                <li v-for="(w, i) in foldProgress.warnings" :key="i">{{ w }}</li>
              </ul>
            </div>
          </UCard>

          <UCard id="gcp-mysql-refresh-section" class="mt-4">
            <template #header>
              <span class="font-semibold">③ MySQL (dtako) 側を取り直す</span>
            </template>
            <p class="text-xs text-gray-500 mb-2">
              運行1件 (運行NO) ぶんの csvdata.zip を theearth から取り直し、オンプレ MariaDB へ push します。
              <b>rust-ichibanboshi 側のコード自身が「押しても直る保証が無い」対象があると明記しています</b> —
              下の「保証」の表示を必ず確認してください。実行前に保証を確認しても、実行そのものはブロックされません。
              運行NOは<b>「勤務時間再登録まで行う」がオフなら22桁 (取り込み漏れ候補等) でも構いません</b> —
              オンでは③ (`resetby-unko-no`) の対象になるため23桁 (対象CDまで) が必須です。
            </p>
            <div class="flex flex-wrap items-center gap-2 mb-2">
              <UInput v-model="mysqlRefreshUnkoNo" size="xs" placeholder="運行NO (unko_no、22桁 or 23桁)" class="w-56" />
              <UInput v-model="mysqlRefreshDriverCd" size="xs" placeholder="乗務員CD (任意、保証判定用)" class="w-44" />
              <UCheckbox v-model="mysqlRefreshResetTimecard" label="勤務時間再登録まで行う (③、破壊的)" />
            </div>
            <div v-if="mysqlRefreshUnkoNoIs22Digit" class="text-xs mb-2">
              <p class="text-amber-700 dark:text-amber-400">
                22桁 (GCP側) です。取り込み (①②) はこのまま実行できます。
                ③ (勤務時間再登録) にはオンプレの23桁 (対象CD込み) が必要です —
                <b>①②を実行した後</b>、下のボタンでオンプレから実物の23桁を引けます
                (②の反映タイミングは未確認のため自動では引きません。時間をおいて何度でも押し直せます)。
              </p>
              <div class="flex flex-wrap items-center gap-2 mt-1">
                <UButton
                  size="xs"
                  variant="soft"
                  label="day-events で23桁を引く"
                  :loading="dayEventsLookupLoading"
                  :disabled="dayEventsLookupLoading || !mysqlRefreshDriverCd.trim()"
                  @click="lookupDayEventsForMysqlRefreshCandidate"
                />
                <span v-if="!mysqlRefreshDriverCd.trim()" class="text-gray-400">乗務員CD欄が必要です</span>
              </div>
              <UAlert
                v-if="dayEventsLookupError"
                color="error"
                variant="soft"
                class="mt-1"
                icon="i-lucide-alert-triangle"
                title="引けませんでした"
                :description="dayEventsLookupError"
              />
              <template v-if="dayEventsLookup">
                <p v-if="dayEventsLookup.status === 'not_found'" class="text-gray-500 mt-1">
                  {{ dayEventsLookup.date }} の乗務員CD {{ dayEventsLookup.driverCd }} に、この候補 (prefix {{ dayEventsLookup.opeNo }}) の運行がまだ見えません。
                  ①②を実行済みなら、時間をおいてもう一度お試しください (読むだけなので何度でも安全です)。
                </p>
                <p v-else-if="dayEventsLookup.status === 'found' && dayEventsLookup.unkoNo" class="text-green-700 dark:text-green-400 mt-1">
                  見つかりました: <code class="select-all">{{ dayEventsLookup.unkoNo }}</code>
                  <UButton
                    size="xs"
                    variant="soft"
                    label="この値を運行NO欄に入れる"
                    class="ml-2"
                    @click="useDayEventsLookupUnkoNo(dayEventsLookup.unkoNo)"
                  />
                </p>
                <template v-else-if="dayEventsLookup.status === 'ambiguous'">
                  <p class="text-amber-700 dark:text-amber-400 mt-1">
                    複数の運行が該当しました (2マン運行等)。<b>乗務員を取り違えると別の人のデータを消します</b> —
                    正しい行を確認してから選んでください。黙って1件目は選びません。
                  </p>
                  <ul class="mt-1 space-y-1">
                    <li v-for="c in dayEventsLookup.candidates" :key="c" class="flex items-center gap-2">
                      <code class="select-all">{{ c }}</code>
                      <UButton size="xs" variant="soft" label="この値を使う" @click="useDayEventsLookupUnkoNo(c)" />
                    </li>
                  </ul>
                </template>
              </template>
            </div>
            <UAlert
              v-if="mysqlRefreshError"
              color="error"
              variant="soft"
              class="mb-2"
              icon="i-lucide-alert-triangle"
              title="失敗しました"
              :description="mysqlRefreshError"
            />
            <div class="flex flex-wrap items-center gap-2">
              <UButton
                size="xs"
                label="① 確認 (dry-run)"
                :loading="mysqlRefreshLoading"
                :disabled="mysqlRefreshLoading || !mysqlRefreshUnkoNo.trim()"
                @click="previewMysqlRefresh"
              />
              <UButton
                size="xs"
                color="error"
                label="② 実行 (取り直す)"
                :loading="mysqlRefreshLoading"
                :disabled="mysqlRefreshLoading || !mysqlRefreshPreview"
                @click="applyMysqlRefresh"
              />
            </div>
            <div v-if="mysqlRefreshPreview" class="mt-2 text-sm">
              <div class="text-xs text-gray-500">ope_no: {{ mysqlRefreshPreview.opeNo }} / start_ope: {{ mysqlRefreshPreview.startOpe }}</div>
              <div
                class="font-medium"
                :class="mysqlRefreshPreview.guarantee?.guaranteed ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'"
              >
                {{ mysqlRefreshGuaranteeText }}
              </div>
            </div>
            <div v-if="mysqlRefreshApplyResult" class="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {{ mysqlRefreshApplyResult }}
            </div>
          </UCard>
        </template>
      </div>
    </template>
  </div>
</template>

<style>
/* 印刷: サイドバー等のアプリ枠を隠す。一括印刷ビューは月毎に改ページ。
   A4 横向きを想定 (ブラウザの印刷ダイアログで横向きを選択)。 */
@media print {
  aside { display: none !important; }
  .monthly-table { font-size: 9px; }
  .monthly-table th, .monthly-table td { padding: 2px 3px; border: 1px solid #999; }
  .print-month-page { break-after: page; }
  .print-month-page:last-child { break-after: auto; }
  @page { size: A4 landscape; margin: 8mm; }

  /* タイムカードは既存 PDF と同じく 3 人横並び。1 人分の表が途中で割れないように
     break-inside を止める (Refs #424 PR-E)。 */
  .timecard-sheet { font-size: 8px; }
  .timecard-sheet td, .timecard-sheet th { padding: 0 2px; }

  /* 最低賃金チェック: **分類 (会社 × 職員区分) ごとに改ページ** (2026-07-30 要望)。
     区画は tbody 1 つ = 1 分類なので、2 つ目以降の tbody の前で改ページする
     (先頭で切ると白紙が 1 枚出る)。列見出しは Chrome が thead を各ページの
     先頭に繰り返してくれる。13 列あるので字を詰める。 */
  .minwage-section { break-before: page; }
  .minwage-section:first-of-type { break-before: auto; }
  /* 3 段積みの行と分類見出しが紙の境目で割れないように */
  .minwage-table tr { break-inside: avoid; }
  .minwage-section-head { break-after: avoid; }
  .minwage-table { font-size: 9px; }
  .minwage-table th, .minwage-table td { padding: 2px 3px; }
}
</style>
