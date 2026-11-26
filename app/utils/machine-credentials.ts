/**
 * 給油データ USB アップローダー (Windows アプリ ohishi-exp/fuel-usb-uploader) が Basic で名乗る
 * 資格情報 (purpose `fuel-utran`) の型・呼び出し・表示用の変換 (Refs yhonda-ohishi/nginx#814)。
 * 複合機の `etc-scan` (ETC コーポレートカード発行明細書のスキャン送信、Refs #1287) も同じ部品
 * (`app/components/MachineCredentials.vue`) で扱い、こちらは `/etc-cards` で発行する。
 *
 * 管理 API は auth-worker にあり、画面のブラウザから `{authWorkerUrl}/api/machine-credentials` を
 * 直接 (cross-origin で) 叩く。Bearer は dtako の browser JWT。管理者 (role=admin) 以外は 403。
 * password は発行・rotate の応答で 1 回だけ返る (auth-worker は hash しか持たない)。
 * fetch の実体は引数で受ける (画面は $fetch、テストは偽物)。
 *
 * ★ ohishi-exp/nuxt-leave の `app/utils/machine-credentials.ts` (purpose `leave-scan`) と重複している。
 * 共有の置き場 (`@ippoan/auth-client` 等) が無いので PURPOSE だけ変えた最小の移植。共有化は別件。
 */
import { caughtErrorStatus, describeCaughtError } from '~/utils/api-error'

export const PURPOSE = 'fuel-utran'

/**
 * 用途 (Refs #1287)。画面ごとに固定で使う — `fuel-utran` は `/fuel/credentials`、
 * `etc-scan` (複合機が ETC コーポレートカード発行明細書のスキャンを送るときに名乗る資格情報) は `/etc-cards`。
 * 用途の allowlist の正本は auth-worker の `MACHINE_CRED_PURPOSES`。
 */
export const PURPOSES = ['fuel-utran', 'etc-scan'] as const
export type Purpose = (typeof PURPOSES)[number]

/** 用途ごとの表示 (部品 `MachineCredentials` が文をそのまま出す。組み立てない) */
export interface PurposeText {
  /** 一覧の上の 1 文 (誰が何に使うか) */
  intro: string
  /** 発行の欄の上の説明 */
  guide: string
  /** 発行・rotate 直後の password の注意 */
  notice: string
  /** 名前の欄・表の見出し */
  nameLabel: string
  /** 名前の欄の説明 (末尾に文字数の上限を足す) */
  nameHint: string
  namePlaceholder: string
  /** rotate の確認の末尾 */
  rotateNote: string
  /** 失効の確認の末尾 */
  revokeNote: string
}

export const PURPOSE_TEXT: Record<Purpose, PurposeText> = {
  'fuel-utran': {
    intro: 'Windows アプリ (給油データ USB アップローダー) が送信に使う username / password です。PC ごとに発行してください。',
    guide: '発行すると username と password が 1 回だけ表示されます。Windows アプリのトレイのアイコンを右クリック →『資格情報を設定』に入れてください',
    notice: 'この表示を閉じると password は二度と見られません。Windows アプリ (給油データ USB アップローダー) の『資格情報を設定』に入れてください',
    nameLabel: 'PC 名',
    nameHint: 'どの PC 用か分かる名前',
    namePlaceholder: '例: 本社 給油室の PC',
    rotateNote: 'PC に新しいパスワードを入れ直すまで送信できません。',
    revokeNote: 'この PC からは送信できなくなります。',
  },
  'etc-scan': {
    intro: '複合機が ETC カード明細書のスキャンを送るときに使う username / password です。複合機ごとに発行してください。',
    guide: '発行すると username と password が 1 回だけ、複合機の設定例と一緒に表示されます。複合機の送信先 (WebDAV) に入れてください',
    notice: 'この表示を閉じると password は二度と見られません。複合機の送信先 (WebDAV) の認証情報に入れてください',
    nameLabel: '機器名',
    nameHint: 'どの複合機用か分かる名前',
    namePlaceholder: '例: 本社 2F の複合機',
    rotateNote: '複合機に新しいパスワードを入れ直すまで送信できません。',
    revokeNote: 'この複合機からは送信できなくなります。',
  },
}

/** 名前 (label) の最大長 (auth-worker の MACHINE_CRED_LABEL_MAX と同じ) */
export const LABEL_MAX = 64

