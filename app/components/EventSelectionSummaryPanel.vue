<script setup lang="ts">
/**
 * `/operations/[unko_no]` の「イベント」タブ: 行選択に応じてデジタコ実績 (距離・
 * 時間内訳) を画面左下にフローティング表示する (Refs #330 PR3)。一番星の売上との
 * 突合パネル (PR4) はこのパネルの隣に並べる想定で、まずはデジタコ側のみで完結する。
 * 集計自体は `summarizeSelectedRows` (pure) が算出し、このコンポーネントは表示に専念する。
 */
import type { SelectedRowsSummary } from '~/utils/event-data-table'
import { OPERATION_TIME_CATEGORY_ORDER, OPERATION_TIME_CATEGORY_LABELS, formatDuration } from '~/utils/event-data-table'

const props = defineProps<{
  summary: SelectedRowsSummary
}>()

defineEmits<{ close: [] }>()

const nonZeroCategories = computed(() =>
  OPERATION_TIME_CATEGORY_ORDER.filter(cat => props.summary.byCategory[cat] > 0),
)
</script>

<template>
  <div class="fixed bottom-4 left-4 z-40 w-[320px] max-w-[calc(100vw-2rem)] rounded-lg shadow-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-hidden">
    <div class="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
      <span class="text-xs font-medium text-gray-600 dark:text-gray-300">
        選択区間の実績 ({{ summary.rowCount }}行)
      </span>
      <button class="text-gray-400 hover:text-gray-600" @click="$emit('close')">
        <UIcon name="i-lucide-x" class="size-4" />
      </button>
    </div>

    <div class="px-3 py-3 space-y-3 text-xs">
      <div class="grid grid-cols-2 gap-2">
        <div>
          <span class="text-gray-500 block">距離</span>
          <span class="text-sm font-semibold">{{ summary.distanceKm.toFixed(1) }} km</span>
        </div>
        <div>
          <span class="text-gray-500 block">時間</span>
          <span class="text-sm font-semibold">{{ formatDuration(String(summary.durationMin)) }}</span>
        </div>
      </div>

      <div v-if="nonZeroCategories.length">
        <p class="text-gray-500 mb-1">時間内訳</p>
        <ul class="space-y-1">
          <li v-for="cat in nonZeroCategories" :key="cat" class="flex items-center justify-between">
            <span>{{ OPERATION_TIME_CATEGORY_LABELS[cat] }}</span>
            <span>{{ formatDuration(String(summary.byCategory[cat])) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
