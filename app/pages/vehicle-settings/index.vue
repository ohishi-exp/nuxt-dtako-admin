<script setup lang="ts">
/**
 * 車輛設定 ビューア — NET780 デジタコ dump zip をアップロードして `.cfg` 内容を表示する。
 *
 * `POST /api/vehicle-settings/extract` に multipart で zip を投げると JSON が返るので
 * `<VehicleSettingsDisplay>` で日本語化付きで表示する。
 * extract endpoint は R2 (`DTAKO_R2`) に dump を保存するので、保存ステータスも併せて表示。
 */

import { ref } from 'vue'
import VehicleSettingsDisplay from '~/components/VehicleSettingsDisplay.vue'
import type { VehicleSettings } from '~/utils/vehicle-settings-cfg'

interface ExtractResult extends VehicleSettings {
  saved: { json_key: string; cfg_key: string } | null
  saved_warning: string | null
}

const file = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)
const loading = ref(false)
const error = ref('')
const result = ref<ExtractResult | null>(null)

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  file.value = input.files && input.files[0] ? input.files[0] : null
  result.value = null
  error.value = ''
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f) {
    file.value = f
    result.value = null
    error.value = ''
  }
}

async function submit() {
  if (!file.value) {
    error.value = 'zip ファイルを選択してください'
    return
  }
  loading.value = true
  error.value = ''
  result.value = null
  try {
    const form = new FormData()
    form.append('file', file.value)
    const res = await fetch('/api/vehicle-settings/extract', {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`抽出失敗 (${res.status}): ${text || res.statusText}`)
    }
    result.value = (await res.json()) as ExtractResult
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '抽出に失敗しました'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold">車輛設定 ビューア</h2>
      <div class="flex gap-3 text-sm">
        <NuxtLink
          to="/vehicle-settings/history"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          履歴を見る →
        </NuxtLink>
        <NuxtLink
          to="/vehicle-settings/unconfirmed"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          未確認車輛 →
        </NuxtLink>
      </div>
    </div>

    <p class="text-sm text-gray-600 dark:text-gray-400">
      NET780 デジタコ本体から吸い出した運行 dump zip
      (<code>&lt;vehicle_cd&gt;/&lt;YYYYMMDD_HHMMSS-...&gt;/*.cfg</code> を含むもの) を
      アップロードすると、車輛側の設定値を 日本語項目名 + 単位 + enum 意味 付きで表示します。
      抽出結果は R2 (<code>vehicle-settings/</code>) に保存され、後から履歴ページで参照できます。
    </p>

    <!-- アップロード -->
    <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
      <div
        class="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors"
        :class="dragOver
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40'
          : 'border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-600'"
        @click="fileInput?.click()"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop="onDrop"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".zip,application/zip"
          class="hidden"
          @change="onFileChange"
        >
        <div v-if="!file" class="text-sm text-gray-600 dark:text-gray-400">
          zip をドラッグ&ドロップ または クリックで選択
        </div>
        <div v-else class="text-sm">
          <div class="font-mono">{{ file.name }}</div>
          <div class="text-xs text-gray-500 dark:text-gray-400">
            {{ (file.size / 1024).toFixed(1) }} KB
          </div>
        </div>
      </div>
      <div class="flex justify-end">
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          :disabled="loading || !file"
          @click="submit"
        >
          <span v-if="loading">抽出中...</span>
          <span v-else>設定を抽出</span>
        </button>
      </div>
    </div>

    <div v-if="error" class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
      {{ error }}
    </div>

    <!-- R2 保存ステータス -->
    <div
      v-if="result?.saved"
      class="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200 p-3 rounded text-sm"
    >
      <div class="font-semibold">✓ R2 に保存しました</div>
      <div class="font-mono text-xs mt-1 break-all">{{ result.saved.json_key }}</div>
      <div class="font-mono text-xs break-all">{{ result.saved.cfg_key }}</div>
    </div>
    <div
      v-else-if="result?.saved_warning"
      class="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-300 dark:border-yellow-700 text-yellow-900 dark:text-yellow-200 p-3 rounded text-sm"
    >
      ⚠ {{ result.saved_warning }}
    </div>

    <!-- 結果表示 -->
    <VehicleSettingsDisplay v-if="result" :data="result" />
  </div>
</template>
