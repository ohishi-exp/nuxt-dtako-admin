<script setup lang="ts">
/**
 * 保存済み検証一覧 (Refs #330 PR4 / #859)。
 *
 * `/operations/[unko_no]` の収支パネルで**過去に人が確認して保存した**検証スナップショット
 * (R2) を新しい順に一覧し、元の運行詳細・類似運行比較へ渡す・削除する画面。
 * 一覧の中身は `GET /api/profit/snapshots` (`SnapshotListItem`) がそのまま出る。
 *
 * **「一番星マッチ率検証 (月次)」の比較セクションは #859 で廃止した。**
 * #849 (PR-2) で収支パネルのスナップショット書き込みを止めたため、分子 (確認済み合計) が
 * 凍結する一方で分母 (一番星月計、毎回ライブ) だけが増え続け、**「マッチできていない量が
 * 増え続けている」という誤診**を生む形になっていた。突合の正は**粗利タブ (`/profit/margin`)**
 * で、そちらは動いている。**この一覧は過去の確認作業の記録**として残してある
 * (マッチレベルは保存時に焼き込んだ値を読むだけなので、書き込みが止まっても正しい)。
 */
import { snapshotUnreadableNote, type SnapshotListItem, type SnapshotListResult } from '~/utils/profit-r2'
import { describeApiError } from '~/utils/api-error'
import { currentAccessToken } from '~/utils/api'
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

// --- 保存済み検証スナップショット一覧 (Refs #330、車輌・月を先に決めなくても
//     保存したものから検索・閲覧できるようにする要望) ---

type SnapshotListStatus = 'idle' | 'loading' | 'ready' | 'error'
const snapshotListStatus = ref<SnapshotListStatus>('idle')
const snapshotListError = ref<string | null>(null)
const snapshotItems = ref<SnapshotListItem[]>([])
/** **本文を読めなかった保存**があることを人に言うための注記 (Refs #850)。無ければ空文字。
 * 空の一覧を「この条件では保存が無い」と読ませないため、**0 件のときも出す**。 */
const snapshotUnreadable = ref('')
const snapshotFilterVehicle = ref('')
const snapshotFilterYm = ref('')

async function loadSnapshotList() {
  snapshotListStatus.value = 'loading'
  snapshotListError.value = null
  try {
    const query: Record<string, string> = {}
    if (snapshotFilterVehicle.value) query.vehicle = snapshotFilterVehicle.value
    if (snapshotFilterYm.value) query.ym = snapshotFilterYm.value
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — この読み口が
    // `requireAuth` を通すようになった (Refs #988)。`snapshot.delete.ts` と同じ扱い。
    const token = currentAccessToken()
    const res = await $fetch<SnapshotListResult>('/api/profit/snapshots', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      query,
    })
    snapshotItems.value = res.items
    snapshotUnreadable.value = snapshotUnreadableNote(res.unreadable)
    snapshotListStatus.value = 'ready'
  }
  catch (e) {
    // 一覧そのものを読めなかったときは注記を残さない — こちらは `snapshotListError`
    // が理由を言う。前の検索で出た件数を持ち越すと、今の結果の話に読める。
    snapshotUnreadable.value = ''
    // 理由は JSON 本文から読む (Refs #890)。`e.message` だと status しか出ない。
    snapshotListError.value = describeApiError(e)
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
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — 削除の口が
    // `requireAuth` を通すようになった (Refs #988)。`postNet780Archive` と同じ扱い。
    const token = currentAccessToken()
    await $fetch('/api/profit/snapshot', {
      method: 'DELETE',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      query: { ym: item.ym, vehicle: item.vehicleCode, unkoNo: item.unkoNo, segmentId: item.segmentId },
    })
    snapshotItems.value = snapshotItems.value.filter(i => i !== item)
    deleteConfirmOpen.value = false
  }
  catch (e) {
    // 削除の失敗理由も JSON 本文から読む (Refs #890)。
    deleteError.value = describeApiError(e)
  }
  finally {
    deleting.value = false
  }
}

function matchLevelLabel(item: SnapshotListItem): string {
  const { exact, partial, none } = item.matchCounts
  return `完全${exact} / 部分${partial} / 根拠なし${none}`
}

/**
 * 円。`+ 0` は `Math.round` が返す `-0` を `0` に畳むためだけのもの
 * (`(-0).toLocaleString()` は `"-0"`。Refs #843 / #928)。**丸め方は変えない。**
 */
function formatYen(v: number): string {
  return (Math.round(v) + 0).toLocaleString('ja-JP')
}
</script>

<template>
  <div class="max-w-5xl mx-auto p-6">
    <h1 class="text-xl font-bold mb-1">保存済み検証一覧</h1>
    <p class="text-xs text-gray-500 mb-3">
      運行詳細の収支パネルで保存した検証結果を新しい順に表示します。行をクリックすると元の運行詳細に移動します。
    </p>

    <!-- 区画が黙って消えると「廃止された」と「壊れている・読み込めていない」が同じ見た目に
         なるので、消えたことと**次にどこを見ればよいか**を画面で言う (Refs #859)。
         **時期を書いてあるのは、あとで消してよい注記だと次の人に分かるようにするため。** -->
    <p class="text-xs text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-800 rounded px-3 py-2 mb-4">
      この画面にあった「一番星マッチ率検証 (月次)」の比較は
      <strong>2026-08 に廃止しました</strong>。突合の現況は
      <NuxtLink to="/profit/margin" class="text-blue-600 dark:text-blue-400 hover:underline">粗利タブ</NuxtLink>
      で見てください (運行単位なら運行詳細の「粗利タブの計上額」)。
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

    <p v-if="snapshotUnreadable" class="text-xs text-amber-600 dark:text-amber-400 mb-3">
      {{ snapshotUnreadable }}
    </p>
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
