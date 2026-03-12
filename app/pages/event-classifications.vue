<script setup lang="ts">
import type { EventClassification } from '~/types'
import { getEventClassifications, updateEventClassification } from '~/utils/api'

const items = ref<EventClassification[]>([])
const loading = ref(false)
const saving = ref<string | null>(null)
const error = ref('')

const classificationOptions = [
  { value: 'work', label: '稼働', color: 'text-blue-600 dark:text-blue-400' },
  { value: 'rest_split', label: '休息(分割)', color: 'text-orange-600 dark:text-orange-400' },
  { value: 'break', label: '休憩', color: 'text-green-600 dark:text-green-400' },
  { value: 'ignore', label: '無視', color: 'text-gray-400' },
]

function classificationLabel(value: string) {
  return classificationOptions.find(o => o.value === value)?.label ?? value
}

function classificationColor(value: string) {
  return classificationOptions.find(o => o.value === value)?.color ?? ''
}

async function fetchData() {
  loading.value = true
  error.value = ''
  try {
    items.value = await getEventClassifications()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'データの取得に失敗しました'
  } finally {
    loading.value = false
  }
}

async function onChange(item: EventClassification, newValue: string) {
  if (item.classification === newValue) return
  saving.value = item.id
  error.value = ''
  try {
    const updated = await updateEventClassification(item.id, newValue)
    const idx = items.value.findIndex(i => i.id === item.id)
    if (idx !== -1) items.value[idx] = updated
  } catch (e) {
    error.value = e instanceof Error ? e.message : '更新に失敗しました'
  } finally {
    saving.value = null
  }
}

onMounted(fetchData)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-bold">イベント分類設定</h2>
      <UButton
        icon="i-lucide-refresh-cw"
        label="再読み込み"
        variant="ghost"
        size="sm"
        :loading="loading"
        @click="fetchData"
      />
    </div>

    <UAlert v-if="error" color="error" :title="error" class="mb-4" />

    <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
            <th class="text-left px-4 py-3 font-medium">イベントCD</th>
            <th class="text-left px-4 py-3 font-medium">イベント名</th>
            <th class="text-left px-4 py-3 font-medium">分類</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr>
            <td colspan="3" class="px-4 py-8 text-center text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin mr-2" />
              読み込み中...
            </td>
          </tr>
        </tbody>
        <tbody v-else-if="items.length === 0">
          <tr>
            <td colspan="3" class="px-4 py-8 text-center text-gray-500">
              データがありません
            </td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr
            v-for="item in items"
            :key="item.id"
            class="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/30"
          >
            <td class="px-4 py-3 font-mono">{{ item.event_cd }}</td>
            <td class="px-4 py-3">{{ item.event_name }}</td>
            <td class="px-4 py-3">
              <select
                :value="item.classification"
                :disabled="saving === item.id"
                class="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm cursor-pointer"
                :class="classificationColor(item.classification)"
                @change="onChange(item, ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="opt in classificationOptions"
                  :key="opt.value"
                  :value="opt.value"
                >
                  {{ opt.label }}
                </option>
              </select>
              <UIcon
                v-if="saving === item.id"
                name="i-lucide-loader-circle"
                class="size-4 animate-spin ml-2 inline"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
