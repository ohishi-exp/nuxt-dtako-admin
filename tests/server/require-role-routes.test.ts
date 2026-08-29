import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * **配線の陽性/陰性対照** (Refs #1004)。
 *
 * `require-role.test.ts` は helper 単体の振る舞いを見るだけで、**route に実際に
 * 繋がっているか**は 1 つも検査していない。カバレッジが緑でも
 * 「`assertAllowedRole(auth)` の行が実行された」までしか言えず、
 * **非許可 role が本当に止まるか**は別問題なので、ここで route ごとに測る。
 *
 * 各 route は `cfEnv` → `resolveSecret` → (secret 無しなら 503) → `requireAuth`
 * → `assertAllowedRole` の順で、**binding や body の検査はすべて認可より後ろ**に
 * 置かれている。だから `INTERNAL_SHARED_SECRET` だけを持つ env で 403 まで届く。
 */

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    readBody: async () => ({}),
    getQuery: () => ({}),
    getRouterParam: () => 'x',
  }
})

import etcCsvDownload from '../../server/api/etc-csv/download.get'
import kyuyoMasterCompanies from '../../server/api/kyuyo-master/companies.get'
import net780ByOperation from '../../server/api/net780/by-operation.get'
import netprintRun from '../../server/api/netprint/run.post'
import netprintTargetsGet from '../../server/api/netprint/targets.get'
import netprintTargetsPut from '../../server/api/netprint/targets.put'
import poiRegion from '../../server/api/poi/[region].get'
import profitOperationLegSales from '../../server/api/profit/operation-leg-sales.get'
import profitSnapshotDelete from '../../server/api/profit/snapshot.delete'
import profitSnapshot from '../../server/api/profit/snapshot.get'
import profitSnapshots from '../../server/api/profit/snapshots.get'
import vehicleSettingsExtract from '../../server/api/vehicle-settings/extract.post'
import vehicleSettingsHistory from '../../server/api/vehicle-settings/history.get'
import vehicleSettingsObject from '../../server/api/vehicle-settings/object.get'
import vehicleSettingsUnconfirmed from '../../server/api/vehicle-settings/unconfirmed.get'
import vidCheckMapKey from '../../server/api/vid-check/map-key.get'
import yTimeExport from '../../server/api/y-time-export.post'
import yTimeTemplateGet from '../../server/api/y-time-template.get'
import yTimeTemplatePut from '../../server/api/y-time-template.put'

/** この PR で role 認可を配線した route。**追加したらここにも足す。** */
const WIRED: [string, unknown][] = [
  ['GET /api/etc-csv/download', etcCsvDownload],
  ['GET /api/kyuyo-master/companies', kyuyoMasterCompanies],
  ['GET /api/net780/by-operation', net780ByOperation],
  ['POST /api/netprint/run', netprintRun],
  ['GET /api/netprint/targets', netprintTargetsGet],
  ['PUT /api/netprint/targets', netprintTargetsPut],
  ['GET /api/poi/[region]', poiRegion],
  ['GET /api/profit/operation-leg-sales', profitOperationLegSales],
  ['GET /api/profit/snapshot', profitSnapshot],
  ['DELETE /api/profit/snapshot', profitSnapshotDelete],
  ['GET /api/profit/snapshots', profitSnapshots],
  ['POST /api/vehicle-settings/extract', vehicleSettingsExtract],
  ['GET /api/vehicle-settings/history', vehicleSettingsHistory],
  ['GET /api/vehicle-settings/object', vehicleSettingsObject],
  ['GET /api/vehicle-settings/unconfirmed', vehicleSettingsUnconfirmed],
  ['GET /api/vid-check/map-key', vidCheckMapKey],
  ['POST /api/y-time-export', yTimeExport],
  ['GET /api/y-time-template', yTimeTemplateGet],
  ['PUT /api/y-time-template', yTimeTemplatePut],
]

const event = () => ({ context: { cloudflare: { env: { INTERNAL_SHARED_SECRET: 'secret' } } } })
const call = (h: unknown) => (h as (e: unknown) => Promise<unknown>)(event())

beforeEach(() => {
  requireAuthMock.mockReset()
})

describe('role 認可の配線 (Refs #1004)', () => {
  it.each(WIRED)('%s — 非許可 role (viewer) は 403', async (_label, handler) => {
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'viewer' })
    await expect(call(handler)).rejects.toMatchObject({
      statusCode: 403,
      statusMessage: 'administrator role is required',
    })
  })

  it.each(WIRED)('%s — role が空文字なら 403 (fail-closed)', async (_label, handler) => {
    // auth-worker は claim 欠落時に `payload.role || ""` を返す。
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: '' })
    await expect(call(handler)).rejects.toMatchObject({ statusCode: 403 })
  })

  it.each(WIRED)('%s — role が無ければ 403 (fail-closed)', async (_label, handler) => {
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
    await expect(call(handler)).rejects.toMatchObject({ statusCode: 403 })
  })

  // ★ 陽性対照。403 が「role のせい」であって「env が足りないせい」ではないことを示す。
  //   admin なら **403 では落ちない** (この env では後段の binding 不足で 503 等になるが、
  //   それは認可を通り抜けた証拠)。
  it.each(WIRED)('%s — 陽性対照: admin は 403 で止まらない', async (_label, handler) => {
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'admin' })
    const got = await call(handler).then(() => null, (e: { statusCode?: number }) => e)
    expect(got?.statusCode).not.toBe(403)
  })

  it('認可は認証の後 — requireAuth が 401 で投げたら 403 にはしない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    await expect(call(vidCheckMapKey)).rejects.toMatchObject({ statusCode: 401 })
  })
})
