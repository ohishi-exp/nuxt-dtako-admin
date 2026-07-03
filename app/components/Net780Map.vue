<script setup lang="ts">
import { Loader } from '@googlemaps/js-api-loader'
import type { Net780GpsPoint } from '~/utils/net780'

const props = defineProps<{
  gps: Net780GpsPoint[]
  /** 現在位置 (UNIX epoch 秒、net780 の ts と同じ単位)。 */
  currentTime: number
}>()

const mapEl = ref<HTMLDivElement | null>(null)
const loadError = ref<string | null>(null)

let map: google.maps.Map | null = null
let marker: google.maps.marker.AdvancedMarkerElement | null = null

const points = computed(() => props.gps)

onMounted(async () => {
  if (points.value.length === 0) {
    loadError.value = 'GPS データがありません'
    return
  }
  try {
    // GOOGLEMAP_KEY_SECRET は Cloudflare Secrets Store binding (文字列ではない) なので
    // public runtimeConfig には載せず、server route 経由で解決した文字列を取得する
    // (vid-check ページと同じ endpoint を共用する)。
    const { key } = await $fetch('/api/vid-check/map-key')
    if (!key) {
      loadError.value = 'Google Maps API key が未設定です (GOOGLEMAP_KEY_SECRET)'
      return
    }
    const loader = new Loader({ apiKey: key, version: 'weekly' })
    const { Map } = await loader.importLibrary('maps')
    const { AdvancedMarkerElement } = await loader.importLibrary('marker')
    if (!mapEl.value) return
    const first = points.value[0]!
    map = new Map(mapEl.value, {
      center: { lat: first.lat, lng: first.lon },
      zoom: 14,
      // AdvancedMarkerElement は有効な mapId を要求する。専用 Map スタイルは
      // 不要なので Google 提供の DEMO_MAP_ID (Cloud Console 登録不要) を使う。
      mapId: 'DEMO_MAP_ID',
    })
    const bounds = new google.maps.LatLngBounds()
    for (const p of points.value) bounds.extend({ lat: p.lat, lng: p.lon })
    map.fitBounds(bounds)
    new google.maps.Polyline({
      path: points.value.map(p => ({ lat: p.lat, lng: p.lon })),
      strokeColor: '#3b82f6',
      strokeOpacity: 0.9,
      strokeWeight: 3,
      map,
    })
    marker = new AdvancedMarkerElement({ position: { lat: first.lat, lng: first.lon }, map })
  }
  catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
})

/** currentTime (epoch 秒) に最も近い前後の GPS 点から位置を線形補間する。 */
function interpolatedPosition(t: number): { lat: number, lng: number } | null {
  const pts = points.value
  if (pts.length === 0) return null
  const first = pts[0]!
  if (t <= first.ts) return { lat: first.lat, lng: first.lon }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    if (t >= a.ts && t <= b.ts) {
      const ratio = b.ts === a.ts ? 0 : (t - a.ts) / (b.ts - a.ts)
      return { lat: a.lat + (b.lat - a.lat) * ratio, lng: a.lon + (b.lon - a.lon) * ratio }
    }
  }
  const last = pts[pts.length - 1]!
  return { lat: last.lat, lng: last.lon }
}

watch(() => props.currentTime, (t) => {
  if (!marker || !map) return
  const pos = interpolatedPosition(t)
  if (!pos) return
  marker.position = pos
  map.panTo(pos)
})
</script>

<template>
  <div class="relative w-full h-64 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
    <div ref="mapEl" class="w-full h-full" />
    <p v-if="loadError" class="absolute inset-0 flex items-center justify-center text-sm text-gray-400 px-4 text-center">
      {{ loadError }}
    </p>
  </div>
</template>
