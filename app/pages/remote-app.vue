<script setup lang="ts">
/**
 * 社内の RemoteApp をブラウザの中で描画して操作する画面 (Refs #693)。
 *
 * WASM クライアント (IronRDP) が RDP を喋り、WebSocket は同一オリジンの `/ws/rdp` へ張る。
 * その先は Worker が Workers VPC binding で社内の中継へ繋ぎ替える (`rdp-relay-proxy.ts`)。
 *
 * **接続先とパスワードはこのリポジトリに書かない。** 接続先は入力欄 (localStorage に
 * 記憶)、パスワードは毎回入力で記憶しない。この repo は public。
 */
import { useAuth } from '@ippoan/auth-client'

const { token } = useAuth()

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

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (saved) Object.assign(form, saved)
  }
  catch { /* 壊れていたら既定のまま */ }
})

function remember() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...form }))
  }
  catch { /* 記憶できなくても接続はできる */ }
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
  if (!form.destination) { errorText.value = '接続先を入れてください'; return }
  if (!token.value) { errorText.value = 'ログインし直してください (token が無い)'; return }

  connecting.value = true
  status.value = 'クライアントを読み込み中…'
  try {
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

    // WebSocket は同一オリジン。Access の cookie も別ホストの証明書も要らない。
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const proxyAddress
      = `${scheme}://${location.host}/ws/rdp?token=${encodeURIComponent(token.value)}`

    const configBuilder = userInteraction
      .configBuilder()
      .withUsername(form.username)
      .withPassword(password.value)
      .withDestination(form.destination)
      .withProxyAddress(proxyAddress)
      .withServerDomain(form.domain)
      // 中継は Worker 側で認証済み。RDCleanPath の欄は空にできないので印を入れる。
      .withAuthToken('via-worker')
      .withDesktopSize({ width: form.width, height: form.height })
      .withExtension(rdp.displayControl(true))
      .withExtension(rdp.printJobStreamCallbacks(makePrintSink()))
      .withExtension(rdp.printerName('Browser Printer'))
      .withExtension(rdp.printerDriverName(rdp.PrinterDriverName.MicrosoftPrintToPdf))

    // 空ならフルデスクトップ。RemoteApp を出すときだけ RAIL を開ける。
    if (form.remoteApp) configBuilder.withExtension(rdp.remoteApp(form.remoteApp))

    const config = configBuilder.build()

    await userInteraction.connect(config)

    // 画面に残さない。ここから先はサーバー側のセッションが持っている。
    password.value = ''
    connected.value = true
    status.value = '接続中'
  }
  catch (e) {
    errorText.value = e instanceof Error ? e.message : String(e)
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

    <p v-if="errorText" class="text-sm text-red-600">
      {{ errorText }}
    </p>

    <div ref="screenHost" class="flex-1 min-h-0 bg-neutral-800" />
  </div>
</template>
