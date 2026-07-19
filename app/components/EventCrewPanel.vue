<script setup lang="ts">
import type { CrewGroup, EventCategory, SelectedRowsSummary } from '~/utils/event-data-table'
import {
  colIndex,
  getDisplayColumns,
  eventRowClass,
  columnAlignClass,
  selectedRowsTimeRange,
  summarizeSelectedRows,
  filterRowsByCategory,
  countRowsByCategory,
  EVENT_CATEGORY_ORDER,
  EVENT_CATEGORY_LABELS,
} from '~/utils/event-data-table'

const props = defineProps<{
  group: CrewGroup
  headers: string[]
}>()

const emit = defineEmits<{
  'update:selectedRange': [range: { fromTs: number, toTs: number } | null]
  'update:selectedSummary': [summary: SelectedRowsSummary | null]
}>()

/** イベント/走行/アイドリング/速度超過 の4タブ (排他選択)。 */
const activeCategory = ref<EventCategory>('event')

const eventNameIdx = computed(() => colIndex(props.headers, 'イベント名'))

const filteredRows = computed(() =>
  filterRowsByCategory(props.group.rows, eventNameIdx.value, activeCategory.value),
)

const categoryCounts = computed(() => {
  const counts = {} as Record<EventCategory, number>
  for (const cat of EVENT_CATEGORY_ORDER) {
    counts[cat] = countRowsByCategory(props.group.rows, eventNameIdx.value, cat)
  }
  return counts
})

const displayColumns = computed(() => getDisplayColumns(props.headers))

/** 選択行 index (filteredRows 基準)。地図パネル (速度カラー) に渡す時刻レンジの元。 */
const selectedRows = ref<Set<number>>(new Set())

function clearSelection() {
  if (selectedRows.value.size > 0) selectedRows.value = new Set()
}

// filteredRows の並びが変わる (乗務員切替・タブ切替) と選択index が
// 別の行を指してしまうため、その都度クリアする。
watch(() => props.group, clearSelection)
watch(activeCategory, clearSelection)

function toggleRow(ri: number) {
  const next = new Set(selectedRows.value)
  if (next.has(ri)) next.delete(ri)
  else next.add(ri)
  selectedRows.value = next
}

watch(selectedRows, (rows) => {
  const range = selectedRowsTimeRange(props.headers, filteredRows.value, rows)
  emit('update:selectedRange', range)
  emit('update:selectedSummary', rows.size > 0 ? summarizeSelectedRows(props.headers, filteredRows.value, rows) : null)
})
</script>

<template>
  <div class="px-4 py-3 flex flex-wrap gap-4 items-center text-xs text-gray-500 border-b border-gray-100 dark:border-gray-800">
    <span>{{ group.officeName }}</span>
    <span>{{ group.vehicleName }}</span>
    <span>{{ group.driverCd }} {{ group.driverName }}</span>
    <div class="ml-auto flex items-center gap-2">
      <button
        v-for="cat in EVENT_CATEGORY_ORDER"
        :key="cat"
        class="px-2 py-1 rounded text-xs transition-colors"
        :class="activeCategory === cat
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
          : 'text-gray-400 hover:text-gray-600'"
        @click="activeCategory = cat"
      >
        {{ EVENT_CATEGORY_LABELS[cat] }} ({{ categoryCounts[cat] }})
      </button>
    </div>
  </div>

  <p v-if="selectedRows.size > 0" class="px-4 pt-2 text-xs text-gray-500">
    {{ selectedRows.size }}行選択中
    <button class="ml-2 text-blue-600 dark:text-blue-400 hover:underline" @click="clearSelection">
      選択解除
    </button>
  </p>

  <table v-if="displayColumns.length" class="w-full text-xs">
    <thead class="bg-gray-50 dark:bg-gray-800">
      <tr>
        <th class="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap w-8" />
        <th class="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">#</th>
        <th
          v-for="col in displayColumns"
          :key="col.header"
          class="px-3 py-2 font-medium text-gray-500 whitespace-nowrap"
          :class="columnAlignClass(col.header)"
        >
          {{ col.header }}<span v-if="col.header === '区間距離'" class="text-[10px] text-gray-400 ml-0.5">(km)</span>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="(row, ri) in filteredRows"
        :key="ri"
        class="border-t border-gray-100 dark:border-gray-800 cursor-pointer"
        :class="[eventRowClass(headers, row), selectedRows.has(ri) ? 'bg-blue-50 dark:bg-blue-950/40' : '']"
        @click="toggleRow(ri)"
      >
        <td class="px-3 py-1.5" @click.stop="toggleRow(ri)">
          <input type="checkbox" :checked="selectedRows.has(ri)" class="cursor-pointer" @click.stop="toggleRow(ri)">
        </td>
        <td class="px-3 py-1.5 text-gray-400">{{ ri + 1 }}</td>
        <td
          v-for="col in displayColumns"
          :key="col.header"
          class="px-3 py-1.5 whitespace-nowrap"
          :class="columnAlignClass(col.header)"
        >
          <EventTableCell
            :headers="headers"
            :row="row"
            :header="col.header"
            :value="row[col.index] ?? ''"
          />
        </td>
      </tr>
      <tr v-if="filteredRows.length === 0">
        <td :colspan="displayColumns.length + 2" class="px-3 py-8 text-center text-gray-400">
          データがありません
        </td>
      </tr>
    </tbody>
  </table>
</template>
