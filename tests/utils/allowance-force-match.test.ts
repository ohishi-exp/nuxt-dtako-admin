import { describe, it, expect } from 'vitest'
import { toReportRows, type AllowanceReportRow, type OperationAllowance } from '~/utils/allowance-report'
import type { AllowanceLeg, LegAllowance } from '~/utils/allowance-trips'
import type { VehicleDailySlip } from '~/utils/ichiban'
import {
  parseForceMatch,
  serializeForceMatch,
  toggleForceMatch,
  clearForceMatch,
  forceMatchKey,
  legOrigin,
  forcedLeg,
  resolveForceMatches,
  forcedLegAllowance,
  applyForcedLegs,
  forceMatchCandidates,
} from '~/utils/allowance-force-match'

/** 2026-07-16 の実データ: 運行終了後に卸していて降しが 1 つも無い便。 */
function row(over: Partial<AllowanceReportRow> = {}): AllowanceReportRow {
  return {
    unkoNo: '2607160931450000001318',
    date: '2026-07-16',
    driverName: '柳井 亮祐',
    vehicleName: '帯広800か1318',
    seq: 3,
    fromTs: 1784000000,
    originCity: '北海道釧路市西港１',
    destCity: '',
    viaCities: '',
    masterDest: '',
    allowanceYen: null,
    status: 'unknown',
    destSource: 'event',
    ...over,
  }
}
function slip(over: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-07-16',
    vehicleNumber: '1318',
    customerCode: '015204',
    customerName: '大　石　畜　産',
    originAreaName: '北海道釧路市',
    destAreaName: '北海道浦幌町',
    origin: '釧路',
    dest: '浦幌',
    isSubcontracted: false,
    amount: 36250,
    itemCode: '1516',
    itemName: '大石後期',
    quantity: 12.5,
    unitPrice: 2900,
    unit: 'ｔ',
    rowId: '20260716-1',
    ...over,
  }
}
const KEY = '2607160931450000001318#t1784000000'

describe('forceMatchKey / legOrigin', () => {
  it('便のキーは除外と共通 (積みの開始日時なので取り直しに強い)', () => {
    expect(forceMatchKey(row())).toBe(KEY)
  })

  it('積地はデジタコの住所からマスタ語彙に寄せる', () => {
    expect(legOrigin(row())).toBe('釧路')
  })
})

describe('parseForceMatch / serializeForceMatch', () => {
  it('保存した形をそのまま読み戻す', () => {
    const map = { [KEY]: ['20260716-1', '20260716-2'] }
    expect(parseForceMatch(serializeForceMatch(map))).toEqual(map)
  })

  it('未設定・壊れた値は空として扱う (投げない)', () => {
    expect(parseForceMatch(null)).toEqual({})
    expect(parseForceMatch(undefined)).toEqual({})
    expect(parseForceMatch('')).toEqual({})
    expect(parseForceMatch('{')).toEqual({})
    expect(parseForceMatch('42')).toEqual({})
    expect(parseForceMatch('null')).toEqual({})
    expect(parseForceMatch('["a"]')).toEqual({})
  })

  it('空キー・配列でない値・空配列・重複と空文字の明細は捨てる', () => {
    expect(parseForceMatch(JSON.stringify({
      '': ['a'], 'k1': 'a', 'k2': [], 'k3': ['a', 'a', '', 1], 'k4': ['b'],
    }))).toEqual({ k3: ['a'], k4: ['b'] })
  })
})

