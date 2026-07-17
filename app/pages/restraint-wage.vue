<script setup lang="ts">
/**
 * 拘束×賃金 (Refs #244)。
 *
 * theearth には触らず、/restraint-fetch が R2 にアーカイブした summary を素材に:
 * ⓪ アーカイブ閲覧 (生 CSV / 版 / 確認履歴、サマリ再計算 — 単月/全月一括)
 * ① 月次集計・印刷 (theearth プレビュー形式 + 時間給の法定区分列、展開トグル、
 *    月範囲 × 乗務員範囲の一括印刷 = 月毎改ページ)
 * ② 最低賃金チェック (換算時給 vs 県別最低賃金)
 * ③ 単価マスタ (適用開始日つき履歴、一括変更、CSV 入出力)
 *
 * 対象月は「年セレクタ + 月タブ」で選ぶ (アーカイブが存在する月だけ活性、
 * GET /restraint-api/archive/months)。theearth ログインセッションは
 * /restraint-fetch 等と共有 (useRestraintSession)。
 */
import type {
  ArchiveCsvEntry,
  ArchiveHistoryEntry,
  RestraintDriverSummary,
  WageMaster,
  WageReportResponse,
  WageReportRow,
} from '~/utils/restraint-wage-view'
import type {
  ParsedSalaryCsv,
  SalaryComparison,
  SalaryItemCategory,
  SalaryItemConfig,
} from '~/utils/salary-compare'

const { session, authHeaders, restoreSession, showLoginPanel, expireSession } = useRestraintSession()

const TABS = [
  { key: 'archive', label: 'アーカイブ' },
  { key: 'monthly', label: '月次集計・印刷' },
  { key: 'minwage', label: '最低賃金チェック' },
  { key: 'salary', label: '給与比較' },
  { key: 'master', label: '単価マスタ' },
] as const
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

onMounted(() => {
  restoreSession()
  if (!session.value) showLoginPanel.value = true
  else loadArchiveMonths()
})

