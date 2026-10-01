<script setup lang="ts">
/**
 * 訴訟用の準備ページ (Refs #1133 c1133-1)。
 *
 * 「何月から何月まで・どの乗務員の勤務を記録するか」を選び、案件として保存して
 * 開き直せる土台。案件を「開く」と詳細にタブが出る。「出力」タブ (#c1133-2) は
 * 案件の乗務員 × 期間ぶんの Y時間 Excel を作って 1 つの ZIP にまとめる。ZIP をダウンロードしたあと、
 * 同じファイルと結果を relay へ 1 つの版として保存し (#c1133-34)、開き直すと最新の版の結果を表示する。
 * 冊ごとの「月ごとの時間」の表 (#c1133-36) は、給与比較タブと同じ保存済みの wage report から作る
 * (「ZIP を作る」の結果にも、保存した版の表示にも依らない)。
 * 「エラー」タブ (#c1133-5) は乗務員 × 月ごとに 4 つの検知 (alc の運行 0 件 /
 * Y時間の欠け / alc にあってオンプレのデジタコに無い運行 / 最低賃金の不変条件) を並べ、alc に運行が無い月は
 * theearth から取り込み直すボタンを出す。「印刷」は案件の概要・出力の結果・エラーの表を
 * 1 つの紙面にする。変更記録のタブは後続 PR (#c1133-6) が足す。
 *
 * ★ エラータブは wage-report を**読むだけ**。最低賃金チェックの自動保存
 * (`POST /restraint-api/wage-snapshot`) は呼ばない (restraint-wage.vue のタブや
 * computed も流用しない)。
 *
 * 認証は restraint-wage.vue の viewer 経路 (Refs #272) と同型: このページの
 * relay route は theearth に触らない (D1 のみ) ので、theearth ログインは不要。
 * 会社を選んで (DTAKO_COMPS) auth-worker JWT (viewer 経路) で閲覧する。1 案件 = 乗務員 1 名 (個別案件)。
 */
import JSZip from 'jszip'
import type { Driver } from '~/types'
import { getDrivers, getYTimePreview, getOperations, getDtakoOperationChanges, currentAccessToken, getViewerComps } from '~/utils/api'
import { caughtErrorStatus, describeCaughtError, describeResponseFailure } from '~/utils/api-error'
import { downloadBlob } from '~/utils/download-blob'
import {
  buildLitigationHoursBooks,
  buildLitigationOutputChunks,
  buildLitigationZipSummary,
  countLitigationResults,
  litigationResultFromFailure,
  litigationOutputSourceLines,
  litigationResultFromHeaders,
  litigationZipFilename,
  LITIGATION_TEMPLATE_KEY,
  type LitigationOutputChunk,
  type LitigationOutputResult,
  type LitigationOutputStatus,
} from '~/utils/litigation-output'
import {
  buildLitigationOutputSnapshot,
  LITIGATION_OUTPUT_CHANGES_STORAGE_NAME,
  LITIGATION_OUTPUT_RESULTS_MAX_CHARS,
  litigationOutputSnapshotChars,
  litigationOutputVersionRow,
  litigationSnapshotMatchesChunks,
  parseLitigationOutputSnapshot,
  parseLitigationOutputVersions,
  type LitigationOutputChanges,
  type LitigationOutputSnapshot,
  type LitigationOutputVersion,
} from '~/utils/litigation-output-version'
import {
  buildLitigationErrorRows,
  classifyLitigationImport,
  countLitigationErrorCells,
  foldYTimeDaysByMonth,
  foldYTimeDroppedByMonth,
  litigationAlcOpsFailure,
  litigationChunkMonths,
  litigationChunkWarnings,
  litigationDriverMonthKey,
  litigationImportRanges,
  litigationMonthBounds,
  litigationAlcReadingRange,
  opeNosStartedInMonth,
  litigationCheckedAtKey,
  litigationNeedsFetch,
  litigationRowCheckedAt,
  litigationRowNeedsAttention,
  reduceWageReportForDriver,
  restoreLitigationChecks,
  LITIGATION_CHECK_KEYS,
  LITIGATION_CHECK_LABELS,
  LITIGATION_CHECK_STATE_LABELS,
  type LitigationAlcOpsEntry,
  type LitigationCheckState,
  type LitigationErrorRow,
  type LitigationFetched,
  type LitigationImportOutcome,
  type LitigationStoredItem,
  type LitigationDtakoOps,
} from '~/utils/litigation-errors'
import {
  alcRecordingSinceNotice,
  buildAlcChangeRows,
  buildKintaiChangeRows,
  KINTAI_CHANGE_LOG_FORBIDDEN_NOTICE,
  kintaiRecordingSinceNotice,
  fmtJstDateTime,
  LITIGATION_CHANGE_LOG_MAX_DAYS,
  litigationCaseDateBounds,
  LITIGATION_CHANGES_CSV_FILENAME,
  litigationChangesCsv,
  mergeLitigationChangeRows,
  parseAlcOperationChanges,
  parseKintaiChangeLog,
  splitDateRangeByMaxDays,
  type LitigationChangeRow,
} from '~/utils/litigation-changes'
import { fmtRatePerHour, monthRange, nextYm, type WageReportResponse } from '~/utils/restraint-wage-view'
import {
  buildLitigationSalaryRows,
  LITIGATION_SALARY_STATE_LABELS,
  litigationAttrsCandidates,
  litigationPayrollMonths,
  litigationRegisterCandidates,
  narrowKyuyoEmployees,
  rateBasisLabel,
  rateBasisPeriods,
  rateBasisStatus,
  salaryRowCells,
  splitPayrollTargets,
  type LitigationRegisterCandidate,
  type PayrollTarget,
  type LitigationSalaryState,
  type RateBasisStatus,
} from '~/utils/litigation-salary'
import type { MinWageFixInput } from '~/utils/min-wage-fix'
import { wageRowOutdatedNotice, type SalaryCdMap, type SalaryCsvRow, type SalaryItemConfig } from '~/utils/salary-compare'
import { fmtPayrollSync, foldPayrollSync, payrollToParsedSalary, summarizeSyncedMonths, toStoredPayroll, type KyuyoPayrollRow } from '~/utils/kyuyo-fetch'
import { buildCdMapEntries, planPayrollDbImport, type EmployeeMasterEntry, type EmployeeMasterGetResponse, type KyuyoEmployeesResponse } from '~/utils/employee-master'
import { parseCompMap } from '~/utils/dtako-comps'
import { b64urlUtf8 } from '~/composables/useTheearthSession'
import { dtakoCompDisplay, pickViewerComp, viewerCompOptions } from '~/utils/dtako-comps'
import {
  addDriverCd,
  buildLitigationCaseSavePayload,
  emptyLitigationCaseForm,
  LITIGATION_CASE_MAX_MONTHS,
  litigationCaseMonthCount,
  deletedCaseExpiryDate,
  LITIGATION_CASE_RESTORE_DAYS,
  litigationCaseToForm,
  removeDriverCd,
  restoreRetryLabel,
  validateLitigationCaseForm,
  type LitigationCaseFormError,
  type LitigationCaseFormInput,
  type DeletedLitigationCaseRecord,
  type LitigationCaseRecord,
} from '~/utils/litigation-case-form'

// 閲覧する会社ID (restraint-wage.vue の viewer 経路 (Refs #272) に倣う)。
// このページの relay route は theearth に触らないので theearth ログインは不要。
// 同じブラウザで restraint-wage.vue / restraint-fetch.vue 等 (theearth 系ページ) を
// 既に使っていれば、その会社IDを引き継いで毎回の手入力を省く (RESTRAINT_VIEWER_COMP_STORAGE_KEY /
// lastAccount の 2 段フォールバック)。**このページ自体は theearth にログインしない**ので
// 引き継ぐのは値だけで、theearth セッションは使わない。引き継ぐのはこのアカウントが見られる会社だけで、
// 見られる会社が 1 社ならそれに決めて選ばせない (pickViewerComp)。
const VIEWER_COMP_STORAGE_KEY = 'litigation-viewer-comp'
const RESTRAINT_VIEWER_COMP_STORAGE_KEY = 'restraint-viewer-comp'
const viewerComp = ref('')
const viewerCompInput = ref('')
/** ログイン中のアカウントが見られる会社 (relay の viewer-comps)。null は一覧の口が無い旧 relay。 */
const viewerComps = ref<string[] | null>(null)
const { lastAccount } = useRestraintSession()

function startViewer() {
  const comp = viewerCompInput.value
  if (!comp) return
  viewerComp.value = comp
  if (import.meta.client) localStorage.setItem(VIEWER_COMP_STORAGE_KEY, comp)
  pageError.value = ''
  loadCases()
}

/** 会社の選択に戻る (Refs 誤選択時の変更手段)。今の値は選択欄に残し、直しやすくする。 */
function changeViewer() {
  viewerComp.value = ''
  pageError.value = ''
  cases.value = []
  casesLoaded.value = false
  deletedCases.value = []
  deletedError.value = ''
  openCaseId.value = null
}

/** restraint-wage.vue の authHeaders と同じ組み立て。`comp` は、押した時点の会社を握って最後まで使う処理 (出力の版の保存) が渡す。 */
function authHeaders(comp = viewerComp.value): Record<string, string> {
  const token = currentAccessToken()
  return {
    'X-Theearth-Comp-Id': comp,
    'X-Theearth-User-B64': b64urlUtf8('viewer'),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

const pageError = ref('')
const cases = ref<LitigationCaseRecord[]>([])
const casesLoaded = ref(false)
const casesLoading = ref(false)

async function loadCases() {
  if (!viewerComp.value) return
  casesLoading.value = true
  const deletedLoad = loadDeletedCases()
  try {
    const res = await $fetch<{ cases: LitigationCaseRecord[] }>('/restraint-api/litigation-cases', {
      headers: authHeaders(),
    })
    cases.value = res.cases
    casesLoaded.value = true
    pageError.value = ''
  }
  catch (e) {
    pageError.value = describeCaughtError(e, '「再読み込み」を押してやり直してください')
  }
  finally {
    casesLoading.value = false
  }
  await deletedLoad
}

// 削除した案件 (削除から 30 日間は復活できる)。admin / payroll 以外は 403 — 役割の無い人には節を出さない
// (front は役割を知らないので、403 を「その人には関係ない」として黙る)。案件の一覧の成否 (pageError) とは分ける。
const deletedCases = ref<DeletedLitigationCaseRecord[]>([])
const deletedError = ref('')

async function loadDeletedCases() {
  try {
    const res = await $fetch<{ cases: DeletedLitigationCaseRecord[] }>('/restraint-api/litigation-cases/deleted', {
      headers: authHeaders(),
    })
    deletedCases.value = res.cases
    deletedError.value = ''
  }
  catch (e) {
    deletedCases.value = []
    deletedError.value = caughtErrorStatus(e) === 403 ? '' : describeCaughtError(e, 'ページを読み込み直してください')
  }
}

const restoring = ref<string | null>(null)

async function restoreCase(entry: DeletedLitigationCaseRecord) {
  restoring.value = entry.case.caseId
  pageError.value = ''
  let failure = ''
  try {
    await $fetch('/restraint-api/litigation-cases/restore', {
      method: 'POST',
      headers: authHeaders(),
      body: { caseId: entry.case.caseId },
    })
  }
  catch (e) {
    failure = describeCaughtError(e, restoreRetryLabel(caughtErrorStatus(e)))
  }
  // 失敗でも読み直す (30 日を過ぎて消えた / 既に復活済みの行を残さない)。読み直しは pageError を空にするので文は後に入れる
  await loadCases()
  if (failure) pageError.value = failure
  restoring.value = null
}

// --- 乗務員一覧 (y-time-export.vue と同じ取り方) ---
// alc に運行が1件でもある乗務員しか出ない (nuxt-dtako-admin-map skill の
// Y時間 節「3つの壁」) ので、一覧に居ない乗務員CDも手入力で追加できるようにする。
const drivers = ref<Driver[]>([])
/** 乗務員の選択肢 (restraint-wage.vue の USelectMenu と同じ「CD 氏名」表記・CD 順で、CD でも氏名でも検索できる)。 */
const driverOptions = computed(() => drivers.value
  .map(d => ({ label: `${d.driver_cd} ${d.driver_name}`, value: d.driver_cd }))
  .sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true })))

onMounted(async () => {
  try {
    viewerComps.value = await getViewerComps()
    viewerComp.value = pickViewerComp(
      viewerComps.value,
      localStorage.getItem(VIEWER_COMP_STORAGE_KEY),
      localStorage.getItem(RESTRAINT_VIEWER_COMP_STORAGE_KEY),
      lastAccount().compId,
    )
  }
  catch (e) {
    // 見られる会社が分からないまま決めない (決めた会社で 401 になりうる)
    pageError.value = describeCaughtError(e, '画面を再読み込みしてください')
  }
  viewerCompInput.value = viewerComp.value
  // 他画面から引き継いだ値は次回のためにこのページ自身のキーにも書いておく
  if (viewerComp.value) localStorage.setItem(VIEWER_COMP_STORAGE_KEY, viewerComp.value)
  if (viewerComp.value) loadCases()
  try {
    drivers.value = await getDrivers()
  }
  catch (e) {
    pageError.value = describeCaughtError(e, '画面を再読み込みしてください')
  }
})

// --- 新規作成/編集フォーム ---
const showForm = ref(false)
const editingCaseId = ref<string | null>(null)
const form = ref<LitigationCaseFormInput>(emptyLitigationCaseForm())
const formErrors = ref<LitigationCaseFormError[]>([])
const driverCdInput = ref('')
const driverAddError = ref('')
const saving = ref(false)

function fieldError(field: LitigationCaseFormError['field']): string {
  return formErrors.value.find(e => e.field === field)?.message ?? ''
}

function startNewCase() {
  editingCaseId.value = null
  form.value = emptyLitigationCaseForm()
  formErrors.value = []
  driverCdInput.value = ''
  driverAddError.value = ''
  showForm.value = true
}

function startEditCase(entry: LitigationCaseRecord) {
  editingCaseId.value = entry.caseId
  form.value = litigationCaseToForm(entry)
  formErrors.value = []
  driverCdInput.value = ''
  driverAddError.value = ''
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
}

// 1 案件 = 乗務員 1 名 (訴訟は個別案件)。選び直すと置き換わる — 既存に積まず空配列へ足す。

/** 一覧 (USelectMenu) で乗務員を選ぶ。選んだ時点で決まる。 */
function selectListedDriver(cd: unknown) {
  const { driverCds, error } = addDriverCd([], typeof cd === 'string' ? cd : '')
  driverAddError.value = error ?? ''
  if (driverCds.length > 0) form.value.driverCds = driverCds
}

/** 一覧に居ない乗務員CDを手入力で選ぶ。 */
function addTypedDriver() {
  const { driverCds, error } = addDriverCd([], driverCdInput.value)
  driverAddError.value = error ?? ''
  // 不正・空の入力で今の選択を消さない
  if (driverCds.length === 0) return
  form.value.driverCds = driverCds
  driverCdInput.value = ''
}

function removeDriver(cd: string) {
  form.value.driverCds = removeDriverCd(form.value.driverCds, cd)
}

/** 乗務員CDに対応する氏名 (一覧に居れば)。手入力分は CD のまま表示する。 */
function driverLabel(cd: string): string {
  return drivers.value.find(d => d.driver_cd === cd)?.driver_name ?? cd
}

/** 案件の乗務員の表示 (`氏名 (CD)`)。1 名制の前に作った複数名の案件は全員を `、` で並べる。 */
function driversText(cds: readonly string[]): string {
  return cds.map(cd => `${driverLabel(cd)} (${cd})`).join('、')
}

async function saveCase() {
  formErrors.value = validateLitigationCaseForm(form.value)
  if (formErrors.value.length > 0) return
  saving.value = true
  pageError.value = ''
  try {
    const payload = buildLitigationCaseSavePayload(form.value, editingCaseId.value ?? undefined)
    await $fetch('/restraint-api/litigation-cases', {
      method: 'PUT',
      headers: authHeaders(),
      body: payload,
    })
    showForm.value = false
    await loadCases()
  }
  catch (e) {
    // 削除された案件への保存 (404) は押し直しても直らない。読み直してから、一覧へ戻る案内を出す
    const gone = caughtErrorStatus(e) === 404
    const message = describeCaughtError(e, gone
      ? '一覧に戻ってください。admin / payroll は「削除した案件」から復活できます'
      : '「保存」を押してやり直してください')
    if (gone) await loadCases()
    pageError.value = message
  }
  finally {
    saving.value = false
  }
}

const deleting = ref<string | null>(null)

async function deleteCase(entry: LitigationCaseRecord) {
  if (!confirm(`案件「${entry.name}」を削除しますか？削除から ${LITIGATION_CASE_RESTORE_DAYS} 日間は「削除した案件」から復活できます。`)) return
  deleting.value = entry.caseId
  pageError.value = ''
  try {
    await $fetch('/restraint-api/litigation-cases', {
      method: 'DELETE',
      headers: authHeaders(),
      query: { case_id: entry.caseId },
    })
    await loadCases()
  }
  catch (e) {
    pageError.value = describeCaughtError(e, '「削除」を押してやり直してください')
  }
  finally {
    deleting.value = null
  }
}

