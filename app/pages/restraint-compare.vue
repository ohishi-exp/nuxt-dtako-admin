<script setup lang="ts">
import { compareRestraintCsv, recalculateDriverStream, recalculateDriversBatch } from '~/utils/api'
import type { RecalcProgressEvent, BatchRecalcEvent } from '~/utils/api'

const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const results = ref<any[]>([])
const error = ref('')
const selectedFile = ref<File | null>(null)
const filterMode = ref<'all' | 'diff' | 'unknown'>('unknown')
/**
 * 1 人ぶんの再計算の状態。**`error` は「この結果が失敗である」ことを持つ** (Refs #917)。
 *
 * 文字列だけだと表示側の色分けが `result.includes('一致')` のような**文言判定**になり、
 * 失敗の理由文にたまたま「一致」の 2 文字が入った回に緑で出る。**失敗かどうかは
 * 文言から読み取らない。**
 */
const recalcStates = ref<Record<string, { loading: boolean; result: string; error?: boolean }>>({})
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
    results.value = await compareRestraintCsv(selectedFile.value, '「再比較」を押してください')
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
/** 一括再計算の進捗。**ボタンのラベルにしか出ない**ので、走り終われば消えてよい。 */
const batchRecalcProgress = ref('')
/**
 * 一括再計算が失敗した理由 (Refs #917)。
 *
 * **進捗と分けてある**のは、進捗が `batchRecalcRunning` の間しか描かれないため —
 * 理由を進捗に入れると、走り終わった瞬間にボタンのラベルが通常文言に戻り、
 * **失敗が画面から消える**。理由はこちらに入れて `UAlert` で出し続ける。
 */
const batchRecalcError = ref('')

/**
 * 再計算ストリームが**例外で終わった**ときに人に見せる 1 文 (Refs #917)。
 *
 * **進捗を 1 つでも受け取っていれば、切れたのは接続だけでサーバ側は走り続けている
 * ことがある**ので、「失敗しました」と断定しない。ここは表の行に出るセルなので
 * `restraint-report.vue` の長い文面は入らない — 短く、理由は残す。
 *
 * ⚠️ `app/pages/restraint-report.vue:133` に同名・同趣旨のローカル関数がある。
 * **#903 の 2 段目 (あちらを編集中) がマージされたら `app/utils/` へ 1 本に統合する。**
 * 今そちらを動かすと編集中のファイルと衝突するので、重複を承知でここに置く。
 */
