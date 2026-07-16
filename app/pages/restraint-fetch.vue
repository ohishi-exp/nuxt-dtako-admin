<script setup lang="ts">
/**
 * 拘束時間管理表 CSV 取得 (web地球号 F-ERS2010、Refs #241)。
 *
 * 管理者 (auth-worker ログイン必須) が theearth-np.com のアカウントでログインし、
 * 対象乗務員 (複数) × 対象年月 (範囲) の拘束時間管理表 CSV を **1 名 × 1 月ずつ
 * 逐次** ダウンロード → パース済みサマリを集計テーブルに表示するページ。
 * 全乗務員一括 (乗務員CD 未入力) は 1 回の export が重い (実測 112 名 378KB /
 * 数十秒) ため、通常は乗務員CD を列挙して 1 名ずつ取る。
 *
 * credential pass-through 設計は /daily-report-edit と同じ (TheearthSessionHeader.vue
 * 参照)。theearth ログインセッションは DVR viewer / 日報編集と共有する (Refs #233)。
 * worker 側の実機確定知見は workers/dtako-scraper-relay/src/theearth-restraint-client.ts。
 */

/** worker (theearth-restraint-client.ts) の RestraintDayRow と同型。 */
interface RestraintDayRow {
  date: string
  day: number | null
  isRestDay: boolean
  startTime: string
  endTime: string
  drivingMinutes: number | null
  loadingMinutes: number | null
  breakMinutes: number | null
  restraintMinutes: number | null
  restraintCumulativeMinutes: number | null
  restMinutes: number | null
  workingMinutes: number | null
  overtimeMinutes: number | null
  notes: string[]
  columns: string[]
}

interface RestraintDriverBlock {
  branchName: string
  categories: Record<string, string>
  driverName: string
  driverCd: string
  header: string[]
  days: RestraintDayRow[]
  totals: { columns: string[] } | null
  fiscalCumulativeMinutes: number | null
  fiscalLimitHours: number | null
}

interface RestraintDriverSummary {
  driverCd: string
  driverName: string
  branchName: string
  workDays: number
  restDays: number
  restraintMinutes: number | null
  drivingMinutes: number | null
  workingMinutes: number | null
  overtimeMinutes: number | null
  maxDailyRestraintMinutes: number | null
  fiscalCumulativeMinutes: number | null
}

interface RestraintReportResponse {
  no_data: boolean
  report?: {
    title: string
    year: number
    month: number
    maxRestraintNote: string
    drivers: RestraintDriverBlock[]
  }
  summaries?: RestraintDriverSummary[]
}

/** 取得結果 1 行 (乗務員 × 年月)。 */
interface ResultRow {
  ym: string // "2025-04"
  year: number
  month: number
  summary: RestraintDriverSummary
  block: RestraintDriverBlock
}

interface ProgressItem {
  label: string
  status: 'pending' | 'running' | 'done' | 'no-data' | 'error'
  message?: string
}

const { session, authHeaders, restoreSession, showLoginPanel, expireSession } = useRestraintSession()

const driversInput = ref('')
const monthFrom = ref('')
const monthTo = ref('')
const running = ref(false)
const progress = ref<ProgressItem[]>([])
const results = ref<ResultRow[]>([])
/** 「該当データなし」だった乗務員×月 (途中入社・休職・未集計)。取得結果の一部と
 * して明細・集計 CSV にも残す (未取得との区別)。 */
const noDataItems = ref<Array<{ ym: string, driverCd: string }>>([])
const fetchError = ref('')
const expandedKey = ref<string | null>(null)

onMounted(() => {
  restoreSession()
  if (!session.value) showLoginPanel.value = true
  // 既定: 先月 1 ヶ月分
  const now = new Date()
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const ym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
  monthFrom.value = ym
  monthTo.value = ym
})

watch(session, (s) => {
  if (!s) {
    results.value = []
    progress.value = []
    noDataItems.value = []
  }
})

/** 入力欄の乗務員CD (空白・カンマ・改行区切り) をパースする。空 = 全乗務員。 */
function parseDriverCds(input: string): string[] {
  return [...new Set(input.split(/[\s,、]+/).map(s => s.trim()).filter(Boolean))]
}

const driverCds = computed(() => parseDriverCds(driversInput.value))
const driverInputInvalid = computed(() => driverCds.value.some(cd => !/^\d{1,8}$/.test(cd)))

