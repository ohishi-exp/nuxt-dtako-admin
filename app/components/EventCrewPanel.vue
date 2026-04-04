<script setup lang="ts">
import type { CrewGroup } from '~/utils/event-data-table'
import {
  filterRows,
  colIndex,
  getDisplayColumns,
  eventRowClass,
  columnAlignClass,
} from '~/utils/event-data-table'

const props = defineProps<{
  group: CrewGroup
  headers: string[]
}>()

const showDriveEvents = ref(false)

const eventNameIdx = computed(() => colIndex(props.headers, 'イベント名'))

const filteredRows = computed(() =>
  filterRows(props.group.rows, eventNameIdx.value, showDriveEvents.value),
)

const driveEventCount = computed(() =>
  filterRows(props.group.rows, eventNameIdx.value, true).length,
)

const otherEventCount = computed(() =>
  props.group.rows.length - driveEventCount.value,
)

const displayColumns = computed(() => getDisplayColumns(props.headers))
</script>

<template>
  <div class="px-4 py-3 flex flex-wrap gap-4 items-center text-xs text-gray-500 border-b border-gray-100 dark:border-gray-800">
    <span>{{ group.officeName }}</span>
    <span>{{ group.vehicleName }}</span>
    <span>{{ group.driverCd }} {{ group.driverName }}</span>
    <div class="ml-auto flex items-center gap-2">
      <button
        class="px-2 py-1 rounded text-xs transition-colors"
        :class="!showDriveEvents
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
          : 'text-gray-400 hover:text-gray-600'"
        @click="showDriveEvents = false"
      >
        イベント ({{ otherEventCount }})
      </button>
      <button
        class="px-2 py-1 rounded text-xs transition-colors"
        :class="showDriveEvents
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
          : 'text-gray-400 hover:text-gray-600'"
        @click="showDriveEvents = true"
      >
        走行 ({{ driveEventCount }})
      </button>
    </div>
  </div>

  <table v-if="displayColumns.length" class="w-full text-xs">
    <thead class="bg-gray-50 dark:bg-gray-800">
      <tr>
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
        class="border-t border-gray-100 dark:border-gray-800"
        :class="eventRowClass(headers, row)"
      >
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
        <td :colspan="displayColumns.length + 1" class="px-3 py-8 text-center text-gray-400">
          データがありません
        </td>
      </tr>
    </tbody>
  </table>
</template>
