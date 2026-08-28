/**
 * 設定未確認車輛抽出 endpoint。
 *
 * GET /api/vehicle-settings/unconfirmed
 *
 * 1. backend (rust-alc-api) `/api/vehicles` を auth-worker `/alc-proxy`
 *    経由でフェッチ → 全車輛マスタ [{ id, tenant_id, vehicle_cd, vehicle_name }, ...]
 * 2. R2 (`DTAKO_R2`) の `vehicle-settings/` prefix を listing して
 *    dump が存在する vehicle_cd 集合を作る
 * 3. (1) - (2) = 未確認車輛
 *
 * レスポンス: [{ vehicle_cd, vehicle_name }, ...]
 * vehicle_cd でソートされて返る。
 *
 * ## path は `/api/dtako/vehicles` ではない (Refs #1033)
 *
 * **本番でこの画面は 404 だった** — `/api/dtako/vehicles` は上流に一度も存在しない。
 * `rust-alc-api` (`5df8b03`) の実体は `crates/alc-dtako/src/dtako_vehicles.rs` の
 * `route("/vehicles", get(list_vehicles))` が `src/routes/mod.rs` の tenant router に
 * merge され、`src/main.rs` が `.nest("/api", api_router)` するので **`GET /api/vehicles`**。
 * **`/api/dtako/**` という形自体は上流に在る** (`/dtako/events`, `/dtako/events/etags`,
 * `/dtako/tickets*`, `/dtako/y-time-export`)。ただし `dtako/` は router の nest では
 * なく **各モジュールが route 文字列に直書き**しており (`nest("/api/dtako` は 0 件)、
 * `alc-dtako` crate の 37 route のうち接頭辞を持つのは上記 4 系統だけ。
 * `dtako_vehicles` は持たない側なので **`dtako` を足し直さないこと。**
 *
 * **⚠ テスト (`tests/server/vehicle-settings-unconfirmed-route.test.ts`) は
 * `alcProxyFetch` を mock しているので、「この path で呼んだ」ことしか守っていない。
 * 「この path が上流に在る」は誰も見ていない** — 上流が route を消す/改名しても、
 * この repo のテストは緑のまま通り、本番だけが 404 になる。
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
 * **⇒ ここは無防備ではなく、`requireAuth` を入れる前も車輛マスタは無認証の
 * 呼び出し元には返っていない** (上流 401 がそのまま `createError({statusCode:
 * apiRes.status})` で返る)。「開いていたので塞いだ」とは書かないこと。
 *
 * それでも A 段に上げる理由が 2 つある:
 *
 * 1. **B 段の防御は上流の実装依存**で、この repo からは保証できない
 *    (`docs/plan-922-single-signin.md` §1 が `/api/ichiban/**` の項で書いている性質と
 *    同じ)。Nitro 側で確定させれば、上流が変わっても規約が残る。
 * 2. **上流 401 を待つ前に R2 list が走ってしまう** — 下の `Promise.all` は
 *    `listConfirmedVehicleCds` を並行で回すので、**未ログインの相手でも R2 の
 *    listing だけは実行される**。`requireAuth` を先に置けば止まる。
 *    **実測** (`origin/main` a05bd08 の実装に、上流が 401 を返す mock を当てた
 *    使い捨て probe。空バケツ = objects 0 件): **`r2.list` の呼び出し 1 回**。
 *    陽性対照として上流 200 でも 1 回。**「未ログインなら 0 回」ではなかった。**
 *    本番のデータ量では 1000 件ごとに cursor が 1 往復増える (ループ上限 50)。
 *    今の実装では未ログイン時 **0 回**で、
 *    `tests/server/vehicle-settings-unconfirmed-route.test.ts` が固定している。
 *
 * 呼ぶのは `/vehicle-settings/unconfirmed` の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_R2 binding 未設定
 */

import { defineEventHandler, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { VEHICLE_SETTINGS_R2_PREFIX, parseVehicleSettingsR2Key } from '~/utils/vehicle-settings-r2'
import { alcProxyFetch } from '../../utils/alc-proxy'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

interface R2Object {
  key: string
}
interface R2ListResult {
  objects: R2Object[]
  truncated: boolean
  cursor?: string
}
interface R2ListOptions {
  prefix?: string
  cursor?: string
  limit?: number
}
interface R2BucketLite {
  list(options?: R2ListOptions): Promise<R2ListResult>
}

interface CloudflareEnv {
  DTAKO_R2?: R2BucketLite
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

async function listConfirmedVehicleCds(r2: R2BucketLite): Promise<Set<string>> {
  const cds = new Set<string>()
  let cursor: string | undefined = undefined
  // R2 list は 1 回 1000 件上限。全件拾うため cursor でストリーム。
  for (let i = 0; i < 50; i += 1) {
    const res: R2ListResult = await r2.list({
      prefix: VEHICLE_SETTINGS_R2_PREFIX,
      cursor,
      limit: 1000,
    })
    for (const o of res.objects) {
      // `history.get.ts` と同じ共有パーサ。拡張子まで見るので
      // `vehicle-settings/<cd>/<dump_dir>` のような拡張子無しの key は null に
      // なるが、書き手 (`extract.post.ts` の `vehicleSettingsR2Paths`) は
      // `.json` / `.cfg` しか作らない。
      const parsed = parseVehicleSettingsR2Key(o.key)
      if (parsed) cds.add(parsed.vehicle_cd)
    }
    if (!res.truncated || !res.cursor) break
    cursor = res.cursor
  }
  return cds
}

interface DtakoVehicle {
  id: string
  tenant_id: string
  vehicle_cd: string
  vehicle_name: string
}

export interface UnconfirmedVehicle {
  vehicle_cd: string
  vehicle_name: string
}

export default defineEventHandler(async (event): Promise<UnconfirmedVehicle[]> => {
  const env = cfEnv<CloudflareEnv>(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **R2 list と上流フェッチを始める前に認証する。** 上流も未ログインを 401 に
  // するが、それを待つ間に下の `Promise.all` が R2 listing を回してしまう。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const r2 = env.DTAKO_R2
  if (!r2) {
    throw createError({
      statusCode: 503,
      statusMessage: 'R2 binding (DTAKO_R2) not available',
    })
  }

  // backend フェッチと R2 list を並行。#434 step 3 (方式 B): rust-alc-api を直叩き
  // せず auth-worker `/alc-proxy` に委譲する (OIDC mint は auth-worker、lockdown 対応)。
  const [vehiclesRes, confirmedCds] = await Promise.all([
    alcProxyFetch(event, { path: '/api/vehicles' }),
    listConfirmedVehicleCds(r2),
  ])

  if (!vehiclesRes.ok) {
    const text = await vehiclesRes.text().catch(() => '')
    throw createError({
      statusCode: vehiclesRes.status,
      statusMessage: `backend /api/vehicles エラー: ${text || vehiclesRes.statusText}`,
    })
  }
  const allVehicles = (await vehiclesRes.json()) as DtakoVehicle[]

  const unconfirmed: UnconfirmedVehicle[] = []
  for (const v of allVehicles) {
    if (!v.vehicle_cd) continue
    if (confirmedCds.has(v.vehicle_cd)) continue
    unconfirmed.push({ vehicle_cd: v.vehicle_cd, vehicle_name: v.vehicle_name ?? '' })
  }
  unconfirmed.sort((a, b) => a.vehicle_cd.localeCompare(b.vehicle_cd))
  return unconfirmed
})