/** 発行・rotate の直後に password と並べて出す文 */
export const ONE_TIME_NOTICE = PURPOSE_TEXT['fuel-utran'].notice

/** fetch の実体 ($fetch と同じ形の部分集合) */
export type Fetcher = <T>(url: string, options?: {
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
  query?: Record<string, string>
}) => Promise<T>

/** 一覧の 1 行 (password も hash も返らない) */
export interface MachineCredential {
  username: string
  purpose: string
  label: string
  /** ISO 8601 */
  created_at: string
  revoked: boolean
}

/** 発行・rotate の応答。password はこの 1 回しか取れない */
export interface IssuedCredential {
  username: string
  password: string
}

/** 末尾の `/` を落とした auth-worker の基点 URL */
function base(authWorkerUrl: string): string {
  return `${authWorkerUrl.replace(/\/+$/, '')}/api/machine-credentials`
}

export function listUrl(authWorkerUrl: string): string {
  return base(authWorkerUrl)
}

export function revokeUrl(authWorkerUrl: string, username: string): string {
  return `${base(authWorkerUrl)}/${encodeURIComponent(username)}/revoke`
}

export function rotateUrl(authWorkerUrl: string, username: string): string {
  return `${base(authWorkerUrl)}/${encodeURIComponent(username)}/rotate`
}

/** 一覧の応答は配列か `{ credentials: [...] }` のどちらでも受ける */
export function toCredentialList(res: unknown): MachineCredential[] {
  const rows = Array.isArray(res)
    ? res
    : (res && typeof res === 'object' && Array.isArray((res as { credentials?: unknown }).credentials))
        ? (res as { credentials: unknown[] }).credentials
        : []
  return (rows as MachineCredential[]).filter(r => r && typeof r.username === 'string')
}

export function createMachineCredentialApi(fetcher: Fetcher, authWorkerUrl: string, purpose: Purpose = PURPOSE) {
  return {
    async list(): Promise<MachineCredential[]> {
      return toCredentialList(await fetcher<unknown>(listUrl(authWorkerUrl), { query: { purpose } }))
    },
    issue(label: string): Promise<IssuedCredential> {
      return fetcher<IssuedCredential>(listUrl(authWorkerUrl), { method: 'POST', body: { purpose, label: label.trim() } })
    },
    revoke(username: string): Promise<unknown> {
      return fetcher(revokeUrl(authWorkerUrl, username), { method: 'POST' })
    },
    /** username はそのまま password だけ新しくする (旧 password は即失効)。新しい password はこの応答だけ */
    rotate(username: string): Promise<IssuedCredential> {
      return fetcher<IssuedCredential>(rotateUrl(authWorkerUrl, username), { method: 'POST' })
    },
  }
}

export type MachineCredentialApi = ReturnType<typeof createMachineCredentialApi>

/** 名前の問題を文にする (問題なしは null)。`name` は欄の名前 (既定 `PC 名`) */
export function labelError(raw: string, name = 'PC 名'): string | null {
  const v = raw.trim()
  if (v === '') return `${name}を入れてください`
  if (v.length > LABEL_MAX) return `${name}は ${LABEL_MAX} 文字以内にしてください`
  return null
}

/**
 * auth-worker が本文の `error` に入れるコードごとの文 (Refs yhonda-ohishi/nginx#814)。
 * コード (英語) は画面に出さない — 押した人が次に何をすればいいかだけを書く。
 * `invalid_label` / `invalid_purpose` は 400、`store_failed` は 502 (保存先の失敗)。
 */
const CODE_TEXT: Record<string, string> = {
  invalid_label: `PC 名を 1〜${LABEL_MAX} 文字で入れてください`,
  store_failed: '資格情報を保存できませんでした。時間をおいてもう一度試し、続くときは管理者に連絡してください',
  invalid_purpose: 'この種類の資格情報は発行できません (設定の不足)。管理者に連絡してください',
}

/** 失敗の本文 (`$fetch` の `e.data`) の `error` コードが既知なら、その文。無ければ null */
export function errorCodeText(e: unknown): string | null {
  const code = (e as { data?: { error?: unknown } } | null)?.data?.error
  return typeof code === 'string' && Object.hasOwn(CODE_TEXT, code) ? CODE_TEXT[code]! : null
}

