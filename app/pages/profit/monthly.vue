<script setup lang="ts">
/**
 * 車輌+月単位の一番星マッチ率検証サマリ画面 (Refs #330 PR4)。
 *
 * `/operations/[unko_no]` の収支パネルで保存した検証スナップショットを月次で
 * 集計し、一番星側月計との差額・マッチレベル内訳を表示する (Task #1 実データ
 * マッチ率検証の集計結果を見るための画面)。集計本体は
 * `server/api/profit/monthly.get.ts` + `app/utils/profit-r2.ts::summarizeMonthly`。
 */
import type { MonthlySummary, SnapshotListItem } from '~/utils/profit-r2'
import { shiftYmd } from '~/utils/profit-compare'

/** 保存済み検証スナップショットの車輌・期間で `/profit/compare` (類似運行検索) に
 * 遷移するためのクエリを組み立てる (Refs #330 PR5)。`to` は半開区間なので
 * `saleDateTo` の翌日にする。伝票が確認されていないスナップショットは
 * saleDateFrom/To が空文字になりうるため、その場合は車輌のみで絞り込む。 */
function compareLinkQuery(item: SnapshotListItem): Record<string, string> {
  const query: Record<string, string> = { vehicle: item.vehicleCode }
  if (item.saleDateFrom) {
    query.from = item.saleDateFrom
    query.to = shiftYmd(item.saleDateTo || item.saleDateFrom, 1)
  }
  return query
}

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

// --- 保存済み検証スナップショット一覧 (Refs #330、車輌・月を先に決めなくても
//     保存したものから検索・閲覧できるようにする要望) ---

type SnapshotListStatus = 'idle' | 'loading' | 'ready' | 'error'
const snapshotListStatus = ref<SnapshotListStatus>('idle')
const snapshotListError = ref<string | null>(null)
const snapshotItems = ref<SnapshotListItem[]>([])
const snapshotFilterVehicle = ref('')
const snapshotFilterYm = ref('')

async function loadSnapshotList() {
  snapshotListStatus.value = 'loading'
  snapshotListError.value = null
  try {
    const query: Record<string, string> = {}
    if (snapshotFilterVehicle.value) query.vehicle = snapshotFilterVehicle.value
    if (snapshotFilterYm.value) query.ym = snapshotFilterYm.value
    const res = await $fetch<{ items: SnapshotListItem[], total: number }>('/api/profit/snapshots', { query })
    snapshotItems.value = res.items
    snapshotListStatus.value = 'ready'
  }
  catch (e) {
    snapshotListError.value = e instanceof Error ? e.message : String(e)
    snapshotListStatus.value = 'error'
  }
}

onMounted(loadSnapshotList)

