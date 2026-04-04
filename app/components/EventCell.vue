<script setup lang="ts">
import { formatCell, eventColorClass } from '~/utils/event-data-table'

const props = defineProps<{
  headers: string[]
  row: string[]
  header: string
  value: string
}>()

const colorClass = computed(() =>
  props.header === 'イベント名' ? eventColorClass(props.headers, props.row) : '',
)
</script>

<template>
  <span :class="colorClass">{{ formatCell(header, value) }}</span>
</template>
