<script setup lang="ts">
/**
 * 訴訟用の準備ページ (Refs #1133 c1133-1)。
 *
 * 「何月から何月まで・どの乗務員の勤務を記録するか」を選び、案件として保存して
 * 開き直せる土台。案件を「開く」と詳細にタブが出る。「出力」タブ (#c1133-2) は
 * 案件の乗務員 × 期間ぶんの Y時間 Excel を作って 1 つの ZIP にまとめる。
 * 「エラー」タブ (#c1133-5) は乗務員 × 月ごとに 4 つの検知 (alc の運行 0 件 /
 * Y時間の欠け / alc にあって勤怠に無い運行 / 最低賃金の不変条件) を並べ、alc に運行が無い月は
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
import { getDrivers, getYTimePreview, getDtakoOperationChanges, currentAccessToken, getViewerComps } from '~/utils/api'
import { caughtErrorStatus, describeCaughtError, describeResponseFailure } from '~/utils/api-error'
import { downloadBlob } from '~/utils/download-blob'
import {
  buildLitigationOutputChunks,
  countLitigationResults,
  litigationResultFromFailure,
  litigationResultFromHeaders,
  litigationZipFilename,
  LITIGATION_TEMPLATE_KEY,
  type LitigationOutputChunk,
  type LitigationOutputResult,
  type LitigationOutputStatus,
} from '~/utils/litigation-output'
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
  litigationErrorsCsv,
  litigationImportRanges,
  litigationMonthBounds,
  litigationRowNeedsAttention,
  LITIGATION_CHECK_KEYS,
  LITIGATION_CHECK_LABELS,
  LITIGATION_CHECK_STATE_LABELS,
  LITIGATION_ERRORS_CSV_FILENAME,
  type LitigationAlcOpsEntry,
  type LitigationCheckState,
  type LitigationErrorRow,
  type LitigationFetched,
  type LitigationImportOutcome,
} from '~/utils/litigation-errors'
import { parseKintaiUnkoGaps, type KintaiUnkoGaps } from '~/utils/kintai-unko-gaps'
import {
  alcRecordingSinceNotice,
  buildAlcChangeRows,
  buildKintaiChangeRows,
  KINTAI_CHANGE_LOG_FORBIDDEN_NOTICE,
  kintaiRecordingSinceNotice,
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
import { monthRange, type WageReportResponse } from '~/utils/restraint-wage-view'
import { b64urlUtf8 } from '~/composables/useTheearthSession'
import { dtakoCompDisplay, pickViewerComp, viewerCompOptions } from '~/utils/dtako-comps'
import {
  addDriverCd,
  buildLitigationCaseSavePayload,
  emptyLitigationCaseForm,
  LITIGATION_CASE_MAX_MONTHS,
  litigationCaseMonthCount,
  litigationCaseToForm,
  removeDriverCd,
  validateLitigationCaseForm,
  type LitigationCaseFormError,
  type LitigationCaseFormInput,
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
  openCaseId.value = null
}

/** restraint-wage.vue の authHeaders と同じ組み立て。 */
function authHeaders(): Record<string, string> {
  const token = currentAccessToken()
  return {
    'X-Theearth-Comp-Id': viewerComp.value,
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
    pageError.value = describeCaughtError(e, '「保存」を押してやり直してください')
  }
  finally {
    saving.value = false
  }
}

const deleting = ref<string | null>(null)

