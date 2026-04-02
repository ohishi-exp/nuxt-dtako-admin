<script setup lang="ts">
import { compareRestraintCsv, recalculateDriverStream, recalculateDriversBatch } from '~/utils/api'
import type { RecalcProgressEvent, BatchRecalcEvent } from '~/utils/api'

const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const results = ref<any[]>([])
const error = ref('')
const selectedFile = ref<File | null>(null)
const filterMode = ref<'all' | 'diff' | 'unknown'>('unknown')
const recalcStates = ref<Record<string, { loading: boolean; result: string }>>({})
const flashDrivers = ref<Set<string>>(new Set())

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
  if (filterMode.value === 'unknown') {
    return results.value.filter((r: any) => (r.unknown_diffs || 0) > 0)
  }
  return results.value.filter((r: any) => r.diffs.length > 0)
})

const summary = computed(() => {
  const total = results.value.length
  const withDiffs = results.value.filter((r: any) => r.diffs.length > 0).length
  const withUnknownDiffs = results.value.filter((r: any) => (r.unknown_diffs || 0) > 0).length
  const knownBugOnly = results.value.filter((r: any) => r.diffs.length > 0 && (r.unknown_diffs || 0) === 0).length
  const noSystem = results.value.filter((r: any) => !r.system).length
  return { total, withDiffs, withUnknownDiffs, knownBugOnly, noSystem }
})

const batchRecalcRunning = ref(false)
const batchRecalcProgress = ref('')

