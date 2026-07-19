<script setup lang="ts">
/**
 * 車輌+月単位の一番星マッチ率検証サマリ画面 (Refs #330 PR4)。
 *
 * `/operations/[unko_no]` の収支パネルで保存した検証スナップショットを月次で
 * 集計し、一番星側月計との差額・マッチレベル内訳を表示する (Task #1 実データ
 * マッチ率検証の集計結果を見るための画面)。集計本体は
 * `server/api/profit/monthly.get.ts` + `app/utils/profit-r2.ts::summarizeMonthly`。
 */
import type { MonthlySummary } from '~/utils/profit-r2'

function currentYm(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

const vehicleCode = ref('')
const ym = ref(currentYm())

type Status = 'idle' | 'loading' | 'ready' | 'error'
const status = ref<Status>('idle')
const errorMessage = ref<string | null>(null)
const summary = ref<MonthlySummary | null>(null)

async function search() {
  if (!vehicleCode.value || !ym.value) return
  status.value = 'loading'
  errorMessage.value = null
  try {
    summary.value = await $fetch<MonthlySummary>('/api/profit/monthly', {
      query: { vehicle: vehicleCode.value, ym: ym.value },
    })
    status.value = 'ready'
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
  }
}

function formatYen(v: number): string {
  return Math.round(v).toLocaleString('ja-JP')
}

const matchTotal = computed(() => {
  if (!summary.value) return 0
  const { exact, partial, none } = summary.value.matchCounts
  return exact + partial + none
})

function pct(count: number): string {
  return matchTotal.value > 0 ? `${Math.round((count / matchTotal.value) * 100)}%` : '-'
}
</script>

<template>
  <div class="max-w-3xl mx-auto p-6">
    <h1 class="text-xl font-bold mb-1">一番星マッチ率検証 (月次)</h1>
    <p class="text-xs text-gray-500 mb-4">
      運行詳細の収支パネルで保存した検証スナップショットを車輌・月単位で集計し、
      一番星側の月計と突き合わせます。
    </p>

    <div class="flex items-end gap-3 mb-6">
      <div>
        <label class="text-xs text-gray-500 block mb-1">車輌CD</label>
        <input
          v-model="vehicleCode"
          type="text"
          placeholder="例: 8504"
          class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900"
        >
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">年月</label>
        <input
          v-model="ym"
          type="month"
          class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900"
        >
      </div>
      <button
        class="text-sm px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
        :disabled="!vehicleCode || !ym || status === 'loading'"
        @click="search"
      >
        {{ status === 'loading' ? '集計中...' : '集計する' }}
      </button>
    </div>

    <p v-if="status === 'error'" class="text-sm text-red-600 dark:text-red-400">
      {{ errorMessage }}
    </p>

    <template v-if="status === 'ready' && summary">
      <div class="grid grid-cols-3 gap-4 mb-6">
        <div class="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
          <span class="text-xs text-gray-500 block">一番星 月計</span>
          <span class="text-lg font-semibold">{{ formatYen(summary.ichibanTotal) }} 円</span>
        </div>
        <div class="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
          <span class="text-xs text-gray-500 block">確認済み合計</span>
          <span class="text-lg font-semibold">{{ formatYen(summary.confirmedTotal) }} 円</span>
        </div>
        <div class="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
          <span class="text-xs text-gray-500 block">差額 (未確認・誤マッチ等)</span>
          <span class="text-lg font-semibold" :class="summary.diff === 0 ? 'text-green-600 dark:text-green-400' : ''">
            {{ formatYen(summary.diff) }} 円
          </span>
        </div>
      </div>

      <div class="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
        <span class="text-xs text-gray-500 block mb-2">確認済み伝票のマッチレベル内訳 ({{ matchTotal }}件、{{ summary.snapshotCount }}区間分)</span>
        <div v-if="matchTotal === 0" class="text-xs text-gray-400">
          この車輌・月の検証スナップショットはまだ保存されていません
        </div>
        <div v-else class="flex gap-4 text-sm">
          <span class="text-green-600 dark:text-green-400">完全一致 {{ summary.matchCounts.exact }}件 ({{ pct(summary.matchCounts.exact) }})</span>
          <span class="text-yellow-600 dark:text-yellow-400">部分一致 {{ summary.matchCounts.partial }}件 ({{ pct(summary.matchCounts.partial) }})</span>
          <span class="text-gray-400">根拠なし {{ summary.matchCounts.none }}件 ({{ pct(summary.matchCounts.none) }})</span>
        </div>
      </div>
    </template>
  </div>
</template>