describe('toggleForceMatch / clearForceMatch', () => {
  it('同じ明細をもう一度渡せば外れる', () => {
    const one = toggleForceMatch({}, KEY, 'r1')
    expect(one).toEqual({ [KEY]: ['r1'] })
    const two = toggleForceMatch(one, KEY, 'r2')
    expect(two).toEqual({ [KEY]: ['r1', 'r2'] })
    expect(toggleForceMatch(two, KEY, 'r1')).toEqual({ [KEY]: ['r2'] })
    // 最後の 1 つを外したらキーごと消える
    expect(toggleForceMatch({ [KEY]: ['r1'] }, KEY, 'r1')).toEqual({})
  })

  it('空のキー・明細は何もしない', () => {
    const before = { [KEY]: ['r1'] }
    expect(toggleForceMatch(before, '', 'r1')).toBe(before)
    expect(toggleForceMatch(before, KEY, '')).toBe(before)
  })

  it('渡した map は書き換えない', () => {
    const before = { [KEY]: ['r1'] }
    toggleForceMatch(before, KEY, 'r2')
    expect(before).toEqual({ [KEY]: ['r1'] })
  })

  it('その便の結びつけを全部外す', () => {
    expect(clearForceMatch({ [KEY]: ['r1', 'r2'], other: ['x'] }, KEY)).toEqual({ other: ['x'] })
  })

  it('結んでいない便を外そうとしても同じ map を返す', () => {
    const before = { other: ['x'] }
    expect(clearForceMatch(before, KEY)).toBe(before)
  })
})

describe('forcedLeg', () => {
  it('明細から卸地・手当・売上を決める (積地はデジタコ側を使う)', () => {
    expect(forcedLeg(row(), [slip()], {})).toMatchObject({
      dest: '浦幌',
      masterDest: '浦幌',
      allowanceYen: 9000,
      isProvisional: false,
      salesYen: 36250,
    })
  })

  it('複数の明細を結べる (複数卸し。手当は最終卸し地)', () => {
    const out = forcedLeg(row(), [
      slip({ dest: '川西', destAreaName: '北海道帯広市', amount: 33825, rowId: 'a' }),
      slip({ dest: '浦幌', amount: 36250, rowId: 'b' }),
    ], {})
    expect(out.salesYen).toBe(70075)
    expect(out.quantity).toBe(25)
    expect(out.allowanceYen).toBe(9000)
  })

  it('マスタに無い経路には暫定手当を当てる', () => {
    const out = forcedLeg(
      row({ originCity: '北海道広尾郡広尾町会所前６' }),
      [slip({ dest: '大野ﾌｧｰﾑ', destAreaName: '北海道芽室町' })],
      { '広尾|芽室': 9000 },
    )
    expect(out).toMatchObject({ dest: '芽室', masterDest: '', allowanceYen: 9000, isProvisional: true })
  })

  it('暫定も無ければ手当は決めない (推測しない)', () => {
    const out = forcedLeg(row({ originCity: '北海道広尾郡広尾町会所前６' }), [slip({ dest: '大野ﾌｧｰﾑ', destAreaName: '北海道芽室町' })], {})
    expect(out.allowanceYen).toBeNull()
  })
})

/** 降しが 1 つも無い便 (卸地が決まらない = 強制突合の対象)。 */
function bareLeg(over: Partial<AllowanceLeg> = {}): LegAllowance {
  const leg: AllowanceLeg = {
    loadRowIndex: 3,
    unloadRowIndexes: [],
    originCity: '北海道釧路市西港１',
    destCity: '',
    viaCities: [],
    fromTs: 1784000000,
    toTs: null,
    ...over,
  }
  return { leg, lookup: { status: 'unknown', dest: '' }, destSource: 'event' }
}
function operation(legs: LegAllowance[]): OperationAllowance {
  return {
    unkoNo: '2607160931450000001318',
    readingDate: '2026-07-16',
    operationDate: '2026-07-16',
    driverName: '柳井 亮祐',
    vehicleName: '帯広800か1318',
    legs,
    carryIn: { cities: [], toTs: null },
    error: null,
  }
}

