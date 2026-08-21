<script setup lang="ts">
import type { CsvJsonResponse } from '~/types'
import type { SelectedRowsSummary, SelectedRowsLocationRange } from '~/utils/event-data-table'
import { groupByCrewRole, ignoredEventCodes, dropIgnoredRows } from '~/utils/event-data-table'
import { getEventClassifications } from '~/utils/api'

const props = defineProps<{
  data: CsvJsonResponse
  loading?: boolean
  proposedRange?: { fromTs: number, toTs: number } | null
}>()

/**
 * イベント分類 (`/event-classifications`) で「無視」にされたイベントCD。
 *
 * **設定は保存できるだけで、どこからも読まれていなかった** (2026-08-21 に判明)。
 * 急加速・急減速・急カーブを `無視` にしてあるのに、イベント表には 260 件並んで
 * 積み/降しが埋もれていた。ここで読むので**詳細ページとモーダルの両方が直る**。
 *
 * **黙って消さない** — 何件落としたかを出して、チェックで戻せるようにする。
 */
const ignored = ref<Set<string>>(new Set())
const showIgnored = ref(false)

onMounted(async () => {
  try {
    ignored.value = ignoredEventCodes(await getEventClassifications())
  }
  catch {
    // 分類が引けなくても表は出す (全部見えるだけ)
  }
})

const keptRows = computed(() => dropIgnoredRows(props.data.headers, props.data.rows, ignored.value))
const ignoredCount = computed(() => props.data.rows.length - keptRows.value.length)
const visibleRows = computed(() => (showIgnored.value ? props.data.rows : keptRows.value))

const emit = defineEmits<{
  'update:selectedRange': [range: { fromTs: number, toTs: number } | null]
  'update:selectedSummary': [summary: SelectedRowsSummary | null]
  'update:selectedLocation': [location: SelectedRowsLocationRange | null]
}>()

const crewGroups = computed(() => groupByCrewRole(props.data.headers, visibleRows.value))

const activeCrewRole = ref('1')

watch(crewGroups, (groups) => {
  if (groups.length && !groups.find(g => g.crewRole === activeCrewRole.value)) {
    activeCrewRole.value = groups[0]!.crewRole
  }
}, { immediate: true })

const activeGroup = computed(() => crewGroups.value.find(g => g.crewRole === activeCrewRole.value))
</script>

<template>
  <div class="overflow-auto">
    <div v-if="loading" class="flex items-center justify-center py-8">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 mr-2" />
      <span class="text-gray-400">読み込み中...</span>
    </div>

    <template v-else-if="crewGroups.length">
      <!-- **落としたことを黙らない。** 分類で「無視」にしたぶんは件数を出して戻せる。 -->
      <label
        v-if="ignoredCount > 0"
        class="flex items-center gap-1.5 px-4 py-1.5 text-xs text-gray-500 cursor-pointer select-none"
      >
        <input v-model="showIgnored" type="checkbox" class="cursor-pointer">
        イベント分類で「無視」にした {{ ignoredCount }} 件も表示
      </label>

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

      <EventCrewPanel
        v-if="activeGroup"
        :group="activeGroup"
        :headers="data.headers"
        :proposed-range="proposedRange"
        @update:selected-range="emit('update:selectedRange', $event)"
        @update:selected-summary="emit('update:selectedSummary', $event)"
        @update:selected-location="emit('update:selectedLocation', $event)"
      />
    </template>

    <div v-else class="py-8 text-center text-gray-400">
      データがありません
    </div>
  </div>
</template>
