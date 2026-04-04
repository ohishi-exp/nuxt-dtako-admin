<script setup lang="ts">
import type { CsvJsonResponse } from '~/types'
import { groupByCrewRole } from '~/utils/event-data-table'

const props = defineProps<{
  data: CsvJsonResponse
  loading?: boolean
}>()

const crewGroups = computed(() => groupByCrewRole(props.data.headers, props.data.rows))

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
      />
    </template>

    <div v-else class="py-8 text-center text-gray-400">
      データがありません
    </div>
  </div>
</template>