// --- 案件の詳細 (開いた案件のタブ) ---
// restraint-wage.vue の自前 TABS / activeTab と同じ流儀 (UTabs は使わない)。
const TABS = [
  { key: 'output', label: '出力' },
  { key: 'errors', label: 'エラー' },
  { key: 'changes', label: '変更記録' },
  { key: 'salary', label: '給与比較' },
] as const
type TabKey = typeof TABS[number]['key']
const activeTab = ref<TabKey>('output')

const openCaseId = ref<string | null>(null)
const openCase = computed(() => cases.value.find(c => c.caseId === openCaseId.value) ?? null)

function openCaseDetail(entry: LitigationCaseRecord) {
  openCaseId.value = entry.caseId
  activeTab.value = 'output'
}

function closeCaseDetail() {
  openCaseId.value = null
}

// --- 出力タブ: Y時間 Excel を区切りごとに作って ZIP にまとめる ---
// 1 冊 = 乗務員 1 名 × 最大 12 か月 (litigation-output.ts の doc 参照)。
const outputChunks = computed<LitigationOutputChunk[]>(() =>
  openCase.value ? buildLitigationOutputChunks(openCase.value) : [])

/**
 * このページで「ZIP を作る」を実行した結果 (区切りごと)。添字は `outputChunks` と揃える。
 * **エラータブがこの状態を読む** (Y時間に書けなかった日・冊単位の警告) ので、保存した版から
 * 戻した結果はここへ入れない — `restoredOutput` に分け、出力タブの表示だけがそちらを読む。
 */
const outputResults = ref<(LitigationOutputResult | null)[]>([])
const outputRunning = ref(false)
const outputCurrent = ref(-1)
const outputFinished = ref(false)
const outputZipMessage = ref('')
const outputZipError = ref('')
/** 「ZIP を作る」を押した時点の変更記録の状態 (= ZIP に入れた CSV の要点)。実行前は null */
const outputRunChanges = ref<LitigationOutputChanges | null>(null)

// 版 (relay への保存)。手元への ZIP は「ダウンロード」、relay への版は「保存」と呼び分ける
/** 版の保存の進捗 (ファイルを 1 つずつ上げる) */
const outputSaveProgress = ref<{ done: number, total: number } | null>(null)
const outputSaveMessage = ref('')
/** 版として保存できなかった理由。**ダウンロードの成功の表示とは別に出す** (保存の失敗でダウンロードを失敗に見せない) */
const outputSaveWarning = ref<{ title: string, items: string[] } | null>(null)
const outputVersions = ref<LitigationOutputVersion[]>([])
/** 一覧のうち形が読めなかった版の数 (黙って落とさない) */
const outputVersionsUnreadable = ref(0)
const outputVersionsLoading = ref(false)
/** 版の一覧が 403 (admin / payroll 以外)。エラーにせず 1 行だけ出す — front は役割を知らない */
const outputVersionsForbidden = ref(false)
const outputVersionsError = ref('')
/** 保存した版から戻した結果。出力タブの表示 (区切りの表・ZIP に入るもの・紙面) だけが読む */
const restoredOutput = ref<{ versionId: string, createdAt: string, results: (LitigationOutputResult | null)[], changes: LitigationOutputChanges } | null>(null)
/** 版の結果を表示しなかった理由 */
const outputRestoreNotice = ref('')
const versionBusy = ref<{ versionId: string, action: 'zip' | 'show' } | null>(null)
const versionZipProgress = ref<{ done: number, total: number } | null>(null)
const versionActionError = ref('')

/**
 * 別の案件を開いたら進む世代。走っている「ZIP を作る」・版の保存・一覧の読み込み・版の ZIP は、
 * 世代が変わっていたら画面へ書かない (別の案件の表へ結果を書かない)。
 * エラータブの `errorsEpoch` は検知の実行でも進むので使い回さない。
 */
let outputEpoch = 0
/** 版の一覧の読み込みの通し番号。後から始めた読み込みが在れば、遅れて届いた古い一覧で上書きしない */
let outputVersionsSeq = 0

// 別の案件を開いた・案件を編集して期間/乗務員が変わったら、前の表示は捨てて、その案件の版を読む
watch(() => [openCase.value?.caseId, openCase.value?.updatedAt], () => {
  outputEpoch++
  outputResults.value = []
  outputRunning.value = false
  outputCurrent.value = -1
  outputFinished.value = false
  outputZipMessage.value = ''
  outputZipError.value = ''
  outputRunChanges.value = null
  outputSaveProgress.value = null
  outputSaveMessage.value = ''
  outputSaveWarning.value = null
  outputVersions.value = []
  outputVersionsUnreadable.value = 0
  outputVersionsLoading.value = false
  outputVersionsForbidden.value = false
  outputVersionsError.value = ''
  restoredOutput.value = null
  outputRestoreNotice.value = ''
  versionBusy.value = null
  versionZipProgress.value = null
  versionActionError.value = ''
  if (openCase.value) loadOutputVersions(outputEpoch, openCase.value.caseId, true)
})

/** 出力タブに出す結果: 版から戻した結果を表示中ならそれ、そうでなければこのページで実行した結果 */
const shownOutputResults = computed(() => restoredOutput.value ? restoredOutput.value.results : outputResults.value)
const restoredOutputText = computed(() => restoredOutput.value
  ? `${fmtJstDateTime(restoredOutput.value.createdAt)} に出力して保存した結果を表示しています`
  : '')

const outputDoneCount = computed(() => shownOutputResults.value.filter(r => r !== null).length)
const outputCounts = computed(() =>
  countLitigationResults(shownOutputResults.value.filter((r): r is LitigationOutputResult => r !== null)))

/** ZIP に入るファイルの一覧と中身の要点 (出力タブに出す)。作る前は Excel を「まだ」、作った後は結果で出す。
 * 変更記録は、作った後 (と版の表示中) は ZIP に入れた時点の要点、作る前は今の変更記録タブの状態 */
const zipSummary = computed(() => {
  return buildLitigationZipSummary({
    chunks: outputChunks.value,
    results: shownOutputResults.value,
    changesCsv: {
      filename: LITIGATION_CHANGES_CSV_FILENAME,
      ...(restoredOutput.value?.changes ?? outputRunChanges.value ?? { finished: changesFinished.value, rows: changesRows.value.length }),
    },
  })
})

/** 出力タブの紙面に出す冊単位の警告 (エラータブの `chunkWarnings` は、このページで実行した結果だけを読む) */
const outputChunkWarnings = computed(() => litigationChunkWarnings(outputChunks.value, shownOutputResults.value))

const outputVersionRows = computed(() => outputVersions.value.map(v => ({ v, row: litigationOutputVersionRow(v) })))

const OUTPUT_RETRY = '「ZIP を作る」を押してやり直してください'
const VERSIONS_RETRY = '「履歴を読み直す」を押してやり直してください'
const VERSION_SHOW_RETRY = '「この版の結果を表示」を押してやり直してください'
const VERSION_ZIP_RETRY = '「この版の ZIP をダウンロード」を押してやり直してください'
/** 案件が削除されていたとき (404)。押し直しても直らないので、やり直しの文にしない (保存の 404 と同じ案内) */
const CASE_GONE_HINT = '一覧に戻ってください。admin / payroll は「削除した案件」から復活できます'
const VERSION_ZIP_HINT = '版の一覧から ZIP はダウンロードできます'

/** ZIP に入れる 1 ファイル。`label` が ZIP 内の名前 (日本語可)、`name` は版に保存するときの名前 */
interface OutputFile { name: string, label: string, bytes: ArrayBuffer }

/** ZIP を組む (「ZIP を作る」と「この版の ZIP をダウンロード」で共用)。 */
function zipOutputFiles(files: readonly OutputFile[]): Promise<Blob> {
  const zip = new JSZip()
  for (const f of files) zip.file(f.label, f.bytes)
  return zip.generateAsync({ type: 'blob' })
}

/** 区切り 1 つぶんを作る。失敗は結果に畳んで返す (途中の失敗で全体を止めない)。 */
async function runOutputChunk(chunk: LitigationOutputChunk): Promise<{ result: LitigationOutputResult, bytes?: ArrayBuffer }> {
  try {
    const token = currentAccessToken()
    const res = await fetch('/api/y-time-export', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        driver_cd: chunk.driverCd,
        from: chunk.from,
        to: chunk.to,
        template_key: LITIGATION_TEMPLATE_KEY,
        period_rewrite: true,
      }),
    })
    if (!res.ok) {
      // 404 の出どころ (上流 = 乗務員CD 未登録 / R2 = テンプレ不在) は本文の data で分かる
      const body = await res.clone().json().catch(() => null)
      const reason = await describeResponseFailure(res, OUTPUT_RETRY)
      return { result: litigationResultFromFailure(chunk, res.status, body, reason) }
    }
    const result = litigationResultFromHeaders(chunk, res.headers)
    // 行が 0 件の冊は ZIP に入れない (空の Excel を「働いていない」と読ませない)
    const bytes = result.status === 'ok' ? await res.arrayBuffer() : undefined
    return { result, bytes }
  }
  catch (e) {
    return { result: litigationResultFromFailure(chunk, null, null, describeCaughtError(e, OUTPUT_RETRY)) }
  }
}

/** 「ZIP を作る」1 回ぶんが、押した時点で握るもの。案件を切り替えても、握った案件へ最後まで保存する */
interface OutputRun { caseId: string, comp: string, live: () => boolean }

async function buildOutputZip() {
  const target = openCase.value
  const chunks = outputChunks.value
  if (!target || chunks.length === 0 || outputRunning.value) return
  const epoch = outputEpoch
  const run: OutputRun = { caseId: target.caseId, comp: viewerComp.value, live: () => epoch === outputEpoch }
  // 変更記録は押した時点で握る (実行の最後に読むと、途中で案件を切り替えたときに別の案件の表になる)
  const changes: LitigationOutputChanges = { finished: changesFinished.value, rows: changesRows.value.length }
  const changesCsv = new TextEncoder().encode(changesCsvText()).buffer as ArrayBuffer
  outputRunning.value = true
  outputFinished.value = false
  outputZipMessage.value = ''
  outputZipError.value = ''
  outputSaveProgress.value = null
  outputSaveMessage.value = ''
  outputSaveWarning.value = null
  outputRunChanges.value = changes
  // 新しい実行の結果を出す (版から戻した表示はやめる)
  restoredOutput.value = null
  outputRestoreNotice.value = ''
  outputResults.value = chunks.map(() => null)
  const results: (LitigationOutputResult | null)[] = chunks.map(() => null)
  const files: OutputFile[] = []
  let downloaded = false
  try {
    // 上流 (alc) は乗務員 1 名・期間 1 本しか受けないので、区切りごとに 1 回ずつ直列に呼ぶ
    for (const [i, chunk] of chunks.entries()) {
      if (run.live()) outputCurrent.value = i
      const { result, bytes } = await runOutputChunk(chunk)
      results[i] = result
      if (run.live()) outputResults.value[i] = result
      if (bytes) files.push({ name: chunk.filename, label: chunk.filename, bytes })
    }
    const excelCount = files.length
    // 変更記録 (変更記録タブで「検知を実行」していなければ、その旨を備考に書いた空表になる)
    files.push({ name: LITIGATION_OUTPUT_CHANGES_STORAGE_NAME, label: LITIGATION_CHANGES_CSV_FILENAME, bytes: changesCsv })
    const blob = await zipOutputFiles(files)
    const zipName = litigationZipFilename(target.name, new Date())
    downloadBlob(blob, zipName)
    downloaded = true
    if (run.live()) {
      if (excelCount === 0) {
        // Excel が無くても CSV は成果物なのでダウンロードはする。ただし成功の見た目にしない
        outputZipError.value = `Excel が 1 冊もできませんでした (下の表の理由を見てください)。${zipName} には ${LITIGATION_CHANGES_CSV_FILENAME} だけを入れてダウンロードしました`
      }
      else {
        outputZipMessage.value = `${zipName} をダウンロードしました (Excel ${excelCount} / ${chunks.length} 冊 + ${LITIGATION_CHANGES_CSV_FILENAME})`
      }
    }
  }
  catch (e) {
    if (run.live()) outputZipError.value = `ZIP を組めませんでした: ${describeCaughtError(e, OUTPUT_RETRY)}`
  }
  if (run.live()) {
    outputCurrent.value = -1
    outputFinished.value = true
  }
  // ダウンロードできたら、同じファイルと結果を版として保存する (保存の失敗でダウンロードの成功を取り消さない)
  if (downloaded) await saveOutputVersion(run, buildLitigationOutputSnapshot(chunks, results, changes), files)
  if (run.live()) outputRunning.value = false
}

/**
 * 版を作り (`POST`)、ファイルを 1 つずつ直列で上げる (`PUT`)。**例外を投げない** — 失敗は
 * 警告として出力タブに出す。途中でやめると半端な版が残るので、案件を切り替えても最後まで上げる。
 */
