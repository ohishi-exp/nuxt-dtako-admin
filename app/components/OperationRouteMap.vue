<script setup lang="ts">
/**
 * 粗利タブの運行行「地図」: 1 運行の経路を便ごとに色分けして Google Map に描くモーダル
 * (Refs #760 の 18)。
 *
 * `EventSpeedMapPanel.vue` と同じローダ方式 (@googlemaps/js-api-loader、
 * `/api/vid-check/map-key`、`DEMO_MAP_ID`) を踏襲し、`buildOperationRoute` が出した
 * `segments` を kind 別の色で Polyline に、`markers` を `AdvancedMarkerElement` に置く。
 * 開閉は `AllowanceOperationModal.vue` と同じ (呼び出し側の `v-if` で出し入れ、
 * Esc / 背景クリック / ✕ で `close`)。
 *
 * 描く層は `layers` で絞る (Refs #760 の 25。既定は軌跡 + マーカーだけで、イベント線
 * (始点→終点の直線) は凡例のチェックで出す)。絞り込みは `filterRouteByLayers` (pure)。
 *
 * データ変換 (GPS の換算・便の切り方) はぜんぶ `app/utils/operation-route-map.ts` (pure、
 * カバレッジ gate 対象) が持ち、このコンポーネントは描画に専念する (dumb component、
 * Google Maps 描画コンポーネントは他と同様 unit test 対象外)。
 */
import { Loader } from '@googlemaps/js-api-loader'
import { filterRouteByLayers, type OperationRoute, type RouteMarker, type RouteSegment, type RouteMapLayers } from '~/utils/operation-route-map'

const props = defineProps<{
  /** 描く経路。まだ無ければ null (読み込み中 / 失敗)。 */
  route: OperationRoute | null
  /** 見出し (例: `運行 2026-07-01 中村 車輌 1109 — 便 4 本`)。 */
  title: string
  loading: boolean
  /** イベントCSV が引けなかった理由。引けていれば null。 */
  error: string | null
  /**
   * 軌跡の内訳 (例 `NET780 軌跡: 2 運行ぶん / イベント軌跡: 5 運行ぶん`)。まだ引いていなければ null。
   * 見出しの横に出すだけ (Refs #760 の 21・24)。
   */
  trackNote?: string | null
  /**
   * どの層を描くか (Refs #760 の 25)。凡例の各行がチェックボックス兼用で、切り替えは
   * `update:layers` で親に返す (保存 (localStorage) は親の仕事)。
   */
  layers: RouteMapLayers
  /**
   * NET780 のアーカイブが無かった運行の数 (Refs #760 の 27)。0 (または未指定) なら
   * 「NET780 を取得」ボタンを出さない。取得そのもの (relay へ 20 件ずつ投げる・
   * 終わったら地図を開き直す) は呼び出し側 (`margin.vue`) が持つ。
   */
  net780MissingCount?: number
  /**
   * NET780 取得の進捗 / 結果 (例 `NET780 取得中 20/32` → `NET780 取得: archived 3 / already 0 /
   * not_found 29 / error 0`)。見出しの横に出すだけ。走っていなければ null。
   */
  net780ArchiveProgress?: string | null
  /** NET780 取得が走っている間 true (ボタンを押せなくする)。 */
  net780Archiving?: boolean
}>()

const emit = defineEmits<{
  'close': []
  'update:layers': [layers: RouteMapLayers]
  /** 見出しの「NET780 を取得 (未取得 N 運行)」(Refs #760 の 27)。 */
  'archive-net780': []
}>()

/**
 * 線の色 (凡例と同じ)。haul = 売上走行 / deadhead = 回送 / other = 降しの無い便など分類不能。
 *
 * `opacity` は**半透明**にしてある (Refs #760 の 19)。経路行の「この経路の便を全部
 * 重ねた地図」は同じ道を 28 本重ねることがあり、不透明だと 1 本目しか見えない。
 * 重なりの濃さで本数が読めるように、回送 (背景) をさらに薄くする。運行 1 本のときも同じ。
 */