/** "YYYY-MM" range を [{year, month}] に展開する (from > to は空)。 */
function expandMonths(from: string, to: string): Array<{ year: number, month: number }> {
  const m1 = from.match(/^(\d{4})-(\d{2})$/)
  const m2 = to.match(/^(\d{4})-(\d{2})$/)
  if (!m1 || !m2) return []
  const months: Array<{ year: number, month: number }> = []
  let y = parseInt(m1[1]!, 10)
  let m = parseInt(m1[2]!, 10)
  const endY = parseInt(m2[1]!, 10)
  const endM = parseInt(m2[2]!, 10)
  while (y < endY || (y === endY && m <= endM)) {
    months.push({ year: y, month: m })
    m++
    if (m > 12) { m = 1; y++ }
    if (months.length > 24) break // 誤入力で巨大ループにしない
  }
  return months
}

async function run() {
  if (running.value || !session.value) return
  const months = expandMonths(monthFrom.value, monthTo.value)
  if (months.length === 0) {
    fetchError.value = '対象年月の範囲が不正です'
    return
  }
  if (driverInputInvalid.value) {
    fetchError.value = '乗務員コードは数値で入力してください'
    return
  }
  const cds = driverCds.value
  running.value = true
  fetchError.value = ''
  results.value = []
  noDataItems.value = []
  expandedKey.value = null

  // 乗務員 × 月の逐次実行 (theearth は同一セッションへの並行リクエストを
  // 許さないため並列化しない。worker 側でも直列化される)
  const jobs: Array<{ year: number, month: number, from: string, to: string, label: string }> = []
  for (const { year, month } of months) {
    if (cds.length === 0) {
      jobs.push({ year, month, from: '', to: '', label: `${year}/${String(month).padStart(2, '0')} 全乗務員` })
    }
    else {
      for (const cd of cds) {
        jobs.push({ year, month, from: cd, to: cd, label: `${year}/${String(month).padStart(2, '0')} 乗務員 ${cd}` })
      }
    }
  }
  progress.value = jobs.map(j => ({ label: j.label, status: 'pending' as const }))

  try {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!
      const item = progress.value[i]!
      item.status = 'running'
      try {
        const res = await $fetch<RestraintReportResponse>('/restraint-api/report', {
          headers: authHeaders(),
          query: { year: job.year, month: job.month, driverFrom: job.from, driverTo: job.to },
        })
        const ym = `${job.year}-${String(job.month).padStart(2, '0')}`
        if (res.no_data || !res.report) {
          item.status = 'no-data'
          if (job.from) noDataItems.value.push({ ym, driverCd: job.from })
          continue
        }
        for (let d = 0; d < res.report.drivers.length; d++) {
          results.value.push({
            ym,
            year: job.year,
            month: job.month,
            summary: res.summaries![d]!,
            block: res.report.drivers[d]!,
          })
        }
        item.status = 'done'
      }
      catch (e) {
        if (restraintErrorStatus(e) === 401) {
          expireSession(restraintErrorMessage(e))
          item.status = 'error'
          item.message = 'セッション切れ'
          return
        }
        item.status = 'error'
        item.message = restraintErrorMessage(e)
      }
    }
  }
  finally {
    running.value = false
  }
}

