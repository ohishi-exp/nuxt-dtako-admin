<script setup lang="ts">
import { isLocationColumn } from '~/utils/event-data-table'

defineProps<{
  headers: string[]
  row: string[]
  header: string
  value: string
}>()
</script>

<template>
  <EventLocationCell
    v-if="isLocationColumn(header)"
    :headers="headers"
    :row="row"
    :header="header"
    :value="value"
  />
  <EventCell
    v-else
    :headers="headers"
    :row="row"
    :header="header"
    :value="value"
  />
</template>