async function deleteCase(entry: LitigationCaseRecord) {
  if (!confirm(`案件「${entry.name}」を削除しますか？この操作は取り消せません。`)) return
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
 * 区切りごとの結果。**後続のエラータブ (#c1133-5) がこの状態を読む** ので、
 * ページの状態として持つ (保存はしない)。添字は `outputChunks` と揃える。
 */
const outputResults = ref<(LitigationOutputResult | null)[]>([])
const outputRunning = ref(false)
const outputCurrent = ref(-1)
const outputFinished = ref(false)
const outputZipMessage = ref('')
const outputZipError = ref('')

// 別の案件を開いた・案件を編集して期間/乗務員が変わったら、前の結果は捨てる
watch(() => [openCase.value?.caseId, openCase.value?.updatedAt], () => {
  if (outputRunning.value) return
  outputResults.value = []
  outputCurrent.value = -1
  outputFinished.value = false
  outputZipMessage.value = ''
  outputZipError.value = ''
})

const outputDoneCount = computed(() => outputResults.value.filter(r => r !== null).length)
const outputCounts = computed(() =>
  countLitigationResults(outputResults.value.filter((r): r is LitigationOutputResult => r !== null)))

const OUTPUT_RETRY = '「ZIP を作る」を押してやり直してください'

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
    // 運行 0 件の冊は ZIP に入れない (空の Excel を「働いていない」と読ませない)
    const bytes = result.status === 'ok' ? await res.arrayBuffer() : undefined
    return { result, bytes }
  }
  catch (e) {
    return { result: litigationResultFromFailure(chunk, null, null, describeCaughtError(e, OUTPUT_RETRY)) }
  }
}

async function buildOutputZip() {
  const target = openCase.value
  const chunks = outputChunks.value
  if (!target || chunks.length === 0 || outputRunning.value) return
  outputRunning.value = true
  outputFinished.value = false
  outputZipMessage.value = ''
  outputZipError.value = ''
  outputResults.value = chunks.map(() => null)
  const files: { filename: string, bytes: ArrayBuffer }[] = []
  try {
    // 上流 (alc) は乗務員 1 名・期間 1 本しか受けないので、区切りごとに 1 回ずつ直列に呼ぶ
    for (const [i, chunk] of chunks.entries()) {
      outputCurrent.value = i
      const { result, bytes } = await runOutputChunk(chunk)
      outputResults.value[i] = result
      if (bytes) files.push({ filename: chunk.filename, bytes })
    }
    outputCurrent.value = -1
    const zip = new JSZip()
    for (const f of files) zip.file(f.filename, f.bytes)
    // エラー一覧 (エラータブの今の表) も入れる。Y時間の欠けはいま作った結果で埋まり、
    // エラータブで検知を実行していない列は「未実行」のまま出る (0 件とは書かない)
    zip.file(LITIGATION_ERRORS_CSV_FILENAME, errorsCsvText())
    // 変更記録 (変更記録タブで「検知を実行」していなければ、その旨を備考に書いた空表になる)
    zip.file(LITIGATION_CHANGES_CSV_FILENAME, changesCsvText())
    const blob = await zip.generateAsync({ type: 'blob' })
    const zipName = litigationZipFilename(target.name, new Date())
    downloadBlob(blob, zipName)
    const csvNames = `${LITIGATION_ERRORS_CSV_FILENAME} / ${LITIGATION_CHANGES_CSV_FILENAME}`
    if (files.length === 0) {
      // Excel が無くても CSV 2 本は成果物なので保存はする。ただし成功の見た目にしない
      outputZipError.value = `Excel が 1 冊もできませんでした (下の表の理由を見てください)。${zipName} には ${csvNames} だけを入れて保存しました`
      return
    }
    outputZipMessage.value = `${zipName} を保存しました (Excel ${files.length} / ${chunks.length} 冊 + ${csvNames})`
  }
  catch (e) {
    outputZipError.value = `ZIP を組めませんでした: ${describeCaughtError(e, OUTPUT_RETRY)}`
  }
  finally {
    outputRunning.value = false
    outputCurrent.value = -1
    outputFinished.value = true
  }
}

// --- エラータブ: 乗務員 × 月ごとに 4 つの検知を並べる (litigation-errors.ts の doc 参照) ---
const caseMonths = computed<string[]>(() =>
  openCase.value ? monthRange(openCase.value.fromMonth, openCase.value.toMonth, LITIGATION_CASE_MAX_MONTHS) : [])

/** キー `乗務員CD|YYYY-MM` */
const errAlcOps = ref(new Map<string, LitigationAlcOpsEntry>())
/** キー `乗務員CD|YYYY-MM` */
const errUnkoGaps = ref(new Map<string, LitigationFetched<KintaiUnkoGaps>>())
/** キー `YYYY-MM` (会社全体を 1 回で読む) */
const errWageReports = ref(new Map<string, LitigationFetched<WageReportResponse>>())
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
  errorsRunning.value = false
  errorsFinished.value = false
  errorsProgress.value = null
  importResults.value = new Map()
})

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
}

