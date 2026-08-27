/**
 * **R2 から解決したマスタが引き当てまで届くこと** (Refs #805 PR-2)。
 *
 * 引き当ての pure 関数 (`lookupAllowance` / `lookupFare`) は最初から `master`
 * 引数を持っていたが、**画面から呼ぶ経路が既定引数のまま**だったので、R2 の版を
 * 渡しても同梱の初期値で計算されてしまう。ここは**その経路 1 本ずつ**に、
 * 「初期値と違う値を渡したら、その値が出る」ことを当てる。
 *
 * 中間の関数はどれも `master?: RateRow[]` (**既定値を持たない**)。既定を書くと
 * 「渡し忘れ」と「初期値で計算してよい」が区別できなくなるうえ、`RATE_MASTER`
 * への import が層ごとに増える。`undefined` はいちばん下 (`lookupAllowance` /
 * `lookupFare` / `brandFares`) の既定が受ける。
 *
 * **陰性対照**: この 12 本は基点 (`c918714`) のコードに当てると全部落ちる —
 * 余分な引数が黙って捨てられ、同梱の初期値の 9000 / 2750 が返るため。
 */
import { describe, it, expect } from 'vitest'
import { RATE_MASTER, type RateRow } from '~/utils/allowance-rate-master'
import type { VehicleDailySlip } from '~/utils/ichiban'
import type { ProvisionalMap } from '~/utils/allowance-provisional'
import {
  allowanceForLegs,
  carryOverDest,
  lookupAllowanceByCity,
  type AllowanceLeg,
  type LegAllowance,
} from '~/utils/allowance-trips'
import { applyCarryOver, type AllowanceReportRow, type OperationAllowance } from '~/utils/allowance-report'
import {
  brandFares,
  checkFares,
  checkLeftoverFares,
  fareCandidates,
  legKey,
  lookupFareByCity,
  type LegReconcile,
} from '~/utils/allowance-ichiban'
import { buildIchibanLegs, resolveSlipDest } from '~/utils/allowance-ichiban-legs'
import { forcedLeg, resolveForceMatches } from '~/utils/allowance-force-match'
import { buildUncoveredLegs } from '~/utils/margin'

/** 手当 ¥1,234 / 運賃 ¥4,321 — **同梱の初期値 (9000 / 2750) とは違う値**。 */
const TAMPERED_YEN = 1234
const TAMPERED_FARE = 4321

/** R2 から来たつもりのマスタ。釧路〜上士幌 の 1 行だけ。 */
const MASTER: RateRow[] = [{
  shipper: '大石グループ',
  customer: '大石畜産',
  loader: '中部飼料',
  origin: '釧路',
  dest: '上士幌',
  brand: '大石後期',
  farePerT: TAMPERED_FARE,
  allowanceYen: TAMPERED_YEN,
  note: '',
}]

const PROVISIONAL: ProvisionalMap = {}

function leg(over: Partial<AllowanceLeg> = {}): AllowanceLeg {
  return {
    loadRowIndex: 0,
    unloadRowIndexes: [1],
    originCity: '北海道釧路市西港１',
    destCity: '北海道河東郡上士幌町上士幌東３線',
    viaCities: ['北海道河東郡上士幌町'],
    fromTs: null,
    toTs: null,
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
    fromTs: null,
    originCity: '北海道釧路市西港１',
    destCity: '北海道河東郡上士幌町上士幌東３線',
    viaCities: '',
    masterDest: '上士幌',
    allowanceYen: null,
    status: 'unknown',
    destSource: 'event',
    ...over,
  }
}

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
    unitPrice: TAMPERED_FARE,
    unit: 'ｔ',
    rowId: 'r1',
    ...over,
  }
}

function op(over: Partial<OperationAllowance> = {}): OperationAllowance {
  return {
    unkoNo: '2607010419590000001109',
    readingDate: '2026-07-02',
    operationDate: '2026-07-01',
    driverName: '中村 一由',
    vehicleName: '帯広800か1109',
    legs: [],
    carryIn: { cities: [], toTs: null },
    error: null,
    ...over,
  }
}

/** 卸地がまだ決まっていない便 (次の運行の先頭の降しで埋まる)。 */
const OPEN_LEG: LegAllowance = {
  leg: leg({ unloadRowIndexes: [], destCity: '', viaCities: [] }),
  lookup: { status: 'unknown', dest: '' },
  destSource: 'event',
}

