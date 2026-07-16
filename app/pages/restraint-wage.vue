<script setup lang="ts">
/**
 * 拘束×賃金 (Refs #244)。
 *
 * theearth には触らず、/restraint-fetch が R2 にアーカイブした summary を素材に:
 * ⓪ アーカイブ閲覧 (生 CSV / 版 / 確認履歴)
 * ① 月次集計・印刷 (theearth プレビュー形式 + 時間給の法定区分列、展開トグル)
 * ② 最低賃金チェック (換算時給 vs 県別最低賃金)
 * ③ 単価マスタ (適用開始日つき履歴、一括変更、CSV 入出力)
 * ④ 実給与比較は形式確定後 (Refs #244)
 *
 * theearth ログインセッションは /restraint-fetch 等と共有 (useRestraintSession)。
 * 決定事項: 法定休日=日曜、週40h は日曜起算で月跨ぎ週を含む (worker 側
 * restraint-wage.ts 参照)。「休出」列は保留。
 */

interface RestraintSummaryDay {
  day: number
  isRestDay: boolean
  restraintMinutes: number | null
  workingMinutes: number | null
  overtimeMinutes: number | null
  nightMinutes: number | null
  overtimeNightMinutes: number | null
}

interface RestraintDriverSummary {
  driverCd: string
  driverName: string
  branchName: string
  workDays: number
  restDays: number
  restraintMinutes: number | null
  drivingMinutes: number | null
  loadingMinutes: number | null
  breakMinutes: number | null
  workingMinutes: number | null
  overtimeMinutes: number | null
  nightMinutes: number | null
  overtimeNightMinutes: number | null
  maxDailyRestraintMinutes: number | null
  fiscalCumulativeMinutes: number | null
  restraintLimitMinutes: number | null
  excessRestraintMinutes: number | null
  over15hDays: number
  avgDriving9hOverCount: number
  days: RestraintSummaryDay[]
}

type WageCategoryKey =
  | 'statutory' | 'overtime' | 'night' | 'overtimeNight'
  | 'nonLegalHoliday' | 'nonLegalHolidayNight' | 'legalHoliday' | 'legalHolidayNight'
  | 'weekly40Excess'

interface WageRow {
  driverCd: string
  driverName: string
  branchName: string
  hourlyRate: number | null
  minutes: Record<WageCategoryKey, number>
  amounts: Record<WageCategoryKey, number> | null
  totalAmount: number | null
  hourlyEquivalent: number | null
  minWage: { rate: number | null, prefecture: string | null, mapped: boolean }
  minWageDiff: number | null
}

interface WageReportRow {
  summary: RestraintDriverSummary
  fetched_at: string | null
  last_verified_at: string | null
  wage: WageRow
}

interface WageReportResponse {
  month: string
  rows: WageReportRow[]
  no_data_drivers: string[]
  warnings: string[]
}

interface WageRateEntry { effectiveFrom: string, hourlyRate: number }
interface WageMasterDriver { name?: string, rates: WageRateEntry[], retiredAt?: string }
interface WageMaster { drivers: Record<string, WageMasterDriver> }

interface MinWageEntry { effectiveFrom: string, rate: number }
interface MinWageMaster {
  prefectures: Record<string, MinWageEntry[]>
  branchToPrefecture: Record<string, string>
  defaultPrefecture?: string
}

interface ArchiveCsvEntry {
  key: string
  range: string
  file: string
  kind: 'latest' | 'version' | 'history'
  size: number
  fetched_at: string | null
  last_verified_at: string | null
}

interface ArchiveHistoryEntry { ts?: string, result?: string, sha256?: string, bytes?: number, raw?: string }

const { session, authHeaders, restoreSession, showLoginPanel, expireSession } = useRestraintSession()

const TABS = [
  { key: 'archive', label: 'アーカイブ' },
  { key: 'monthly', label: '月次集計・印刷' },
  { key: 'minwage', label: '最低賃金チェック' },
  { key: 'master', label: '単価マスタ' },
] as const
type TabKey = typeof TABS[number]['key']
const activeTab = ref<TabKey>('monthly')

const month = ref('')
const pageError = ref('')

const WAGE_COLUMNS: Array<{ key: WageCategoryKey, label: string }> = [
  { key: 'statutory', label: '法定時間内' },
  { key: 'overtime', label: '法定時間外' },
  { key: 'night', label: '深夜' },
  { key: 'overtimeNight', label: '時間外深夜' },
  { key: 'nonLegalHoliday', label: '法定外休日' },
  { key: 'nonLegalHolidayNight', label: '法定外休日深夜' },
  { key: 'legalHoliday', label: '法定休日' },
  { key: 'legalHolidayNight', label: '法定休日深夜' },
  { key: 'weekly40Excess', label: '週40超過' },
]

