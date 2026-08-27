<script setup lang="ts">
/**
 * `/operations/[unko_no]` の NET780 タブ本体。運行No で D1 検索カタログ
 * (Refs #299) を引き、アーカイブ済みなら NET780 生データのサマリ・速度
 * チャート・GPS 軌跡を表示する (`/net780` ページの暦日ごとチャート+地図
 * 表示ロジックを移植、Refs #299 の後続)。
 */

import {
  buildNet780Summary,
  buildNet780SearchLink,
  buildDailySpeedCharts,
  buildDailyGpsPoints,
  chartXRatioToTime,
  net780DateStartTs,
  formatNet780Ts,
} from '~/utils/net780'
import type { Net780GpsPoint } from '~/utils/net780'
import { net780ZipAvailability, net780ZipFileName } from '~/utils/operation-detail-view'
import { currentAccessToken } from '~/utils/api'

const props = defineProps<{
  operationNo: string
  readingDate?: string | null
  vehicleCd?: string | null
  driverCd?: string | null
}>()

/** 未アーカイブ時に /net780 へ渡す検索の初期値。/net780 の NET780 検索は
 * 読取日 (ReadNo) 基準に固定されている (Refs #311) ため、運行日 (operation_date)
 * ではなく読取日 (reading_date) を渡す。運行日と読取日は1日ズレることがあり、
 * 運行日を渡すと 0 件になる (Refs #316)。車輌CD・乗務員CD も分かっていれば渡し、
 * より絞り込んだ状態で検索フォームを開けるようにする。 */
const net780SearchLink = computed(() => buildNet780SearchLink({
  readingDate: props.readingDate,
  vehicleCd: props.vehicleCd,
  driverCd: props.driverCd,
}))

const net780Data = useNet780OperationData(() => props.operationNo)
const { result } = net780Data
const loading = computed(() => net780Data.status.value === 'idle' || net780Data.status.value === 'loading')
const notFound = computed(() => net780Data.status.value === 'not-found')
const error = net780Data.error

watch(() => props.operationNo, (v) => { if (v) net780Data.ensureLoaded() }, { immediate: true })

const summary = computed(() => (result.value ? buildNet780Summary(result.value) : null))

// --- NET780 生データ zip のダウンロード (Refs #873) ---------------------------
//
// **出すのは R2 の原本 (`/api/net780/by-operation` の応答そのもの)。**
// `extractSingleOperationZip` を通した後の zip ではない。実測 (2026-08-25、
// 運行 2607010121120000001318) で:
//
// | | bytes | 中身 |
// |---|---|---|
// | 原本 | **60,803** | `{車輌CD}/{運行開始日時}-{端末ID}-{車輌CD}/` の下に 8 ファイル (deflate) |
// | `extractSingleOperationZip` 後 | 185,707 | フォルダを剥いだ 8 ファイルを平置き (JSZip 既定 = 無圧縮) |
//
// 原本は **1/3 のサイズ**で、**運行を識別するフォルダ名が残る**。「生データ」として
// 渡すなら原本が正しい。
//
// **bytes は composable に持たせない。**押されたときに取り直す —
// `useNet780OperationData` は `Net780ParseResult` を返すモジュール scope の cache
// (evict 無し) で、そこへ運行ごとに数十〜数百 KB の生バイトを載せると開いた運行のぶん
// だけ常駐する。ダウンロードは人が押したときだけの操作なので、取り直す方が安い
// (**cache / dedup の方針にも 1 行も触らずに済む**)。
const zip = computed(() => net780ZipAvailability(net780Data.status.value))
const zipDownloading = ref(false)
/** ダウンロードそのものの失敗 (取得状態 `error` とは別物なので別に持つ)。 */
const zipError = ref<string | null>(null)

