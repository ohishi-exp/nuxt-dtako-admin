<script setup lang="ts">
import { decodeVdf } from '~/utils/dtako-vid-wasm'
import type { VdfTelemetry } from '~/utils/dtako-vid-wasm'

const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const fileName = ref('')
const fileSize = ref(0)

const frontUrl = ref<string | null>(null)
const rearUrl = ref<string | null>(null)
const telemetry = ref<VdfTelemetry | null>(null)

const frontVideoEl = ref<HTMLVideoElement | null>(null)
const rearVideoEl = ref<HTMLVideoElement | null>(null)
const currentTime = ref(0)
const duration = ref(0)

function onTimeUpdate() {
  const el = frontVideoEl.value || rearVideoEl.value
  if (el) currentTime.value = el.currentTime
}

function onLoadedMetadata() {
  const el = frontVideoEl.value || rearVideoEl.value
  if (el && Number.isFinite(el.duration)) duration.value = el.duration
}

function onSeek(seconds: number) {
  if (frontVideoEl.value) frontVideoEl.value.currentTime = seconds
  if (rearVideoEl.value) rearVideoEl.value.currentTime = seconds
  currentTime.value = seconds
}

function revokeUrls() {
  if (frontUrl.value) URL.revokeObjectURL(frontUrl.value)
  if (rearUrl.value) URL.revokeObjectURL(rearUrl.value)
  frontUrl.value = null
  rearUrl.value = null
  currentTime.value = 0
  duration.value = 0
}

onBeforeUnmount(revokeUrls)

async function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  loading.value = true
  error.value = null
  telemetry.value = null
  revokeUrls()
  fileName.value = file.name
  fileSize.value = file.size

  try {
    const buf = new Uint8Array(await file.arrayBuffer())
    const result = await decodeVdf(buf)
    if (result.hasFront) {
      frontUrl.value = URL.createObjectURL(new Blob([result.frontMp4], { type: 'video/mp4' }))
    }
    if (result.hasRear) {
      rearUrl.value = URL.createObjectURL(new Blob([result.rearMp4], { type: 'video/mp4' }))
    }
    telemetry.value = result.telemetry
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    loading.value = false
    input.value = ''
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="max-w-4xl">
    <h1 class="text-2xl font-bold mb-1">
      映像確認 (VDF アップロード)
    </h1>
    <p class="text-sm text-gray-500 mb-6">
      NET780 ドラレコイベント映像 (<code>.vdf</code>) をアップロードして、前方/後方映像と
      テレメトリ (G センサー / 速度・回転数 / GPS / イベント) が正しく抽出できるか確認します。
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
          label=".vdf ファイルを選択"
          icon="i-lucide-upload"
          :loading="loading"
          @click="fileInput?.click()"
        />
        <input
          ref="fileInput"
          type="file"
          accept=".vdf"
          class="hidden"
          @change="handleFileChange"
        >
        <span v-if="fileName" class="text-sm text-gray-500">
          {{ fileName }} ({{ fmtBytes(fileSize) }})
        </span>
      </div>

      <div v-if="loading" class="mt-3 text-sm text-gray-400">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-4 inline-block mr-1" />
        デコード中...
      </div>

      <div v-if="error" class="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
        <UIcon name="i-lucide-alert-circle" class="size-4 inline-block mr-1" />
        {{ error }}
      </div>
    </UCard>

    <template v-if="telemetry">
      <UCard class="mb-4">
        <div class="flex flex-wrap gap-6 text-sm">
          <div><span class="text-gray-500">車両コード:</span> <span class="font-medium">{{ telemetry.vehicle || '(なし)' }}</span></div>
          <div><span class="text-gray-500">乗務員コード:</span> <span class="font-medium">{{ telemetry.driver || '(なし)' }}</span></div>
          <div><span class="text-gray-500">前方フレーム数:</span> <span class="font-medium">{{ telemetry.front_frame_count }}</span></div>
          <div><span class="text-gray-500">後方フレーム数:</span> <span class="font-medium">{{ telemetry.rear_frame_count }}</span></div>
        </div>
      </UCard>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <UCard>
          <template #header>
            前方映像
          </template>
          <video
            v-if="frontUrl"
            ref="frontVideoEl"
            :src="frontUrl"
            controls
            class="w-full rounded-lg bg-black"
            @timeupdate="onTimeUpdate"
            @loadedmetadata="onLoadedMetadata"
          />
          <p v-else class="text-sm text-gray-400 py-8 text-center">前方映像なし</p>
        </UCard>
        <UCard>
          <template #header>
            後方映像
          </template>
          <video
            v-if="rearUrl"
            ref="rearVideoEl"
            :src="rearUrl"
            controls
            class="w-full rounded-lg bg-black"
            @timeupdate="onTimeUpdate"
            @loadedmetadata="onLoadedMetadata"
          />
          <p v-else class="text-sm text-gray-400 py-8 text-center">後方映像なし</p>
        </UCard>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <UCard>
          <template #header>
            GPS 軌跡
          </template>
          <VidMap :gps="telemetry.gps" :telemetry="telemetry" :current-time="currentTime" />
        </UCard>
        <UCard>
          <template #header>
            Gセンサー・速度・回転数 (クリック/ドラッグでシーク)
          </template>
          <VidTelemetryChart
            :g="telemetry.g"
            :speed-rpm="telemetry.speed_rpm"
            :telemetry="telemetry"
            :duration="duration"
            :current-time="currentTime"
            @seek="onSeek"
          />
        </UCard>
      </div>

      <UCard class="mb-4">
        <template #header>
          テレメトリ
        </template>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div>
            <h3 class="font-bold mb-1">Gセンサー ({{ telemetry.g.length }}件)</h3>
            <div v-for="(r, i) in telemetry.g" :key="i" class="py-0.5">
              前後 {{ r.g_front_back.toFixed(2) }}G / 左右 {{ r.g_left_right.toFixed(2) }}G / 上下 {{ r.g_up_down.toFixed(2) }}G
            </div>
          </div>
          <div>
            <h3 class="font-bold mb-1">速度・回転数 ({{ telemetry.speed_rpm.length }}件)</h3>
            <div v-for="(r, i) in telemetry.speed_rpm" :key="i" class="py-0.5">
              {{ r.speed_kmh.toFixed(2) }} km/h / {{ r.rpm }} rpm
            </div>
          </div>
          <div>
            <h3 class="font-bold mb-1">GPS ({{ telemetry.gps.length }}件)</h3>
            <div v-for="(r, i) in telemetry.gps" :key="i" class="py-0.5">
              [{{ r.fix }}] {{ r.lat.toFixed(6) }}, {{ r.lon.toFixed(6) }} ({{ r.heading_deg }}°)
            </div>
          </div>
          <div>
            <h3 class="font-bold mb-1">イベント ({{ telemetry.events.length }}件)</h3>
            <div v-for="(r, i) in telemetry.events" :key="i" class="py-0.5">
              code={{ r.code }} (ts={{ r.ts }})
            </div>
          </div>
        </div>
      </UCard>
    </template>
  </div>
</template>
