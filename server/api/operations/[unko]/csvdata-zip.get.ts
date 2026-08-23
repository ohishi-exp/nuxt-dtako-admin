/**
 * 運行 1 本の csvdata.zip (theearth F-NOS3010 が返す原本) をダウンロードさせる
 * endpoint (Refs #760 の 23)。粗利タブ (`/profit/margin`) の運行行と、地図モーダルの
 * 見出しから叩く。
 *
 * GET /api/operations/:unko/csvdata-zip[?start_ope=YYYY/MM/DD H:mm:ss]
 *   200 — zip バイナリ (`csvdata-<運行NO>.zip`。中身は KUDGFUL / KUDGIVT /
 *         KUDGURI / SokudoData の CSV。`X-Zip-Entries` に列挙も載せる)
 *   400 — 運行NO / start_ope の形式不正
 *   401 — 未ログイン (`requireAuth`)
 *   4xx/5xx — relay の応答をそのまま (status + メッセージ)
 *   502 — relay は 2xx だが zip が載っていない (1MB 超の `omitted` 含む)
 *   503 — SCRAPER_RELAY / INTERNAL_SHARED_SECRET binding 未設定
 *
 * ## なぜ server route を挟むか
 *
 * zip を取るのは relay の `POST /kintai-relay/operation-zip` (read-only、relay が
 * `DTAKO_ACCOUNTS` で theearth に自前ログインする) だが、この口の認証は
 * `X-Alc-Proxy-Secret` (= `INTERNAL_SHARED_SECRET`) の constant-time 比較で、
 * **ブラウザ経路ではない** (`worker/index.ts` の `/kintai-relay/*` 素通しはあくまで
 * worker→worker)。secret をブラウザに出さないため、Nitro 側で `requireAuth`
 * (auth-worker ログイン必須) を通してから service binding で relay を呼ぶ。
 * gate の組み方は `server/api/etc-csv/download.get.ts` と同じ (R2 read と同様、
 * backend に認証を委譲できない経路なのでここで gate する)。`requireAuth` は
 * **cookie `logi_auth_token` を優先し、無ければ `Authorization: Bearer`** を
 * auth-worker の `/auth/introspect` に掛ける (`@ippoan/auth-client` の
 * `server/auth.mjs`) ので、呼び出し側はどちらでもよい (画面は両方載せている)。
 *
 * 日報編集 (`/daily-report-edit`) の `GET /daily-report-api/zip` は同じ zip を
 * **ブラウザの theearth セッション**で取る別経路。粗利タブは theearth セッションを
 * 持たないので、そちらは使えない。
 */

import type { H3Event } from 'h3'
import { defineEventHandler, getRouterParam, getQuery, createError, setResponseHeader } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { START_OPE_RE, opeNo22FromUnkoNo, startOpeFromUnkoNo } from '../../../utils/operation-zip'

interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>
}
interface CloudflareEnv {
  SCRAPER_RELAY?: FetcherLike
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

function cfEnv(event: H3Event): CloudflareEnv {
  return (event.context.cloudflare as { env?: CloudflareEnv } | undefined)?.env ?? {}
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す
 * (`etc-csv/download.get.ts` と同実装)。 */
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

/** relay が返す zip 応答 (`operation-zip.ts` の `OperationZipPayload` 由来)。 */
interface OperationZipResponse {
  ok?: boolean
  bytes?: number
  zip_base64?: string | null
  omitted?: boolean
  limit_bytes?: number
  entries?: string[]
  error?: string
}

/** base64 (RFC 4648) を bytes に戻す。 */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** `X-Zip-Entries` に載せる zip 内ファイル名。header injection を避けるため
 * ASCII の素直な名前だけ通す (列挙は付随情報なので、落としても本体に影響しない)。 */
function safeEntries(entries: unknown): string {
  if (!Array.isArray(entries)) return ''
  return entries.filter((e): e is string => typeof e === 'string' && /^[A-Za-z0-9._/-]{1,64}$/.test(e)).join(',')
}

export default defineEventHandler(async (event) => {
  const env = cfEnv(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const unko = getRouterParam(event, 'unko') ?? ''
  const opeNo22 = opeNo22FromUnkoNo(unko)
  if (opeNo22 === null) {
    throw createError({ statusCode: 400, statusMessage: '運行NO は 22 桁または 23 桁の数値で指定してください' })
  }
  // クエリで明示された出庫日時があればそちらを優先する (運行NO から導けない
  // 運行が将来出たときの逃げ道。無ければ先頭 12 桁から組む)。
  const rawStartOpe = getQuery(event).start_ope
  const queryStartOpe = typeof rawStartOpe === 'string' && rawStartOpe !== '' ? rawStartOpe : null
  if (queryStartOpe !== null && !START_OPE_RE.test(queryStartOpe)) {
    throw createError({ statusCode: 400, statusMessage: 'start_ope は `YYYY/MM/DD H:mm:ss` (時は 0 埋めなし) で指定してください' })
  }
  const startOpe = queryStartOpe ?? startOpeFromUnkoNo(opeNo22)
  if (startOpe === null) {
    throw createError({ statusCode: 400, statusMessage: '出庫日時 (start_ope) を組み立てられません (運行NO の先頭 12 桁が日時として不正です)' })
  }

  const relay = env.SCRAPER_RELAY
  if (!relay) {
    throw createError({ statusCode: 503, statusMessage: 'SCRAPER_RELAY service binding が未設定です' })
  }

  const res = await relay.fetch('https://relay.internal/kintai-relay/operation-zip', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Alc-Proxy-Secret': sharedSecret },
    // ★ キー名は **`ope_no`**。`ope_no_22` は kyuyo-mcp の *tool 引数名* であって
    // relay の body の名前ではない (`workers/kyuyo-mcp/src/mcp/tools.ts` が
    // `ope_no: item.ope_no_22` に詰め替えている)。relay の proxy
    // (`handleOperationZip`) は body をフィールド単位で組み直さず素通しするので、
    // ここで `ope_no_22` と書くと DO の `parseOperationZipRequest`
    // (`cron-batch.ts`) が読めず **400 `comp_id / ope_no / start_ope が必要です`**
    // になる (本番 v0.0.487 で実際に踏んだ)。
    // `comp_id` は relay の proxy が `KINTAI_COMP_ID` で補完するので送らない。
    body: JSON.stringify({ ope_no: opeNo22, start_ope: startOpe }),
  })
  const data = await res.json().catch(() => null) as OperationZipResponse | null
  if (!res.ok) {
    throw createError({
      statusCode: res.status,
      statusMessage: `relay: ${data?.error ?? `csvdata.zip の取得に失敗しました (HTTP ${res.status})`}`,
    })
  }
  // 黙って空の zip を返さない (壊れた zip をダウンロードさせるより、理由を出す)。
  if (data?.ok !== true) {
    throw createError({ statusCode: 502, statusMessage: `relay の応答が ok ではありません: ${data?.error ?? '(理由不明)'}` })
  }
  if (data.omitted === true) {
    throw createError({
      statusCode: 502,
      statusMessage: `zip が ${data.bytes ?? '?'} bytes で上限 (${data.limit_bytes ?? '?'} bytes) を超えたため relay が本体を返していません`,
    })
  }
  if (typeof data.zip_base64 !== 'string') {
    throw createError({ statusCode: 502, statusMessage: 'relay の応答に zip_base64 がありません' })
  }

  const bytes = base64ToBytes(data.zip_base64)
  // `unko` は 22/23 桁の数字のみ (検証済み) なので filename に入れても header injection しない。
  setResponseHeader(event, 'content-type', 'application/zip')
  setResponseHeader(event, 'content-disposition', `attachment; filename="csvdata-${unko}.zip"`)
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseHeader(event, 'x-zip-entries', safeEntries(data.entries))
  return bytes
})
