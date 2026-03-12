<script setup lang="ts">
import { getDailyHours, getDrivers } from '~/utils/api'
import type { DailyWorkHours, Driver } from '~/types'

// Filters
const selectedDriverId = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const page = ref(1)
const perPage = 50

// Data
const items = ref<DailyWorkHours[]>([])
const total = ref(0)
const drivers = ref<Driver[]>([])
const loading = ref(false)

async function fetchData() {
  loading.value = true
  try {
    const res = await getDailyHours({
      driver_id: selectedDriverId.value || undefined,
      date_from: dateFrom.value || undefined,
      date_to: dateTo.value || undefined,
      page: page.value,
      per_page: perPage,
    })
    items.value = res.items
    total.value = res.total
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

watch([selectedDriverId, dateFrom, dateTo], () => {
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

const totalPages = computed(() => Math.ceil(total.value / perPage))

// ドライバー名を引くためのマップ
const driverMap = computed(() => {
  const map = new Map<string, string>()
  for (const d of drivers.value) {
    map.set(d.id, d.driver_name)
  }
  return map
})
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-xl font-bold">日別労働時間</h2>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="text-xs text-gray-500 block mb-1">ドライバー</label>
        <select v-model="selectedDriverId" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
          <option value="">すべて</option>
          <option v-for="d in drivers" :key="d.id" :value="d.id">{{ d.driver_name }}</option>
        </select>
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">開始日</label>
        <input v-model="dateFrom" type="date" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">終了日</label>
        <input v-model="dateTo" type="date" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
    </div>

    <!-- Table -->
    <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
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
      <span class="text-sm text-gray-500">{{ total }} 件中 {{ (page - 1) * perPage + 1 }}〜{{ Math.min(page * perPage, total) }} 件</span>
      <div class="flex gap-1">
        <UButton :disabled="page <= 1" variant="outline" size="sm" icon="i-lucide-chevron-left" @click="page--" />
        <UButton :disabled="page >= totalPages" variant="outline" size="sm" icon="i-lucide-chevron-right" @click="page++" />
      </div>
    </div>
  </div>
</template>