onMounted(() => {
  restoreSession()
  if (!session.value) showLoginPanel.value = true
  const now = new Date()
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  month.value = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
})

watch(session, (s) => {
  if (!s) {
    report.value = null
    archiveEntries.value = []
    archiveHistory.value = {}
  }
})

function handleApiError(e: unknown): void {
  if (restraintErrorStatus(e) === 401) {
    expireSession(restraintErrorMessage(e))
    return
  }
  pageError.value = restraintErrorMessage(e)
}

/** 分 → "H:mm" (null は "-")。 */
function fmt(minutes: number | null | undefined): string {
  if (minutes == null) return '-'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

/** 円 (null は "-")。 */
function yen(v: number | null | undefined): string {
  return v == null ? '-' : v.toLocaleString('ja-JP')
}

// ---------------------------------------------------------------------------
// ① 月次集計・印刷 / ② 最低賃金チェック (データ源は共通の wage-report)
// ---------------------------------------------------------------------------

const report = ref<WageReportResponse | null>(null)
const loadingReport = ref(false)
const expandWage = ref(false)

async function loadWageReport() {
  if (!session.value || !month.value) return
  loadingReport.value = true
  pageError.value = ''
  try {
    report.value = await $fetch<WageReportResponse>('/restraint-api/wage-report', {
      headers: authHeaders(),
      query: { month: month.value },
    })
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

function printMonthly() {
  window.print()
}

/** 月次集計テーブルを CSV (UTF-8 BOM) で保存する。展開状態に関わらず全列を出す。 */
function downloadMonthlyCsv() {
  if (!report.value) return
  const header = [
    '乗務員CD', '氏名', '事業所', '稼働日数', '休日数',
    '運転', '荷役', '休憩', '拘束合計', '年度累計(前月まで)', '当月超過', '15時間超過日数', '平均運転9h超過回数',
    '実働', '時間外', '深夜', '時間外深夜', '単価',
    ...WAGE_COLUMNS.map(c => `${c.label}(円)`), '合計(円)', '換算時給', '最低賃金', '最低賃金差',
  ]
  const lines = [header.join(',')]
  for (const row of report.value.rows) {
    const s = row.summary
    const w = row.wage
    lines.push([
      s.driverCd, s.driverName, s.branchName, String(s.workDays), String(s.restDays),
      fmt(s.drivingMinutes), fmt(s.loadingMinutes), fmt(s.breakMinutes), fmt(s.restraintMinutes),
      fmt(s.fiscalCumulativeMinutes), fmt(s.excessRestraintMinutes), String(s.over15hDays), String(s.avgDriving9hOverCount),
      fmt(s.workingMinutes), fmt(s.overtimeMinutes), fmt(s.nightMinutes), fmt(s.overtimeNightMinutes),
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
// ⓪ アーカイブ閲覧
// ---------------------------------------------------------------------------

const archiveEntries = ref<ArchiveCsvEntry[]>([])
const archiveNoData = ref<string[]>([])
const archiveSummaryCount = ref(0)
const loadingArchive = ref(false)
/** range → 履歴 (展開時に取得)。 */
const archiveHistory = ref<Record<string, ArchiveHistoryEntry[]>>({})

async function loadArchive() {
  if (!session.value || !month.value) return
  loadingArchive.value = true
  pageError.value = ''
  try {
    const [csvList, summaries] = [
      await $fetch<{ entries: ArchiveCsvEntry[] }>('/restraint-api/archive/csv-list', {
        headers: authHeaders(),
        query: { month: month.value },
      }),
      await $fetch<{ summaries: unknown[], no_data_drivers: string[] }>('/restraint-api/archive/summaries', {
        headers: authHeaders(),
        query: { month: month.value },
      }),
    ]
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

const resummarizing = ref(false)
const resummarizeMessage = ref('')

/** R2 の生 CSV からサマリを再計算する (theearth 非依存。summary v2 への移行や
 * サマリ欠落月の復元に使う)。 */
async function resummarize() {
  if (!session.value || !month.value) return
  resummarizing.value = true
  resummarizeMessage.value = ''
  pageError.value = ''
  try {
    const res = await $fetch<{ csv_processed: number, summaries_written: number, summaries_new_version: number, errors: string[] }>(
      '/restraint-api/archive/resummarize',
      { method: 'POST', headers: authHeaders(), query: { month: month.value } },
    )
    resummarizeMessage.value
      = `CSV ${res.csv_processed} 件からサマリ ${res.summaries_written} 名分を再計算 (更新 ${res.summaries_new_version} 件)`
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

/** "20260716T183000" → "2026-07-16 18:30"。 */
function fmtTs(ts: string | null | undefined): string {
  if (!ts) return '-'
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : ts
}

const HISTORY_LABEL: Record<string, string> = {
  'new-version': '変更あり (新版)',
  'unchanged': '変更なし',
  'no-data': '該当データなし',
}

// ---------------------------------------------------------------------------
// ③ 単価マスタ
// ---------------------------------------------------------------------------

const master = ref<WageMaster>({ drivers: {} })
const masterUpdatedAt = ref<string | null>(null)
const loadingMaster = ref(false)
const savingMaster = ref(false)
/** 乗務員ごとの新規履歴入力欄。 */
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
    // 乗務員一覧の初期投入: 対象月の summary から未登録乗務員を補完する
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

/** 一括変更: 選択行に同じ単価 + 適用開始日の履歴を追加する。 */
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

/** タブ切替時のデータ読込。 */
watch([activeTab, month, session], () => {
  if (!session.value || !month.value) return
  if (activeTab.value === 'monthly' || activeTab.value === 'minwage') {
    if (!report.value || report.value.month !== month.value) loadWageReport()
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
    <div class="print:hidden">
      <TheearthSessionHeader title="拘束×賃金 (集計・単価・印刷)" api-prefix="/restraint-api" wide />
    </div>

    <div class="p-6 space-y-4 print:p-0">
      <!-- タブ + 月選択 -->
      <div class="flex flex-wrap items-center gap-3 print:hidden">
        <UButton
          v-for="tab in TABS"
          :key="tab.key"
          size="sm"
          :variant="activeTab === tab.key ? 'solid' : 'soft'"
          :label="tab.label"
          @click="activeTab = tab.key"
        />
        <div class="flex-1" />
        <UFormField label="対象月" class="flex items-center gap-2">
          <UInput v-model="month" type="month" size="sm" />
        </UFormField>
      </div>

      <p v-if="pageError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 print:hidden">
        {{ pageError }}
      </p>

      <!-- ⓪ アーカイブ閲覧 -->
      <template v-if="activeTab === 'archive'">
        <UCard>
          <template #header>
            <div class="flex items-center gap-3">
              <span class="font-semibold">アーカイブ ({{ month }})</span>
              <span class="text-xs text-gray-500">summary {{ archiveSummaryCount }} 名 / データなし {{ archiveNoData.length }} 名</span>
              <div class="flex-1" />
              <UButton
                size="xs"
                variant="soft"
                icon="i-lucide-calculator"
                label="サマリを CSV から再計算"
                title="R2 に保存済みの生 CSV からサマリを作り直します (theearth には接続しません)"
                :loading="resummarizing"
                :disabled="!archiveRanges.length"
                @click="resummarize"
              />
              <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再読込" :loading="loadingArchive" @click="loadArchive" />
            </div>
          </template>
          <p v-if="resummarizeMessage" class="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded-lg p-2 mb-3">
            {{ resummarizeMessage }}
          </p>
          <p v-if="!archiveRanges.length && !loadingArchive" class="text-sm text-gray-500">
            この月のアーカイブはありません (/restraint-fetch で取得するとここに貯まります)
          </p>
          <div v-for="group in archiveRanges" :key="group.range" class="border border-gray-200 dark:border-gray-800 rounded-lg p-3 mb-3">
            <div class="flex flex-wrap items-center gap-3 text-sm">
              <span class="font-medium">取得範囲: {{ group.range === 'all' ? '全乗務員' : `乗務員 ${group.range}` }}</span>
              <template v-if="group.latest">
                <span class="text-xs text-gray-500">
                  最新: {{ fmtTs(group.latest.fetched_at) }} 取得 /
                  <b>{{ fmtTs(group.latest.last_verified_at) }} まで同一内容を確認</b> /
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
            <!-- 過去版 -->
            <div v-if="group.versions.length" class="mt-2 flex flex-wrap gap-2">
              <UButton
                v-for="v in group.versions"
                :key="v.key"
                size="xs"
                variant="outline"
                icon="i-lucide-file-clock"
                :label="`版 ${fmtTs(v.fetched_at) !== '-' ? fmtTs(v.fetched_at) : v.file}`"
                @click="downloadArchiveCsv(v)"
              />
            </div>
            <!-- 確認履歴 -->
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
                  <td class="px-2 py-1">{{ fmtTs(h.ts) }}</td>
                  <td
                    class="px-2 py-1"
                    :class="{
                      'text-green-600': h.result === 'new-version',
                      'text-gray-500': h.result === 'unchanged',
                      'text-amber-600': h.result === 'no-data',
                    }"
                  >
                    {{ HISTORY_LABEL[h.result ?? ''] ?? h.raw ?? h.result }}
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
        <UCard>
          <template #header>
            <div class="flex flex-wrap items-center gap-3 print:hidden">
              <span class="font-semibold">{{ activeTab === 'monthly' ? '月次集計' : '最低賃金チェック' }} ({{ month }})</span>
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
                <UButton size="xs" icon="i-lucide-printer" label="印刷" :disabled="!report?.rows.length" @click="printMonthly" />
              </template>
              <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" label="再計算" :loading="loadingReport" @click="loadWageReport" />
            </div>
          </template>

          <div class="print:hidden">
            <p v-for="w in report?.warnings ?? []" :key="w" class="text-xs text-amber-600 dark:text-amber-400 mb-1">⚠ {{ w }}</p>
            <p v-if="missingRateRows.length" class="text-xs text-amber-600 dark:text-amber-400 mb-1">
              ⚠ 単価未設定: {{ missingRateRows.map(r => `${r.summary.driverCd} ${r.summary.driverName}`).join(', ') }} (単価マスタタブで登録してください)
            </p>
          </div>

          <p v-if="!report?.rows.length && !loadingReport" class="text-sm text-gray-500">
            この月の summary がアーカイブにありません (/restraint-fetch で取得してください)
          </p>

          <!-- 印刷ヘッダ (印刷時のみ表示) -->
          <div class="hidden print:block mb-2">
            <h1 class="text-lg font-bold">乗務員拘束時間・時間給集計表 ({{ month }})</h1>
          </div>

          <!-- ① 月次集計テーブル -->
          <div v-if="activeTab === 'monthly' && report?.rows.length" class="overflow-x-auto print:overflow-visible">
            <table class="w-full text-xs monthly-table">
              <thead>
                <tr class="text-left text-gray-500 border-b-2 border-gray-300 dark:border-gray-600">
                  <th class="px-1.5 py-1.5">乗務員</th>
                  <th class="px-1.5 py-1.5 text-right">稼働<br>日数</th>
                  <th class="px-1.5 py-1.5 text-right">運転</th>
                  <th class="px-1.5 py-1.5 text-right">荷役</th>
                  <th class="px-1.5 py-1.5 text-right">休憩</th>
                  <th class="px-1.5 py-1.5 text-right">拘束<br>合計</th>
                  <th class="px-1.5 py-1.5 text-right">年度累計<br>(前月まで)</th>
                  <th class="px-1.5 py-1.5 text-right">当月<br>超過</th>
                  <th class="px-1.5 py-1.5 text-right">15h超<br>日数</th>
                  <th class="px-1.5 py-1.5 text-right">平均運転<br>9h超</th>
                  <th class="px-1.5 py-1.5 text-right">実働</th>
                  <th class="px-1.5 py-1.5 text-right">時間外</th>
                  <th class="px-1.5 py-1.5 text-right">深夜</th>
                  <th class="px-1.5 py-1.5 text-right">時間外<br>深夜</th>
                  <th class="px-1.5 py-1.5 text-right wage-col">単価</th>
                  <template v-if="expandWage">
                    <th v-for="c in WAGE_COLUMNS" :key="c.key" class="px-1.5 py-1.5 text-right wage-col">{{ c.label }}</th>
                  </template>
                  <th class="px-1.5 py-1.5 text-right wage-col">時間給<br>合計</th>
                  <th class="px-1.5 py-1.5 text-right wage-col">換算<br>時給</th>
                  <th class="px-1.5 py-1.5 text-right wage-col">最低賃金<br>差</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in report.rows" :key="row.summary.driverCd" class="border-b border-gray-100 dark:border-gray-800">
                  <td class="px-1.5 py-1 whitespace-nowrap">{{ row.summary.driverCd }} {{ row.summary.driverName }}</td>
                  <td class="px-1.5 py-1 text-right">{{ row.summary.workDays }}</td>
                  <td class="px-1.5 py-1 text-right">{{ fmt(row.summary.drivingMinutes) }}</td>
                  <td class="px-1.5 py-1 text-right">{{ fmt(row.summary.loadingMinutes) }}</td>
                  <td class="px-1.5 py-1 text-right">{{ fmt(row.summary.breakMinutes) }}</td>
                  <td class="px-1.5 py-1 text-right font-medium">{{ fmt(row.summary.restraintMinutes) }}</td>
                  <td class="px-1.5 py-1 text-right">{{ fmt(row.summary.fiscalCumulativeMinutes) }}</td>
                  <td class="px-1.5 py-1 text-right" :class="(row.summary.excessRestraintMinutes ?? 0) > 0 ? 'text-red-600 font-bold' : ''">
                    {{ fmt(row.summary.excessRestraintMinutes) }}
                  </td>
                  <td class="px-1.5 py-1 text-right">{{ row.summary.over15hDays }}</td>
                  <td class="px-1.5 py-1 text-right">{{ row.summary.avgDriving9hOverCount }}</td>
                  <td class="px-1.5 py-1 text-right">{{ fmt(row.summary.workingMinutes) }}</td>
                  <td class="px-1.5 py-1 text-right">{{ fmt(row.summary.overtimeMinutes) }}</td>
                  <td class="px-1.5 py-1 text-right">{{ fmt(row.summary.nightMinutes) }}</td>
                  <td class="px-1.5 py-1 text-right">{{ fmt(row.summary.overtimeNightMinutes) }}</td>
                  <td class="px-1.5 py-1 text-right wage-col">{{ yen(row.wage.hourlyRate) }}</td>
                  <template v-if="expandWage">
                    <td v-for="c in WAGE_COLUMNS" :key="c.key" class="px-1.5 py-1 text-right wage-col">
                      {{ row.wage.amounts ? yen(row.wage.amounts[c.key]) : '-' }}
                    </td>
                  </template>
                  <td class="px-1.5 py-1 text-right font-medium wage-col">{{ yen(row.wage.totalAmount) }}</td>
                  <td class="px-1.5 py-1 text-right wage-col">{{ yen(row.wage.hourlyEquivalent) }}</td>
                  <td class="px-1.5 py-1 text-right wage-col" :class="(row.wage.minWageDiff ?? 0) < 0 ? 'text-red-600 font-bold' : ''">
                    {{ row.wage.minWageDiff == null ? '-' : (row.wage.minWageDiff >= 0 ? '+' : '') + yen(row.wage.minWageDiff) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- ② 最低賃金チェック -->
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
                  <td class="px-2 py-1.5 text-right">{{ fmt(row.summary.workingMinutes) }}</td>
                  <td class="px-2 py-1.5 text-right">{{ yen(row.wage.totalAmount) }}</td>
                  <td class="px-2 py-1.5 text-right font-medium">{{ yen(row.wage.hourlyEquivalent) }}</td>
                  <td class="px-2 py-1.5 text-right">{{ yen(row.wage.minWage.rate) }}</td>
                  <td class="px-2 py-1.5 text-right" :class="(row.wage.minWageDiff ?? 0) < 0 ? 'text-red-600 font-bold' : ''">
                    {{ row.wage.minWageDiff == null ? '-' : (row.wage.minWageDiff >= 0 ? '+' : '') + yen(row.wage.minWageDiff) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="text-xs text-gray-500 mt-2">
              換算時給 = 時間給合計 ÷ 実働時間。最低賃金は事業所 → 都道府県のマッピング (単価マスタタブの min-wage 設定は API 経由 —
              未設定の間は「未設定」表示)。単価未設定の乗務員は計算されません。
            </p>
          </div>
        </UCard>
      </template>

      <!-- ③ 単価マスタ -->
      <template v-else-if="activeTab === 'master'">
        <UCard>
          <template #header>
            <div class="flex flex-wrap items-center gap-3">
              <span class="font-semibold">単価マスタ</span>
              <span v-if="masterUpdatedAt" class="text-xs text-gray-500">最終更新: {{ fmtTs(masterUpdatedAt) }}</span>
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

          <!-- 一括変更 -->
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
                  <td class="px-2 py-1.5 text-right font-medium">{{ row.current ? yen(row.current.hourlyRate) : '未設定' }}</td>
                  <td class="px-2 py-1.5">{{ row.current?.effectiveFrom ?? '-' }}</td>
                  <td class="px-2 py-1.5 text-xs text-gray-500">
                    {{ row.history.length > 1 ? row.history.slice(1).map(r => `${r.effectiveFrom}: ${yen(r.hourlyRate)}円`).join(' / ') : '-' }}
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
  </div>
</template>

<style>
/* 印刷: サイドバー等のアプリ枠を隠して月次テーブルだけ出す (1 ヶ月 = 1 ページ)。
   A4 横向きを想定 (ブラウザの印刷ダイアログで横向きを選択)。 */
@media print {
  aside { display: none !important; }
  .monthly-table { font-size: 9px; }
  .monthly-table th, .monthly-table td { padding: 2px 3px; border: 1px solid #999; }
  @page { size: A4 landscape; margin: 8mm; }
}
</style>
