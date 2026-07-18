<script setup lang="ts">
import {
  parseNet780Zip,
  extractSingleOperationZip,
  buildDailySpeedCharts,
  buildDailyGpsPoints,
  chartXRatioToTime,
  net780DateStartTs,
  net780EventCodeHex,
  formatNet780Ts,
} from '~/utils/net780'
import type { Net780ParseResult, Net780GpsPoint } from '~/utils/net780'

// ---------------------------------------------------------------------------
// theearth からの検索・一括ダウンロード (F-VOS3020、Refs #302)
// ---------------------------------------------------------------------------

/** worker (theearth-net780-client.ts) の Net780Row と同型。 */
interface Net780Row {
  operationNo: string
  startDateTime: string
  operationDate: string | null
  vehicleName: string | null
  branchName: string | null
  driverCd1: string | null
  driverName1: string | null
  driverName2: string | null
  cityName: string | null
}

const { session: net780Session, authHeaders: net780AuthHeaders, restoreSession: restoreNet780Session, expireSession: expireNet780Session } = useNet780Session()

const searchOperationDateFrom = ref('')
const searchOperationDateTo = ref('')
const searchDriverCdFrom = ref('')
const searchDriverCdTo = ref('')
const searchVehicleCdFrom = ref('')
const searchVehicleCdTo = ref('')
const searching = ref(false)
const searchError = ref('')
const searchRows = ref<Net780Row[]>([])
const selectedOperationNos = ref<Set<string>>(new Set())
const downloading = ref(false)
const downloadError = ref('')
/** 現在「解析して表示」中の運行No (二重クリック防止 + ボタンのローディング表示用)。 */
const viewingOperationNo = ref<string | null>(null)

onMounted(() => {
  restoreNet780Session()
})

watch(net780Session, (s) => {
  if (!s) {
    searchRows.value = []
    selectedOperationNos.value = new Set()
  }
})

function rowKeyOf(row: Net780Row): string {
  return row.operationNo
}

const allSelected = computed(() => searchRows.value.length > 0 && selectedOperationNos.value.size === searchRows.value.length)

function toggleSelectAll() {
  selectedOperationNos.value = allSelected.value
    ? new Set()
    : new Set(searchRows.value.map(rowKeyOf))
}

function toggleRow(row: Net780Row) {
  const next = new Set(selectedOperationNos.value)
  const key = rowKeyOf(row)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedOperationNos.value = next
}

async function runNet780Search() {
  if (searching.value || !net780Session.value) return
  searchError.value = ''
  searchRows.value = []
  selectedOperationNos.value = new Set()
  searching.value = true
  try {
    const res = await $fetch<{ rows: Net780Row[] }>('/net780-api/search', {
      headers: net780AuthHeaders(),
      query: {
        operationDateFrom: searchOperationDateFrom.value || undefined,
        operationDateTo: searchOperationDateTo.value || undefined,
        driverCdFrom: searchDriverCdFrom.value || undefined,
        driverCdTo: searchDriverCdTo.value || undefined,
        vehicleCdFrom: searchVehicleCdFrom.value || undefined,
        vehicleCdTo: searchVehicleCdTo.value || undefined,
      },
    })
    searchRows.value = res.rows
  }
  catch (e) {
    if (net780ErrorStatus(e) === 401) {
      expireNet780Session(net780ErrorMessage(e))
      return
    }
    searchError.value = net780ErrorMessage(e)
  }
  finally {
    searching.value = false
  }
}

/** 検索結果の1行を、D1 検索カタログ (Refs #299) 用の表示メタ込みで
 * ダウンロード target に変換する。theearth への postback には
 * operationNo/startDateTime だけが使われ、残りはカタログ書き込み専用。 */
function net780RowToTarget(row: Net780Row) {
  return {
    operationNo: row.operationNo,
    startDateTime: row.startDateTime,
    vehicleName: row.vehicleName,
    driverCd1: row.driverCd1,
    driverName1: row.driverName1,
    operationDate: row.operationDate,
  }
}

/** 選択した運行を1件ずつダウンロードする。複数運行を1回の postback にまとめると
 * 個別運行を安全に取り出せない ZIP (`operationCount > 1`) が archive されて
 * しまうため、選択件数分このループで順に呼ぶ (Refs #299)。 */
