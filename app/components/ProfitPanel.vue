<script setup lang="ts">
/**
 * `/operations/[unko_no]` の「イベント」タブ: 選択区間に対応する一番星の伝票候補を
 * 検索し、確認 (チェックボックス) した伝票の売上合計とデジタコ実績 (距離・時間) を
 * 並列表示する収支パネル (Refs #330 PR4)。EventSelectionSummaryPanel (デジタコ実績、
 * 画面左下) / EventSpeedMapPanel (速度カラーMap、画面右下) と並ぶ第3のフローティング
 * パネル (画面下中央)。
 *
 * 突合ロジック (スコアリング・効率指標計算) は `app/utils/ichiban.ts` の pure 関数に
 * 集約し、このコンポーネントは fetch のトリガーと選択状態の保持に専念する。
 */
import type { SelectedRowsSummary, SelectedRowsLocationRange } from '~/utils/event-data-table'
import {
  fetchVehicleDailySlips,
  vehicleDailyDateRange,
  scoreVehicleDailySlips,
  calcProfitEfficiency,
  type ScoredVehicleDailySlip,
} from '~/utils/ichiban'

const props = defineProps<{
  vehicleCode: string | null
  range: { fromTs: number, toTs: number } | null
  location: SelectedRowsLocationRange | null
  summary: SelectedRowsSummary
}>()

defineEmits<{ close: [] }>()

type FetchStatus = 'idle' | 'loading' | 'ready' | 'error' | 'no-vehicle'

const status = ref<FetchStatus>('idle')
const errorMessage = ref<string | null>(null)
const scoredSlips = ref<ScoredVehicleDailySlip[]>([])
const confirmedRowIds = ref<Set<string>>(new Set())

async function load() {
  if (!props.vehicleCode || !props.range) {
    status.value = 'no-vehicle'
    scoredSlips.value = []
    confirmedRowIds.value = new Set()
    return
  }
  status.value = 'loading'
  errorMessage.value = null
  try {
    const { from, to } = vehicleDailyDateRange(props.range.fromTs, props.range.toTs)
    const slips = await fetchVehicleDailySlips(props.vehicleCode, from, to)
    const scored = scoreVehicleDailySlips(
      props.location?.originCity ?? '',
      props.location?.destCity ?? '',
      slips,
    )
    scoredSlips.value = scored
    confirmedRowIds.value = new Set(scored.filter(s => s.suggested).map(s => s.slip.rowId))
    status.value = 'ready'
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
  }
}

watch([() => props.vehicleCode, () => props.range], load, { immediate: true })

function toggleConfirmed(rowId: string) {
  const next = new Set(confirmedRowIds.value)
  if (next.has(rowId)) next.delete(rowId)
  else next.add(rowId)
  confirmedRowIds.value = next
}

const confirmedAmount = computed(() =>
  scoredSlips.value
    .filter(s => confirmedRowIds.value.has(s.slip.rowId))
    .reduce((sum, s) => sum + s.slip.amount, 0),
)

const efficiency = computed(() => calcProfitEfficiency(
  confirmedAmount.value,
  props.summary.distanceKm,
  props.summary.durationMin,
  props.summary.byCategory.drive,
))

function formatYen(v: number | null): string {
  return v === null ? '-' : Math.round(v).toLocaleString('ja-JP')
}

/** 品名N/数量/単価をまとめて1列に表示するための整形。同一日でも複数明細で単価が
 * 異なりうることを一目で確認できるようにする (Refs #330 実データ検証)。 */
function formatItem(slip: ScoredVehicleDailySlip['slip']): string {
  if (!slip.itemName) return '-'
  const qty = slip.quantity > 0 ? `${slip.quantity}${slip.unit}` : ''
  const price = slip.unitPrice > 0 ? `@${formatYen(slip.unitPrice)}` : ''
  const detail = [qty, price].filter(Boolean).join(' ')
  return detail ? `${slip.itemName} (${detail})` : slip.itemName
}

const matchBadgeClass: Record<string, string> = {
  exact: 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300',
  partial: 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300',
  none: 'bg-gray-100 dark:bg-gray-800 text-gray-400',
}

const matchBadgeLabel: Record<string, string> = { exact: '完全一致', partial: '部分一致', none: '根拠なし' }
</script>

