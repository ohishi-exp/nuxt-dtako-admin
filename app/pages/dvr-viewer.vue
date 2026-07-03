<script setup lang="ts">
/**
 * DVR 動画ビューア (Refs #90)。
 *
 * theearth-np.com のアカウントを持つ利用者が **自分の credential でログイン** して、
 * 自社の DVR ドラレコ動画 (.vdf) を閲覧するページ。管理画面の auth-worker ログインは
 * 使わない (auth.global.ts の publicPaths に登録、layout も独立)。
 *
 * credential pass-through 設計: パスワードはログイン 1 リクエストの body にだけ載り、
 * サーバー側 (DtakoScraperRelayDO) にも browser にも保存されない (保存したい人は
 * ブラウザのパスワードマネージャーに任せる — form は PM が拾える構造にしてある)。
 * アプリが保持するのは theearth session cookie (DO storage) とランダム token
 * (localStorage、サーバ側 TTL 8h で失効) のみ。.vdf のデコード (dtako_vid_wasm) は
 * ブラウザ内で完結する。
 */
import { decodeVdf, probeVideoDuration } from '~/utils/dtako-vid-wasm'
import type { VdfTelemetry } from '~/utils/dtako-vid-wasm'

definePageMeta({ layout: false })

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
}

interface DvrSession {
  compId: string
  userName: string
  token: string
}

const SESSION_STORAGE_KEY = 'dvr-viewer-session'

/** 前回ログインした会社ID/ユーザーID (パスワード以外) のプリフィル用。
 * パスワードマネージャーが覚えるのは username+password の 1 組だけなので、
 * 会社ID はこちらで補完する。 */
const LAST_ACCOUNT_KEY = 'dvr-viewer-last-account'

/** ヘッダー右上のログインパネル開閉。未ログインで開くと本文はデータ用に空ける。 */
const showLoginPanel = ref(false)

/** UTF-8 文字列を base64url (padding 無し) に encode する。relay worker 側の
 * dvr-session.ts の encodeDvrUserB64 と同一形式 (ヘッダに日本語を載せるため)。 */
function b64urlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fetchErrorMessage(e: unknown): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data
  if (data && typeof data.error === 'string') return data.error
  return e instanceof Error ? e.message : String(e)
}

function fetchErrorStatus(e: unknown): number | null {
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

// --- セッション ---

const session = ref<DvrSession | null>(null)
const form = reactive({ compId: '', userName: '', userPass: '' })
const loggingIn = ref(false)
const loginError = ref<string | null>(null)

function routingHeaders(compId: string, userName: string): Record<string, string> {
  return {
    'X-Dvr-Comp-Id': compId,
    'X-Dvr-User-B64': b64urlUtf8(userName),
  }
}

function authHeaders(s: DvrSession): Record<string, string> {
  return {
    ...routingHeaders(s.compId, s.userName),
    'Authorization': `Bearer ${s.token}`,
  }
}

function persistSession(s: DvrSession | null) {
  session.value = s
  try {
    // token はブラウザを閉じても保持する (localStorage)。パスワードは保存しない。
    if (s) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_STORAGE_KEY)
  }
  catch {
    // localStorage 不可 (プライベートモード等) でも動作は継続する (再読込で再ログイン)
  }
}

/** 401 (token/theearth セッション切れ) を受けた時の共通処理。 */
function expireSession(message: string) {
  persistSession(null)
  closeViewer()
  notifications.value = []
  loginError.value = message
  showLoginPanel.value = true
}

async function doLogin() {
  if (!form.compId || !form.userName || !form.userPass) {
    loginError.value = '会社ID / ユーザーID / パスワードをすべて入力してください'
    return
  }
  loggingIn.value = true
  loginError.value = null
  try {
    const res = await $fetch<{ token: string }>('/dvr-api/login', {
      method: 'POST',
      headers: routingHeaders(form.compId, form.userName),
      body: { user_pass: form.userPass },
    })
    persistSession({ compId: form.compId, userName: form.userName, token: res.token })
    try {
      localStorage.setItem(LAST_ACCOUNT_KEY, JSON.stringify({ compId: form.compId, userName: form.userName }))
    }
    catch {
      // プリフィルは best-effort
    }
    form.userPass = ''
    showLoginPanel.value = false
    await loadNotifications()
  }
  catch (e) {
    loginError.value = fetchErrorMessage(e)
  }
  finally {
    loggingIn.value = false
  }
}

