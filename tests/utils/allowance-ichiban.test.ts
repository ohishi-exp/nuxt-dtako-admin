import { describe, it, expect } from 'vitest'
import type { VehicleDailySlip } from '~/utils/ichiban'
import type { AllowanceReportRow } from '~/utils/allowance-report'
import type { RateRow } from '~/utils/allowance-rate-master'
import {
  areaTown,
  slipDestKeys,
  legDestAlts,
  destMatches,
  dayDiff,
  legKey,
  reconcileLegs,
  reconcileWithPool,
  reconcileVehicles,
  slipDateRange,
  tradableSlips,
  lookupFareByCity,
  brandFares,
  fareCandidates,
  fareStatus,
  checkFares,
  checkLeftoverFares,
  emptySalesTotals,
  summarizeSales,
  margin,
  reconcileCsvLines,
  vehicleCodeFromUnkoNo,
  POOL_VEHICLE,
} from '~/utils/allowance-ichiban'

function slip(over: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-07-01',
    vehicleNumber: '1109',
    customerCode: '015211',
    customerName: '大石　勉',
    originAreaName: '北海道釧路市',
    destAreaName: '北海道上士幌町',
    origin: '釧路',
    dest: '上士幌',
    isSubcontracted: false,
    amount: 30000,
    itemCode: '1516',
    itemName: '大石後期',
    quantity: 10,
    unitPrice: 2750,
    unit: 'ｔ',
    rowId: 'r1',
    ...over,
  }
}

function row(over: Partial<AllowanceReportRow> = {}): AllowanceReportRow {
  return {
    unkoNo: '26070104195900000011091',
    date: '2026-07-01',
    driverName: '中村 一由',
    vehicleName: '帯広800か1109',
    seq: 1,
    originCity: '北海道釧路市西港１-98-41',
    destCity: '北海道河東郡上士幌町上士幌東３線',
    viaCities: '',
    masterDest: '上士幌',
    allowanceYen: 9000,
    status: 'ok',
    ...over,
  }
}

describe('areaTown', () => {
  it('都道府県と郡を落として市区町村名だけにする', () => {
    expect(areaTown('北海道上士幌町')).toBe('上士幌')
    expect(areaTown('北海道川上郡標茶町')).toBe('標茶')
    expect(areaTown('青森県八戸市')).toBe('八戸')
  })

  it('取り出せない文字列はそのまま返す (勝手に切り詰めない)', () => {
    expect(areaTown('ノベルズ')).toBe('ノベルズ')
    expect(areaTown('')).toBe('')
  })
})

describe('slipDestKeys', () => {
  it('着地N と 地域ﾏｽﾀ の市区町村 の両方を候補にする', () => {
    expect(slipDestKeys(slip({ dest: '清水　ﾉﾍﾞﾙｽﾞDF', destAreaName: '北海道清水町' })))
      .toEqual(['清水ノベルズDF', '清水'])
  })

  it('同じ値になれば 1 つに畳み、空は落とす', () => {
    expect(slipDestKeys(slip({ dest: '上士幌', destAreaName: '北海道上士幌町' }))).toEqual(['上士幌'])
    expect(slipDestKeys(slip({ dest: '', destAreaName: '' }))).toEqual([])
  })
})

describe('legDestAlts', () => {
  it('デジタコの住所とマスタの卸地の両方から候補を作る', () => {
    expect(legDestAlts({ destCity: '北海道河東郡上士幌町上士幌東３線', masterDest: '上士幌' }))
      .toEqual(['上士幌町', '上士幌'])
  })

  it('`松山/士幌` `清水・富士` は分けて展開する', () => {
    expect(legDestAlts({ destCity: '北海道士幌町', masterDest: '松山/士幌' }))
      .toEqual(['士幌町', '士幌', '松山'])
    expect(legDestAlts({ destCity: '清水・富士', masterDest: '' })).toEqual(['清水', '富士'])
  })

  it('卸地の手がかりが無ければ空 (推測しない)', () => {
    expect(legDestAlts({ destCity: '', masterDest: '' })).toEqual([])
  })
})

describe('destMatches', () => {
  it('完全一致と前方一致で当てる', () => {
    expect(destMatches(['上士幌'], ['上士幌'])).toBe(true)
    expect(destMatches(['士幌大木牧場'], ['士幌'])).toBe(true)
  })

  it('`士幌` が `上士幌` を巻き込まない (部分一致にしない)', () => {
    expect(destMatches(['上士幌'], ['士幌'])).toBe(false)
  })

  it('候補が無ければ当てにいかない', () => {
    expect(destMatches(['上士幌'], [])).toBe(false)
  })
})

