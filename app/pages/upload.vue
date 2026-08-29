<script setup lang="ts">
import { uploadZip, getPendingUploads, rerunUpload, getUploads, splitCsv } from '~/utils/api'
import { parseSplitCsvResponse } from '~/utils/scrape-split'
import type { UploadResponse, PendingUpload } from '~/types'
import { describeCaughtError } from '~/utils/api-error'

const isDragging = ref(false)
const isUploading = ref(false)
const result = ref<UploadResponse | null>(null)
const error = ref<string | null>(null)

// --- Pending uploads ---
const pendingUploads = ref<PendingUpload[]>([])
const pendingLoading = ref(false)
// 取得に失敗した理由 (Refs #911)。**空配列だけでは「0 件」と区別が付かない**ので、
// 「読めなかった」ことを状態として持つ。成功したら必ず null に戻す。
const pendingError = ref<string | null>(null)
const rerunningId = ref<string | null>(null)
const rerunResult = ref<{ id: string; success: boolean; message: string } | null>(null)

// --- Upload history (CSV split) ---
const uploads = ref<any[]>([])
const uploadsLoading = ref(false)
const uploadsError = ref<string | null>(null)
const splittingId = ref<string | null>(null)
const splitResults = ref<Record<string, { success: boolean; message: string }>>({})

function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragging.value = true
}

function onDragLeave() {
  isDragging.value = false
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  const file = e.dataTransfer?.files[0]
  if (file) handleUpload(file)
}

function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) handleUpload(file)
  input.value = ''
}

async function handleUpload(file: File) {
  if (!file.name.endsWith('.zip')) {
    error.value = 'ZIP ファイルを選択してください'
    return
  }

  error.value = null
  result.value = null
  isUploading.value = true

  try {
    result.value = await uploadZip(file)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'アップロードに失敗しました'
  } finally {
    isUploading.value = false
  }
}

/**
 * 一覧の取得失敗を 1 行にする (Refs #911 / #1008)。
 *
 * ## `describeCaughtError` に通す — 足しているのは**「次に何をすればいいか」**
 *
 * `getPendingUploads` / `getUploads` は `app/utils/api.ts` の `request()` →
 * `@ippoan/auth-client` の `createAuthFetch` 経由で、そこは非 2xx を
 * `new Error(`API エラー (${status}): ${body || statusText}`)` に組んで投げる
 * (`createAuthFetch.ts:56`)。**ofetch の `FetchError` ではない**ので `statusCode` も
 * `data` も持たず、**理由の文字列は `describeApiError` を当てても 1 文字も変わらない**
 * (#910 が (B) 経路 28 箇所で実測済み。この事実は #1008 でも変わっていない)。
 *
 * **変わるのは末尾**で、`describeCaughtError` が
 * `` `API エラー (503): …` `` の `` `(3 桁): ` `` から status を読み、
 * 401 は再ログイン / 403 は管理者へ / 5xx は復旧待ち、と撃ち分ける。
 * **理由そのものを 1 行に畳むのは今も #904 (`api.ts` 側) の担当**で、ここで JSON を
 * 読み直すと二重実装になるのでやっていない。
 *
 * ## いま実際に出る文字列 (合成後の 1 文)
 *
 * ```
 * 保留中のアップロードを取得できませんでした (API エラー (503): { "error": true, … }
 *   — サーバ側の設定か障害です (権限の問題ではありません)。
 *     復旧してから「保留中のアップロードを再取得」を押してください)
 * ```
 *
 * ## ★ `retry` は**画面に実在するボタンの表記そのまま**
 *
 * この 2 つの再取得ボタンは **`icon` だけでラベルの文字を持っていなかった**ので、
 * **`aria-label` を足してそれを引用している** (#1008)。案内文のためだけに
 * ラベルを創作したのではなく、**画面 (と読み上げ) の側に足したものを引用**している。
 * `tests/components/next-step-retry-labels.test.ts` が
 * 「その `.vue` の template に実在するか」を機械で見ている。
 *
 * ## ★ ここでは塞げない穴 (#904 に申し送り、未測定)
 *
 * 本番は HTTP/3 で reason phrase が空 (`res.statusText === ''`) なので、
 * **本文が空の非 2xx では `e.message` が `API エラー (503): ` (コロンの後ろが空)** に
 * なる。`api.ts` / `createAuthFetch` に触らずには塞げない。dev は HTTP/1.1 なので
 * この形は踏めず、**実測できていない**。
 * **ただし「次の一手」はこの穴の中でも出る** — status は `(503): ` の側から読める。
 */