async function doLogout() {
  const s = session.value
  if (s) {
    try {
      await $fetch('/dvr-api/logout', { method: 'POST', headers: authHeaders(s) })
    }
    catch {
      // best-effort (セッションが既に切れていても手元は消す)
    }
  }
  persistSession(null)
  closeViewer()
  notifications.value = []
  loginError.value = null
  showLoginPanel.value = true
}

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
      headers: authHeaders(s),
    })
    notifications.value = res.notifications
  }
  catch (e) {
    if (fetchErrorStatus(e) === 401) {
      expireSession(fetchErrorMessage(e))
      return
    }
    listError.value = fetchErrorMessage(e)
  }
  finally {
    listLoading.value = false
  }
}

function canView(n: DvrNotification): boolean {
  return Boolean(n.serialNo && n.vehicleCd && n.fileName)
}

// --- ビューア (vid-check.vue の単一ファイル版) ---

const viewingFileName = ref<string | null>(null)
const videoLoading = ref(false)
const videoError = ref<string | null>(null)
const frontUrl = ref<string | null>(null)
const rearUrl = ref<string | null>(null)
const telemetry = ref<VdfTelemetry | null>(null)
const duration = ref(0)
const currentTime = ref(0)

const frontVideoEl = ref<HTMLVideoElement | null>(null)
const rearVideoEl = ref<HTMLVideoElement | null>(null)

function closeViewer() {
  if (frontUrl.value) URL.revokeObjectURL(frontUrl.value)
  if (rearUrl.value) URL.revokeObjectURL(rearUrl.value)
  frontUrl.value = null
  rearUrl.value = null
  telemetry.value = null
  viewingFileName.value = null
  videoError.value = null
  duration.value = 0
  currentTime.value = 0
}

async function openNotification(n: DvrNotification) {
  const s = session.value
  if (!s || !canView(n)) return
  videoLoading.value = true
  videoError.value = null
  try {
    const params = new URLSearchParams({
      support_id: n.serialNo!,
      vehicle_cd: n.vehicleCd!,
      filename: n.fileName!,
    })
    const buf = await $fetch<ArrayBuffer>(`/dvr-api/file?${params.toString()}`, {
      headers: authHeaders(s),
      responseType: 'arrayBuffer',
    })
    const result = await decodeVdf(new Uint8Array(buf))
    closeViewer()
    frontUrl.value = result.hasFront ? URL.createObjectURL(new Blob([result.frontMp4], { type: 'video/mp4' })) : null
    rearUrl.value = result.hasRear ? URL.createObjectURL(new Blob([result.rearMp4], { type: 'video/mp4' })) : null
    telemetry.value = result.telemetry
    viewingFileName.value = n.fileName
    const probeUrl = frontUrl.value || rearUrl.value
    duration.value = probeUrl ? await probeVideoDuration(probeUrl) : 0
  }
  catch (e) {
    if (fetchErrorStatus(e) === 401) {
      expireSession(fetchErrorMessage(e))
      return
    }
    videoError.value = fetchErrorMessage(e)
  }
  finally {
    videoLoading.value = false
  }
}

function onTimeUpdate(e: Event) {
  currentTime.value = (e.target as HTMLVideoElement).currentTime
}

function onSeek(seconds: number) {
  for (const el of [frontVideoEl.value, rearVideoEl.value]) {
    if (el) el.currentTime = seconds
  }
  currentTime.value = seconds
}

onMounted(() => {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (raw) session.value = JSON.parse(raw) as DvrSession
  }
  catch {
    session.value = null
  }
  try {
    const rawLast = localStorage.getItem(LAST_ACCOUNT_KEY)
    if (rawLast) {
      const last = JSON.parse(rawLast) as { compId?: string, userName?: string }
      form.compId = last.compId ?? ''
      form.userName = last.userName ?? ''
    }
  }
  catch {
    // プリフィルは best-effort
  }
  if (session.value) loadNotifications()
  else showLoginPanel.value = true
})

