<script setup lang="ts">
import { Loader } from '@googlemaps/js-api-loader'
import type { GpsRecord, VdfTelemetry } from '~/utils/dtako-vid-wasm'
import { recordOffsetSeconds } from '~/utils/dtako-vid-wasm'

const props = defineProps<{
  gps: GpsRecord[]
  telemetry: Pick<VdfTelemetry, 'video_start_ts'>
  currentTime: number
}>()

const config = useRuntimeConfig()
const mapEl = ref<HTMLDivElement | null>(null)
const loadError = ref<string | null>(null)

let map: google.maps.Map | null = null
let marker: google.maps.Marker | null = null

interface Point { t: number, lat: number, lng: number }

const points = computed<Point[]>(() =>
  props.gps
    .filter(g => g.fix === 'A')
    .map(g => ({ t: recordOffsetSeconds(g, props.telemetry), lat: g.lat, lng: g.lon })),
)

onMounted(async () => {
  if (!config.public.googlemapKey) {
    loadError.value = 'Google Maps API key が未設定です (NUXT_PUBLIC_GOOGLEMAP_KEY)'
    return
  }
  if (points.value.length === 0) {
    loadError.value = 'GPS データがありません'
    return
  }
  try {
    const loader = new Loader({ apiKey: config.public.googlemapKey, version: 'weekly' })
    const { Map } = await loader.importLibrary('maps')
    const { Marker } = await loader.importLibrary('marker')
    if (!mapEl.value) return
    const first = points.value[0]!
    map = new Map(mapEl.value, {
      center: { lat: first.lat, lng: first.lng },
      zoom: 16,
    })
    new google.maps.Polyline({
      path: points.value.map(p => ({ lat: p.lat, lng: p.lng })),
      strokeColor: '#3b82f6',
      strokeOpacity: 0.9,
      strokeWeight: 3,
      map,
    })
    marker = new Marker({ position: { lat: first.lat, lng: first.lng }, map })
  }
  catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
})

function interpolatedPosition(t: number): { lat: number, lng: number } | null {
  const pts = points.value
  if (pts.length === 0) return null
  const first = pts[0]!
  if (t <= first.t) return { lat: first.lat, lng: first.lng }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    if (t >= a.t && t <= b.t) {
      const ratio = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)
      return { lat: a.lat + (b.lat - a.lat) * ratio, lng: a.lng + (b.lng - a.lng) * ratio }
    }
  }
  const last = pts[pts.length - 1]!
  return { lat: last.lat, lng: last.lng }
}

watch(() => props.currentTime, (t) => {
  if (!marker || !map) return
  const pos = interpolatedPosition(t)
  if (!pos) return
  marker.setPosition(pos)
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