describe('dayDiff', () => {
  it('日数差を絶対値で返し、時刻付きでも先頭 10 桁だけ見る', () => {
    expect(dayDiff('2026-07-01', '2026-07-01')).toBe(0)
    expect(dayDiff('2026-07-01', '2026-07-02')).toBe(1)
    expect(dayDiff('2026-07-03T00:00:00', '2026-07-01')).toBe(2)
  })
})

describe('legKey', () => {
  it('運行NO と 便番号 で一意にする', () => {
    expect(legKey({ unkoNo: '2607…1', seq: 2 })).toBe('2607…1#2')
  })
})

describe('reconcileLegs', () => {
  it('1 便に同じ日・同じ卸地の明細をまとめて付ける (標茶 8t + 4t = 12t 型)', () => {
    const slips = [
      slip({ rowId: 'a', quantity: 8, amount: 24000 }),
      slip({ rowId: 'b', quantity: 4, amount: 12000 }),
    ]
    const res = reconcileLegs([row()], slips)
    const hit = res.byLeg.get(legKey(row()))!
    expect(hit.status).toBe('matched')
    expect(hit.slips.map(s => s.rowId)).toEqual(['a', 'b'])
    expect(hit.quantity).toBe(12)
    expect(hit.salesYen).toBe(36000)
    expect(hit.split).toBe(false)
    expect(hit.fromPool).toBe(false)
    expect(res.leftovers).toEqual([])
  })

  it('同じ日に無ければ ±1 日まで広げ、日付ずれとして残す', () => {
    const res = reconcileLegs([row()], [slip({ saleDate: '2026-07-02' })])
    expect(res.byLeg.get(legKey(row()))!.status).toBe('matched_date_shift')
  })

  it('±1 日を超えた明細には当てない', () => {
    const res = reconcileLegs([row()], [slip({ saleDate: '2026-07-03' })])
    const hit = res.byLeg.get(legKey(row()))!
    expect(hit.status).toBe('no_slip')
    expect(hit.salesYen).toBe(0)
    expect(hit.quantity).toBe(0)
    expect(hit.slips).toEqual([])
    expect(res.leftovers).toHaveLength(1)
  })

  it('卸地が違う明細は残す', () => {
    const res = reconcileLegs([row()], [slip({ dest: '川西', destAreaName: '北海道帯広市' })])
    expect(res.byLeg.get(legKey(row()))!.status).toBe('no_slip')
    expect(res.leftovers).toHaveLength(1)
  })

  it('同じ日・同じ卸地に便が複数あれば明細を件数で分け、推定の印を付ける', () => {
    const rows = [row({ seq: 1 }), row({ seq: 2 })]
    const slips = [
      slip({ rowId: 'a', amount: 1000 }),
      slip({ rowId: 'b', amount: 2000 }),
      slip({ rowId: 'c', amount: 4000 }),
    ]
    const res = reconcileLegs(rows, slips)
    const first = res.byLeg.get(legKey(rows[0]!))!
    const second = res.byLeg.get(legKey(rows[1]!))!
    expect(first.slips.map(s => s.rowId)).toEqual(['a', 'b'])
    expect(second.slips.map(s => s.rowId)).toEqual(['c'])
    expect(first.split).toBe(true)
    expect(second.split).toBe(true)
    // 合計は分け方に関わらず変わらない
    expect(first.salesYen + second.salesYen).toBe(7000)
    expect(res.leftovers).toEqual([])
  })

  it('日付 → 運行NO → 便番号 の順に処理する (渡した順に依存しない)', () => {
    const early = row({ date: '2026-07-01', seq: 9 })
    const late = row({ date: '2026-07-02', seq: 1 })
    const slips = [slip({ rowId: 'a' }), slip({ rowId: 'b', saleDate: '2026-07-02' })]
    const res = reconcileLegs([late, early], slips)
    expect(res.byLeg.get(legKey(early))!.slips.map(s => s.rowId)).toEqual(['a'])
    expect(res.byLeg.get(legKey(late))!.slips.map(s => s.rowId)).toEqual(['b'])
  })
})

describe('reconcileWithPool', () => {
  it('自車で当たらなかった便だけ受け皿から拾い、印を付ける', () => {
    const rows = [row({ seq: 1 }), row({ seq: 2, date: '2026-07-05' })]
    const own = [slip({ rowId: 'own' })]
    const pool = [slip({ rowId: 'pool', saleDate: '2026-07-05', amount: 50000 })]
    const res = reconcileWithPool(rows, own, pool)
    expect(res.byLeg.get(legKey(rows[0]!))!.fromPool).toBe(false)
    const second = res.byLeg.get(legKey(rows[1]!))!
    expect(second.fromPool).toBe(true)
    expect(second.salesYen).toBe(50000)
  })

  it('受け皿にも無ければ未突合のまま。残明細は自車ぶんだけ返す', () => {
    const rows = [row({ date: '2026-07-05' })]
    const own = [slip({ rowId: 'own' })]
    const pool = [slip({ rowId: 'pool', dest: '川西', destAreaName: '北海道帯広市' })]
    const res = reconcileWithPool(rows, own, pool)
    expect(res.byLeg.get(legKey(rows[0]!))!.status).toBe('no_slip')
    expect(res.leftovers.map(s => s.rowId)).toEqual(['own'])
    expect(res.poolLeftovers.map(s => s.rowId)).toEqual(['pool'])
  })
})