onBeforeUnmount(closeViewer)
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <header class="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 sticky top-0 z-20">
      <div class="max-w-7xl mx-auto px-6 py-3 flex flex-wrap items-center gap-3">
        <h1 class="text-lg font-bold">
          DVR 動画ビューア
        </h1>
        <div class="flex-1" />

        <!-- 右上: ログイン状態表示 + ボタン -->
        <template v-if="session">
          <span class="inline-flex items-center gap-1.5 text-sm rounded-full px-3 py-1 bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300">
            <span class="size-2 rounded-full bg-green-500" />
            ログイン中: {{ session.compId }} / {{ session.userName }}
          </span>
          <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-log-out" label="ログアウト" @click="doLogout" />
        </template>
        <template v-else>
          <span class="inline-flex items-center gap-1.5 text-sm rounded-full px-3 py-1 bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            <span class="size-2 rounded-full bg-gray-400" />
            未ログイン
          </span>
          <UButton
            size="sm"
            icon="i-lucide-log-in"
            :label="showLoginPanel ? '閉じる' : 'ログイン'"
            @click="showLoginPanel = !showLoginPanel"
          />
        </template>
      </div>

      <!-- 右上から出るログインパネル (未ログイン時のみ) -->
      <div v-if="!session && showLoginPanel" class="absolute right-4 top-full mt-2 w-96 max-w-[calc(100vw-2rem)] z-30">
        <UCard class="shadow-xl">
          <template #header>
            <span class="font-semibold">theearth (web地球号) にログイン</span>
          </template>
          <!-- name/autocomplete はブラウザのパスワードマネージャーが username+password を
               保存・自動入力できるようにするためのもの (会社ID は PM の対象外なので
               localStorage の前回値プリフィルで補完する)。 -->
          <form method="post" class="space-y-3" @submit.prevent="doLogin">
            <UFormField label="会社ID">
              <UInput v-model="form.compId" name="organization" autocomplete="organization" placeholder="例: 27324455" class="w-full" />
            </UFormField>
            <UFormField label="ユーザーID">
              <UInput v-model="form.userName" name="username" autocomplete="username" class="w-full" />
            </UFormField>
            <UFormField label="パスワード">
              <UInput v-model="form.userPass" name="password" type="password" autocomplete="current-password" class="w-full" />
            </UFormField>
            <div v-if="loginError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
              {{ loginError }}
            </div>
            <UButton type="submit" block :loading="loggingIn" label="ログイン" />
          </form>
          <p class="text-xs text-gray-400 mt-3">
            入力した ID / パスワードは theearth へのログインにその場で 1 回だけ使われ、
            このサービスには保存されません。theearth 側は同一アカウントの同時ログインを
            許可しないため、他の場所でログイン中のセッションは切断されることがあります。
          </p>
        </UCard>
      </div>
    </header>

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

        <div v-if="videoLoading" class="text-sm text-gray-400 mb-4">
          <UIcon name="i-lucide-loader-circle" class="animate-spin size-4 inline-block mr-1" />
          動画を取得・デコード中... (ファイルサイズによっては時間がかかります)
        </div>
        <div v-if="videoError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-4">
          {{ videoError }}
        </div>

        <!-- ビューア (vid-check.vue の単一ファイル簡易版。デコードはブラウザ内 wasm) -->
        <template v-if="telemetry">
          <UCard class="mb-4">
            <div class="flex flex-wrap gap-6 text-sm">
              <div><span class="text-gray-500">ファイル:</span> <span class="font-medium">{{ viewingFileName }}</span></div>
              <div><span class="text-gray-500">車両コード:</span> <span class="font-medium">{{ telemetry.vehicle || '(なし)' }}</span></div>
              <div><span class="text-gray-500">乗務員コード:</span> <span class="font-medium">{{ telemetry.driver || '(なし)' }}</span></div>
            </div>
          </UCard>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <UCard>
              <template #header>
                前方映像
              </template>
              <div class="relative overflow-hidden rounded-lg bg-black">
                <video
                  v-if="frontUrl"
                  ref="frontVideoEl"
                  :src="frontUrl"
                  controls
                  class="w-full h-auto block"
                  @timeupdate="onTimeUpdate"
                />
                <p v-else class="text-sm text-gray-400 py-8 text-center">前方映像なし</p>
              </div>
            </UCard>

            <UCard>
              <template #header>
                後方映像
              </template>
              <div class="relative overflow-hidden rounded-lg bg-black">
                <video
                  v-if="rearUrl"
                  ref="rearVideoEl"
                  :src="rearUrl"
                  controls
                  class="w-full h-auto block"
                  @timeupdate="onTimeUpdate"
                />
                <p v-else class="text-sm text-gray-400 py-8 text-center">後方映像なし</p>
              </div>
            </UCard>

            <UCard>
              <template #header>
                GPS 軌跡
              </template>
              <VidMap :gps="telemetry.gps" :telemetry="telemetry" :current-time="currentTime" />
            </UCard>
          </div>

          <UCard>
            <template #header>
              Gセンサー・速度・回転数 (クリック/ドラッグでシーク)
            </template>
            <VidTelemetryChart
              :g="telemetry.g"
              :speed-rpm="telemetry.speed_rpm"
              :telemetry="telemetry"
              :duration="duration"
              :current-time="currentTime"
              @seek="onSeek"
            />
          </UCard>
        </template>
      </template>
    </main>
  </div>
</template>
