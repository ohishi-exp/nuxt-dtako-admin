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
  MinWageMaster,
  RestraintDriverSummary,
  WageMaster,
  WageReportResponse,
  WageReportRow,
} from '~/utils/restraint-wage-view'
import { MIN_WAGE_DEFAULT_KEY } from '~/utils/restraint-wage-view'
import type {
  ParsedSalaryCsv,
  SalaryComparison,
  SalaryItemCategory,
  SalaryItemConfig,
} from '~/utils/salary-compare'
import type { EmployeeMasterEntry, EmployeeMasterGetResponse } from '~/utils/employee-master'

const {
  session: theearthSession,
  authHeaders: theearthHeaders,
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

/** `compId` を明示すると閲覧モードでその会社に対して投げる (社員マスタの会社横断、
 * Refs #367)。触れるかどうかの判定は worker 側 (`viewerCompIdsForTenant`) が
 * DTAKO_ACCOUNTS の逆引きで行うため、ここで会社を絞る必要はない。 */
function authHeaders(compId?: string): Record<string, string> {
  if (theearthSession.value) return theearthHeaders()
  const token = currentAccessToken()
  return {
    'X-Theearth-Comp-Id': compId ?? viewerComp.value,
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
] as const

/** 対象月が効くタブ。ここに無いタブでは年月バーを出さない (Refs #409)。
 * 単価マスタは選択月時点の単価を出すので対象に含む。 */
const MONTH_AWARE_TABS: string[] = ['archive', 'monthly', 'minwage', 'salary', 'master']

type TabKey = typeof TABS[number]['key']
const activeTab = ref<TabKey>('monthly')

const pageError = ref('')

// ---------------------------------------------------------------------------
// 対象月 (年セレクタ + 月タブ)
// ---------------------------------------------------------------------------

/** アーカイブが存在する月 (YYYY-MM、降順)。 */
const archiveMonths = ref<string[]>([])
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

async function loadArchiveMonths() {
  if (!session.value) return
  try {
    const res = await $fetch<{ months: string[] }>('/restraint-api/archive/months', { headers: authHeaders() })
    archiveMonths.value = res.months
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
    minWageMasterLoaded.value = false
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
/** 月別 wage-report のキャッシュ (一括印刷で再利用)。 */
const reportCache = new Map<string, WageReportResponse>()

async function fetchWageReport(ym: string): Promise<WageReportResponse> {
  const cached = reportCache.get(ym)
  if (cached) return cached
  const res = await $fetch<WageReportResponse>('/restraint-api/wage-report', {
    headers: authHeaders(),
    query: { month: ym },
  })
  reportCache.set(ym, res)
  return res
}

async function loadWageReport() {
  if (!session.value || !month.value) return
  loadingReport.value = true
  pageError.value = ''
  try {
    reportCache.delete(month.value) // 再計算ボタンは常に最新を取り直す
    report.value = await fetchWageReport(month.value)
  }
  catch (e) {
    report.value = null
    handleApiError(e)
  }
  finally {
    loadingReport.value = false
  }
}

/** 金額 ÷ 時間(分) の実額按分平均単価 (円/h)。時間が 0 や金額が null なら null。 */
function ratePerHour(pay: number | null, minutes: number): number | null {
  if (pay == null || minutes <= 0) return null
  return Math.round(pay / (minutes / 60))
}

/** 計算単価の表示 ("@1,206")。null は空文字 (空 div は高さ 0 で潰れる)。 */
function fmtAt(rate: number | null): string {
  return rate == null ? '' : `@${fmtYen(rate)}`
}

/** 計算単価の表示 ("@1,206")。実額按分 (金額 ÷ 時間) が出せない時は空文字。 */
function fmtAtRate(pay: number | null, minutes: number): string {
  return fmtAt(ratePerHour(pay, minutes))
}

/** 実働 − 表に出ている区分時間の合計 (法定内 + 時間外 + 週40超過 + 時間外深夜 +
 * 法定休日(通常+深夜))。週40超過は法定内から控除済み (案B Refs #282) のため加算対象。
 * 0 以外 = 表に無い区分へ分類された時間がある (wage-config の法定外休日設定・
 * 休日フラグ日の実働・日別データ不整合など) — 検算用 (Refs #282)。 */
function unaccountedMinutes(row: WageReportRow): number | null {
  const working = row.summary.workingMinutes
  if (working == null) return null
  const m = row.wage.minutes
  return working - (m.statutory + m.overtime + m.weekly40Excess + m.overtimeNight + m.legalHoliday + m.legalHolidayNight)
}

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
    '実働', '時間外', '深夜', '時間外深夜', '単価',
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
      fmtMinutes(s.workingMinutes), fmtMinutes(s.overtimeMinutes), fmtMinutes(s.nightMinutes), fmtMinutes(s.overtimeNightMinutes),
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

async function loadArchive() {
  if (!session.value || !month.value) return
  loadingArchive.value = true
  pageError.value = ''
  try {
    const csvList = await $fetch<{ entries: ArchiveCsvEntry[] }>('/restraint-api/archive/csv-list', {
      headers: authHeaders(),
      query: { month: month.value },
    })
    const summaries = await $fetch<{ summaries: unknown[], no_data_drivers: string[] }>('/restraint-api/archive/summaries', {
      headers: authHeaders(),
      query: { month: month.value },
    })
    archiveEntries.value = csvList.entries
    archiveSummaryCount.value = summaries.summaries.length
    archiveNoData.value = summaries.no_data_drivers
    archiveHistory.value = {}
  }
  catch (e) {
    archiveEntries.value = []
    handleApiError(e)
  }
  finally {
    loadingArchive.value = false
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

function setEmployeeMasterEntries(compId: string, entries: EmployeeMasterEntry[]) {
  employeeMasterByComp.value = { ...employeeMasterByComp.value, [compId]: entries }
}

/** 1 会社分を読む。`compId` 省略時は今開いている会社。
 * 他社の読み込みは fail-soft — テナントが許可されていない会社は 401/403 に
 * なるが、それは「見えないのが正しい」ので画面全体のエラーにはしない。 */
async function loadEmployeeMaster(compId?: string) {
  if (!session.value) return
  const target = compId ?? session.value.compId
  const isCurrent = target === session.value.compId
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

// ---- 給与DBからの社員取り込み (Refs #367) ----
// 会社対応表 (dtako 会社ID → 給与大臣の会社コード) は D1 が正 —
// `GET /restraint-api/comp-map` で取る (同じテナントの会社だけ返る)。
// 取り込み自体は rust-ichibanboshi の identity-only API
// (`/api/kyuyo/employees`) で、**金額は一切ブラウザに来ない**。

const compMap = ref<CompMapEntry[]>([])
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
async function loadPayrollFromDb() {
  const compId = session.value?.compId
  if (!compId) return
  const companies = compMap.value.find(c => c.compId === compId)?.payrollCompanies ?? []
  if (!companies.length) return
  const payMonth = nextYm(month.value)
  loadingPayrollDb.value = true
  payrollDbMessage.value = ''
  pageError.value = ''
  const loaded: typeof dbImports.value = []
  try {
    const token = currentAccessToken()
    for (const { payrollCompany } of companies) {
      const key = payrollStorageKey(payrollCompany, payMonth)
      let stored: StoredPayroll | null = null
      const cached = import.meta.client ? sessionStorage.getItem(key) : null
      if (cached) {
        try {
          stored = JSON.parse(cached) as StoredPayroll
        }
        catch {
          stored = null // 壊れていたら取り直す
        }
      }
      if (!stored) {
        payrollDbMessage.value = `${payrollCompany} を取得しています… (1 社あたり 10〜20 秒)`
        const body = await $fetch(`/api/kyuyo/payroll`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          query: { company: payrollCompany, month: month.value },
        })
        stored = toStoredPayroll(body, new Date().toISOString())
        if (!stored) {
          payrollDbMessage.value = `${payrollCompany} の応答形式が想定外でした`
          continue
        }
        if (import.meta.client) sessionStorage.setItem(key, JSON.stringify(stored))
      }
      const parsed = payrollToParsedSalary(stored.rows as KyuyoPayrollRow[], payrollCompany)
      loaded.push({ company: payrollCompany, month: payMonth, parsed })
    }
    dbImports.value = loaded
    const total = loaded.reduce((n, i) => n + i.parsed.rows.length, 0)
    payrollDbMessage.value = loaded.length
      ? `給与DB から ${loaded.length} 社 / ${total} 行を読み込みました (${fmtYm(payMonth)} 支給分)`
      : '給与DB から読み込める明細がありませんでした'
  }
  catch (e) {
    handleApiError(e)
  }
  finally {
    loadingPayrollDb.value = false
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
        : entries.map((e, i) => (i === idx ? { ...e, name: emp.name, driverCd: emp.driverCd } : e))
    }
    for (const attr of plan.attrs) {
      const idx = entries.findIndex(e => e.company === attr.company && e.payrollCd === attr.payrollCd)
      if (idx === -1) continue
      const { effectiveFrom, branch, payScheme } = attr
      entries = entries.map((e, i) =>
        (i === idx ? { ...e, attrs: upsertAttrRow(e.attrs, { effectiveFrom, branch, payScheme }) } : e))
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
          employees: entries.map(e => ({ company: e.company, payrollCd: e.payrollCd, name: e.name, driverCd: e.driverCd })),
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
  const row = { effectiveFrom: input.from, branch: input.branch.trim() || null, payScheme: input.payScheme.trim() || null }
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
  const map = new Map<string, { base: number, overtime: number }>()
  for (const r of salaryComparison.value?.rows ?? []) {
    map.set(String(Number(r.mappedDriverCd ?? r.driverCd)), { base: r.csvBase, overtime: r.csvOvertime })
  }
  return map
})

function paidFor(driverCd: string): { base: number, overtime: number } | null {
  return paidByDriver.value.get(String(Number(driverCd))) ?? null
}

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
  const map = new Map<string, { company: string, companyLabel: string, branch: string }>()
  for (const row of employeeMasterRows.value) {
    const cd = row.entry.driverCd
    if (!cd) continue
    map.set(cd, {
      company: row.entry.company,
      companyLabel: row.companyLabel,
      branch: row.current?.branch ?? '',
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
      }
    })
    .filter(r => masterCompanyFilter.value === 'all' || r.company === masterCompanyFilter.value)
  // localeCompare は ICU の照合順が OS 間で揺れるので、数値順が要る乗務員CD 以外は
  // 単純な大小比較で並べる
  return rows.sort((a, b) => {
    if (masterSortKey.value === 'branch') {
      return cmp(a.branch, b.branch) || a.cd.localeCompare(b.cd, undefined, { numeric: true })
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

watch([activeTab, month, session], () => {
  if (!session.value || !month.value) return
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
    // 「給与DBから読み込み」ボタンの活殺は compMap 由来 (importPayrollOptions =
    // 対象 comp の給与会社行) なので、このタブでも読む。無いとリロード直後は
    // ボタンが disabled のままで、社員マスタ/単価マスタタブを一度開くまで押せない
    // (それらのタブだけが loadCompMap していた)
    if (!compMap.value.length) loadCompMap()
  }
  else if (activeTab.value === 'items') {
    if (!salaryConfigLoaded.value) loadSalaryItemConfig()
  }
  else if (activeTab.value === 'archive') {
    loadArchive()
  }
  else if (activeTab.value === 'master') {
    if (Object.keys(master.value.drivers).length === 0) loadMaster()
    // 会社フィルタ・所属列・営業所順の並べ替えに使う (Refs #409)。
    // compMap も要る — 無いと会社コード (0200) が会社名に直らず生のまま出る
    if (!employeeMasterLoaded.value) loadEmployeeMaster()
    if (!compMap.value.length) loadCompMap()
  }
  else if (activeTab.value === 'employees') {
    // 会社横断表示のため、選択中の範囲に必要な会社をまとめて読む (Refs #367)
    loadEmployeeMasterScope()
    if (!compMap.value.length) loadCompMap()
  }
}, { immediate: false })
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
            <UButton
              v-for="m in 12"
              :key="m"
              size="xs"
              :variant="selectedMonthNo === m ? 'solid' : monthHasArchive(selectedYear, m) ? 'soft' : 'ghost'"
              :class="!monthHasArchive(selectedYear, m) && selectedMonthNo !== m ? 'opacity-40' : ''"
              :label="`${m}月`"
              @click="selectedMonthNo = m"
            />
          </div>
          <span class="text-xs text-gray-500 ml-auto">薄い月はアーカイブなし</span>
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

            <RestraintWageMonthlyTable
              v-if="activeTab === 'monthly' && report?.rows.length"
              :rows="report.rows"
              :expand-wage="expandWage"
            />

            <div v-else-if="activeTab === 'minwage' && report?.rows.length" class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th class="px-2 py-2">乗務員CD</th>
                    <th class="px-2 py-2">氏名</th>
                    <th class="px-2 py-2 text-right">実働</th>
                    <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700" title="法定時間内賃金 (深夜・残業等の割増区分を含まない基本部分)。対象時間 = 実働 − 時間外 − 時間外深夜 − 週40超過 − 法定休日実働。「給与比較」タブの基本給(計算)と同じ値">基本給(法定内)<br><span class="font-normal text-xs">(対象時間 / @単価 / 金額)</span></th>
                    <th class="px-2 py-2 text-right" title="残業ではない通常勤務中の深夜加算分 (0.25倍、基本給とは別枠の上乗せ)。@ は計算単価 (加算分 0.25 倍のみ)">深夜(通常)<br><span class="font-normal text-xs">(対象時間 / @単価 / 金額)</span></th>
                    <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700" title="対象時間 = 時間外 + 週40超過 (2段表示)。@ は残業単価 (基礎時給 + 割増加算分の実額按分、基礎込み)。月60時間超過は時間が橙色">残業代<br><span class="font-normal text-xs">(時間外 / 週40超過 / @単価 / 金額)</span></th>
                    <th class="px-2 py-2 text-right" title="対象時間 = 時間外深夜。@ は深夜残業単価 (基礎時給 + 割増加算分の実額按分、基礎込み)">深夜残業代<br><span class="font-normal text-xs">(対象時間 / @単価 / 金額)</span></th>
                    <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700" title="法定休日 (既定 日曜) の実働すべて (1.35倍、深夜分は1.6倍)。@ は通常+深夜合算の実額按分">法定休日<br><span class="font-normal text-xs">(通常 / 深夜 / @単価 / 金額)</span></th>
                    <th class="px-2 py-2 text-right" title="実働 − (法定内 + 時間外 + 時間外深夜 + 法定休日の通常+深夜)。0 以外 = 表に出ていない区分へ分類された時間がある (法定外休日設定・休日フラグ日の実働・日別データ不整合など) — 検算用">差分<br><span class="font-normal text-xs">(実働 − 表合計)</span></th>
                    <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700">残業代合計<br><span class="font-normal text-xs">(残業+深夜残業)</span></th>
                    <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700">合計(計算)<br><span class="font-normal text-xs">(全区分合計)</span></th>
                    <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700" title="支払い済み給与: 給与比較タブで取り込んだ給与明細 CSV の基本給扱い項目の合計。CSV の年月は支給月ラベルのため勤務月+1 の行を突合 (月末締め・翌月払い)。未取り込みの月は「-」">基本給(給与)<br><span class="font-normal text-xs">(支払い実績)</span></th>
                    <th class="px-2 py-2 text-right" title="支払い済み給与: 給与比較タブで取り込んだ給与明細 CSV の割増扱い項目 (残業・深夜・休日出勤) の合計。CSV の年月は支給月ラベルのため勤務月+1 の行を突合 (月末締め・翌月払い)。未取り込みの月は「-」">残業代(給与)<br><span class="font-normal text-xs">(支払い実績)</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in report.rows"
                    :key="row.summary.driverCd"
                    class="border-b border-gray-100 dark:border-gray-800"
                  >
                    <td class="px-2 py-1.5">{{ row.summary.driverCd }}</td>
                    <td class="px-2 py-1.5">{{ row.summary.driverName }}</td>
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
                    <td class="px-2 py-1.5 text-right">
                      <span :class="unaccountedMinutes(row) === 0 ? 'text-xs text-gray-400' : 'text-red-600 font-bold'">
                        {{ fmtSignedMinutes(unaccountedMinutes(row)) }}
                      </span>
                    </td>
                    <td class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700">
                      <div class="font-medium">{{ fmtYen(sumNullable(row.wage.actualOvertimePay, row.wage.actualNightOvertimePay)) }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700">
                      <div class="font-medium">{{ fmtYen(row.wage.totalAmount) }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-right border-l border-gray-200 dark:border-gray-700">
                      <div class="font-medium">{{ fmtYen(paidFor(row.summary.driverCd)?.base ?? null) }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-right">
                      <div class="font-medium">{{ fmtYen(paidFor(row.summary.driverCd)?.overtime ?? null) }}</div>
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
                合計(計算) = 基本給 + 深夜 + 残業代合計 + 法定休日 (全区分合計、「給与比較」タブの合計(計算)と同じ値)。<br>
                基本給(給与)・残業代(給与) は<b>支払い済み給与の実績</b> — 給与比較タブで取り込んだ給与明細 CSV の基本給扱い / 割増扱い項目の合計。CSV の年月ラベルは支給月なので、勤務月+1 (翌月支給) の行を突合している。
                月末締め・翌月払いのため実際の支給は翌月 (ヘッダの支給月表示)。CSV 未取り込みの月は「-」。項目の区分は「支給項目区分」の設定に従う。<br>
                <b>実働 = 基本給(法定内)の対象時間 + 時間外 + 週40超過 + 時間外深夜 + 法定休日(通常+深夜)</b>。
                深夜(通常) だけは上記の<b>内数</b> (0.25 加算のための別枠計上) なので、実働の足し算には含めない。
                差分列はこの検算 (実働 − 表合計) で、0 以外 (赤) は表に出ていない区分へ分類された時間がある印 (法定外休日設定・休日フラグ日の実働・日別データ不整合など)。<br>
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
                    <th class="px-2 py-1.5">拠点</th>
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

          <UCard class="border-sky-300 dark:border-sky-800 mb-3">
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-sm font-medium">給与DBから読み込み</span>
              <span class="text-xs text-gray-500">
                {{ fmtYm(nextYm(month)) }} 支給分を給与大臣から直接取得します (Excel コピペ不要)
              </span>
              <div class="flex-1" />
              <UButton
                size="xs"
                icon="i-lucide-database"
                label="給与DBから読み込み"
                :loading="loadingPayrollDb"
                :disabled="!importPayrollOptions.length"
                @click="loadPayrollFromDb"
              />
            </div>
            <p v-if="payrollDbMessage" class="text-sm mt-2" :class="dbImports.length ? 'text-green-700 dark:text-green-400' : 'text-gray-500'">
              {{ payrollDbMessage }}
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

          <UCard v-if="salaryParsed">
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">比較結果 ({{ fmtYm(month) }})</span>
                <span class="text-xs text-gray-500">給与明細の区分集計 vs 給与明細の単価 × システム集計 (基本単価×稼働日数 / 残業単価×時間外)</span>
                <div class="flex-1" />
                <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再計算" :loading="loadingReport" @click="loadWageReport" />
              </div>
            </template>

            <p v-if="!salaryMonthRows.length" class="text-sm text-gray-500">
              貼り付けデータに {{ fmtYm(month) }} の行がありません (上の「検出した月」から切り替えてください)
            </p>
            <p v-else-if="loadingReport" class="text-sm text-gray-500">
              システム計算 (wage-report) を読み込み中...
            </p>
            <p v-else-if="!salaryComparison" class="text-sm text-gray-500">
              この月の summary がアーカイブにありません (/restraint-fetch で取得するか、アーカイブタブで再計算してください)
            </p>
            <template v-else>
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
                      <th class="px-2 py-2 text-right" title="給与明細の残業単価 (時給) × システム計算の時間外+時間外深夜">残業(計算)</th>
                      <th class="px-2 py-2 text-right">差</th>
                      <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700" title="割増基礎に算入する支給項目の合計 ÷ デジタコ法定内時間 (円/h)。単価マスタの時給との検算にもなる">基礎単価(実績)</th>
                      <th class="px-2 py-2 text-right" title="基礎単価(実績) を基礎額とした割増残業代の理論値 (労基法37条。月60時間までは1.25倍・超過分は1.5倍・深夜分は常時+0.25倍)">残業(基礎単価)</th>
                      <th class="px-2 py-2 text-right" title="残業計(給与) − 残業(基礎単価)。負なら実際の基礎単価に対する法定割増 (37条) を下回っている — 主判定">差</th>
                      <th class="px-2 py-2 text-right border-l border-gray-200 dark:border-gray-700" title="最低賃金を基礎額とみなした割増残業代の理論値 (単価マスタは使わず、デジタコ拘束時間データ×最低賃金で算出)。絶対下限として併記">残業(最低賃金)</th>
                      <th class="px-2 py-2 text-right" title="残業計(給与) − 残業(最低賃金)。負なら実際に支払われた残業代が最低賃金換算の絶対下限すら下回っている">差</th>
                      <th class="px-2 py-2 text-right">支給計(給与)</th>
                      <th class="px-2 py-2 text-right">合計(計算)</th>
                      <th class="px-2 py-2 text-right">差</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in salaryComparison.rows"
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
                      <td class="px-2 py-1.5 text-right" :class="(row.diffOvertime ?? 0) !== 0 ? 'text-red-600 font-medium' : 'text-gray-400'">
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
                    <td class="px-2 py-1.5">{{ row.current?.branch ?? '-' }}</td>
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
}
</style>
