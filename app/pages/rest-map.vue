<script setup lang="ts">
// トラック休憩ポイントマップ (Refs #198 Phase 1)
//
// /api/poi/kyushu (R2 配信) の正規化 GeoJSON を Google Maps に表示する。
// データは scripts/poi/build-poi.ts の月次バッチが生成 (README 参照)。
import { Loader } from '@googlemaps/js-api-loader'
import type { PoiCollection, PoiFeature, PoiKind } from '~/utils/poi'
import {
  ALL_POI_KINDS,
  POI_KIND_COLORS,
  POI_KIND_LABELS,
  filterPoisByKind,
  poiBadges,
  poiLocation,
  poiTitle,
} from '~/utils/poi'

const REGION = 'kyushu'

const mapEl = ref<HTMLDivElement | null>(null)
const loadError = ref<string | null>(null)
const loading = ref(true)
const collection = ref<PoiCollection | null>(null)
const selected = ref<PoiFeature | null>(null)
const enabledKinds = ref<Set<PoiKind>>(new Set(ALL_POI_KINDS))

let map: google.maps.Map | null = null
let AdvancedMarker: typeof google.maps.marker.AdvancedMarkerElement | null = null
let markers: google.maps.marker.AdvancedMarkerElement[] = []

const visibleFeatures = computed<PoiFeature[]>(() =>
  collection.value ? filterPoisByKind(collection.value.features, enabledKinds.value) : [],
)

const kindCounts = computed<Record<string, number>>(() => collection.value?.metadata.counts ?? {})

function toggleKind(kind: PoiKind) {
  const next = new Set(enabledKinds.value)
  if (next.has(kind)) next.delete(kind)
  else next.add(kind)
  enabledKinds.value = next
}

function markerElement(kind: PoiKind): HTMLDivElement {
  const el = document.createElement('div')
  el.style.width = '14px'
  el.style.height = '14px'
  el.style.borderRadius = '9999px'
  el.style.border = '2px solid white'
  el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.5)'
  el.style.backgroundColor = POI_KIND_COLORS[kind]
  return el
}

function renderMarkers() {
  if (!map || !AdvancedMarker) return
  for (const m of markers) m.map = null
  markers = []
  for (const f of visibleFeatures.value) {
    const [lng, lat] = f.geometry.coordinates
    const marker = new AdvancedMarker({
      position: { lat, lng },
      map,
      title: poiTitle(f.properties),
      content: markerElement(f.properties.kind),
    })
    marker.addListener('click', () => {
      selected.value = f
    })
    markers.push(marker)
  }
}

watch(visibleFeatures, () => renderMarkers())

onMounted(async () => {
  try {
    collection.value = await $fetch<PoiCollection>(`/api/poi/${REGION}`)
  }
  catch (e: unknown) {
    const status = (e as { statusCode?: number }).statusCode
    loadError.value = status === 404
      ? 'POI データが未配置です (scripts/poi/README.md の手順で poi/kyushu.geojson を R2 に配置してください)'
      : `POI データの取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`
    loading.value = false
    return
  }

  try {
    // GOOGLEMAP_KEY_SECRET は Secrets Store binding なので server route 経由で解決 (VidMap と同じ)
    const { key } = await $fetch('/api/vid-check/map-key')
    if (!key) {
      loadError.value = 'Google Maps API key が未設定です (GOOGLEMAP_KEY_SECRET)'
      return
    }
    const loader = new Loader({ apiKey: key, version: 'weekly' })
    const { Map } = await loader.importLibrary('maps')
    const { AdvancedMarkerElement } = await loader.importLibrary('marker')
    AdvancedMarker = AdvancedMarkerElement
    if (!mapEl.value) return
    map = new Map(mapEl.value, {
      center: { lat: 33.0, lng: 130.9 }, // 九州中央付近
      zoom: 8,
      // AdvancedMarkerElement は mapId 必須 (VidMap と同じ DEMO_MAP_ID)
      mapId: 'DEMO_MAP_ID',
    })
    renderMarkers()
  }
  catch (e: unknown) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold">
        休憩ポイントマップ (九州)
      </h1>
    </div>

    <!-- kind フィルタ + 凡例 -->
    <div class="flex flex-wrap gap-2">
      <button
        v-for="kind in ALL_POI_KINDS"
        :key="kind"
        type="button"
        class="flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm transition-colors"
        :class="enabledKinds.has(kind)
          ? 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800'
          : 'border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-900 opacity-50'"
        @click="toggleKind(kind)"
      >
        <span
          class="inline-block size-3 rounded-full"
          :style="{ backgroundColor: POI_KIND_COLORS[kind] }"
        />
        {{ POI_KIND_LABELS[kind] }}
        <span v-if="kindCounts[kind]" class="text-gray-400">{{ kindCounts[kind] }}</span>
      </button>
    </div>

    <div class="flex gap-4">
      <!-- 地図 -->
      <div class="relative flex-1 h-[70vh] rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-800">
        <div ref="mapEl" class="w-full h-full" />
        <p
          v-if="loadError"
          class="absolute inset-0 flex items-center justify-center text-sm text-gray-500 px-6 text-center"
        >
          {{ loadError }}
        </p>
        <p
          v-else-if="loading"
          class="absolute inset-0 flex items-center justify-center text-sm text-gray-400"
        >
          読み込み中…
        </p>
      </div>

      <!-- 詳細パネル -->
      <aside
        v-if="selected"
        class="w-72 shrink-0 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3 h-fit"
      >
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="text-xs text-gray-500">
              {{ POI_KIND_LABELS[selected.properties.kind] }}
            </p>
            <h2 class="font-bold">
              {{ poiTitle(selected.properties) }}
            </h2>
            <p v-if="poiLocation(selected.properties)" class="text-sm text-gray-500">
              {{ poiLocation(selected.properties) }}
            </p>
          </div>
          <button
            type="button"
            class="text-gray-400 hover:text-gray-600"
            aria-label="閉じる"
            @click="selected = null"
          >
            <UIcon name="i-lucide-x" class="size-4" />
          </button>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="badge in poiBadges(selected.properties)"
            :key="badge.label"
            class="px-2 py-0.5 rounded text-xs"
            :class="badge.value
              ? 'bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-400 line-through'"
          >
            {{ badge.label }}
          </span>
        </div>
        <p class="text-xs text-gray-400">
          id: {{ selected.properties.id }}
        </p>
      </aside>
    </div>

    <!-- 帰属表示 (ODbL / 国土数値情報 — 必須。消さないこと) -->
    <p v-if="collection" class="text-xs text-gray-400">
      {{ collection.metadata.attribution.join(' / ') }}
      — 生成: {{ collection.metadata.generatedAt.slice(0, 10) }}
    </p>
  </div>
</template>
