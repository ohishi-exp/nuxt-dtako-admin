<script setup lang="ts">
/**
 * DVR 動画ビューア (Refs #90)。
 *
 * 管理者 (auth-worker ログイン必須) が theearth-np.com のアカウントでログインして、
 * 自社の DVR ドラレコ動画 (.vdf) を閲覧するページ。
 *
 * credential pass-through 設計: パスワードはログイン 1 リクエストの body にだけ載り、
 * サーバー側 (DtakoScraperRelayDO) にも browser にも保存されない (保存したい人は
 * ブラウザのパスワードマネージャーに任せる — form は PM が拾える構造にしてある)。
 * アプリが保持するのは theearth session cookie (DO storage) とランダム token
 * (localStorage、サーバ側 TTL 8h で失効) のみ。.vdf のデコード (dtako_vid_wasm) は
 * ブラウザ内で完結する。
 */
import { decodeVdf, probeVideoDuration } from '~/utils/dtako-vid-wasm'
import type { VdfSegment } from '~/components/VdfViewer.vue'

type DvrReceiveState = 'ready' | 'requestable' | 'in_progress' | 'error' | 'unknown'

interface DvrNotification {
  raw: Record<string, unknown>
  vehicleCd: string | null
  vehicleName: string | null
  serialNo: string | null
  fileName: string | null
  filePath: string | null
  eventType: string | null
  dvrDatetime: string | null
  driverName: string | null
  latitude: number | null
  longitude: number | null
  receiveState: DvrReceiveState
}

const { session, authHeaders, restoreSession, showLoginPanel, expireSession } = useDvrSession()

/** ヘッダーでのログイン成功時 (DvrSessionHeader @login)。 */
function onLogin() {
  loadNotifications()
  loadMasters()
}

/** ログアウト / セッション切れ (session が null になったら) ページ内データを破棄する。 */
watch(session, (s) => {
  if (!s) {
    closeViewer()
    stopAutoRefresh()
    notifications.value = []
    resetSearchState()
  }
})

// --- DVR 通知一覧 ---

const notifications = ref<DvrNotification[]>([])
const listLoading = ref(false)
const listError = ref<string | null>(null)

async function loadNotifications() {
  const s = session.value
  if (!s) return
  listLoading.value = true
  listError.value = null
  try {
    const res = await $fetch<{ notifications: DvrNotification[] }>('/dvr-api/notifications', {
      headers: authHeaders(),
    })
    notifications.value = res.notifications
  }
  catch (e) {
    if (dvrErrorStatus(e) === 401) {
      expireSession(dvrErrorMessage(e))
      return
    }
    listError.value = dvrErrorMessage(e)
  }
  finally {
    listLoading.value = false
  }
}

/** 通知行の受信状態を、UI で扱いやすいラベル・色に。 */
const RECEIVE_STATE_META: Record<DvrReceiveState, { label: string, color: string }> = {
  ready: { label: '再生可能', color: 'success' },
  requestable: { label: '未受信', color: 'warning' },
  in_progress: { label: '受信中', color: 'info' },
  error: { label: 'エラー', color: 'error' },
  unknown: { label: '不明', color: 'neutral' },
}

function canView(n: DvrNotification): boolean {
  return n.receiveState === 'ready' && Boolean(n.serialNo && n.fileName)
}

function canRequest(n: DvrNotification): boolean {
  return n.receiveState === 'requestable' && Boolean(n.serialNo && n.fileName)
}

// 転送要求 (車両から取得) 中の行 (serialNo+fileName キー)
const requestingKeys = ref<Set<string>>(new Set())
function rowKey(n: DvrNotification): string {
  return `${n.serialNo ?? ''}|${n.fileName ?? ''}`
}

/** 「受信」= 車両に映像転送を要求する (1段目)。要求後は一覧を再読込して状態を追う。 */
async function requestTransfer(n: DvrNotification) {
  const s = session.value
  if (!s || !canRequest(n)) return
  const key = rowKey(n)
  requestingKeys.value = new Set(requestingKeys.value).add(key)
  listError.value = null
  try {
    await $fetch('/dvr-api/transfer', {
      method: 'POST',
      headers: authHeaders(),
      body: { serial: n.serialNo, filename: n.fileName },
    })
    // 転送は非同期。一覧を再読込した上で、receiveState の変化を自動更新で追う。
    await loadNotifications()
    startAutoRefresh('notifications')
  }
  catch (e) {
    if (dvrErrorStatus(e) === 401) {
      expireSession(dvrErrorMessage(e))
      return
    }
    listError.value = dvrErrorMessage(e)
  }
  finally {
    const next = new Set(requestingKeys.value)
    next.delete(key)
    requestingKeys.value = next
  }
}

