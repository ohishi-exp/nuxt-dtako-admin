/**
 * 給油データ USB アップローダー (Windows アプリ ohishi-exp/fuel-usb-uploader) が Basic で名乗る
 * 資格情報 (purpose `fuel-utran`) の型・呼び出し・表示用の変換 (Refs yhonda-ohishi/nginx#814)。
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

/** 名前 (label) の最大長 (auth-worker の MACHINE_CRED_LABEL_MAX と同じ) */
export const LABEL_MAX = 64

/** 発行・rotate の直後に password と並べて出す文 */
export const ONE_TIME_NOTICE
  = 'この表示を閉じると password は二度と見られません。Windows アプリ (給油データ USB アップローダー) の『資格情報を設定』に入れてください'

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

export function createMachineCredentialApi(fetcher: Fetcher, authWorkerUrl: string) {
  return {
    async list(): Promise<MachineCredential[]> {
      return toCredentialList(await fetcher<unknown>(listUrl(authWorkerUrl), { query: { purpose: PURPOSE } }))
    },
    issue(label: string): Promise<IssuedCredential> {
      return fetcher<IssuedCredential>(listUrl(authWorkerUrl), { method: 'POST', body: { purpose: PURPOSE, label: label.trim() } })
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

/** 名前の問題を文にする (問題なしは null) */
export function labelError(raw: string): string | null {
  const v = raw.trim()
  if (v === '') return 'PC 名を入れてください'
  if (v.length > LABEL_MAX) return `PC 名は ${LABEL_MAX} 文字以内にしてください`
  return null
}

/**
 * 管理 API の失敗を画面の文にする。403 は管理者以外、404 は rotate・revoke の対象が無い
 * (`notFoundIsMissing`)。それ以外は dtako 共通の `describeCaughtError` (通信失敗・5xx 等)。
 * 401 は fetcher 側でログインし直しへ飛ばすので、ここには来ても共通の文で足りる。
 */
export function credentialErrorText(e: unknown, retry: string, notFoundIsMissing = false): string {
  const status = caughtErrorStatus(e)
  if (status === 403) return '管理者だけが使えます'
  if (status === 404 && notFoundIsMissing) return 'この資格情報は失効しているか見つかりません'
  return describeCaughtError(e, retry)
}

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