const downloadProgress = ref<{ done: number; total: number } | null>(null)

async function downloadSelectedNet780() {
  if (downloading.value || !net780Session.value) return
  const selected = searchRows.value.filter(r => selectedOperationNos.value.has(rowKeyOf(r)))
  if (selected.length === 0) return
  downloadError.value = ''
  downloading.value = true
  downloadProgress.value = { done: 0, total: selected.length }
  try {
    for (const row of selected) {
      const blob = await $fetch<Blob>('/net780-api/download', {
        method: 'POST',
        headers: net780AuthHeaders(),
        body: { targets: [net780RowToTarget(row)] },
        responseType: 'blob',
      })
      triggerNet780Download(blob, `net780-${row.operationNo}.zip`)
      downloadProgress.value = { done: downloadProgress.value.done + 1, total: selected.length }
    }
  }
  catch (e) {
    if (net780ErrorStatus(e) === 401) {
      expireNet780Session(net780ErrorMessage(e))
      return
    }
    downloadError.value = net780ErrorMessage(e)
  }
  finally {
    downloading.value = false
    downloadProgress.value = null
  }
}

function triggerNet780Download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// 単一ファイル手動アップロード解析 (既存機能、ブラウザ内完結)
// ---------------------------------------------------------------------------

const isDragging = ref(false)
const isParsing = ref(false)
const error = ref<string | null>(null)
const result = ref<Net780ParseResult | null>(null)
const fileName = ref('')

const GPS_TABLE_LIMIT = 300

function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragging.value = true
}

function onDragLeave() {
  isDragging.value = false
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  const file = e.dataTransfer?.files[0]
  if (file) handleFile(file)
}

function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) handleFile(file)
  input.value = ''
}

async function handleFile(file: File) {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    error.value = 'ZIP ファイルを選択してください'
    return
  }

  error.value = null
  result.value = null
  fileName.value = file.name
  isParsing.value = true

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    result.value = await parseNet780Zip(bytes)
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : 'パースに失敗しました'
  }
  finally {
    isParsing.value = false
  }
}

/** R2 に既にアーカイブ済みなら theearth に再アクセスせずそこから取得する
 * (`/net780-api/r2-view`)。未アーカイブ (404) なら通常の theearth
 * ダウンロードにフォールバックする (Refs #302 続き)。 */
async function fetchNet780Blob(row: Net780Row): Promise<Blob> {
  try {
    return await $fetch<Blob>('/net780-api/r2-view', {
      headers: net780AuthHeaders(),
      query: { operationNo: row.operationNo },
      responseType: 'blob',
    })
  }
  catch (e) {
    if (net780ErrorStatus(e) !== 404) throw e
  }
  return await $fetch<Blob>('/net780-api/download', {
    method: 'POST',
    headers: net780AuthHeaders(),
    body: { targets: [net780RowToTarget(row)] },
    responseType: 'blob',
  })
}

/** 検索結果の1行を取得し、再アップロードなしでそのまま下のビューアに解析結果を
 * 表示する。過去にダウンロード済みの運行は R2 アーカイブからそのまま表示する
 * (theearth 側の負荷・503 再現性を避けられる)。 */
async function viewNet780Row(row: Net780Row) {
  if (viewingOperationNo.value || !net780Session.value) return
  error.value = null
  result.value = null
  fileName.value = `${row.vehicleName ?? row.operationNo} (${row.operationDate ?? ''})`
  viewingOperationNo.value = row.operationNo
  isParsing.value = true
  try {
    const blob = await fetchNet780Blob(row)
    const bulkBytes = new Uint8Array(await blob.arrayBuffer())
    const singleBytes = await extractSingleOperationZip(bulkBytes)
    result.value = await parseNet780Zip(singleBytes)
  }
  catch (e) {
    if (net780ErrorStatus(e) === 401) {
      expireNet780Session(net780ErrorMessage(e))
      return
    }
    error.value = e instanceof Error ? e.message : '取得・パースに失敗しました'
  }
  finally {
    viewingOperationNo.value = null
    isParsing.value = false
  }
}

// --- 表示用 computed ---