// --- 映像検索 (Request_DvrDataList 相当、Refs #90) ---
//
// 通知一覧 (イベント発生時に届くもの) とは別に、日時範囲 + 車輌/乗務員などの条件で
// 車載機が記録した映像を検索する。結果行は通知一覧と同じ受信状態 (fa-prcs) を持つので、
// 「受信」(車両へ転送要求) →「表示」(ダウンロード + wasm デコード) のフローを共用する。
// 注意: 映像は車両走行中にのみ記録され、転送要求は車両の電源が入っていないと進まない。

interface DvrSearchRow extends DvrNotification {
  dataType: string | null
  runState: string | null
  roadType: string | null
  placeName: string | null
  speed: number | null
}

interface DvrMasterBranch { code: string, name: string }
interface DvrMasterItem { code: string, link: string | null, name: string }
interface DvrMasters { branches: DvrMasterBranch[], vehicles: DvrMasterItem[], drivers: DvrMasterItem[] }

const masters = ref<DvrMasters | null>(null)
const mastersError = ref<string | null>(null)

/** datetime-local 形式 (YYYY-MM-DDTHH:mm) の既定値 = 30 分前 (直近の映像を検索する想定)。 */
function defaultSearchStart(): string {
  const d = new Date(Date.now() - 30 * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** USelect (reka-ui) は空文字 value の item を許可しないため、「全事業所」「指定なし」
 * には sentinel を使う (branch code は "00000001" 形式、CD は数値なので衝突しない)。 */
const ALL_BRANCHES = '__all__'
const NOT_SELECTED = '__none__'

const searchForm = reactive({
  start: defaultSearchStart(),
  rangeMinutes: 30,
  branchCode: ALL_BRANCHES,
  vehicleCd: NOT_SELECTED,
  driverCd: NOT_SELECTED,
  dvrWarning: true,
  dvrAlways: true,
  dvrEmergency: true,
  runRunning: true,
  runStopped: true,
  roadGeneral: true,
  roadHighway: true,
  roadExclusive: true,
})

const searchRows = ref<DvrSearchRow[]>([])
const searchLoading = ref(false)
const searchError = ref<string | null>(null)
const searched = ref(false)

const branchOptions = computed(() => [
  { label: '全事業所', value: ALL_BRANCHES },
  ...(masters.value?.branches ?? []).map(b => ({ label: b.name, value: b.code })),
])

function masterItemOptions(items: DvrMasterItem[] | undefined): Array<{ label: string, value: string }> {
  const list = (items ?? []).filter(v => searchForm.branchCode === ALL_BRANCHES || v.link === searchForm.branchCode)
  return [{ label: '指定なし', value: NOT_SELECTED }, ...list.map(v => ({ label: `${v.code} ${v.name}`, value: v.code }))]
}

const vehicleOptions = computed(() => masterItemOptions(masters.value?.vehicles))
const driverOptions = computed(() => masterItemOptions(masters.value?.drivers))

/** 事業所を切り替えたら、絞込に合わない車輌/乗務員選択はリセットする。 */
watch(() => searchForm.branchCode, () => {
  if (!vehicleOptions.value.some(o => o.value === searchForm.vehicleCd)) searchForm.vehicleCd = NOT_SELECTED
  if (!driverOptions.value.some(o => o.value === searchForm.driverCd)) searchForm.driverCd = NOT_SELECTED
})

/** ログアウト / セッション切れ時に検索状態を破棄する (マスタはアカウント紐付きのため)。 */
function resetSearchState() {
  masters.value = null
  mastersError.value = null
  searchRows.value = []
  searched.value = false
  searchError.value = null
}

const mastersLoading = ref(false)

async function loadMasters() {
  const s = session.value
  if (!s || masters.value || mastersLoading.value) return
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

async function doSearch() {
  const s = session.value
  if (!s) return
  searchLoading.value = true
  searchError.value = null
  try {
    // datetime-local (YYYY-MM-DDTHH:mm) → theearth 形式 (YYYY/MM/DD HH:mm)
    const start = searchForm.start.replaceAll('-', '/').replace('T', ' ')
    const res = await $fetch<{ rows: DvrSearchRow[] }>('/dvr-api/search', {
      method: 'POST',
      headers: authHeaders(),
      body: {
        start,
        rangeMinutes: Number(searchForm.rangeMinutes),
        vehicleCds: searchForm.vehicleCd !== NOT_SELECTED ? searchForm.vehicleCd : undefined,
        driverCds: searchForm.driverCd !== NOT_SELECTED ? searchForm.driverCd : undefined,
        dvrTypes: { warning: searchForm.dvrWarning, always: searchForm.dvrAlways, emergency: searchForm.dvrEmergency },
        runStates: { running: searchForm.runRunning, stopped: searchForm.runStopped },
        roadTypes: { general: searchForm.roadGeneral, highway: searchForm.roadHighway, exclusive: searchForm.roadExclusive },
      },
    })
    searchRows.value = res.rows
    searched.value = true
  }
  catch (e) {
    if (dvrErrorStatus(e) === 401) {
      expireSession(dvrErrorMessage(e))
      return
    }
    searchError.value = dvrErrorMessage(e)
  }
  finally {
    searchLoading.value = false
  }
}

/** 検索結果からの「受信」。実ページ準拠で、車輌絞込検索時は MultiTarget (一括要求 API)
 * を使う。要求後は検索を再実行して受信状態の変化を見せる。 */
async function requestTransferFromSearch(n: DvrSearchRow) {
  const s = session.value
  if (!s || !canRequest(n)) return
  const key = rowKey(n)
  requestingKeys.value = new Set(requestingKeys.value).add(key)
  searchError.value = null
  try {
    const body = searchForm.vehicleCd !== NOT_SELECTED
      ? { serials: [n.serialNo], filenames: [n.fileName] }
      : { serial: n.serialNo, filename: n.fileName }
    await $fetch('/dvr-api/transfer', { method: 'POST', headers: authHeaders(), body })
    await doSearch()
    startAutoRefresh('search')
  }
  catch (e) {
    if (dvrErrorStatus(e) === 401) {
      expireSession(dvrErrorMessage(e))
      return
    }
    searchError.value = dvrErrorMessage(e)
  }
  finally {
    const next = new Set(requestingKeys.value)
    next.delete(key)
    requestingKeys.value = next
  }
}

// --- 受信進捗の自動更新 ---
//
// 「受信」(車両への転送要求) は非同期で、完了は一覧の receiveState 変化でしか
// 観測できない (実ページも cfg_conn_interval 秒ごとに Refresh_DvrDataList を poll
// している)。受信要求後に対象一覧を定期再読込し、受信待ちの行が無くなったら止める。

const AUTO_REFRESH_INTERVAL_MS = 15_000
const AUTO_REFRESH_MAX_MS = 30 * 60_000

const autoRefreshTimer = ref<ReturnType<typeof setInterval> | null>(null)
const autoRefreshStartedAt = ref(0)
const autoRefreshTarget = ref<'search' | 'notifications' | null>(null)

function stopAutoRefresh() {
  if (autoRefreshTimer.value) clearInterval(autoRefreshTimer.value)
  autoRefreshTimer.value = null
  autoRefreshTarget.value = null
}

function startAutoRefresh(target: 'search' | 'notifications') {
  stopAutoRefresh()
  autoRefreshTarget.value = target
  autoRefreshStartedAt.value = Date.now()
  autoRefreshTimer.value = setInterval(autoRefreshTick, AUTO_REFRESH_INTERVAL_MS)
}

async function autoRefreshTick() {
  if (!session.value || Date.now() - autoRefreshStartedAt.value > AUTO_REFRESH_MAX_MS) {
    stopAutoRefresh()
    return
  }
  if (autoRefreshTarget.value === 'search') {
    if (searchLoading.value) return
    await doSearch()
    // 受信中の行が無くなったら (全て再生可能 / エラーに落ち着いたら) 停止
    if (!searchRows.value.some(r => r.receiveState === 'in_progress')) stopAutoRefresh()
  }
  else if (autoRefreshTarget.value === 'notifications') {
    if (listLoading.value) return
    await loadNotifications()
    if (!notifications.value.some(n => n.receiveState === 'in_progress')) stopAutoRefresh()
  }
}

// --- ビューア (VdfViewer 共通部品 = vid-check 基準。Refs #90) ---
//
// ダウンロードした .vdf をブラウザ内 wasm でデコードし、VdfSegment (1 ファイル分) に
// して VdfViewer に渡す。再生 / 前方・後方切替 / 区間ループ / クリップ等の機能は
// すべて VdfViewer 側 (= vid-check と同一) に共通化されている。

const viewingFileName = ref<string | null>(null)
const videoLoading = ref(false)
const videoError = ref<string | null>(null)
const viewerSegments = ref<VdfSegment[]>([])

function closeViewer() {
  for (const seg of viewerSegments.value) {
    if (seg.frontUrl) URL.revokeObjectURL(seg.frontUrl)
    if (seg.rearUrl) URL.revokeObjectURL(seg.rearUrl)
  }
  viewerSegments.value = []
  viewingFileName.value = null
  videoError.value = null
}

async function openNotification(n: DvrNotification) {
  const s = session.value
  if (!s || !canView(n)) return
  videoLoading.value = true
  videoError.value = null
  try {
    const params = new URLSearchParams({
      serial: n.serialNo!,
      filename: n.fileName!,
    })
    const buf = await $fetch<ArrayBuffer>(`/dvr-api/file?${params.toString()}`, {
      headers: authHeaders(),
      responseType: 'arrayBuffer',
    })
    const fileSize = buf.byteLength
    const result = await decodeVdf(new Uint8Array(buf))
    closeViewer()
    const frontUrl = result.hasFront ? URL.createObjectURL(new Blob([result.frontMp4], { type: 'video/mp4' })) : null
    const rearUrl = result.hasRear ? URL.createObjectURL(new Blob([result.rearMp4], { type: 'video/mp4' })) : null
    const probeUrl = frontUrl || rearUrl
    const duration = probeUrl ? await probeVideoDuration(probeUrl) : 0
    viewerSegments.value = [{
      fileName: n.fileName ?? '',
      fileSize,
      frontUrl,
      rearUrl,
      telemetry: result.telemetry,
      duration,
    }]
    viewingFileName.value = n.fileName
  }
  catch (e) {
    if (dvrErrorStatus(e) === 401) {
      expireSession(dvrErrorMessage(e))
      return
    }
    videoError.value = dvrErrorMessage(e)
  }
  finally {
    videoLoading.value = false
  }
}

onMounted(() => {
  restoreSession()
  if (session.value) {
    loadNotifications()
    loadMasters()
  }
  else {
    showLoginPanel.value = true
  }
})

onBeforeUnmount(() => {
  stopAutoRefresh()
  closeViewer()
})
</script>

<template>
  <!-- default レイアウト (サイドバー) 内。-m-6 で main の p-6 を打ち消しヘッダーを全幅に -->
  <div class="-m-6">
    <DvrSessionHeader title="DVR 動画ビューア" @login="onLogin" />

    <main class="max-w-7xl mx-auto p-6">
      <!-- 未ログイン: 本文はプレースホルダのみ (ログインは右上から) -->
      <div v-if="!session" class="text-center text-gray-500 mt-16">
        <UIcon name="i-lucide-cctv" class="size-10 inline-block mb-3 opacity-60" />
        <p class="text-sm">
          右上の「ログイン」から theearth (web地球号) のアカウントでログインすると、
          自社の DVR ドラレコ動画がここに表示されます。
        </p>
      </div>

      <!-- ログイン後: 取得したデータ (通知一覧 + ビューア) -->
      <template v-else>
        <UCard class="mb-4">
          <template #header>
            <div class="flex items-center gap-3">
              <span class="font-semibold">DVR 動画通知</span>
              <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-refresh-cw" :loading="listLoading" label="再読込" @click="loadNotifications" />
              <template v-if="autoRefreshTarget === 'notifications'">
                <span class="inline-flex items-center gap-1.5 text-xs text-blue-500">
                  <UIcon name="i-lucide-loader-circle" class="animate-spin size-3.5" />
                  受信状況を自動更新中 (15秒ごと)
                </span>
                <UButton size="xs" color="neutral" variant="ghost" label="停止" @click="stopAutoRefresh" />
              </template>
            </div>
          </template>

          <div v-if="listError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-3">
            {{ listError }}
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                  <th class="py-2 pr-4">日時</th>
                  <th class="py-2 pr-4">車両CD</th>
                  <th class="py-2 pr-4">車両名</th>
                  <th class="py-2 pr-4">イベント</th>
                  <th class="py-2 pr-4">運転者</th>
                  <th class="py-2 pr-4">状態</th>
                  <th class="py-2">動画</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(n, i) in notifications"
                  :key="`${n.fileName ?? ''}-${i}`"
                  class="border-b border-gray-100 dark:border-gray-900"
                  :class="viewingFileName && n.fileName === viewingFileName ? 'bg-blue-50 dark:bg-blue-950' : ''"
                >
                  <td class="py-2 pr-4 whitespace-nowrap">{{ n.dvrDatetime ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.vehicleCd ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.vehicleName ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.eventType ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.driverName ?? '-' }}</td>
                  <td class="py-2 pr-4">
                    <UBadge size="xs" variant="soft" :color="RECEIVE_STATE_META[n.receiveState].color as any">
                      {{ RECEIVE_STATE_META[n.receiveState].label }}
                    </UBadge>
                  </td>
                  <td class="py-2">
                    <!-- 再生可能 → 表示 (ダウンロード + デコード再生) -->
                    <UButton
                      v-if="canView(n)"
                      size="xs"
                      icon="i-lucide-play"
                      label="表示"
                      :loading="videoLoading && viewingFileName !== n.fileName"
                      :disabled="videoLoading"
                      @click="openNotification(n)"
                    />
                    <!-- 未受信 → 受信 (車両へ映像転送を要求) -->
                    <UButton
                      v-else-if="canRequest(n)"
                      size="xs"
                      color="warning"
                      variant="soft"
                      icon="i-lucide-download-cloud"
                      label="受信"
                      :loading="requestingKeys.has(rowKey(n))"
                      @click="requestTransfer(n)"
                    />
                    <!-- 受信中 → 状態のみ (再読込で追う) -->
                    <span v-else-if="n.receiveState === 'in_progress'" class="text-xs text-gray-400">受信中...</span>
                    <span v-else class="text-gray-400">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="!listLoading && notifications.length === 0" class="text-sm text-gray-500 mt-3">
            DVR 動画通知がありません。
          </p>
        </UCard>

        <!-- 映像検索 (日時範囲 + 車輌/乗務員などの条件で車載機の記録映像を検索) -->
        <UCard class="mb-4">
          <template #header>
            <div class="flex items-center gap-3">
              <UIcon name="i-lucide-search" class="size-4" />
              <span class="font-semibold">映像検索</span>
              <template v-if="autoRefreshTarget === 'search'">
                <span class="inline-flex items-center gap-1.5 text-xs text-blue-500">
                  <UIcon name="i-lucide-loader-circle" class="animate-spin size-3.5" />
                  受信状況を自動更新中 (15秒ごと)
                </span>
                <UButton size="xs" color="neutral" variant="ghost" label="停止" @click="stopAutoRefresh" />
              </template>
            </div>
          </template>

          <div v-if="mastersError" class="flex items-center gap-3 text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-3">
            <span class="flex-1">車輌・乗務員マスタの取得に失敗しました: {{ mastersError }}</span>
            <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-refresh-cw" :loading="mastersLoading" label="再取得" @click="loadMasters" />
          </div>

          <form class="space-y-3" @submit.prevent="doSearch">
            <div class="flex flex-wrap items-end gap-3">
              <UFormField label="開始日時">
                <UInput v-model="searchForm.start" type="datetime-local" class="w-52" />
              </UFormField>
              <UFormField label="範囲 [分]">
                <UInput v-model.number="searchForm.rangeMinutes" type="number" min="1" max="1440" class="w-24" />
              </UFormField>
              <UFormField label="事業所">
                <USelect v-model="searchForm.branchCode" :items="branchOptions" class="w-56" />
              </UFormField>
              <!-- USelectMenu は検索ボックス内蔵 (車番/CD/名前の手入力で絞り込める) -->
              <UFormField label="車 輌">
                <USelectMenu
                  v-model="searchForm.vehicleCd"
                  :items="vehicleOptions"
                  value-key="value"
                  :search-input="{ placeholder: '車番/CD で検索...' }"
                  class="w-56"
                />
              </UFormField>
              <UFormField label="乗務員">
                <USelectMenu
                  v-model="searchForm.driverCd"
                  :items="driverOptions"
                  value-key="value"
                  :search-input="{ placeholder: '名前/CD で検索...' }"
                  class="w-56"
                />
              </UFormField>
            </div>

            <div class="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div class="flex items-center gap-3">
                <span class="text-gray-500">映像種別:</span>
                <label class="flex items-center gap-1"><input v-model="searchForm.dvrWarning" type="checkbox" class="rounded"> 警告</label>
                <label class="flex items-center gap-1"><input v-model="searchForm.dvrAlways" type="checkbox" class="rounded"> 常時</label>
                <label class="flex items-center gap-1"><input v-model="searchForm.dvrEmergency" type="checkbox" class="rounded"> 緊急ボタン</label>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-gray-500">走行状態:</span>
                <label class="flex items-center gap-1"><input v-model="searchForm.runRunning" type="checkbox" class="rounded"> 走行中</label>
                <label class="flex items-center gap-1"><input v-model="searchForm.runStopped" type="checkbox" class="rounded"> 停車中</label>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-gray-500">道路種別:</span>
                <label class="flex items-center gap-1"><input v-model="searchForm.roadGeneral" type="checkbox" class="rounded"> 一般道</label>
                <label class="flex items-center gap-1"><input v-model="searchForm.roadHighway" type="checkbox" class="rounded"> 高速道</label>
                <label class="flex items-center gap-1"><input v-model="searchForm.roadExclusive" type="checkbox" class="rounded"> 専用道</label>
              </div>
            </div>

            <div class="flex items-center gap-3">
              <UButton type="submit" icon="i-lucide-search" label="検索" :loading="searchLoading" />
              <span class="text-xs text-gray-400">
                車輌・乗務員のいずれかを指定してください。映像は車両の走行中にのみ記録され、
                受信 (車両からの取得) は車両の電源が入っている間のみ進行します。
              </span>
            </div>
          </form>

          <div v-if="searchError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mt-3">
            {{ searchError }}
          </div>

          <div v-if="searched" class="overflow-x-auto mt-4">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                  <th class="py-2 pr-4">映像日時</th>
                  <th class="py-2 pr-4">車輌名</th>
                  <th class="py-2 pr-4">乗務員</th>
                  <th class="py-2 pr-4">映像種別</th>
                  <th class="py-2 pr-4">走行</th>
                  <th class="py-2 pr-4">道路</th>
                  <th class="py-2 pr-4">地点</th>
                  <th class="py-2 pr-4">状態</th>
                  <th class="py-2">動画</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(n, i) in searchRows"
                  :key="`${n.fileName ?? ''}-${i}`"
                  class="border-b border-gray-100 dark:border-gray-900"
                  :class="viewingFileName && n.fileName === viewingFileName ? 'bg-blue-50 dark:bg-blue-950' : ''"
                >
                  <td class="py-2 pr-4 whitespace-nowrap">{{ n.dvrDatetime ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.vehicleName ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.driverName ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.dataType ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.runState ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.roadType ?? '-' }}</td>
                  <td class="py-2 pr-4">{{ n.placeName ?? '-' }}</td>
                  <td class="py-2 pr-4">
                    <UBadge size="xs" variant="soft" :color="RECEIVE_STATE_META[n.receiveState].color as any">
                      {{ RECEIVE_STATE_META[n.receiveState].label }}
                    </UBadge>
                  </td>
                  <td class="py-2">
                    <UButton
                      v-if="canView(n)"
                      size="xs"
                      icon="i-lucide-play"
                      label="表示"
                      :loading="videoLoading && viewingFileName !== n.fileName"
                      :disabled="videoLoading"
                      @click="openNotification(n)"
                    />
                    <UButton
                      v-else-if="canRequest(n)"
                      size="xs"
                      color="warning"
                      variant="soft"
                      icon="i-lucide-download-cloud"
                      label="受信"
                      :loading="requestingKeys.has(rowKey(n))"
                      @click="requestTransferFromSearch(n)"
                    />
                    <span v-else-if="n.receiveState === 'in_progress'" class="text-xs text-gray-400">受信中...</span>
                    <span v-else class="text-gray-400">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="!searchLoading && searchRows.length === 0" class="text-sm text-gray-500 mt-3">
              指定された条件に該当する映像情報がありません。条件を変更して再度検索してください。
            </p>
          </div>
        </UCard>

        <div v-if="videoLoading" class="text-sm text-gray-400 mb-4">
          <UIcon name="i-lucide-loader-circle" class="animate-spin size-4 inline-block mr-1" />
          動画を取得・デコード中... (ファイルサイズによっては時間がかかります)
        </div>
        <div v-if="videoError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-4">
          {{ videoError }}
        </div>

        <!-- ビューア (VdfViewer 共通部品 = vid-check と同一機能: 前方/後方切替・
             結合タイムライン・区間ループ・クリップダウンロード) -->
        <VdfViewer
          v-if="viewerSegments.length > 0"
          :segments="viewerSegments"
          :file-label="viewingFileName"
        />
      </template>
    </main>
  </div>
</template>
