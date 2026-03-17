<script setup lang="ts">
import { compareRestraintCsv, recalculateDriverStream } from '~/utils/api'
import type { RecalcProgressEvent } from '~/utils/api'

const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const results = ref<any[]>([])
const error = ref('')
const selectedFile = ref<File | null>(null)
const filterMode = ref<'all' | 'diff'>('diff')
const recalcStates = ref<Record<string, { loading: boolean; result: string }>>({})

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  selectedFile.value = file
  await runCompare()
}

async function runCompare() {
  if (!selectedFile.value) return
  loading.value = true
  error.value = ''
  results.value = []
  try {
    results.value = await compareRestraintCsv(selectedFile.value)
  } catch (e: any) {
    error.value = e.message || '比較に失敗しました'
  } finally {
    loading.value = false
  }
}

const filteredResults = computed(() => {
  if (filterMode.value === 'all') return results.value
  return results.value.filter((r: any) => r.diffs.length > 0)
})

const summary = computed(() => {
  const total = results.value.length
  const withDiffs = results.value.filter((r: any) => r.diffs.length > 0).length
  const noSystem = results.value.filter((r: any) => !r.system).length
  return { total, withDiffs, noSystem }
})

const batchRecalcRunning = ref(false)
const batchRecalcProgress = ref('')

async function recalcDiffsOnly() {
  const driversWithDiffs = results.value.filter((r: any) => r.diffs.length > 0 && r.driver_id)
  if (driversWithDiffs.length === 0) return

  batchRecalcRunning.value = true
  let done = 0
  const total = driversWithDiffs.length

  for (const r of driversWithDiffs) {
    batchRecalcProgress.value = `${done + 1}/${total} ${r.driver_name}`
    await recalcDriver(r.driver_id, r.driver_name, r.driver_cd)
    done++
  }
  batchRecalcProgress.value = `${total}名完了 再比較中...`
  await runCompare()
  batchRecalcRunning.value = false
  batchRecalcProgress.value = ''
}

async function recalcDriver(driverId: string, driverName: string, driverCd: string) {
  // 年月をCSVの日付から推定
  const firstResult = results.value[0]
  if (!firstResult?.csv?.days?.length) return
  const dateStr = firstResult.csv.days.find((d: any) => !d.is_holiday)?.date || ''
  const mMatch = dateStr.match(/(\d+)月/)
  if (!mMatch) return
  const month = parseInt(mMatch[1])
  const year = 2026 // TODO: CSVヘッダーから取得

  const key = driverCd
  recalcStates.value[key] = { loading: true, result: '再計算中...' }

  try {
    await recalculateDriverStream(year, month, driverId, (evt: RecalcProgressEvent) => {
      if (evt.event === 'progress') {
        const step = evt.step === 'download' ? 'DL' : '処理'
        recalcStates.value[key] = { loading: true, result: `${step}中 (${evt.current}/${evt.total})` }
      } else if (evt.event === 'done') {
        recalcStates.value[key] = { loading: false, result: '完了！再比較してください' }
      } else if (evt.event === 'error') {
        recalcStates.value[key] = { loading: false, result: evt.message || 'エラー' }
      }
    })
  } catch {
    recalcStates.value[key] = { loading: false, result: 'エラー' }
  }
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-xl font-bold">拘束時間管理表 CSV比較</h2>

    <div class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="text-xs text-gray-500 block mb-1">CSV選択</label>
        <input ref="fileInput" type="file" accept=".csv" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700" @change="onFileChange">
      </div>
      <UButton label="再比較" icon="i-lucide-refresh-cw" size="sm" :loading="loading" :disabled="!selectedFile" @click="runCompare" />
      <div class="flex gap-1">
        <UButton :label="`差分のみ (${summary.withDiffs})`" size="xs" :color="filterMode === 'diff' ? 'primary' : 'neutral'" variant="outline" @click="filterMode = 'diff'" />
        <UButton :label="`全員 (${summary.total})`" size="xs" :color="filterMode === 'all' ? 'primary' : 'neutral'" variant="outline" @click="filterMode = 'all'" />
      </div>
      <UButton
        v-if="summary.withDiffs > 0"
        :label="batchRecalcRunning ? batchRecalcProgress : `差分${summary.withDiffs}名 再計算`"
        icon="i-lucide-refresh-cw"
        size="sm"
        color="warning"
        :loading="batchRecalcRunning"
        @click="recalcDiffsOnly"
      />
      <span v-if="summary.noSystem > 0" class="text-xs text-orange-500 self-center">{{ summary.noSystem }}名 未登録</span>
    </div>

    <UAlert v-if="error" :title="error" color="error" icon="i-lucide-circle-x" variant="subtle" />

    <div v-if="loading" class="text-center py-8 text-gray-400">読み込み中...</div>

    <!-- Results -->
    <div v-for="r in filteredResults" :key="r.driver_cd" class="border rounded-lg dark:border-gray-700 mb-4">
      <div class="flex items-center gap-3 px-4 py-2 bg-gray-50 dark:bg-gray-800 rounded-t-lg">
        <span class="font-bold">{{ r.driver_name }}</span>
        <span class="text-xs text-gray-500">({{ r.driver_cd }})</span>
        <span v-if="r.diffs.length === 0 && r.system" class="text-xs text-green-600 font-bold">✓ 一致</span>
        <span v-else-if="r.diffs.length > 0" class="text-xs text-red-600 font-bold">{{ r.diffs.length }}件 差分</span>
        <span v-else class="text-xs text-orange-500">システム未登録</span>
        <div class="ml-auto flex items-center gap-2">
          <UButton
            v-if="r.driver_id"
            label="再計算"
            icon="i-lucide-refresh-cw"
            size="xs"
            color="warning"
            variant="outline"
            :loading="recalcStates[r.driver_cd]?.loading"
            @click="recalcDriver(r.driver_id, r.driver_name, r.driver_cd)"
          />
          <span v-if="recalcStates[r.driver_cd]?.result" class="text-xs text-gray-500">{{ recalcStates[r.driver_cd].result }}</span>
        </div>
      </div>

      <!-- Diff table -->
      <div v-if="r.diffs.length > 0" class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="bg-gray-100 dark:bg-gray-900">
              <th class="px-2 py-1 text-left">日付</th>
              <th class="px-2 py-1 text-left">項目</th>
              <th class="px-2 py-1 text-right">CSV値</th>
              <th class="px-2 py-1 text-right">システム値</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(d, i) in r.diffs" :key="i" class="border-t dark:border-gray-700 hover:bg-yellow-50 dark:hover:bg-yellow-900/10">
              <td class="px-2 py-1">{{ d.date }}</td>
              <td class="px-2 py-1">{{ d.field }}</td>
              <td class="px-2 py-1 text-right font-mono">{{ d.csv_val || '-' }}</td>
              <td class="px-2 py-1 text-right font-mono" :class="d.csv_val !== d.sys_val ? 'text-red-600 font-bold' : ''">{{ d.sys_val || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="results.length > 0 && filteredResults.length === 0" class="text-center py-8 text-green-600 font-bold">
      全ドライバー一致！差分なし
    </div>
  </div>
</template>