const SEGMENT_STYLE: Record<RouteSegment['kind'], { color: string, weight: number, opacity: number, dashed: boolean, zIndex: number, label: string }> = {
  haul: { color: '#10b981', weight: 5, opacity: 0.7, dashed: false, zIndex: 2, label: '売上走行 (積み → 降し)' },
  deadhead: { color: '#9ca3af', weight: 3, opacity: 0.5, dashed: false, zIndex: 1, label: '回送' },
  other: { color: '#f59e0b', weight: 3, opacity: 0.7, dashed: true, zIndex: 1, label: '降しの無い便 / 分類不能' },
  // 軌跡 (Refs #760 の 21・24・30)。イベント線 (始点・終点を結んだ直線) の**下**に描く —
  // 直線のスケッチと、実際に通った点の両方が読めるように。NET780 の道なり GPS
  // (アーカイブがある運行) と、重ね掛け行も混ぜたイベント軌跡 (それ以外の運行) の**どちらか**。
  // 色は紫系 2 色 (オーナー 2026-08-23「軌跡の色をわかりやすく、もう少し太く」)。
  // 緑 (積み marker #059669 / 直線 haul #10b981)・灰 (直線 deadhead #9ca3af)・
  // 琥珀 (#f59e0b、Google ライト地図の高速の橙/黄とも紛れる)・青 (降し marker #2563eb) を
  // 全部避けると、**ライト地図に事実上存在しない紫系**が残る。violet ⇄ magenta は
  // 赤緑軸に依存せず青チャネルの差で読めるので、色覚多様性でも便と回送を区別できる。
  // 太さ 5 は直線の haul と同じだが、軌跡は zIndex 0 で下に敷くので直線は隠れない。
  // **縁取り (casing) は入れない** — 重なりの濃さで本数を読む上の設計 (Refs #760 の 19) と衝突するため。
  // 凡例の見本もこの weight / color から描いている。
  trackHaul: { color: '#7c3aed', weight: 5, opacity: 0.9, dashed: false, zIndex: 0, label: '軌跡 (便の時間帯)' },
  trackDeadhead: { color: '#db2777', weight: 5, opacity: 0.85, dashed: false, zIndex: 0, label: '軌跡 (回送の時間帯)' },
}

/** マーカーの重なり順。積み 4 / 降し 3 (重なったとき積みが上) / 開始・終了 2。 */
const MARKER_Z: Record<RouteMarker['kind'], number> = { load: 4, unload: 3, start: 2, end: 2 }

const mapEl = ref<HTMLDivElement | null>(null)
const loadError = ref<string | null>(null)

let map: google.maps.Map | null = null
let markerLib: google.maps.MarkerLibrary | null = null
let polylines: google.maps.Polyline[] = []
let markers: google.maps.marker.AdvancedMarkerElement[] = []
/** 作成中の Map。`onMounted` と `route` の watch が同時に走っても Map を 2 つ作らない。 */
let mapPromise: Promise<google.maps.Map | null> | null = null

function ensureMap(): Promise<google.maps.Map | null> {
  if (!mapPromise) mapPromise = createMap()
  return mapPromise
}