function describeListFailure(e: unknown, retry: string): string {
  return e instanceof Error ? describeCaughtError(e, retry) : '理由を読めませんでした'
}

async function loadPending() {
  pendingLoading.value = true
  pendingError.value = null
  try {
    pendingUploads.value = await getPendingUploads()
  } catch (e) {
    // 一覧は空に戻す (前回読めた内容を残すと「いま読めた分」に見える)。
    // **ただし空にした理由を必ず持つ** — 空配列だけだと画面が「保留中は無い」と
    // 読まれ、API が落ちて読めなかっただけの回と区別が付かない (Refs #911)。
    pendingUploads.value = []
    pendingError.value = describeListFailure(e, '「保留中のアップロードを再取得」を押してください')
  } finally {
    pendingLoading.value = false
  }
}

async function handleRerun(upload: PendingUpload) {
  rerunningId.value = upload.id
  rerunResult.value = null
  try {
    const res = await rerunUpload(upload.id)
    upload.status = res.status
    rerunResult.value = {
      id: upload.id,
      success: true,
      message: `${res.operations_count} 件取り込み完了`,
    }
    await loadPending()
  } catch (e) {
    rerunResult.value = {
      id: upload.id,
      success: false,
      message: e instanceof Error ? e.message : 'リランに失敗しました',
    }
  } finally {
    rerunningId.value = null
  }
}

function statusColor(status: string) {
  switch (status) {
    case 'completed': return 'success' as const
    case 'pending_retry': return 'warning' as const
    case 'failed': return 'error' as const
    default: return 'neutral' as const
  }
}

function statusLabel(status: string) {
  switch (status) {
    case 'completed': return '完了'
    case 'pending_retry': return '保留中'
    case 'failed': return '失敗'
    default: return status
  }
}

function formatDatetime(iso: string) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function loadUploads() {
  uploadsLoading.value = true
  uploadsError.value = null
  try {
    uploads.value = await getUploads()
  } catch (e) {
    // loadPending と同じ理由 (Refs #911)。
    uploads.value = []
    uploadsError.value = describeListFailure(e, '「アップロード履歴を再取得」を押してください')
  } finally {
    uploadsLoading.value = false
  }
}

async function handleSplit(uploadId: string) {
  splittingId.value = uploadId
  try {
    // 200 が返っても個別 CSV の PUT が失敗していることがある (`split_failed`)。
    // 「分割完了」と言い切ると、運行が消えたままなのに直したつもりになる (Refs #205-40)。
    const failed = parseSplitCsvResponse(await splitCsv(uploadId))
    splitResults.value[uploadId] = failed !== null && failed > 0
      ? { success: false, message: `${failed} 件失敗したままです` }
      : { success: true, message: '分割完了' }
  } catch (e) {
    splitResults.value[uploadId] = { success: false, message: e instanceof Error ? e.message : '失敗' }
  } finally {
    splittingId.value = null
  }
}

onMounted(() => {
  loadPending()
  loadUploads()
})
</script>

