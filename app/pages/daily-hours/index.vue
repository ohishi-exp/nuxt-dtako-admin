<script setup lang="ts">
import { getDailyHours, getDrivers, getWorkTimes } from '~/utils/api'
import type { DailyWorkHours, Driver, WorkTimeItem } from '~/types'

// Tab
const activeTab = ref('segments')

// Filters
const selectedDriverId = ref('')
const now = new Date()
const selectedMonth = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
const page = ref(1)
const perPage = 50

// Data
const items = ref<DailyWorkHours[]>([])
const total = ref(0)
const drivers = ref<Driver[]>([])
const workTimeItems = ref<WorkTimeItem[]>([])
const wtTotal = ref(0)
const loading = ref(false)

function buildFilter() {
  let date_from: string | undefined
  let date_to: string | undefined
  if (selectedMonth.value) {
    const [y, m] = selectedMonth.value.split('-').map(Number)
    date_from = `${y}-${String(m).padStart(2, '0')}-01`
    const lastDay = new Date(y, m, 0).getDate()
    date_to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  }
  return {
    driver_id: selectedDriverId.value || undefined,
    date_from,
    date_to,
    page: page.value,
    per_page: perPage,
  }
}

async function fetchData() {
  loading.value = true
  try {
    const filter = buildFilter()
    const [hoursRes, wtRes] = await Promise.all([
      getDailyHours(filter),
      getWorkTimes(filter),
    ])
    items.value = hoursRes.items
    total.value = hoursRes.total
    workTimeItems.value = wtRes.items
    wtTotal.value = wtRes.total
  } catch (e) {
    console.error('Failed to fetch daily hours:', e)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await getDrivers().then(d => drivers.value = d).catch(() => {})
  await fetchData()
})

watch([selectedDriverId, selectedMonth], () => {
  page.value = 1
  fetchData()
})

watch(page, fetchData)

function formatMinutes(val: number | null): string {
  if (val == null) return '-'
  const h = Math.floor(val / 60)
  const m = val % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

const currentTotal = computed(() => activeTab.value === 'segments' ? wtTotal.value : total.value)
const totalPages = computed(() => Math.ceil(currentTotal.value / perPage))

// ドライバー名を引くためのマップ
const driverMap = computed(() => {
  const map = new Map<string, string>()
  for (const d of drivers.value) {
    map.set(d.id, d.driver_name)
  }
  return map
})

function formatTime(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })
}

function isNextDay(isoString: string, workDate: string): boolean {
  const d = new Date(isoString)
  const jstDate = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
  return jstDate !== workDate
}

function onTabChange() {
  page.value = 1
  fetchData()
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-xl font-bold">日別労働時間</h2>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="text-xs text-gray-500 block mb-1">ドライバー</label>
        <DriverSearchSelect v-model="selectedDriverId" :drivers="drivers" />
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">月</label>
        <input v-model="selectedMonth" type="month" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 border-b border-gray-200 dark:border-gray-700">
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'segments' ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-700'"
        @click="activeTab = 'segments'; onTabChange()"
      >
        始業・終業
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'daily' ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-700'"
        @click="activeTab = 'daily'; onTabChange()"
      >
        日別集計
      </button>
    </div>

    <!-- 始業・終業 Table -->
    <div v-if="activeTab === 'segments'" class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th class="text-left px-4 py-3 font-medium text-gray-500">日付</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">ドライバー</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">運行番号</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">始業</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">終業</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">拘束時間</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">労働時間</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">
              <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
              読み込み中...
            </td>
          </tr>
          <tr v-else-if="workTimeItems.length === 0">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">
              データがありません
            </td>
          </tr>
          <tr
            v-for="wt in workTimeItems"
            v-else
            :key="wt.id"
            class="border-t border-gray-100 dark:border-gray-800"
          >
            <td class="px-4 py-3">{{ wt.work_date }}</td>
            <td class="px-4 py-3">{{ driverMap.get(wt.driver_id) || '-' }}</td>
            <td class="px-4 py-3">{{ wt.unko_no }}</td>
            <td class="px-4 py-3">{{ formatTime(wt.start_at) }}</td>
            <td class="px-4 py-3">
              <span v-if="isNextDay(wt.end_at, wt.work_date)" class="text-orange-500 text-xs mr-0.5">翌</span>{{ formatTime(wt.end_at) }}
            </td>
            <td class="px-4 py-3">{{ formatMinutes(wt.work_minutes) }}</td>
            <td class="px-4 py-3">{{ formatMinutes(wt.labor_minutes) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 日別集計 Table -->
    <div v-if="activeTab === 'daily'" class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th class="text-left px-4 py-3 font-medium text-gray-500">日付</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">ドライバー</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">拘束時間</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">運転時間</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">休憩時間</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">走行距離</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">運行数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">
              <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
              読み込み中...
            </td>
          </tr>
          <tr v-else-if="items.length === 0">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">
              データがありません
            </td>
          </tr>
          <tr
            v-for="item in items"
            v-else
            :key="item.id"
            class="border-t border-gray-100 dark:border-gray-800"
          >
            <td class="px-4 py-3">{{ item.work_date }}</td>
            <td class="px-4 py-3">{{ driverMap.get(item.driver_id) || '-' }}</td>
            <td class="px-4 py-3">{{ formatMinutes(item.total_work_minutes) }}</td>
            <td class="px-4 py-3">{{ formatMinutes(item.total_drive_minutes) }}</td>
            <td class="px-4 py-3">{{ formatMinutes(item.total_rest_minutes) }}</td>
            <td class="px-4 py-3">{{ item.total_distance?.toFixed(1) ?? '-' }} km</td>
            <td class="px-4 py-3">{{ item.operation_count }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="flex items-center justify-between">
      <span class="text-sm text-gray-500">{{ currentTotal }} 件中 {{ (page - 1) * perPage + 1 }}〜{{ Math.min(page * perPage, currentTotal) }} 件</span>
      <div class="flex gap-1">
        <UButton :disabled="page <= 1" variant="outline" size="sm" icon="i-lucide-chevron-left" @click="page--" />
        <UButton :disabled="page >= totalPages" variant="outline" size="sm" icon="i-lucide-chevron-right" @click="page++" />
      </div>
    </div>
  </div>
</template>
