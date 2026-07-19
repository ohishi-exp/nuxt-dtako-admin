<script setup lang="ts">
/**
 * `/operations/[unko_no]` の「イベント」タブ: 行選択 (複数可) → 画面右下に
 * フローティング表示する速度カラー Google Map。`Net780Map.vue` と同じローダ方式
 * (@googlemaps/js-api-loader、`/api/vid-check/map-key`、`DEMO_MAP_ID`) を踏襲するが、
 * 単色 polyline ではなく `buildSpeedColoredSegments` が算出した区間ごとの色で
 * 複数の Polyline を描画する (Google Maps の Polyline は頂点ごとのグラデーションを
 * 持てないため、隣接2点ずつのセグメントに分けて色分けする定番手法)。
 *
 * データ変換 (GPSフィルタ・時刻レンジ絞り込み・速度カラー算出) は全て呼び出し側
 * (`app/pages/operations/[unko_no].vue`) が utils で行い、このコンポーネントは
 * 地図描画に専念する (dumb component、Google Maps 描画コンポーネントは他と同様
 * unit test 対象外のため、ロジックを持ち込まないことでテスト可能な範囲を保つ)。
 */
import { Loader } from '@googlemaps/js-api-loader'
import { formatNet780Ts } from '~/utils/net780'
import type { SpeedColoredSegment } from '~/utils/net780'
import type { Net780DataStatus } from '~/composables/useNet780OperationData'

const props = defineProps<{
  status: Net780DataStatus
  errorMessage?: string | null
  /** status==='not-found' 時、/net780 検索への導線。 */
  net780SearchLink?: string
  segments: SpeedColoredSegment[]
  range: { fromTs: number, toTs: number } | null
}>()

const emit = defineEmits<{ close: [] }>()

const mapEl = ref<HTMLDivElement | null>(null)
const loadError = ref<string | null>(null)

let map: google.maps.Map | null = null
let markerLib: google.maps.MarkerLibrary | null = null
let polylines: google.maps.Polyline[] = []
let markers: google.maps.marker.AdvancedMarkerElement[] = []

async function ensureMap(): Promise<google.maps.Map | null> {
  if (map) return map
  try {
    // GOOGLEMAP_KEY_SECRET は Cloudflare Secrets Store binding なので server route
    // 経由で解決した文字列を取得する (vid-check / net780 と同じ endpoint を共用)。
    const { key } = await $fetch('/api/vid-check/map-key')
    if (!key) {
      loadError.value = 'Google Maps API key が未設定です (GOOGLEMAP_KEY_SECRET)'
      return null
    }
    const loader = new Loader({ apiKey: key, version: 'weekly' })
    const { Map } = await loader.importLibrary('maps')
    markerLib = await loader.importLibrary('marker')
    if (!mapEl.value) return null
    map = new Map(mapEl.value, {
      center: { lat: 35.0, lng: 135.0 },
      zoom: 5,
      // AdvancedMarkerElement は有効な mapId を要求する (DEMO_MAP_ID で登録不要)。
      mapId: 'DEMO_MAP_ID',
    })
    return map
  }
  catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
    return null
  }
}

function clearOverlays() {
  for (const line of polylines) line.setMap(null)
  polylines = []
  for (const m of markers) m.map = null
  markers = []
}

async function redraw() {
  const m = await ensureMap()
  if (!m || !markerLib) return
  clearOverlays()

  const segs = props.segments
  if (segs.length === 0) return

  const bounds = new google.maps.LatLngBounds()
  for (const seg of segs) {
    const path = [
      { lat: seg.from.lat, lng: seg.from.lon },
      { lat: seg.to.lat, lng: seg.to.lon },
    ]
    polylines.push(new google.maps.Polyline({
      path,
      strokeColor: seg.color,
      strokeOpacity: 0.9,
      strokeWeight: 4,
      map: m,
    }))
    bounds.extend(path[0]!)
    bounds.extend(path[1]!)
  }

  const first = segs[0]!.from
  const last = segs[segs.length - 1]!.to
  markers.push(new markerLib.AdvancedMarkerElement({
    position: { lat: first.lat, lng: first.lon },
    map: m,
    title: '開始',
  }))
  markers.push(new markerLib.AdvancedMarkerElement({
    position: { lat: last.lat, lng: last.lon },
    map: m,
    title: '終了',
  }))

  m.fitBounds(bounds)
  const listener = google.maps.event.addListenerOnce(m, 'bounds_changed', () => {
    if (m && (m.getZoom() ?? 0) > 17) m.setZoom(17)
  })
  void listener
}

