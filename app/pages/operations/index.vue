<script setup lang="ts">
import { getOperations, getDrivers, getVehicles } from '~/utils/api'
import type { OperationListItem, Driver, Vehicle } from '~/types'

const router = useRouter()

// Filters
const dateFrom = ref('')
const dateTo = ref('')
const selectedDriverCd = ref('')
const selectedVehicleCd = ref('')
const page = ref(1)
const perPage = 50

// Data
const operations = ref<OperationListItem[]>([])
const total = ref(0)
const drivers = ref<Driver[]>([])
const vehicles = ref<Vehicle[]>([])
const loading = ref(false)

// Table columns
const columns = [
  { key: 'reading_date', label: '読取日' },
  { key: 'unko_no', label: '運行NO' },
  { key: 'driver_name', label: 'ドライバー' },
  { key: 'vehicle_name', label: '車両' },
  { key: 'total_distance', label: '走行距離' },
  { key: 'safety_score', label: '安全' },
  { key: 'economy_score', label: '省エネ' },
  { key: 'total_score', label: '総合' },
]

async function fetchData() {
  loading.value = true
  try {
    const res = await getOperations({
      date_from: dateFrom.value || undefined,
      date_to: dateTo.value || undefined,
      driver_cd: selectedDriverCd.value || undefined,
      vehicle_cd: selectedVehicleCd.value || undefined,
      page: page.value,
      per_page: perPage,
    })
    operations.value = res.operations
    total.value = res.total
  } catch (e) {
    console.error('Failed to fetch operations:', e)
  } finally {
    loading.value = false
  }
}

// Fetch filter options
onMounted(async () => {
  await Promise.all([
    getDrivers().then(d => drivers.value = d).catch(() => {}),
    getVehicles().then(v => vehicles.value = v).catch(() => {}),
  ])
  await fetchData()
})

// Re-fetch on filter change
watch([dateFrom, dateTo, selectedDriverCd, selectedVehicleCd], () => {
  page.value = 1
  fetchData()
})

watch(page, fetchData)

function onRowClick(row: OperationListItem) {
  router.push(`/operations/${row.unko_no}`)
}

function formatDistance(val: number | null): string {
  if (val == null) return '-'
  return `${val.toFixed(1)} km`
}

function formatScore(val: number | null): string {
  if (val == null) return '-'
  return val.toFixed(1)
}

function scoreColor(val: number | null): string {
  if (val == null) return ''
  if (val >= 80) return 'text-green-600'
  if (val >= 60) return 'text-yellow-600'
  return 'text-red-600'
}

const totalPages = computed(() => Math.ceil(total.value / perPage))
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-xl font-bold">運行一覧</h2>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="text-xs text-gray-500 block mb-1">開始日</label>
        <input v-model="dateFrom" type="date" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">終了日</label>
        <input v-model="dateTo" type="date" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">ドライバー</label>
        <select v-model="selectedDriverCd" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
          <option value="">すべて</option>
          <option v-for="d in drivers" :key="d.id" :value="d.driver_cd">{{ d.driver_name }}</option>
        </select>
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">車両</label>
        <select v-model="selectedVehicleCd" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
          <option value="">すべて</option>
          <option v-for="v in vehicles" :key="v.id" :value="v.vehicle_cd">{{ v.vehicle_name }}</option>
        </select>
      </div>
    </div>

    <!-- Table -->
    <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th v-for="col in columns" :key="col.key" class="text-left px-4 py-3 font-medium text-gray-500">
              {{ col.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td :colspan="columns.length" class="px-4 py-8 text-center text-gray-400">
              <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
              読み込み中...
            </td>
          </tr>
          <tr v-else-if="operations.length === 0">
            <td :colspan="columns.length" class="px-4 py-8 text-center text-gray-400">
              データがありません
            </td>
          </tr>
          <tr
            v-for="op in operations"
            v-else
            :key="op.id"
            class="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
            @click="onRowClick(op)"
          >
            <td class="px-4 py-3">{{ op.reading_date }}</td>
            <td class="px-4 py-3 font-mono">{{ op.unko_no }}</td>
            <td class="px-4 py-3">{{ op.driver_name || '-' }}</td>
            <td class="px-4 py-3">{{ op.vehicle_name || '-' }}</td>
            <td class="px-4 py-3">{{ formatDistance(op.total_distance) }}</td>
            <td class="px-4 py-3" :class="scoreColor(op.safety_score)">{{ formatScore(op.safety_score) }}</td>
            <td class="px-4 py-3" :class="scoreColor(op.economy_score)">{{ formatScore(op.economy_score) }}</td>
            <td class="px-4 py-3" :class="scoreColor(op.total_score)">{{ formatScore(op.total_score) }}</td>
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
