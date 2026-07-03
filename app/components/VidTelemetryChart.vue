<script setup lang="ts">
import type { GRecord, SpeedRpmRecord, VdfTelemetry } from '~/utils/dtako-vid-wasm'
import { recordOffsetSeconds } from '~/utils/dtako-vid-wasm'
import { fmtDuration } from '~/utils/time-format'

const props = defineProps<{
  g: GRecord[]
  speedRpm: SpeedRpmRecord[]
  telemetry: Pick<VdfTelemetry, 'video_start_ts'>
  duration: number
  currentTime: number
  /** 区間選択バーの選択中区間 (結合後タイムライン上、秒)。未選択時は null。 */
  rangeStart?: number | null
  rangeEnd?: number | null
}>()

const emit = defineEmits<{
  seek: [seconds: number]
  'update:rangeStart': [seconds: number | null]
  'update:rangeEnd': [seconds: number | null]
}>()

const WIDTH = 1400
const HEIGHT = 260
const PAD_LEFT = 46
const PAD_RIGHT = 58
const PLOT_LEFT = PAD_LEFT
const PLOT_RIGHT = WIDTH - PAD_RIGHT

// Gセンサーは物理的に意味のある固定レンジ (-2G〜+2G) を全系列で共有する
// (min-max 正規化だと「上下=常時+1G付近」のような系列がスケールを潰してしまい、
// 0G の位置も系列ごとにバラバラで読めなくなるため)。
const G_MIN = -2
const G_MAX = 2

interface Point { x: number, y: number }
interface Series { label: string, color: string, points: Point[] }
interface GridLine { y: number, label: string, emphasize: boolean }

function minMax(values: number[]): { min: number, max: number } {
  if (values.length === 0) return { min: 0, max: 1 }
  let min = values[0]!
  let max = values[0]!
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (min === max) {
    min -= 1
    max += 1
  }
  return { min, max }
}

/** データ最大値をキリの良い値 (10刻み) に切り上げる。0 件・0 の時は 10 を返す。 */
function niceMax(value: number): number {
  return Math.max(10, Math.ceil(value / 10) * 10)
}

function scaleY(v: number, min: number, max: number): number {
  return HEIGHT - ((v - min) / (max - min)) * HEIGHT
}

function buildSeries<T extends { ts: number, sub_us: number }>(
  records: T[],
  value: (r: T) => number,
  label: string,
  color: string,
  telemetry: Pick<VdfTelemetry, 'video_start_ts'>,
  duration: number,
  range: { min: number, max: number },
): Series {
  const raw = records.map(r => ({ t: recordOffsetSeconds(r, telemetry), v: value(r) }))
  const dur = duration || 1
  return {
    label,
    color,
    points: raw.map(r => ({
      x: PLOT_LEFT + (r.t / dur) * (PLOT_RIGHT - PLOT_LEFT),
      y: scaleY(r.v, range.min, range.max),
    })),
  }
}

// 速度・回転数は右軸を共有 (回転数は 0..rpmMax を 0..speedMax の見た目レンジに
// 合わせて re-scale する。web地球号ビューアの dual-axis 表示と同じ考え方)。
const speedMax = computed(() => niceMax(minMax(props.speedRpm.map(r => r.speed_kmh)).max))
const rpmMax = computed(() => niceMax(minMax(props.speedRpm.map(r => r.rpm)).max))

const series = computed<Series[]>(() => [
  buildSeries(props.g, r => r.g_front_back, 'G前後', '#818cf8', props.telemetry, props.duration, { min: G_MIN, max: G_MAX }),
  buildSeries(props.g, r => r.g_left_right, 'G左右', '#fb923c', props.telemetry, props.duration, { min: G_MIN, max: G_MAX }),
  buildSeries(props.g, r => r.g_up_down, 'G上下', '#34d399', props.telemetry, props.duration, { min: G_MIN, max: G_MAX }),
  buildSeries(props.speedRpm, r => r.speed_kmh, '速度', '#22d3ee', props.telemetry, props.duration, { min: 0, max: speedMax.value }),
  buildSeries(props.speedRpm, r => (r.rpm / rpmMax.value) * speedMax.value, '回転数', '#f472b6', props.telemetry, props.duration, { min: 0, max: speedMax.value }),
])

// 左軸: G (-2G〜+2G を 1G 刻み)。右軸: 速度 (0〜speedMax を 4 分割)。
const gGridLines = computed<GridLine[]>(() =>
  [-2, -1, 0, 1, 2].map(v => ({
    y: scaleY(v, G_MIN, G_MAX),
    label: `${v > 0 ? '+' : ''}${v}G`,
    emphasize: v === 0,
  })),
)

const speedGridLines = computed<GridLine[]>(() => {
  const max = speedMax.value
  const step = max / 4
  return [0, 1, 2, 3, 4].map(i => ({
    y: scaleY(i * step, 0, max),
    label: `${Math.round(i * step)}`,
    emphasize: i === 0,
  }))
})

