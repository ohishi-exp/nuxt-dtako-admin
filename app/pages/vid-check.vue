<script setup lang="ts">
import { decodeVdf, mergeTelemetrySegments, probeVideoDuration } from '~/utils/dtako-vid-wasm'
import type { VdfTelemetry } from '~/utils/dtako-vid-wasm'
import { useVideoCrop } from '~/composables/useVideoCrop'
import { fmtDuration } from '~/utils/time-format'

interface Segment {
  fileName: string
  fileSize: number
  frontUrl: string | null
  rearUrl: string | null
  telemetry: VdfTelemetry
  duration: number
}

const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const loadingProgress = ref('')
const error = ref<string | null>(null)

const segments = ref<Segment[]>([])
const activeSegmentIndex = ref(0)
const localCurrentTime = ref(0)
const pendingSeekLocal = ref<number | null>(null)

const frontVideoEl = ref<HTMLVideoElement | null>(null)
const rearVideoEl = ref<HTMLVideoElement | null>(null)
const frontContainerEl = ref<HTMLDivElement | null>(null)
const rearContainerEl = ref<HTMLDivElement | null>(null)

/**
 * 表示モード: 両方 / 前方のみ / 後方のみ。前方のみ・後方のみでも列数は3列のまま
 * (映像カードが左2列分の幅を使い、GPS軌跡が右1列に残る)。
 */
const displayMode = ref<'both' | 'front' | 'rear'>('both')

function toggleFrontOnly() {
  displayMode.value = displayMode.value === 'front' ? 'both' : 'front'
}
function toggleRearOnly() {
  displayMode.value = displayMode.value === 'rear' ? 'both' : 'rear'
}

const frontCrop = useVideoCrop()
const rearCrop = useVideoCrop()

/**
 * テレメトリグラフ下の区間選択バーで指定する再生区間 (結合後タイムライン上、秒)。
 * クロップ中は映像のネイティブシークバーが使えないため、この区間バー + ループ再生で
 * 特定のイベント区間を繰り返し確認できるようにする。
 */
const rangeStart = ref<number | null>(null)
const rangeEnd = ref<number | null>(null)
const loopRange = ref(false)

watch([rangeStart, rangeEnd], () => {
  if (rangeStart.value === null || rangeEnd.value === null) loopRange.value = false
})

/** 区間選択バーで指定した範囲を実時間で録画・ダウンロードする「クリップ」機能の状態。 */
const clipping = ref(false)
const clipProgress = ref(0)

const activeSegment = computed<Segment | null>(() => segments.value[activeSegmentIndex.value] ?? null)

const hasFront = computed(() => segments.value.some(s => s.frontUrl))
const hasRear = computed(() => segments.value.some(s => s.rearUrl))

/** 各セグメントの開始オフセット (結合後タイムライン上、秒)。 */
const segmentOffsets = computed<number[]>(() => {
  const offsets: number[] = []
  let cumulative = 0
  for (const seg of segments.value) {
    offsets.push(cumulative)
    cumulative += seg.duration
  }
  return offsets
})

const totalDuration = computed(() => segments.value.reduce((sum, s) => sum + s.duration, 0))

const mergedTelemetry = computed<VdfTelemetry | null>(() => {
  if (segments.value.length === 0) return null
  return mergeTelemetrySegments(segments.value.map(s => ({ telemetry: s.telemetry, duration: s.duration })))
})

/** 結合後タイムライン上の現在位置 (グラフ/地図のシークバーに渡す)。 */
const globalCurrentTime = computed(() => (segmentOffsets.value[activeSegmentIndex.value] ?? 0) + localCurrentTime.value)

function onTimeUpdate() {
  const el = frontVideoEl.value || rearVideoEl.value
  if (el) localCurrentTime.value = el.currentTime
  // クリップ (区間の実時間録画) 中はループで巻き戻さない (録画の終端検出と競合するため)
  if (!clipping.value && loopRange.value && rangeEnd.value !== null && globalCurrentTime.value >= rangeEnd.value) {
    onSeek(rangeStart.value ?? 0)
    // 一部ブラウザはシーク直後に再生を止めることがあるため、再生中なら明示的に再開する
    if (isPlaying.value) {
      frontVideoEl.value?.play().catch(() => {})
      rearVideoEl.value?.play().catch(() => {})
    }
  }
}

