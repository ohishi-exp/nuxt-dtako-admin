// 標準的運賃 snapshot 取得スクリプト (Refs #198 Phase 4/5)
//
// 全ト協「標準的運賃計算サイト」(detailedfare.jta.support) の Supabase から
// 距離制運賃表 (fare_rates) と付帯料金 (charge_data) を取得し、
// server/tariff/snapshot.json に保存する。
//
// このサイトは令和6年国土交通省告示第209号の運賃表をそのまま配信しており
// (九州 260 行が官報転記値と完全一致することを確認済み、2026-07-10)、
// このデータは告示の公開値と同一。
//
// snapshot は本番の **フォールバック** 用 + CI のゴールデンテスト fixture 兼用。
// 本番は実行時に Supabase を直接叩き、失敗時にこの snapshot に落ちる。
// 告示改定時にこのスクリプトを再実行して snapshot を更新する。
//
//   node scripts/tariff/fetch-tariff-snapshot.mjs
//
// anon key は公開 JS bundle に平文で載っている公開値 (RLS 前提の anon ロール)。

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { JTA_SUPABASE_URL, JTA_SUPABASE_ANON_KEY } from '../../server/utils/jta-tariff.mjs'

const REGION_CODES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

async function sbGet(path) {
  const res = await fetch(`${JTA_SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: JTA_SUPABASE_ANON_KEY, Authorization: `Bearer ${JTA_SUPABASE_ANON_KEY}` },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

async function main() {
  // 距離制運賃表 (region ごとに取得、Supabase の default limit 1000 を回避)
  const fareRates = []
  for (const region of REGION_CODES) {
    const rows = await sbGet(
      `fare_rates?region_code=eq.${region}&order=vehicle_code,upto_km&select=region_code,vehicle_code,upto_km,fare_yen`,
    )
    fareRates.push(...rows)
    console.log(`region ${region}: ${rows.length} fare rows`)
  }

  // 付帯料金 (待機/積込/取卸)
  const chargeData = await sbGet('charge_data?order=id_code,vehicle_code,time_code&select=id_code,vehicle_code,time_code,charge_yen')
  console.log(`charge_data: ${chargeData.length} rows`)

  const snapshot = {
    // 告示改定日 (令和6年3月22日)。取得日時は再現性のため source メモに残す
    source: 'detailedfare.jta.support (Supabase) — 令和6年国交省告示第209号',
    notice: '令和6年3月22日告示 (号外第66号)',
    fareRates,
    chargeData,
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/tariff')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, 'snapshot.json')
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 0)}\n`)
  console.log(`wrote ${outPath}: ${fareRates.length} fares + ${chargeData.length} charges`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
