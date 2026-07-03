<script setup lang="ts">
import { decodeVdf, probeVideoDuration } from '~/utils/dtako-vid-wasm'
import { fmtDuration } from '~/utils/time-format'
import type { VdfSegment } from '~/components/VdfViewer.vue'

const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const loadingProgress = ref('')
const error = ref<string | null>(null)

const segments = ref<VdfSegment[]>([])

const totalDuration = computed(() => segments.value.reduce((sum, s) => sum + s.duration, 0))

function revokeAll() {
  for (const seg of segments.value) {
    if (seg.frontUrl) URL.revokeObjectURL(seg.frontUrl)
    if (seg.rearUrl) URL.revokeObjectURL(seg.rearUrl)
  }
  segments.value = []
}

onBeforeUnmount(revokeAll)

async function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  if (files.length === 0) return

  loading.value = true
  error.value = null
  revokeAll()

  try {
    // 複数ファイル選択時、ブラウザのファイル選択順 (ダイアログでの選択順) は
    // 録画日時と一致しないことがあるため、デコード後にヘッダーの video_start_ts
    // (先頭フレームの絶対撮影時刻) で時系列順に並べ替えてから結合する。
    const decoded: VdfSegment[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!
      loadingProgress.value = files.length > 1
        ? `${i + 1}/${files.length} ファイル処理中... (${file.name})`
        : 'デコード中...'
      const buf = new Uint8Array(await file.arrayBuffer())
      const result = await decodeVdf(buf)
      const frontUrl = result.hasFront ? URL.createObjectURL(new Blob([result.frontMp4], { type: 'video/mp4' })) : null
      const rearUrl = result.hasRear ? URL.createObjectURL(new Blob([result.rearMp4], { type: 'video/mp4' })) : null
      const probeUrl = frontUrl || rearUrl
      const duration = probeUrl ? await probeVideoDuration(probeUrl) : 0
      decoded.push({
        fileName: file.name,
        fileSize: file.size,
        frontUrl,
        rearUrl,
        telemetry: result.telemetry,
        duration,
      })
    }
    decoded.sort((a, b) => a.telemetry.video_start_ts - b.telemetry.video_start_ts)
    segments.value = decoded
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    revokeAll()
  }
  finally {
    loading.value = false
    loadingProgress.value = ''
    input.value = ''
  }
}
</script>

<template>
  <div class="max-w-7xl">
    <h1 class="text-2xl font-bold mb-1">
      映像確認 (VDF アップロード)
    </h1>
    <p class="text-sm text-gray-500 mb-6">
      NET780 ドラレコイベント映像 (<code>.vdf</code>) をアップロードして、前方/後方映像と
      テレメトリ (G センサー / 速度・回転数 / GPS / イベント) が正しく抽出できるか確認します。
      複数ファイルを選択すると再生順に結合し、1本の連続タイムラインとして表示します。
      デコードはブラウザ内 (wasm) で完結し、ファイルはサーバーに送信されません。
      Refs
      <a
        href="https://github.com/ohishi-exp/dtako-scraper/issues/20"
        target="_blank"
        class="underline"
      >ohishi-exp/dtako-scraper#20</a>
    </p>

    <UCard class="mb-4">
      <div class="flex flex-wrap items-center gap-3">
        <UButton
          label=".vdf ファイルを選択 (複数可)"
          icon="i-lucide-upload"
          :loading="loading"
          @click="fileInput?.click()"
        />
        <input
          ref="fileInput"
          type="file"
          accept=".vdf"
          multiple
          class="hidden"
          @change="handleFileChange"
        >
        <span v-if="segments.length > 0 && !loading" class="text-sm text-gray-500">
          {{ segments.length }} ファイル (合計 {{ fmtDuration(totalDuration) }})
        </span>
      </div>

      <div v-if="loading" class="mt-3 text-sm text-gray-400">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-4 inline-block mr-1" />
        {{ loadingProgress }}
      </div>

      <div v-if="error" class="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
        <UIcon name="i-lucide-alert-circle" class="size-4 inline-block mr-1" />
        {{ error }}
      </div>
    </UCard>

    <!-- ビューア本体 (前方/後方映像 + GPS 軌跡 + テレメトリグラフ + 区間ループ/クリップ)
         は VdfViewer に共通化 (dvr-viewer と共用、Refs #90) -->
    <VdfViewer v-if="!loading && segments.length > 0" :segments="segments" />
  </div>
</template>