async function loadUnkoGaps(epoch: number, driverCd: string, month: string) {
  let entry: LitigationFetched<KintaiUnkoGaps>
  try {
    const res = await $fetch<unknown>('/restraint-api/kintai/unko-gaps', {
      headers: authHeaders(),
      query: { month, driver_cd: driverCd },
    })
    entry = { ok: true, value: parseKintaiUnkoGaps(res) }
  }
  catch (e) {
    entry = { ok: false, reason: describeCaughtError(e, ERRORS_RETRY) }
  }
  if (epoch !== errorsEpoch) return
  errUnkoGaps.value.set(litigationDriverMonthKey(driverCd, month), entry)
}

/** 最低賃金の不変条件は GCP の拘束で計算した wage-report にだけ付く (Refs #1123)。
 * **読むだけ** — wage-snapshot (最低賃金チェックの自動保存) は呼ばない。 */
async function loadWageReport(epoch: number, month: string) {
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
  errWageReports.value.set(month, entry)
}

/** 4 つの検知を**直列に**回す (wage-report は 1 か月 15〜64 秒かかり、同じ DO を奪い合わせない)。
 * 軽いものから先に回し、最後に wage-report を月ごとに読む。 */
async function runErrorChecks() {
  const target = openCase.value
  if (!target || errorsRunning.value) return
  const epoch = ++errorsEpoch
  const months = caseMonths.value
  const steps: { label: string, run: () => Promise<void> }[] = [
    ...outputChunks.value.map(c => ({
      label: `alc の運行 ${c.driverCd} ${c.label}`,
      run: () => loadAlcOps(epoch, c.driverCd, c.from, c.to, litigationChunkMonths(c)),
    })),
    ...target.driverCds.flatMap(cd => months.map(m => ({
      label: `勤怠に無い運行 ${cd} ${m}`,
      run: () => loadUnkoGaps(epoch, cd, m),
    }))),
    ...months.map(m => ({
      label: `最低賃金の不変条件 ${m} (1 か月 15〜64 秒)`,
      run: () => loadWageReport(epoch, m),
    })),
  ]
  errAlcOps.value = new Map()
  errUnkoGaps.value = new Map()
  errWageReports.value = new Map()
  errorsRunning.value = true
  errorsFinished.value = false
  errorsProgress.value = { done: 0, total: steps.length, label: '' }
  try {
    for (const [i, step] of steps.entries()) {
      if (epoch !== errorsEpoch) return
      errorsProgress.value = { done: i, total: steps.length, label: step.label }
      await step.run()
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
 * theearth のセッションロック)。1 本でも取り込めたら、その行の alc の運行と「勤怠に無い運行」を
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

/** エラー一覧 CSV (ZIP に入れる)。氏名は乗務員一覧に居る人だけ、居なければ空欄 */
function errorsCsvText(): string {
  return litigationErrorsCsv(
    errorRows.value,
    cd => drivers.value.find(d => d.driver_cd === cd)?.driver_name ?? '',
    chunkWarnings.value,
  )
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
  noBaseline: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}
const IMPORT_KIND_CLASS: Record<LitigationImportOutcome['kind'], string> = {
  ok: 'text-green-700 dark:text-green-400',
  empty: 'text-gray-600 dark:text-gray-400',
  forbidden: 'text-red-700 dark:text-red-400',
  error: 'text-red-700 dark:text-red-400',
}

// --- 印刷: 案件の概要 + 出力の結果 + エラーの表を 1 つの紙面に ---
const printedAt = ref('')
function printCase() {
  printedAt.value = fmtDateTime(new Date().toISOString())
  // printedAt の描画を待ってから開く
  nextTick(() => window.print())
}

/** 状態の短い名前。**0 件・未登録・失敗を同じ見た目にしない** (map skill「PR の基準」(7)) */
const OUTPUT_STATUS_LABEL: Record<LitigationOutputStatus, string> = {
  ok: '作成',
  empty: '運行 0 件',
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
            <UButton icon="i-lucide-printer" label="印刷" variant="soft" size="sm" data-testid="litigation-print" @click="printCase" />
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
            案件の乗務員 × 期間ぶんの Y時間 Excel (京都ソフト案件のテンプレ) を作り、1 つの ZIP で保存します。
            1 冊 = 乗務員 1 名 × 最大 12 か月 (開始月から 12 か月ごとに区切ります)。
            1 冊あたり 5〜15 秒かかります。運行 0 件・alc に未登録・失敗の冊は ZIP に入れず、下の表に残します。
            ZIP には {{ LITIGATION_ERRORS_CSV_FILENAME }} (エラータブの表) と {{ LITIGATION_CHANGES_CSV_FILENAME }} (変更記録タブの表) も入れます — どちらもタブで検知を実行していない場合は、その旨を書いた空の表になります。
          </p>

          <div class="flex items-center gap-3 flex-wrap">
            <UButton
              icon="i-lucide-file-archive"
              label="ZIP を作る"
              :loading="outputRunning"
              :disabled="outputRunning || outputChunks.length === 0"
              @click="buildOutputZip"
            />
            <span v-if="outputRunning || outputFinished" class="text-sm text-gray-600 dark:text-gray-400" data-testid="litigation-output-progress">
              {{ outputDoneCount }} / {{ outputChunks.length }} 冊
              <template v-if="outputFinished">
                (作成 {{ outputCounts.ok }} / 運行 0 件 {{ outputCounts.empty }} / alc に未登録 {{ outputCounts.not_found }} / 失敗 {{ outputCounts.error }})
              </template>
            </span>
            <span v-if="outputChunks.length === 0" class="text-sm text-gray-500">区切りがありません (期間か乗務員が空です)</span>
          </div>

          <UAlert v-if="outputZipMessage" color="success" :title="outputZipMessage" />
          <UAlert v-if="outputZipError" color="error" :title="outputZipError" />

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
                    <span v-if="outputResults[i]" class="text-xs rounded px-2 py-0.5" :class="OUTPUT_STATUS_CLASS[outputResults[i]!.status]">
                      {{ OUTPUT_STATUS_LABEL[outputResults[i]!.status] }}
                    </span>
                    <span v-else-if="outputRunning && outputCurrent === i" class="text-xs text-gray-500">
                      <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin mr-1" />作成中
                    </span>
                    <span v-else class="text-xs text-gray-400">未実行</span>
                  </td>
                  <td class="px-4 py-2">
                    <template v-if="outputResults[i]">
                      <div>{{ outputResults[i]!.message }}</div>
                      <div v-if="outputResults[i]!.missingCount > 0" class="text-xs text-amber-700 dark:text-amber-400 mt-1">
                        テンプレに行が無く書けなかった日 {{ outputResults[i]!.missingCount }} 日
                        ({{ outputResults[i]!.missingDates.join(', ') }}<template v-if="outputResults[i]!.missingCount > outputResults[i]!.missingDates.length"> ほか</template>)
                      </div>
                      <div v-if="outputResults[i]!.warningsCount > 0" class="text-xs text-amber-700 dark:text-amber-400 mt-1">
                        警告 {{ outputResults[i]!.warningsCount }} 件: {{ outputResults[i]!.warnings.join(' / ') }}<template v-if="outputResults[i]!.warningsCount > outputResults[i]!.warnings.length"> ほか</template>
                      </div>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- エラー: 乗務員 × 月ごとに 4 つの検知 (litigation-errors.ts) -->
        <div v-if="activeTab === 'errors'" data-testid="litigation-errors" class="space-y-3">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            乗務員 × 月ごとに、alc の運行が 0 件か・Y時間に書けなかった日があるか・alc にあるのに勤怠 (オンプレから運んだ運行) に無い運行があるか・
            最低賃金の不変条件 (条件1〜3、拘束は GCP) が崩れていないかを並べます。
            「判定できない」は調べたが材料が取れなかった月で、異常なしではありません。
            「照合先なし」はその月の勤怠にこの乗務員の運行が 1 件も無く、alc の運行と突き合わせる相手が無い月です (異常とは数えません)。
            Y時間の欠けは「検知を実行」の Y時間 プレビューから判定します (出庫/帰庫が無い・運行の中身が取れないなどで Y時間 に入らなかった運行)。出力タブで ZIP を作った後は、テンプレに書けなかった日も加えます。最低賃金の不変条件は 1 か月 15〜64 秒かかります (読むだけで保存はしません)。
          </p>

          <div class="flex items-center gap-3 flex-wrap">
            <UButton
              icon="i-lucide-search-check"
              label="検知を実行"
              :loading="errorsRunning"
              :disabled="errorsRunning || importingKey !== null || errorRows.length === 0"
              data-testid="litigation-errors-run"
              @click="runErrorChecks"
            />
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

          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400" data-testid="litigation-errors-summary">
            <span v-for="k in LITIGATION_CHECK_KEYS" :key="k">
              {{ LITIGATION_CHECK_LABELS[k] }}: 異常あり {{ errorCounts[k].ng }} / 異常なし {{ errorCounts[k].ok }} / 判定できない {{ errorCounts[k].unknown }} / 未実行 {{ errorCounts[k].pending }}<template v-if="errorCounts[k].noBaseline > 0"> / 照合先なし {{ errorCounts[k].noBaseline }}</template>
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
                  <td class="px-3 py-2 whitespace-nowrap">{{ row.month }}</td>
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

      <!-- 印刷用の紙面 (画面には出さない)。案件の概要 + 出力の結果 + エラーの表 -->
      <div v-if="openCase" class="hidden print:block litigation-print" data-testid="litigation-print-sheet">
        <h1 class="text-base font-bold">訴訟準備: {{ openCase.name }}</h1>
        <div class="litigation-print-meta">
          期間 {{ openCase.fromMonth }}〜{{ openCase.toMonth }} ({{ caseMonths.length }}か月) / 会社 {{ dtakoCompDisplay(viewerComp) }} / 乗務員: {{ driversText(openCase.driverCds) }}
          <template v-if="printedAt"> / 印刷 {{ printedAt }}</template>
        </div>
        <div v-if="openCase.memo" class="litigation-print-meta">メモ: {{ openCase.memo }}</div>

        <h2 class="font-bold mt-2">出力 (Y時間 Excel)</h2>
        <table class="litigation-print-table">
          <thead>
            <tr><th>乗務員</th><th>期間</th><th>ファイル名</th><th>状態</th><th>結果</th></tr>
          </thead>
          <tbody>
            <tr v-for="(chunk, i) in outputChunks" :key="chunk.filename">
              <td>{{ driverLabel(chunk.driverCd) }} ({{ chunk.driverCd }})</td>
              <td>{{ chunk.label }}</td>
              <td>{{ chunk.filename }}</td>
              <td>{{ outputResults[i] ? OUTPUT_STATUS_LABEL[outputResults[i]!.status] : '未実行' }}</td>
              <td>
                <template v-if="outputResults[i]">
                  {{ outputResults[i]!.message }}<template v-if="outputResults[i]!.missingCount > 0"> / 書けなかった日 {{ outputResults[i]!.missingCount }} 日</template><template v-if="outputResults[i]!.warningsCount > 0"> / 警告 {{ outputResults[i]!.warningsCount }} 件</template>
                </template>
              </td>
            </tr>
          </tbody>
        </table>

        <h2 class="font-bold mt-2">エラー</h2>
        <div class="litigation-print-meta">
          <template v-for="(k, i) in LITIGATION_CHECK_KEYS" :key="k">{{ i > 0 ? ' / ' : '' }}{{ LITIGATION_CHECK_LABELS[k] }}: 異常あり {{ errorCounts[k].ng }}・異常なし {{ errorCounts[k].ok }}・判定できない {{ errorCounts[k].unknown }}・未実行 {{ errorCounts[k].pending }}<template v-if="errorCounts[k].noBaseline > 0">・照合先なし {{ errorCounts[k].noBaseline }}</template></template>
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
        <div v-if="chunkWarnings.length > 0" class="litigation-print-meta">
          Y時間の警告 (冊単位):
          <template v-for="w in chunkWarnings" :key="`${w.driverCd}|${w.label}`">{{ driverLabel(w.driverCd) }} ({{ w.driverCd }}) {{ w.label }}: {{ w.warnings.join(' / ') }}<template v-if="w.warningsCount > w.warnings.length"> ほか (全 {{ w.warningsCount }} 件)</template>。</template>
        </div>

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
}
</style>
