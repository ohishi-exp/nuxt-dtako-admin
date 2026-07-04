<script setup lang="ts">
/**
 * 車輌の位置情報 (現在地) + 動態履歴 (GPS 軌跡) ページ (Refs #90)。
 *
 * theearth の VenusMain (位置情報) / F-DOV0010 (動態履歴) 相当。認証は /dvr-viewer と
 * 同じ credential pass-through (useDvrSession で共有、DO も同一 = theearth 単一
 * セッションを共用する)。座標は relay 側で DDMM → 十進度に変換済み。
 */
import type { DvrMapMarker } from '~/components/DvrMap.vue'


interface VehicleStatePoint {
  vehicleCd: string | null
  vehicleName: string | null
  branchName: string | null
  driverName: string | null
  latitude: number | null
  longitude: number | null
  dataDatetime: string | null
  comuDatetime: string | null
  speed: number | null
  revo: number | null
  direction: number | null
  currentWorkName: string | null
}

/** 動態履歴 1 点 (VehicleDisp テーブル由来、速度・回転数・住所・状態付き)。 */
interface VehicleLogPoint {
  dataDatetime: string | null
  comuDatetime: string | null
  latitude: number | null
  longitude: number | null
  speed: number | null
  revo: number | null
  state: string | null
  roadType: string | null
  address: string | null
  driverName: string | null
  dataType: string | null
}

interface DvrMasterBranch { code: string, name: string }
interface DvrMasterItem { code: string, link: string | null, name: string }
interface DvrMasters { branches: DvrMasterBranch[], vehicles: DvrMasterItem[], drivers: DvrMasterItem[] }

const { session, authHeaders, restoreSession, showLoginPanel, expireSession } = useDvrSession()

const activeTab = ref<'states' | 'track'>('states')

// --- マスタ (事業所 / 車輌ドロップダウン) ---

const masters = ref<DvrMasters | null>(null)
const mastersError = ref<string | null>(null)
const mastersLoading = ref(false)

async function loadMasters() {
  if (!session.value || masters.value || mastersLoading.value) return
  mastersLoading.value = true
  mastersError.value = null
  try {
    masters.value = await $fetch<DvrMasters>('/dvr-api/masters', { headers: authHeaders() })
  }
  catch (e) {
    if (dvrErrorStatus(e) === 401) {
      expireSession(dvrErrorMessage(e))
      return
    }
    mastersError.value = dvrErrorMessage(e)
  }
  finally {
    mastersLoading.value = false
  }
}

/** 事業所絞込。"00000000" = 全事業所 (theearth の ddlBranch デフォルトと同値)。 */
const ALL_BRANCHES = '00000000'
const BRANCH_STORAGE_KEY = 'dvr-map-branch'

const branchOptions = computed(() => [
  { label: '全事業所', value: ALL_BRANCHES },
  ...(masters.value?.branches ?? []).map(b => ({ label: b.name, value: b.code })),
])
const vehicleOptions = computed(() =>
  (masters.value?.vehicles ?? []).map(v => ({ label: `${v.code} ${v.name}`, value: v.code })),
)

// --- 現在地 (VehicleStateTableForBranchEx) ---

// 前回選択した事業所を復元 (無ければ全事業所)。localStorage 不可でも既定にフォールバック。
const branchCode = ref(ALL_BRANCHES)
const states = ref<VehicleStatePoint[]>([])
const statesLoading = ref(false)
const statesError = ref<string | null>(null)
const statesLoaded = ref(false)
const selectedStateIndex = ref<number | null>(null)

async function loadStates() {
  if (!session.value || !branchCode.value) return
  statesLoading.value = true
  statesError.value = null
  try {
    const res = await $fetch<{ vehicles: VehicleStatePoint[] }>('/dvr-api/vehicle-states', {
      headers: authHeaders(),
      query: { branch: branchCode.value },
    })
    states.value = res.vehicles
    statesLoaded.value = true
    selectedStateIndex.value = null
  }
  catch (e) {
    if (dvrErrorStatus(e) === 401) {
      expireSession(dvrErrorMessage(e))
      return
    }
    statesError.value = dvrErrorMessage(e)
  }
  finally {
    statesLoading.value = false
  }
}

