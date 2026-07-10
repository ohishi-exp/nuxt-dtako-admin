import { describe, expect, it, vi } from 'vitest'
import {
  fetchFareFromJta,
  lookupFare,
  lookupFareFromSnapshot,
} from '../../server/utils/tariff-lookup'
import { REGION_CODE, VEHICLE_CODE } from '../../server/utils/jta-tariff.mjs'

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response
}

describe('lookupFareFromSnapshot', () => {
  it('九州 大型 100km = 45,860円 (官報値)', () => {
    expect(lookupFareFromSnapshot(REGION_CODE.kyushu, VEHICLE_CODE.large_10t, 100)).toBe(45860)
  })

  it('未収録は null', () => {
    expect(lookupFareFromSnapshot(REGION_CODE.kyushu, VEHICLE_CODE.large_10t, 15)).toBeNull()
  })
})

describe('fetchFareFromJta', () => {
  it('Supabase から fare_yen を取得', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ fare_yen: 45860 }]))
    const fare = await fetchFareFromJta(9, 3, 100, fetchImpl)
    expect(fare).toBe(45860)
    const url = fetchImpl.mock.calls[0]![0] as string
    expect(url).toContain('region_code=eq.9')
    expect(url).toContain('vehicle_code=eq.3')
    expect(url).toContain('upto_km=eq.100')
  })

  it('該当なしは null、HTTP エラーは throw', async () => {
    expect(await fetchFareFromJta(9, 3, 100, vi.fn().mockResolvedValue(jsonResponse([])))).toBeNull()
    await expect(fetchFareFromJta(9, 3, 100, vi.fn().mockResolvedValue(jsonResponse(null, false)))).rejects.toThrow(/HTTP 500/)
  })
})

describe('lookupFare (主 JTA / 副 snapshot)', () => {
  it('JTA 成功時は source=jta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ fare_yen: 99999 }]))
    const r = await lookupFare('kyushu', 'large_10t', 100, fetchImpl)
    expect(r).toEqual({ fareYen: 99999, uptoKm: 100, source: 'jta' })
  })

  it('JTA 失敗時は snapshot にフォールバック (source=snapshot)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'))
    const r = await lookupFare('kyushu', 'large_10t', 100, fetchImpl)
    expect(r).toEqual({ fareYen: 45860, uptoKm: 100, source: 'snapshot' })
  })

  it('JTA が該当なしを返しても snapshot にフォールバック', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]))
    const r = await lookupFare('kyushu', 'large_10t', 95, fetchImpl)
    // 95km は 100km に切り上げ
    expect(r).toEqual({ fareYen: 45860, uptoKm: 100, source: 'snapshot' })
  })

  it('距離は 10/20/50km 規則で切り上げてから引く', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('x'))
    const r = await lookupFare('kyushu', 'small_2t', 205, fetchImpl)
    expect(r.uptoKm).toBe(220)
  })

  it('2000km 超は snapshot にも無く throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('x'))
    await expect(lookupFare('kyushu', 'small_2t', 2500, fetchImpl)).rejects.toThrow(/見つかりません/)
  })
})