function toPolylinePoints(points: Point[]): string {
  return points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

const cursorX = computed(() =>
  props.duration > 0 ? PLOT_LEFT + (props.currentTime / props.duration) * (PLOT_RIGHT - PLOT_LEFT) : PLOT_LEFT,
)

function timeToPlotX(t: number): number {
  return props.duration > 0 ? PLOT_LEFT + (t / props.duration) * (PLOT_RIGHT - PLOT_LEFT) : PLOT_LEFT
}

const rangeStartX = computed(() => (props.rangeStart != null ? timeToPlotX(props.rangeStart) : null))
const rangeEndX = computed(() => (props.rangeEnd != null ? timeToPlotX(props.rangeEnd) : null))

const svgEl = ref<SVGSVGElement | null>(null)
const dragging = ref(false)

function seekFromEvent(e: MouseEvent) {
  if (!svgEl.value || props.duration <= 0) return
  const rect = svgEl.value.getBoundingClientRect()
  const plotLeftPx = (PLOT_LEFT / WIDTH) * rect.width
  const plotRightPx = (PLOT_RIGHT / WIDTH) * rect.width
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left - plotLeftPx) / (plotRightPx - plotLeftPx)))
  emit('seek', ratio * props.duration)
}

function onPointerDown(e: MouseEvent) {
  dragging.value = true
  seekFromEvent(e)
}
function onPointerMove(e: MouseEvent) {
  if (dragging.value) seekFromEvent(e)
}
function onPointerUp() {
  dragging.value = false
}

/**
 * 区間選択バー (グラフ下の細いトラック)。クロップ中でネイティブのシークバーが
 * 使えない時でも、ドラッグで区間の開始/終了を直接指定できるようにする。
 * 空いている場所をドラッグすると新規に区間を作り、既存の端 (ハンドル) を
 * つまむとその端だけを動かせる。
 */
const rangeTrackEl = ref<HTMLDivElement | null>(null)
const brushStartFrac = ref<number | null>(null)
const handleDragging = ref<'start' | 'end' | null>(null)

function fracFromEvent(e: MouseEvent): number | null {
  if (!rangeTrackEl.value) return null
  const r = rangeTrackEl.value.getBoundingClientRect()
  if (r.width <= 0) return null
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
}

/**
 * ドラッグ中は `window` でグローバルに `mousemove`/`mouseup` を監視する。
 * トラック要素 (高さ 16px の細いバー) に直接バインドすると、指が少し上下に
 * ぶれたりドラッグが速いだけでバー外に出て `mousemove`/`mouseup` が届かなく
 * なり、つまみ調整が「範囲外に出ると切れる」ため。
 */
function startGlobalDrag() {
  stopGlobalDrag() // 念のため多重登録を防ぐ (addEventListener 自体は同一関数なら冪等だが明示しておく)
  window.addEventListener('mousemove', onTrackPointerMove)
  window.addEventListener('mouseup', onTrackPointerUp)
  // alt-tab 等でウィンドウがフォーカスを失うと mouseup が届かずドラッグ状態が
  // 固着することがあるため、blur でも確実に終了させる
  window.addEventListener('blur', onTrackPointerUp)
}

function stopGlobalDrag() {
  window.removeEventListener('mousemove', onTrackPointerMove)
  window.removeEventListener('mouseup', onTrackPointerUp)
  window.removeEventListener('blur', onTrackPointerUp)
}

function beginHandleDrag(which: 'start' | 'end') {
  handleDragging.value = which
  startGlobalDrag()
}

function onTrackPointerDown(e: MouseEvent) {
  if (props.duration <= 0) return
  const frac = fracFromEvent(e)
  if (frac === null) return
  brushStartFrac.value = frac
  startGlobalDrag()
}

function onTrackPointerMove(e: MouseEvent) {
  if (props.duration <= 0) return
  const frac = fracFromEvent(e)
  if (frac === null) return
  const t = frac * props.duration

  if (handleDragging.value === 'start') {
    const end = props.rangeEnd ?? props.duration
    emit('update:rangeStart', Math.min(t, end))
    return
  }
  if (handleDragging.value === 'end') {
    const start = props.rangeStart ?? 0
    emit('update:rangeEnd', Math.max(t, start))
    return
  }
  if (brushStartFrac.value === null) return
  const t0 = Math.min(brushStartFrac.value, frac) * props.duration
  const t1 = Math.max(brushStartFrac.value, frac) * props.duration
  emit('update:rangeStart', t0)
  emit('update:rangeEnd', t1)
}

function onTrackPointerUp() {
  brushStartFrac.value = null
  handleDragging.value = null
  stopGlobalDrag()
}

onBeforeUnmount(stopGlobalDrag)

function clearRange() {
  emit('update:rangeStart', null)
  emit('update:rangeEnd', null)
}

const positionPct = computed(() => (props.duration > 0 ? (props.currentTime / props.duration) * 100 : 0))
const startPct = computed(() => (props.rangeStart != null && props.duration > 0 ? (props.rangeStart / props.duration) * 100 : 0))
const endPct = computed(() => (props.rangeEnd != null && props.duration > 0 ? (props.rangeEnd / props.duration) * 100 : 0))
const rangeShadeStyle = computed(() => ({
  left: `${startPct.value}%`,
  width: `${Math.max(0, endPct.value - startPct.value)}%`,
}))
</script>

