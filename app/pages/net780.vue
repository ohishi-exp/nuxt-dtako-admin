<script setup lang="ts">
import {
  parseNet780Zip,
  downsampleSpeed,
  net780EventCodeHex,
  formatNet780Ts,
} from '~/utils/net780'
import type { Net780ParseResult } from '~/utils/net780'

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

// --- 速度チャート (簡易 SVG polyline、外部ライブラリ非依存) ---

const CHART_WIDTH = 800
const CHART_HEIGHT = 180
const CHART_PADDING = 8

const speedChart = computed(() => {
  const points = result.value ? downsampleSpeed(result.value.speed) : []
  if (points.length < 2) return null

  const maxSecs = Math.max(...points.map(p => p.offset_secs)) || 1
  const maxSpeed = Math.max(...points.map(p => p.speed_kmh)) || 1
  const innerW = CHART_WIDTH - CHART_PADDING * 2
  const innerH = CHART_HEIGHT - CHART_PADDING * 2

  const polyline = points
    .map((p) => {
      const x = CHART_PADDING + (p.offset_secs / maxSecs) * innerW
      const y = CHART_PADDING + innerH - (p.speed_kmh / maxSpeed) * innerH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return { polyline, maxSpeed, maxSecs, pointCount: points.length }
})

const gpsRows = computed(() => (result.value?.gps ?? []).slice(0, GPS_TABLE_LIMIT))
const gpsTruncated = computed(() => (result.value?.gps.length ?? 0) > GPS_TABLE_LIMIT)

function eventLabel(e: Net780ParseResult['events'][number]): string {
  return e.description ?? e.payload_ascii ?? ''
}
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-6">
    <h2 class="text-xl font-bold">
      NET780 生データビューア
    </h2>
    <p class="text-sm text-gray-500">
      NET780 デジタコの運行単位 ZIP (.inf/.spd/.dsd/.gpd/.evd 同梱) をブラウザ内で直接パースして
      内容を確認する (アップロード・サーバー送信なし)。
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

      <!-- Speed chart -->
      <UCard v-if="speedChart">
        <template #header>
          <span class="font-bold">速度 (.spd、0.5秒粒度)</span>
        </template>
        <svg
          :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
          class="w-full h-40"
          preserveAspectRatio="none"
        >
          <polyline
            :points="speedChart.polyline"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            class="text-blue-500"
          />
        </svg>
        <p class="text-xs text-gray-500 mt-1">
          最高速度 {{ speedChart.maxSpeed.toFixed(1) }} km/h ・ 表示点数 {{ speedChart.pointCount }}
        </p>
      </UCard>
      <p v-else-if="result.speed.length === 0" class="text-sm text-gray-400">
        .spd データがありません
      </p>

      <!-- GPS -->
      <UCard>
        <template #header>
          <span class="font-bold">GPS 軌跡 (.gpd)</span>
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
</template>