const summary = computed(() => {
  const r = result.value
  if (!r) return null
  const inf = r.inf
  const header = r.header
  return {
    vehicleCode: inf?.vehicle_code ?? header?.vehicle_code ?? null,
    driverCode: inf?.driver_code ?? header?.driver_code ?? null,
    startAt: inf?.start_at ?? header?.start_at ?? null,
    endAt: inf?.end_at ?? header?.end_at ?? null,
    distanceKm: inf?.distance_km ?? header?.distance_km ?? null,
    distanceTotalM: r.distance_total_m,
    storagePath: inf?.storage_path ?? null,
    deviceId: header?.device_id ?? null,
  }
})

// --- 速度チャート (簡易 SVG polyline、外部ライブラリ非依存) + GPS 軌跡 (Google Map) ---
// 暦日ごとに「チャート (クリック/ドラッグでシーク可能)」と「地図 (シーク位置を
// マーカーで表示)」を左右に並べる。currentTime (UNIX epoch 秒) を暦日ごとに
// 保持し、チャート上のシーク操作がその日の地図マーカーを連動させる。

const CHART_WIDTH = 800
const CHART_HEIGHT = 180
const CHART_PADDING = 8

const dailySpeedCharts = computed(() => {
  if (!result.value) return []
  return buildDailySpeedCharts(result.value.speed, CHART_WIDTH, CHART_HEIGHT, CHART_PADDING)
})