watch(branchCode, (v) => {
  try {
    localStorage.setItem(BRANCH_STORAGE_KEY, v)
  }
  catch {
    // 保存不可 (プライベートモード等) でも動作は継続
  }
  if (statesLoaded.value) loadStates()
})

/** GPS が取れている車輌のみ地図に出す。 */
const stateMarkers = computed<DvrMapMarker[]>(() =>
  states.value
    .filter(v => v.latitude != null && v.longitude != null)
    .map(v => ({
      lat: v.latitude!,
      lng: v.longitude!,
      // 元サイト (web金星号) と同じ 車番 / 乗務員 / 日時 の 3 行ラベル + 進行方向矢印。
      lines: [
        v.vehicleName ?? v.vehicleCd ?? '',
        v.driverName ?? '',
        v.dataDatetime ?? '',
      ].filter(Boolean),
      // 停車中 (Speed=0) は GPSDirection=0 (方向不定) で全車が北を向くため矢印を出さず、
      // DvrMap 側で丸マーカーにする。走行中のみ方向を渡す。
      direction: v.speed != null && v.speed > 0 ? v.direction : null,
      title: `${v.vehicleName ?? ''} ${v.dataDatetime ?? ''}`,
    })),
)

/** テーブル行 index → 地図マーカー index (GPS 無し行はマーカーに居ない)。 */
function markerIndexOfState(row: VehicleStatePoint): number | null {
  const withGps = states.value.filter(v => v.latitude != null && v.longitude != null)
  const idx = withGps.indexOf(row)
  return idx >= 0 ? idx : null
}

/** 現在地行のダブルクリック → その車輌の動態履歴 (当日) を検索して履歴タブへ。 */
function openTrackForVehicle(v: VehicleStatePoint) {
  if (!v.vehicleCd) return
  trackForm.vehicleCd = v.vehicleCd
  trackForm.startDay = todayDateInput()
  trackForm.endDay = todayDateInput()
  activeTab.value = 'track'
  loadTrack()
}

// --- 動態履歴 (VehicleStateTable) ---