describe('reconcileVehicles', () => {
  it('受け皿の明細を車輌どうしで取り合わせない (同じ売上を 2 台に数えない)', () => {
    const a = row({ unkoNo: 'A1', date: '2026-07-05' })
    const b = row({ unkoNo: 'B1', date: '2026-07-05' })
    const pool = [slip({ rowId: 'p', saleDate: '2026-07-05', amount: 50000 })]
    const res = reconcileVehicles([
      { vehicle: '1109', rows: [a], slips: [] },
      { vehicle: '0016', rows: [b], slips: [] },
    ], pool)
    expect(res.byLeg.get(legKey(a))!.salesYen).toBe(50000)
    expect(res.byLeg.get(legKey(b))!.status).toBe('no_slip')
  })

  it('未突合明細を車輌ごとに返す', () => {
    const res = reconcileVehicles([
      { vehicle: '1109', rows: [], slips: [slip({ rowId: 'x' })] },
    ], [])
    expect(res.leftovers).toEqual([{ vehicle: '1109', slips: [slip({ rowId: 'x' })] }])
  })
})

describe('slipDateRange', () => {
  it('月の前後に 1 日ずつ広げる (便の日付が ±1 日ずれるため)', () => {
    expect(slipDateRange('2026-07')).toEqual({ from: '2026-06-30', to: '2026-08-02' })
    expect(slipDateRange('2026-12')).toEqual({ from: '2026-11-30', to: '2027-01-02' })
  })
})

describe('tradableSlips', () => {
  it('「休み」行は便ではないので落とす', () => {
    expect(tradableSlips([slip({ itemName: '休み' }), slip({ itemName: '大石後期' })]))
      .toHaveLength(1)
  })
})

describe('lookupFareByCity', () => {
  it('市町村名の組がマスタの卸地に寄る経路を引ける', () => {
    expect(lookupFareByCity('北海道釧路市西港', '北海道川上郡標茶町', '星空の前期')).toBe(3000)
  })

  it('寄せる対応が無ければ市町村名から `市/町/村` を落として引く', () => {
    expect(lookupFareByCity('北海道釧路市', '北海道上士幌町', '大石後期')).toBe(2750)
  })

  it('マスタに無い経路は null', () => {
    expect(lookupFareByCity('北海道釧路市', '長崎県佐世保市', '肉牛')).toBeNull()
  })
})

describe('brandFares', () => {
  const master: RateRow[] = [
    { shipper: '', customer: '', loader: '', origin: '釧路', dest: 'A', brand: 'ミライコーン', farePerT: 3500, allowanceYen: 8000, note: '' },
    { shipper: '', customer: '', loader: '', origin: '広尾', dest: 'B', brand: 'ミライコーン', farePerT: 3500, allowanceYen: 8000, note: '' },
    { shipper: '', customer: '', loader: '', origin: '帯広', dest: 'C', brand: 'ミライコーン', farePerT: null, allowanceYen: 8000, note: '' },
    { shipper: '', customer: '', loader: '', origin: '帯広', dest: 'D', brand: '', farePerT: 4200, allowanceYen: 10000, note: '' },
  ]

  it('銘柄名で引き、重複と運賃なしの行を落とす', () => {
    expect(brandFares('ミライコーン', master)).toEqual([3500])
  })

  it('半角カナ・全角英字の揺れは正規化して当てる', () => {
    expect(brandFares('ﾐﾗｲｺｰﾝ', master)).toEqual([3500])
  })

  it('銘柄が空なら引かない (卸地だけで運賃が決まる契約を巻き込まないため)', () => {
    expect(brandFares('', master)).toEqual([])
  })

  it('既定はマスタ本体を見る', () => {
    expect(brandFares('北海特専')).toEqual([2750])
  })

  it('同じ銘柄でも卸地で運賃が変わる契約は昇順で全部返す', () => {
    expect(brandFares('ノベルズブレンド')).toEqual([2900, 3550, 3600])
  })
})

