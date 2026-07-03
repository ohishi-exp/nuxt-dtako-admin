<script setup lang="ts">
/**
 * 動態履歴の速度チャート (net780.vue の暦日速度チャートと同じ操作感)。
 *
 * - x 軸はデータの時刻範囲 (複数日レンジ対応)、y 軸は速度
 * - 点間隔が空く区間 (通信断/停車) は polyline を分割して誤った直線補間を避ける
 * - クリック/ドラッグでシーク → 最寄り点の ts を `seek` で emit (親が行選択 +
 *   地図ピンに反映する)
 * - `currentTs` (選択中の行の時刻) にカーソル線を描く
 */
export interface DvrSpeedPoint {
  /** naive epoch 秒 (theearth サーバーローカル時刻をそのまま epoch にした値)。 */
  ts: number
  /** km/h。 */
  speed: number
}

const props = defineProps<{
  points: DvrSpeedPoint[]
  currentTs?: number | null
}>()

const emit = defineEmits<{
  seek: [ts: number]
  /** ←→キーでの前後移動 (親が行選択を 1 つ動かす)。 */
  step: [delta: number]
}>()

const CHART_WIDTH = 800
const CHART_HEIGHT = 160
const PADDING = 8
/** この秒数を超える点間隔は空白期間とみなして折れ線を分割する (点は通常 1〜2 分間隔)。 */
const GAP_SECS = 20 * 60

const range = computed(() => {
  if (props.points.length === 0) return null
  let min = Infinity
  let max = -Infinity
  for (const p of props.points) {
    if (p.ts < min) min = p.ts
    if (p.ts > max) max = p.ts
  }
  return { min, max, span: Math.max(1, max - min) }
})

const maxSpeed = computed(() => Math.max(1, ...props.points.map(p => p.speed)))

const innerW = CHART_WIDTH - PADDING * 2
const innerH = CHART_HEIGHT - PADDING * 2

function xFor(ts: number): number {
  const r = range.value!
  return PADDING + ((ts - r.min) / r.span) * innerW
}

const segments = computed(() => {
  const r = range.value
  if (!r) return []
  const segs: string[] = []
  let current: string[] = []
  let prevTs: number | null = null
  for (const p of props.points) {
    if (prevTs !== null && p.ts - prevTs > GAP_SECS) {
      if (current.length >= 2) segs.push(current.join(' '))
      current = []
    }
    const x = xFor(p.ts)
    const y = PADDING + innerH - (p.speed / maxSpeed.value) * innerH
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    prevTs = p.ts
  }
  if (current.length >= 2) segs.push(current.join(' '))
  return segs
})

/** naive epoch 秒を表示用文字列に (TZ シフトせず UTC getter で読む)。 */
function formatTs(ts: number, withDate: boolean): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return withDate ? `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${hm}` : hm
}

const ticks = computed(() => {
  const r = range.value
  if (!r) return []
  const withDate = r.span > 24 * 60 * 60
  const n = 5
  return Array.from({ length: n }, (_, i) => formatTs(r.min + (r.span * i) / (n - 1), withDate))
})

const cursorX = computed(() => {
  const r = range.value
  const t = props.currentTs
  if (!r || t == null) return null
  if (t < r.min || t > r.max) return null
  return xFor(t)
})

const svgEl = ref<SVGSVGElement | null>(null)
const seeking = ref(false)

function seekFromEvent(e: MouseEvent) {
  const r = range.value
  const svg = svgEl.value
  if (!r || !svg) return
  const rect = svg.getBoundingClientRect()
  if (rect.width <= 0) return
  const ratio = (e.clientX - rect.left) / rect.width
  const innerRatio = Math.min(1, Math.max(0, (ratio * CHART_WIDTH - PADDING) / innerW))
  emit('seek', r.min + innerRatio * r.span)
}

function onPointerDown(e: MouseEvent) {
  seeking.value = true
  svgEl.value?.focus() // 以降 ←→ キーで前後移動できるようにする
  seekFromEvent(e)
}
function onPointerMove(e: MouseEvent) {
  if (seeking.value) seekFromEvent(e)
}
function onPointerUp() {
  seeking.value = false
}
</script>

<template>
  <div v-if="segments.length > 0">
    <p class="text-xs text-gray-500 mb-1">
      速度 (クリック/ドラッグでシーク、←→キーで前後移動 — 一覧と地図のピンが連動) / 最高 {{ Math.round(maxSpeed) }} km/h
    </p>
    <svg
      ref="svgEl"
      tabindex="0"
      :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
      class="w-full h-40 cursor-crosshair select-none bg-gray-50 dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-800 outline-none focus:ring-2 focus:ring-blue-400"
      preserveAspectRatio="none"
      @mousedown="onPointerDown"
      @mousemove="onPointerMove"
      @mouseup="onPointerUp"
      @mouseleave="onPointerUp"
      @keydown.left.prevent="emit('step', -1)"
      @keydown.right.prevent="emit('step', 1)"
    >
      <polyline
        v-for="(seg, i) in segments"
        :key="i"
        :points="seg"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        class="text-blue-500"
      />
      <line
        v-if="cursorX !== null"
        :x1="cursorX" :x2="cursorX" y1="0" :y2="CHART_HEIGHT"
        stroke="currentColor" stroke-width="1.5" stroke-dasharray="4,3"
        class="text-red-400"
      />
    </svg>
    <div class="flex justify-between text-[10px] text-gray-400 px-1">
      <span v-for="(t, i) in ticks" :key="i">{{ t }}</span>
    </div>
  </div>
</template>