describe('forcedLegAllowance / applyForcedLegs', () => {
  const forced = forcedLeg(row(), [slip()], {})

  it('卸地と引き当てを便に映す (出どころは forced)', () => {
    const out = forcedLegAllowance(bareLeg(), forced)
    expect(out.leg.destCity).toBe('浦幌')
    expect(out.lookup).toEqual(forced.lookup)
    expect(out.destSource).toBe('forced')
  })

  it('結んだ便だけを差し替え、他の便と積みの他の列は触らない', () => {
    const other = bareLeg({ fromTs: 1784099999, loadRowIndex: 7 })
    const ops = [operation([bareLeg(), other])]
    const out = applyForcedLegs(ops, new Map([[KEY, forced]]))
    expect(out[0]!.legs[0]!.leg).toMatchObject({ destCity: '浦幌', originCity: '北海道釧路市西港１', loadRowIndex: 3 })
    expect(out[0]!.legs[1]!).toBe(other)
  })

  it('映した卸地・手当が便の行に出る (経路キーが釧路|浦幌 になる)', () => {
    const rows = toReportRows(applyForcedLegs([operation([bareLeg()])], new Map([[KEY, forced]])))
    expect(rows[0]).toMatchObject({
      destCity: '浦幌', masterDest: '浦幌', allowanceYen: 9000, status: 'ok', destSource: 'forced',
    })
  })

  it('暫定で決まる便は手当を映さない (「うち暫定」に数えるのは経路キー側の役目)', () => {
    const hiroo = bareLeg({ originCity: '北海道広尾郡広尾町会所前６' })
    const prov = forcedLeg(
      { originCity: '北海道広尾郡広尾町会所前６' },
      [slip({ dest: '大野ﾌｧｰﾑ', destAreaName: '北海道芽室町' })],
      { '広尾|芽室': 9000 },
    )
    const rows = toReportRows(applyForcedLegs([operation([hiroo])], new Map([[KEY, prov]])))
    expect(rows[0]).toMatchObject({ destCity: '芽室', masterDest: '', allowanceYen: null })
  })

  it('結びつけが 1 件も無ければ渡された配列をそのまま返す', () => {
    const ops = [operation([bareLeg()])]
    expect(applyForcedLegs(ops, new Map())).toBe(ops)
  })

  it('どの便にも当たらない結びつけでは運行の identity を変えない', () => {
    const ops = [operation([bareLeg({ fromTs: 1784099999 })])]
    const out = applyForcedLegs(ops, new Map([[KEY, forced]]))
    expect(out[0]!).toBe(ops[0]!)
  })
})

describe('resolveForceMatches', () => {
  const byRowId = new Map([['20260716-1', slip()]])

  it('結んだ便だけを返す', () => {
    const out = resolveForceMatches([row()], { [KEY]: ['20260716-1'] }, byRowId, {})
    expect([...out.keys()]).toEqual([KEY])
    expect(out.get(KEY)!.allowanceYen).toBe(9000)
  })

  it('結んでいない便は出さない', () => {
    expect(resolveForceMatches([row()], {}, byRowId, {}).size).toBe(0)
  })

  it('明細が 1 つも引けないキーは出さない (取り直しで消えた等)', () => {
    const out = resolveForceMatches([row()], { [KEY]: ['no-such-row'] }, byRowId, {})
    expect(out.size).toBe(0)
  })
})

describe('forceMatchCandidates', () => {
  const near = slip({ rowId: 'near' })
  const nextDay = slip({ saleDate: '2026-07-17', rowId: 'next' })
  const farDay = slip({ saleDate: '2026-07-20', rowId: 'far' })
  const otherOrigin = slip({ origin: '苫小牧', rowId: 'other' })

  it('日付が ±1 日の明細だけ出し、積地が一致するものを先に並べる', () => {
    const out = forceMatchCandidates(row(), [otherOrigin, near, nextDay, farDay], new Set(), [])
    expect(out.map(s => s.rowId)).toEqual(['near', 'next', 'other'])
  })

  it('他の便に使われている明細は出さない', () => {
    const out = forceMatchCandidates(row(), [near, nextDay], new Set(['near']), [])
    expect(out.map(s => s.rowId)).toEqual(['next'])
  })

  it('その便に既に結んである明細は、使用済みでも残す (外せなくなるため)', () => {
    const out = forceMatchCandidates(row(), [near, nextDay], new Set(['near']), ['near'])
    expect(out.map(s => s.rowId)).toEqual(['near', 'next'])
  })

  it('積地が取れない便でも候補は出す', () => {
    const out = forceMatchCandidates(row({ originCity: '' }), [near], new Set(), [])
    expect(out.map(s => s.rowId)).toEqual(['near'])
  })
})
