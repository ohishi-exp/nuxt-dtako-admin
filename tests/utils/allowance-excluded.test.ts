import { describe, it, expect } from 'vitest'
import {
  buildMonthlyAllowance,
  type OperationAllowance,
} from '~/utils/allowance-report'
import type { LegAllowance } from '~/utils/allowance-trips'
import {
  excludedKey,
  unkoNoOfKey,
  parseExcluded,
  serializeExcluded,
  isExcluded,
  toggleExcluded,
  applyExclusions,
  staleExclusionKeys,
} from '~/utils/allowance-excluded'

/** 2026-07 の実データ。3 つ目の積みの後に降しが 1 つも無い運行 (柳井 亮祐 / 帯広800か1318)。 */
const PHANTOM_UNKO = '2607152258300000001318'
const NEXT_UNKO = '2607200412000000001318'
const NO_TS_UNKO = '2607180500000000001318'

const ts = (day: number, hour: number, min: number) => Date.UTC(2026, 6, day, hour, min) / 1000

function leg(over: Partial<LegAllowance['leg']> = {}): LegAllowance['leg'] {
  return {
    loadRowIndex: 0, unloadRowIndexes: [1], originCity: '北海道釧路市西港１',
    destCity: '北海道上士幌町上士幌東3線', viaCities: [], fromTs: ts(15, 23, 0), toTs: null, ...over,
  }
}

function ok(over: Partial<LegAllowance['leg']> = {}, yen = 9000): LegAllowance {
  return { leg: leg(over), lookup: { status: 'ok', allowanceYen: yen, dest: '上士幌', rows: [] }, destSource: 'event' }
}

function op(over: Partial<OperationAllowance> = {}): OperationAllowance {
  return {
    unkoNo: PHANTOM_UNKO, readingDate: '2026-07-16', operationDate: '2026-07-15',
    driverName: '柳井 亮祐', vehicleName: '帯広800か1318', legs: [],
    carryIn: { cities: [], toTs: null }, error: null, ...over,
  }
}

/** 便3 = 降しが無く卸地が決まらない便。**これを外せるようにするのがこの util の目的。** */
const PHANTOM: LegAllowance = {
  leg: leg({ destCity: '', viaCities: [], fromTs: ts(16, 9, 0) }),
  lookup: { status: 'unknown', dest: '' },
  destSource: 'event',
}
/** 卸地を次の運行から引き継いだ便 (推定)。除外すると `carriedTrips` も減る。 */
const CARRIED: LegAllowance = {
  leg: leg({ fromTs: ts(16, 3, 0) }),
  lookup: { status: 'ok', allowanceYen: 12000, dest: '上士幌', rows: [] },
  destSource: 'carried',
}

function monthly() {
  return buildMonthlyAllowance([
    op({ legs: [ok(), CARRIED, PHANTOM] }),
    op({ unkoNo: NEXT_UNKO, readingDate: '2026-07-20', operationDate: '2026-07-20', legs: [ok({ fromTs: ts(20, 4, 12) })] }),
    op({ unkoNo: NO_TS_UNKO, readingDate: '2026-07-18', operationDate: '2026-07-18', legs: [ok({ fromTs: null })] }),
    op({ unkoNo: '2607010000000000001109', driverName: '中村 一由', legs: [], error: 'イベントCSV が未取り込み (has_kudgivt=false)' }),
  ], '2026-07')
}

const PHANTOM_KEY = `${PHANTOM_UNKO}#t${ts(16, 9, 0)}`

describe('excludedKey', () => {
  it('積みの開始日時を鍵にする (seq がずれても同じ便を指す)', () => {
    expect(excludedKey({ unkoNo: PHANTOM_UNKO, seq: 3, fromTs: ts(16, 9, 0) })).toBe(PHANTOM_KEY)
    // 積みが 1 つ増えて seq が 4 になっても同じキー。
    expect(excludedKey({ unkoNo: PHANTOM_UNKO, seq: 4, fromTs: ts(16, 9, 0) })).toBe(PHANTOM_KEY)
  })

  it('開始日時が読めない積みだけ seq に落とす', () => {
    expect(excludedKey({ unkoNo: PHANTOM_UNKO, seq: 3, fromTs: null })).toBe(`${PHANTOM_UNKO}#s3`)
  })
})

describe('unkoNoOfKey', () => {
  it('`#` の手前を運行NO として取る', () => {
    expect(unkoNoOfKey(PHANTOM_KEY)).toBe(PHANTOM_UNKO)
    expect(unkoNoOfKey(`${PHANTOM_UNKO}#s3`)).toBe(PHANTOM_UNKO)
  })

  it('`#` が無ければそのまま返す (壊れた保存値を落とさない)', () => {
    expect(unkoNoOfKey(PHANTOM_UNKO)).toBe(PHANTOM_UNKO)
  })
})

describe('parseExcluded / serializeExcluded', () => {
  it('保存した形をそのまま読み戻す', () => {
    const map = { [PHANTOM_KEY]: true } as const
    expect(parseExcluded(serializeExcluded(map))).toEqual(map)
  })

  it('未設定・壊れた値は空として扱う (投げない)', () => {
    expect(parseExcluded(null)).toEqual({})
    expect(parseExcluded(undefined)).toEqual({})
    expect(parseExcluded('')).toEqual({})
    expect(parseExcluded('{')).toEqual({})
    expect(parseExcluded('42')).toEqual({})
    expect(parseExcluded('null')).toEqual({})
    expect(parseExcluded('["a"]')).toEqual({})
  })

  it('空キーと `true` でない値は捨てる', () => {
    expect(parseExcluded(JSON.stringify({ '': true, 'a': 1, 'b': false, 'c': 'true', 'd': true })))
      .toEqual({ d: true })
  })
})