function downloadSnapshotListJson() {
  const blob = new Blob([JSON.stringify(snapshotItems.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `保存済み検証一覧_${snapshotFilterYm.value || 'all'}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// --- 保存済みスナップショットの削除 (「保存が増えすぎたので消せるように」要望) ---

const deleteConfirmOpen = ref(false)
const deleteTarget = ref<SnapshotListItem | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

function requestDeleteSnapshot(item: SnapshotListItem) {
  deleteTarget.value = item
  deleteError.value = null
  deleteConfirmOpen.value = true
}

async function confirmDeleteSnapshot() {
  const item = deleteTarget.value
  if (!item) return
  deleting.value = true
  deleteError.value = null
  try {
    await $fetch('/api/profit/snapshot', {
      method: 'DELETE',
      query: { ym: item.ym, vehicle: item.vehicleCode, unkoNo: item.unkoNo, segmentId: item.segmentId },
    })
    snapshotItems.value = snapshotItems.value.filter(i => i !== item)
    deleteConfirmOpen.value = false
  }
  catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    deleting.value = false
  }
}

function matchLevelLabel(item: SnapshotListItem): string {
  const { exact, partial, none } = item.matchCounts
  return `完全${exact} / 部分${partial} / 根拠なし${none}`
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
  <div class="max-w-5xl mx-auto p-6">
    <h2 class="text-lg font-bold mb-1">保存済み検証一覧</h2>
    <p class="text-xs text-gray-500 mb-3">
      運行詳細の収支パネルで保存した検証結果を新しい順に表示します。行をクリックすると元の運行詳細に移動します。
    </p>

    <div class="flex items-end gap-3 mb-3">
      <div>
        <label class="text-xs text-gray-500 block mb-1">車輌CD (絞り込み)</label>
        <input
          v-model="snapshotFilterVehicle"
          type="text"
          placeholder="例: 8504"
          class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900"
          @keyup.enter="loadSnapshotList"
        >
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">年月 (絞り込み)</label>
        <input
          v-model="snapshotFilterYm"
          type="month"
          class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900"
        >
      </div>
      <button
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 disabled:opacity-50 text-white"
        :disabled="snapshotListStatus === 'loading'"
        @click="loadSnapshotList"
      >
        {{ snapshotListStatus === 'loading' ? '検索中...' : '検索' }}
      </button>
      <button
        v-if="snapshotItems.length > 0"
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white"
        @click="downloadSnapshotListJson"
      >
        JSON出力
      </button>
    </div>

    <p v-if="snapshotListStatus === 'error'" class="text-sm text-red-600 dark:text-red-400 mb-6">
      {{ snapshotListError }}
    </p>
    <p v-else-if="snapshotListStatus === 'ready' && snapshotItems.length === 0" class="text-xs text-gray-400 mb-6">
      条件に一致する保存済みスナップショットはありません
    </p>
    <div v-else-if="snapshotItems.length > 0" class="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto mb-8">
      <table class="w-full text-xs min-w-[720px]">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th class="text-left px-3 py-2 font-medium text-gray-500">保存日時</th>
            <th class="text-left px-3 py-2 font-medium text-gray-500">車輌CD</th>
            <th class="text-left px-3 py-2 font-medium text-gray-500">運行日</th>
            <th class="text-left px-3 py-2 font-medium text-gray-500">得意先</th>
            <th class="text-right px-3 py-2 font-medium text-gray-500">確定金額</th>
            <th class="text-left px-3 py-2 font-medium text-gray-500">マッチレベル</th>
            <th class="text-left px-3 py-2 font-medium text-gray-500">類似運行</th>
            <th class="text-left px-3 py-2 font-medium text-gray-500" />
          </tr>
        </thead>
        <tbody>
          <NuxtLink
            v-for="item in snapshotItems"
            :key="`${item.vehicleCode}-${item.unkoNo}-${item.segmentId}`"
            :to="`/operations/${item.unkoNo}`"
            custom
          >
            <template #default="{ navigate }">
              <tr
                class="border-t border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                @click="navigate"
              >
                <td class="px-3 py-2 whitespace-nowrap">{{ item.savedAt.slice(0, 16).replace('T', ' ') }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ item.vehicleCode }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ item.saleDateFrom }}{{ item.saleDateFrom !== item.saleDateTo ? ` 〜 ${item.saleDateTo}` : '' }}</td>
                <td class="px-3 py-2">{{ item.customerNames.join(', ') || '-' }}</td>
                <td class="px-3 py-2 text-right whitespace-nowrap">{{ formatYen(item.confirmedAmount) }} 円</td>
                <td class="px-3 py-2 whitespace-nowrap text-gray-500">{{ matchLevelLabel(item) }}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                  <NuxtLink
                    :to="{ path: '/profit/compare', query: compareLinkQuery(item) }"
                    class="text-blue-600 dark:text-blue-400 hover:underline"
                    @click.stop
                  >
                    比較 →
                  </NuxtLink>
                </td>
                <td class="px-3 py-2 whitespace-nowrap">
                  <button
                    class="text-red-600 dark:text-red-400 hover:underline"
                    @click.stop="requestDeleteSnapshot(item)"
                  >
                    削除
                  </button>
                </td>
              </tr>
            </template>
          </NuxtLink>
        </tbody>
      </table>
    </div>

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

    <!-- Delete confirmation modal -->
    <UModal v-model:open="deleteConfirmOpen">
      <template #content>
        <div class="p-6 space-y-4">
          <h3 class="text-lg font-bold">検証スナップショットの削除</h3>
          <p class="text-gray-600 dark:text-gray-400 text-sm">
            車輌{{ deleteTarget?.vehicleCode }} / {{ deleteTarget?.saleDateFrom }}<template v-if="deleteTarget && deleteTarget.saleDateFrom !== deleteTarget.saleDateTo"> 〜 {{ deleteTarget?.saleDateTo }}</template> /
            {{ deleteTarget?.customerNames.join(', ') || '-' }} の検証スナップショットを削除しますか？この操作は取り消せません。
          </p>
          <p v-if="deleteError" class="text-sm text-red-600 dark:text-red-400">{{ deleteError }}</p>
          <div class="flex justify-end gap-2">
            <UButton label="キャンセル" variant="outline" @click="deleteConfirmOpen = false" />
            <UButton label="削除" color="error" :loading="deleting" @click="confirmDeleteSnapshot" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