async function recalcDiffsOnly() {
  const driversWithDiffs = results.value.filter((r: any) => r.diffs.length > 0 && r.driver_id)
  if (driversWithDiffs.length === 0) return

  // 年月推定
  const firstResult = results.value[0]
  if (!firstResult?.csv?.days?.length) return
  const dateStr = firstResult.csv.days.find((d: any) => !d.is_holiday)?.date || ''
  const mMatch = dateStr.match(/(\d+)月/)
  if (!mMatch) return
  const month = parseInt(mMatch[1])
  const year = 2026

  batchRecalcRunning.value = true
  const driverIds = driversWithDiffs.map((r: any) => r.driver_id)
  const driverMap = Object.fromEntries(driversWithDiffs.map((r: any) => [r.driver_cd, r.driver_name]))

  try {
    await recalculateDriversBatch(year, month, driverIds, (evt: BatchRecalcEvent) => {
      if (evt.event === 'progress') {
        const errors = (evt as any).errors || 0
        batchRecalcProgress.value = `${evt.current}/${evt.total}名${errors > 0 ? ` (${errors}エラー)` : ''}`
      } else if (evt.event === 'batch_done') {
        const errors = (evt as any).errors || 0
        batchRecalcProgress.value = `${(evt as any).done || evt.total}名完了${errors > 0 ? ` ${errors}エラー` : ''} 再比較中...`
      } else if (evt.event === 'error') {
        batchRecalcProgress.value = evt.message || 'エラー'
      }
    })
    await runCompare()
  } catch (e: any) {
    batchRecalcProgress.value = e.message || 'エラー'
  } finally {
    batchRecalcRunning.value = false
    batchRecalcProgress.value = ''
  }
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
        recalcStates.value[key] = { loading: true, result: '再比較中...' }
      } else if (evt.event === 'error') {
        recalcStates.value[key] = { loading: false, result: evt.message || 'エラー' }
      }
    })

    // 再計算完了 → 1件だけ再比較
    if (selectedFile.value) {
      const updated = await compareRestraintCsv(selectedFile.value, driverCd)
      if (updated.length > 0) {
        const idx = results.value.findIndex((r: any) => r.driver_cd === driverCd)
        if (idx >= 0) {
          results.value[idx] = updated[0]
        }
      }
      const unknownDiffs = updated[0]?.unknown_diffs || 0
      const knownDiffs = updated[0]?.known_bug_diffs || 0
      const resultText = unknownDiffs > 0 ? `${unknownDiffs}件 未知差分` : knownDiffs > 0 ? `既知バグのみ${knownDiffs}件` : '一致！'
      recalcStates.value[key] = { loading: false, result: resultText }
      // フラッシュアニメーション
      flashDrivers.value.add(driverCd)
      setTimeout(() => flashDrivers.value.delete(driverCd), 2000)
    } else {
      recalcStates.value[key] = { loading: false, result: '完了' }
    }
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
        <UButton :label="`未知差分 (${summary.withUnknownDiffs})`" size="xs" :color="filterMode === 'unknown' ? 'primary' : 'neutral'" variant="outline" @click="filterMode = 'unknown'" />
        <UButton :label="`全差分 (${summary.withDiffs})`" size="xs" :color="filterMode === 'diff' ? 'primary' : 'neutral'" variant="outline" @click="filterMode = 'diff'" />
        <UButton :label="`全員 (${summary.total})`" size="xs" :color="filterMode === 'all' ? 'primary' : 'neutral'" variant="outline" @click="filterMode = 'all'" />
      </div>
      <UButton
        v-if="summary.withUnknownDiffs > 0"
        :label="batchRecalcRunning ? batchRecalcProgress : `未知差分${summary.withUnknownDiffs}名 再計算`"
        icon="i-lucide-refresh-cw"
        size="sm"
        color="warning"
        :loading="batchRecalcRunning"
        @click="recalcDiffsOnly"
      />
      <span v-if="summary.knownBugOnly > 0" class="text-xs text-yellow-600 self-center">{{ summary.knownBugOnly }}名 既知バグのみ</span>
      <span v-if="summary.noSystem > 0" class="text-xs text-orange-500 self-center">{{ summary.noSystem }}名 未登録</span>
    </div>

    <UAlert v-if="error" :title="error" color="error" icon="i-lucide-circle-x" variant="subtle" />

    <div v-if="loading" class="text-center py-8 text-gray-400">読み込み中...</div>

    <!-- Results -->
    <div
      v-for="r in filteredResults"
      :key="r.driver_cd"
      class="border rounded-lg dark:border-gray-700 mb-4 relative transition-all duration-500"
      :class="flashDrivers.has(r.driver_cd) ? 'ring-2 ring-green-400 bg-green-50 dark:bg-green-900/20' : ''"
    >
      <!-- ローディングオーバーレイ -->
      <div
        v-if="recalcStates[r.driver_cd]?.loading"
        class="absolute inset-0 bg-white/70 dark:bg-gray-900/70 z-10 flex items-center justify-center rounded-lg"
      >
        <div class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <UIcon name="i-lucide-loader-2" class="animate-spin" />
          <span>{{ recalcStates[r.driver_cd]?.result || '処理中...' }}</span>
        </div>
      </div>
      <div class="flex items-center gap-3 px-4 py-2 bg-gray-50 dark:bg-gray-800 rounded-t-lg">
        <span class="font-bold">{{ r.driver_name }}</span>
        <span class="text-xs text-gray-500">({{ r.driver_cd }})</span>
        <span v-if="r.diffs.length === 0 && r.system" class="text-xs text-green-600 font-bold">一致</span>
        <span v-else-if="(r.unknown_diffs || 0) > 0" class="text-xs text-red-600 font-bold">{{ r.unknown_diffs }}件 未知差分</span>
        <span v-else-if="(r.known_bug_diffs || 0) > 0" class="text-xs text-yellow-600 font-bold">{{ r.known_bug_diffs }}件 既知バグ</span>
        <span v-else-if="!r.system" class="text-xs text-orange-500">システム未登録</span>
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
          <span
            v-if="recalcStates[r.driver_cd]?.result && !recalcStates[r.driver_cd]?.loading"
            class="text-xs font-bold"
            :class="recalcStates[r.driver_cd]!.result.includes('一致') ? 'text-green-600' : recalcStates[r.driver_cd]!.result.includes('未知') ? 'text-red-600' : 'text-yellow-600'"
          >
            {{ recalcStates[r.driver_cd]!.result }}
          </span>
        </div>
      </div>

      <!-- 未知差分テーブル（常に表示） -->
      <div v-if="r.diffs.some((d: any) => !d.known_bug)" class="overflow-x-auto">
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
            <tr
              v-for="(d, i) in r.diffs.filter((d: any) => !d.known_bug)"
              :key="i"
              class="border-t dark:border-gray-700 hover:bg-red-50 dark:hover:bg-red-900/10"
            >
              <td class="px-2 py-1">{{ d.date }}</td>
              <td class="px-2 py-1">{{ d.field }}</td>
              <td class="px-2 py-1 text-right font-mono">{{ d.csv_val || '-' }}</td>
              <td class="px-2 py-1 text-right font-mono text-red-600 font-bold">{{ d.sys_val || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 既知バグ差分（detailsで折りたたみ） -->
      <details v-if="r.diffs.some((d: any) => d.known_bug)" class="border-t dark:border-gray-700">
        <summary class="px-4 py-1.5 text-xs text-yellow-600 cursor-pointer hover:bg-yellow-50 dark:hover:bg-yellow-900/10 select-none">
          既知バグ {{ r.diffs.filter((d: any) => d.known_bug).length }}件
        </summary>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="bg-yellow-50 dark:bg-yellow-900/10">
                <th class="px-2 py-1 text-left">日付</th>
                <th class="px-2 py-1 text-left">項目</th>
                <th class="px-2 py-1 text-right">CSV値</th>
                <th class="px-2 py-1 text-right">システム値</th>
                <th class="px-2 py-1 text-left">理由</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(d, i) in r.diffs.filter((d: any) => d.known_bug)"
                :key="i"
                class="border-t dark:border-gray-700 bg-yellow-50/50 dark:bg-yellow-900/5"
              >
                <td class="px-2 py-1">{{ d.date }}</td>
                <td class="px-2 py-1">{{ d.field }}</td>
                <td class="px-2 py-1 text-right font-mono">{{ d.csv_val || '-' }}</td>
                <td class="px-2 py-1 text-right font-mono text-yellow-600">{{ d.sys_val || '-' }}</td>
                <td class="px-2 py-1 text-[10px] text-yellow-600">{{ d.known_bug }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>

    <div v-if="results.length > 0 && filteredResults.length === 0" class="text-center py-8 text-green-600 font-bold">
      {{ filterMode === 'unknown' ? '未知差分なし' : '全ドライバー一致！差分なし' }}
    </div>
  </div>
</template>