/**
 * 管理 API の失敗を画面の文にする。403 は管理者以外、404 は rotate・revoke の対象が無い
 * (`notFoundIsMissing`)、既知のコードはその文 ({@link errorCodeText})。
 * それ以外は dtako 共通の `describeCaughtError` (通信失敗・401・5xx 等)。
 * 401 は fetcher 側でログインし直しへ飛ばすので、ここには来ても共通の文で足りる。
 */
export function credentialErrorText(e: unknown, retry: string, notFoundIsMissing = false): string {
  const status = caughtErrorStatus(e)
  if (status === 403) return '管理者だけが使えます'
  if (status === 404 && notFoundIsMissing) return 'この資格情報は失効しているか見つかりません'
  return errorCodeText(e) ?? describeCaughtError(e, retry)
}

/**
 * 「発行」の失敗の文。{@link credentialErrorText} と同じ枝に加えて、status は読めたが
 * コードを知らない失敗を「発行できませんでした (HTTP <status>)」にする — 共通の文の
 * 「上の理由のとおりに直して」は、理由がコード (英語) しか無いと何を直すのか分からないため。
 * 通信失敗 (status 無し) と 401・403 は共通の文のまま (次の一手が決まっている)。
 */
export function issueErrorText(e: unknown): string {
  const status = caughtErrorStatus(e)
  if (status === null || status === 401 || status === 403 || errorCodeText(e) !== null) {
    return credentialErrorText(e, 'もう一度「発行」を押してください')
  }
  return `発行できませんでした (HTTP ${status})`
}

/** 発行の前に入力欄の上に出す説明 */
export const ISSUE_GUIDE = PURPOSE_TEXT['fuel-utran'].guide

/** 作成日を `YYYY-MM-DD` (日本時間) で出す。読めなければそのまま */
export function formatIssuedDate(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 10)
}

/** 有効なものを先に、それぞれ新しい順 */
export function sortCredentials(rows: MachineCredential[]): MachineCredential[] {
  return [...rows].sort((a, b) => {
    if (a.revoked !== b.revoked) return a.revoked ? 1 : -1
    return b.created_at.localeCompare(a.created_at)
  })
}

/** 複合機に入れる設定値 */
export interface DeviceSetup {
  protocol: string
  host: string
  folder: string
  username: string
  password: string
  curl: string
}

/** auth-worker の機械用の入口 (Basic を照合して dtako の /dav へ中継する、Refs #1287) */
export const MACHINE_ENTRY = '/m/etc-scan'

/** 複合機のフォルダ。会社は資格情報だけで決まるので、残りのパスは何でもよい */
export const MACHINE_FOLDER = `${MACHINE_ENTRY}/scan`

/**
 * 発行直後に出す複合機の設定例と、PC から試す curl (`etc-scan` 用)。
 * host は auth-worker (本番 https://auth.ippoan.org / staging https://auth-staging.ippoan.org)。
 *
 * ohishi-exp/nuxt-leave の `app/utils/machine-credentials.ts` の `deviceSetup` / `deviceSetupRows` と
 * 同形 (入口が `/m/leave-scan` か `/m/etc-scan` かだけが違う)。共有の置き場が無いので写した。
 */
export function deviceSetup(authWorkerUrl: string, cred: IssuedCredential): DeviceSetup {
  const host = authWorkerUrl.replace(/\/+$/, '')
  const folder = MACHINE_FOLDER
  return {
    protocol: 'WebDAV',
    host,
    folder,
    username: cred.username,
    password: cred.password,
    curl: `curl -T test.pdf -u ${cred.username}:${cred.password} ${host}${folder}/test.pdf`,
  }
}

/** 設定例を「項目名・値」の行にする (画面はこの順に並べ、値ごとにコピーできる)。nuxt-leave と同形 */
export function deviceSetupRows(d: DeviceSetup): [string, string][] {
  return [
    ['プロトコル', d.protocol],
    ['ホスト名', d.host],
    ['フォルダへのパス', d.folder],
    ['ユーザー名', d.username],
    ['パスワード', d.password],
  ]
}

/** 発行・rotate の直後に設定例を出すか。複合機 (`etc-scan`) だけ — Windows アプリは username / password だけ入れる */
export function deviceSetupFor(purpose: Purpose, authWorkerUrl: string, cred: IssuedCredential): DeviceSetup | null {
  return purpose === 'etc-scan' ? deviceSetup(authWorkerUrl, cred) : null
}