<template>
  <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[560px] max-w-[calc(100vw-2rem)] rounded-lg shadow-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-hidden">
    <div class="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
      <span class="text-xs font-medium text-gray-600 dark:text-gray-300">収支パネル (一番星 × デジタコ)</span>
      <button class="text-gray-400 hover:text-gray-600" @click="$emit('close')">
        <UIcon name="i-lucide-x" class="size-4" />
      </button>
    </div>

    <div v-if="status === 'no-vehicle'" class="px-4 py-6 text-xs text-gray-400 text-center">
      車輌CD が特定できないため一番星との突合はできません
    </div>
    <div v-else-if="status === 'loading'" class="px-4 py-6 text-xs text-gray-400 flex items-center justify-center gap-2">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />
      一番星の伝票を検索中...
    </div>
    <div v-else-if="status === 'error'" class="px-4 py-6 text-xs text-red-600 dark:text-red-400 text-center">
      {{ errorMessage }}
    </div>
    <template v-else-if="status === 'ready'">
      <div class="max-h-64 overflow-y-auto overflow-x-auto">
        <table v-if="scoredSlips.length" class="w-full text-xs min-w-[640px]">
          <thead class="bg-gray-50 dark:bg-gray-800 sticky top-0">
            <tr>
              <th class="w-8" />
              <th class="text-left px-2 py-1.5 font-medium text-gray-500">日付</th>
              <th class="text-left px-2 py-1.5 font-medium text-gray-500">得意先</th>
              <th class="text-left px-2 py-1.5 font-medium text-gray-500">積地→卸地</th>
              <th class="text-left px-2 py-1.5 font-medium text-gray-500">品名 (数量@単価)</th>
              <th class="text-right px-2 py-1.5 font-medium text-gray-500">金額</th>
              <th class="text-center px-2 py-1.5 font-medium text-gray-500">根拠</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="s in scoredSlips"
              :key="s.slip.rowId"
              class="border-t border-gray-100 dark:border-gray-800 cursor-pointer"
              :class="confirmedRowIds.has(s.slip.rowId) ? 'bg-blue-50 dark:bg-blue-950/40' : ''"
              @click="toggleConfirmed(s.slip.rowId)"
            >
              <td class="px-2 py-1.5" @click.stop="toggleConfirmed(s.slip.rowId)">
                <input type="checkbox" :checked="confirmedRowIds.has(s.slip.rowId)" class="cursor-pointer" @click.stop="toggleConfirmed(s.slip.rowId)">
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">{{ s.slip.saleDate }}</td>
              <td class="px-2 py-1.5">{{ s.slip.customerName || '-' }}</td>
              <td class="px-2 py-1.5">{{ s.slip.originAreaName || s.slip.origin || '?' }} → {{ s.slip.destAreaName || s.slip.dest || '?' }}</td>
              <td class="px-2 py-1.5 whitespace-nowrap">{{ formatItem(s.slip) }}</td>
              <td class="px-2 py-1.5 text-right whitespace-nowrap">{{ formatYen(s.slip.amount) }}</td>
              <td class="px-2 py-1.5 text-center">
                <span class="px-1.5 py-0.5 rounded text-[10px]" :class="matchBadgeClass[s.score > 0 ? (s.originMatch !== 'none' && s.destMatch !== 'none' ? 'exact' : 'partial') : 'none']">
                  {{ s.suggested ? matchBadgeLabel.exact : (s.score > 0 ? matchBadgeLabel.partial : matchBadgeLabel.none) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-4 py-6 text-xs text-gray-400 text-center">
          この車輌・期間の伝票が見つかりませんでした
        </p>
      </div>

      <div class="px-3 py-2 border-t border-gray-100 dark:border-gray-800 grid grid-cols-2 gap-3 text-xs">
        <div>
          <span class="text-gray-500 block">確定売上 (税抜)</span>
          <span class="text-sm font-semibold">{{ formatYen(confirmedAmount) }} 円</span>
        </div>
        <div>
          <span class="text-gray-500 block">距離 / 時間 (拘束)</span>
          <span class="text-sm font-semibold">{{ summary.distanceKm.toFixed(1) }} km / {{ (summary.durationMin / 60).toFixed(1) }} h</span>
        </div>
        <div>
          <span class="text-gray-500 block">円/km</span>
          <span class="text-sm font-semibold">{{ formatYen(efficiency.yenPerKm) }}</span>
        </div>
        <div>
          <span class="text-gray-500 block">円/時間 (拘束 / 運転)</span>
          <span class="text-sm font-semibold">{{ formatYen(efficiency.yenPerHourBound) }} / {{ formatYen(efficiency.yenPerHourDrive) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
