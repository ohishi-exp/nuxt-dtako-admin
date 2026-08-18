<script setup lang="ts">
/**
 * 社内の RemoteApp をブラウザの中で描画して操作する画面 (Refs #693)。
 *
 * WASM クライアント (IronRDP) が RDP を喋り、WebSocket は **Cloudflare Access が守る
 * 中継の公開ホスト名** (`NUXT_PUBLIC_RDP_RELAY_URL` の `/rdp`) へ直接張る。Worker は
 * データ経路に居ない。中継は `Cf-Access-Jwt-Assertion` を自分で検証する。
 *
 * WebSocket は 302 を辿れないので、**接続前に Access の cookie を確保する**
 * (`app/utils/rdp-access.ts`)。旧経路の `/ws/rdp` (Worker が introspect して VPC
 * binding へ繋ぐ) は切り戻し先として残してあるが、中継が cf-access モードの間は通らない。
 *
 * **配置先ごとの値はこのリポジトリに書かない。** 宛先・ドメイン・RemoteApp は中継の
 * `/defaults` が配り (権威は中継の `--allow` と site の env)、画面はそれを初期値に入れる。
 * 読めなければ入力欄の値 (localStorage) をそのまま使う。パスワードは記憶しない。
 */
import { browserDeps, ensureAccessSession, fetchRdpDefaults, probeAccessSession, rdpWsUrl } from '~/utils/rdp-access'

/** 中継の公開ホスト名 (`wss://…`)。Access がここを守る。 */
const rdpRelayUrl = (useRuntimeConfig().public.rdpRelayUrl as string) || ''

/** パスワード以外は記憶する。再接続のたびに全部打ち直すのは現実的でないため。 */
const STORAGE_KEY = 'remote-app:form:v1'

const form = reactive({
  destination: '',
  username: '',
  domain: '',
  /** publish 済み RemoteApp のエイリアス (`||ALIAS`)。空ならフルデスクトップ。
   * **repo には持たない** — 配置先ごとの設定なので入力欄で受けて localStorage に記憶する。 */
  remoteApp: '',
  width: 1920,
  height: 920,
})
/** **記憶しない。** */
const password = ref('')

const status = ref('未接続')
const errorText = ref('')
const connecting = ref(false)
const connected = ref(false)
const screenHost = ref<HTMLElement | null>(null)

/** Access を通れるか。`null` は未確認。接続の前に分かっていると案内が出せる。 */
const accessReady = ref<boolean | null>(null)

onMounted(async () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (saved) Object.assign(form, saved)
  }
  catch { /* 壊れていたら既定のまま */ }

  // 接続先が無いと WebSocket の URL を組めない。案内は connect() で出す。
  if (!rdpRelayUrl) return
  accessReady.value = await probeAccessSession(rdpWsUrl(rdpRelayUrl), browserDeps())
  // Access を通れているなら既定値も読める。押す前に欄が埋まっている方が親切。
  if (accessReady.value) await applyDefaults()
})

/**
 * 中継が配る既定値を欄に入れる (Refs #693)。
 *
 * **宛先は中継の値で上書きする。** 中継は `--allow` で唯一の宛先を知っていて、
 * 違う値を送れば「許可されていない宛先」で閉じられるだけなので、権威は向こうにある。
 * ドメインと RemoteApp は**空のときだけ**入れる — 利用者が選んだ値 (フルデスクトップ
 * にするために空にした、等) を消さないため。
 *
 * 読めなければ何もしない (古い中継・未ログイン・CORS 未設定はすべて同じ扱い)。
 */
async function applyDefaults() {
  const defaults = await fetchRdpDefaults(rdpRelayUrl)
  if (!defaults) return
  if (defaults.destination) form.destination = defaults.destination
  if (!form.domain && defaults.domain) form.domain = defaults.domain
  if (!form.remoteApp && defaults.remoteApp) form.remoteApp = defaults.remoteApp
}

function remember() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...form }))
  }
  catch { /* 記憶できなくても接続はできる */ }
}