watch(() => props.segments, redraw, { deep: true })

watch(() => props.status, (s) => {
  if (s === 'ready') redraw()
})

onMounted(() => {
  if (props.status === 'ready') redraw()
})

onBeforeUnmount(clearOverlays)

type OverlayKind = 'loading' | 'not-found' | 'error' | 'map-error' | 'empty' | null

const overlayKind = computed<OverlayKind>(() => {
  if (props.status === 'idle' || props.status === 'loading') return 'loading'
  if (props.status === 'not-found') return 'not-found'
  if (props.status === 'error') return 'error'
  if (loadError.value) return 'map-error'
  if (props.segments.length === 0) return 'empty'
  return null
})
</script>

<template>
  <div class="fixed bottom-4 right-4 z-40 w-[420px] max-w-[calc(100vw-2rem)] rounded-lg shadow-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-hidden">
    <div class="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
      <span class="text-xs font-medium text-gray-600 dark:text-gray-300">
        <template v-if="range">{{ formatNet780Ts(range.fromTs) }} 〜 {{ formatNet780Ts(range.toTs) }}</template>
      </span>
      <button class="text-gray-400 hover:text-gray-600" @click="emit('close')">
        <UIcon name="i-lucide-x" class="size-4" />
      </button>
    </div>

    <div class="relative w-full h-64 bg-gray-100 dark:bg-gray-800">
      <div ref="mapEl" class="w-full h-full" />
      <div
        v-if="overlayKind"
        class="absolute inset-0 flex items-center justify-center text-sm px-4 text-center bg-white/90 dark:bg-gray-900/90"
      >
        <div class="space-y-2 text-gray-500">
          <p v-if="overlayKind === 'loading'" class="flex items-center gap-2 justify-center">
            <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />
            NET780 データを取得中...
          </p>
          <template v-else-if="overlayKind === 'not-found'">
            <p>この運行の NET780 生データはまだダウンロード・アーカイブされていません。</p>
            <NuxtLink v-if="net780SearchLink" :to="net780SearchLink" class="text-blue-600 dark:text-blue-400 hover:underline">
              NET780 一括ダウンロードで検索する →
            </NuxtLink>
          </template>
          <p v-else-if="overlayKind === 'error'" class="text-red-600 dark:text-red-400">
            {{ errorMessage ?? 'NET780 データの取得に失敗しました' }}
          </p>
          <p v-else-if="overlayKind === 'map-error'" class="text-red-600 dark:text-red-400">
            {{ loadError }}
          </p>
          <p v-else-if="overlayKind === 'empty'">
            選択範囲に GPS 点がありません (通信断・圏外の可能性があります)
          </p>
        </div>
      </div>
    </div>

    <div
      v-if="status === 'ready' && segments.length > 0"
      class="flex items-center gap-3 px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-100 dark:border-gray-800"
    >
      <span class="flex items-center gap-1">
        <span class="inline-block w-3 h-1.5 rounded" style="background: hsl(120, 85%, 45%)" />低速
      </span>
      <span class="flex items-center gap-1">
        <span class="inline-block w-3 h-1.5 rounded" style="background: hsl(60, 85%, 45%)" />中速
      </span>
      <span class="flex items-center gap-1">
        <span class="inline-block w-3 h-1.5 rounded" style="background: hsl(0, 85%, 45%)" />高速
      </span>
    </div>
  </div>
</template>
