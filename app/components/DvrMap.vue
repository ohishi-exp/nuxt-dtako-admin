<script setup lang="ts">
/**
 * 車輌現在地 (マーカー群) / 動態履歴 (軌跡ポリライン) 用の Google Map。
 * VidMap / Net780Map と同じパターン (js-api-loader + /api/vid-check/map-key +
 * DEMO_MAP_ID) で、props の変化に追従して描き直す。
 */
import { Loader } from '@googlemaps/js-api-loader'

export interface DvrMapMarker {
  lat: number
  lng: number
  /** マーカー横に常時表示する短いラベル (車番等)。 */
  label?: string
  /** hover 時の title。 */
  title?: string
}

const props = defineProps<{
  markers: DvrMapMarker[]
  /** 軌跡 (動態履歴)。指定時はポリライン + 始点/終点マーカーを描く。 */
  track?: Array<{ lat: number, lng: number }>
  /** 選択中マーカーの index (地図中心を移す)。 */
  selectedIndex?: number | null
  /** 選択中の地点 (行選択に連動する赤ピン)。null で消す。 */
  current?: { lat: number, lng: number } | null
}>()

const mapEl = ref<HTMLDivElement | null>(null)
const loadError = ref<string | null>(null)

let map: google.maps.Map | null = null
let markerLib: google.maps.MarkerLibrary | null = null
let markerObjs: google.maps.marker.AdvancedMarkerElement[] = []
let trackLine: google.maps.Polyline | null = null
let currentMarker: google.maps.marker.AdvancedMarkerElement | null = null

function clearOverlays() {
  for (const m of markerObjs) m.map = null
  markerObjs = []
  if (trackLine) {
    trackLine.setMap(null)
    trackLine = null
  }
  if (currentMarker) {
    currentMarker.map = null
    currentMarker = null
  }
}

/** 選択地点の赤ピンを更新し、そこへ地図をパンする (行選択 / ↑↓キー連動)。 */
function updateCurrentMarker() {
  if (!map || !markerLib) return
  const cur = props.current
  if (!cur) {
    if (currentMarker) {
      currentMarker.map = null
      currentMarker = null
    }
    return
  }
  const pos = { lat: cur.lat, lng: cur.lng }
  if (!currentMarker) {
    const pin = new markerLib.PinElement({
      background: '#dc2626',
      borderColor: '#7f1d1d',
      glyphColor: '#fff',
    })
    currentMarker = new markerLib.AdvancedMarkerElement({
      position: pos,
      map,
      content: pin.element,
      zIndex: 1000,
    })
  }
  else {
    currentMarker.position = pos
  }
  map.panTo(pos)
}

function markerContent(label: string | undefined): HTMLElement | undefined {
  if (!label) return undefined
  const div = document.createElement('div')
  div.textContent = label
  div.style.cssText
    = 'background:#1d4ed8;color:#fff;font-size:11px;padding:2px 6px;border-radius:9999px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4)'
  return div
}

function redraw() {
  if (!map || !markerLib) return
  clearOverlays()

  const bounds = new google.maps.LatLngBounds()
  let hasAny = false

  for (const m of props.markers) {
    const pos = { lat: m.lat, lng: m.lng }
    markerObjs.push(new markerLib.AdvancedMarkerElement({
      position: pos,
      map,
      title: m.title,
      content: markerContent(m.label),
    }))
    bounds.extend(pos)
    hasAny = true
  }

  const track = props.track ?? []
  if (track.length > 0) {
    trackLine = new google.maps.Polyline({
      path: track,
      strokeColor: '#3b82f6',
      strokeOpacity: 0.9,
      strokeWeight: 3,
      map,
    })
    for (const p of track) bounds.extend(p)
    hasAny = true
  }

  if (hasAny) {
    map.fitBounds(bounds)
    // 単一点で異常にズームインしないよう上限を掛ける
    const listener = google.maps.event.addListenerOnce(map, 'bounds_changed', () => {
      if (map && (map.getZoom() ?? 0) > 16) map.setZoom(16)
    })
    void listener
  }

  // clearOverlays で消えた選択ピンを描き直す
  updateCurrentMarker()
}

watch(() => [props.markers, props.track], redraw, { deep: true })

watch(() => props.current, updateCurrentMarker)

watch(() => props.selectedIndex, (idx) => {
  if (map && idx != null && props.markers[idx]) {
    map.panTo({ lat: props.markers[idx].lat, lng: props.markers[idx].lng })
  }
})

onMounted(async () => {
  try {
    // GOOGLEMAP_KEY_SECRET は Cloudflare Secrets Store binding なので server route
    // 経由で解決した文字列を取得する (vid-check / net780 と同じ endpoint を共用)。
    const { key } = await $fetch('/api/vid-check/map-key')
    if (!key) {
      loadError.value = 'Google Maps API key が未設定です (GOOGLEMAP_KEY_SECRET)'
      return
    }
    const loader = new Loader({ apiKey: key, version: 'weekly' })
    const { Map } = await loader.importLibrary('maps')
    markerLib = await loader.importLibrary('marker')
    if (!mapEl.value) return
    map = new Map(mapEl.value, {
      center: { lat: 35.0, lng: 135.0 },
      zoom: 5,
      // AdvancedMarkerElement は有効な mapId を要求する (DEMO_MAP_ID で登録不要)。
      mapId: 'DEMO_MAP_ID',
    })
    redraw()
    updateCurrentMarker()
  }
  catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
})

onBeforeUnmount(clearOverlays)
</script>

<template>
  <div class="relative">
    <div ref="mapEl" class="w-full h-[480px] rounded-lg bg-gray-100 dark:bg-gray-800" />
    <p v-if="loadError" class="absolute inset-0 flex items-center justify-center text-sm text-red-600">
      {{ loadError }}
    </p>
  </div>
</template>
