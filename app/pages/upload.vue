<script setup lang="ts">
import { uploadZip, getPendingUploads, rerunUpload } from '~/utils/api'
import type { UploadResponse, PendingUpload } from '~/types'

const isDragging = ref(false)
const isUploading = ref(false)
const result = ref<UploadResponse | null>(null)
const error = ref<string | null>(null)

// --- Pending uploads ---
const pendingUploads = ref<PendingUpload[]>([])
const pendingLoading = ref(false)
const rerunningId = ref<string | null>(null)
const rerunResult = ref<{ id: string; success: boolean; message: string } | null>(null)

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

async function loadPending() {
  pendingLoading.value = true
  try {
    pendingUploads.value = await getPendingUploads()
  } catch {
    pendingUploads.value = []
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

onMounted(() => {
  loadPending()
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
        <UButton
          icon="i-lucide-refresh-cw"
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
  </div>
</template>