function recalcStreamFailure(e: unknown, gotAnyEvent: boolean): string {
  const reason = e instanceof Error ? e.message : String(e)
  return gotAnyEvent
    ? `再計算が途中で切れました (${reason})。完了したかは不明 — 再比較で確認`
    : `再計算を開始できませんでした (${reason})`
}

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
  batchRecalcError.value = ''
  const driverIds = driversWithDiffs.map((r: any) => r.driver_id)

  /** `error` イベントを受け取ったか。**受け取ったら再比較しない。** */
  let batchFailed = false
  /** 進捗を 1 つでも受け取ったか (= 再計算が始まってはいた)。 */
  let gotAnyEvent = false

  try {
    await recalculateDriversBatch(year, month, driverIds, (evt: BatchRecalcEvent) => {
      gotAnyEvent = true
      if (evt.event === 'progress') {
        const errors = (evt as any).errors || 0
        batchRecalcProgress.value = `${evt.current}/${evt.total}名${errors > 0 ? ` (${errors}エラー)` : ''}`
      } else if (evt.event === 'batch_done') {
        const errors = (evt as any).errors || 0
        batchRecalcProgress.value = `${(evt as any).done || evt.total}名完了${errors > 0 ? ` ${errors}エラー` : ''} 再比較中...`
      } else if (evt.event === 'error') {
        // `/api/recalculate-drivers` は SSE で、alc は **DB エラーでも 200 を返す**
        // (エラーは本文に入る)。**失敗を知る手段はこの error イベントだけ**なので、
        // 進捗欄に入れて `finally` で消す、をやめる (Refs #917)。
        batchFailed = true
        batchRecalcError.value = evt.message || '一括再計算に失敗しました'
      }
    }, '「未知差分…名 再計算」を押してください')
  } catch (e: unknown) {
    if (!batchFailed) batchRecalcError.value = recalcStreamFailure(e, gotAnyEvent)
    batchFailed = true
  }

  try {
    // 失敗した回に再比較すると、**再計算されていない古い値**で結果が出る。続行しない。
    if (batchFailed) return

    // ★ ここから先で落ちたのは**再比較**であって再計算ではない。`recalcDriver` と
    //   同じ扱いにする — 「再計算に失敗」と読めると、**もう一度 全員ぶん回さないと
    //   直らない**ように見える (Refs #917)。
    //   なお `runCompare()` は自分で catch して `error` に入れる (**throw しない**)
    //   ので、例外ではなく `error` を見て判定する。throw するように変えるなら
    //   ここも直すこと。
    await runCompare()
    if (error.value) {
      batchRecalcError.value = `一括再計算は終わりましたが再比較に失敗しました (${error.value})`
      // 同じことを 2 つの UAlert で言わない (理由は上の 1 文に畳んである)。
      error.value = ''
    }
  } finally {
    batchRecalcRunning.value = false
    // 進捗はボタンのラベルなので消してよい。**理由は batchRecalcError に残る。**
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

  /** `error` イベントを受け取ったか。**受け取ったら再比較も「一致！」も出さない。** */
  let recalcFailed = false
  /** 進捗を 1 つでも受け取ったか (= 再計算が始まってはいた)。 */
  let gotAnyEvent = false

  try {
    await recalculateDriverStream(year, month, driverId, (evt: RecalcProgressEvent) => {
      gotAnyEvent = true
      if (evt.event === 'progress') {
        const step = evt.step === 'download' ? 'DL' : '処理'
        recalcStates.value[key] = { loading: true, result: `${step}中 (${evt.current}/${evt.total})` }
      } else if (evt.event === 'done') {
        recalcStates.value[key] = { loading: true, result: '再比較中...' }
      } else if (evt.event === 'error') {
        // `/api/recalculate-driver` は SSE で、alc は **DB エラーでも 200 を返す**。
        // **失敗を知る手段はこの error イベントだけ** (Refs #917)。
        recalcFailed = true
        recalcStates.value[key] = { loading: false, result: evt.message || '再計算に失敗しました', error: true }
      }
    }, '行の「再計算」を押してください')
  } catch (e: unknown) {
    // **error イベントで受け取った理由の方が具体的**なので、既に持っていれば上書きしない。
    if (!recalcFailed) {
      recalcStates.value[key] = { loading: false, result: recalcStreamFailure(e, gotAnyEvent), error: true }
    }
    return
  }

  // ★ 失敗した回はここで止める。以前はこの下の「再計算完了 → 再比較」が
  //   **エラーかどうかを一切見ずに** `一致！` / `完了` で上書きしていたため、
  //   **理由が数ミリ秒だけ出て消え、失敗が成功に読めていた** (Refs #917)。
  if (recalcFailed) return

  // 再計算完了 → 1件だけ再比較
  try {
    if (selectedFile.value) {
      const updated = await compareRestraintCsv(selectedFile.value, '「再比較」を押してください', driverCd)
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
  } catch (e: unknown) {
    // **再計算は終わっている**。ここで落ちたのは再比較なので、そう書く —
    // 「再計算に失敗」と出すと、もう一度回さないと直らないように読める。
    const reason = e instanceof Error ? e.message : String(e)
    recalcStates.value[key] = { loading: false, result: `再計算は終わりましたが再比較に失敗しました (${reason})`, error: true }
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
    <UAlert v-if="batchRecalcError" :title="batchRecalcError" color="error" icon="i-lucide-circle-x" variant="subtle" />

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
            :class="recalcStates[r.driver_cd]!.error ? 'text-red-600' : recalcStates[r.driver_cd]!.result.includes('一致') ? 'text-green-600' : recalcStates[r.driver_cd]!.result.includes('未知') ? 'text-red-600' : 'text-yellow-600'"
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
