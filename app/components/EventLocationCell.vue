<script setup lang="ts">
import { getGpsForCell } from '~/utils/event-data-table'

const props = defineProps<{
  headers: string[]
  row: string[]
  header: string
  value: string
}>()

const gps = computed(() => getGpsForCell(props.headers, props.row, props.header))

function openMap() {
  window.open(`https://www.google.com/maps?q=${gps.value!.lat},${gps.value!.lng}`, '_blank')
}
</script>

<template>
  <button
    v-if="gps"
    class="text-blue-500 hover:text-blue-700 hover:underline cursor-pointer inline-flex items-center gap-0.5"
    @click="openMap"
  >
    {{ value }}
    <UIcon name="i-lucide-map-pin" class="size-3" />
  </button>
  <span v-else>{{ value }}</span>
</template>