async function createMap(): Promise<google.maps.Map | null> {
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
      center: { lat: 43.0, lng: 143.2 },
      zoom: 7,
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

/**
 * マーカーの見た目: start/end = 小さい丸 (黒 ● / 白 ○)、load = 緑の ▲ 20px (白縁取り)、
 * unload = 青の ■ 20px に白抜きの便番号 (Refs #760 の 25。▲/▼ だと重ねたときに
 * 見分けにくいので形を変え、少し大きくした)。便番号は積みは右に添え、降しは ■ の中。
 */
function markerContent(mk: RouteMarker): HTMLElement {
  const el = document.createElement('div')
  el.style.display = 'flex'
  el.style.alignItems = 'center'
  el.style.gap = '2px'
  el.style.fontSize = '13px'
  el.style.fontWeight = '700'
  el.style.lineHeight = '1'
  if (mk.kind === 'start' || mk.kind === 'end') {
    const dot = document.createElement('span')
    dot.style.display = 'inline-block'
    dot.style.width = '10px'
    dot.style.height = '10px'
    dot.style.borderRadius = '9999px'
    dot.style.background = mk.kind === 'start' ? '#111827' : '#ffffff'
    dot.style.border = '2px solid #111827'
    el.appendChild(dot)
    return el
  }
  const seqText = String(mk.legSeq ?? '')
  if (mk.kind === 'load') {
    const glyph = document.createElement('span')
    glyph.textContent = '▲'
    glyph.style.color = '#059669'
    glyph.style.fontSize = '20px'
    // 白縁取り (地図の緑の上でも形が立つように)。
    glyph.style.textShadow = '0 0 2px #fff, 0 0 2px #fff, 1px 1px 0 #fff, -1px -1px 0 #fff'
    el.appendChild(glyph)
    const seq = document.createElement('span')
    seq.textContent = seqText
    seq.style.color = '#065f46'
    seq.style.textShadow = '0 0 3px #fff, 0 0 3px #fff'
    el.appendChild(seq)
    return el
  }
  // unload: 青の ■ に白抜きの便番号。
  const box = document.createElement('span')
  box.style.display = 'inline-flex'
  box.style.alignItems = 'center'
  box.style.justifyContent = 'center'
  box.style.width = '20px'
  box.style.height = '20px'
  box.style.borderRadius = '3px'
  box.style.background = '#2563eb'
  box.style.border = '2px solid #fff'
  box.style.boxSizing = 'border-box'
  box.style.color = '#fff'
  box.style.fontSize = '11px'
  box.textContent = seqText
  el.appendChild(box)
  return el
}

async function redraw() {
  const m = await ensureMap()
  if (!m || !markerLib) return
  clearOverlays()

  const route = props.route
  // `pointCount` はイベント線の点数 (NET780 軌跡は数えない) なので、描くものの有無は segments で見る。
  if (!route || route.segments.length === 0) return

  // 層で絞る (Refs #760 の 25)。fitBounds は**描画対象が空でなければ描画対象だけ**で、
  // 全部 OFF にして空なら全要素で (何も描かれない地図がどこか分からない場所に飛ばないように)。
  const shown = filterRouteByLayers(route, props.layers)
  const fit = shown.segments.length > 0 || shown.markers.length > 0 ? shown : route

  const bounds = new google.maps.LatLngBounds()
  for (const seg of shown.segments) {
    const style = SEGMENT_STYLE[seg.kind]
    polylines.push(new google.maps.Polyline({
      path: seg.path,
      strokeColor: style.color,
      strokeOpacity: style.dashed ? 0 : style.opacity,
      strokeWeight: style.weight,
      // 破線は Google Maps の定番 (strokeOpacity 0 + 短い線のアイコンを繰り返す)。
      icons: style.dashed
        ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: style.opacity, strokeColor: style.color, scale: 3 }, offset: '0', repeat: '14px' }]
        : undefined,
      zIndex: style.zIndex,
      map: m,
    }))
  }

  for (const mk of shown.markers) {
    markers.push(new markerLib.AdvancedMarkerElement({
      position: { lat: mk.lat, lng: mk.lng },
      map: m,
      title: mk.ts ? `${mk.label} ${mk.ts}` : mk.label,
      content: markerContent(mk),
      // 積み 4 / 降し 3 (重なったとき積みが上) / 開始・終了 2。
      zIndex: MARKER_Z[mk.kind],
    }))
  }

  for (const seg of fit.segments) for (const p of seg.path) bounds.extend(p)
  for (const mk of fit.markers) bounds.extend({ lat: mk.lat, lng: mk.lng })
  m.fitBounds(bounds)
  const listener = google.maps.event.addListenerOnce(m, 'bounds_changed', () => {
    if (m && (m.getZoom() ?? 0) > 16) m.setZoom(16)
  })
  void listener
}

/** 層の切替 (凡例の各行 = チェックボックス)。親が保存して `layers` を差し替え、watch で描き直す。 */
function toggleLayer(key: keyof RouteMapLayers) {
  emit('update:layers', { ...props.layers, [key]: !props.layers[key] })
}

watch(() => props.route, redraw)
watch(() => props.layers, redraw)
onMounted(redraw)
onBeforeUnmount(clearOverlays)

/** Esc で閉じる。モーダルの外に出る唯一の副作用なので、外したら必ず戻す。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

type OverlayKind = 'loading' | 'error' | 'map-error' | 'empty' | null

const overlayKind = computed<OverlayKind>(() => {
  if (props.loading) return 'loading'
  if (props.error) return 'error'
  if (loadError.value) return 'map-error'
  if (!props.route || props.route.segments.length === 0) return 'empty'
  return null
})

/** 「点が無い」の理由。GPS 列が無い CSV (落とした行 0) と、GPS が全部無効 (落とした行 > 0) を分ける。 */
const emptyReason = computed(() => {
  if (!props.route) return 'この運行の経路はありません'
  if (props.route.droppedRows > 0) return `GPS が有効な行がありません (GPS 無効の行 ${props.route.droppedRows})`
  return 'イベントCSV に GPS 列が無いか、行がありません'
})

/**
 * 凡例 = レイヤのチェックボックス (Refs #760 の 25)。線の層は 1 行に 1 層で、
 * 直線 2 層は見本の色を `SEGMENT_STYLE` から、軌跡は便 / 回送の 2 色を並べる。
 */
