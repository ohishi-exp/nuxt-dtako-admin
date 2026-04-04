<script setup lang="ts">
import type { CsvJsonResponse } from '~/types'
import {
  colIndex,
  groupByCrewRole,
  filterRows,
  getDisplayColumns,
  formatCell,
  eventColorClass,
  eventRowClass,
  columnAlignClass,
  isLocationColumn,
  getGpsForCell,
} from '~/utils/event-data-table'

const props = defineProps<{
  data: CsvJsonResponse
  loading?: boolean
}>()

const h = computed(() => props.data.headers)

const showDriveEvents = ref(false)

const crewGroups = computed(() => groupByCrewRole(h.value, props.data.rows))

const activeCrewRole = ref('1')

watch(crewGroups, (groups) => {
  if (groups.length && !groups.find(g => g.crewRole === activeCrewRole.value)) {
    activeCrewRole.value = groups[0]!.crewRole
  }
}, { immediate: true })

const activeGroup = computed(() => crewGroups.value.find(g => g.crewRole === activeCrewRole.value))

const eventNameIdx = computed(() => colIndex(h.value, 'イベント名'))

const activeRows = computed(() => activeGroup.value?.rows ?? [])

const filteredRows = computed(() =>
  filterRows(activeRows.value, eventNameIdx.value, showDriveEvents.value),
)

const driveEventCount = computed(() =>
  filterRows(activeRows.value, eventNameIdx.value, true).length,
)

const otherEventCount = computed(() =>
  activeRows.value.length - driveEventCount.value,
)

const displayColumns = computed(() => getDisplayColumns(h.value))

function hasGps(row: string[], header: string): boolean {
  return getGpsForCell(h.value, row, header) !== null
}

function openGoogleMap(row: string[], header: string) {
  const gps = getGpsForCell(h.value, row, header)
  if (!gps) return
  window.open(`https://www.google.com/maps?q=${gps.lat},${gps.lng}`, '_blank')
}
</script>

<template>
  <div class="overflow-auto">
    <div v-if="loading" class="flex items-center justify-center py-8">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 mr-2" />
      <span class="text-gray-400">読み込み中...</span>
    </div>

    <template v-else-if="crewGroups.length">
      <!-- 乗務員タブ（2名以上の場合のみ表示） -->
      <div v-if="crewGroups.length > 1" class="border-b border-gray-200 dark:border-gray-800 flex px-4">
        <button
          v-for="g in crewGroups"
          :key="g.crewRole"
          class="px-3 py-2 text-xs font-medium transition-colors border-b-2"
          :class="activeCrewRole === g.crewRole
            ? 'border-blue-500 text-blue-600'
            : 'border-transparent text-gray-500 hover:text-gray-700'"
          @click="activeCrewRole = g.crewRole"
        >
          {{ g.label }} ({{ g.driverName }})
        </button>
      </div>

      <!-- 共通情報 + フィルタ -->
      <div v-if="activeGroup" class="px-4 py-3 flex flex-wrap gap-4 items-center text-xs text-gray-500 border-b border-gray-100 dark:border-gray-800">
        <span>{{ activeGroup.officeName }}</span>
        <span>{{ activeGroup.vehicleName }}</span>
        <span>{{ activeGroup.driverCd }} {{ activeGroup.driverName }}</span>
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

      <!-- イベントテーブル -->
      <table v-if="activeGroup && displayColumns.length" class="w-full text-xs">
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
            :class="eventRowClass(h, row)"
          >
            <td class="px-3 py-1.5 text-gray-400">{{ ri + 1 }}</td>
            <td
              v-for="col in displayColumns"
              :key="col.header"
              class="px-3 py-1.5 whitespace-nowrap"
              :class="[columnAlignClass(col.header), col.header === 'イベント名' ? eventColorClass(h, row) : '']"
            >
              <button
                v-if="isLocationColumn(col.header) && hasGps(row, col.header)"
                class="text-blue-500 hover:text-blue-700 hover:underline cursor-pointer inline-flex items-center gap-0.5"
                @click="openGoogleMap(row, col.header)"
              >
                {{ row[col.index] ?? '' }}
                <UIcon name="i-lucide-map-pin" class="size-3" />
              </button>
              <span v-else>{{ formatCell(col.header, row[col.index] ?? '') }}</span>
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

    <div v-else class="py-8 text-center text-gray-400">
      データがありません
    </div>
  </div>
</template>
