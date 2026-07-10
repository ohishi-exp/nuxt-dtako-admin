/**
 * 標準的運賃 (告示209号) の距離制運賃額を返す (Refs #198 Phase 4/5)。
 *
 * GET /api/tariff/fare?bureau=kyushu&vehicle=large_10t&distanceKm=1550
 *   200 { fareYen, uptoKm, source, holiday?, lateNight?, total }
 *   400 — パラメータ不正 / 未対応距離
 *
 * 運賃額の lookup は主 JTA Supabase / 副 snapshot (server/utils/tariff-lookup)。
 * 休日・深夜割増は告示準拠で 2 割 (calc.ts)。
 */

import { defineEventHandler, getQuery, createError } from 'h3'
import { lookupFare } from '../../utils/tariff-lookup'
import { HOLIDAY_SURCHARGE_RATE, LATE_NIGHT_SURCHARGE_RATE } from '../../../app/utils/tariff/data/common'
import { REGION_CODE, VEHICLE_CODE } from '../../utils/jta-tariff.mjs'
import type { TransportBureau, VehicleClass } from '../../../app/utils/tariff/types'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const bureau = String(q.bureau ?? '')
  const vehicle = String(q.vehicle ?? '')
  const distanceKm = Number(q.distanceKm)

  if (!(bureau in REGION_CODE)) {
    throw createError({ statusCode: 400, statusMessage: `bureau が不正です: ${bureau}` })
  }
  if (!(vehicle in VEHICLE_CODE)) {
    throw createError({ statusCode: 400, statusMessage: `vehicle が不正です: ${vehicle}` })
  }
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw createError({ statusCode: 400, statusMessage: `distanceKm が不正です: ${String(q.distanceKm)}` })
  }

  const holiday = q.holiday === 'true' || q.holiday === '1'
  const lateNight = q.lateNight === 'true' || q.lateNight === '1'

  let result: Awaited<ReturnType<typeof lookupFare>>
  try {
    result = await lookupFare(bureau as TransportBureau, vehicle as VehicleClass, distanceKm)
  }
  catch (e: unknown) {
    throw createError({ statusCode: 400, statusMessage: e instanceof Error ? e.message : String(e) })
  }

  const holidaySurcharge = holiday ? Math.round(result.fareYen * HOLIDAY_SURCHARGE_RATE) : 0
  const lateNightSurcharge = lateNight ? Math.round(result.fareYen * LATE_NIGHT_SURCHARGE_RATE) : 0

  return {
    bureau,
    vehicle,
    distanceKm,
    uptoKm: result.uptoKm,
    fareYen: result.fareYen,
    source: result.source,
    holidaySurcharge,
    lateNightSurcharge,
    total: result.fareYen + holidaySurcharge + lateNightSurcharge,
  }
})