describe('isExcluded / toggleExcluded', () => {
  const row = { unkoNo: PHANTOM_UNKO, seq: 3, fromTs: ts(16, 9, 0) }

  it('同じキーを渡すたびに 除外 ⇄ 戻す が入れ替わる', () => {
    const added = toggleExcluded({}, PHANTOM_KEY)
    expect(added).toEqual({ [PHANTOM_KEY]: true })
    expect(isExcluded(row, added)).toBe(true)
    const removed = toggleExcluded(added, PHANTOM_KEY)
    expect(removed).toEqual({})
    expect(isExcluded(row, removed)).toBe(false)
  })

  it('渡した map は書き換えない', () => {
    const before = { [PHANTOM_KEY]: true } as const
    toggleExcluded(before, PHANTOM_KEY)
    expect(before).toEqual({ [PHANTOM_KEY]: true })
  })

  it('空キーは何もしない', () => {
    const before = { [PHANTOM_KEY]: true } as const
    expect(toggleExcluded(before, '')).toBe(before)
  })
})

describe('applyExclusions', () => {
  it('除外が 1 件も無ければ、渡した集計をそのまま返す (identity を変えない)', () => {
    const m = monthly()
    const out = applyExclusions(m, {})
    expect(out.monthly).toBe(m)
    expect(out.rows).toEqual([])
    // 当たらないキーだけ持っていても同じ (別の月の除外がこれ)。
    expect(applyExclusions(m, { '2601010000000000009999#t1': true }).monthly).toBe(m)
  })

  it('除外した便を どの合計にも入れない', () => {
    const m = monthly()
    expect(m.trips).toBe(4)
    expect(m.irregularTrips).toBe(1)
    expect(m.totalYen).toBe(9000 + 12000 + 9000 + 9000)

    const out = applyExclusions(m, { [PHANTOM_KEY]: true })
    expect(out.rows.map(r => r.seq)).toEqual([3])
    expect(out.monthly.irregularTrips).toBe(0)
    expect(out.monthly.trips).toBe(4)
    expect(out.monthly.totalYen).toBe(m.totalYen)
    expect(out.monthly.carriedTrips).toBe(1)
    expect(out.monthly.failedOperations).toBe(1)
    expect(out.monthly.outOfMonthTrips).toBe(0)

    const driver = out.monthly.drivers.find(d => d.driverName === '柳井 亮祐')!
    expect(driver.irregularTrips).toBe(0)
    expect(driver.trips).toBe(4)
    const phantomOp = driver.operations.find(o => o.unkoNo === PHANTOM_UNKO)!
    expect(phantomOp.rows.map(r => r.seq)).toEqual([1, 2])
    expect(phantomOp.irregularTrips).toBe(0)
    expect(phantomOp.trips).toBe(2)
    expect(phantomOp.totalYen).toBe(21000)
    expect(phantomOp.carriedTrips).toBe(1)
  })

  it('推定卸地の便を除外すると 推定 の件数も減る', () => {
    const m = monthly()
    const out = applyExclusions(m, { [`${PHANTOM_UNKO}#t${ts(16, 3, 0)}`]: true })
    expect(out.monthly.carriedTrips).toBe(0)
    expect(out.monthly.totalYen).toBe(m.totalYen - 12000)
    expect(out.monthly.trips).toBe(3)
  })

  it('開始日時が読めない便は seq のキーで外れる', () => {
    const out = applyExclusions(monthly(), { [`${NO_TS_UNKO}#s1`]: true })
    expect(out.rows.map(r => r.unkoNo)).toEqual([NO_TS_UNKO])
    expect(out.monthly.trips).toBe(3)
  })

  it('便が 0 になった運行も一覧に残す (運行そのものは実在するため)', () => {
    const out = applyExclusions(monthly(), { [`${NEXT_UNKO}#t${ts(20, 4, 12)}`]: true })
    const driver = out.monthly.drivers.find(d => d.driverName === '柳井 亮祐')!
    const emptied = driver.operations.find(o => o.unkoNo === NEXT_UNKO)!
    expect(emptied.rows).toEqual([])
    expect(emptied.trips).toBe(0)
    expect(emptied.totalYen).toBe(0)
  })

  it('1 便も外れていない運行は同じオブジェクトのまま返す (表の選択を飛ばさない)', () => {
    const m = monthly()
    const out = applyExclusions(m, { [PHANTOM_KEY]: true })
    const before = m.drivers.find(d => d.driverName === '柳井 亮祐')!
    const after = out.monthly.drivers.find(d => d.driverName === '柳井 亮祐')!
    const at = (d: typeof before, unkoNo: string) => d.operations.find(o => o.unkoNo === unkoNo)!
    expect(at(after, NEXT_UNKO)).toBe(at(before, NEXT_UNKO))
    expect(at(after, PHANTOM_UNKO)).not.toBe(at(before, PHANTOM_UNKO))
  })
})

describe('staleExclusionKeys', () => {
  it('除外が無ければ空', () => {
    expect(staleExclusionKeys(monthly(), {})).toEqual([])
  })

  it('当たっている除外は出さない', () => {
    expect(staleExclusionKeys(monthly(), { [PHANTOM_KEY]: true })).toEqual([])
  })

  it('同じ運行が居るのに当たらない除外だけ出す (イベントCSV が変わった疑い)', () => {
    const stale = staleExclusionKeys(monthly(), {
      [PHANTOM_KEY]: true,
      [`${PHANTOM_UNKO}#t999`]: true,
      [PHANTOM_UNKO]: true,
      '2601010000000000009999#t1': true,
    })
    expect(stale).toEqual([PHANTOM_UNKO, `${PHANTOM_UNKO}#t999`])
  })
})