<template>
  <div class="max-w-2xl mx-auto space-y-6">
    <h2 class="text-xl font-bold">デジタコ CSV アップロード</h2>

    <!-- Drop zone -->
    <div
      class="border-2 border-dashed rounded-xl p-12 text-center transition-colors cursor-pointer"
      :class="isDragging
        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
        : 'border-gray-300 dark:border-gray-700 hover:border-gray-400'"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="($refs.fileInput as HTMLInputElement).click()"
    >
      <UIcon name="i-lucide-upload-cloud" class="size-12 text-gray-400 mx-auto mb-4" />
      <p class="text-gray-600 dark:text-gray-400">
        ZIP ファイルをドラッグ＆ドロップ<br>
        またはクリックして選択
      </p>
      <input
        ref="fileInput"
        type="file"
        accept=".zip"
        class="hidden"
        @change="onFileSelect"
      >
    </div>

    <!-- Loading -->
    <div v-if="isUploading" class="flex items-center gap-3 p-4">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-5" />
      <span>アップロード中...</span>
    </div>

    <!-- Result -->
    <UAlert
      v-if="result"
      icon="i-lucide-check-circle"
      color="success"
      variant="subtle"
      :title="`${result.operations_count} 件の運行データを取り込みました`"
    />

    <!-- 取り込みは成功したが CSV 分割が失敗した (Refs #205-40)。分割されていない運行は
         `has_kudgivt = FALSE` のまま残り、読み取り側 3 クエリが全部 TRUE で絞るため
         一覧からも欠け検知からも消える。取り込みの成功表示とは別枠で出す。 -->
    <UAlert
      v-if="result && (result.split_failed ?? 0) > 0"
      icon="i-lucide-alert-triangle"
      color="error"
      variant="subtle"
      :title="`CSV分割が ${result.split_failed} 件失敗しました`"
      description="このままだと該当運行が一覧にも欠け検知にも出てきません。下の「アップロード履歴 / CSV分割」で該当のアップロードの「CSV分割」を押してやり直してください。"
    />

    <!-- Error -->
    <UAlert
      v-if="error"
      icon="i-lucide-alert-circle"
      color="error"
      variant="subtle"
      :title="error"
    />

    <!-- Pending Uploads -->
    <UCard>
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-lg font-bold">保留中のアップロード</h3>
        <!-- ★ `aria-label` はこのボタンの**唯一の表記** (アイコンだけで文字が無い)。
             読み上げのためだけでなく、取得に失敗したときの案内文
             (`describeListFailure` の `retry`) がこの文字列を引用している。
             **変えるときは `loadPending` の catch の文字列も一緒に**
             (`tests/components/next-step-retry-labels.test.ts` が突き合わせる)。 -->
        <UButton
          icon="i-lucide-refresh-cw"
          aria-label="保留中のアップロードを再取得"
          variant="ghost"
          size="xs"
          :loading="pendingLoading"
          @click="loadPending"
        />
      </div>

      <div v-if="pendingLoading && pendingUploads.length === 0" class="py-8 text-center text-gray-400">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
        読み込み中...
      </div>

      <!-- ★ 「読めなかった」と「0 件」を別の文にする (Refs #911)。理由だけ出すと
           **本当に 0 件の回**まで異常に見えるので、0 件の文はそのまま残し、
           失敗の回は**判らないと言って確かめ方まで出す** (#910 と同じ形)。 -->
      <div v-else-if="pendingError" class="py-8 text-center text-sm space-y-1">
        <p class="text-red-600 dark:text-red-400 break-words">
          保留中のアップロードを取得できませんでした ({{ pendingError }})
        </p>
        <p class="text-gray-400">
          <!-- ★ 「再読み込みを押して確かめてください」を落とした (Refs #1008)。
               やり直し方は**上の 1 文が実在するボタン名で言う**ようになったので、
               ここに残すと**同じ指示が 2 回**出るうえ、**この画面に「再読み込み」という
               表記のボタンは無い** (アイコンだけのボタンで、名前は `aria-label` の
               「保留中のアップロードを再取得」/「アップロード履歴を再取得」)。
               この段が言うべきは「0 件と読めなかったの区別が付かない」ことだけ。 -->
          0 件なのか読めなかっただけなのかは、この画面では判りません
        </p>
      </div>

      <div v-else-if="pendingUploads.length === 0" class="py-8 text-center text-gray-400 text-sm">
        保留中のアップロードはありません
      </div>

      <div v-else class="space-y-2">
        <div
          v-for="item in pendingUploads"
          :key="item.id"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm border"
          :class="{
            'border-green-200 dark:border-green-800': item.status === 'completed',
            'border-yellow-200 dark:border-yellow-800': item.status === 'pending_retry',
            'border-red-200 dark:border-red-800': item.status === 'failed',
          }"
        >
          <UBadge :color="statusColor(item.status)" variant="subtle" size="sm">
            {{ statusLabel(item.status) }}
          </UBadge>
          <span class="font-medium truncate">{{ item.filename }}</span>
          <span class="text-xs text-gray-500 shrink-0">{{ formatDatetime(item.created_at) }}</span>
          <span
            v-if="item.error_message"
            class="text-xs text-red-600 dark:text-red-400 truncate"
            :title="item.error_message"
          >
            {{ item.error_message }}
          </span>
          <div class="flex-1" />
          <span
            v-if="rerunResult && rerunResult.id === item.id && rerunResult.success"
            class="text-xs text-green-600"
          >
            {{ rerunResult.message }}
          </span>
          <span
            v-if="rerunResult && rerunResult.id === item.id && !rerunResult.success"
            class="text-xs text-red-600"
          >
            {{ rerunResult.message }}
          </span>
          <UButton
            v-if="item.status === 'pending_retry' || item.status === 'failed'"
            label="リラン"
            icon="i-lucide-refresh-cw"
            variant="soft"
            color="warning"
            size="xs"
            :loading="rerunningId === item.id"
            :disabled="rerunningId !== null"
            @click="handleRerun(item)"
          />
        </div>
      </div>
    </UCard>

    <!-- Upload History (CSV Split) -->
    <UCard>
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-lg font-bold">アップロード履歴 / CSV分割</h3>
        <!-- 上と同じ (Refs #1008)。`aria-label` がこのボタンの唯一の表記で、
             `loadUploads` の catch の案内文がこの文字列を引用している。 -->
        <UButton
          icon="i-lucide-refresh-cw"
          aria-label="アップロード履歴を再取得"
          variant="ghost"
          size="xs"
          :loading="uploadsLoading"
          @click="loadUploads"
        />
      </div>

      <div v-if="uploadsLoading && uploads.length === 0" class="py-4 text-center text-gray-400 text-sm">
        読み込み中...
      </div>

      <!-- 上と同じ (Refs #911)。 -->
      <div v-else-if="uploadsError" class="py-4 text-center text-sm space-y-1">
        <p class="text-red-600 dark:text-red-400 break-words">
          アップロード履歴を取得できませんでした ({{ uploadsError }})
        </p>
        <p class="text-gray-400">
          <!-- ★ 「再読み込みを押して確かめてください」を落とした (Refs #1008)。
               やり直し方は**上の 1 文が実在するボタン名で言う**ようになったので、
               ここに残すと**同じ指示が 2 回**出るうえ、**この画面に「再読み込み」という
               表記のボタンは無い** (アイコンだけのボタンで、名前は `aria-label` の
               「保留中のアップロードを再取得」/「アップロード履歴を再取得」)。
               この段が言うべきは「0 件と読めなかったの区別が付かない」ことだけ。 -->
          0 件なのか読めなかっただけなのかは、この画面では判りません
        </p>
      </div>

      <div v-else-if="uploads.length === 0" class="py-4 text-center text-gray-400 text-sm">
        アップロード履歴なし
      </div>

      <div v-else class="space-y-2">
        <div
          v-for="item in uploads"
          :key="item.id"
          class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm border dark:border-gray-700"
        >
          <UBadge :color="statusColor(item.status)" variant="subtle" size="sm">
            {{ statusLabel(item.status) }}
          </UBadge>
          <span class="font-medium truncate text-xs">{{ item.filename }}</span>
          <span class="text-xs text-gray-500 shrink-0">{{ formatDatetime(item.created_at) }}</span>
          <div class="flex-1" />
          <span
            v-if="splitResults[item.id]?.success"
            class="text-xs text-green-600"
          >{{ splitResults[item.id]!.message }}</span>
          <span
            v-if="splitResults[item.id] && !splitResults[item.id]!.success"
            class="text-xs text-red-600"
          >{{ splitResults[item.id]!.message }}</span>
          <UButton
            v-if="item.status === 'completed'"
            label="CSV分割"
            icon="i-lucide-scissors"
            variant="soft"
            color="primary"
            size="xs"
            :loading="splittingId === item.id"
            :disabled="splittingId !== null"
            @click="handleSplit(item.id)"
          />
        </div>
      </div>
    </UCard>
  </div>
</template>