async function downloadZip() {
  zipDownloading.value = true
  zipError.value = null
  try {
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — この口が `requireAuth` を
    // 通すようになった (Refs #988)。`snapshot.delete.ts` と同じ扱い。
    const token = currentAccessToken()
    const blob = await $fetch<Blob>('/api/net780/by-operation', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      query: { operationNo: props.operationNo },
      responseType: 'blob',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // zip の中に運行NO は出てこない (車輌CD と運行開始日時のフォルダ名だけ) ので、
    // **外側のファイル名で運行NO が読める**ようにする。
    a.download = net780ZipFileName(props.operationNo)
    a.click()
    URL.revokeObjectURL(url)
  }
  catch (e) {
    zipError.value = e instanceof Error ? e.message : 'zip のダウンロードに失敗しました'
  }
  finally {
    zipDownloading.value = false
  }
}

// --- 速度チャート (簡易 SVG polyline、外部ライブラリ非依存) + GPS 軌跡 (Google Map) ---
// 暦日ごとに「チャート (クリック/ドラッグでシーク可能)」と「地図 (シーク位置を
// マーカーで表示)」を左右に並べる (`app/pages/net780/index.vue` と同じロジック)。

const CHART_WIDTH = 800
const CHART_HEIGHT = 180
const CHART_PADDING = 8

const dailySpeedCharts = computed(() => {
  if (!result.value) return []
  return buildDailySpeedCharts(result.value.speed, CHART_WIDTH, CHART_HEIGHT, CHART_PADDING)
})

const dailyGpsPoints = computed(() => {
  if (!result.value) return []
  return buildDailyGpsPoints(result.value.gps, result.value.events)
})

interface DailyView {
  date: string
  dayStart: number
  chart: ReturnType<typeof buildDailySpeedCharts>[number]['chart'] | null
  gpsPoints: Net780GpsPoint[]
}

/** 速度チャートと GPS を同じ暦日単位で束ねる (どちらか一方しか無い日も許容する)。 */
const dailyViews = computed<DailyView[]>(() => {
  const chartsByDate = new Map(dailySpeedCharts.value.map(d => [d.date, d]))
  const gpsByDate = new Map(dailyGpsPoints.value.map(d => [d.date, d.points]))
  const dates = new Set([...chartsByDate.keys(), ...gpsByDate.keys()])
  return [...dates].sort().map((date) => {
    const chartEntry = chartsByDate.get(date)
    return {
      date,
      dayStart: chartEntry?.dayStart ?? net780DateStartTs(date),
      chart: chartEntry?.chart ?? null,
      gpsPoints: gpsByDate.get(date) ?? [],
    }
  })
})

/** 暦日のチャート x 軸ラベル (0, 6, 12, 18, 24 時)。全日共通 (0:00〜24:00 固定幅)。 */
const HOUR_TICKS = [0, 6, 12, 18, 24]

/** 日付ごとの現在シーク位置 (UNIX epoch 秒)。未操作時は各日の 00:00 を指す。 */
const currentTimes = reactive<Record<string, number>>({})

function currentTimeFor(view: DailyView): number {
  return currentTimes[view.date] ?? view.dayStart
}

function cursorXFor(view: DailyView): number {
  const t = currentTimeFor(view)
  const innerW = CHART_WIDTH - CHART_PADDING * 2
  const frac = Math.min(1, Math.max(0, (t - view.dayStart) / (24 * 60 * 60)))
  return CHART_PADDING + frac * innerW
}

const chartRefs = new Map<string, SVGSVGElement>()
function setChartRef(date: string, el: Element | null) {
  if (el instanceof SVGSVGElement) chartRefs.set(date, el)
  else chartRefs.delete(date)
}

const seeking = ref<string | null>(null)

function seekFromEvent(view: DailyView, e: MouseEvent) {
  const svg = chartRefs.get(view.date)
  if (!svg) return
  const rect = svg.getBoundingClientRect()
  if (rect.width <= 0) return
  const ratio = (e.clientX - rect.left) / rect.width
  currentTimes[view.date] = chartXRatioToTime(ratio, view.dayStart, CHART_WIDTH, CHART_PADDING)
}

function onChartPointerDown(view: DailyView, e: MouseEvent) {
  seeking.value = view.date
  chartRefs.get(view.date)?.focus() // 以降 ←→ キーで前後移動できるようにする
  seekFromEvent(view, e)
}
function onChartPointerMove(view: DailyView, e: MouseEvent) {
  if (seeking.value === view.date) seekFromEvent(view, e)
}
function onChartPointerUp() {
  seeking.value = null
}

/** ←→キーでの前後移動 (dvr-map.vue と同じ操作感)。GPS 軌跡の点を一覧に見立て、
 * 現在のシーク位置に最も近い点から ±1 点分だけ移動し、地図のピンに反映する。 */
function stepSeek(view: DailyView, delta: number) {
  const points = view.gpsPoints
  if (!points.length) return
  const t = currentTimeFor(view)
  let idx = 0
  let bestDiff = Infinity
  for (let i = 0; i < points.length; i++) {
    const diff = Math.abs(points[i]!.ts - t)
    if (diff < bestDiff) {
      bestDiff = diff
      idx = i
    }
  }
  const newIdx = Math.min(points.length - 1, Math.max(0, idx + delta))
  currentTimes[view.date] = points[newIdx]!.ts
}
</script>

<template>
  <div class="p-4 space-y-4">
    <!-- NET780 生データ zip (Refs #873)。**どの状態でもこの行は消えない** —
         ボタンが黙って消えると「この機能は無い」に読める。出せない状態は
         `net780ZipAvailability` が 5 状態それぞれ別の文言で言う (未アーカイブは
         下の検索リンクへ誘導する)。 -->
    <div class="flex items-center gap-2 flex-wrap text-sm" data-test="net780-zip">
      <span class="font-medium text-gray-700 dark:text-gray-300">NET780 生データ zip</span>
      <button
        v-if="zip.canDownload"
        type="button"
        class="rounded border border-gray-300 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
        :disabled="zipDownloading"
        data-test="net780-zip-download"
        @click="downloadZip"
      >
        {{ zipDownloading ? 'ダウンロード中...' : 'zip をダウンロード' }}
      </button>
      <span
        v-else
        class="text-xs"
        :class="zip.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-500'"
        data-test="net780-zip-reason"
      >{{ zip.reason }}</span>
      <span v-if="zipError" class="text-xs text-red-600 dark:text-red-400" data-test="net780-zip-error">
        {{ zipError }}
      </span>
      <span class="text-xs text-gray-400">
        アーカイブされた原本をそのまま出します (中身は 車輌CD / 運行開始日時-端末ID-車輌CD のフォルダ)
      </span>
    </div>

    <div v-if="loading" class="flex items-center gap-2 text-sm text-gray-500">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />
      NET780 データを取得中...
    </div>

    <div v-else-if="notFound" class="text-sm text-gray-500 space-y-2">
      <p>この運行の NET780 生データはまだダウンロード・アーカイブされていません。</p>
      <NuxtLink :to="net780SearchLink" class="text-blue-600 dark:text-blue-400 hover:underline">
        NET780 一括ダウンロードで検索する →
      </NuxtLink>
    </div>

    <p v-else-if="error" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
      {{ error }}
    </p>

    <template v-else-if="summary">
      <dl class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <dt class="text-gray-500">車輌CD</dt>
          <dd class="font-medium">{{ summary.vehicleCode ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">乗務員CD</dt>
          <dd class="font-medium">{{ summary.driverCode ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">走行距離</dt>
          <dd class="font-medium">
            {{ summary.distanceKm !== null ? `${summary.distanceKm.toFixed(2)} km` : '-' }}
          </dd>
        </div>
        <div>
          <dt class="text-gray-500">端末ID</dt>
          <dd class="font-medium">{{ summary.deviceId ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">開始</dt>
          <dd class="font-medium">{{ summary.startAt ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">終了</dt>
          <dd class="font-medium">{{ summary.endAt ?? '-' }}</dd>
        </div>
      </dl>

      <!-- 速度チャート (シーク可能) + GPS 軌跡 (Google Map、シーク連動) — 暦日ごと -->
      <UCard v-for="daily in dailyViews" :key="daily.date">
        <template #header>
          <span class="font-bold">{{ daily.date }}</span>
        </template>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-gray-500 mb-1">
              速度 (.spd、0.5秒粒度、クリック/ドラッグでシーク、←→キーで前後移動 — 地図のピンが連動)
            </p>
            <template v-if="daily.chart">
              <svg
                :ref="(el) => setChartRef(daily.date, el as Element | null)"
                tabindex="0"
                :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
                class="w-full h-40 cursor-crosshair select-none outline-none focus:ring-2 focus:ring-blue-400"
                preserveAspectRatio="none"
                @mousedown="onChartPointerDown(daily, $event)"
                @mousemove="onChartPointerMove(daily, $event)"
                @mouseup="onChartPointerUp"
                @mouseleave="onChartPointerUp"
                @keydown.left.prevent="stepSeek(daily, -1)"
                @keydown.right.prevent="stepSeek(daily, 1)"
              >
                <polyline
                  v-for="(seg, i) in daily.chart.segments"
                  :key="i"
                  :points="seg"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  class="text-blue-500"
                />
                <line
                  :x1="cursorXFor(daily)" :x2="cursorXFor(daily)" y1="0" :y2="CHART_HEIGHT"
                  stroke="currentColor" stroke-width="1.5" stroke-dasharray="4,3"
                  class="text-gray-400 dark:text-gray-300"
                />
              </svg>
              <div class="flex justify-between text-[10px] text-gray-400 px-2">
                <span v-for="h in HOUR_TICKS" :key="h">{{ h }}時</span>
              </div>
              <p class="text-xs text-gray-500 mt-1">
                最高速度 {{ daily.chart.maxSpeed.toFixed(1) }} km/h ・ 表示点数 {{ daily.chart.pointCount }}
                ・ シーク位置 {{ formatNet780Ts(currentTimeFor(daily)) }}
              </p>
            </template>
            <p v-else class="text-sm text-gray-400 h-40 flex items-center justify-center">
              .spd データがありません
            </p>
          </div>

          <div>
            <p class="text-xs text-gray-500 mb-1">GPS 軌跡 (.gpd) — {{ daily.gpsPoints.length }} 点</p>
            <Net780Map
              v-if="daily.gpsPoints.length"
              :gps="daily.gpsPoints"
              :current-time="currentTimeFor(daily)"
            />
            <p v-else class="text-sm text-gray-400 h-64 flex items-center justify-center">
              .gpd データがありません
            </p>
          </div>
        </div>
      </UCard>
      <p v-if="!dailyViews.length" class="text-sm text-gray-400">
        .spd / .gpd データがありません
      </p>

      <NuxtLink
        :to="`/net780?operationNo=${encodeURIComponent(operationNo)}`"
        class="inline-block text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        GPS 一覧・イベントログなど詳細を NET780 ビューアで見る →
      </NuxtLink>
    </template>
  </div>
</template>
