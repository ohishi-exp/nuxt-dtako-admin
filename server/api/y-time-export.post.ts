/**
 * Y時間 Excel 追記エクスポート (Cloudflare Worker 上で実行される Nitro server route)。
 *
 * 1. body から `{ driver_cd, from, to, template_key }` を受け取る
 * 2. backend (rust-alc-api) `/api/dtako/y-time-export` を auth-worker `/alc-proxy`
 *    経由で叩いて JSON 取得 (OIDC mint は auth-worker、Cloud Run IAM lockdown 対応)
 * 3. R2 binding (`env.DTAKO_R2`) でテンプレ xlsx を fetch
 * 4. ExcelJS で Y時間 シートに書き込み
 * 5. xlsx binary を octet-stream で return
 *
 * R2 binding がない (ローカル `nuxt dev` 等) 環境では明示的に 503 を返す。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * **ここは D 段 (認可ゼロ) ではなく B 段だった** — `alcProxyFetch` が browser JWT を
 * cookie / `Authorization: Bearer` から拾って転送し、上流の auth-worker `/alc-proxy`
 * が **token 不在を fail-closed で 401 にする** (`ippoan/auth-worker@dd220b2`
 * `src/handlers/alc-proxy.ts` の `if (!token) return jsonError(401, "Unauthorized")`)。
 * `X-Alc-Proxy-Secret` は consumer proof であって身元ではないので、secret だけでは
 * 通らない。**`/api/ichiban/**` (Service Token を無条件に付け、呼び出し元の身元を
 * 一切見ない) とは型が違う** — 誤読しやすいのでここに書いておく。
 *
 * それでも A 段に上げる: **B 段の防御は上流の実装依存**で、この repo からは
 * 保証できない (`docs/plan-922-single-signin.md` §1 が `/api/ichiban/**` の項で
 * 書いている性質と同じ)。Nitro 側で確定させれば、上流が変わっても規約が残る。
 * ここが返す xlsx は**乗務員 1 人の日別 拘束/運転/休憩 の実データ**なので、
 * 「Access を通れる誰か」ではなく「ログインしている人」に限る。
 * 呼ぶのは Y時間 タブ (`/y-time-export`) の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 * **書き口 (`y-time-template.put.ts`) と読み口 (`y-time-template.get.ts`) が
 * 認証を要求するのに、テンプレを使って出力する側だけ素通し**、という食い違いも
 * ここで解消する。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_R2 binding 未設定
 */

import {
  defineEventHandler,
  readBody,
  createError,
  setResponseHeader,
} from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import type { YTimeExportResponse } from '~/types'
import { writeYTimeRows, buildFilename } from '~/utils/y-time-xlsx'
import { alcProxyFetch } from '../utils/alc-proxy'
import { cfEnv, resolveSecret } from '../utils/cf-env'

interface RequestBody {
  driver_cd: string
  from: string
  to: string
  template_key: string
}

interface R2ObjectMinimal {
  arrayBuffer(): Promise<ArrayBuffer>
}
interface R2BucketMinimal {
  get(key: string): Promise<R2ObjectMinimal | null>
}
interface CloudflareEnv {
  DTAKO_R2?: R2BucketMinimal
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

export default defineEventHandler(async (event) => {
  // nitro-cloudflare-pages / cloudflare-module で `event.context.cloudflare.env` に bindings が入る
  const env = cfEnv<CloudflareEnv>(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **body を読む前・上流を叩く前に認証する。**
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const body = await readBody<RequestBody>(event)
  if (!body || !body.driver_cd || !body.from || !body.to || !body.template_key) {
    throw createError({
      statusCode: 400,
      statusMessage: 'driver_cd / from / to / template_key are required',
    })
  }
  if (!body.template_key.startsWith('templates/')) {
    throw createError({
      statusCode: 400,
      statusMessage: 'template_key must start with "templates/"',
    })
  }

  // 1. backend JSON 取得 — #434 step 3 (方式 B): rust-alc-api を直叩きせず
  //    auth-worker `/alc-proxy` に委譲する。introspect / ACL / OIDC mint /
  //    identity 注入は auth-worker 側で行われ、Cloud Run IAM lockdown 後も通る。
  const apiRes = await alcProxyFetch(event, {
    path: '/api/dtako/y-time-export',
    query: { driver_cd: body.driver_cd, from: body.from, to: body.to },
  })
  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => '')
    throw createError({
      statusCode: apiRes.status,
      statusMessage: `backend error: ${text || apiRes.statusText}`,
    })
  }
  const data = (await apiRes.json()) as YTimeExportResponse

  // 2. R2 binding でテンプレ取得
  const r2 = env.DTAKO_R2
  if (!r2) {
    throw createError({
      statusCode: 503,
      statusMessage:
        'R2 binding (DTAKO_R2) not available. Deploy via wrangler or set up local R2 binding.',
    })
  }
  const tplObj = await r2.get(body.template_key)
  if (!tplObj) {
    throw createError({
      statusCode: 404,
      statusMessage: `template not found in R2: ${body.template_key}`,
    })
  }
  const tplBytes = await tplObj.arrayBuffer()

  // 3. xlsx 生成 — 期間内の旧データを書き込み前にクリアして、テンプレ汚染を除去する
  const result = await writeYTimeRows(tplBytes, data.rows, {
    clearPeriod: { from: body.from, to: body.to },
  })

  if (result.missingDates.length > 0) {
    // dev でデバッグしやすいよう warning header にも入れる (本文 binary なので)
    setResponseHeader(
      event,
      'x-y-time-missing-dates',
      result.missingDates.slice(0, 30).join(','),
    )
  }
  if (data.warnings.length > 0) {
    setResponseHeader(
      event,
      'x-y-time-warnings',
      // ASCII safe にだけ落とす (ヘッダーに日本語を直接入れると 500 になる ので URI encode)
      encodeURIComponent(data.warnings.slice(0, 5).join(' / ')),
    )
  }

  // 4. response
  setResponseHeader(
    event,
    'content-type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  setResponseHeader(
    event,
    'content-disposition',
    `attachment; filename="${buildFilename(body.driver_cd, body.from, body.to)}"`,
  )
  return result.bytes
})
