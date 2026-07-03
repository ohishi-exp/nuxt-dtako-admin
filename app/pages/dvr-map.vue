<script setup lang="ts">
/**
 * 車輌の位置情報 (現在地) + 動態履歴 (GPS 軌跡) ページ (Refs #90)。
 *
 * theearth の VenusMain (位置情報) / F-DOV0010 (動態履歴) 相当。認証は /dvr-viewer と
 * 同じ credential pass-through (useDvrSession で共有、DO も同一 = theearth 単一
 * セッションを共用する)。座標は relay 側で DDMM → 十進度に変換済み。
 */
import type { DvrMapMarker } from '~/components/DvrMap.vue'

definePageMeta({ layout: false })

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
  currentWorkName: string | null
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
    if (!branchCode.value && masters.value.branches[0]) {
      branchCode.value = masters.value.branches[0].code
    }
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

const branchOptions = computed(() =>
  (masters.value?.branches ?? []).map(b => ({ label: b.name, value: b.code })),
)
const vehicleOptions = computed(() =>
  (masters.value?.vehicles ?? []).map(v => ({ label: `${v.code} ${v.name}`, value: v.code })),
)

// --- 現在地 (VehicleStateTableForBranchEx) ---

const branchCode = ref('')
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

watch(branchCode, () => {
  if (statesLoaded.value) loadStates()
})

/** GPS が取れている車輌のみ地図に出す。 */
const stateMarkers = computed<DvrMapMarker[]>(() =>
  states.value
    .filter(v => v.latitude != null && v.longitude != null)
    .map(v => ({
      lat: v.latitude!,
      lng: v.longitude!,
      label: v.vehicleName ?? v.vehicleCd ?? '',
      title: `${v.vehicleName ?? ''} ${v.dataDatetime ?? ''}`,
    })),
)

/** テーブル行 index → 地図マーカー index (GPS 無し行はマーカーに居ない)。 */
function markerIndexOfState(row: VehicleStatePoint): number | null {
  const withGps = states.value.filter(v => v.latitude != null && v.longitude != null)
  const idx = withGps.indexOf(row)
  return idx >= 0 ? idx : null
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
const track = ref<VehicleStatePoint[]>([])
const trackLoading = ref(false)
const trackError = ref<string | null>(null)
const trackLoaded = ref(false)

async function loadTrack() {
  if (!session.value) return
  if (!trackForm.vehicleCd) {
    trackError.value = '車輌を選択してください'
    return
  }
  trackLoading.value = true
  trackError.value = null
  try {
    const res = await $fetch<{ points: VehicleStatePoint[] }>('/dvr-api/log-track', {
      headers: authHeaders(),
      query: {
        vehicle: trackForm.vehicleCd,
        start: trackForm.startDay.replaceAll('-', '/'),
        end: trackForm.endDay.replaceAll('-', '/'),
      },
    })
    track.value = res.points
    trackLoaded.value = true
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
  }
})

onMounted(() => {
  restoreSession()
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
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
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

            <div class="overflow-x-auto mt-4 max-h-96 overflow-y-auto">
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-white dark:bg-gray-900">
                  <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                    <th class="py-2 pr-4">車輌名</th>
                    <th class="py-2 pr-4">乗務員</th>
                    <th class="py-2 pr-4">データ日時</th>
                    <th class="py-2 pr-4">作業</th>
                    <th class="py-2 pr-4">速度</th>
                    <th class="py-2">地図</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(v, i) in states"
                    :key="`${v.vehicleCd ?? ''}-${i}`"
                    class="border-b border-gray-100 dark:border-gray-900"
                  >
                    <td class="py-1.5 pr-4 whitespace-nowrap">{{ v.vehicleName ?? '-' }}</td>
                    <td class="py-1.5 pr-4">{{ v.driverName ?? '-' }}</td>
                    <td class="py-1.5 pr-4 whitespace-nowrap">{{ v.dataDatetime ?? '-' }}</td>
                    <td class="py-1.5 pr-4">{{ v.currentWorkName ?? '-' }}</td>
                    <td class="py-1.5 pr-4">{{ v.speed != null && v.dataDatetime ? `${v.speed} km/h` : '-' }}</td>
                    <td class="py-1.5">
                      <UButton
                        v-if="markerIndexOfState(v) !== null"
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-locate"
                        @click="selectedStateIndex = markerIndexOfState(v)"
                      />
                      <span v-else class="text-xs text-gray-400">GPSなし</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="statesLoaded && states.length === 0" class="text-sm text-gray-500 mt-3">
                車輌がありません。
              </p>
            </div>
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
                GPS 点数: {{ trackPoints.length }} / {{ track.length }}
              </p>
              <DvrMap :markers="trackMarkers" :track="trackPoints" />

              <div class="overflow-x-auto mt-4 max-h-96 overflow-y-auto">
                <table class="w-full text-sm">
                  <thead class="sticky top-0 bg-white dark:bg-gray-900">
                    <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                      <th class="py-2 pr-4">データ日時</th>
                      <th class="py-2 pr-4">通信日時</th>
                      <th class="py-2 pr-4">速度</th>
                      <th class="py-2">座標</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(p, i) in track"
                      :key="i"
                      class="border-b border-gray-100 dark:border-gray-900"
                    >
                      <td class="py-1.5 pr-4 whitespace-nowrap">{{ p.dataDatetime ?? '-' }}</td>
                      <td class="py-1.5 pr-4 whitespace-nowrap">{{ p.comuDatetime ?? '-' }}</td>
                      <td class="py-1.5 pr-4">{{ p.speed != null ? `${p.speed} km/h` : '-' }}</td>
                      <td class="py-1.5 text-xs text-gray-400">
                        {{ p.latitude != null ? `${p.latitude.toFixed(6)}, ${p.longitude?.toFixed(6)}` : 'GPSなし' }}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="track.length === 0" class="text-sm text-gray-500 mt-3">
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
