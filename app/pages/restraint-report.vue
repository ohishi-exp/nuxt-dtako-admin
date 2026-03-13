<script setup lang="ts">
import { getDrivers, getRestraintReport } from '~/utils/api'
import type { Driver, RestraintReportResponse, RestraintDayRow } from '~/types'

const drivers = ref<Driver[]>([])
const selectedDriverId = ref('')
const selectedMonth = ref('')
const report = ref<RestraintReportResponse | null>(null)
const loading = ref(false)
const error = ref('')

async function fetchReport() {
  if (!selectedDriverId.value || !selectedMonth.value) return
  loading.value = true
  error.value = ''
  try {
    const [y, m] = selectedMonth.value.split('-').map(Number)
    report.value = await getRestraintReport({
      driver_id: selectedDriverId.value,
      year: y,
      month: m,
    })
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'データ取得に失敗しました'
    report.value = null
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await getDrivers().then(d => drivers.value = d).catch(() => {})
})

watch([selectedDriverId, selectedMonth], () => {
  if (selectedDriverId.value && selectedMonth.value) fetchReport()
})

function fmt(val: number | null | undefined): string {
  if (val == null || val === 0) return ''
  const h = Math.floor(val / 60)
  const m = val % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

function fmtOrDash(val: number | null | undefined): string {
  return fmt(val) || '-'
}

function isWeekSubtotalAfter(day: RestraintDayRow, index: number, days: RestraintDayRow[]): boolean {
  if (!report.value) return false
  return report.value.weekly_subtotals.some(ws => ws.week_end_date === day.date)
}

function getWeekSubtotal(date: string) {
  return report.value?.weekly_subtotals.find(ws => ws.week_end_date === date)
}

const driverName = computed(() => {
  if (report.value) return report.value.driver_name
  const d = drivers.value.find(d => d.id === selectedDriverId.value)
  return d?.driver_name || ''
})

const monthLabel = computed(() => {
  if (!selectedMonth.value) return ''
  const [y, m] = selectedMonth.value.split('-').map(Number)
  return `令和${y - 2018}年${m}月分`
})
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-xl font-bold">拘束時間管理表</h2>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="text-xs text-gray-500 block mb-1">ドライバー</label>
        <select v-model="selectedDriverId" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
          <option value="" disabled>選択してください</option>
          <option v-for="d in drivers" :key="d.id" :value="d.id">{{ d.driver_name }}</option>
        </select>
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">月</label>
        <input v-model="selectedMonth" type="month" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
      <UButton label="表示" icon="i-lucide-search" size="sm" :loading="loading" :disabled="!selectedDriverId || !selectedMonth" @click="fetchReport" />
    </div>

    <UAlert v-if="error" :title="error" color="error" icon="i-lucide-circle-x" variant="subtle" />

    <!-- Empty state -->
    <div v-if="!report && !loading && !error" class="text-center text-gray-400 py-12">
      ドライバーと月を選択してください
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12 text-gray-400">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
      読み込み中...
    </div>

    <!-- Report -->
    <div v-if="report && !loading" class="space-y-4">
      <!-- Header -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
        <div class="flex justify-between items-center">
          <div>
            <span class="text-lg font-bold">拘束時間管理表</span>
            <span class="ml-4 text-gray-500">{{ monthLabel }}</span>
          </div>
          <div class="text-sm text-gray-500">
            当月最大拘束時間: <span class="font-medium text-gray-900 dark:text-white">{{ fmt(report.max_restraint_minutes) }}</span>
          </div>
        </div>
        <div class="mt-1 text-sm">
          氏名: <span class="font-medium">{{ report.driver_name }}</span>
        </div>
      </div>

      <!-- Table -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        <table class="w-full text-xs whitespace-nowrap">
          <thead class="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">日付</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" colspan="2">始業終業時刻</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" colspan="4">拘束時間</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">合計</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">拘束<br>累計</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">運転<br>平均</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">休息<br>時間</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center" rowspan="2">摘要</th>
            </tr>
            <tr>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">始業</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">終業</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">運転</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">荷役</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">休憩</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">小計</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(day, idx) in report.days" :key="day.date">
              <!-- Holiday row -->
              <tr v-if="day.is_holiday" class="border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700">{{ day.date.slice(8) }}</td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700 text-red-500 font-medium" colspan="6">休</td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700"></td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700"></td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700"></td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700"></td>
                <td class="px-2 py-1.5"></td>
              </tr>

              <!-- Working day -->
              <template v-else>
                <!-- First operation row (with start/end time and totals) -->
                <tr class="border-t border-gray-100 dark:border-gray-800">
                  <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ day.date.slice(8) }}
                  </td>
                  <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ day.start_time || '' }}
                  </td>
                  <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ day.end_time || '' }}
                  </td>
                  <!-- First operation breakdown -->
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700">
                    {{ day.operations.length ? fmt(day.operations[0].drive_minutes) : '' }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700">
                    {{ day.operations.length ? fmt(day.operations[0].cargo_minutes) : '' }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700">
                    {{ day.operations.length ? fmt(day.operations[0].break_minutes) : '' }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700">
                    {{ day.operations.length ? fmt(day.operations[0].restraint_minutes) : '' }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700 font-medium" :rowspan="day.operations.length || 1">
                    {{ fmt(day.restraint_total_minutes) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ fmt(day.restraint_cumulative_minutes) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ fmt(Math.round(day.drive_average_minutes)) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ day.rest_period_minutes != null ? fmt(day.rest_period_minutes) : '' }}
                  </td>
                  <td class="px-2 py-1.5 text-xs" :rowspan="day.operations.length || 1">
                    {{ day.remarks }}
                  </td>
                </tr>

                <!-- Additional operation rows (stacked) -->
                <tr
                  v-for="(op, opIdx) in day.operations.slice(1)"
                  :key="`${day.date}-${opIdx}`"
                  class="border-t border-gray-50 dark:border-gray-800/50"
                >
                  <td class="px-2 py-1 text-right border-r border-gray-200 dark:border-gray-700 text-gray-500">
                    {{ fmt(op.drive_minutes) }}
                  </td>
                  <td class="px-2 py-1 text-right border-r border-gray-200 dark:border-gray-700 text-gray-500">
                    {{ fmt(op.cargo_minutes) }}
                  </td>
                  <td class="px-2 py-1 text-right border-r border-gray-200 dark:border-gray-700 text-gray-500">
                    {{ fmt(op.break_minutes) }}
                  </td>
                  <td class="px-2 py-1 text-right border-r border-gray-200 dark:border-gray-700 text-gray-500">
                    {{ fmt(op.restraint_minutes) }}
                  </td>
                </tr>
              </template>

              <!-- Weekly subtotal row -->
              <tr v-if="getWeekSubtotal(day.date)" class="border-t-2 border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/30">
                <td class="px-2 py-1.5 text-center font-medium text-blue-600 dark:text-blue-400 border-r border-gray-200 dark:border-gray-700" colspan="3">
                  小計
                </td>
                <td class="px-2 py-1.5 text-right font-medium border-r border-gray-200 dark:border-gray-700">
                  {{ fmt(getWeekSubtotal(day.date)!.drive_minutes) }}
                </td>
                <td class="px-2 py-1.5 text-right font-medium border-r border-gray-200 dark:border-gray-700">
                  {{ fmt(getWeekSubtotal(day.date)!.cargo_minutes) }}
                </td>
                <td class="px-2 py-1.5 text-right font-medium border-r border-gray-200 dark:border-gray-700">
                  {{ fmt(getWeekSubtotal(day.date)!.break_minutes) }}
                </td>
                <td class="px-2 py-1.5 text-right font-medium border-r border-gray-200 dark:border-gray-700">
                  {{ fmt(getWeekSubtotal(day.date)!.restraint_minutes) }}
                </td>
                <td colspan="5"></td>
              </tr>
            </template>

            <!-- Monthly total -->
            <tr class="border-t-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 font-medium">
              <td class="px-2 py-2 text-center border-r border-gray-200 dark:border-gray-700" colspan="3">合計</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700">{{ fmt(report.monthly_total.drive_minutes) }}</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700">{{ fmt(report.monthly_total.cargo_minutes) }}</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700">{{ fmt(report.monthly_total.break_minutes) }}</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700">{{ fmt(report.monthly_total.restraint_minutes) }}</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700" colspan="5"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Footer summary -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 text-sm space-y-1">
        <div class="flex gap-8">
          <div>
            4月〜前月 累計拘束時間:
            <span class="font-medium">{{ fmt(report.monthly_total.fiscal_year_cumulative_minutes) }}</span>
          </div>
          <div>
            当月拘束時間:
            <span class="font-medium">{{ fmt(report.monthly_total.restraint_minutes) }}</span>
          </div>
          <div>
            年度合計:
            <span class="font-bold">{{ fmt(report.monthly_total.fiscal_year_total_minutes) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
