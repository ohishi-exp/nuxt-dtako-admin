// 標準的運賃の額 lookup (Refs #198 Phase 4/5)
//
// 主: 全ト協 Supabase (detailedfare.jta.support のバックエンド) を実行時に叩く
// 副: 取得済み snapshot.json にフォールバック (先方の障害 / RLS 変更 / revoke 時)
//
// どちらも同じ告示 209 号の事前計算表 (region × vehicle × upto_km → fare_yen)。
// 距離の切り上げは calc.ts の roundUpDistanceKm と一致する (JTA の upto_km は
// 10/20/50km 刻みの離散値)。

import {
  JTA_SUPABASE_URL,
  JTA_SUPABASE_ANON_KEY,
  REGION_CODE,
  VEHICLE_CODE,
} from './jta-tariff.mjs'
import snapshot from '../tariff/snapshot.json'
import { roundUpDistanceKm } from '../../app/utils/tariff/calc'
import type { TransportBureau, VehicleClass } from '../../app/utils/tariff/types'

export interface FareRow {
  region_code: number
  vehicle_code: number
  upto_km: number
  fare_yen: number
}

export interface FareLookupResult {
  fareYen: number
  /** 表引きに使った切り上げ後の距離 (= JTA upto_km) */
  uptoKm: number
  /** 'jta' = Supabase 実行時取得 / 'snapshot' = フォールバック */
  source: 'jta' | 'snapshot'
}

const SNAPSHOT = snapshot as { fareRates: FareRow[] }

/** snapshot から region+vehicle+upto_km の fare_yen を引く */
export function lookupFareFromSnapshot(
  regionCode: number,
  vehicleCode: number,
  uptoKm: number,
): number | null {
  const row = SNAPSHOT.fareRates.find(
    r => r.region_code === regionCode && r.vehicle_code === vehicleCode && r.upto_km === uptoKm,
  )
  return row ? row.fare_yen : null
}

/** JTA Supabase から fare_yen を引く (実行時、失敗は throw) */
export async function fetchFareFromJta(
  regionCode: number,
  vehicleCode: number,
  uptoKm: number,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const url
    = `${JTA_SUPABASE_URL}/rest/v1/fare_rates`
      + `?region_code=eq.${regionCode}&vehicle_code=eq.${vehicleCode}&upto_km=eq.${uptoKm}`
      + `&select=fare_yen`
  const res = await fetchImpl(url, {
    headers: { apikey: JTA_SUPABASE_ANON_KEY, Authorization: `Bearer ${JTA_SUPABASE_ANON_KEY}` },
  })
  if (!res.ok) throw new Error(`JTA fare_rates HTTP ${res.status}`)
  const rows = (await res.json()) as { fare_yen: number }[]
  return rows.length > 0 ? rows[0]!.fare_yen : null
}

/**
 * 運賃額を引く。主: JTA Supabase、失敗時: snapshot フォールバック。
 * 2000km 超 (JTA 表の範囲外) や未収録の距離帯は null を返す。
 */
export async function lookupFare(
  bureau: TransportBureau,
  vehicleClass: VehicleClass,
  distanceKm: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FareLookupResult> {
  const regionCode = REGION_CODE[bureau]
  const vehicleCode = VEHICLE_CODE[vehicleClass]
  const uptoKm = roundUpDistanceKm(distanceKm)

  // 主: JTA を叩く
  try {
    const fareYen = await fetchFareFromJta(regionCode, vehicleCode, uptoKm, fetchImpl)
    if (fareYen !== null) return { fareYen, uptoKm, source: 'jta' }
  }
  catch {
    // 副にフォールバック
  }

  const fallback = lookupFareFromSnapshot(regionCode, vehicleCode, uptoKm)
  if (fallback === null) {
    throw new Error(`運賃データが見つかりません: bureau=${bureau} vehicle=${vehicleClass} uptoKm=${uptoKm} (2000km 超は未対応)`)
  }
  return { fareYen: fallback, uptoKm, source: 'snapshot' }
}
