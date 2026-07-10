// 検算ゴールデンテスト (Refs #198 Phase 5)
//
// 全ト協 Supabase から取得した snapshot (server/tariff/snapshot.json) と、
// 告示から独立実装した calc.ts の距離制運賃を全件突合する。九州は官報転記の
// kyushu.ts、他運輸局は snapshot が SoT (calc.ts 未収録) なので突合は九州のみ。
// snapshot 自体の整合性 (行数・単調性) は全 region チェックする。
import { describe, expect, it } from 'vitest'
import snapshot from '../../server/tariff/snapshot.json'
import { distanceBaseFare } from '../../app/utils/tariff/calc'
import { REGION_CODE, VEHICLE_CODE } from '../../server/utils/jta-tariff.mjs'

interface FareRow { region_code: number, vehicle_code: number, upto_km: number, fare_yen: number }
const snap = snapshot as { fareRates: FareRow[], chargeData: unknown[] }

describe('snapshot の整合性 (全運輸局)', () => {
  it('九州は 4 車種 × 65 距離帯 = 260 行', () => {
    const kyushu = snap.fareRates.filter(r => r.region_code === REGION_CODE.kyushu)
    expect(kyushu).toHaveLength(260)
  })

  it('全 region で距離・車種の単調増加が成り立つ (転記/取得ミス検出)', () => {
    for (const region of Object.values(REGION_CODE)) {
      for (const vehicle of Object.values(VEHICLE_CODE)) {
        const rows = snap.fareRates
          .filter(r => r.region_code === region && r.vehicle_code === vehicle)
          .sort((a, b) => a.upto_km - b.upto_km)
        expect(rows.length).toBeGreaterThan(0)
        for (let i = 1; i < rows.length; i++) {
          expect(rows[i]!.fare_yen).toBeGreaterThan(rows[i - 1]!.fare_yen)
        }
      }
    }
  })
})

describe('calc.ts (官報転記) と JTA snapshot の全件突合 — 九州', () => {
  it('九州の全 260 行で fare が一致する', () => {
    const vmap: Record<number, 'small_2t' | 'medium_4t' | 'large_10t' | 'trailer_20t'> = {
      1: 'small_2t', 2: 'medium_4t', 3: 'large_10t', 4: 'trailer_20t',
    }
    const kyushu = snap.fareRates.filter(r => r.region_code === REGION_CODE.kyushu)
    const mismatches: unknown[] = []
    for (const r of kyushu) {
      // JTA 表は 2000km まで。calc.ts の加算式が JTA の事前計算値と一致するか
      const mine = distanceBaseFare('kyushu', vmap[r.vehicle_code]!, r.upto_km)
      if (mine !== r.fare_yen) mismatches.push({ ...r, mine })
    }
    expect(mismatches).toEqual([])
  })
})
