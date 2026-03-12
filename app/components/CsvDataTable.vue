<script setup lang="ts">
const props = defineProps<{
  headers: string[]
  rows: string[][]
  loading?: boolean
}>()
</script>

<template>
  <div class="overflow-auto">
    <div v-if="loading" class="flex items-center justify-center py-8">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 mr-2" />
      <span class="text-gray-400">読み込み中...</span>
    </div>
    <table v-else-if="headers.length" class="w-full text-xs">
      <thead class="bg-gray-50 dark:bg-gray-800">
        <tr>
          <th v-for="(h, i) in headers" :key="i" class="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">
            {{ h }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, ri) in rows"
          :key="ri"
          class="border-t border-gray-100 dark:border-gray-800"
        >
          <td v-for="(cell, ci) in row" :key="ci" class="px-3 py-1.5 whitespace-nowrap">
            {{ cell }}
          </td>
        </tr>
        <tr v-if="rows.length === 0">
          <td :colspan="headers.length" class="px-3 py-8 text-center text-gray-400">
            データがありません
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="py-8 text-center text-gray-400">
      データがありません
    </div>
  </div>
</template>
