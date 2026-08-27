/**
 * R2 (`DTAKO_R2`) 上の `vehicle-settings/` prefix 配下から dump 履歴を取得する endpoint。
 *
 * GET /api/vehicle-settings/history?vehicle_cd=4437
 *   → 指定 vehicle_cd の dump 一覧 (json オブジェクトのみ、新しい順)
 *      [{ key, dump_dir, vehicle_cd, uploaded_at, size, machine_id, firm_main_app }]
 *
 * GET /api/vehicle-settings/history
 *   → 全車輛分の dump 件数集計
 *      [{ vehicle_cd, count, latest_uploaded_at }]
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ので、A 段の `requireAuth`
 * (`y-time-template.put.ts` と同じ 2 行) をここにも入れる。
 *
 * **この口は「どの車輛の設定をいつ誰が吸い出したか」の一覧**で、`vehicle_cd` /
 * `machine_id` / `firm_main_app` / 撮り込み時刻が並ぶ。実体 (`object.get.ts`) の
 * key もここから全部取れるので、**一覧が開いていれば実体も開いている**。
 * 呼ぶのは車輛設定タブ (`/vehicle-settings/history` `/vehicle-settings/diff` と
 * `VehicleSettingsDumpPicker`) の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_R2 binding 未設定
 */

import { defineEventHandler, getQuery, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { VEHICLE_SETTINGS_R2_PREFIX, parseVehicleSettingsR2Key } from '~/utils/vehicle-settings-r2'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

interface R2Object {
  key: string
  size: number
  uploaded: Date | string
  customMetadata?: Record<string, string>
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
  include?: ('customMetadata' | 'httpMetadata')[]
}
interface R2BucketLite {
  list(options?: R2ListOptions): Promise<R2ListResult>
}

interface CloudflareEnv {
  DTAKO_R2?: R2BucketLite
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

// listAll: R2 list は 1 回 1000 件上限なので cursor で全件回収
async function listAll(r2: R2BucketLite, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = []
  let cursor: string | undefined = undefined
  for (let i = 0; i < 50; i += 1) {
    const res: R2ListResult = await r2.list({
      prefix,
      cursor,
      limit: 1000,
      include: ['customMetadata'],
    })
    out.push(...res.objects)
    if (!res.truncated || !res.cursor) break
    cursor = res.cursor
  }
  return out
}

function toIso(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString()
}

export interface HistoryItem {
  key: string
  vehicle_cd: string
  dump_dir: string
  uploaded_at: string
  size: number
  machine_id: string | null
  firm_main_app: string | null
}
export interface VehicleSummary {
  vehicle_cd: string
  count: number
  latest_uploaded_at: string
}

export default defineEventHandler(
  async (event): Promise<HistoryItem[] | VehicleSummary[]> => {
    const env = cfEnv<CloudflareEnv>(event)
    const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
    if (!sharedSecret) {
      throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
    }
    const authWorkerUrl
      = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
        ? env.NUXT_PUBLIC_AUTH_WORKER_URL
        : 'https://auth.ippoan.org'
    // **一覧を出す前に認証する。** ここに並ぶ key は実体 (`object.get.ts`) の
    // 入口そのものなので、一覧を開けることは実体を開けることと同じ。
    await requireAuth(event, { authWorkerUrl, sharedSecret })

    const r2 = env.DTAKO_R2
    if (!r2) {
      throw createError({
        statusCode: 503,
        statusMessage: 'R2 binding (DTAKO_R2) not available',
      })
    }

    const { vehicle_cd } = getQuery(event)

    if (typeof vehicle_cd === 'string' && vehicle_cd) {
      // 個別車輛: vehicle-settings/<cd>/ prefix で listing。json のみ拾う
      if (!/^[A-Za-z0-9_\-]+$/.test(vehicle_cd)) {
        throw createError({
          statusCode: 400,
          statusMessage: 'vehicle_cd は英数 / _ / - のみ',
        })
      }
      const objects = await listAll(r2, `${VEHICLE_SETTINGS_R2_PREFIX}${vehicle_cd}/`)
      const items: HistoryItem[] = []
      for (const o of objects) {
        const parsed = parseVehicleSettingsR2Key(o.key)
        if (!parsed || parsed.ext !== 'json') continue
        items.push({
          key: o.key,
          vehicle_cd: parsed.vehicle_cd,
          dump_dir: parsed.dump_dir,
          uploaded_at: o.customMetadata?.uploaded_at ?? toIso(o.uploaded),
          size: o.size,
          machine_id: o.customMetadata?.machine_id ?? null,
          firm_main_app: o.customMetadata?.firm_main_app ?? null,
        })
      }
      // 新しい順
      items.sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))
      return items
    }

    // 全車輛集計: 全 prefix を listing して vehicle_cd 別に count + latest を計算
    const objects = await listAll(r2, VEHICLE_SETTINGS_R2_PREFIX)
    const summary = new Map<string, { count: number; latest: string }>()
    for (const o of objects) {
      const parsed = parseVehicleSettingsR2Key(o.key)
      if (!parsed || parsed.ext !== 'json') continue
      const uploadedAt = o.customMetadata?.uploaded_at ?? toIso(o.uploaded)
      const cur = summary.get(parsed.vehicle_cd)
      if (!cur) {
        summary.set(parsed.vehicle_cd, { count: 1, latest: uploadedAt })
      } else {
        cur.count += 1
        if (uploadedAt > cur.latest) cur.latest = uploadedAt
      }
    }
    const out: VehicleSummary[] = Array.from(summary.entries()).map(
      ([vehicle_cd, { count, latest }]) => ({
        vehicle_cd,
        count,
        latest_uploaded_at: latest,
      }),
    )
    out.sort((a, b) => a.vehicle_cd.localeCompare(b.vehicle_cd))
    return out
  },
)
