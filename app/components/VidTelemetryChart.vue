<script setup lang="ts">
import type { GRecord, SpeedRpmRecord, VdfTelemetry } from '~/utils/dtako-vid-wasm'
import { recordOffsetSeconds } from '~/utils/dtako-vid-wasm'

const props = defineProps<{
  g: GRecord[]
  speedRpm: SpeedRpmRecord[]
  telemetry: Pick<VdfTelemetry, 'video_start_ts'>
  duration: number
  currentTime: number
}>()

const emit = defineEmits<{ seek: [seconds: number] }>()

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
  </div>
</template>
