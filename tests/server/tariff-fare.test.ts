import { describe, expect, it, vi } from 'vitest'

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

// lookupFare をモックして route の wiring (パラメータ検証・割増) を固定する
const { lookupFareMock } = vi.hoisted(() => ({ lookupFareMock: vi.fn() }))
vi.mock('../../server/utils/tariff-lookup', () => ({ lookupFare: lookupFareMock }))

import handler from '../../server/api/tariff/fare.get'

interface Q { [k: string]: string | undefined }
const call = (query: Q) => {
  const url = `/api/tariff/fare?${new URLSearchParams(query)}`
  return (handler as unknown as (e: unknown) => Promise<Record<string, unknown>>)({
    context: {},
    path: url,
    node: { req: { url } },
  })
}

describe('GET /api/tariff/fare', () => {
  it('運賃額 + source を返す', async () => {
    lookupFareMock.mockResolvedValue({ fareYen: 45860, uptoKm: 100, source: 'jta' })
    const res = await call({ bureau: 'kyushu', vehicle: 'large_10t', distanceKm: '100' })
    expect(res).toMatchObject({ fareYen: 45860, uptoKm: 100, source: 'jta', total: 45860 })
  })

  it('休日 + 深夜割増を各 2 割で加算', async () => {
    lookupFareMock.mockResolvedValue({ fareYen: 45860, uptoKm: 100, source: 'snapshot' })
    const res = await call({ bureau: 'kyushu', vehicle: 'large_10t', distanceKm: '100', holiday: 'true', lateNight: '1' })
    expect(res.holidaySurcharge).toBe(9172)
    expect(res.lateNightSurcharge).toBe(9172)
    expect(res.total).toBe(45860 + 9172 * 2)
  })

  it('holiday=1 / lateNight=true の表記でも割増が付く', async () => {
    lookupFareMock.mockResolvedValue({ fareYen: 45860, uptoKm: 100, source: 'jta' })
    const res = await call({ bureau: 'kyushu', vehicle: 'large_10t', distanceKm: '100', holiday: '1', lateNight: 'true' })
    expect(res.holidaySurcharge).toBe(9172)
    expect(res.lateNightSurcharge).toBe(9172)
  })

  it('bureau / vehicle / distanceKm 不正・未指定は 400', async () => {
    await expect(call({ vehicle: 'large_10t', distanceKm: '100' })).rejects.toMatchObject({ statusCode: 400 }) // bureau 未指定
    await expect(call({ bureau: 'mars', vehicle: 'large_10t', distanceKm: '100' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(call({ bureau: 'kyushu', distanceKm: '100' })).rejects.toMatchObject({ statusCode: 400 }) // vehicle 未指定
    await expect(call({ bureau: 'kyushu', vehicle: 'bike', distanceKm: '100' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(call({ bureau: 'kyushu', vehicle: 'large_10t', distanceKm: 'abc' })).rejects.toMatchObject({ statusCode: 400 }) // NaN
    await expect(call({ bureau: 'kyushu', vehicle: 'large_10t', distanceKm: '0' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('lookupFare の throw (Error) は 400 に変換', async () => {
    lookupFareMock.mockRejectedValue(new Error('運賃データが見つかりません'))
    await expect(call({ bureau: 'kyushu', vehicle: 'small_2t', distanceKm: '3000' })).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining('見つかりません'),
    })
  })

  it('lookupFare の throw (非 Error) も 400 に変換', async () => {
    lookupFareMock.mockRejectedValue('boom')
    await expect(call({ bureau: 'kyushu', vehicle: 'small_2t', distanceKm: '100' })).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'boom',
    })
  })
})
