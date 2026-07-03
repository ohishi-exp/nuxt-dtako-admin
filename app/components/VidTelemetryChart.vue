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

const WIDTH = 800
const HEIGHT = 160

interface Point { x: number, y: number }
interface Series { label: string, color: string, points: Point[] }

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

function buildSeries<T extends { ts: number, sub_us: number }>(
  records: T[],
  value: (r: T) => number,
  label: string,
  color: string,
  telemetry: Pick<VdfTelemetry, 'video_start_ts'>,
  duration: number,
): Series {
  const raw = records.map(r => ({ t: recordOffsetSeconds(r, telemetry), v: value(r) }))
  const { min, max } = minMax(raw.map(r => r.v))
  const dur = duration || 1
  return {
    label,
    color,
    points: raw.map(r => ({
      x: (r.t / dur) * WIDTH,
      y: HEIGHT - ((r.v - min) / (max - min)) * HEIGHT,
    })),
  }
}

const series = computed<Series[]>(() => [
  buildSeries(props.g, r => r.g_front_back, 'G前後', '#818cf8', props.telemetry, props.duration),
  buildSeries(props.g, r => r.g_left_right, 'G左右', '#fb923c', props.telemetry, props.duration),
  buildSeries(props.g, r => r.g_up_down, 'G上下', '#34d399', props.telemetry, props.duration),
  buildSeries(props.speedRpm, r => r.speed_kmh, '速度', '#22d3ee', props.telemetry, props.duration),
  buildSeries(props.speedRpm, r => r.rpm, '回転数', '#f472b6', props.telemetry, props.duration),
])

function toPolylinePoints(points: Point[]): string {
  return points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

const cursorX = computed(() => (props.duration > 0 ? (props.currentTime / props.duration) * WIDTH : 0))

const svgEl = ref<SVGSVGElement | null>(null)
const dragging = ref(false)

function seekFromEvent(e: MouseEvent) {
  if (!svgEl.value || props.duration <= 0) return
  const rect = svgEl.value.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
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
      class="w-full h-40 cursor-crosshair select-none rounded-lg bg-gray-900"
      @mousedown="onPointerDown"
      @mousemove="onPointerMove"
      @mouseup="onPointerUp"
      @mouseleave="onPointerUp"
    >
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