/**
 * クロップ適用中の映像はネイティブ `controls` を隠す (transform で拡大すると
 * コントロールバーも一緒に拡大されて操作不能になるため)。その代わりに前方/
 * 後方をまとめて再生・一時停止できるボタンを常設する。
 */
const isPlaying = ref(false)

function togglePlayback() {
  const els = [frontVideoEl.value, rearVideoEl.value].filter((el): el is HTMLVideoElement => el !== null)
  const playing = els.some(el => !el.paused)
  if (playing) {
    els.forEach(el => el.pause())
    isPlaying.value = false
  }
  else {
    els.forEach(el => el.play().catch(() => {}))
    isPlaying.value = true
  }
}

function onLoadedMetadata() {
  if (pendingSeekLocal.value !== null) {
    const t = pendingSeekLocal.value
    if (frontVideoEl.value) frontVideoEl.value.currentTime = t
    if (rearVideoEl.value) rearVideoEl.value.currentTime = t
    localCurrentTime.value = t
    pendingSeekLocal.value = null
  }
  // シークでセグメントを跨いだ (src が再読込された) 場合、再生中だったなら続きから再生する
  if (isPlaying.value) {
    frontVideoEl.value?.play().catch(() => {})
    rearVideoEl.value?.play().catch(() => {})
  }
}

/**
 * 前方/後方の両方が存在するセグメントでは、両方の `<video>` の `ended` が
 * (ほぼ同時だが) 別々に発火しうる。片方だけを「代表」として扱わないと
 * セグメントを2つ分スキップしてしまうため、そのセグメントの代表側
 * (前方があれば前方、無ければ後方) からの ended だけを処理する。
 */
function onEnded(source: 'front' | 'rear') {
  const canonical = activeSegment.value?.frontUrl ? 'front' : 'rear'
  if (source !== canonical) return
  if (activeSegmentIndex.value >= segments.value.length - 1) {
    isPlaying.value = false
    return
  }
  activeSegmentIndex.value += 1
  localCurrentTime.value = 0
  nextTick(() => {
    frontVideoEl.value?.play().catch(() => {})
    rearVideoEl.value?.play().catch(() => {})
  })
}

/** グラフ/地図からの結合タイムライン上のシーク要求。必要ならセグメントを切り替える。 */
function onSeek(globalSeconds: number) {
  const offsets = segmentOffsets.value
  let segIdx = 0
  for (let i = 0; i < offsets.length; i++) {
    if (globalSeconds >= offsets[i]!) segIdx = i
  }
  const local = Math.max(0, globalSeconds - (offsets[segIdx] ?? 0))
  if (segIdx === activeSegmentIndex.value) {
    if (frontVideoEl.value) frontVideoEl.value.currentTime = local
    if (rearVideoEl.value) rearVideoEl.value.currentTime = local
    localCurrentTime.value = local
  }
  else {
    pendingSeekLocal.value = local
    activeSegmentIndex.value = segIdx
  }
}

/**
 * ループ再生を ON にした時、一時停止のままだと見た目に何も起きず「機能していない」
 * ように見えるため、区間の開始位置へシークした上で自動的に再生を始める。
 *
 * `togglePlayback()` (一時停止⇔再生の反転) は使わない — `isPlaying` はネイティブ
 * 操作バー等での再生開始を追従できておらず、既に再生中の状態で反転すると逆に
 * 一時停止させてしまうため。ここでは常に「再生している状態」を強制する。
 */
function toggleLoopRange() {
  const turningOn = !loopRange.value
  loopRange.value = turningOn
  if (!turningOn) return
  if (rangeStart.value !== null) onSeek(rangeStart.value)
  const els = [frontVideoEl.value, rearVideoEl.value].filter((el): el is HTMLVideoElement => el !== null)
  els.forEach(el => el.play().catch(() => {}))
  isPlaying.value = true
}