/**
 * 例外の中身を文字列にする。
 *
 * IronRDP が投げる `IronError` は **`Error` ではない**ので `String(e)` だと
 * `[object Object]` になり、実機で理由が一切分からなかった。
 */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  const iron = e as { backtrace?: () => string, kind?: () => unknown }
  if (typeof iron?.backtrace === 'function') {
    const kind = typeof iron.kind === 'function' ? `${String(iron.kind())}: ` : ''
    return kind + String(iron.backtrace())
  }
  try {
    return JSON.stringify(e) ?? String(e)
  }
  catch {
    return String(e)
  }
}

/** 印刷ジョブを組み立ててブラウザに落とす。RemoteApp 側は PDF ドライバへ印刷する。 */
function makePrintSink() {
  const jobs = new Map<number, Uint8Array[]>()
  return {
    onJobStart: (fileId: number) => jobs.set(fileId, []),
    onJobData: (fileId: number, chunk: Uint8Array) => {
      const buf = jobs.get(fileId)
      if (buf) buf.push(chunk)
      else jobs.set(fileId, [chunk])
    },
    onJobComplete: (fileId: number) => {
      const chunks = jobs.get(fileId) ?? []
      jobs.delete(fileId)
      const blob = new Blob(chunks as BlobPart[], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      // 新しいタブで開く。保存はブラウザの PDF ビューアに任せる。
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    onJobError: (fileId: number) => {
      jobs.delete(fileId)
      errorText.value = '印刷ジョブが失敗しました'
    },
  }
}

async function connect() {
  errorText.value = ''
  if (!rdpRelayUrl) { errorText.value = '中継の接続先が未設定です (NUXT_PUBLIC_RDP_RELAY_URL)'; return }

  connecting.value = true
  try {
    // **クリック直後にやる。** cookie が無ければここでログイン画面 (別窓) を開くので、
    // wasm の読み込みを先にやると transient activation が切れてブロックされる。
    status.value = 'Cloudflare Access を確認中…'
    await ensureAccessSession(rdpRelayUrl)
    accessReady.value = true

    // 初回 (cookie が無くて mount 時に読めなかった) はここで埋まる。
    await applyDefaults()
    if (!form.destination) { errorText.value = '接続先を入れてください'; return }

    status.value = 'クライアントを読み込み中…'
    // wasm を含むので client 側でだけ読み込む。SSR には載せない。
    await import('@devolutions/iron-remote-desktop')
    const rdp = await import('@devolutions/iron-remote-desktop-rdp')

    // **wasm の初期化。忘れると `__wbindgen_malloc` の undefined 参照で落ちる。**
    // Backend を触る前に一度だけ呼ぶ必要がある (デモクライアントも onMount でやっている)。
    // ページを再訪すると setup は再実行されるので、フラグは window に置く。
    const w = window as unknown as { __ironRdpInit?: Promise<void> }
    w.__ironRdpInit ??= rdp.init('INFO')
    await w.__ironRdpInit

    status.value = '接続中…'
    remember()

    // 要素は JS で作る。Vue のテンプレートに custom element を書くと
    // `module` が属性 (文字列) として渡ってしまうため。
    const el = document.createElement('iron-remote-desktop') as HTMLElement & {
      module?: unknown
    }
    el.setAttribute('scale', 'fit')
    el.setAttribute('flexcenter', 'true')
    // **カスタム要素には既定のスタイルが無い。** 指定しないと display:inline /
    // width:auto のまま 0x0 になり、canvas (1920x920) が画面外へ押し出される
    // (実機で「繋がっているのに何も映らない」になった)。
    el.style.display = 'block'
    el.style.width = '100%'
    el.style.height = '100%'
    el.module = rdp.Backend
    screenHost.value?.replaceChildren(el)

    const userInteraction: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('クライアントが起動しませんでした')), 30_000)
      el.addEventListener('ready', (e) => {
        clearTimeout(timer)
        resolve((e as CustomEvent).detail.irgUserInteraction)
      }, { once: true })
    })

    // 中継へ直接張る。認証は Access の cookie が持つので、URL に資格情報は載せない
    // (中継の `/rdp` はクエリを一切読まない — `rust-ichibanboshi` の `rdp_relay.rs`)。
    const proxyAddress = rdpWsUrl(rdpRelayUrl)

    const configBuilder = userInteraction
      .configBuilder()
      .withUsername(form.username)
      .withPassword(password.value)
      .withDestination(form.destination)
      .withProxyAddress(proxyAddress)
      .withServerDomain(form.domain)
      // 利用者の認証は Access が済ませている。RDCleanPath の欄は空にできないので印を入れる。
      .withAuthToken('via-access')
      .withDesktopSize({ width: form.width, height: form.height })
      .withExtension(rdp.displayControl(true))
      .withExtension(rdp.printJobStreamCallbacks(makePrintSink()))
      .withExtension(rdp.printerName('Browser Printer'))
      .withExtension(rdp.printerDriverName(rdp.PrinterDriverName.MicrosoftPrintToPdf))

    // 空ならフルデスクトップ。RemoteApp を出すときだけ RAIL を開ける。
    if (form.remoteApp) configBuilder.withExtension(rdp.remoteApp(form.remoteApp))

    const config = configBuilder.build()

    const session = await userInteraction.connect(config)

    // **`connect()` はセッションを走らせない。** 返ってきた `run()` を呼ばないと
    // クライアントは何も送らず、サーバーが十数秒で黙って切る (実機で再現した)。
    userInteraction.setVisibility(true)

    // 画面に残さない。ここから先はサーバー側のセッションが持っている。
    password.value = ''
    connected.value = true
    status.value = '接続中'

    // `run()` はセッションが終わるまで解決しない。await で待つと画面が出せないので繋がない。
    session
      .run()
      .then((info: { reason?: () => string }) => {
        status.value = `切断 (${info?.reason?.() ?? '正常終了'})`
      })
      .catch((e: unknown) => {
        status.value = '切断'
        errorText.value = describeError(e)
      })
      .finally(() => {
        connected.value = false
      })
  }
  catch (e) {
    errorText.value = describeError(e)
    status.value = '切断'
    connected.value = false
  }
  finally {
    connecting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col h-full gap-3 p-3">
    <h1 class="text-lg font-semibold">
      リモートアプリ
    </h1>

    <form v-if="!connected" class="flex flex-wrap items-end gap-3" @submit.prevent="connect">
      <label class="flex flex-col text-sm">
        接続先
        <input v-model="form.destination" class="border rounded px-2 py-1" placeholder="host:port">
      </label>
      <label class="flex flex-col text-sm">
        ユーザー名
        <input v-model="form.username" class="border rounded px-2 py-1" autocomplete="username">
      </label>
      <label class="flex flex-col text-sm">
        ドメイン
        <input v-model="form.domain" class="border rounded px-2 py-1">
      </label>
      <label class="flex flex-col text-sm">
        アプリ (空でデスクトップ)
        <input v-model="form.remoteApp" class="border rounded px-2 py-1" placeholder="||ALIAS">
      </label>
      <label class="flex flex-col text-sm">
        パスワード
        <input
          v-model="password" type="password" class="border rounded px-2 py-1"
          autocomplete="current-password"
        >
      </label>
      <button
        type="submit" :disabled="connecting"
        class="border rounded px-3 py-1 disabled:opacity-50"
      >
        {{ connecting ? '接続中…' : '接続' }}
      </button>
      <span class="text-sm opacity-70">{{ status }}</span>
    </form>

    <p v-if="accessReady === false" class="text-sm opacity-70">
      Cloudflare Access に未ログインです。「接続」を押すとログイン画面が別窓で開きます
      (ポップアップを許可してください)。
    </p>

    <p v-if="errorText" class="text-sm text-red-600">
      {{ errorText }}
    </p>

    <div ref="screenHost" class="flex-1 min-h-0 bg-neutral-800" />
  </div>
</template>