watch(session, (s) => {
  if (!s) {
    report.value = null
    archiveEntries.value = []
    archiveHistory.value = {}
    printBatch.value = null
    // 貼り付け中の給与データはメモリ上にしか無い — ログアウトで破棄する
    clearSalaryPaste()
    salaryConfigLoaded.value = false
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

const missingRateRows = computed(() => (report.value?.rows ?? []).filter(r => r.wage.hourlyRate === null))
const belowMinWageRows = computed(() =>
  (report.value?.rows ?? []).filter(r => r.wage.minWageDiff !== null && r.wage.minWageDiff < 0))

/** 月次集計テーブルを CSV (UTF-8 BOM) で保存する (全列)。 */
function downloadMonthlyCsv() {
  if (!report.value) return
  const header = [
    '年月', '乗務員CD', '氏名', '事業所', '稼働日数', '休日数',
    '運転', '荷役', '休憩', '拘束合計', '年度累計(前月まで)', '当月超過', '15時間超過日数', '平均運転9h超過回数',
    '実働', '時間外', '深夜', '時間外深夜', '単価',
    ...WAGE_COLUMNS.map(c => `${c.label}(円)`), '合計(円)', '換算時給', '最低賃金', '最低賃金差',
  ]
  const lines = [header.join(',')]
  for (const row of report.value.rows) {
    const s = row.summary
    const w = row.wage
    lines.push([
      report.value.month, s.driverCd, s.driverName, s.branchName, String(s.workDays), String(s.restDays),
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
/** 取り込み済み CSV (複数可、Refs #253)。メモリ上にのみ保持しサーバーへは送らない。 */
const salaryImports = ref<Array<{ id: number, name?: string, parsed: ParsedSalaryCsv }>>([])
let salaryImportSeq = 0
const salaryParseError = ref('')
/** 全取り込みを合算した解析結果 (行連結・項目名の和集合)。 */
const salaryParsed = computed<ParsedSalaryCsv | null>(() =>
  salaryImports.value.length
    ? mergeParsedSalaryCsv(salaryImports.value.map(i => i.parsed))
    : null)
const salaryItemConfig = ref<SalaryItemConfig>({ items: {} })
const salaryConfigLoaded = ref(false)
const savingSalaryConfig = ref(false)
const salaryConfigMessage = ref('')

const SALARY_CATEGORY_OPTIONS = [
  { label: '基本給として計算', value: 'base' },
  { label: '残業として計算', value: 'overtime' },
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
    const parsed = parseSalaryCsv(salaryPaste.value)
    salaryImports.value = [...salaryImports.value, { id: ++salaryImportSeq, parsed }]
    // 取り込んだら入力欄を空にして次の CSV の貼り付けを受け付ける
    salaryPaste.value = ''
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
      const parsed = parseSalaryCsv(text)
      salaryImports.value = [...salaryImports.value, { id: ++salaryImportSeq, name: file.name, parsed }]
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

/** 選択中の月の CSV 行。 */
const salaryMonthRows = computed(() =>
  (salaryParsed.value?.rows ?? []).filter(r => r.month === month.value))

const salaryComparison = computed<SalaryComparison | null>(() => {
  if (!salaryParsed.value || !report.value || report.value.month !== month.value) return null
  return compareSalaryMonth(salaryMonthRows.value, report.value.rows, salaryItemConfig.value)
})

function selectSalaryMonth(ym: string) {
  selectedYear.value = parseInt(ym.slice(0, 4), 10)
  selectedMonthNo.value = parseInt(ym.slice(5, 7), 10)
}

/** 差額表示 (0 は "±0"、正負は符号つき)。 */
function fmtDiff(v: number | null): string {
  if (v == null) return '-'
  if (v === 0) return '±0'
  return (v > 0 ? '+' : '') + v.toLocaleString('ja-JP')
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

const masterRows = computed(() =>
  Object.entries(master.value.drivers)
    .map(([cd, driver]) => {
      const sorted = [...driver.rates].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
      return { cd, driver, current: sorted[0] ?? null, history: sorted }
    })
    .sort((a, b) => a.cd.localeCompare(b.cd, undefined, { numeric: true })))

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
  for (const row of masterRows.value) {
    for (const rate of row.history) {
      lines.push([row.cd, row.driver.name ?? '', String(rate.hourlyRate), rate.effectiveFrom].join(','))
    }
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

watch([activeTab, month, session], () => {
  if (!session.value || !month.value) return
  if (activeTab.value === 'monthly' || activeTab.value === 'minwage') {
    if (!report.value || report.value.month !== month.value) loadWageReport()
  }
  else if (activeTab.value === 'salary') {
    if (!report.value || report.value.month !== month.value) loadWageReport()
    if (!salaryConfigLoaded.value) loadSalaryItemConfig()
  }
  else if (activeTab.value === 'archive') {
    loadArchive()
  }
  else if (activeTab.value === 'master') {
    if (Object.keys(master.value.drivers).length === 0) loadMaster()
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

        <!-- 対象月: 年セレクタ + 月タブ -->
        <div class="flex flex-wrap items-center gap-2 border border-gray-200 dark:border-gray-800 rounded-lg p-2">
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
              <p v-if="belowMinWageRows.length" class="text-sm text-red-600 font-medium mb-2">
                最低賃金割れ: {{ belowMinWageRows.length }} 名
              </p>
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th class="px-2 py-2">乗務員CD</th>
                    <th class="px-2 py-2">氏名</th>
                    <th class="px-2 py-2">事業所</th>
                    <th class="px-2 py-2">都道府県</th>
                    <th class="px-2 py-2 text-right">実働</th>
                    <th class="px-2 py-2 text-right">支給見込(円)</th>
                    <th class="px-2 py-2 text-right">換算時給</th>
                    <th class="px-2 py-2 text-right">最低賃金</th>
                    <th class="px-2 py-2 text-right">差</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in report.rows"
                    :key="row.summary.driverCd"
                    class="border-b border-gray-100 dark:border-gray-800"
                    :class="(row.wage.minWageDiff ?? 0) < 0 ? 'bg-red-50 dark:bg-red-950/40' : ''"
                  >
                    <td class="px-2 py-1.5">{{ row.summary.driverCd }}</td>
                    <td class="px-2 py-1.5">{{ row.summary.driverName }}</td>
                    <td class="px-2 py-1.5">{{ row.summary.branchName }}</td>
                    <td class="px-2 py-1.5">
                      {{ row.wage.minWage.prefecture ?? '未設定' }}
                      <span v-if="row.wage.minWage.prefecture && !row.wage.minWage.mapped" class="text-amber-600 text-xs">(既定県で近似)</span>
                    </td>
                    <td class="px-2 py-1.5 text-right">{{ fmtMinutes(row.summary.workingMinutes) }}</td>
                    <td class="px-2 py-1.5 text-right">{{ fmtYen(row.wage.totalAmount) }}</td>
                    <td class="px-2 py-1.5 text-right font-medium">{{ fmtYen(row.wage.hourlyEquivalent) }}</td>
                    <td class="px-2 py-1.5 text-right">{{ fmtYen(row.wage.minWage.rate) }}</td>
                    <td class="px-2 py-1.5 text-right" :class="(row.wage.minWageDiff ?? 0) < 0 ? 'text-red-600 font-bold' : ''">
                      {{ row.wage.minWageDiff == null ? '-' : (row.wage.minWageDiff >= 0 ? '+' : '') + fmtYen(row.wage.minWageDiff) }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p class="text-xs text-gray-500 mt-2">
                換算時給 = 時間給合計 ÷ 実働時間。単価未設定の乗務員は計算されません。
              </p>
            </div>
          </UCard>
        </template>

        <!-- ④ 給与比較 (Refs #253) -->
        <template v-else-if="activeTab === 'salary'">
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
                <div class="flex-1" />
                <UButton size="xs" variant="ghost" icon="i-lucide-trash-2" label="削除" @click="removeSalaryImport(imp.id)" />
              </div>
              <ul v-if="imp.parsed.warnings.length" class="text-xs text-amber-600 dark:text-amber-400 mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                <li v-for="(w, i) in imp.parsed.warnings" :key="i">⚠ {{ w }}</li>
              </ul>
            </div>
            <template v-if="salaryParsed">
              <p class="text-sm text-gray-600 dark:text-gray-300 mt-2">
                合計 {{ salaryParsed.rows.length }} 行 / 支給項目 {{ salaryParsed.itemLabels.length }} 件を検出しました
              </p>
              <div class="flex flex-wrap items-center gap-1 mt-1">
                <span class="text-xs text-gray-500">検出した月 (クリックで比較対象月を切替):</span>
                <UButton
                  v-for="ym in salaryParsed.months"
                  :key="ym"
                  size="xs"
                  :variant="ym === month ? 'solid' : 'soft'"
                  :label="fmtYm(ym)"
                  @click="selectSalaryMonth(ym)"
                />
              </div>
            </template>
          </UCard>

          <UCard v-if="salaryItemRows.length">
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">支給項目の区分 (基本給 / 残業)</span>
                <span class="text-xs text-gray-500">この区分設定だけがサーバーに保存されます</span>
                <div class="flex-1" />
                <UButton size="xs" icon="i-lucide-save" label="区分を保存" :loading="savingSalaryConfig" @click="saveSalaryItemConfig" />
              </div>
            </template>
            <p v-if="salaryConfigMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
              {{ salaryConfigMessage }}
            </p>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
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
                  class="w-40 shrink-0"
                  @update:model-value="(v: unknown) => setSalaryItemCategory(row.label, v as SalaryItemCategory)"
                />
              </div>
            </div>
          </UCard>

          <UCard v-if="salaryParsed">
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">比較結果 ({{ fmtYm(month) }})</span>
                <span class="text-xs text-gray-500">CSV の区分集計 vs システム計算 (法定内 = 法定時間内額、割増 = 合計 − 法定内)</span>
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
                      <th class="px-2 py-2 text-right">法定内(計算)</th>
                      <th class="px-2 py-2 text-right">差</th>
                      <th class="px-2 py-2 text-right">残業計(給与)</th>
                      <th class="px-2 py-2 text-right">割増(計算)</th>
                      <th class="px-2 py-2 text-right">差</th>
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
                      <td class="px-2 py-1.5">{{ row.driverCd }}</td>
                      <td class="px-2 py-1.5">{{ row.driverName }}</td>
                      <td class="px-2 py-1.5 text-right">{{ fmtYen(row.csvBase) }}</td>
                      <td class="px-2 py-1.5 text-right">{{ fmtYen(row.sysBase) }}</td>
                      <td class="px-2 py-1.5 text-right" :class="(row.diffBase ?? 0) !== 0 ? 'text-red-600 font-medium' : 'text-gray-400'">
                        {{ fmtDiff(row.diffBase) }}
                      </td>
                      <td class="px-2 py-1.5 text-right">{{ fmtYen(row.csvOvertime) }}</td>
                      <td class="px-2 py-1.5 text-right">{{ fmtYen(row.sysOvertime) }}</td>
                      <td class="px-2 py-1.5 text-right" :class="(row.diffOvertime ?? 0) !== 0 ? 'text-red-600 font-medium' : 'text-gray-400'">
                        {{ fmtDiff(row.diffOvertime) }}
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
                差 = 給与明細 − システム計算。* は 支給合計額 列と支給項目の合算が一致しない行。
                単価マスタ未設定の乗務員は計算列が「-」になります。
              </p>
              <p v-if="salaryComparison.csvOnly.length" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
                給与明細のみ (システム計算なし): {{ salaryComparison.csvOnly.map(d => `${d.driverCd} ${d.driverName}`).join(', ') }}
              </p>
              <p v-if="salaryComparison.reportOnly.length" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
                システム計算のみ (給与明細なし): {{ salaryComparison.reportOnly.map(d => `${d.driverCd} ${d.driverName}`).join(', ') }}
              </p>
            </template>
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
                    <th class="px-2 py-2 text-right">現行単価 (円)</th>
                    <th class="px-2 py-2">適用開始日 (現行)</th>
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
                    <td class="px-2 py-1.5 text-right font-medium">{{ row.current ? fmtYen(row.current.hourlyRate) : '未設定' }}</td>
                    <td class="px-2 py-1.5">{{ row.current?.effectiveFrom ?? '-' }}</td>
                    <td class="px-2 py-1.5 text-xs text-gray-500">
                      {{ row.history.length > 1 ? row.history.slice(1).map(r => `${r.effectiveFrom}: ${fmtYen(r.hourlyRate)}円`).join(' / ') : '-' }}
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