/** 分 → "H:mm" (null/0 は "-")。 */
function fmt(minutes: number | null | undefined): string {
  if (minutes == null) return '-'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

/** 乗務員単位の期間合計 (選択した全月の拘束時間ほか)。 */
const driverTotals = computed(() => {
  const map = new Map<string, {
    driverCd: string
    driverName: string
    branchName: string
    months: number
    workDays: number
    restraintMinutes: number
    drivingMinutes: number
    workingMinutes: number
    overtimeMinutes: number
    maxDailyRestraintMinutes: number | null
  }>()
  for (const row of results.value) {
    const key = row.summary.driverCd || row.summary.driverName
    let agg = map.get(key)
    if (!agg) {
      agg = {
        driverCd: row.summary.driverCd,
        driverName: row.summary.driverName,
        branchName: row.summary.branchName,
        months: 0,
        workDays: 0,
        restraintMinutes: 0,
        drivingMinutes: 0,
        workingMinutes: 0,
        overtimeMinutes: 0,
        maxDailyRestraintMinutes: null,
      }
      map.set(key, agg)
    }
    agg.months++
    agg.workDays += row.summary.workDays
    agg.restraintMinutes += row.summary.restraintMinutes ?? 0
    agg.drivingMinutes += row.summary.drivingMinutes ?? 0
    agg.workingMinutes += row.summary.workingMinutes ?? 0
    agg.overtimeMinutes += row.summary.overtimeMinutes ?? 0
    if (row.summary.maxDailyRestraintMinutes !== null) {
      agg.maxDailyRestraintMinutes = Math.max(agg.maxDailyRestraintMinutes ?? 0, row.summary.maxDailyRestraintMinutes)
    }
  }
  return [...map.values()].sort((a, b) => a.driverCd.localeCompare(b.driverCd, undefined, { numeric: true }))
})

function rowKey(row: ResultRow): string {
  return `${row.ym}:${row.summary.driverCd}`
}

/** 明細 (乗務員×月) テーブルの集計 CSV (UTF-8 BOM、Excel でそのまま開ける)。 */
function downloadAggregateCsv() {
  const header = ['年月', '乗務員CD', '氏名', '事業所', '出勤日数', '休日数', '拘束時間', '最大拘束(日)', '運転時間', '実働時間', '時間外時間', '年度累計拘束(前月まで)']
  const lines = [header.join(',')]
  for (const row of [...results.value].sort((a, b) => rowKey(a).localeCompare(rowKey(b), undefined, { numeric: true }))) {
    const s = row.summary
    lines.push([
      row.ym,
      s.driverCd,
      s.driverName,
      s.branchName,
      String(s.workDays),
      String(s.restDays),
      fmt(s.restraintMinutes),
      fmt(s.maxDailyRestraintMinutes),
      fmt(s.drivingMinutes),
      fmt(s.workingMinutes),
      fmt(s.overtimeMinutes),
      fmt(s.fiscalCumulativeMinutes),
    ].map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(','))
  }
  // 「該当データなし」も行として残す (途中入社・休職・未集計を未取得と区別する)
  for (const nd of noDataItems.value) {
    lines.push([nd.ym, nd.driverCd, '(該当データなし)', '', '', '', '', '', '', '', '', ''].join(','))
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  triggerDownload(blob, `拘束時間集計_${monthFrom.value}_${monthTo.value}.csv`)
}

/** theearth の生 CSV (Shift_JIS) をそのまま保存する。 */
async function downloadRawCsv(row: ResultRow) {
  try {
    const blob = await $fetch<Blob>('/restraint-api/csv', {
      headers: authHeaders(),
      query: { year: row.year, month: row.month, driverFrom: row.summary.driverCd, driverTo: row.summary.driverCd },
      responseType: 'blob',
    })
    triggerDownload(blob, `拘束時間管理表_${row.ym}_${row.summary.driverCd}.csv`)
  }
  catch (e) {
    if (restraintErrorStatus(e) === 401) {
      expireSession(restraintErrorMessage(e))
      return
    }
    fetchError.value = restraintErrorMessage(e)
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
</script>

<template>
  <div>
    <TheearthSessionHeader title="拘束CSV取得 (web地球号)" api-prefix="/restraint-api" wide />

    <div class="p-6 space-y-6">
      <!-- 取得条件 -->
      <UCard>
        <div class="flex flex-wrap items-end gap-4">
          <UFormField label="対象年月 (から)">
            <UInput v-model="monthFrom" type="month" />
          </UFormField>
          <UFormField label="対象年月 (まで)">
            <UInput v-model="monthTo" type="month" />
          </UFormField>
          <UFormField label="乗務員コード (空白・カンマ区切りで複数。空欄 = 全乗務員一括)" class="flex-1 min-w-72">
            <UTextarea v-model="driversInput" :rows="2" placeholder="例: 1001 1002 1003" class="w-full" />
          </UFormField>
          <UButton
            icon="i-lucide-download"
            :label="running ? '取得中...' : 'CSV 取得・集計'"
            :loading="running"
            :disabled="!session || driverInputInvalid"
            @click="run"
          />
        </div>
        <p v-if="driverInputInvalid" class="text-sm text-red-600 mt-2">
          乗務員コードは数値で入力してください
        </p>
        <p v-else-if="driverCds.length === 0" class="text-xs text-amber-600 dark:text-amber-400 mt-2">
          乗務員コード未入力のため全乗務員を一括取得します (1 ヶ月あたり数十秒かかります)
        </p>
        <p v-if="fetchError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mt-3">
          {{ fetchError }}
        </p>
      </UCard>

      <!-- 進捗 -->
      <UCard v-if="progress.length">
        <template #header>
          <span class="font-semibold">取得状況</span>
        </template>
        <ul class="space-y-1 text-sm max-h-64 overflow-y-auto">
          <li v-for="(item, i) in progress" :key="i" class="flex items-center gap-2">
            <span
              class="size-2 rounded-full shrink-0"
              :class="{
                'bg-gray-300': item.status === 'pending',
                'bg-blue-500 animate-pulse': item.status === 'running',
                'bg-green-500': item.status === 'done',
                'bg-amber-400': item.status === 'no-data',
                'bg-red-500': item.status === 'error',
              }"
            />
            <span>{{ item.label }}</span>
            <span v-if="item.status === 'no-data'" class="text-amber-600 dark:text-amber-400">該当データなし</span>
            <span v-else-if="item.status === 'error'" class="text-red-600">{{ item.message }}</span>
          </li>
        </ul>
      </UCard>

      <!-- 乗務員別 期間合計 -->
      <UCard v-if="driverTotals.length">
        <template #header>
          <div class="flex items-center gap-3">
            <span class="font-semibold">乗務員別 合計 ({{ monthFrom }} 〜 {{ monthTo }})</span>
            <div class="flex-1" />
            <UButton size="xs" variant="soft" icon="i-lucide-file-down" label="集計CSV" @click="downloadAggregateCsv" />
          </div>
        </template>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                <th class="px-2 py-2">乗務員CD</th>
                <th class="px-2 py-2">氏名</th>
                <th class="px-2 py-2">事業所</th>
                <th class="px-2 py-2 text-right">月数</th>
                <th class="px-2 py-2 text-right">出勤日数</th>
                <th class="px-2 py-2 text-right">拘束時間</th>
                <th class="px-2 py-2 text-right">最大拘束(日)</th>
                <th class="px-2 py-2 text-right">運転時間</th>
                <th class="px-2 py-2 text-right">実働時間</th>
                <th class="px-2 py-2 text-right">時間外時間</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in driverTotals" :key="t.driverCd" class="border-b border-gray-100 dark:border-gray-800">
                <td class="px-2 py-1.5">{{ t.driverCd }}</td>
                <td class="px-2 py-1.5">{{ t.driverName }}</td>
                <td class="px-2 py-1.5">{{ t.branchName }}</td>
                <td class="px-2 py-1.5 text-right">{{ t.months }}</td>
                <td class="px-2 py-1.5 text-right">{{ t.workDays }}</td>
                <td class="px-2 py-1.5 text-right font-medium">{{ fmt(t.restraintMinutes) }}</td>
                <td class="px-2 py-1.5 text-right">{{ fmt(t.maxDailyRestraintMinutes) }}</td>
                <td class="px-2 py-1.5 text-right">{{ fmt(t.drivingMinutes) }}</td>
                <td class="px-2 py-1.5 text-right">{{ fmt(t.workingMinutes) }}</td>
                <td class="px-2 py-1.5 text-right">{{ fmt(t.overtimeMinutes) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UCard>

      <!-- 明細 (乗務員 × 月) -->
      <UCard v-if="results.length || noDataItems.length">
        <template #header>
          <span class="font-semibold">明細 (乗務員 × 月)</span>
        </template>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                <th class="px-2 py-2">年月</th>
                <th class="px-2 py-2">乗務員CD</th>
                <th class="px-2 py-2">氏名</th>
                <th class="px-2 py-2">事業所</th>
                <th class="px-2 py-2 text-right">出勤</th>
                <th class="px-2 py-2 text-right">休日</th>
                <th class="px-2 py-2 text-right">拘束時間</th>
                <th class="px-2 py-2 text-right">最大拘束(日)</th>
                <th class="px-2 py-2 text-right">運転時間</th>
                <th class="px-2 py-2 text-right">実働時間</th>
                <th class="px-2 py-2 text-right">時間外</th>
                <th class="px-2 py-2 text-right">年度累計(前月まで)</th>
                <th class="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              <template v-for="row in results" :key="rowKey(row)">
                <tr
                  class="border-b border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  @click="expandedKey = expandedKey === rowKey(row) ? null : rowKey(row)"
                >
                  <td class="px-2 py-1.5">{{ row.ym }}</td>
                  <td class="px-2 py-1.5">{{ row.summary.driverCd }}</td>
                  <td class="px-2 py-1.5">{{ row.summary.driverName }}</td>
                  <td class="px-2 py-1.5">{{ row.summary.branchName }}</td>
                  <td class="px-2 py-1.5 text-right">{{ row.summary.workDays }}</td>
                  <td class="px-2 py-1.5 text-right">{{ row.summary.restDays }}</td>
                  <td class="px-2 py-1.5 text-right font-medium">{{ fmt(row.summary.restraintMinutes) }}</td>
                  <td class="px-2 py-1.5 text-right">{{ fmt(row.summary.maxDailyRestraintMinutes) }}</td>
                  <td class="px-2 py-1.5 text-right">{{ fmt(row.summary.drivingMinutes) }}</td>
                  <td class="px-2 py-1.5 text-right">{{ fmt(row.summary.workingMinutes) }}</td>
                  <td class="px-2 py-1.5 text-right">{{ fmt(row.summary.overtimeMinutes) }}</td>
                  <td class="px-2 py-1.5 text-right">{{ fmt(row.summary.fiscalCumulativeMinutes) }}</td>
                  <td class="px-2 py-1.5 text-right whitespace-nowrap">
                    <UButton
                      size="xs"
                      variant="ghost"
                      icon="i-lucide-file-down"
                      title="theearth の生 CSV (Shift_JIS) をダウンロード"
                      @click.stop="downloadRawCsv(row)"
                    />
                    <UIcon
                      :name="expandedKey === rowKey(row) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                      class="align-middle text-gray-400"
                    />
                  </td>
                </tr>
                <!-- 日別詳細 -->
                <tr v-if="expandedKey === rowKey(row)">
                  <td colspan="13" class="px-4 py-3 bg-gray-50 dark:bg-gray-800/40">
                    <div class="overflow-x-auto">
                      <table class="w-full text-xs">
                        <thead>
                          <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                            <th class="px-2 py-1">日付</th>
                            <th class="px-2 py-1">始業</th>
                            <th class="px-2 py-1">終業</th>
                            <th class="px-2 py-1 text-right">拘束時間</th>
                            <th class="px-2 py-1 text-right">拘束累計</th>
                            <th class="px-2 py-1 text-right">運転</th>
                            <th class="px-2 py-1 text-right">荷役</th>
                            <th class="px-2 py-1 text-right">休憩</th>
                            <th class="px-2 py-1 text-right">休息</th>
                            <th class="px-2 py-1 text-right">実働</th>
                            <th class="px-2 py-1 text-right">時間外</th>
                            <th class="px-2 py-1">摘要</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr
                            v-for="dayRow in row.block.days"
                            :key="dayRow.date"
                            class="border-b border-gray-100 dark:border-gray-800"
                            :class="dayRow.isRestDay ? 'text-gray-400' : ''"
                          >
                            <td class="px-2 py-1 whitespace-nowrap">{{ dayRow.date }}</td>
                            <td class="px-2 py-1">{{ dayRow.isRestDay ? '休' : dayRow.startTime }}</td>
                            <td class="px-2 py-1">{{ dayRow.endTime }}</td>
                            <td class="px-2 py-1 text-right font-medium">{{ fmt(dayRow.restraintMinutes) }}</td>
                            <td class="px-2 py-1 text-right">{{ fmt(dayRow.restraintCumulativeMinutes) }}</td>
                            <td class="px-2 py-1 text-right">{{ fmt(dayRow.drivingMinutes) }}</td>
                            <td class="px-2 py-1 text-right">{{ fmt(dayRow.loadingMinutes) }}</td>
                            <td class="px-2 py-1 text-right">{{ fmt(dayRow.breakMinutes) }}</td>
                            <td class="px-2 py-1 text-right">{{ fmt(dayRow.restMinutes) }}</td>
                            <td class="px-2 py-1 text-right">{{ fmt(dayRow.workingMinutes) }}</td>
                            <td class="px-2 py-1 text-right">{{ fmt(dayRow.overtimeMinutes) }}</td>
                            <td class="px-2 py-1 text-gray-500">{{ dayRow.notes.join(' / ') }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              </template>
              <!-- 該当データなし (途中入社・休職・未集計) も明細に残す -->
              <tr v-for="nd in noDataItems" :key="`nd:${nd.ym}:${nd.driverCd}`" class="border-b border-gray-100 dark:border-gray-800 text-gray-400">
                <td class="px-2 py-1.5">{{ nd.ym }}</td>
                <td class="px-2 py-1.5">{{ nd.driverCd }}</td>
                <td class="px-2 py-1.5" colspan="11">該当データなし (途中入社・休職・未集計 等)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UCard>
    </div>
  </div>
</template>