const LINE_LAYERS: Array<{ key: keyof RouteMapLayers, label: string, kinds: RouteSegment['kind'][] }> = [
  { key: 'track', label: '軌跡 (経路)', kinds: ['trackHaul', 'trackDeadhead'] },
  { key: 'haulLine', label: '売上走行の直線', kinds: ['haul'] },
  { key: 'deadheadLine', label: '回送の直線', kinds: ['deadhead', 'other'] },
]
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-5xl my-8 rounded-lg bg-white dark:bg-gray-900 shadow-xl">
      <div class="flex flex-wrap items-center gap-3 border-b border-gray-200 dark:border-gray-800 px-4 py-3">
        <h2 class="text-sm font-semibold">
          {{ title }}
        </h2>
        <span v-if="trackNote" class="text-xs text-gray-500">{{ trackNote }}</span>
        <button
          v-if="(net780MissingCount ?? 0) > 0"
          type="button"
          class="rounded border border-gray-300 dark:border-gray-700 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          title="NET780 のアーカイブが無い運行を relay に取りに行かせて R2 に保存する (1 運行 数秒〜十数秒)。終わると地図を引き直す"
          :disabled="net780Archiving"
          @click="emit('archive-net780')"
        >
          {{ net780Archiving ? '…' : `NET780 を取得 (未取得 ${net780MissingCount} 運行)` }}
        </button>
        <span v-if="net780ArchiveProgress" class="text-xs text-gray-500">{{ net780ArchiveProgress }}</span>
        <span class="ml-auto flex items-center gap-3 text-xs">
          <span v-if="route" class="text-gray-500">
            点 {{ route.pointCount }}<template v-if="route.droppedRows > 0"> / GPS 無効の行 {{ route.droppedRows }}</template>
          </span>
          <button
            class="rounded px-2 py-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-label="閉じる"
            @click="emit('close')"
          >
            ✕
          </button>
        </span>
      </div>

      <div class="relative w-full h-[70vh] min-h-[360px] bg-gray-100 dark:bg-gray-800">
        <div ref="mapEl" class="w-full h-full" />
        <div
          v-if="overlayKind"
          class="absolute inset-0 flex items-center justify-center text-sm px-4 text-center bg-white/90 dark:bg-gray-900/90"
        >
          <div class="space-y-2 text-gray-500">
            <p v-if="overlayKind === 'loading'" class="flex items-center gap-2 justify-center">
              <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />
              イベントCSV を取得中...
            </p>
            <p v-else-if="overlayKind === 'error'" class="text-red-600 dark:text-red-400">
              {{ error }}
            </p>
            <p v-else-if="overlayKind === 'map-error'" class="text-red-600 dark:text-red-400">
              {{ loadError }}
            </p>
            <p v-else-if="overlayKind === 'empty'">
              {{ emptyReason }}
            </p>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-4 px-4 py-2 text-[11px] text-gray-500 border-t border-gray-100 dark:border-gray-800">
        <label v-for="l in LINE_LAYERS" :key="l.key" class="flex items-center gap-1 cursor-pointer select-none">
          <input type="checkbox" class="size-3" :checked="layers[l.key]" @change="toggleLayer(l.key)">
          <span
            v-for="k in l.kinds"
            :key="k"
            class="inline-block w-4 rounded"
            :style="{
              height: `${SEGMENT_STYLE[k].weight}px`,
              background: SEGMENT_STYLE[k].dashed ? 'transparent' : SEGMENT_STYLE[k].color,
              borderTop: SEGMENT_STYLE[k].dashed ? `${SEGMENT_STYLE[k].weight}px dashed ${SEGMENT_STYLE[k].color}` : 'none',
            }"
          />{{ l.label }}
        </label>
        <label class="flex items-center gap-1 cursor-pointer select-none">
          <input type="checkbox" class="size-3" :checked="layers.load" @change="toggleLayer('load')">
          <span class="text-emerald-600 font-bold text-base leading-none">▲</span>積み (便番号)
        </label>
        <label class="flex items-center gap-1 cursor-pointer select-none">
          <input type="checkbox" class="size-3" :checked="layers.unload" @change="toggleLayer('unload')">
          <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm bg-blue-600 text-white text-[9px] font-bold leading-none">1</span>降し (便の最後)
        </label>
        <label class="flex items-center gap-1 cursor-pointer select-none">
          <input type="checkbox" class="size-3" :checked="layers.startEnd" @change="toggleLayer('startEnd')">
          <span class="inline-block w-2.5 h-2.5 rounded-full bg-gray-900 dark:bg-gray-100" />運行開始
          <span class="inline-block w-2.5 h-2.5 rounded-full border-2 border-gray-900 dark:border-gray-100" />運行終了
        </label>
      </div>
      <div class="flex flex-wrap items-center gap-4 px-4 pb-2 text-[11px] text-gray-400">
        <span>軌跡 = NET780 の道なり GPS か、重ね掛け行も混ぜたイベント軌跡 (紫 = 便の時間帯 / マゼンタ = 回送の時間帯)。直線 = イベント行の始点→終点 (既定 OFF)</span>
      </div>
    </div>
  </div>
</template>