describe('手当 (allowance) の経路にマスタが届く', () => {
  it('lookupAllowanceByCity', () => {
    expect(lookupAllowanceByCity('北海道釧路市西港１', '北海道河東郡上士幌町', MASTER))
      .toMatchObject({ status: 'ok', allowanceYen: TAMPERED_YEN })
  })

  it('allowanceForLegs', () => {
    const got = allowanceForLegs([leg()], MASTER)
    expect(got[0]!.lookup).toMatchObject({ status: 'ok', allowanceYen: TAMPERED_YEN })
  })

  it('carryOverDest (次の運行の先頭の降しから引き継いだ便)', () => {
    const got = carryOverDest(
      [OPEN_LEG],
      { cities: ['北海道河東郡上士幌町'], toTs: 1 },
      MASTER,
    )
    expect(got[0]!.lookup).toMatchObject({ status: 'ok', allowanceYen: TAMPERED_YEN })
    expect(got[0]!.destSource).toBe('carried')
  })

  it('applyCarryOver (運行をまたいだ引き継ぎ)', () => {
    const ops = [
      op({ unkoNo: '2607010419590000001109', legs: [OPEN_LEG] }),
      op({ unkoNo: '2607020419590000001109', carryIn: { cities: ['北海道河東郡上士幌町'], toTs: 1 } }),
    ]
    const got = applyCarryOver(ops, MASTER)
    expect(got[0]!.legs[0]!.lookup).toMatchObject({ status: 'ok', allowanceYen: TAMPERED_YEN })
  })

  it('resolveSlipDest (一番星の明細から卸地を決める)', () => {
    expect(resolveSlipDest('釧路', [slip()], MASTER).lookup)
      .toMatchObject({ status: 'ok', allowanceYen: TAMPERED_YEN })
  })

  it('buildIchibanLegs (デジタコに運行が無い日に起こす便)', () => {
    const legs = buildIchibanLegs('中村 一由', [slip()], new Set(), new Set(), '2026-07', PROVISIONAL, MASTER)
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({ allowanceYen: TAMPERED_YEN, status: 'ok' })
  })

  it('forcedLeg (人が結んだ明細から決める便)', () => {
    expect(forcedLeg(row(), [slip()], PROVISIONAL, MASTER))
      .toMatchObject({ allowanceYen: TAMPERED_YEN, masterDest: '上士幌' })
  })

  it('resolveForceMatches', () => {
    const r = row()
    const key = `${r.unkoNo}#s${r.seq}`
    const got = resolveForceMatches(
      [r],
      { [key]: ['r1'] },
      new Map([['r1', slip()]]),
      PROVISIONAL,
      MASTER,
    )
    expect(got.get(key)).toMatchObject({ allowanceYen: TAMPERED_YEN })
  })
})

describe('運賃 (fare) の経路にマスタが届く', () => {
  it('brandFares', () => {
    expect(brandFares('大石後期', MASTER)).toEqual([TAMPERED_FARE])
  })

  it('lookupFareByCity', () => {
    expect(lookupFareByCity('北海道釧路市西港１', '北海道河東郡上士幌町', '大石後期', MASTER))
      .toBe(TAMPERED_FARE)
  })

  it('fareCandidates', () => {
    expect(fareCandidates('北海道釧路市西港１', '北海道河東郡上士幌町', '大石後期', MASTER))
      .toEqual([TAMPERED_FARE])
  })

  it('checkFares (突合できた明細の単価検算)', () => {
    const r = row()
    const hit: LegReconcile = {
      key: legKey(r),
      status: 'matched',
      slips: [slip()],
      quantity: 10,
      salesYen: 30000,
      split: false,
      fromPool: false,
    }
    const got = checkFares([r], new Map([[legKey(r), hit]]), MASTER)
    expect(got[0]).toMatchObject({ masterFares: [TAMPERED_FARE], status: 'match' })
  })

  it('checkLeftoverFares (便に当たらなかった明細)', () => {
    expect(checkLeftoverFares([slip()], MASTER)[0])
      .toMatchObject({ masterFares: [TAMPERED_FARE], status: 'match' })
  })
})

