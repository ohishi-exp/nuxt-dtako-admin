import { describe, it, expect } from 'vitest'
import type { AllowanceReportRow } from '~/utils/allowance-report'
import {
  routeKey,
  parseProvisional,
  serializeProvisional,
  setProvisional,
  provisionalFor,
  summarizeProvisional,
  emptyProvisionalTotals,
  provisionalRoutes,
} from '~/utils/allowance-provisional'

/** 2026-07 に実在した「マスタの穴」= 広尾 → 芽室 (マスタに芽室が 1 行も無い)。 */
function row(over: Partial<AllowanceReportRow> = {}): AllowanceReportRow {
  return {
    unkoNo: '26070106130100000000161',
    date: '2026-07-01',
    driverName: '佐竹 繁',
    vehicleName: '十勝800か16',
    seq: 1,
    originCity: '北海道広尾郡広尾町会所前６',
    destCity: '北海道河西郡芽室町祥栄北８線',
    viaCities: '',
    masterDest: '',
    allowanceYen: null,
    status: 'unknown',
    destSource: 'event',
    ...over,
  }
}

describe('routeKey', () => {
  it('デジタコの住所から `積地|卸地` を組む', () => {
    expect(routeKey(row())).toBe('広尾|芽室')
  })

  it('マスタで卸地が決まっていればその語彙を使う', () => {
    expect(routeKey(row({ masterDest: '清水DF' }))).toBe('広尾|清水DF')
  })

  it('積地も卸地も取れなければ空 (暫定を当てられない)', () => {
    expect(routeKey(row({ originCity: '', destCity: '', masterDest: '' }))).toBe('')
  })
})

describe('parseProvisional', () => {
  it('保存した形を読み戻す', () => {
    const map = { '広尾|芽室': 9000 }
    expect(parseProvisional(serializeProvisional(map))).toEqual(map)
  })

  it('空・壊れた JSON・配列・オブジェクトでない値は空として扱う', () => {
    expect(parseProvisional(null)).toEqual({})
    expect(parseProvisional('')).toEqual({})
    expect(parseProvisional('{')).toEqual({})
    expect(parseProvisional('[1,2]')).toEqual({})
    expect(parseProvisional('null')).toEqual({})
    expect(parseProvisional('"x"')).toEqual({})
  })

  it('給与に混ざる数字なので、数でない・0 以下・小数・空キーは捨てる', () => {
    expect(parseProvisional(JSON.stringify({
      '広尾|芽室': 9000,
      '文字列': '9000',
      'ゼロ': 0,
      'マイナス': -1,
      '小数': 9000.5,
      '': 9000,
    }))).toEqual({ '広尾|芽室': 9000 })
  })
})

describe('setProvisional', () => {
  it('入れる・上書きする', () => {
    expect(setProvisional({}, '広尾|芽室', 9000)).toEqual({ '広尾|芽室': 9000 })
    expect(setProvisional({ '広尾|芽室': 9000 }, '広尾|芽室', 8000)).toEqual({ '広尾|芽室': 8000 })
  })

  it('0 以下・小数・空キーは消す扱い (入力欄を空にしたら外れる)', () => {
    const map = { '広尾|芽室': 9000 }
    expect(setProvisional(map, '広尾|芽室', 0)).toEqual({})
    expect(setProvisional(map, '広尾|芽室', -1)).toEqual({})
    expect(setProvisional(map, '広尾|芽室', 1.5)).toEqual({})
    expect(setProvisional(map, '', 9000)).toEqual(map)
  })

  it('元の Map を壊さない', () => {
    const map = { '広尾|芽室': 9000 }
    setProvisional(map, '広尾|芽室', 0)
    expect(map).toEqual({ '広尾|芽室': 9000 })
  })
})

describe('provisionalFor', () => {
  const map = { '広尾|芽室': 9000 }

  it('手当が決まらない便に経路の暫定を当てる', () => {
    expect(provisionalFor(row(), map)).toBe(9000)
  })

  it('マスタで金額が決まっている便には当てない (確定を上書きしない)', () => {
    expect(provisionalFor(row({ allowanceYen: 8000, masterDest: '清水DF' }), map)).toBeNull()
  })

  it('経路の暫定が無ければ null', () => {
    expect(provisionalFor(row(), {})).toBeNull()
  })
})

describe('summarizeProvisional', () => {
  it('暫定が当たった便と、暫定も無い便を分けて数える', () => {
    const rows = [
      row({ seq: 1 }),
      row({ seq: 2 }),
      row({ seq: 3, destCity: '北海道中川郡本別町南３' }),
      row({ seq: 4, allowanceYen: 8000, masterDest: '清水DF' }),
    ]
    expect(summarizeProvisional(rows, { '広尾|芽室': 9000 }))
      .toEqual({ trips: 2, yen: 18000, missingTrips: 1 })
  })

  it('対象が無ければ 0', () => {
    expect(summarizeProvisional([], {})).toEqual(emptyProvisionalTotals())
  })
})

describe('provisionalRoutes', () => {
  it('手当が決まらない便を経路ごとに畳んで、いま入っている額を添える', () => {
    const rows = [
      row({ seq: 1 }),
      row({ seq: 2 }),
      row({ seq: 3, destCity: '北海道中川郡本別町南３' }),
      row({ seq: 4, allowanceYen: 8000 }),
    ]
    expect(provisionalRoutes(rows, { '広尾|芽室': 9000 })).toEqual([
      { key: '広尾|本別', trips: 1, yen: null, label: '広尾 → 本別' },
      { key: '広尾|芽室', trips: 2, yen: 9000, label: '広尾 → 芽室' },
    ])
  })

  it('出てきた順ではなく経路キー順に並べる', () => {
    const rows = [
      row({ seq: 1, destCity: '北海道中川郡本別町南３' }),
      row({ seq: 2 }),
    ]
    expect(provisionalRoutes(rows, {}).map(r => r.key)).toEqual(['広尾|本別', '広尾|芽室'])
  })

  it('経路キーが組めない便は出さない', () => {
    expect(provisionalRoutes([row({ originCity: '', destCity: '' })], {})).toEqual([])
  })
})