describe('fareCandidates / fareStatus', () => {
  it('経路から引けた運賃と銘柄から引いた運賃の両方を候補にする', () => {
    expect(fareCandidates('北海道釧路市', '北海道上士幌町', '大石後期')).toEqual([2750])
    expect(fareCandidates('北海道帯広市', '北海道鹿追町', 'ミライコーン')).toEqual([3500, 3800])
  })

  it('経路も銘柄もマスタに無ければ候補は空', () => {
    expect(fareCandidates('長崎県', '長崎県', '肉牛')).toEqual([])
  })

  it('候補が無ければ対象外、一致すれば一致、どれとも違えば食い違い', () => {
    expect(fareStatus([], 3000)).toBe('no_master')
    expect(fareStatus([2750, 3000], 3000)).toBe('match')
    expect(fareStatus([2750], 2700)).toBe('mismatch')
  })
})

describe('checkFares', () => {
  it('突合できた明細の単価をマスタと突き合わせる', () => {
    const rows = [row()]
    const res = reconcileLegs(rows, [slip({ unitPrice: 2700 })])
    const checks = checkFares(rows, res.byLeg)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({
      unkoNo: rows[0]!.unkoNo, itemName: '大石後期', unitPrice: 2700,
      masterFares: [2750], status: 'mismatch',
    })
  })

  it('突合結果に無い便は飛ばす', () => {
    expect(checkFares([row({ seq: 7 })], new Map())).toEqual([])
  })
})

describe('checkLeftoverFares', () => {
  it('便に当たらなかった明細も銘柄だけで検算する', () => {
    const checks = checkLeftoverFares([
      slip({ itemName: '北海特専', unitPrice: 2700 }),
      slip({ itemName: '肉牛', unitPrice: 4000 }),
    ])
    expect(checks.map(c => c.status)).toEqual(['mismatch', 'no_master'])
    expect(checks[0]).toMatchObject({ legKey: '', unkoNo: '', masterFares: [2750] })
  })
})

describe('summarizeSales', () => {
  it('売上・数量と、日付ずれ / 推定 / 受け皿 / 未突合 の件数を分けて返す', () => {
    const rows = [
      row({ seq: 1 }),
      row({ seq: 2, date: '2026-07-05' }),
      row({ seq: 3, date: '2026-07-20' }),
    ]
    const own = [slip({ rowId: 'a', amount: 1000, quantity: 1 }), slip({ rowId: 'b', amount: 2000, quantity: 2 })]
    const pool = [slip({ rowId: 'p', saleDate: '2026-07-06', amount: 5000, quantity: 5 })]
    const res = reconcileWithPool(rows, own, pool)
    const totals = summarizeSales(rows, res.byLeg)
    expect(totals).toEqual({
      salesYen: 8000,
      quantity: 8,
      matchedTrips: 2,
      unmatchedTrips: 1,
      dateShiftTrips: 1,
      splitTrips: 0,
      poolTrips: 1,
    })
  })

  it('明細を分けた便は推定として数える', () => {
    const rows = [row({ seq: 1 }), row({ seq: 2 })]
    const res = reconcileLegs(rows, [slip({ rowId: 'a' }), slip({ rowId: 'b' })])
    expect(summarizeSales(rows, res.byLeg).splitTrips).toBe(2)
  })

  it('突合結果に無い便は飛ばす', () => {
    expect(summarizeSales([row()], new Map())).toEqual(emptySalesTotals())
  })
})

describe('margin', () => {
  it('収支 = 売上 − 手当', () => {
    expect(margin(36000, 9000)).toBe(27000)
  })
})

describe('reconcileCsvLines', () => {
  it('便 1 行ずつに 手当・売上・収支・突合の状態を並べる', () => {
    const rows = [row()]
    const res = reconcileLegs(rows, [slip({ amount: 36000, quantity: 12 })])
    const lines = reconcileCsvLines(rows, res.byLeg)
    expect(lines[0]).toContain('"収支"')
    expect(lines[1]).toContain('"9000","12","36000","27000","matched","",""')
  })

  it('推定・受け皿の印と、手当が決まらない便を出せる', () => {
    const rows = [row({ seq: 1, allowanceYen: null }), row({ seq: 2, allowanceYen: null })]
    const pool = [slip({ rowId: 'p1', amount: 1000 }), slip({ rowId: 'p2', amount: 2000 })]
    const res = reconcileWithPool(rows, [], pool)
    const lines = reconcileCsvLines(rows, res.byLeg)
    expect(lines[1]).toContain(`"1000","1000","matched","推定","${POOL_VEHICLE}"`)
  })

  it('突合結果に無い便は未突合として出す (合計から黙って消さない)', () => {
    const lines = reconcileCsvLines([row()], new Map())
    expect(lines[1]).toContain('"9000","0","0","-9000","no_slip"')
  })
})

describe('vehicleCodeFromUnkoNo', () => {
  it('運行NO の車輌CD を一番星の 4 桁ゼロ埋めに揃える', () => {
    expect(vehicleCodeFromUnkoNo('26070104195900000011091')).toBe('1109')
    expect(vehicleCodeFromUnkoNo('26070104195900000000161')).toBe('0016')
  })
})
