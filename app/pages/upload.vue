<script setup lang="ts">
import { uploadZip } from '~/utils/api'
import type { UploadResponse } from '~/types'

const isDragging = ref(false)
const isUploading = ref(false)
const result = ref<UploadResponse | null>(null)
const error = ref<string | null>(null)

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
  </div>
</template>
