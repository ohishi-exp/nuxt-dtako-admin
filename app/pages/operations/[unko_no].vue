<script setup lang="ts">
import { getOperation, getOperationCsv, deleteOperation, getDrivers, getVehicles } from '~/utils/api'
import type { Operation, CsvJsonResponse, CsvType } from '~/types'

const route = useRoute()
const router = useRouter()
const unkoNo = route.params.unko_no as string

// Data
const operations = ref<Operation[]>([])
const loading = ref(true)
const deleteConfirm = ref(false)
const deleting = ref(false)

// CSV tabs
const csvTabs = [
  { key: 'events' as CsvType, label: 'イベント' },
  { key: 'kudguri' as CsvType, label: '拘束データ' },
  { key: 'tolls' as CsvType, label: '料金' },
  { key: 'ferries' as CsvType, label: 'フェリー' },
  { key: 'speed' as CsvType, label: '速度' },
]
/** NET780 タブは CSV エンドポイント (getOperationCsv) を経由しないため
 * CsvType には含めず、表示切替専用の別値として扱う (Refs #299)。 */
const allTabs: { key: CsvType | 'net780'; label: string }[] = [
  ...csvTabs,
  { key: 'net780', label: 'NET780' },
]
const activeTab = ref<CsvType | 'net780'>('events')
const csvData = ref<Record<string, CsvJsonResponse>>({})
const csvLoading = ref(false)

// Fetch operation detail
onMounted(async () => {
  try {
    operations.value = await getOperation(unkoNo)
  } catch (e) {
    console.error('Failed to fetch operation:', e)
  } finally {
    loading.value = false
  }
  if (activeTab.value !== 'net780') await loadCsv(activeTab.value)
})

async function loadCsv(csvType: CsvType) {
  if (csvData.value[csvType]) return
  csvLoading.value = true
  try {
    csvData.value[csvType] = await getOperationCsv(unkoNo, csvType)
  } catch (e) {
    console.error(`Failed to load ${csvType}:`, e)
    csvData.value[csvType] = { headers: [], rows: [] }
  } finally {
    csvLoading.value = false
  }
}

/** NET780 検索 (/net780) の車輌CD/乗務員CD 事前入力用。Operation は
 * vehicle_id/driver_id (rust-alc-api の内部ID) しか持たず、CD 自体は
 * Driver/Vehicle の一覧から id で引く必要がある (Refs #299)。NET780 タブを
 * 開いた時だけ遅延取得する (他タブしか見ないユーザーには不要な取得)。 */
const net780VehicleCd = ref<string | null>(null)
const net780DriverCd = ref<string | null>(null)
let net780CdsRequested = false

async function loadNet780Cds() {
  if (net780CdsRequested || !primary.value) return
  net780CdsRequested = true
  try {
    const [drivers, vehicles] = await Promise.all([getDrivers(), getVehicles()])
    net780DriverCd.value = drivers.find(d => d.id === primary.value?.driver_id)?.driver_cd ?? null
    net780VehicleCd.value = vehicles.find(v => v.id === primary.value?.vehicle_id)?.vehicle_cd ?? null
  } catch (e) {
    console.error('Failed to load driver/vehicle cd for NET780 tab:', e)
  }
}

watch(activeTab, (tab) => {
  if (tab === 'net780') loadNet780Cds()
  else loadCsv(tab)
})

const primary = computed(() => operations.value[0])

async function handleDelete() {
  deleting.value = true
  try {
    await deleteOperation(unkoNo)
    router.push('/operations')
  } catch (e) {
    console.error('Failed to delete:', e)
  } finally {
    deleting.value = false
    deleteConfirm.value = false
  }
}

function formatDatetime(val: string | null): string {
  if (!val) return '-'
  return new Date(val).toLocaleString('ja-JP')
}
</script>

<template>
  <div class="space-y-6">
    <!-- Back button -->
    <UButton label="一覧に戻る" icon="i-lucide-arrow-left" variant="ghost" to="/operations" />

    <div v-if="loading" class="flex items-center justify-center py-12">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-6" />
    </div>

    <template v-else-if="primary">
      <!-- Header -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
        <div class="flex items-start justify-between">
          <div>
            <h2 class="text-xl font-bold mb-4">運行 {{ unkoNo }}</h2>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span class="text-gray-500 block">読取日</span>
                {{ primary.reading_date }}
              </div>
              <div>
                <span class="text-gray-500 block">出発</span>
                {{ formatDatetime(primary.departure_at) }}
              </div>
              <div>
                <span class="text-gray-500 block">帰着</span>
                {{ formatDatetime(primary.return_at) }}
              </div>
              <div>
                <span class="text-gray-500 block">走行距離</span>
                {{ primary.total_distance?.toFixed(1) ?? '-' }} km
              </div>
              <div>
                <span class="text-gray-500 block">安全スコア</span>
                <span :class="(primary.safety_score ?? 0) >= 80 ? 'text-green-600' : 'text-yellow-600'">
                  {{ primary.safety_score?.toFixed(1) ?? '-' }}
                </span>
              </div>
              <div>
                <span class="text-gray-500 block">省エネスコア</span>
                <span :class="(primary.economy_score ?? 0) >= 80 ? 'text-green-600' : 'text-yellow-600'">
                  {{ primary.economy_score?.toFixed(1) ?? '-' }}
                </span>
              </div>
              <div>
                <span class="text-gray-500 block">総合スコア</span>
                <span :class="(primary.total_score ?? 0) >= 80 ? 'text-green-600' : 'text-yellow-600'">
                  {{ primary.total_score?.toFixed(1) ?? '-' }}
                </span>
              </div>
            </div>
          </div>

          <UButton
            label="削除"
            icon="i-lucide-trash-2"
            color="error"
            variant="outline"
            @click="deleteConfirm = true"
          />
        </div>
      </div>

      <!-- CSV Tabs -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
        <div class="border-b border-gray-200 dark:border-gray-800 flex">
          <button
            v-for="tab in allTabs"
            :key="tab.key"
            class="px-4 py-3 text-sm font-medium transition-colors border-b-2"
            :class="activeTab === tab.key
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </div>
        <Net780OperationSummary
          v-if="activeTab === 'net780'"
          :operation-no="unkoNo"
          :operation-date="primary.operation_date ?? primary.reading_date"
          :vehicle-cd="net780VehicleCd"
          :driver-cd="net780DriverCd"
        />
        <EventDataTable
          v-else-if="activeTab === 'events'"
          :data="csvData[activeTab] || { headers: [], rows: [] }"
          :loading="csvLoading && !csvData[activeTab]"
        />
        <CsvDataTable
          v-else
          :headers="csvData[activeTab]?.headers || []"
          :rows="csvData[activeTab]?.rows || []"
          :loading="csvLoading && !csvData[activeTab]"
        />
      </div>
    </template>

    <div v-else class="text-center py-12 text-gray-400">
      運行データが見つかりません
    </div>

    <!-- Delete confirmation modal -->
    <UModal v-model:open="deleteConfirm">
      <template #content>
        <div class="p-6 space-y-4">
          <h3 class="text-lg font-bold">運行データの削除</h3>
          <p class="text-gray-600 dark:text-gray-400">
            運行 {{ unkoNo }} を削除しますか？この操作は取り消せません。
          </p>
          <div class="flex justify-end gap-2">
            <UButton label="キャンセル" variant="outline" @click="deleteConfirm = false" />
            <UButton label="削除" color="error" :loading="deleting" @click="handleDelete" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