/**
 * **`master` を渡さない呼び出しは 1 文字も変わらない** (Refs #805 PR-2)。
 *
 * この PR で増えたのは `master?: RateRow[]` (**既定値なし**) だけなので、
 * 引数を足していない呼び出し元 — とくに**粗利タブ** (`app/pages/profit/margin.vue`
 * の `allowanceForLegs`、`app/utils/margin.ts` の `buildIchibanLegs`) — は
 * 同梱の初期値で計算し続ける。それを「読んで明らか」で済ませず、
 * **省略した答えと `RATE_MASTER` を明示した答えが deepEqual** で測る。
 *
 * **陽性対照つき** — 当てても 1 文字も変わらない測り方は、測っていないのと同じ。
 */
describe('master を省略した呼び出しは同梱の初期値のまま (粗利タブの経路)', () => {
  const legs = [leg(), leg({ destCity: '北海道川上郡標茶町', viaCities: ['北海道川上郡標茶町'] })]
  const slips = [slip(), slip({ rowId: 'r2', dest: '川西', destAreaName: '北海道帯広市川西町' })]

  it('allowanceForLegs — 省略 === RATE_MASTER 明示', () => {
    expect(allowanceForLegs(legs)).toEqual(allowanceForLegs(legs, RATE_MASTER))
  })

  it('buildIchibanLegs — 省略 === RATE_MASTER 明示', () => {
    const omitted = buildIchibanLegs('中村 一由', slips, new Set(), new Set(), '2026-07', PROVISIONAL)
    const explicit = buildIchibanLegs('中村 一由', slips, new Set(), new Set(), '2026-07', PROVISIONAL, RATE_MASTER)
    expect(omitted).toEqual(explicit)
    // 「両方 0 件」で通る測り方にしない。
    expect(omitted.length).toBeGreaterThan(0)
    expect(omitted.every(l => l.status === 'ok')).toBe(true)
  })

  it('checkLeftoverFares — 省略 === RATE_MASTER 明示', () => {
    expect(checkLeftoverFares(slips)).toEqual(checkLeftoverFares(slips, RATE_MASTER))
  })

  it('★ 陽性対照: 差し替えたマスタを渡すと上の 3 本はどれも一致しなくなる', () => {
    expect(allowanceForLegs(legs, MASTER)).not.toEqual(allowanceForLegs(legs))
    expect(buildIchibanLegs('中村 一由', slips, new Set(), new Set(), '2026-07', PROVISIONAL, MASTER))
      .not.toEqual(buildIchibanLegs('中村 一由', slips, new Set(), new Set(), '2026-07', PROVISIONAL))
    expect(checkLeftoverFares(slips, MASTER)).not.toEqual(checkLeftoverFares(slips))
  })
})

/**
 * **粗利タブの経路にもマスタが届く** (Refs #805 PR-2)。
 *
 * 粗利の「手当」は運行手当タブと同じマスタから出ている
 * (`app/pages/profit/margin.vue` の `allowanceForLegs` / `applyCarryOver` /
 * `resolveForceMatches` と、`margin.ts` の `buildUncoveredLegs`)。ここは
 * `margin.ts` 側の 1 本 — 残り 3 本は上の describe が同じ関数を測っている。
 */
describe('粗利タブの「対象外の便」にもマスタが届く', () => {
  const driver = {
    driverName: '中村 一由',
    rows: [] as AllowanceReportRow[],
    slips: [slip()],
  }

  it('buildUncoveredLegs — 差し替えたマスタの手当が出る', () => {
    const legs = buildUncoveredLegs([driver], [], '2026-07', PROVISIONAL, MASTER)
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({ allowanceYen: TAMPERED_YEN, status: 'ok' })
  })

  it('省略すると同梱の初期値のまま (陽性対照つき)', () => {
    const omitted = buildUncoveredLegs([driver], [], '2026-07', PROVISIONAL)
    expect(omitted).toEqual(buildUncoveredLegs([driver], [], '2026-07', PROVISIONAL, RATE_MASTER))
    expect(omitted[0]).toMatchObject({ allowanceYen: 9000, status: 'ok' })
    expect(omitted).not.toEqual(buildUncoveredLegs([driver], [], '2026-07', PROVISIONAL, MASTER))
  })
})