/** date input (YYYY-MM-DD) の既定値 = 今日。 */
function todayDateInput(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const trackForm = reactive({
  vehicleCd: '',
  startDay: todayDateInput(),
  endDay: todayDateInput(),
})
const track = ref<VehicleLogPoint[]>([])
const trackLoading = ref(false)
const trackError = ref<string | null>(null)
const trackLoaded = ref(false)

// --- 動態履歴の行選択 (クリック / ↑↓キー) → 地図の赤ピン連動 ---

const selectedTrackIndex = ref<number | null>(null)
const trackTableEl = ref<HTMLDivElement | null>(null)

/** 選択行の地点 (GPS 無し行は null = ピンはその場に留まる)。 */
const currentTrackPoint = computed(() => {
  const i = selectedTrackIndex.value
  const p = i != null ? track.value[i] : null
  return p && p.latitude != null && p.longitude != null
    ? { lat: p.latitude, lng: p.longitude }
    : null
})

/**
 * 選択行をテーブル内部だけスクロールして表示する。
 *
 * 素の `scrollIntoView({ block: 'nearest' })` はコンテナ自体がビューポートに
 * 完全に収まっていない場合、コンテナを可視化するためにページ全体もスクロール
 * してしまう。シークのドラッグ中は `onChartSeek` が高頻度で発火し続けるため、
 * その都度ページが下に流れて画面が安定しない不具合があった。
 * `container.scrollTop` だけを直接操作し、外側のページスクロールには一切
 * 触れないようにする。
 */
function scrollTrackRowIntoView(i: number) {
  nextTick(() => {
    const container = trackTableEl.value
    const row = container?.querySelector<HTMLElement>(`[data-row="${i}"]`)
    if (!container || !row) return
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    if (rowRect.top < containerRect.top) {
      container.scrollTop += rowRect.top - containerRect.top
    }
    else if (rowRect.bottom > containerRect.bottom) {
      container.scrollTop += rowRect.bottom - containerRect.bottom
    }
  })
}

function selectTrackRow(i: number) {
  selectedTrackIndex.value = i
  // クリック直後から ↑↓ キーが効くようにフォーカスを移す
  trackTableEl.value?.focus()
  scrollTrackRowIntoView(i)
}

function moveTrackSelection(delta: number) {
  if (track.value.length === 0) return
  const cur = selectedTrackIndex.value ?? (delta > 0 ? -1 : track.value.length)
  const next = Math.min(track.value.length - 1, Math.max(0, cur + delta))
  selectedTrackIndex.value = next
  scrollTrackRowIntoView(next)
}

// --- 速度チャート (net780 の暦日チャートと同じシーク操作、DvrSpeedChart) ---

/** "MM/DD HH:mm" を naive epoch 秒に (年は検索範囲から補完。12月→1月の年跨ぎ対応)。 */
function parseTrackTs(v: string | null): number | null {
  if (!v) return null
  const m = v.match(/^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/)
  if (!m) return null
  const startYear = Number(trackForm.startDay.slice(0, 4))
  const startMonth = Number(trackForm.startDay.slice(5, 7))
  const month = Number(m[1])
  const year = month < startMonth ? startYear + 1 : startYear
  return Date.UTC(year, month - 1, Number(m[2]), Number(m[3]), Number(m[4])) / 1000
}

/** 各行の naive epoch 秒 (時刻が読めない行は null)。 */
const trackTimes = computed(() => track.value.map(p => parseTrackTs(p.dataDatetime)))

const trackSpeedPoints = computed(() => {
  const out: Array<{ ts: number, speed: number, index: number }> = []
  track.value.forEach((p, i) => {
    const ts = trackTimes.value[i]
    if (ts != null && p.speed != null) out.push({ ts, speed: p.speed, index: i })
  })
  return out
})

/** 選択中の行の時刻 (チャートのカーソル線)。 */
const currentTrackTs = computed(() => {
  const i = selectedTrackIndex.value
  return i != null ? trackTimes.value[i] ?? null : null
})

/** チャートのシーク → 最寄りの点の行を選択する (地図ピン・一覧ハイライトが連動)。 */
function onChartSeek(ts: number) {
  const pts = trackSpeedPoints.value
  if (pts.length === 0) return
  let best = pts[0]!
  for (const p of pts) {
    if (Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p
  }
  selectedTrackIndex.value = best.index
  scrollTrackRowIntoView(best.index)
}

async function loadTrack() {
  if (!session.value) return
  if (!trackForm.vehicleCd) {
    trackError.value = '車輌を選択してください'
    return
  }
  trackLoading.value = true
  trackError.value = null
  try {
    const res = await $fetch<{ points: VehicleLogPoint[] }>('/dvr-api/log-track', {
      headers: authHeaders(),
      query: {
        vehicle: trackForm.vehicleCd,
        start: trackForm.startDay.replaceAll('-', '/'),
        end: trackForm.endDay.replaceAll('-', '/'),
      },
    })
    track.value = res.points
    trackLoaded.value = true
    selectedTrackIndex.value = null
  }
  catch (e) {
    if (dvrErrorStatus(e) === 401) {
      expireSession(dvrErrorMessage(e))
      return
    }
    trackError.value = dvrErrorMessage(e)
  }
  finally {
    trackLoading.value = false
  }
}

const trackPoints = computed(() =>
  track.value
    .filter(p => p.latitude != null && p.longitude != null)
    .map(p => ({ lat: p.latitude!, lng: p.longitude! })),
)

/** 軌跡の始点・終点だけマーカーを立てる。 */
const trackMarkers = computed<DvrMapMarker[]>(() => {
  const pts = track.value.filter(p => p.latitude != null && p.longitude != null)
  if (pts.length === 0) return []
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  const markers: DvrMapMarker[] = [
    { lat: first.latitude!, lng: first.longitude!, label: `始 ${first.dataDatetime ?? ''}` },
  ]
  if (pts.length > 1) {
    markers.push({ lat: last.latitude!, lng: last.longitude!, label: `終 ${last.dataDatetime ?? ''}` })
  }
  return markers
})

// --- セッションライフサイクル ---

function onLogin() {
  loadMasters()
  if (branchCode.value) loadStates()
}

/** ログアウト / セッション切れでページ内データを破棄する。 */
watch(session, (s) => {
  if (!s) {
    masters.value = null
    mastersError.value = null
    states.value = []
    statesLoaded.value = false
    statesError.value = null
    track.value = []
    trackLoaded.value = false
    trackError.value = null
    selectedTrackIndex.value = null
  }
})

onMounted(() => {
  restoreSession()
  // 前回選択した事業所を復元 (無ければ全事業所のまま)。
  try {
    const saved = localStorage.getItem(BRANCH_STORAGE_KEY)
    if (saved) branchCode.value = saved
  }
  catch {
    // 復元不可でも既定 (全事業所) で継続
  }
  if (session.value) {
    loadMasters().then(() => {
      if (branchCode.value) loadStates()
    })
  }
  else {
    showLoginPanel.value = true
  }
})
</script>

<template>
  <!-- default レイアウト (サイドバー) 内。-m-6 で main の p-6 を打ち消しヘッダーを全幅に -->
  <div class="-m-6">
    <DvrSessionHeader title="位置情報・動態履歴" @login="onLogin" />

    <main class="max-w-7xl mx-auto p-6">
      <!-- 未ログイン: プレースホルダのみ (ログインは右上から) -->
      <div v-if="!session" class="text-center text-gray-500 mt-16">
        <UIcon name="i-lucide-map-pin" class="size-10 inline-block mb-3 opacity-60" />
        <p class="text-sm">
          右上の「ログイン」から theearth (web地球号) のアカウントでログインすると、
          自社車輌の現在地と動態履歴がここに表示されます。
        </p>
      </div>

      <template v-else>
        <div v-if="mastersError" class="flex items-center gap-3 text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-4">
          <span class="flex-1">車輌・事業所マスタの取得に失敗しました: {{ mastersError }}</span>
          <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-refresh-cw" :loading="mastersLoading" label="再取得" @click="loadMasters" />
        </div>

        <div class="flex items-center gap-2 mb-4">
          <UButton
            :variant="activeTab === 'states' ? 'solid' : 'soft'"
            icon="i-lucide-map-pin"
            label="現在地"
            @click="activeTab = 'states'"
          />
          <UButton
            :variant="activeTab === 'track' ? 'solid' : 'soft'"
            icon="i-lucide-route"
            label="動態履歴"
            @click="activeTab = 'track'"
          />
        </div>

        <!-- 現在地 -->
        <template v-if="activeTab === 'states'">
          <UCard class="mb-4">
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-semibold">車輌現在地</span>
                <USelect v-model="branchCode" :items="branchOptions" class="w-64" />
                <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-refresh-cw" :loading="statesLoading" label="更新" @click="loadStates" />
                <span class="text-xs text-gray-400">GPS 取得済み {{ stateMarkers.length }} / {{ states.length }} 台</span>
              </div>
            </template>

            <div v-if="statesError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-3">
              {{ statesError }}
            </div>

            <DvrMap :markers="stateMarkers" :selected-index="selectedStateIndex" />

            <!-- 元サイト (web金星号) の車輌一覧を参考にしたコンパクト表: 濃色ヘッダー +
                 罫線 + 縞行 + 行クリックで地図の車輌へ移動 -->
            <div class="mt-4 max-h-96 overflow-auto rounded border border-gray-300 dark:border-gray-700">
              <table class="w-full text-xs border-collapse">
                <thead class="sticky top-0 z-10">
                  <tr class="bg-slate-600 text-white dark:bg-slate-700">
                    <th class="py-1.5 px-2 text-left font-medium border-r border-slate-500">車輌名</th>
                    <th class="py-1.5 px-2 text-left font-medium border-r border-slate-500">乗務員</th>
                    <th class="py-1.5 px-2 text-center font-medium border-r border-slate-500">データ日時</th>
                    <th class="py-1.5 px-2 text-left font-medium border-r border-slate-500">作業</th>
                    <th class="py-1.5 px-2 text-right font-medium border-r border-slate-500">速度</th>
                    <th class="py-1.5 px-2 text-center font-medium">GPS</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(v, i) in states"
                    :key="`${v.vehicleCd ?? ''}-${i}`"
                    class="border-b border-gray-200 dark:border-gray-800 odd:bg-white even:bg-gray-50 dark:odd:bg-gray-900 dark:even:bg-gray-800/60"
                    :class="markerIndexOfState(v) !== null
                      ? [
                          'cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-950',
                          selectedStateIndex !== null && selectedStateIndex === markerIndexOfState(v) ? '!bg-blue-100 dark:!bg-blue-950' : '',
                        ]
                      : 'text-gray-400'"
                    :title="'ダブルクリックで当日の動態履歴を検索'"
                    @click="selectedStateIndex = markerIndexOfState(v)"
                    @dblclick="openTrackForVehicle(v)"
                  >
                    <td class="py-1 px-2 whitespace-nowrap font-medium border-r border-gray-200 dark:border-gray-800">{{ v.vehicleName ?? '-' }}</td>
                    <td class="py-1 px-2 whitespace-nowrap border-r border-gray-200 dark:border-gray-800">{{ v.driverName ?? '-' }}</td>
                    <td class="py-1 px-2 whitespace-nowrap text-center border-r border-gray-200 dark:border-gray-800">{{ v.dataDatetime ?? '-' }}</td>
                    <td class="py-1 px-2 whitespace-nowrap border-r border-gray-200 dark:border-gray-800">
                      <span v-if="v.currentWorkName" class="inline-block rounded px-1.5 py-0.5 text-[11px]" :class="v.speed && v.speed > 0 ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'">
                        {{ v.currentWorkName }}
                      </span>
                      <span v-else>-</span>
                    </td>
                    <td class="py-1 px-2 text-right whitespace-nowrap border-r border-gray-200 dark:border-gray-800" :class="v.speed && v.speed > 0 ? 'text-green-600 dark:text-green-400 font-medium' : ''">
                      {{ v.speed != null && v.dataDatetime ? `${v.speed} km/h` : '-' }}
                    </td>
                    <td class="py-1 px-2 text-center">
                      <UIcon v-if="markerIndexOfState(v) !== null" name="i-lucide-map-pin" class="size-3.5 text-blue-500" />
                      <span v-else class="text-[11px]">なし</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="statesLoaded && states.length === 0" class="text-sm text-gray-500 p-3">
                車輌がありません。
              </p>
            </div>
            <p class="text-xs text-gray-400 mt-2">
              行クリックで地図がその車輌に移動、ダブルクリックで当日の動態履歴を検索します。
            </p>
          </UCard>
        </template>

        <!-- 動態履歴 -->
        <template v-else>
          <UCard class="mb-4">
            <template #header>
              <div class="flex flex-wrap items-end gap-3">
                <span class="font-semibold self-center">動態履歴</span>
                <UFormField label="車 輌">
                  <USelectMenu
                    v-model="trackForm.vehicleCd"
                    :items="vehicleOptions"
                    value-key="value"
                    :search-input="{ placeholder: '車番/CD で検索...' }"
                    placeholder="車輌を選択"
                    class="w-56"
                  />
                </UFormField>
                <UFormField label="開始日">
                  <UInput v-model="trackForm.startDay" type="date" class="w-40" />
                </UFormField>
                <UFormField label="終了日">
                  <UInput v-model="trackForm.endDay" type="date" class="w-40" />
                </UFormField>
                <UButton icon="i-lucide-route" label="表示" :loading="trackLoading" @click="loadTrack" />
              </div>
            </template>

            <div v-if="trackError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-3">
              {{ trackError }}
            </div>

            <template v-if="trackLoaded">
              <p class="text-xs text-gray-400 mb-2">
                GPS 点数: {{ trackPoints.length }} / {{ track.length }} —
                行クリック / グラフの ←→ キー / 一覧の ↑↓ キーで赤ピンが移動します
              </p>
              <DvrMap :markers="trackMarkers" :track="trackPoints" :current="currentTrackPoint" />

              <div class="mt-4">
                <DvrSpeedChart :points="trackSpeedPoints" :current-ts="currentTrackTs" @seek="onChartSeek" @step="moveTrackSelection" />
              </div>

              <div
                ref="trackTableEl"
                tabindex="0"
                class="mt-4 max-h-96 overflow-auto rounded border border-gray-300 dark:border-gray-700 outline-none focus:ring-2 focus:ring-blue-400"
                @keydown.up.prevent="moveTrackSelection(-1)"
                @keydown.down.prevent="moveTrackSelection(1)"
              >
                <table class="w-full text-xs border-collapse">
                  <thead class="sticky top-0 z-10">
                    <tr class="bg-slate-600 text-white dark:bg-slate-700">
                      <th class="py-1.5 px-2 text-center font-medium border-r border-slate-500">データ日時</th>
                      <th class="py-1.5 px-2 text-right font-medium border-r border-slate-500">速度</th>
                      <th class="py-1.5 px-2 text-right font-medium border-r border-slate-500">回転数</th>
                      <th class="py-1.5 px-2 text-center font-medium border-r border-slate-500">状態</th>
                      <th class="py-1.5 px-2 text-center font-medium border-r border-slate-500">道路</th>
                      <th class="py-1.5 px-2 text-left font-medium">場所</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(p, i) in track"
                      :key="i"
                      :data-row="i"
                      class="border-b border-gray-200 dark:border-gray-800 cursor-pointer odd:bg-white even:bg-gray-50 dark:odd:bg-gray-900 dark:even:bg-gray-800/60 hover:bg-blue-50 dark:hover:bg-blue-950"
                      :class="selectedTrackIndex === i ? '!bg-blue-100 dark:!bg-blue-950 font-medium' : ''"
                      @click="selectTrackRow(i)"
                    >
                      <td class="py-1 px-2 whitespace-nowrap text-center border-r border-gray-200 dark:border-gray-800">{{ p.dataDatetime ?? '-' }}</td>
                      <td class="py-1 px-2 text-right whitespace-nowrap border-r border-gray-200 dark:border-gray-800" :class="p.speed && p.speed > 0 ? 'text-green-600 dark:text-green-400 font-medium' : ''">
                        {{ p.speed != null ? `${p.speed} km/h` : '-' }}
                      </td>
                      <td class="py-1 px-2 text-right whitespace-nowrap border-r border-gray-200 dark:border-gray-800">{{ p.revo != null ? p.revo : '-' }}</td>
                      <td class="py-1 px-2 text-center whitespace-nowrap border-r border-gray-200 dark:border-gray-800">{{ p.state ?? '-' }}</td>
                      <td class="py-1 px-2 text-center whitespace-nowrap border-r border-gray-200 dark:border-gray-800">{{ p.roadType ?? '-' }}</td>
                      <td class="py-1 px-2 whitespace-nowrap">
                        {{ p.address || (p.latitude != null ? `${p.latitude.toFixed(5)}, ${p.longitude?.toFixed(5)}` : 'GPSなし') }}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="track.length === 0" class="text-sm text-gray-500 p-3">
                  指定範囲の動態履歴がありません。
                </p>
              </div>
            </template>
          </UCard>
        </template>
      </template>
    </main>
  </div>
</template>
