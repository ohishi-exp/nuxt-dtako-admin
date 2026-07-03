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
  /** マーカー横に常時表示する短いラベル (車番等)。lines 指定時は無視。 */
  label?: string
  /** 複数行ラベル (車番 / 乗務員 / 日時 等)。指定時は label より優先。 */
  lines?: string[]
  /** 進行方向 (度・北 0 時計回り)。指定時は方向を向いた矢印を描く。 */
  direction?: number | null
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

/** 方向を向いた青い矢印 (△) の SVG。direction 度 (北 0 時計回り) だけ回転する。 */
function arrowEl(direction: number): HTMLElement {
  const wrap = document.createElement('div')
  wrap.style.cssText = `transform:rotate(${direction}deg);line-height:0;`
  wrap.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22">'
    + '<path d="M11 1 L18 19 L11 15 L4 19 Z" fill="#1d4ed8" stroke="#fff" stroke-width="1"/></svg>'
  return wrap
}

/** 停車中 (方向不定) の車輌を表す中立マーカー (灰色の丸)。 */
function dotEl(): HTMLElement {
  const d = document.createElement('div')
  d.style.cssText = 'width:12px;height:12px;border-radius:9999px;background:#64748b;'
    + 'border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.4);'
  return d
}

/** 白背景・青枠の複数行ラベル。 */
function labelBox(lines: string[]): HTMLElement {
  const box = document.createElement('div')
  box.style.cssText = 'background:#fff;border:1px solid #1d4ed8;border-radius:4px;'
    + 'padding:1px 5px;font-size:10px;line-height:1.35;white-space:nowrap;'
    + 'box-shadow:0 1px 2px rgba(0,0,0,.35);text-align:center;color:#1e293b;'
  for (const line of lines) {
    const row = document.createElement('div')
    row.textContent = line
    box.appendChild(row)
  }
  return box
}

/** 従来の青 pill 単行ラベル (軌跡の始点/終点用)。 */
function pillEl(label: string): HTMLElement {
  const div = document.createElement('div')
  div.textContent = label
  div.style.cssText = 'background:#1d4ed8;color:#fff;font-size:11px;padding:2px 6px;'
    + 'border-radius:9999px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4);'
  return div
}

function markerContent(m: DvrMapMarker): HTMLElement | undefined {
  const lines = m.lines?.filter(Boolean) ?? []

  // 現在地マーカー: アイコン (走行中=方向矢印 / 停車中=丸) を常時表示し、
  // 3 行ラベルは初期非表示 → アイコンクリックで開閉する。
  if (lines.length > 0) {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:1px;cursor:pointer;'
    wrap.appendChild(typeof m.direction === 'number' ? arrowEl(m.direction) : dotEl())
    const box = labelBox(lines)
    box.style.display = 'none'
    wrap.addEventListener('click', (e) => {
      e.stopPropagation()
      box.style.display = box.style.display === 'none' ? '' : 'none'
    })
    wrap.appendChild(box)
    return wrap
  }

  // 軌跡の始点/終点: 従来どおり青 pill を常時表示。
  if (m.label) return pillEl(m.label)
  if (typeof m.direction === 'number') return arrowEl(m.direction)
  return undefined
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
      content: markerContent(m),
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