async function saveOutputVersion(run: OutputRun, snapshot: LitigationOutputSnapshot, files: readonly OutputFile[]) {
  const chars = litigationOutputSnapshotChars(snapshot)
  if (chars > LITIGATION_OUTPUT_RESULTS_MAX_CHARS) {
    if (run.live()) {
      outputSaveWarning.value = {
        title: `結果が大きすぎるため、版として保存しませんでした (${chars.toLocaleString()} 文字、上限 ${LITIGATION_OUTPUT_RESULTS_MAX_CHARS.toLocaleString()} 文字)。ZIP のダウンロードは済んでいます`,
        items: [],
      }
    }
    return
  }
  let versionId: string
  let createdAt: string
  try {
    const res = await $fetch<{ versionId?: unknown, createdAt?: unknown }>('/restraint-api/litigation-outputs', {
      method: 'POST',
      headers: authHeaders(run.comp),
      body: { caseId: run.caseId, results: snapshot },
    })
    if (typeof res?.versionId !== 'string' || typeof res.createdAt !== 'string') throw new Error('版を作った応答の形が想定外')
    versionId = res.versionId
    createdAt = res.createdAt
  }
  catch (e) {
    if (!run.live()) return
    // 途中で案件が削除された (404) は押し直しても直らない。読み直すと案件の詳細が閉じるので、文は一覧の上に出す
    const gone = caughtErrorStatus(e) === 404
    const message = `版として保存できませんでした (ZIP のダウンロードは済んでいます): ${describeCaughtError(e, gone ? CASE_GONE_HINT : OUTPUT_RETRY)}`
    if (gone) {
      await loadCases()
      pageError.value = message
    }
    else {
      outputSaveWarning.value = { title: message, items: [] }
    }
    return
  }
  const failed: string[] = []
  if (run.live()) outputSaveProgress.value = { done: 0, total: files.length }
  // 1 通信 1 ファイル。直列に上げる (同じ版へ同時に書かない)
  for (const [i, f] of files.entries()) {
    try {
      const query = new URLSearchParams({ case_id: run.caseId, version_id: versionId, name: f.name, label: f.label })
      // ofetch は応答が JSON でないとエラーの本文を隠すことがあるので、バイト列の口は生の fetch で理由を読む
      const res = await fetch(`/restraint-api/litigation-outputs/file?${query}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', ...authHeaders(run.comp) },
        body: f.bytes,
      })
      if (!res.ok) failed.push(`${f.label} — ${await describeResponseFailure(res, OUTPUT_RETRY)}`)
    }
    catch (e) {
      failed.push(`${f.label} — ${describeCaughtError(e, OUTPUT_RETRY)}`)
    }
    if (run.live()) outputSaveProgress.value = { done: i + 1, total: files.length }
  }
  if (!run.live()) {
    // 表示は切替先のもの。同じ案件を開き直していれば、一覧だけ読み直す
    if (openCase.value?.caseId === run.caseId && viewerComp.value === run.comp) await loadOutputVersions(outputEpoch, run.caseId, false)
    return
  }
  outputSaveProgress.value = null
  if (failed.length > 0) {
    outputSaveWarning.value = {
      title: `版として保存できなかったファイルが ${failed.length} / ${files.length} 個あります (ZIP のダウンロードは済んでいます)`,
      items: failed,
    }
  }
  else {
    outputSaveMessage.value = `${fmtJstDateTime(createdAt)} の版として保存しました (ファイル ${files.length} 個)`
  }
  await loadOutputVersions(outputEpoch, run.caseId, false)
}

/**
 * 版の一覧を読む。`restoreLatest` (案件を開いたとき) は、最新の版の結果も表示へ戻す。
 * 403 (admin / payroll 以外) はエラーにしない。
 */
async function loadOutputVersions(epoch: number, caseId: string, restoreLatest: boolean) {
  const seq = ++outputVersionsSeq
  const current = () => epoch === outputEpoch && seq === outputVersionsSeq
  outputVersionsLoading.value = true
  try {
    const res = await $fetch<unknown>('/restraint-api/litigation-outputs', {
      headers: authHeaders(),
      query: { case_id: caseId },
    })
    if (epoch !== outputEpoch) return
    const parsed = parseLitigationOutputVersions(res)
    if (current()) {
      outputVersions.value = parsed?.versions ?? []
      outputVersionsUnreadable.value = parsed?.unreadable ?? 0
      outputVersionsForbidden.value = false
      outputVersionsError.value = parsed ? '' : '版の一覧を読めませんでした: 応答の形が想定外'
    }
    const latest = parsed?.versions[0]
    if (restoreLatest && latest) await showVersionResults(epoch, caseId, latest, true)
  }
  catch (e) {
    if (!current()) return
    if (caughtErrorStatus(e) === 403) outputVersionsForbidden.value = true
    else outputVersionsError.value = `版の一覧を読めませんでした: ${describeCaughtError(e, VERSIONS_RETRY)}`
  }
  finally {
    if (current()) outputVersionsLoading.value = false
  }
}

function reloadOutputVersions() {
  if (openCase.value) loadOutputVersions(outputEpoch, openCase.value.caseId, false)
}

/**
 * 版 1 件の結果を読み、出力タブの表示へ戻す (`outputResults` には入れない)。
 * 戻すのは、保存した区切りが今の案件の区切りと完全に一致するときだけ。
 * `auto` (案件を開いたときの読み戻し) は、応答より先に「ZIP を作る」が押されていたら捨てる。
 */
async function showVersionResults(epoch: number, caseId: string, v: LitigationOutputVersion, auto: boolean) {
  try {
    const res = await $fetch<{ version?: { results?: unknown } }>('/restraint-api/litigation-outputs', {
      headers: authHeaders(),
      query: { case_id: caseId, version_id: v.versionId },
    })
    if (epoch !== outputEpoch) return
    if (auto && outputResults.value.length > 0) return
    const snapshot = parseLitigationOutputSnapshot(res?.version?.results)
    if (!snapshot || !litigationSnapshotMatchesChunks(snapshot, outputChunks.value)) {
      restoredOutput.value = null
      outputRestoreNotice.value = snapshot
        ? `案件の期間・乗務員を変えたため、保存した結果は表示していません (${VERSION_ZIP_HINT})`
        : `${fmtJstDateTime(v.createdAt)} の版は、結果が読めない形で保存されているため表示していません (${VERSION_ZIP_HINT})`
      return
    }
    restoredOutput.value = { versionId: v.versionId, createdAt: v.createdAt, results: snapshot.results, changes: snapshot.changes }
    outputRestoreNotice.value = ''
  }
  catch (e) {
    if (epoch === outputEpoch) versionActionError.value = `保存した結果を読めませんでした: ${describeCaughtError(e, VERSION_SHOW_RETRY)}`
  }
}

async function showVersion(v: LitigationOutputVersion) {
  const target = openCase.value
  if (!target || versionBusy.value) return
  const epoch = outputEpoch
  versionBusy.value = { versionId: v.versionId, action: 'show' }
  versionActionError.value = ''
  await showVersionResults(epoch, target.caseId, v, false)
  if (epoch === outputEpoch) versionBusy.value = null
}

/** 版から戻した表示をやめ、このページで「ZIP を作る」を実行した結果に戻す */
function showRunResults() {
  restoredOutput.value = null
  outputRestoreNotice.value = ''
}

/** 版のファイルを 1 つずつ取って ZIP に組み、ダウンロードする。1 つでも取れなければ ZIP は作らない (欠けた ZIP をその版として渡さない)。 */
async function downloadVersionZip(v: LitigationOutputVersion) {
  const target = openCase.value
  if (!target || versionBusy.value) return
  const epoch = outputEpoch
  const live = () => epoch === outputEpoch
  const comp = viewerComp.value
  versionBusy.value = { versionId: v.versionId, action: 'zip' }
  versionActionError.value = ''
  versionZipProgress.value = { done: 0, total: v.files.length }
  const files: OutputFile[] = []
  let failure = ''
  try {
    for (const [i, f] of v.files.entries()) {
      try {
        const query = new URLSearchParams({ case_id: target.caseId, version_id: v.versionId, name: f.name })
        const res = await fetch(`/restraint-api/litigation-outputs/file?${query}`, { headers: authHeaders(comp) })
        if (!res.ok) {
          failure = `${f.label} — ${await describeResponseFailure(res, VERSION_ZIP_RETRY)}`
          break
        }
        files.push({ name: f.name, label: f.label, bytes: await res.arrayBuffer() })
      }
      catch (e) {
        failure = `${f.label} — ${describeCaughtError(e, VERSION_ZIP_RETRY)}`
        break
      }
      if (live()) versionZipProgress.value = { done: i + 1, total: v.files.length }
    }
    if (failure) {
      if (live()) versionActionError.value = `この版の ZIP を作れませんでした (取れなかったファイル): ${failure}`
      return
    }
    downloadBlob(await zipOutputFiles(files), litigationZipFilename(target.name, new Date(v.createdAt)))
  }
  catch (e) {
    if (live()) versionActionError.value = `ZIP を組めませんでした: ${describeCaughtError(e, VERSION_ZIP_RETRY)}`
  }
  finally {
    if (live()) {
      versionBusy.value = null
      versionZipProgress.value = null
    }
  }
}

// --- エラータブ: 乗務員 × 月ごとに 4 つの検知を並べる (litigation-errors.ts の doc 参照) ---
const caseMonths = computed<string[]>(() =>
  openCase.value ? monthRange(openCase.value.fromMonth, openCase.value.toMonth, LITIGATION_CASE_MAX_MONTHS) : [])

/** キー `乗務員CD|YYYY-MM` */
const errAlcOps = ref(new Map<string, LitigationAlcOpsEntry>())
/** キー `乗務員CD|YYYY-MM` */
const errUnkoGaps = ref(new Map<string, LitigationFetched<LitigationDtakoOps>>())
/** キー `乗務員CD|YYYY-MM` (会社全体を 1 回で読み、乗務員ごとに切り出す) */
const errWageReports = ref(new Map<string, LitigationFetched<WageReportResponse>>())
/** 保存時刻 (キー `種類|乗務員CD|YYYY-MM`)。relay の D1 に残した結果を開き直したときに出す */
const errCheckedAt = ref(new Map<string, string>())
const errorsStoreLoading = ref(false)
const errorsStoreError = ref('')

/** 冊ごとの「月ごとの時間」。給与比較タブと同じ保存済みの wage report から作る (「ZIP を作る」の結果にも、
 * 保存した版の表示にも依らない。画面と紙面で共用) */
const hoursBooks = computed(() => buildLitigationHoursBooks(outputChunks.value, errWageReports.value, errCheckedAt.value))
/** 紙面には、値の在る月が 1 つでも在る冊だけ出す (全部「未取得」の表を刷らない) */
const printHoursBooks = computed(() => hoursBooks.value.filter(b => b.valueMonths > 0))
/** 保存済みの wage report を読み込み中・読めなかったときは、全月を「未取得」に見せずその状態を言う。
 * 保存の失敗 (読めた値は手元に在る) では表を出す */
const hoursNotice = computed(() => {
  if (errorsStoreLoading.value) return '保存済みの結果を読み込み中…'
  return errorsStoreError.value && errWageReports.value.size === 0 ? errorsStoreError.value : ''
})

const errorsRunning = ref(false)
const errorsFinished = ref(false)
const errorsProgress = ref<{ done: number, total: number, label: string } | null>(null)
const errorsOnlyAttention = ref(false)
/** 別の案件を開いたら、走行中の検知の書き込みを捨てる世代 */
let errorsEpoch = 0

watch(() => [openCase.value?.caseId, openCase.value?.updatedAt], () => {
  errorsEpoch++
  errAlcOps.value = new Map()
  errUnkoGaps.value = new Map()
  errWageReports.value = new Map()
  errCheckedAt.value = new Map()
  errorsStoreError.value = ''
  errorsRunning.value = false
  errorsFinished.value = false
  errorsProgress.value = null
  importResults.value = new Map()
  if (openCase.value) loadStoredChecks(errorsEpoch, openCase.value.caseId)
})

/** 保存済みの検知結果を読む (開き直したら前回の結果を出す)。読めなくても検知は回せる。 */
async function loadStoredChecks(epoch: number, caseId: string) {
  errorsStoreLoading.value = true
  try {
    const res = await $fetch<unknown>('/restraint-api/litigation-checks', {
      headers: authHeaders(),
      query: { case_id: caseId },
    })
    if (epoch !== errorsEpoch) return
    const restored = restoreLitigationChecks(res)
    errAlcOps.value = restored.alcOps
    errUnkoGaps.value = restored.unkoGaps
    errWageReports.value = restored.wageReports
    errCheckedAt.value = restored.checkedAt
  }
  catch (e) {
    if (epoch === errorsEpoch) errorsStoreError.value = `保存済みの検知結果を読めませんでした: ${describeCaughtError(e, '画面を再読み込みしてください')}`
  }
  finally {
    if (epoch === errorsEpoch) errorsStoreLoading.value = false
  }
}

/** 取れた結果を 1 ステップぶん保存する。**保存に失敗しても検知は止めない** (画面には出す)。 */
async function saveChecks(epoch: number, items: LitigationStoredItem[]) {
  const caseId = openCase.value?.caseId
  if (!caseId || epoch !== errorsEpoch) return
  try {
    const res = await $fetch<{ checkedAt?: unknown }>('/restraint-api/litigation-checks', {
      method: 'PUT',
      headers: authHeaders(),
      body: { caseId, items },
    })
    if (epoch !== errorsEpoch) return
    const at = typeof res?.checkedAt === 'string' ? res.checkedAt : new Date().toISOString()
    for (const it of items) errCheckedAt.value.set(litigationCheckedAtKey(it.kind, it.key), at)
  }
  catch (e) {
    if (epoch === errorsEpoch) errorsStoreError.value = `検知結果を保存できませんでした (開き直すとこの分は未実行に戻ります): ${describeCaughtError(e, '「続きから」でやり直してください')}`
  }
}

const errorRows = computed<LitigationErrorRow[]>(() => buildLitigationErrorRows({
  driverCds: openCase.value?.driverCds ?? [],
  months: caseMonths.value,
  chunks: outputChunks.value,
  results: outputResults.value,
  alcOps: errAlcOps.value,
  unkoGaps: errUnkoGaps.value,
  wageReports: errWageReports.value,
}))
const errorCounts = computed(() => countLitigationErrorCells(errorRows.value))
const chunkWarnings = computed(() => litigationChunkWarnings(outputChunks.value, outputResults.value))
const shownErrorRows = computed(() => errorsOnlyAttention.value
  ? errorRows.value.filter(litigationRowNeedsAttention)
  : errorRows.value)

const ERRORS_RETRY = '「検知を実行」を押してやり直してください'

/** 区切り 1 つぶんの Y時間 (JSON) を読み、月ごとの勤務日数に畳む。失敗は各月へ配る。 */
async function loadAlcOps(epoch: number, driverCd: string, from: string, to: string, months: string[]) {
  let entries: [string, LitigationAlcOpsEntry][]
  try {
    const res = await getYTimePreview(driverCd, from, to)
    const days = foldYTimeDaysByMonth(res.rows, months)
    const dropped = foldYTimeDroppedByMonth(res.warnings, months)
    entries = months.map(m => [m, { ok: true, days: days[m]!, dropped: dropped[m]! }])
  }
  catch (e) {
    const entry = litigationAlcOpsFailure(caughtErrorStatus(e), describeCaughtError(e, ERRORS_RETRY))
    entries = months.map(m => [m, entry])
  }
  if (epoch !== errorsEpoch) return
  for (const [m, entry] of entries) errAlcOps.value.set(litigationDriverMonthKey(driverCd, m), entry)
  await saveChecks(epoch, entries.map(([m, entry]) => ({ kind: 'alcOps', key: litigationDriverMonthKey(driverCd, m), payload: entry })))
}

/** alc の運行 (読取日で運行を始めた月〜翌月末を引く)。ページを回し切る (1 ページ最大 200 件)。 */
async function fetchAlcUnkoNos(driverCd: string, month: string): Promise<string[]> {
  const { from, to } = litigationAlcReadingRange(month)
  const out: string[] = []
  // 安全弁: 応答の total が壊れていても回り続けない (200 件 × 20 = 4,000 件。1 乗務員 2 か月の実数を大きく超える)
  for (let page = 1; page <= 20; page++) {
    const res = await getOperations({ driver_cd: driverCd, date_from: from, date_to: to, page, per_page: 200 })
    out.push(...res.operations.map(o => o.unko_no))
    if (res.operations.length === 0 || page * res.per_page >= res.total) break
  }
  return out
}

/** alc にあってオンプレのデジタコに無い運行。alc とオンプレ `dtako_rows` の運行を、運行を始めた月・先頭 22 桁で突き合わせる。 */
async function loadUnkoGaps(epoch: number, driverCd: string, month: string) {
  let entry: LitigationFetched<LitigationDtakoOps>
  try {
    const [alcUnkoNos, onprem] = await Promise.all([
      fetchAlcUnkoNos(driverCd, month),
      $fetch<{ ope_nos?: unknown, truncated?: unknown }>('/restraint-api/kintai/onprem-month-operations', {
        headers: authHeaders(),
        query: { month, driver_cd: driverCd },
      }),
    ])
    const onpremOpeNos = Array.isArray(onprem?.ope_nos) ? onprem.ope_nos.filter((u): u is string => typeof u === 'string') : []
    entry = {
      ok: true,
      value: { alc: opeNosStartedInMonth(alcUnkoNos, month), onprem: onpremOpeNos, onpremTruncated: onprem?.truncated === true },
    }
  }
  catch (e) {
    entry = { ok: false, reason: describeCaughtError(e, ERRORS_RETRY) }
  }
  if (epoch !== errorsEpoch) return
  const key = litigationDriverMonthKey(driverCd, month)
  errUnkoGaps.value.set(key, entry)
  await saveChecks(epoch, [{ kind: 'unkoGaps', key, payload: entry }])
}

/** 最低賃金の不変条件は GCP の拘束で計算した wage-report にだけ付く (Refs #1123)。
 * **読むだけ** — wage-snapshot (最低賃金チェックの自動保存) は呼ばない。 */
async function loadWageReport(epoch: number, month: string, driverCds: readonly string[]) {
  let entry: LitigationFetched<WageReportResponse>
  try {
    const res = await $fetch<WageReportResponse>('/restraint-api/wage-report', {
      headers: authHeaders(),
      query: { month, source: 'gcp' },
    })
    entry = { ok: true, value: res }
  }
  catch (e) {
    entry = { ok: false, reason: describeCaughtError(e, ERRORS_RETRY) }
  }
  if (epoch !== errorsEpoch) return
  const items: LitigationStoredItem[] = driverCds.map((cd) => {
    const key = litigationDriverMonthKey(cd, month)
    const cut = reduceWageReportForDriver(entry, cd)
    errWageReports.value.set(key, cut)
    return { kind: 'wageReport', key, payload: cut }
  })
  await saveChecks(epoch, items)
}

interface ErrorCheckStep { label: string, run: (epoch: number) => Promise<void> }

/**
 * 検知のステップ。`onlyMissing` (続きから) なら、まだ取っていない・取りに行って失敗した
 * 結果 (`litigationNeedsFetch`) を含むステップだけにする。軽いものから並べ、最後に
 * wage-report を月ごとに読む。
 */
function buildErrorSteps(onlyMissing: boolean): ErrorCheckStep[] {
  const target = openCase.value
  if (!target) return []
  const months = caseMonths.value
  const need = (entry: { ok: boolean } | undefined) => !onlyMissing || litigationNeedsFetch(entry)
  const key = litigationDriverMonthKey
  return [
    ...outputChunks.value
      .filter(c => litigationChunkMonths(c).some(m => need(errAlcOps.value.get(key(c.driverCd, m)))))
      .map(c => ({
        label: `alc の運行 ${c.driverCd} ${c.label}`,
        run: (epoch: number) => loadAlcOps(epoch, c.driverCd, c.from, c.to, litigationChunkMonths(c)),
      })),
    ...target.driverCds.flatMap(cd => months
      .filter(m => need(errUnkoGaps.value.get(key(cd, m))))
      .map(m => ({
        label: `オンプレのデジタコとの突き合わせ ${cd} ${m}`,
        run: (epoch: number) => loadUnkoGaps(epoch, cd, m),
      }))),
    ...months
      .filter(m => target.driverCds.some(cd => need(errWageReports.value.get(key(cd, m)))))
      .map(m => wageReportStep(m, target.driverCds)),
  ]
}

function wageReportStep(m: string, driverCds: readonly string[]): ErrorCheckStep {
  return {
    label: `最低賃金の不変条件 ${m} (1 か月 15〜64 秒)`,
    run: (epoch: number) => loadWageReport(epoch, m, driverCds),
  }
}

/** 保存時刻の表示 (JST の「M/D HH:mm」) */
function fmtCheckedAt(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 「続きから」で回すステップ数 (ボタンに出す) */
const missingErrorSteps = computed(() => buildErrorSteps(true).length)

/** 検知のステップを**直列に**回す (wage-report は 1 か月 15〜64 秒かかり、同じ DO を奪い合わせない)。
 * 取れたステップから保存するので、途中で止めても「続きから」で残りだけ回せる。
 * 全部やり直すときも前回の結果は消さず、取れた順に上書きする (止めても前回分が残る)。 */
async function runErrorSteps(steps: ErrorCheckStep[]) {
  if (!openCase.value || errorsRunning.value || errorsStoreLoading.value) return
  const epoch = ++errorsEpoch
  errorsStoreError.value = ''
  errorsRunning.value = true
  errorsFinished.value = false
  errorsProgress.value = { done: 0, total: steps.length, label: '' }
  try {
    for (const [i, step] of steps.entries()) {
      if (epoch !== errorsEpoch) return
      errorsProgress.value = { done: i, total: steps.length, label: step.label }
      await step.run(epoch)
    }
    if (epoch === errorsEpoch) errorsProgress.value = { done: steps.length, total: steps.length, label: '' }
  }
  finally {
    if (epoch === errorsEpoch) {
      errorsRunning.value = false
      errorsFinished.value = true
    }
  }
}

const runErrorChecks = (onlyMissing: boolean) => runErrorSteps(buildErrorSteps(onlyMissing))

// --- 取り込みボタン (alc に運行が 0 件の月): theearth から乗務員 × 期間で取り込み直す ---
/** 走行中の行 (キー `乗務員CD|YYYY-MM`)。**同時に 1 行だけ** (theearth のセッションロック) */
const importingKey = ref<string | null>(null)
/** 行ごとの取り込み結果 (期間 1 本 = 1 件) */
const importResults = ref(new Map<string, { from: string, to: string, outcome: LitigationImportOutcome }[]>())
const IMPORT_RETRY = '「theearth から取り込む」を押してやり直してください'

async function postImport(driverCd: string, range: { from: string, to: string }): Promise<LitigationImportOutcome> {
  try {
    const res = await fetch('/restraint-api/litigation/alc-upload-driver', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ driver_cd: driverCd, from: range.from, to: range.to }),
    })
    const body = await res.clone().json().catch(() => null)
    const reason = res.ok ? '' : await describeResponseFailure(res, IMPORT_RETRY)
    return classifyLitigationImport(res.status, body, reason)
  }
  catch (e) {
    return classifyLitigationImport(null, null, describeCaughtError(e, IMPORT_RETRY))
  }
}

/**
 * 運行月とその翌月 (読取日) を **1 か月ずつ直列に** 取り込む (relay の期間上限 31 日、
 * theearth のセッションロック)。1 本でも取り込めたら、その行の alc の運行と「オンプレのデジタコに無い運行」を
 * 読み直す。**取り込み直後は CSV 分割が終わるまで運行が見えないことがある**ので、0 件のまま
 * でも取り込みが失敗したとは限らない (画面の注記で伝える)。
 */
async function importMonth(row: LitigationErrorRow) {
  if (importingKey.value) return
  const key = litigationDriverMonthKey(row.driverCd, row.month)
  const epoch = errorsEpoch
  importingKey.value = key
  const done: { from: string, to: string, outcome: LitigationImportOutcome }[] = []
  importResults.value.set(key, [])
  try {
    for (const range of litigationImportRanges(row.month)) {
      const outcome = await postImport(row.driverCd, range)
      done.push({ ...range, outcome })
      importResults.value.set(key, [...done])
      // 権限が無いなら翌月も同じ答えなので呼ばない
      if (outcome.kind === 'forbidden') break
    }
    if (done.some(d => d.outcome.kind === 'ok')) {
      const { from, to } = litigationMonthBounds(row.month)
      await loadAlcOps(epoch, row.driverCd, from, to, [row.month])
      await loadUnkoGaps(epoch, row.driverCd, row.month)
    }
  }
  finally {
    importingKey.value = null
  }
}

// --- 給与比較タブ: 給与大臣の明細 × エラータブの wage-report (litigation-salary.ts の doc 参照) ---
/** キー 支給月 `YYYY-MM` → 全会社ぶんの明細。**メモリだけに持つ** (金額・氏名をブラウザに残さない) */
const salaryPayroll = ref(new Map<string, LitigationFetched<SalaryCsvRow[]>>())
/** キー 支給月 → 明細の出どころ (全会社を畳んだもの。fmtPayrollSync で表示) */
const salaryPayrollSync = ref(new Map<string, ReturnType<typeof foldPayrollSync>>())
const salaryConfig = ref<SalaryItemConfig>({ items: {} })
const salaryCdMap = ref<SalaryCdMap>({ entries: {} })
/** 社員マスタの全件 (登録候補から既に在る (会社, 給与コード) を外すため) */
const salaryEmployees = ref<EmployeeMasterEntry[]>([])
const salaryLoading = ref(false)
const salaryProgress = ref('')
const salaryLoadingPayMonth = ref<string | ReadonlySet<string> | null>(null)
const salaryError = ref('')
const salaryRegistering = ref(false)
const salaryRegisterMessage = ref('')
/** 属性 (給与区分) を入れた後、拘束の材料をまだ取り直していない */
const salaryAttrsWritten = ref(false)
let salaryEpoch = 0
const SALARY_RETRY = '「給与大臣から読み直す」を押してやり直してください'
/** 保存済みの明細を同時に読む本数。保存済みは通常、上流が給与大臣を開かず保存から返すので軽い。
 * 保存が無い月は給与大臣 (OHKEN) を開く (接続は 2 本しかない) ので直列 — 理由は ichiban-health.vue の同じ注記。 */
const SALARY_PAYROLL_CONCURRENCY = 6

watch(() => [openCase.value?.caseId, openCase.value?.updatedAt, viewerComp.value], () => {
  salaryEpoch++
  salaryAttrsWritten.value = false
  salaryPayroll.value = new Map()
  salaryPayrollSync.value = new Map()
  salaryLoading.value = false
  salaryLoadingPayMonth.value = null
  salaryProgress.value = ''
  salaryError.value = ''
  salaryRegisterMessage.value = ''
})

// 給与比較タブを開いたら明細を自動で読む。案件切替の watch (上) が salaryPayroll を空にした後に走らせる
// (宣言順)。失敗 (salaryError) の後は自動で再試行しない — ボタンで読み直す
watch(() => [activeTab.value, openCase.value?.caseId, openCase.value?.updatedAt, viewerComp.value], () => {
  if (activeTab.value === 'salary' && openCase.value && salaryPayroll.value.size === 0
    && !salaryLoading.value && caseMonths.value.length > 0 && !salaryError.value) {
    loadSalaryPayroll()
  }
})

const salaryRows = computed(() => buildLitigationSalaryRows({
  driverCds: openCase.value?.driverCds ?? [],
  months: caseMonths.value,
  wageReports: errWageReports.value,
  payroll: salaryPayroll.value,
  config: salaryConfig.value,
  cdMap: salaryCdMap.value,
  loadingPayMonth: salaryLoadingPayMonth.value,
}))
const salaryPayrollLoaded = computed(() =>
  caseMonths.value.filter(m => salaryPayroll.value.get(nextYm(m))?.ok).length)
/** 明細の出どころの内訳 (読めた月だけ。source が判らない月はどちらにも数えない) */
const salarySourceCounts = computed(() => {
  let cache = 0
  let live = 0
  for (const m of caseMonths.value) {
    const s = salaryPayrollSync.value.get(nextYm(m))?.source
    if (s === 'cache') cache++
    else if (s === 'live') live++
  }
  return { cache, live }
})
const salaryNeedsMaterials = computed(() => salaryRows.value.some(r => r.message.startsWith('拘束の材料が')))
// 労基法37条 (基礎単価 × 割増) の理論値を、明細の残業代が下回った行の数 (差が負の行)
const salaryShortfall37Count = computed(() =>
  salaryRows.value.filter(r => (r.compared?.diffCsvVsBaseRateOvertime ?? 0) < 0).length)
// 37条の逆算の基礎単価 (÷ wage report の法定時間内) が最低賃金を下回り、最低賃金で計算した行 (0 件でも出す)
const salaryFloored37Count = computed(() =>
  salaryRows.value.filter(r => r.compared?.baseRateBasis.floored).length)
// 保存済みの wage report の行に休日の金額の欄が無い行 (古い保存)。残業・深夜・休日の計算を出さず、取り直しを促す
const salaryOutdatedCount = computed(() => salaryRows.value.filter(r => r.compared?.wageRowOutdated).length)
// 明細の基本給が 単価マスタ × 法定内時間 (wage report の金額) を下回る行 — エラー (0 件でも出す)。比べられない行は数えない
const salaryBaseBelowMinWageCount = computed(() =>
  salaryRows.value.filter(r => (r.compared?.diffBase ?? 0) < 0).length)
// 比較済みの行のうち、単価マスタに単価が無く基本給を比べられない行
const salaryBaseMinWageUnknownCount = computed(() =>
  salaryRows.value.filter(r => r.compared && r.compared.diffBase === null).length)
// 計算に使った単価が、その月の最低賃金と違う行 (上下どちらも) / 判定できない行 (Refs #1133)
const salaryRateBasisCounts = computed(() => {
  let mismatch = 0
  let unknown = 0
  for (const r of salaryRows.value) {
    if (!r.compared) continue
    const { status } = rateBasisStatus(r.compared.rateBasis)
    if (status === 'mismatch') mismatch++
    else if (status === 'unknown') unknown++
  }
  return { mismatch, unknown }
})
const salaryRatePeriods = computed(() => rateBasisPeriods(salaryRows.value))
// 「判定できない」月の直し方パネル (MinWageFixesPanel) の材料。比較できた行の単価・最低賃金だけ
const salaryFixRows = computed<MinWageFixInput[]>(() => salaryRows.value.flatMap(r => r.compared
  ? [{ driverCd: r.driverCd, month: r.month, hourlyRate: r.compared.rateBasis.hourlyRate, minWageRate: r.compared.rateBasis.minWageRate, minWagePrefecture: r.compared.rateBasis.minWagePrefecture }]
  : []))
const RATE_BASIS_CLASS: Record<RateBasisStatus, string> = {
  ok: '',
  mismatch: 'font-bold text-red-600 dark:text-red-400',
  unknown: 'text-gray-500',
}
const salaryCounts = computed(() => {
  const c: Record<LitigationSalaryState, number> = { ok: 0, pending: 0, unknown: 0, noPayroll: 0 }
  for (const r of salaryRows.value) c[r.state]++
  return c
})

/**
 * 給与大臣から、案件の月ぶんの明細を読む。`GET /api/kyuyo/payroll` は**読み通し** — 保存済みの月は
 * 給与大臣を開かずに返り、保存が無い月だけ給与大臣 (OHKEN) から読んで保存する (1 社 10〜20 秒)。
 * 会社は閲覧中の dtako 会社に対応する給与大臣の会社 (`comp-map`)、乗務員への引き当ては社員マスタ、
 * 支給項目の区分は拘束×賃金で保存した設定をそのまま使う。保存済みの (会社, 月) は同時 6 本まで並列、保存が無い月は最後に 1 本ずつ直列に呼ぶ。
 */
async function loadSalaryPayroll() {
  if (!openCase.value || salaryLoading.value) return
  const epoch = ++salaryEpoch
  salaryLoading.value = true
  salaryError.value = ''
  salaryProgress.value = '会社対応表・社員マスタ・支給項目の区分を読んでいます…'
  try {
    const [compMapRaw, employees, config] = await Promise.all([
      $fetch<unknown>('/restraint-api/comp-map', { headers: authHeaders() }),
      $fetch<EmployeeMasterGetResponse>('/restraint-api/employee-master', { headers: authHeaders() }),
      $fetch<{ data: SalaryItemConfig | null }>('/restraint-api/salary-item-config', { headers: authHeaders() }),
    ])
    if (epoch !== salaryEpoch) return
    salaryEmployees.value = employees.employees ?? []
    salaryCdMap.value = buildCdMapEntries(salaryEmployees.value)
    salaryConfig.value = config.data ?? { items: {} }
    const companies = (parseCompMap(compMapRaw).find(c => c.compId === viewerComp.value)?.payrollCompanies ?? [])
      .map(c => c.payrollCompany)
    if (companies.length === 0) {
      salaryError.value = 'この会社に対応する給与大臣の会社がありません (会社対応表)'
      return
    }
    const months = litigationPayrollMonths(caseMonths.value)
    const tasks: PayrollTarget[] = months.flatMap(m => companies.map(company => ({ company, ...m })))
    // 保存済みの (会社, 勤務月)。読めなければ空 = 全部 live = 従来どおりの直列 (保存済みかどうかが判らないだけ)
    let synced: ReadonlySet<string> = new Set()
    try {
      const res = await $fetch<{ entries?: unknown }>('/api/kyuyo/synced-months')
      synced = new Set(summarizeSyncedMonths(res?.entries).map(r => `${r.company}|${r.month}`))
    }
    catch { /* 直列に読む */ }
    if (epoch !== salaryEpoch) return
    const { cached, live } = splitPayrollTargets(tasks, synced)

    // 支給月 → 会社 → 結果。全会社ぶん揃ったら salaryPayroll に入れる (会社の順は結果に影響しない)
    type Outcome = { rows: SalaryCsvRow[], sync: { source?: 'cache' | 'live', syncedAt?: string | null } } | { failure: string }
    const outcomes = new Map<string, Map<string, Outcome>>()
    const pendingCached = new Set(cached.map(t => t.payMonth))
    const showLoading = (current?: string) => {
      salaryLoadingPayMonth.value = new Set(current ? [...pendingCached, current] : pendingCached)
    }
    const finalize = (payMonth: string) => {
      const rows: SalaryCsvRow[] = []
      const syncs: { source?: 'cache' | 'live', syncedAt?: string | null }[] = []
      let failure: string | null = null
      for (const company of companies) {
        const o = outcomes.get(payMonth)!.get(company)!
        if ('failure' in o) failure = o.failure
        else {
          rows.push(...o.rows)
          syncs.push(o.sync)
        }
      }
      // 1 社でも読めなかったら、その月は「読めない」にする (半分だけで比べると明細に居ないと誤読する)
      salaryPayroll.value.set(payMonth, failure ? { ok: false, reason: failure } : { ok: true, value: rows })
      if (!failure) salaryPayrollSync.value.set(payMonth, foldPayrollSync(syncs))
    }
    /** 1 本読んで結果を記録する。false = ここで止める (案件切替で古くなった / 403) */
    const readOne = async ({ company, workMonth, payMonth }: PayrollTarget): Promise<boolean> => {
      let outcome: Outcome
      try {
        // 認証は cookie 任せ (拘束×賃金と同じ。server route が cookie から Bearer を組む)
        const stored = toStoredPayroll(await $fetch('/api/kyuyo/payroll', { query: { company, month: workMonth } }))
        outcome = stored
          ? { rows: payrollToParsedSalary(stored.rows as KyuyoPayrollRow[], company).rows, sync: { source: stored.source, syncedAt: stored.syncedAt } }
          : { failure: `会社 ${company} の応答の形が想定外` }
      }
      catch (e) {
        if (epoch !== salaryEpoch) return false
        if (caughtErrorStatus(e) === 403) {
          salaryError.value = `給与を見る権限がありません: ${describeCaughtError(e, SALARY_RETRY)}`
          return false
        }
        // 404 は上流が「その年度の給与DB が給与大臣に無い」ときに返す (rust-ichibanboshi routes/kyuyo.rs)。
        // 汎用の 404 文言 (画面の情報が古い) は当てはまらないので言い換える
        outcome = { failure: caughtErrorStatus(e) === 404
          ? `会社 ${company}: 給与大臣にこの月の給与DB が無い`
          : `会社 ${company}: ${describeCaughtError(e, SALARY_RETRY)}` }
      }
      if (epoch !== salaryEpoch) return false
      const byCompany = outcomes.get(payMonth) ?? new Map<string, Outcome>()
      outcomes.set(payMonth, byCompany.set(company, outcome))
      if (byCompany.size === companies.length) {
        finalize(payMonth)
        pendingCached.delete(payMonth)
        showLoading()
      }
      return true
    }

    // 保存済み: 同時 SALARY_PAYROLL_CONCURRENCY 本ずつ
    let done = 0
    showLoading()
    for (let i = 0; i < cached.length; i += SALARY_PAYROLL_CONCURRENCY) {
      salaryProgress.value = `読込 ${done} / ${cached.length} (保存済み ${cached.length} 本をまとめて読んでいます)`
      const oks = await Promise.all(cached.slice(i, i + SALARY_PAYROLL_CONCURRENCY).map(readOne))
      if (oks.includes(false)) return
      done += oks.length
    }
    // 保存が無い月: 給与大臣を開くので 1 本ずつ
    for (const [i, t] of live.entries()) {
      showLoading(t.payMonth)
      salaryProgress.value = `${i + 1} / ${live.length} — ${t.payMonth} 支給 (会社 ${t.company}) を読んでいます (保存が無い月は給与大臣から読むので 10〜20 秒)`
      if (!await readOne(t)) return
    }
    salaryProgress.value = ''
  }
  catch (e) {
    if (epoch === salaryEpoch) salaryError.value = describeCaughtError(e, SALARY_RETRY)
  }
  finally {
    if (epoch === salaryEpoch) {
      salaryLoading.value = false
      salaryLoadingPayMonth.value = null
    }
  }
}

// --- 給与比較タブ: 「明細なし」の乗務員を、その場で社員マスタに 1 人ずつ登録する ---
// 拘束×賃金へ移って 給与DB 取り込み → 突合 → 保存 をしなくて済むように、読んだ明細の氏名から一意に引き当てる
const salaryRegisterCandidates = computed(() => litigationRegisterCandidates({
  payrollRows: [...salaryPayroll.value.values()].flatMap(p => (p.ok ? p.value : [])),
  drivers: drivers.value.map(d => ({ summary: { driverCd: d.driver_cd, driverName: d.driver_name } })),
  cdMap: salaryCdMap.value,
  registered: salaryEmployees.value,
  caseDriverCds: openCase.value?.driverCds ?? [],
}))

/** 給与大臣のその 1 人の属性 (給与区分・所属) を、案件の最初の月付けで作る。
 * 拘束×賃金の「給与DBから読み込み」と同じ `planPayrollDbImport` を、その 1 人に絞って使う。
 * `legacyLabel = null` なので旧ラベル行の統合 (deleteEmployees) は起きない。
 * `found = false` は 給与大臣のその年度に居ない。 */
async function planSalaryAttrs(c: LitigationRegisterCandidate) {
  const month = caseMonths.value[0]!
  const res = await $fetch<KyuyoEmployeesResponse>('/api/kyuyo/employees', { query: { company: c.company, month } })
  const plan = planPayrollDbImport(narrowKyuyoEmployees(res, c.payrollCd), salaryEmployees.value, month, null)
  return { month, found: plan.employees.length > 0, entry: plan.employees[0], attrs: plan.attrs }
}

const SALARY_KUBUN_HINT = '拘束×賃金の社員マスタタブで区分を入れてください'

/**
 * 社員マスタに 1 人 PUT する (金額は送らない)。成功したら社員マスタを読み直して引き当てを作り直す — 明細は読み直さない。
 * - `register`: 社員の行も送る。属性が取れなかったら、属性なしで登録して理由を出す
 * - 属性だけ (`register = false`): `employees: []` で attrs だけ送る — 古い写しで name / driver_cd を上書きしないため
 */
async function saveSalaryEmployee(c: LitigationRegisterCandidate, register: boolean) {
  if (salaryRegistering.value) return
  const epoch = salaryEpoch
  salaryRegistering.value = true
  salaryRegisterMessage.value = ''
  const label = `${c.payrollCd} ${c.name} (会社 ${c.company}) → 乗務員 ${c.driverCd}`
  let saved = false
  try {
    let entry = { company: c.company, payrollCd: c.payrollCd, name: c.name, driverCd: c.driverCd, hireDate: null as string | null, retireDate: null as string | null }
    let attrs: Awaited<ReturnType<typeof planSalaryAttrs>>['attrs'] = []
    let attrsNote = ''
    try {
      const planned = await planSalaryAttrs(c)
      if (planned.found) {
        entry = { ...planned.entry!, driverCd: c.driverCd }
        attrs = planned.attrs
        if (attrs.length === 0 || attrs[0]!.payKubun === null) attrsNote = `給与区分が給与大臣に無いので基本給は計算できません — ${SALARY_KUBUN_HINT}`
      }
      else {
        attrsNote = `給与区分が取れませんでした (給与大臣の ${planned.month} の年度に居ない) — ${SALARY_KUBUN_HINT}`
      }
    }
    catch (e) {
      attrsNote = `給与区分が取れませんでした (${describeCaughtError(e, 'もう一度押してください')}) — ${SALARY_KUBUN_HINT}`
    }
    if (epoch !== salaryEpoch) return
    if (!register && attrs.length === 0) {
      salaryRegisterMessage.value = `属性を入れられませんでした (${label}): ${attrsNote}`
      return
    }
    await $fetch('/restraint-api/employee-master', {
      method: 'PUT',
      headers: authHeaders(),
      body: { employees: register ? [entry] : [], attrs, deleteAttrs: [], deleteEmployees: [] },
    })
    saved = true
    const employees = await $fetch<EmployeeMasterGetResponse>('/restraint-api/employee-master', { headers: authHeaders() })
    if (epoch !== salaryEpoch) return
    salaryEmployees.value = employees.employees ?? []
    salaryCdMap.value = buildCdMapEntries(salaryEmployees.value)
    const wrote = attrs[0]?.payKubun != null
    if (wrote) salaryAttrsWritten.value = true
    salaryRegisterMessage.value = `${register ? '社員マスタに登録しました' : '属性を入れました'}: ${label}`
      + (wrote ? ' — 区分を入れました。基本給の計算に反映するには拘束の材料を取り直してください' : ` — ${attrsNote}`)
  }
  catch (e) {
    if (epoch !== salaryEpoch) return
    salaryRegisterMessage.value = saved
      ? `${register ? '社員マスタに登録' : '属性を入れ'}ましたが、読み直せませんでした: ${describeCaughtError(e, SALARY_RETRY)}`
      : `${register ? '社員マスタに登録' : '属性を入れ'}できませんでした (${label}): ${describeCaughtError(e, 'もう一度押してください')}`
  }
  finally {
    salaryRegistering.value = false
  }
}

const registerSalaryEmployee = (c: LitigationRegisterCandidate) => saveSalaryEmployee(c, true)

/** 社員マスタに居るのに属性が空の、案件の乗務員 */
const salaryAttrsCandidates = computed(() => litigationAttrsCandidates({
  employees: salaryEmployees.value,
  caseDriverCds: openCase.value?.driverCds ?? [],
}))

/** 属性を入れた後、wage-report **だけ**を案件の月ごとに直列で取り直す (alc の運行・オンプレ突き合わせはやり直さない)。
 * 自動では走らせない (36 か月で 9〜38 分) */
async function retakeWageReports() {
  const target = openCase.value
  if (!target) return
  await runErrorSteps(caseMonths.value.map(m => wageReportStep(m, target.driverCds)))
  salaryAttrsWritten.value = false
}

const SALARY_STATE_CLASS: Record<LitigationSalaryState, string> = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  pending: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  unknown: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  noPayroll: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}

// --- 変更記録タブ: 打刻 (relay) + 運行 (alc-proxy) を 1 つの表にまとめる ---
// litigation-changes.ts の doc 参照。「取り込んだ時点の値を基準に、あとで変わった記録」を
// 案件の乗務員ごとに読む (期間は案件の開始月初〜終了月末)。
const changesRows = ref<LitigationChangeRow[]>([])
const changesRunning = ref(false)
const changesFinished = ref(false)
const changesKintaiForbidden = ref(false)
const changesKintaiRecordingSince = ref<string | null>(null)
/** 403 以外で 1 回でも読めた (= recordingSince が意味を持つ) か */
const changesKintaiRecordingSinceKnown = ref(false)
const changesKintaiErrors = ref<string[]>([])
const changesAlcRecordingSince = ref<string | null>(null)
const changesAlcRecordingSinceKnown = ref(false)
const changesAlcErrors = ref<string[]>([])

// 別の案件を開いた・案件を編集して期間/乗務員が変わったら、前の結果は捨てる
watch(() => [openCase.value?.caseId, openCase.value?.updatedAt], () => {
  if (changesRunning.value) return
  changesRows.value = []
  changesRunning.value = false
  changesFinished.value = false
  changesKintaiForbidden.value = false
  changesKintaiRecordingSince.value = null
  changesKintaiRecordingSinceKnown.value = false
  changesKintaiErrors.value = []
  changesAlcRecordingSince.value = null
  changesAlcRecordingSinceKnown.value = false
  changesAlcErrors.value = []
})

const CHANGES_RETRY = '「検知を実行」を押してやり直してください'

/** 打刻の記録開始日/403/読めなかった旨の文言。「変更なし」「記録が無い」
 * 「読めなかった」を混同しない (map skill「PR の基準」(7))。 */
const kintaiChangesNotice = computed(() => {
  if (changesKintaiForbidden.value) return KINTAI_CHANGE_LOG_FORBIDDEN_NOTICE
  if (!changesKintaiRecordingSinceKnown.value && changesKintaiErrors.value.length > 0) {
    return `打刻の変更記録を読めませんでした: ${changesKintaiErrors.value[0]}`
  }
  return kintaiRecordingSinceNotice(changesKintaiRecordingSince.value)
})
const alcChangesNotice = computed(() => {
  if (!changesAlcRecordingSinceKnown.value && changesAlcErrors.value.length > 0) {
    return `運行の変更記録を読めませんでした: ${changesAlcErrors.value[0]}`
  }
  return alcRecordingSinceNotice(changesAlcRecordingSince.value)
})
/** CSV (画面と ZIP 共通) に添える備考。検知を実行していなければ表が空である理由を書く。 */
const changesNotices = computed<string[]>(() => {
  if (!changesFinished.value) return ['変更記録タブで「検知を実行」を押していないため、この表は空です。']
  const out = [kintaiChangesNotice.value]
  if (!changesKintaiForbidden.value && changesKintaiErrors.value.length > 0) {
    out.push(`打刻の変更記録の一部が読めませんでした (${changesKintaiErrors.value.length} 件): ${changesKintaiErrors.value.join(' / ')}`)
  }
  out.push(alcChangesNotice.value)
  if (changesAlcErrors.value.length > 0) {
    out.push(`運行の変更記録の一部が読めませんでした (${changesAlcErrors.value.length} 件): ${changesAlcErrors.value.join(' / ')}`)
  }
  return out
})

/** 案件の乗務員ごとに打刻・運行の変更記録を読み、1 つの表にまとめる。
 * 打刻は relay の 400 日上限があるので `splitDateRangeByMaxDays` で分けて読む。
 * 1 名ずつ・打刻→運行の順に直列で叩く (theearth には触らないが、同時多発で
 * 上流に負荷をかけないため他の検知と同じ流儀に揃える)。 */
async function runChangesFetch() {
  const target = openCase.value
  if (!target || changesRunning.value) return
  changesRunning.value = true
  changesFinished.value = false
  changesRows.value = []
  changesKintaiForbidden.value = false
  changesKintaiRecordingSince.value = null
  changesKintaiRecordingSinceKnown.value = false
  changesKintaiErrors.value = []
  changesAlcRecordingSince.value = null
  changesAlcRecordingSinceKnown.value = false
  changesAlcErrors.value = []
  const { from, to } = litigationCaseDateBounds(target.fromMonth, target.toMonth)
  const kintaiRanges = splitDateRangeByMaxDays(from, to, LITIGATION_CHANGE_LOG_MAX_DAYS)
  const kintaiEntries: ReturnType<typeof parseKintaiChangeLog>['changes'] = []
  const alcEntries: ReturnType<typeof parseAlcOperationChanges>['changes'] = []
  try {
    for (const driverCd of target.driverCds) {
      if (!changesKintaiForbidden.value) {
        for (const range of kintaiRanges) {
          try {
            const res = await $fetch<unknown>('/restraint-api/kintai/change-log', {
              headers: authHeaders(),
              query: { driver: driverCd, from: range.from, to: range.to },
            })
            const parsed = parseKintaiChangeLog(res)
            kintaiEntries.push(...parsed.changes)
            changesKintaiRecordingSince.value = parsed.recordingSince
            changesKintaiRecordingSinceKnown.value = true
          }
          catch (e) {
            if (caughtErrorStatus(e) === 403) {
              // 会社ごとの判定 (KINTAI_COMP_ID) — 一度弾かれたら以降は叩かない
              changesKintaiForbidden.value = true
              break
            }
            changesKintaiErrors.value.push(`${driverCd} ${range.from}〜${range.to}: ${describeCaughtError(e, CHANGES_RETRY)}`)
          }
        }
      }
      try {
        const res = await getDtakoOperationChanges(driverCd, from, to)
        const parsed = parseAlcOperationChanges(res)
        alcEntries.push(...parsed.changes)
        changesAlcRecordingSince.value = parsed.recordingSince
        changesAlcRecordingSinceKnown.value = true
      }
      catch (e) {
        changesAlcErrors.value.push(`${driverCd}: ${describeCaughtError(e, CHANGES_RETRY)}`)
      }
    }
    changesRows.value = mergeLitigationChangeRows(buildKintaiChangeRows(kintaiEntries), buildAlcChangeRows(alcEntries))
  }
  finally {
    changesRunning.value = false
    changesFinished.value = true
  }
}

/** 変更記録 CSV (ZIP に入れる)。 */
function changesCsvText(): string {
  return litigationChangesCsv(changesRows.value, changesNotices.value)
}

const CHECK_STATE_CLASS: Record<LitigationCheckState, string> = {
  ng: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  unknown: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  pending: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}
const IMPORT_KIND_CLASS: Record<LitigationImportOutcome['kind'], string> = {
  ok: 'text-green-700 dark:text-green-400',
  empty: 'text-gray-600 dark:text-gray-400',
  forbidden: 'text-red-700 dark:text-red-400',
  error: 'text-red-700 dark:text-red-400',
}

// --- 印刷: 案件の概要 + いま開いているタブの中身を 1 つの紙面に ---
const printedAt = ref('')
function printCase() {
  printedAt.value = fmtDateTime(new Date().toISOString())
  // printedAt の描画を待ってから開く
  nextTick(() => window.print())
}

/** 状態の短い名前。**0 件・未登録・失敗を同じ見た目にしない** (map skill「PR の基準」(7))。
 * `empty` は元 (勤怠 / 運行) を言わない語にする — 何の 0 件かは冊ごとの結果の文が言う */
const OUTPUT_STATUS_LABEL: Record<LitigationOutputStatus, string> = {
  ok: '作成',
  empty: '0 件',
  not_found: 'alc に未登録',
  error: '失敗',
}
const OUTPUT_STATUS_CLASS: Record<LitigationOutputStatus, string> = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  empty: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  not_found: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6 print:hidden">
      <h2 class="text-xl font-bold">訴訟準備</h2>
      <UButton
        v-if="viewerComp"
        icon="i-lucide-refresh-cw"
        label="再読み込み"
        variant="ghost"
        size="sm"
        :loading="casesLoading"
        @click="loadCases"
      />
    </div>

    <UAlert v-if="pageError" color="error" :title="pageError" class="mb-4 print:hidden" />

    <!-- 閲覧する会社ID の指定 (Refs #272 と同型: theearth ログイン不要) -->
    <UCard v-if="!viewerComp" class="max-w-md mb-4 print:hidden">
      <template #header>
        <span class="font-medium">閲覧する会社を選択</span>
      </template>
      <div class="flex items-center gap-2">
        <USelect v-model="viewerCompInput" :items="viewerCompOptions(viewerComps)" placeholder="会社を選択" class="w-64" />
        <UButton label="開始" :disabled="!viewerCompInput" @click="startViewer" />
      </div>
      <p v-if="viewerComps?.length === 0" class="text-xs text-red-600 mt-2">
        このアカウントで閲覧できる会社がありません (管理者に権限を確認してください)
      </p>
    </UCard>

    <template v-else>
      <div class="flex items-center justify-between mb-4 print:hidden">
        <span class="text-sm text-gray-500">
          会社: {{ dtakoCompDisplay(viewerComp) }}
          <UButton icon="i-lucide-pencil" label="変更" variant="link" size="xs" class="ml-1" @click="changeViewer" />
        </span>
        <UButton icon="i-lucide-plus" label="新規作成" size="sm" @click="startNewCase" />
      </div>

      <!-- 新規作成/編集フォーム -->
      <div v-if="showForm" class="mb-4 p-4 print:hidden bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg space-y-4">
        <h3 class="text-sm font-medium">{{ editingCaseId ? '案件を編集' : '新規案件' }}</h3>

        <div>
          <label class="block text-xs text-gray-500 mb-1">案件名</label>
          <UInput v-model="form.name" placeholder="例: 未払残業代請求事件" class="w-full max-w-md" />
          <p v-if="fieldError('name')" class="text-xs text-red-600 mt-1">{{ fieldError('name') }}</p>
        </div>

        <div class="flex items-end gap-3 flex-wrap">
          <div>
            <label class="block text-xs text-gray-500 mb-1">開始月</label>
            <input v-model="form.fromMonth" type="month" class="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
            <p v-if="fieldError('fromMonth')" class="text-xs text-red-600 mt-1">{{ fieldError('fromMonth') }}</p>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">終了月</label>
            <input v-model="form.toMonth" type="month" class="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
            <p v-if="fieldError('toMonth')" class="text-xs text-red-600 mt-1">{{ fieldError('toMonth') }}</p>
          </div>
          <p v-if="form.fromMonth && form.toMonth" class="text-xs text-gray-500 pb-2">
            {{ litigationCaseMonthCount(form.fromMonth, form.toMonth) }}か月分
          </p>
          <p v-if="fieldError('range')" class="text-xs text-red-600 pb-2">{{ fieldError('range') }}</p>
        </div>

        <div>
          <label class="block text-xs text-gray-500 mb-1">乗務員 (1名)</label>
          <div class="flex items-center gap-2 flex-wrap">
            <USelectMenu
              :model-value="form.driverCds[0] ?? ''"
              :items="driverOptions"
              value-key="value"
              :search-input="{ placeholder: '乗務員CD・氏名で検索' }"
              class="w-64"
              placeholder="一覧から選ぶ"
              @update:model-value="selectListedDriver"
            />
            <span class="text-xs text-gray-400">または</span>
            <UInput v-model="driverCdInput" size="sm" placeholder="乗務員CDを直接入力" class="w-40" @keyup.enter="addTypedDriver" />
            <UButton size="xs" label="選択" variant="soft" :disabled="!driverCdInput.trim()" @click="addTypedDriver" />
          </div>
          <p v-if="driverAddError" class="text-xs text-red-600 mt-1">{{ driverAddError }}</p>
          <p v-if="fieldError('driverCds')" class="text-xs text-red-600 mt-1">{{ fieldError('driverCds') }}</p>
          <div v-if="form.driverCds.length > 0" class="flex flex-wrap gap-1.5 mt-2">
            <span
              v-for="cd in form.driverCds"
              :key="cd"
              class="inline-flex items-center gap-1 text-xs bg-gray-100 dark:bg-gray-800 rounded-full pl-2.5 pr-1 py-1"
            >
              {{ driverLabel(cd) }} ({{ cd }})
              <button class="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" @click="removeDriver(cd)">
                <UIcon name="i-lucide-x" class="size-3" />
              </button>
            </span>
          </div>
        </div>

        <div>
          <label class="block text-xs text-gray-500 mb-1">メモ (任意)</label>
          <textarea
            v-model="form.memo"
            rows="2"
            class="w-full max-w-md rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          />
        </div>

        <div class="flex gap-2">
          <UButton label="保存" :loading="saving" @click="saveCase" />
          <UButton label="キャンセル" variant="ghost" @click="cancelForm" />
        </div>
      </div>

      <!-- 案件一覧 -->
      <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden print:hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
              <th class="text-left px-4 py-3 font-medium">名前</th>
              <th class="text-left px-4 py-3 font-medium">期間</th>
              <th class="text-left px-4 py-3 font-medium">乗務員</th>
              <th class="text-left px-4 py-3 font-medium">更新日時</th>
              <th class="text-left px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody v-if="casesLoading && !casesLoaded">
            <tr>
              <td colspan="5" class="px-4 py-8 text-center text-gray-500">
                <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin mr-2" />
                読み込み中...
              </td>
            </tr>
          </tbody>
          <tbody v-else-if="cases.length === 0">
            <tr>
              <td colspan="5" class="px-4 py-8 text-center text-gray-500">案件がありません</td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr
              v-for="entry in cases"
              :key="entry.caseId"
              class="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/30"
            >
              <td class="px-4 py-3 font-medium">{{ entry.name }}</td>
              <td class="px-4 py-3 text-gray-500">{{ entry.fromMonth }} 〜 {{ entry.toMonth }}</td>
              <td class="px-4 py-3 text-gray-500">{{ driversText(entry.driverCds) }}</td>
              <td class="px-4 py-3 text-gray-500">{{ fmtDateTime(entry.updatedAt) }}</td>
              <td class="px-4 py-3 text-right whitespace-nowrap">
                <UButton
                  icon="i-lucide-folder-open" label="開く" size="xs"
                  :variant="openCaseId === entry.caseId ? 'solid' : 'soft'"
                  @click="openCaseDetail(entry)"
                />
                <UButton icon="i-lucide-pencil" label="編集" variant="ghost" size="xs" @click="startEditCase(entry)" />
                <UButton
                  icon="i-lucide-trash-2" label="削除" variant="ghost" color="error" size="xs"
                  :loading="deleting === entry.caseId" @click="deleteCase(entry)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 削除した案件 (削除から 30 日間は復活できる。403 / 0 件なら出さない) -->
      <div v-if="deletedError" class="mt-4 print:hidden" data-testid="litigation-deleted-error">
        <UAlert color="error" :title="deletedError" />
      </div>
      <div v-else-if="deletedCases.length > 0" class="mt-4 print:hidden" data-testid="litigation-deleted">
        <h3 class="text-sm font-medium mb-2">削除した案件 (削除から {{ LITIGATION_CASE_RESTORE_DAYS }} 日間)</h3>
        <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                <th class="text-left px-4 py-3 font-medium">名前</th>
                <th class="text-left px-4 py-3 font-medium">期間</th>
                <th class="text-left px-4 py-3 font-medium">削除した日時</th>
                <th class="text-left px-4 py-3 font-medium">削除した人</th>
                <th class="text-left px-4 py-3 font-medium">消える日</th>
                <th class="text-left px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="entry in deletedCases"
                :key="entry.case.caseId"
                class="border-b border-gray-100 dark:border-gray-800"
              >
                <td class="px-4 py-3 font-medium">{{ entry.case.name }}</td>
                <td class="px-4 py-3 text-gray-500">{{ entry.case.fromMonth }} 〜 {{ entry.case.toMonth }}</td>
                <td class="px-4 py-3 text-gray-500">{{ fmtJstDateTime(entry.deletedAt) }}</td>
                <td class="px-4 py-3 text-gray-500">{{ entry.deletedBy }}</td>
                <td class="px-4 py-3 text-gray-500">{{ deletedCaseExpiryDate(entry.deletedAt) }}</td>
                <td class="px-4 py-3 text-right whitespace-nowrap">
                  <UButton
                    icon="i-lucide-undo-2" label="復活" variant="soft" size="xs"
                    :loading="restoring === entry.case.caseId" @click="restoreCase(entry)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 開いた案件の詳細 (タブ) -->
      <div v-if="openCase" class="mt-6 space-y-4 print:hidden">
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-bold">
            {{ openCase.name }}
            <span class="text-sm font-normal text-gray-500 ml-2">
              {{ openCase.fromMonth }} 〜 {{ openCase.toMonth }} / {{ driversText(openCase.driverCds) }}
            </span>
          </h3>
          <div class="flex items-center gap-1">
            <UButton icon="i-lucide-printer" label="このタブを印刷" variant="soft" size="sm" data-testid="litigation-print" @click="printCase" />
            <UButton icon="i-lucide-x" label="閉じる" variant="ghost" size="sm" @click="closeCaseDetail" />
          </div>
        </div>

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

        <!-- 出力: Y時間 Excel を区切りごとに作って ZIP 1 つにまとめる -->
        <div v-if="activeTab === 'output'" data-testid="litigation-output" class="space-y-3">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            案件の乗務員 × 期間ぶんの Y時間 Excel (京都ソフト案件のテンプレ) を作り、1 つの ZIP でダウンロードします。
            1 冊 = 乗務員 1 名 × 最大 12 か月 (開始月から 12 か月ごとに区切ります)。
            1 冊あたり 5〜15 秒かかります。0 件・alc に未登録・失敗の冊は ZIP に入れず、下の表に残します。
            Excel の行は勤怠の勤務の記録から作ります (勤怠の記録が無い会社は運行から)。どちらで作ったかは冊ごとに下の表に出ます。
            ZIP には {{ LITIGATION_CHANGES_CSV_FILENAME }} (変更記録タブの表) も入れます — タブで検知を実行していない場合は、その旨を書いた空の表になります。
            下の「月ごとの時間」は、給与比較と同じ wage report の月ごとの時間 (暦月) です。ZIP を作る前から出ます。
            ダウンロードのあと、同じファイルと結果を版として保存します (出力するたびに 1 版)。元のデータが後から変わっても、その時点で出力した Excel を下の「保存した版」からダウンロードできます。案件を開き直すと、最新の版の結果を表示します。
          </p>

          <div class="flex items-center gap-3 flex-wrap">
            <UButton
              icon="i-lucide-file-archive"
              label="ZIP を作る"
              :loading="outputRunning"
              :disabled="outputRunning || outputChunks.length === 0"
              @click="buildOutputZip"
            />
            <span v-if="outputRunning || outputFinished || restoredOutput" class="text-sm text-gray-600 dark:text-gray-400" data-testid="litigation-output-progress">
              {{ outputDoneCount }} / {{ outputChunks.length }} 冊
              <template v-if="outputFinished || restoredOutput">
                (作成 {{ outputCounts.ok }} / 0 件 {{ outputCounts.empty }} / alc に未登録 {{ outputCounts.not_found }} / 失敗 {{ outputCounts.error }})
              </template>
            </span>
            <span v-if="outputSaveProgress" class="text-sm text-gray-600 dark:text-gray-400" data-testid="litigation-output-save-progress">
              <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin mr-1" />保存 {{ outputSaveProgress.done }} / {{ outputSaveProgress.total }}
            </span>
            <span v-if="outputChunks.length === 0" class="text-sm text-gray-500">区切りがありません (期間か乗務員が空です)</span>
          </div>

          <UAlert v-if="outputZipMessage" color="success" :title="outputZipMessage" />
          <UAlert v-if="outputZipError" color="error" :title="outputZipError" />
          <div v-if="outputSaveMessage" class="text-sm text-green-700 dark:text-green-400" data-testid="litigation-output-save-message">{{ outputSaveMessage }}</div>
          <div v-if="outputSaveWarning" class="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300 space-y-1" data-testid="litigation-output-save-warning">
            <div class="font-medium">{{ outputSaveWarning.title }}</div>
            <ul v-if="outputSaveWarning.items.length > 0" class="list-disc pl-5 text-xs space-y-0.5">
              <li v-for="item in outputSaveWarning.items" :key="item">{{ item }}</li>
            </ul>
          </div>
          <div v-if="restoredOutput" class="text-sm text-blue-700 dark:text-blue-300 flex items-center gap-2 flex-wrap" data-testid="litigation-output-restored">
            <span>{{ restoredOutputText }}</span>
            <UButton v-if="outputResults.length > 0" label="このページで作った結果に戻す" variant="link" size="xs" @click="showRunResults" />
          </div>
          <div v-if="outputRestoreNotice" class="text-sm text-amber-700 dark:text-amber-400" data-testid="litigation-output-restore-notice">{{ outputRestoreNotice }}</div>

          <div v-if="outputChunks.length > 0" class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-1" data-testid="litigation-zip-summary">
            <div class="text-sm font-medium">ZIP に入るもの</div>
            <div v-for="item in zipSummary" :key="item.filename" class="text-xs flex gap-2" :data-zip-file="item.filename">
              <span
                class="rounded px-1.5 whitespace-nowrap"
                :class="item.state === 'included' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : item.state === 'pending' ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'"
              >{{ item.state === 'included' ? '入る' : item.state === 'pending' ? 'まだ' : '入らない' }}</span>
              <span class="font-mono whitespace-nowrap">{{ item.filename }}</span>
              <span class="text-gray-600 dark:text-gray-400">{{ item.detail }}</span>
            </div>
          </div>

          <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-x-auto">
            <table class="w-full text-sm" data-testid="litigation-output-table">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                  <th class="text-left px-4 py-2 font-medium">乗務員</th>
                  <th class="text-left px-4 py-2 font-medium">期間</th>
                  <th class="text-left px-4 py-2 font-medium">ファイル名</th>
                  <th class="text-left px-4 py-2 font-medium">状態</th>
                  <th class="text-left px-4 py-2 font-medium">結果</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(chunk, i) in outputChunks"
                  :key="chunk.filename"
                  class="border-b border-gray-100 dark:border-gray-800 align-top"
                >
                  <td class="px-4 py-2 whitespace-nowrap">{{ driverLabel(chunk.driverCd) }} ({{ chunk.driverCd }})</td>
                  <td class="px-4 py-2 whitespace-nowrap">{{ chunk.label }}</td>
                  <td class="px-4 py-2 font-mono text-xs text-gray-500">{{ chunk.filename }}</td>
                  <td class="px-4 py-2 whitespace-nowrap">
                    <span v-if="shownOutputResults[i]" class="text-xs rounded px-2 py-0.5" :class="OUTPUT_STATUS_CLASS[shownOutputResults[i]!.status]">
                      {{ OUTPUT_STATUS_LABEL[shownOutputResults[i]!.status] }}
                    </span>
                    <span v-else-if="outputRunning && outputCurrent === i" class="text-xs text-gray-500">
                      <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin mr-1" />作成中
                    </span>
                    <span v-else class="text-xs text-gray-400">未実行</span>
                  </td>
                  <td class="px-4 py-2">
                    <template v-if="shownOutputResults[i]">
                      <div>{{ shownOutputResults[i]!.message }}</div>
                      <div
                        v-for="line in litigationOutputSourceLines(shownOutputResults[i]!)"
                        :key="line.kind"
                        class="text-xs mt-1"
                        :class="line.kind === 'refold' ? 'font-bold text-red-700 dark:text-red-400' : line.kind === 'source' ? 'text-gray-500' : 'text-amber-700 dark:text-amber-400'"
                        :data-output-line="line.kind"
                      >{{ line.text }}</div>
                      <div v-if="shownOutputResults[i]!.missingCount > 0" class="text-xs text-amber-700 dark:text-amber-400 mt-1">
                        テンプレに行が無く書けなかった日 {{ shownOutputResults[i]!.missingCount }} 日
                        ({{ shownOutputResults[i]!.missingDates.join(', ') }}<template v-if="shownOutputResults[i]!.missingCount > shownOutputResults[i]!.missingDates.length"> ほか</template>)
                      </div>
                      <div v-if="shownOutputResults[i]!.warningsCount > 0" class="text-xs text-amber-700 dark:text-amber-400 mt-1">
                        警告 {{ shownOutputResults[i]!.warningsCount }} 件: {{ shownOutputResults[i]!.warnings.join(' / ') }}<template v-if="shownOutputResults[i]!.warningsCount > shownOutputResults[i]!.warnings.length"> ほか</template>
                      </div>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <LitigationMonthlyHoursTable v-if="hoursBooks.length > 0" :books="hoursBooks" :driver-label="driverLabel" :notice="hoursNotice" />

          <!-- 保存した版 (出力するたびに 1 版)。403 (admin / payroll 以外) は 1 行だけ出す -->
          <p v-if="outputVersionsForbidden" class="text-sm text-gray-500" data-testid="litigation-output-versions-forbidden">出力の保存と履歴は admin / payroll のみ使えます</p>
          <div v-else class="space-y-2" data-testid="litigation-output-versions">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-medium">保存した版</span>
              <UButton icon="i-lucide-refresh-cw" label="履歴を読み直す" variant="ghost" size="xs" :loading="outputVersionsLoading" @click="reloadOutputVersions" />
              <span v-if="versionZipProgress" class="text-xs text-gray-600 dark:text-gray-400" data-testid="litigation-version-zip-progress">
                ファイルを取得中 {{ versionZipProgress.done }} / {{ versionZipProgress.total }}
              </span>
            </div>
            <div v-if="outputVersionsError" class="text-xs text-red-600 dark:text-red-400" data-testid="litigation-output-versions-error">{{ outputVersionsError }}</div>
            <div v-if="versionActionError" class="text-xs text-red-600 dark:text-red-400" data-testid="litigation-version-action-error">{{ versionActionError }}</div>
            <div v-if="outputVersionsUnreadable > 0" class="text-xs text-amber-700 dark:text-amber-400">形が読めない版が {{ outputVersionsUnreadable }} 件あり、一覧に出していません</div>
            <div v-if="outputVersionRows.length === 0" class="text-xs text-gray-500">
              {{ outputVersionsLoading ? '読み込み中…' : outputVersionsError ? '' : '保存した版はまだありません' }}
            </div>
            <div v-else class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-x-auto">
              <table class="w-full text-sm" data-testid="litigation-output-versions-table">
                <thead>
                  <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                    <th class="text-left px-4 py-2 font-medium">出力した日時</th>
                    <th class="text-left px-4 py-2 font-medium">出力した人</th>
                    <th class="text-left px-4 py-2 font-medium">保存したファイル</th>
                    <th class="text-left px-4 py-2 font-medium">大きさ</th>
                    <th class="text-left px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="{ v, row } in outputVersionRows"
                    :key="v.versionId"
                    class="border-b border-gray-100 dark:border-gray-800"
                    :data-version="v.versionId"
                  >
                    <td class="px-4 py-2 whitespace-nowrap">
                      {{ row.createdAtText }}
                      <span v-if="restoredOutput?.versionId === v.versionId" class="text-xs rounded px-1.5 ml-1 bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">表示中</span>
                    </td>
                    <td class="px-4 py-2 text-gray-500">{{ row.createdBy }}</td>
                    <td class="px-4 py-2 whitespace-nowrap">Excel {{ row.excelCount }} 冊 / ファイル {{ row.fileCount }} 個</td>
                    <td class="px-4 py-2 whitespace-nowrap text-gray-500">{{ row.sizeText }}</td>
                    <td class="px-4 py-2 text-right whitespace-nowrap">
                      <UButton
                        icon="i-lucide-download" label="この版の ZIP をダウンロード" variant="soft" size="xs"
                        :loading="versionBusy?.versionId === v.versionId && versionBusy.action === 'zip'"
                        :disabled="versionBusy !== null || row.fileCount === 0"
                        @click="downloadVersionZip(v)"
                      />
                      <UButton
                        icon="i-lucide-eye" label="この版の結果を表示" variant="ghost" size="xs"
                        :loading="versionBusy?.versionId === v.versionId && versionBusy.action === 'show'"
                        :disabled="versionBusy !== null || outputRunning"
                        @click="showVersion(v)"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- エラー: 乗務員 × 月ごとに 4 つの検知 (litigation-errors.ts) -->
        <div v-if="activeTab === 'errors'" data-testid="litigation-errors" class="space-y-3">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            乗務員 × 月ごとに、alc の運行が 0 件か・Y時間に書けなかった日があるか・alc にあるのにオンプレのデジタコに無い運行があるか・
            最低賃金の不変条件 (条件1〜3、拘束は GCP) が崩れていないかを並べます。
            「判定できない」は調べたが材料が取れなかった月で、異常なしではありません。
            「alc にあってオンプレのデジタコに無い運行」は、alc の運行とオンプレのデジタコ運行 (dtako_rows) を、運行を始めた月・運行NO の先頭 22 桁で突き合わせます (タイムカードの有無に関係なく照合できます)。
            Y時間の欠けは「検知を実行」の Y時間 プレビューから判定します (出庫/帰庫が無い・運行の中身が取れないなどで Y時間 に入らなかった運行)。出力タブで ZIP を作った後は、テンプレに書けなかった日も加えます。最低賃金の不変条件は 1 か月 15〜64 秒かかります (読むだけで、最低賃金チェックの保存はしません)。
            検知の結果は案件ごとに保存し、開き直すと前回の結果を出します (月の下の時刻がその行の材料を取った時刻)。「続きから」は、まだ取っていない・取れなかった分だけを回します。
          </p>

          <div class="flex items-center gap-3 flex-wrap">
            <UButton
              icon="i-lucide-search-check"
              :label="errCheckedAt.size > 0 ? '検知を全部やり直す' : '検知を実行'"
              :loading="errorsRunning"
              :disabled="errorsRunning || errorsStoreLoading || importingKey !== null || errorRows.length === 0"
              data-testid="litigation-errors-run"
              @click="runErrorChecks(false)"
            />
            <UButton
              v-if="errCheckedAt.size > 0"
              icon="i-lucide-play"
              :label="`続きから (${missingErrorSteps} 件)`"
              variant="soft"
              :disabled="errorsRunning || errorsStoreLoading || importingKey !== null || missingErrorSteps === 0"
              data-testid="litigation-errors-resume"
              @click="runErrorChecks(true)"
            />
            <span v-if="errorsStoreLoading" class="text-sm text-gray-500" data-testid="litigation-errors-store-loading">保存済みの結果を読み込み中…</span>
            <span v-if="errorsProgress" class="text-sm text-gray-600 dark:text-gray-400" data-testid="litigation-errors-progress">
              {{ errorsProgress.done }} / {{ errorsProgress.total }}
              <template v-if="errorsRunning && errorsProgress.label">— {{ errorsProgress.label }}</template>
              <template v-else-if="errorsFinished">完了</template>
            </span>
            <label class="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1">
              <input v-model="errorsOnlyAttention" type="checkbox">
              異常あり・判定できないがある行だけ
            </label>
          </div>

          <div v-if="errorsStoreError" class="text-xs text-red-600 dark:text-red-400" data-testid="litigation-errors-store-error">{{ errorsStoreError }}</div>

          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400" data-testid="litigation-errors-summary">
            <span v-for="k in LITIGATION_CHECK_KEYS" :key="k">
              {{ LITIGATION_CHECK_LABELS[k] }}: 異常あり {{ errorCounts[k].ng }} / 異常なし {{ errorCounts[k].ok }} / 判定できない {{ errorCounts[k].unknown }} / 未実行 {{ errorCounts[k].pending }}
            </span>
          </div>

          <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-x-auto">
            <table class="w-full text-sm" data-testid="litigation-errors-table">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                  <th class="text-left px-3 py-2 font-medium">乗務員</th>
                  <th class="text-left px-3 py-2 font-medium">月</th>
                  <th v-for="k in LITIGATION_CHECK_KEYS" :key="k" class="text-left px-3 py-2 font-medium">{{ LITIGATION_CHECK_LABELS[k] }}</th>
                  <th class="text-left px-3 py-2 font-medium">取り込み</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="shownErrorRows.length === 0">
                  <td :colspan="LITIGATION_CHECK_KEYS.length + 3" class="px-3 py-6 text-center text-gray-500">
                    {{ errorRows.length === 0 ? '行がありません (期間か乗務員が空です)' : '異常あり・判定できないがある行はありません' }}
                  </td>
                </tr>
                <tr
                  v-for="row in shownErrorRows"
                  :key="`${row.driverCd}|${row.month}`"
                  class="border-b border-gray-100 dark:border-gray-800 align-top"
                  :data-row="`${row.driverCd}|${row.month}`"
                >
                  <td class="px-3 py-2 whitespace-nowrap">{{ driverLabel(row.driverCd) }} ({{ row.driverCd }})</td>
                  <td class="px-3 py-2 whitespace-nowrap">
                    {{ row.month }}
                    <div v-if="litigationRowCheckedAt(errCheckedAt, `${row.driverCd}|${row.month}`)" class="text-xs text-gray-500" data-testid="litigation-row-checked-at">
                      {{ fmtCheckedAt(litigationRowCheckedAt(errCheckedAt, `${row.driverCd}|${row.month}`)!) }}
                    </div>
                  </td>
                  <td v-for="k in LITIGATION_CHECK_KEYS" :key="k" class="px-3 py-2 min-w-40" :data-check="k">
                    <span class="text-xs rounded px-2 py-0.5 whitespace-nowrap" :class="CHECK_STATE_CLASS[row.cells[k].state]">
                      {{ LITIGATION_CHECK_STATE_LABELS[row.cells[k].state] }}
                    </span>
                    <div class="text-xs text-gray-600 dark:text-gray-400 mt-1 break-all">{{ row.cells[k].message }}</div>
                  </td>
                  <td class="px-3 py-2 min-w-48">
                    <UButton
                      v-if="row.canImport"
                      icon="i-lucide-download"
                      label="theearth から取り込む"
                      size="xs"
                      variant="soft"
                      :loading="importingKey === `${row.driverCd}|${row.month}`"
                      :disabled="importingKey !== null || errorsRunning"
                      data-testid="litigation-import"
                      @click="importMonth(row)"
                    />
                    <div
                      v-for="r in importResults.get(`${row.driverCd}|${row.month}`) ?? []"
                      :key="r.from"
                      class="text-xs mt-1"
                      :class="IMPORT_KIND_CLASS[r.outcome.kind]"
                      data-testid="litigation-import-result"
                    >
                      読取日 {{ r.from }}〜{{ r.to }}: {{ r.outcome.message }}
                    </div>
                    <div
                      v-if="importResults.get(`${row.driverCd}|${row.month}`)?.some(r => r.outcome.kind === 'ok')"
                      class="text-xs text-gray-500 mt-1"
                    >
                      取り込み直後は CSV 分割が終わるまで運行が見えないことがあります。0 件のままなら数分後に「検知を実行」で読み直してください。
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="chunkWarnings.length > 0" class="text-xs text-amber-700 dark:text-amber-400 space-y-1">
            <div class="font-medium">Y時間の警告 (冊単位。月に割り振れないので表とは別に出します)</div>
            <div v-for="w in chunkWarnings" :key="`${w.driverCd}|${w.label}`">
              {{ driverLabel(w.driverCd) }} ({{ w.driverCd }}) {{ w.label }}: {{ w.warnings.join(' / ') }}<template v-if="w.warningsCount > w.warnings.length"> ほか (全 {{ w.warningsCount }} 件)</template>
            </div>
          </div>
        </div>

        <!-- 給与比較: 給与大臣の明細 × エラータブの wage-report (litigation-salary.ts) -->
        <div v-if="activeTab === 'salary'" data-testid="litigation-salary" class="space-y-3">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            拘束×賃金の給与比較と同じ比べ方で、案件の乗務員 × 月を並べます。明細の実支給 (基本給・残業代・総支給) と、計算 (基本給 = 単価マスタ × 法定時間内 / 残業・深夜・休日 = 最低賃金ベースの 残業代 + 深夜の割増 + 休日労働。拘束は GCP) の差です (+ は明細の方が多い)。
            明細は支給月 = 勤務月の翌月で合わせます。拘束の材料はエラータブの「検知を実行」か、下の「拘束の材料を取る」で取ったものを使います (未取得の月は比べられません)。
            明細はタブを開くと自動で読みます (読み直すときは「給与大臣から読み直す」)。保存済みの月はすぐ返り、保存が無い月だけ給与大臣から読んで保存します (1 社 10〜20 秒)。金額と氏名は画面を閉じると消えます。
          </p>

          <div class="flex items-center gap-3 flex-wrap">
            <UButton
              icon="i-lucide-banknote"
              label="給与大臣から読み直す"
              :loading="salaryLoading"
              :disabled="salaryLoading || caseMonths.length === 0"
              data-testid="litigation-salary-load"
              @click="loadSalaryPayroll"
            />
            <span v-if="salaryProgress" class="text-sm text-gray-600 dark:text-gray-400" data-testid="litigation-salary-progress">{{ salaryProgress }}</span>
            <template v-if="salaryNeedsMaterials">
              <UButton
                icon="i-lucide-download"
                :label="`拘束の材料を取る (続きから ${missingErrorSteps} 件)`"
                :loading="errorsRunning"
                :disabled="errorsRunning || errorsStoreLoading || !!errorsStoreError || importingKey !== null || missingErrorSteps === 0"
                data-testid="litigation-salary-materials-run"
                @click="runErrorChecks(true)"
              />
              <span class="text-xs text-gray-600 dark:text-gray-400">1 か月 15〜64 秒。エラータブの「続きから」と同じで、取れた月から保存します</span>
            </template>
            <span v-if="errorsStoreLoading" class="text-sm text-gray-500">保存済みの結果を読み込み中…</span>
            <span v-if="errorsRunning && errorsProgress" class="text-sm text-gray-600 dark:text-gray-400" data-testid="litigation-salary-materials-progress">
              検知を実行中 {{ errorsProgress.done }} / {{ errorsProgress.total }}<template v-if="errorsProgress.label"> — {{ errorsProgress.label }}</template>
            </span>
          </div>
          <div v-if="errorsStoreError" class="text-xs text-red-600 dark:text-red-400" data-testid="litigation-salary-materials-error">{{ errorsStoreError }}</div>
          <div v-if="salaryError" class="text-sm text-red-600 dark:text-red-400" data-testid="litigation-salary-error">{{ salaryError }}</div>
          <div class="text-xs text-gray-600 dark:text-gray-400" data-testid="litigation-salary-summary">
            <template v-for="(k, i) in (['ok', 'noPayroll', 'unknown', 'pending'] as const)" :key="k">{{ i > 0 ? ' / ' : '' }}{{ LITIGATION_SALARY_STATE_LABELS[k] }} {{ salaryCounts[k] }}</template>
            / <span data-testid="litigation-salary-shortfall37">37条で不足 {{ salaryShortfall37Count }} 件</span>
            / <span :class="salaryFloored37Count > 0 ? 'text-red-600 dark:text-red-400' : ''" data-testid="litigation-salary-floored37">逆算の基礎単価が最低賃金を下回り最低賃金で計算した月 {{ salaryFloored37Count }} 件</span>
            / <span :class="salaryBaseBelowMinWageCount > 0 ? 'font-bold text-red-600 dark:text-red-400' : ''" data-testid="litigation-salary-base-below-minwage">基本給が 単価 × 法定時間内 を下回る {{ salaryBaseBelowMinWageCount }} 件 (比べられない {{ salaryBaseMinWageUnknownCount }} 件)</span>
            / <span :class="salaryRateBasisCounts.mismatch > 0 ? 'font-bold text-red-600 dark:text-red-400' : ''" data-testid="litigation-salary-rate-mismatch">単価が最低賃金と違う {{ salaryRateBasisCounts.mismatch }} 件</span>
            / <span data-testid="litigation-salary-rate-unknown">単価 判定できない {{ salaryRateBasisCounts.unknown }} 件</span>
            / 明細 読込済み {{ salaryPayrollLoaded }} / {{ caseMonths.length }} か月 (サーバー保存 {{ salarySourceCounts.cache }}・給与大臣から取得 {{ salarySourceCounts.live }})
          </div>
          <MinWageFixesPanel
            v-if="openCase"
            :rows="salaryFixRows"
            :from="caseMonths[0] ?? openCase.fromMonth"
            :to="caseMonths[caseMonths.length - 1] ?? openCase.toMonth"
            :headers="authHeaders"
            :retake-label="`拘束の材料を取り直す (${caseMonths.length} か月)`"
            :retake-note="`1 か月 15〜64 秒 × ${caseMonths.length} か月。終わるまでこのタブを閉じない`"
            :retaking="errorsRunning"
            :retake-disabled="errorsStoreLoading || !!errorsStoreError || importingKey !== null || salaryRegistering"
            :force-show="salaryAttrsWritten || salaryOutdatedCount > 0"
            :driver-label="cd => `${driverLabel(cd)} (${cd})`"
            @retake="retakeWageReports"
          >
            <div v-if="salaryAttrsWritten" data-testid="litigation-salary-fix-attrs">属性を入れました。基本給の計算に反映するには下の「拘束の材料を取り直す」を押してください。</div>
            <div v-if="salaryOutdatedCount > 0" data-testid="litigation-salary-outdated">{{ wageRowOutdatedNotice(salaryOutdatedCount, '下の「拘束の材料を取り直す」を押す') }}</div>
          </MinWageFixesPanel>
          <div v-if="salaryCounts.noPayroll > 0" class="flex items-center gap-2 flex-wrap" data-testid="litigation-salary-register">
            <template v-if="salaryRegisterCandidates.length > 0">
              <span class="text-xs text-gray-600 dark:text-gray-400">明細の氏名から乗務員に一意に引き当たりました (社員マスタに未登録):</span>
              <UButton
                v-for="c in salaryRegisterCandidates"
                :key="`${c.company}|${c.payrollCd}`"
                size="xs"
                icon="i-lucide-user-plus"
                :label="`社員マスタに登録: ${c.payrollCd} ${c.name} (会社 ${c.company}) → 乗務員 ${c.driverCd}`"
                :loading="salaryRegistering"
                :disabled="salaryRegistering || salaryLoading"
                data-testid="litigation-salary-register-button"
                @click="registerSalaryEmployee(c)"
              />
            </template>
            <span v-else class="text-xs text-gray-600 dark:text-gray-400" data-testid="litigation-salary-register-hint">
              「明細なし」の乗務員を明細の氏名から一意に引き当てられません (同姓同名・氏名の違い・既に登録済みの給与コード)。拘束×賃金の社員マスタタブで給与コードと乗務員CD を登録してください
            </span>
          </div>
          <div v-if="salaryRegisterMessage" class="text-xs text-gray-700 dark:text-gray-300" data-testid="litigation-salary-register-message">{{ salaryRegisterMessage }}</div>
          <div v-if="salaryAttrsCandidates.length > 0" class="flex items-center gap-2 flex-wrap" data-testid="litigation-salary-attrs">
            <UButton
              v-for="c in salaryAttrsCandidates"
              :key="`${c.company}|${c.payrollCd}`"
              size="xs"
              icon="i-lucide-list-plus"
              :label="`属性を入れる: ${c.payrollCd} ${c.name} (会社 ${c.company}) — 給与大臣の区分・所属を ${caseMonths[0]} 付けで入れる`"
              :loading="salaryRegistering"
              :disabled="salaryRegistering || salaryLoading"
              data-testid="litigation-salary-attrs-button"
              @click="saveSalaryEmployee(c, false)"
            />
          </div>

          <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-x-auto">
            <table class="w-full text-sm" data-testid="litigation-salary-table">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-left">
                  <th class="px-3 py-2 font-medium">乗務員</th>
                  <th class="px-3 py-2 font-medium">勤務月 (支給月)</th>
                  <th class="px-3 py-2 font-medium">状態</th>
                  <th class="px-3 py-2 font-medium text-right" title="明細 = 割増基礎に入る支給 (区分 base: 基本給の項目 + 手当) の合計 / 計算 = 単価マスタ (最低賃金) × 法定時間内 (wage report の金額。単価が無い月は計算なし)。差 = 明細 − 計算 (明細が下回る月は赤太字)">基本給</th>
                  <th class="px-3 py-2 font-medium text-right" title="明細 = 残業代扱いの支給 (区分 overtime: 残業・深夜・休日出勤の手当) の合計 / 計算 = 最低賃金ベースの 残業代 (時間外 + 週40時間超 + 時間外深夜) + 法定時間内の深夜の割増 + 休日労働 (wage report の金額。内訳は根拠の行)。最低賃金が引けない月・拘束が欠測の月・古い形の拘束の材料の月は計算なし">残業・深夜・休日</th>
                  <th class="px-3 py-2 font-medium text-right">総支給</th>
                  <th class="px-3 py-2 font-medium text-right" title="基礎単価 = 逆算の単価と最低賃金の高いほう。逆算の単価 = 割増の基礎に入る支給 ÷ wage report の法定時間内 (実働を週 40 時間で頭打ちにした時間。時給の人は明細の時給そのもの)。逆算が最低賃金を下回る月は最低賃金を採用する (根拠の行が赤)。理論値 = 残業・深夜・休日(計算) × 基礎単価 ÷ 最低賃金 (割増の規則は wage report のもの)">残業・深夜・休日 (37条)</th>
                  <th class="px-3 py-2 font-medium" title="計算に使った単価 = 単価マスタ (最低賃金の一括設定で入れた額)。その月の最低賃金と違う月はエラー">単価 (最低賃金)</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in salaryRows"
                  :key="`${row.driverCd}|${row.month}`"
                  class="border-b border-gray-100 dark:border-gray-800 align-top"
                  :data-salary-row="`${row.driverCd}|${row.month}`"
                >
                  <td class="px-3 py-2 whitespace-nowrap">{{ driverLabel(row.driverCd) }} ({{ row.driverCd }})</td>
                  <td class="px-3 py-2 whitespace-nowrap">{{ row.month }} <span class="text-xs text-gray-500">({{ row.payMonth }})</span>
                    <div v-if="salaryPayrollSync.get(row.payMonth)" class="text-xs text-gray-500" data-salary-source>{{ fmtPayrollSync(salaryPayrollSync.get(row.payMonth)!) }}</div>
                  </td>
                  <td class="px-3 py-2 min-w-40">
                    <span class="text-xs rounded px-2 py-0.5 whitespace-nowrap" :class="SALARY_STATE_CLASS[row.state]">{{ LITIGATION_SALARY_STATE_LABELS[row.state] }}</span>
                    <div v-if="row.message" class="text-xs text-gray-600 dark:text-gray-400 mt-1">{{ row.message }}</div>
                    <div v-if="row.payrollNote" class="text-xs text-gray-600 dark:text-gray-400 mt-1" data-salary-payroll>{{ row.payrollNote }}</div>
                  </td>
                  <template v-if="row.compared">
                    <td
                      v-for="cell in salaryRowCells(row.compared).amounts"
                      :key="cell.key"
                      class="px-3 py-2 whitespace-nowrap"
                      :data-salary-cell="cell.key"
                    >
                      <SalaryAmountCell :cell="cell" :overtime-fixed="salaryRowCells(row.compared).overtimeFixed" />
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap" data-salary-cell="over37">
                      <SalaryOver37Cell :over37="salaryRowCells(row.compared).over37" :none-reason="salaryRowCells(row.compared).over37NoneReason" />
                    </td>
                    <td class="px-3 py-2 text-xs min-w-48" data-salary-cell="rate-basis" :data-rate-status="rateBasisStatus(row.compared.rateBasis).status">
                      <div data-salary-line="rate-basis">単価 {{ rateBasisLabel(row.compared.rateBasis) }}</div>
                      <div :class="RATE_BASIS_CLASS[rateBasisStatus(row.compared.rateBasis).status]" data-salary-line="rate-basis-status">{{ rateBasisStatus(row.compared.rateBasis).message }}</div>
                    </td>
                  </template>
                  <td v-else colspan="5" class="px-3 py-2 text-xs text-gray-400">-</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 変更記録: 打刻 (relay) + 運行 (alc-proxy) — 取り込んだ時点の値を基準に、あとで変わった記録 -->
        <div v-if="activeTab === 'changes'" data-testid="litigation-changes" class="space-y-3">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            案件の乗務員ごとに、取り込んだ時点の値を基準にあとで変わった記録 (打刻の変更・運行データの上げ直し/手動削除) を
            記録時刻の新しい順に並べます。記録は仕組みを作った日 (2026-09-25) からで、それより前の変更は記録されていません。
          </p>

          <div class="flex items-center gap-3 flex-wrap">
            <UButton
              icon="i-lucide-history"
              label="検知を実行"
              :loading="changesRunning"
              :disabled="changesRunning || errorsRunning || importingKey !== null || !openCase || openCase.driverCds.length === 0"
              data-testid="litigation-changes-run"
              @click="runChangesFetch"
            />
            <span v-if="changesFinished" class="text-sm text-gray-600 dark:text-gray-400" data-testid="litigation-changes-count">
              {{ changesRows.length }} 件
            </span>
          </div>

          <UAlert
            :color="changesKintaiForbidden ? 'error' : 'neutral'"
            :title="kintaiChangesNotice"
            data-testid="litigation-changes-kintai-notice"
          />
          <UAlert
            v-if="!changesKintaiForbidden && changesKintaiErrors.length > 0"
            color="warning"
            :title="`打刻の変更記録の一部が読めませんでした (${changesKintaiErrors.length} 件): ${changesKintaiErrors.join(' / ')}`"
          />
          <UAlert color="neutral" :title="alcChangesNotice" data-testid="litigation-changes-alc-notice" />
          <UAlert
            v-if="changesAlcErrors.length > 0"
            color="warning"
            :title="`運行の変更記録の一部が読めませんでした (${changesAlcErrors.length} 件): ${changesAlcErrors.join(' / ')}`"
          />

          <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-x-auto">
            <table class="w-full text-sm" data-testid="litigation-changes-table">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                  <th class="text-left px-3 py-2 font-medium">記録日時</th>
                  <th class="text-left px-3 py-2 font-medium">種別</th>
                  <th class="text-left px-3 py-2 font-medium">対象</th>
                  <th class="text-left px-3 py-2 font-medium">内容</th>
                  <th class="text-left px-3 py-2 font-medium">理由</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="changesRows.length === 0">
                  <td colspan="5" class="px-3 py-6 text-center text-gray-500">
                    {{ changesFinished ? '変更記録はありません' : '「検知を実行」を押してください' }}
                  </td>
                </tr>
                <tr
                  v-for="(row, i) in changesRows"
                  :key="`${row.kind}|${row.recordedAtSort}|${i}`"
                  class="border-b border-gray-100 dark:border-gray-800 align-top"
                >
                  <td class="px-3 py-2 whitespace-nowrap">{{ row.recordedAt }}</td>
                  <td class="px-3 py-2 whitespace-nowrap">{{ row.kind }}</td>
                  <td class="px-3 py-2 whitespace-nowrap font-mono text-xs">{{ row.target }}</td>
                  <td class="px-3 py-2">{{ row.summary }}</td>
                  <td class="px-3 py-2 whitespace-nowrap">{{ row.reason }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 印刷用の紙面 (画面には出さない)。案件の概要 + いま開いているタブの中身だけ -->
      <div v-if="openCase" class="hidden print:block litigation-print" data-testid="litigation-print-sheet">
        <h1 class="text-base font-bold">訴訟準備: {{ openCase.name }}</h1>
        <div class="litigation-print-meta">
          期間 {{ openCase.fromMonth }}〜{{ openCase.toMonth }} ({{ caseMonths.length }}か月) / 会社 {{ dtakoCompDisplay(viewerComp) }} / 乗務員: {{ driversText(openCase.driverCds) }}
          <template v-if="printedAt"> / 印刷 {{ printedAt }}</template>
        </div>
        <div v-if="openCase.memo" class="litigation-print-meta">メモ: {{ openCase.memo }}</div>

        <div v-if="activeTab === 'output'" data-testid="litigation-print-output">
        <h2 class="font-bold mt-2">出力 (Y時間 Excel)</h2>
        <div v-if="restoredOutput" class="litigation-print-meta" data-testid="litigation-print-restored">{{ restoredOutputText }}</div>
        <table class="litigation-print-table">
          <thead>
            <tr><th>乗務員</th><th>期間</th><th>ファイル名</th><th>状態</th><th>結果</th></tr>
          </thead>
          <tbody>
            <tr v-for="(chunk, i) in outputChunks" :key="chunk.filename">
              <td>{{ driverLabel(chunk.driverCd) }} ({{ chunk.driverCd }})</td>
              <td>{{ chunk.label }}</td>
              <td>{{ chunk.filename }}</td>
              <td>{{ shownOutputResults[i] ? OUTPUT_STATUS_LABEL[shownOutputResults[i]!.status] : '未実行' }}</td>
              <td>
                <template v-if="shownOutputResults[i]">
                  {{ shownOutputResults[i]!.message }}<template v-for="line in litigationOutputSourceLines(shownOutputResults[i]!)" :key="line.kind"> / {{ line.text }}</template><template v-if="shownOutputResults[i]!.missingCount > 0"> / 書けなかった日 {{ shownOutputResults[i]!.missingCount }} 日</template><template v-if="shownOutputResults[i]!.warningsCount > 0"> / 警告 {{ shownOutputResults[i]!.warningsCount }} 件</template>
                </template>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="outputChunkWarnings.length > 0" class="litigation-print-meta">
          Y時間の警告 (冊単位):
          <template v-for="w in outputChunkWarnings" :key="`${w.driverCd}|${w.label}`">{{ driverLabel(w.driverCd) }} ({{ w.driverCd }}) {{ w.label }}: {{ w.warnings.join(' / ') }}<template v-if="w.warningsCount > w.warnings.length"> ほか (全 {{ w.warningsCount }} 件)</template>。</template>
        </div>

        <LitigationMonthlyHoursTable v-if="printHoursBooks.length > 0" :books="printHoursBooks" :driver-label="driverLabel" compact />
        </div>

        <div v-if="activeTab === 'errors'" data-testid="litigation-print-errors">
        <h2 class="font-bold mt-2">エラー</h2>
        <div class="litigation-print-meta">
          <template v-for="(k, i) in LITIGATION_CHECK_KEYS" :key="k">{{ i > 0 ? ' / ' : '' }}{{ LITIGATION_CHECK_LABELS[k] }}: 異常あり {{ errorCounts[k].ng }}・異常なし {{ errorCounts[k].ok }}・判定できない {{ errorCounts[k].unknown }}・未実行 {{ errorCounts[k].pending }}</template>
        </div>
        <table class="litigation-print-table">
          <thead>
            <tr>
              <th>乗務員</th><th>月</th>
              <th v-for="k in LITIGATION_CHECK_KEYS" :key="k">{{ LITIGATION_CHECK_LABELS[k] }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in errorRows" :key="`${row.driverCd}|${row.month}`">
              <td>{{ driverLabel(row.driverCd) }} ({{ row.driverCd }})</td>
              <td>{{ row.month }}</td>
              <td v-for="k in LITIGATION_CHECK_KEYS" :key="k">
                <b>{{ LITIGATION_CHECK_STATE_LABELS[row.cells[k].state] }}</b> {{ row.cells[k].message }}
              </td>
            </tr>
          </tbody>
        </table>

        </div>

        <div v-if="activeTab === 'salary'" class="litigation-print-salary" data-testid="litigation-print-salary">
          <h2 class="font-bold mt-2">給与比較</h2>
          <div v-if="salaryPayrollLoaded === 0" class="litigation-print-meta" data-testid="litigation-print-salary-empty">
            給与比較は給与比較タブで明細を読み込むと印刷に入ります。
          </div>
          <template v-else>
            <div class="litigation-print-meta">
              <template v-for="(k, i) in (['ok', 'noPayroll', 'unknown', 'pending'] as const)" :key="k">{{ i > 0 ? ' / ' : '' }}{{ LITIGATION_SALARY_STATE_LABELS[k] }} {{ salaryCounts[k] }}</template>
              / 37条で不足 {{ salaryShortfall37Count }} 件 / 逆算の基礎単価が最低賃金を下回り最低賃金で計算した月 {{ salaryFloored37Count }} 件
              / 基本給が 単価 × 法定時間内 を下回る {{ salaryBaseBelowMinWageCount }} 件 (比べられない {{ salaryBaseMinWageUnknownCount }} 件)
              / 単価が最低賃金と違う {{ salaryRateBasisCounts.mismatch }} 件 / 単価 判定できない {{ salaryRateBasisCounts.unknown }} 件
              / 明細 読込済み {{ salaryPayrollLoaded }} / {{ caseMonths.length }} か月 (サーバー保存 {{ salarySourceCounts.cache }}・給与大臣から取得 {{ salarySourceCounts.live }})
            </div>
            <div v-if="salaryOutdatedCount > 0" class="litigation-print-meta" data-testid="litigation-print-salary-outdated">{{ wageRowOutdatedNotice(salaryOutdatedCount, '画面の「拘束の材料を取り直す」を押す') }}</div>
            <div class="litigation-print-meta font-bold mt-1">計算に使った単価 (単価マスタ)</div>
            <table class="litigation-print-table" data-testid="litigation-print-rate-periods">
              <thead>
                <tr><th>乗務員</th><th>期間 (勤務月)</th><th>単価</th><th>適用年月</th><th>県</th><th>最低賃金と違う月</th></tr>
              </thead>
              <tbody>
                <tr v-if="salaryRatePeriods.length === 0"><td colspan="6">- (比較済みの月が無い)</td></tr>
                <tr
                  v-for="p in salaryRatePeriods"
                  :key="`${p.driverCd}|${p.from}`"
                  :class="p.mismatchMonths > 0 ? 'font-bold text-red-600' : ''"
                  :data-print-rate-period="`${p.driverCd}|${p.from}`"
                >
                  <td>{{ driverLabel(p.driverCd) }} ({{ p.driverCd }})</td>
                  <td>{{ p.from === p.to ? p.from : `${p.from}〜${p.to}` }} ({{ p.months }} か月)</td>
                  <td class="text-right">{{ p.hourlyRate === null ? '単価なし' : `${fmtRatePerHour(p.hourlyRate)} 円/h` }}</td>
                  <td>{{ p.effectiveFrom ? p.effectiveFrom.slice(0, 7) : '不明' }}</td>
                  <td>{{ p.prefecture ?? '-' }}</td>
                  <td>
                    <template v-if="p.mismatchMonths > 0">{{ p.mismatchMonths }} か月 — 最低賃金 {{ p.mismatchMinWages.join(' / ') }}</template>
                    <template v-else-if="p.unknownMonths > 0">0 か月 (判定できない {{ p.unknownMonths }} か月)</template>
                    <template v-else>0 か月</template>
                  </td>
                </tr>
              </tbody>
            </table>
            <table class="litigation-print-table">
              <thead>
                <tr>
                  <th>乗務員</th><th>勤務月 (支給月)</th><th>状態</th>
                  <th>基本給</th><th>残業・深夜・休日</th><th>総支給</th><th>残業・深夜・休日 (37条)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in salaryRows" :key="`${row.driverCd}|${row.month}`" :data-print-salary-row="`${row.driverCd}|${row.month}`">
                  <td>{{ driverLabel(row.driverCd) }} ({{ row.driverCd }})</td>
                  <td>{{ row.month }} ({{ row.payMonth }})
                    <div v-if="salaryPayrollSync.get(row.payMonth)" class="text-[7px]">{{ fmtPayrollSync(salaryPayrollSync.get(row.payMonth)!) }}</div>
                  </td>
                  <td>
                    {{ LITIGATION_SALARY_STATE_LABELS[row.state] }}
                    <div v-if="row.message">{{ row.message }}</div>
                    <div v-if="row.payrollNote">{{ row.payrollNote }}</div>
                  </td>
                  <template v-if="row.compared">
                    <td v-for="cell in salaryRowCells(row.compared).amounts" :key="cell.key">
                      <SalaryAmountCell :cell="cell" :overtime-fixed="salaryRowCells(row.compared).overtimeFixed" compact />
                    </td>
                    <td><SalaryOver37Cell :over37="salaryRowCells(row.compared).over37" :none-reason="salaryRowCells(row.compared).over37NoneReason" compact /></td>
                  </template>
                  <td v-else colspan="4">-</td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <div v-if="activeTab === 'changes'" data-testid="litigation-print-changes">
        <h2 class="font-bold mt-2">変更記録</h2>
        <div class="litigation-print-meta">
          <template v-if="changesFinished">{{ kintaiChangesNotice }} / {{ alcChangesNotice }}</template>
          <template v-else>変更記録タブで「検知を実行」を押していません。</template>
        </div>
        <table class="litigation-print-table">
          <thead>
            <tr><th>記録日時</th><th>種別</th><th>対象</th><th>内容</th><th>理由</th></tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in changesRows" :key="`${row.kind}|${row.recordedAtSort}|${i}`">
              <td>{{ row.recordedAt }}</td>
              <td>{{ row.kind }}</td>
              <td>{{ row.target }}</td>
              <td>{{ row.summary }}</td>
              <td>{{ row.reason }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style>
/* 印刷は余白優先 — 頭揃えより詰める (1 枚に入る行を増やす)。サイドバーと画面の操作部は消す */
@media print {
  aside { display: none !important; }
  main { padding: 0 !important; overflow: visible !important; }
  @page { size: A4 landscape; margin: 6mm; }
  .litigation-print { font-size: 8.5px; line-height: 1.25; color: #000; }
  .litigation-print h1 { font-size: 12px; margin: 0 0 2px; }
  .litigation-print h2 { font-size: 10px; margin: 4px 0 1px; }
  .litigation-print-meta { margin: 1px 0; }
  .litigation-print-table { width: 100%; border-collapse: collapse; }
  .litigation-print-table th, .litigation-print-table td { border: 1px solid #999; padding: 1px 3px; text-align: left; vertical-align: top; }
  .litigation-print-table th { background: #eee; }
  .litigation-print-table tr { break-inside: avoid; }
  /* 月ごとの時間: 1 冊を 1 枚の中に収める。表は中身の幅に詰め、時間は右寄せ */
  .litigation-hours-book { break-inside: avoid; margin-top: 3px; }
  .litigation-print-table.litigation-hours-table { width: auto; }
  .litigation-print-table td.litigation-hours-num { text-align: right; }
  .litigation-print-salary { font-size: 7.5px; }
  .litigation-print-salary .litigation-print-table td { padding: 0 2px; }
}
</style>