<template>
  <div>
    <svg
      ref="svgEl"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      preserve-aspect-ratio="none"
      class="w-full h-64 cursor-crosshair select-none rounded-lg bg-gray-900"
      @mousedown="onPointerDown"
      @mousemove="onPointerMove"
      @mouseup="onPointerUp"
      @mouseleave="onPointerUp"
    >
      <!-- 左軸: G の補助線 (0G を強調) -->
      <g v-for="gl in gGridLines" :key="`g-${gl.label}`">
        <line
          :x1="PLOT_LEFT" :x2="PLOT_RIGHT" :y1="gl.y" :y2="gl.y"
          :stroke="gl.emphasize ? '#6b7280' : '#374151'"
          stroke-width="1" vector-effect="non-scaling-stroke"
        />
        <text :x="PLOT_LEFT - 4" :y="gl.y" text-anchor="end" dominant-baseline="middle" font-size="20" fill="#9ca3af">{{ gl.label }}</text>
      </g>
      <!-- 右軸: 速度 (km/h) の補助線 -->
      <text
        v-for="gl in speedGridLines" :key="`spd-${gl.label}`"
        :x="PLOT_RIGHT + 4" :y="gl.y" text-anchor="start" dominant-baseline="middle" font-size="20" fill="#9ca3af"
      >{{ gl.label }}</text>

      <!-- 選択区間 (開始/終了バーで指定した範囲) -->
      <rect
        v-if="rangeStartX !== null && rangeEndX !== null"
        :x="rangeStartX" y="0" :width="Math.max(0, rangeEndX - rangeStartX)" :height="HEIGHT"
        fill="#22c55e" fill-opacity="0.12"
      />
      <line
        v-if="rangeStartX !== null"
        :x1="rangeStartX" :x2="rangeStartX" y1="0" :y2="HEIGHT"
        stroke="#34d399" stroke-width="1.5" stroke-dasharray="2,2" vector-effect="non-scaling-stroke"
      />
      <line
        v-if="rangeEndX !== null"
        :x1="rangeEndX" :x2="rangeEndX" y1="0" :y2="HEIGHT"
        stroke="#fb7185" stroke-width="1.5" stroke-dasharray="2,2" vector-effect="non-scaling-stroke"
      />

      <polyline
        v-for="s in series"
        :key="s.label"
        :points="toPolylinePoints(s.points)"
        fill="none"
        :stroke="s.color"
        stroke-width="1.5"
        vector-effect="non-scaling-stroke"
      />
      <line
        :x1="cursorX" :x2="cursorX" y1="0" :y2="HEIGHT"
        stroke="white" stroke-width="1.5" stroke-dasharray="4,3"
      />
    </svg>
    <div class="flex flex-wrap gap-3 mt-1.5 text-[11px] text-gray-500">
      <span v-for="s in series" :key="s.label" class="flex items-center gap-1">
        <span class="inline-block w-3 h-0.5 rounded" :style="{ backgroundColor: s.color }" />
        {{ s.label }}
      </span>
    </div>

    <!-- 区間選択バー: ドラッグで開始/終了を指定、端をつまんで微調整 -->
    <div class="flex items-center justify-between text-[11px] text-gray-500 mt-2 mb-1">
      <span>区間選択 (ドラッグで範囲指定・端をつまんで調整)</span>
      <div class="flex items-center gap-2">
        <span v-if="rangeStart != null" class="text-emerald-400">開始 {{ fmtDuration(rangeStart) }}</span>
        <span v-if="rangeEnd != null" class="text-rose-400">終了 {{ fmtDuration(rangeEnd) }}</span>
        <UButton
          v-if="rangeStart != null || rangeEnd != null"
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-x"
          label="解除"
          @click="clearRange"
        />
      </div>
    </div>
    <div
      ref="rangeTrackEl"
      class="relative h-4 rounded bg-gray-800 cursor-pointer select-none"
      @mousedown="onTrackPointerDown"
    >
      <div
        v-if="rangeStart != null && rangeEnd != null"
        class="absolute inset-y-0 bg-emerald-500/30"
        :style="rangeShadeStyle"
      />
      <div class="absolute inset-y-0 w-0.5 bg-white/70 pointer-events-none" :style="{ left: `${positionPct}%` }" />
      <div
        v-if="rangeStart != null"
        class="absolute inset-y-0 w-1.5 -ml-[3px] bg-emerald-400 rounded cursor-ew-resize"
        :style="{ left: `${startPct}%` }"
        @mousedown.stop="beginHandleDrag('start')"
      />
      <div
        v-if="rangeEnd != null"
        class="absolute inset-y-0 w-1.5 -ml-[3px] bg-rose-400 rounded cursor-ew-resize"
        :style="{ left: `${endPct}%` }"
        @mousedown.stop="beginHandleDrag('end')"
      />
    </div>
  </div>
</template>
