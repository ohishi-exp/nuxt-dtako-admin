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
 * 503 — R2 binding 未設定
 */

import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'

const R2_PREFIX = 'vehicle-settings/'

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

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { DTAKO_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.DTAKO_R2 ?? null
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

// `vehicle-settings/4437/20260514_093253-0-0-4437.json` → '4437'
// `vehicle-settings/4437/20260514_093253-0-0-4437.json` → 'json' (拡張子)
function parseKey(key: string): { vehicle_cd: string; dump_dir: string; ext: string } | null {
  if (!key.startsWith(R2_PREFIX)) return null
  const rest = key.slice(R2_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const vehicle_cd = rest.slice(0, slash)
  const file = rest.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  if (dot <= 0) return null
  return { vehicle_cd, dump_dir: file.slice(0, dot), ext: file.slice(dot + 1) }
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
    const r2 = getR2Binding(event)
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
      const objects = await listAll(r2, `${R2_PREFIX}${vehicle_cd}/`)
      const items: HistoryItem[] = []
      for (const o of objects) {
        const parsed = parseKey(o.key)
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
    const objects = await listAll(r2, R2_PREFIX)
    const summary = new Map<string, { count: number; latest: string }>()
    for (const o of objects) {
      const parsed = parseKey(o.key)
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