const dailyGpsPoints = computed(() => {
  if (!result.value) return []
  return buildDailyGpsPoints(result.value.gps)
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
  seekFromEvent(view, e)
}
function onChartPointerMove(view: DailyView, e: MouseEvent) {
  if (seeking.value === view.date) seekFromEvent(view, e)
}
function onChartPointerUp() {
  seeking.value = null
}

const gpsRows = computed(() => (result.value?.gps ?? []).slice(0, GPS_TABLE_LIMIT))
const gpsTruncated = computed(() => (result.value?.gps.length ?? 0) > GPS_TABLE_LIMIT)

function eventLabel(e: Net780ParseResult['events'][number]): string {
  return e.description ?? e.payload_ascii ?? ''
}
</script>

<template>
  <div>
    <TheearthSessionHeader title="NET780 一括ダウンロード (web地球号)" api-prefix="/net780-api" wide />

    <div class="max-w-4xl mx-auto p-6 space-y-6">
      <!-- theearth 検索・一括ダウンロード -->
      <UCard>
        <template #header>
          <span class="font-semibold">theearth から検索して一括ダウンロード</span>
        </template>
        <div class="flex flex-wrap items-end gap-4">
          <UFormField label="運行日 (から)">
            <UInput v-model="searchOperationDateFrom" type="date" />
          </UFormField>
          <UFormField label="運行日 (まで)">
            <UInput v-model="searchOperationDateTo" type="date" />
          </UFormField>
          <UFormField label="乗務員CD (から)">
            <UInput v-model="searchDriverCdFrom" placeholder="例: 1726" />
          </UFormField>
          <UFormField label="乗務員CD (まで)">
            <UInput v-model="searchDriverCdTo" placeholder="例: 1726" />
          </UFormField>
          <UFormField label="車輌CD (から)">
            <UInput v-model="searchVehicleCdFrom" placeholder="例: 3071" />
          </UFormField>
          <UFormField label="車輌CD (まで)">
            <UInput v-model="searchVehicleCdTo" placeholder="例: 3071" />
          </UFormField>
          <UButton
            icon="i-lucide-search"
            :label="searching ? '検索中...' : '検索'"
            :loading="searching"
            :disabled="!net780Session"
            @click="runNet780Search"
          />
        </div>
        <p class="text-xs text-gray-500 mt-2">
          運行日・乗務員CD・車輌CD のいずれか1つ以上を指定してください (無条件の全件検索はできません)。
        </p>
        <p v-if="searchError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mt-3">
          {{ searchError }}
        </p>

        <!-- 検索結果 -->
        <div v-if="searchRows.length" class="mt-4 space-y-3">
          <div class="flex items-center gap-3">
            <UButton size="xs" variant="soft" :label="allSelected ? '選択解除' : '全選択'" @click="toggleSelectAll" />
            <span class="text-sm text-gray-500">{{ searchRows.length }} 件中 {{ selectedOperationNos.size }} 件選択</span>
            <div class="flex-1" />
            <UButton
              icon="i-lucide-download"
              size="sm"
              :label="downloading ? `ダウンロード中... (${downloadProgress?.done ?? 0}/${downloadProgress?.total ?? 0}件)` : `選択した${selectedOperationNos.size}件をダウンロード`"
              :loading="downloading"
              :disabled="selectedOperationNos.size === 0"
              @click="downloadSelectedNet780"
            />
          </div>
          <p v-if="downloadError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
            {{ downloadError }}
          </p>
          <div class="overflow-x-auto max-h-96 overflow-y-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                  <th class="px-2 py-2">
                    <input type="checkbox" :checked="allSelected" @change="toggleSelectAll">
                  </th>
                  <th class="px-2 py-2">運行日</th>
                  <th class="px-2 py-2">車輌名</th>
                  <th class="px-2 py-2">事業所</th>
                  <th class="px-2 py-2">乗務員CD</th>
                  <th class="px-2 py-2">乗務員名</th>
                  <th class="px-2 py-2">行先市町村名</th>
                  <th class="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in searchRows"
                  :key="rowKeyOf(row)"
                  class="border-b border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  @click="toggleRow(row)"
                >
                  <td class="px-2 py-1.5" @click.stop="toggleRow(row)">
                    <input type="checkbox" :checked="selectedOperationNos.has(rowKeyOf(row))">
                  </td>
                  <td class="px-2 py-1.5">{{ row.operationDate ?? '-' }}</td>
                  <td class="px-2 py-1.5">{{ row.vehicleName ?? '-' }}</td>
                  <td class="px-2 py-1.5">{{ row.branchName ?? '-' }}</td>
                  <td class="px-2 py-1.5">{{ row.driverCd1 ?? '-' }}</td>
                  <td class="px-2 py-1.5">{{ row.driverName1 ?? '-' }}</td>
                  <td class="px-2 py-1.5">{{ row.cityName ?? '-' }}</td>
                  <td class="px-2 py-1.5 whitespace-nowrap">
                    <UButton
                      size="xs"
                      variant="soft"
                      icon="i-lucide-eye"
                      label="表示"
                      :loading="viewingOperationNo === row.operationNo"
                      :disabled="viewingOperationNo !== null && viewingOperationNo !== row.operationNo"
                      @click.stop="viewNet780Row(row)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </UCard>
    </div>

    <div class="max-w-4xl mx-auto p-6 pt-0 space-y-6">
      <h2 class="text-xl font-bold">
        NET780 生データビューア
      </h2>
      <p class="text-sm text-gray-500">
        上の検索結果で「表示」を押すか、NET780 デジタコの運行単位 ZIP
        (.inf/.spd/.dsd/.gpd/.evd 同梱) を直接ドラッグ＆ドロップして、ブラウザ内で
        内容を確認する (theearth からのダウンロード以外はサーバー送信なし)。
      </p>

      <!-- Drop zone -->
    <div
      class="border-2 border-dashed rounded-xl p-12 text-center transition-colors cursor-pointer"
      :class="isDragging
        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
        : 'border-gray-300 dark:border-gray-700 hover:border-gray-400'"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="($refs.fileInput as HTMLInputElement).click()"
    >
      <UIcon name="i-lucide-file-archive" class="size-12 text-gray-400 mx-auto mb-4" />
      <p class="text-gray-600 dark:text-gray-400">
        NET780 生データ ZIP をドラッグ＆ドロップ<br>
        またはクリックして選択
      </p>
      <input
        ref="fileInput"
        type="file"
        accept=".zip"
        class="hidden"
        @change="onFileSelect"
      >
    </div>

    <div v-if="isParsing" class="flex items-center gap-3 p-4">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-5" />
      <span class="text-gray-500">{{ fileName }} をパース中...</span>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-circle"
      :title="error"
    />

    <template v-if="result">
      <UAlert
        v-if="result.warnings.length"
        color="warning"
        variant="subtle"
        icon="i-lucide-alert-triangle"
        title="警告"
      >
        <template #description>
          <ul class="list-disc pl-5 space-y-0.5">
            <li v-for="(w, i) in result.warnings" :key="i">
              {{ w }}
            </li>
          </ul>
        </template>
      </UAlert>

      <!-- Summary -->
      <UCard v-if="summary">
        <template #header>
          <span class="font-bold">運行サマリ</span>
        </template>
        <dl class="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt class="text-gray-500">車両CD</dt>
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
              <span v-if="summary.distanceTotalM !== null" class="text-gray-400 text-xs">
                (.dsd 総和 {{ (summary.distanceTotalM / 1000).toFixed(3) }} km)
              </span>
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">運行開始</dt>
            <dd class="font-medium">{{ summary.startAt ?? '-' }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">運行終了</dt>
            <dd class="font-medium">{{ summary.endAt ?? '-' }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">機種ID</dt>
            <dd class="font-medium">{{ summary.deviceId ?? '-' }}</dd>
          </div>
          <div v-if="summary.storagePath" class="col-span-2 sm:col-span-3">
            <dt class="text-gray-500">格納パス</dt>
            <dd class="font-medium break-all text-xs">{{ summary.storagePath }}</dd>
          </div>
        </dl>
      </UCard>

      <!-- 速度チャート (シーク可能) + GPS 軌跡 (Google Map、シーク連動) — 暦日ごと -->
      <UCard v-for="daily in dailyViews" :key="daily.date">
        <template #header>
          <span class="font-bold">{{ daily.date }}</span>
        </template>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-gray-500 mb-1">速度 (.spd、0.5秒粒度、クリック/ドラッグでシーク)</p>
            <template v-if="daily.chart">
              <svg
                :ref="(el) => setChartRef(daily.date, el as Element | null)"
                :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
                class="w-full h-40 cursor-crosshair select-none"
                preserveAspectRatio="none"
                @mousedown="onChartPointerDown(daily, $event)"
                @mousemove="onChartPointerMove(daily, $event)"
                @mouseup="onChartPointerUp"
                @mouseleave="onChartPointerUp"
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

      <!-- GPS 一覧 (テーブル、全日通算) -->
      <UCard>
        <template #header>
          <span class="font-bold">GPS 一覧 (.gpd)</span>
        </template>
        <p class="text-xs text-gray-500 mb-2">
          {{ result.gps.length }} 点
          <span v-if="gpsTruncated">(先頭 {{ GPS_TABLE_LIMIT }} 点のみ表示)</span>
        </p>
        <div v-if="gpsRows.length" class="overflow-auto max-h-64">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                <th class="py-1 pr-4">時刻</th>
                <th class="py-1 pr-4">緯度</th>
                <th class="py-1 pr-4">経度</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in gpsRows" :key="i" class="border-b border-gray-100 dark:border-gray-900">
                <td class="py-1 pr-4 whitespace-nowrap">{{ formatNet780Ts(p.ts) }}</td>
                <td class="py-1 pr-4">{{ p.lat.toFixed(6) }}</td>
                <td class="py-1 pr-4">{{ p.lon.toFixed(6) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-sm text-gray-400">
          .gpd データがありません
        </p>
      </UCard>

      <!-- Events -->
      <UCard>
        <template #header>
          <span class="font-bold">イベント / エラーログ (.evd)</span>
        </template>
        <p class="text-xs text-gray-500 mb-2">
          {{ result.events.length }} 件
        </p>
        <div v-if="result.events.length" class="overflow-auto max-h-96">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                <th class="py-1 pr-4">時刻</th>
                <th class="py-1 pr-4">code</th>
                <th class="py-1 pr-4">subcode</th>
                <th class="py-1 pr-4">内容</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(e, i) in result.events"
                :key="i"
                class="border-b border-gray-100 dark:border-gray-900"
                :class="e.code === 0xFE ? 'bg-red-50/50 dark:bg-red-950/20' : ''"
              >
                <td class="py-1 pr-4 whitespace-nowrap">{{ formatNet780Ts(e.ts) }}</td>
                <td class="py-1 pr-4 font-mono">{{ net780EventCodeHex(e.code) }}</td>
                <td class="py-1 pr-4 font-mono">{{ net780EventCodeHex(e.subcode) }}</td>
                <td class="py-1 pr-4 break-all">{{ eventLabel(e) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-sm text-gray-400">
          .evd データがありません
        </p>
      </UCard>
    </template>
    </div>
  </div>
</template>