/**
 * 区間選択バーで指定した [rangeStart, rangeEnd] を、表示中の映像 (前方/後方の
 * うち現在レンダリングされているもの) ごとに `captureStream()` + `MediaRecorder`
 * で実時間録画し、webm としてダウンロードする。MP4 コンテナを直接切り出す
 * わけではない (デコード済み mp4 バイト列は保持していないため) ので、
 * 録画時間 = クリップ時間ぶんだけ実際に待つ点に注意。
 */
async function clipAndDownload() {
  if (clipping.value) return
  const start = rangeStart.value
  const end = rangeEnd.value
  if (start === null || end === null || end <= start) return

  const targets: { el: HTMLVideoElement, label: string }[] = []
  if (frontVideoEl.value) targets.push({ el: frontVideoEl.value, label: 'front' })
  if (rearVideoEl.value) targets.push({ el: rearVideoEl.value, label: 'rear' })
  if (targets.length === 0) return

  const wasPlaying = isPlaying.value
  targets.forEach(t => t.el.pause())
  onSeek(start)
  await nextTick()

  clipping.value = true
  clipProgress.value = 0
  error.value = null

  try {
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm'

    const recorders = targets.map(({ el, label }) => {
      const captureStream = (el as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream
      if (!captureStream) throw new Error('このブラウザは映像のクリップ書き出しに対応していません (captureStream 未対応)')
      const stream = captureStream.call(el)
      const recorder = new MediaRecorder(stream, { mimeType })
      const chunks: BlobPart[] = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      return { recorder, chunks, label }
    })

    recorders.forEach(r => r.recorder.start())
    targets.forEach(t => t.el.play().catch(() => {}))

    await new Promise<void>((resolve) => {
      const check = () => {
        const t = frontVideoEl.value?.currentTime ?? rearVideoEl.value?.currentTime ?? end
        clipProgress.value = Math.min(1, Math.max(0, (t - start) / (end - start)))
        if (t >= end || !clipping.value) {
          resolve()
          return
        }
        requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    })

    targets.forEach(t => t.el.pause())

    for (const { recorder, chunks, label } of recorders) {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
        recorder.stop()
      })
      const blob = new Blob(chunks, { type: mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `vid-clip-${label}-${Math.round(start)}s-${Math.round(end)}s.webm`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    }
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    clipping.value = false
    clipProgress.value = 0
    if (wasPlaying) {
      targets.forEach(t => t.el.play().catch(() => {}))
    }
  }
}

function revokeAll() {
  for (const seg of segments.value) {
    if (seg.frontUrl) URL.revokeObjectURL(seg.frontUrl)
    if (seg.rearUrl) URL.revokeObjectURL(seg.rearUrl)
  }
  segments.value = []
  activeSegmentIndex.value = 0
  localCurrentTime.value = 0
  pendingSeekLocal.value = null
  rangeStart.value = null
  rangeEnd.value = null
  loopRange.value = false
  clipping.value = false
  clipProgress.value = 0
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
      segments.value.push({
        fileName: file.name,
        fileSize: file.size,
        frontUrl,
        rearUrl,
        telemetry: result.telemetry,
        duration,
      })
    }
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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
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

      <div v-if="segments.length > 1 && !loading" class="flex flex-wrap gap-2 mt-3 text-xs">
        <span
          v-for="(seg, i) in segments"
          :key="seg.fileName + i"
          class="px-2 py-1 rounded-full"
          :class="i === activeSegmentIndex
            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
            : 'bg-gray-100 text-gray-500 dark:bg-gray-800'"
        >
          {{ i + 1 }}. {{ seg.fileName }} ({{ fmtBytes(seg.fileSize) }}, {{ fmtDuration(seg.duration) }})
        </span>
      </div>
    </UCard>

    <template v-if="!loading && segments.length > 0 && mergedTelemetry">
      <UCard class="mb-4">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="flex flex-wrap gap-6 text-sm">
            <div><span class="text-gray-500">車両コード:</span> <span class="font-medium">{{ mergedTelemetry.vehicle || '(なし)' }}</span></div>
            <div><span class="text-gray-500">乗務員コード:</span> <span class="font-medium">{{ mergedTelemetry.driver || '(なし)' }}</span></div>
            <div><span class="text-gray-500">前方フレーム数:</span> <span class="font-medium">{{ mergedTelemetry.front_frame_count }}</span></div>
            <div><span class="text-gray-500">後方フレーム数:</span> <span class="font-medium">{{ mergedTelemetry.rear_frame_count }}</span></div>
          </div>

          <UButton
            :label="isPlaying ? '一時停止' : '再生'"
            :icon="isPlaying ? 'i-lucide-pause' : 'i-lucide-play'"
            size="xs"
            color="neutral"
            variant="soft"
            @click="togglePlayback"
          />
        </div>
        <p class="text-xs text-gray-400 mt-2">
          クロップ (切り抜き拡大表示) 中の映像はネイティブ操作バーの代わりに上の「再生/一時停止」ボタンと、下のグラフのシークバー・区間選択バーを使ってください。
          区間選択バーをドラッグすると開始/終了を指定でき、端をつまんで微調整・ループ再生もできます。
        </p>
      </UCard>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <UCard v-if="displayMode !== 'rear'" :class="displayMode !== 'both' ? 'md:col-span-2' : ''">
          <template #header>
            <div class="flex items-center justify-between">
              <span>前方映像</span>
              <div class="flex gap-1">
                <UButton
                  size="xs"
                  variant="soft"
                  :color="displayMode === 'front' ? 'primary' : 'neutral'"
                  icon="i-lucide-columns-2"
                  :label="displayMode === 'front' ? '両方表示に戻す' : '前方のみ表示'"
                  :disabled="!hasFront"
                  @click="toggleFrontOnly"
                />
                <UButton
                  size="xs"
                  variant="soft"
                  :color="frontCrop.selecting.value ? 'primary' : 'neutral'"
                  icon="i-lucide-crop"
                  :label="frontCrop.selecting.value ? 'ドラッグで選択...' : 'クロップ'"
                  @click="frontCrop.toggleSelecting()"
                />
                <UButton
                  v-if="frontCrop.rect.value"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-x"
                  label="解除"
                  @click="frontCrop.reset()"
                />
              </div>
            </div>
          </template>
          <div
            ref="frontContainerEl"
            class="relative overflow-hidden rounded-lg bg-black select-none"
            @mousedown="frontCrop.onPointerDown($event, frontContainerEl)"
            @mousemove="frontCrop.onPointerMove($event, frontContainerEl)"
            @mouseup="frontCrop.onPointerUp()"
            @mouseleave="frontCrop.onPointerUp()"
          >
            <video
              v-if="activeSegment?.frontUrl"
              ref="frontVideoEl"
              :src="activeSegment.frontUrl"
              :controls="!frontCrop.rect.value"
              class="w-full h-auto block"
              :style="frontCrop.videoStyle.value"
              @timeupdate="onTimeUpdate"
              @loadedmetadata="onLoadedMetadata"
              @ended="onEnded('front')"
            />
            <p v-else class="text-sm text-gray-400 py-8 text-center">前方映像なし</p>
            <div
              v-if="frontCrop.selecting.value && frontCrop.dragBoxStyle.value"
              class="absolute border-2 border-blue-400 bg-blue-400/20 pointer-events-none"
              :style="frontCrop.dragBoxStyle.value"
            />
            <div
              v-if="frontCrop.selecting.value"
              class="absolute inset-0 flex items-center justify-center text-xs text-white bg-black/40 pointer-events-none"
            >
              ドラッグしてクロップ範囲を選択
            </div>
          </div>
        </UCard>

        <UCard v-if="displayMode !== 'front'" :class="displayMode !== 'both' ? 'md:col-span-2' : ''">
          <template #header>
            <div class="flex items-center justify-between">
              <span>後方映像</span>
              <div class="flex gap-1">
                <UButton
                  size="xs"
                  variant="soft"
                  :color="displayMode === 'rear' ? 'primary' : 'neutral'"
                  icon="i-lucide-columns-2"
                  :label="displayMode === 'rear' ? '両方表示に戻す' : '後方のみ表示'"
                  :disabled="!hasRear"
                  @click="toggleRearOnly"
                />
                <UButton
                  size="xs"
                  variant="soft"
                  :color="rearCrop.selecting.value ? 'primary' : 'neutral'"
                  icon="i-lucide-crop"
                  :label="rearCrop.selecting.value ? 'ドラッグで選択...' : 'クロップ'"
                  @click="rearCrop.toggleSelecting()"
                />
                <UButton
                  v-if="rearCrop.rect.value"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-x"
                  label="解除"
                  @click="rearCrop.reset()"
                />
              </div>
            </div>
          </template>
          <div
            ref="rearContainerEl"
            class="relative overflow-hidden rounded-lg bg-black select-none"
            @mousedown="rearCrop.onPointerDown($event, rearContainerEl)"
            @mousemove="rearCrop.onPointerMove($event, rearContainerEl)"
            @mouseup="rearCrop.onPointerUp()"
            @mouseleave="rearCrop.onPointerUp()"
          >
            <video
              v-if="activeSegment?.rearUrl"
              ref="rearVideoEl"
              :src="activeSegment.rearUrl"
              :controls="!rearCrop.rect.value"
              class="w-full h-auto block"
              :style="rearCrop.videoStyle.value"
              @timeupdate="onTimeUpdate"
              @loadedmetadata="onLoadedMetadata"
              @ended="onEnded('rear')"
            />
            <p v-else class="text-sm text-gray-400 py-8 text-center">後方映像なし</p>
            <div
              v-if="rearCrop.selecting.value && rearCrop.dragBoxStyle.value"
              class="absolute border-2 border-blue-400 bg-blue-400/20 pointer-events-none"
              :style="rearCrop.dragBoxStyle.value"
            />
            <div
              v-if="rearCrop.selecting.value"
              class="absolute inset-0 flex items-center justify-center text-xs text-white bg-black/40 pointer-events-none"
            >
              ドラッグしてクロップ範囲を選択
            </div>
          </div>
        </UCard>

        <UCard>
          <template #header>
            GPS 軌跡
          </template>
          <VidMap :gps="mergedTelemetry.gps" :telemetry="mergedTelemetry" :current-time="globalCurrentTime" />
        </UCard>
      </div>

      <UCard class="mb-4">
        <template #header>
          <div class="flex items-center justify-between">
            <span>Gセンサー・速度・回転数 (クリック/ドラッグでシーク)</span>
            <div v-if="rangeStart !== null && rangeEnd !== null" class="flex items-center gap-1">
              <UButton
                size="xs"
                variant="soft"
                :color="loopRange ? 'primary' : 'neutral'"
                icon="i-lucide-repeat"
                :label="loopRange ? 'ループ再生中' : 'この区間をループ再生'"
                :disabled="clipping"
                @click="toggleLoopRange"
              />
              <UButton
                size="xs"
                variant="soft"
                color="neutral"
                icon="i-lucide-scissors"
                :loading="clipping"
                :label="clipping ? `クリップ中... ${Math.round(clipProgress * 100)}%` : 'クリップをダウンロード'"
                :disabled="clipping"
                @click="clipAndDownload"
              />
            </div>
          </div>
        </template>
        <VidTelemetryChart
          :g="mergedTelemetry.g"
          :speed-rpm="mergedTelemetry.speed_rpm"
          :telemetry="mergedTelemetry"
          :duration="totalDuration"
          :current-time="globalCurrentTime"
          :range-start="rangeStart"
          :range-end="rangeEnd"
          @seek="onSeek"
          @update:range-start="rangeStart = $event"
          @update:range-end="rangeEnd = $event"
        />
      </UCard>
    </template>
  </div>
</template>
