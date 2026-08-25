import { describe, it, expect } from 'vitest'
import {
  assignRowsToLegs,
  rowLegLookup,
  countUnassigned,
  unassignedNotice,
  legCellClass,
  legLabel,
  legTitle,
  LEG_COLOR_COUNT,
  NO_LEG_ROW,
  UNKNOWN_LEG_ROW,
  type EventRowLeg,
} from '~/utils/event-row-legs'
import { extractOperationIdle, DISTANCE_EVENT_NAMES } from '~/utils/allowance-idle'
import { colIndex, dropIgnoredRows, groupByCrewRole, filterRowsByCategory, classifyEventName } from '~/utils/event-data-table'

const headers = ['開始日時', '終了日時', 'イベント名', '区間距離', '開始市町村名', '終了市町村名']

/** `イベント名` / `区間距離` / 市町村 だけ指定して 1 行を作る (時刻は行順に 1 時間ずつ)。 */
function row(name: string, km = '0', startCity = '', endCity = '', at = 0): string[] {
  const h = String(at).padStart(2, '0')
  const h2 = String(at + 1).padStart(2, '0')
  return [`2026/07/01 ${h}:00:00`, `2026/07/01 ${h2}:00:00`, name, km, startCity, endCity]
}

function rows(specs: Array<[string, string?, string?, string?]>): string[][] {
  return specs.map(([name, km, s, e], i) => row(name, km ?? '0', s ?? '', e ?? '', i))
}

/** 便ごとの区分を `便1:haul` のような文字列にして読みやすくする。 */
function shape(assigned: EventRowLeg[]): string[] {
  return assigned.map(a => (a.legSeq === null ? a.kind : `便${a.legSeq}:${a.kind}`))
}

/**
 * 運行 `2607010121120000001318` (2026-07-01、イベント 14 行) を issue #868 の表から
 * 起こしたもの。**便2 の降しが 2 回**あるのがこの運行の要点。
 * (距離は issue に載っている 4 つだけ実値、他は 0 に置いた。割り当ては行順だけで
 * 決まるので距離の値は結果に影響しない。)
 */
const EXAMPLE_1318: Array<[string, string?, string?, string?]> = [
  ['運行開始'],
  ['運転', '123.7'],
  ['積み', '0', '北海道釧路市西港１-98-41'],
  ['運転', '129.4'],
  ['降し', '0', '', '北海道帯広市川西町'],
  ['運転', '13.2'],
  ['休憩'],
  ['積み', '0', '北海道帯広市西２５条南１'],
  ['運転', '31.0'],
  ['降し', '0', '', '北海道河東郡士幌町中音更'],
  ['運転', '8.0'],
  ['降し', '0', '', '北海道河東郡士幌町上音更'],
  ['運転', '15.8'],
  ['運行終了'],
]

describe('assignRowsToLegs', () => {
  it('issue #868 の実例 (14 行・便2 は降し 2 回) の割り当てが表と一致する', () => {
    expect(shape(assignRowsToLegs(headers, rows(EXAMPLE_1318)))).toEqual([
      // 1-2 運行開始 / 運転 123.7km → 便1 の回送 (往)
      '便1:approach', '便1:approach',
      // 3 積み 釧路市西港１ → 便1 の売上区間の開始
      '便1:haul',
      // 4-5 運転 129.4km / 降し 帯広市川西町 → 便1 (最後の降しまでが売上区間)
      '便1:haul', '便1:haul',
      // 6-7 運転 13.2km / 休憩 → 便2 の回送 (前の便の降し終了 → 次の積み)
      '便2:approach', '便2:approach',
      // 8 積み 帯広市西２５条南１ → 便2
      '便2:haul',
      // 9-12 運転 / 降し 士幌町中音更 / 運転 / 降し 士幌町上音更 → 便2 (降し 2 回)
      '便2:haul', '便2:haul', '便2:haul', '便2:haul',
      // 13-14 運転 15.8km / 運行終了 → 便2 の帰庫 (最後の便だけ)
      '便2:tail', '便2:tail',
    ])
  })

  it('積みが 1 行も無い運行は全行 noLeg (空欄にしない)', () => {
    const assigned = assignRowsToLegs(headers, rows([['運行開始'], ['運転', '10'], ['運行終了']]))
    expect(assigned).toEqual([NO_LEG_ROW, NO_LEG_ROW, NO_LEG_ROW])
  })

  it('イベント名の列が無い CSV は全行 unknown (推測しない)', () => {
    const assigned = assignRowsToLegs(['開始日時', '終了日時'], [['a', 'b'], ['c', 'd']])
    expect(assigned).toEqual([UNKNOWN_LEG_ROW, UNKNOWN_LEG_ROW])
  })

  it('行が 0 本なら空配列', () => {
    expect(assignRowsToLegs(headers, [])).toEqual([])
  })

  it('`イベント名` の列まで届かない短い行は「名前が空の行」として位置で便に入る', () => {
    // CSV は `,` split なので、行が header より短いことが実データでも起きる
    // (`extractOperationIdle` の `cellAt` = `row[idx] ?? ''` と同じ扱いにする)。
    const short = ['2026/07/01 00:00:00']
    const src = [row('運行開始'), row('積み'), short, row('降し'), short]
    expect(shape(assignRowsToLegs(headers, src))).toEqual([
      '便1:approach', '便1:haul', '便1:haul', '便1:haul', '便1:tail',
    ])
  })

  it('降しの無い便は 積み以降が other、次の便に回送を配らない', () => {
    // 積み(1) → 運転 → 積み(2) → 降し → 運転。1 便目は降しが無いので other のまま。
    const assigned = assignRowsToLegs(headers, rows([
      ['積み'], ['運転', '5'], ['積み'], ['降し'], ['運転', '3'],
    ]))
    expect(shape(assigned)).toEqual([
      '便1:other', '便1:other', '便2:haul', '便2:haul', '便2:tail',
    ])
  })

  it('最後の便に降しが無ければ帰庫 (tail) は出ない — 末尾まで other', () => {
    const assigned = assignRowsToLegs(headers, rows([
      ['運行開始'], ['積み'], ['降し'], ['積み'], ['運転', '4'], ['運行終了'],
    ]))
    expect(shape(assigned)).toEqual([
      '便1:approach', '便1:haul', '便1:haul', '便2:other', '便2:other', '便2:other',
    ])
  })

  it('最初の積みより前の降し (前の運行の積み残し) は便を作らず、1 便目の回送に入る', () => {
    const assigned = assignRowsToLegs(headers, rows([
      ['運行開始'], ['降し'], ['運転', '9'], ['積み'], ['降し'], ['運行終了'],
    ]))
    expect(shape(assigned)).toEqual([
      '便1:approach', '便1:approach', '便1:approach', '便1:haul', '便1:haul', '便1:tail',
    ])
  })

  it('重ね掛け行 (速度オーバー等) も落とさず、行の位置で分類する', () => {
    const assigned = assignRowsToLegs(headers, rows([
      ['積み'], ['一般道速度オーバー', '99'], ['降し'], ['専用道', '99'],
    ]))
    expect(shape(assigned)).toEqual(['便1:haul', '便1:haul', '便1:haul', '便1:tail'])
  })

  it('便が 1 本でもあれば、全行がどれかの便に入る (unknown / noLeg が残らない)', () => {
    const assigned = assignRowsToLegs(headers, rows([
      ['運行開始'], ['積み'], ['降し'], ['休憩'], ['積み'], ['運転', '1'],
      ['降し'], ['降し'], ['積み'], ['アイドリング'], ['運行終了'],
    ]))
    expect(assigned.every(a => a.legSeq !== null)).toBe(true)
  })
})

// --- **お金との一致**。列は `extractOperationIdle` の按分を描くだけなので、
//     行ごとの区分の Σ区間距離 が `legKmDetail` と 1 ビット違わないことを検算する。

/** 便 i (0 始まり) の区分 `kind` に入った行の Σ`区間距離`。**重ね掛け行は 0 に倒す** (お金と同じ判定)。 */
function kmOf(src: string[][], assigned: EventRowLeg[], seq: number, kind: EventRowLeg['kind']): number {
  const nameIdx = colIndex(headers, 'イベント名')
  const distIdx = colIndex(headers, '区間距離')
  let sum = 0
  assigned.forEach((a, i) => {
    if (a.legSeq !== seq || a.kind !== kind) return
    if (!DISTANCE_EVENT_NAMES.includes((src[i]![nameIdx] ?? '').trim())) return
    sum += Number(src[i]![distIdx] ?? '') || 0
  })
  return sum
}

describe('assignRowsToLegs は legKmDetail (お金の按分) と同じ行を数える', () => {
  const cases: Record<string, Array<[string, string?, string?, string?]>> = {
    'issue #868 の実例 (14 行)': EXAMPLE_1318,
    '降しの無い便を挟む運行': [
      ['運行開始'], ['運転', '11'], ['積み', '1'], ['運転', '22'], ['積み', '2'],
      ['運転', '33'], ['降し', '3'], ['運転', '44'], ['運行終了', '0.5'],
    ],
    '重ね掛け行が混ざる運行': [
      ['運行開始'], ['一般道空車', '77'], ['運転', '12.5'], ['積み'], ['専用道', '88'],
      ['運転', '30.5'], ['降し', '0.5'], ['連続運転', '99'], ['運転', '7.5'], ['運行終了'],
    ],
    '最後の便に降しが無い運行': [
      ['運行開始'], ['積み', '1'], ['降し', '2'], ['運転', '3'], ['積み', '4'], ['運転', '5'], ['運行終了'],
    ],
    '積み残しの降しがある運行': [
      ['運行開始'], ['降し', '6'], ['運転', '7'], ['積み', '8'], ['降し', '9'], ['運転', '10'], ['運行終了'],
    ],
  }

  for (const [name, spec] of Object.entries(cases)) {
    it(`${name}: 便ごとの haul / approach / tail / other km が legKmDetail と一致`, () => {
      const src = rows(spec)
      const assigned = assignRowsToLegs(headers, src)
      const detail = extractOperationIdle(headers, src).legKmDetail
      expect(detail.length).toBeGreaterThan(0)
      detail.forEach((d, i) => {
        const seq = i + 1
        expect([seq, 'haul', kmOf(src, assigned, seq, 'haul')]).toEqual([seq, 'haul', d.haulKm])
        expect([seq, 'approach', kmOf(src, assigned, seq, 'approach')]).toEqual([seq, 'approach', d.approachKm])
        expect([seq, 'tail', kmOf(src, assigned, seq, 'tail')]).toEqual([seq, 'tail', d.tailKm])
        expect([seq, 'other', kmOf(src, assigned, seq, 'other')]).toEqual([seq, 'other', d.otherKm])
      })
    })
  }

  it('便の本数が legKmDetail と揃う', () => {
    const src = rows(EXAMPLE_1318)
    const assigned = assignRowsToLegs(headers, src)
    const maxSeq = Math.max(...assigned.map(a => a.legSeq ?? 0))
    expect(maxSeq).toBe(extractOperationIdle(headers, src).legKmDetail.length)
  })
})

describe('rowLegLookup', () => {
  it('行オブジェクトそのものから引ける (絞り込んだ配列でも index がずれない)', () => {
    const src = rows(EXAMPLE_1318)
    const lookup = rowLegLookup(headers, src)
    // 表示側と同じように「一部だけ抜いた配列」から引く。
    const picked = [src[12]!, src[2]!]
    expect(picked.map(r => lookup.get(r))).toEqual([
      { legSeq: 2, kind: 'tail' },
      { legSeq: 1, kind: 'haul' },
    ])
  })

  it('表に無い行は undefined (呼び出し側が「判定不能」に倒せる)', () => {
    const lookup = rowLegLookup(headers, rows(EXAMPLE_1318))
    expect(lookup.get(row('運転'))).toBeUndefined()
  })
})

describe('legLabel / legTitle / legCellClass', () => {
  const samples: Array<[EventRowLeg, string]> = [
    [{ legSeq: 2, kind: 'haul' }, '便2'],
    [{ legSeq: 2, kind: 'approach' }, '便2 回送'],
    [{ legSeq: 2, kind: 'tail' }, '便2 帰庫'],
    [{ legSeq: 2, kind: 'other' }, '便2 区分なし'],
    [{ legSeq: null, kind: 'noLeg' }, '便なし'],
    [{ legSeq: null, kind: 'unknown' }, '判定不能'],
  ]

  for (const [leg, label] of samples) {
    it(`${leg.kind} のラベルは ${label}`, () => {
      expect(legLabel(leg)).toBe(label)
    })
  }

  it('売上区間と回送は語でも分かれる (色が読めなくても区別できる)', () => {
    expect(legLabel({ legSeq: 1, kind: 'haul' })).not.toBe(legLabel({ legSeq: 1, kind: 'approach' }))
    expect(legLabel({ legSeq: 1, kind: 'haul' })).not.toBe(legLabel({ legSeq: 1, kind: 'tail' }))
  })

  it('title は kind ごとに違う説明になる', () => {
    const titles = samples.map(([leg]) => legTitle(leg))
    expect(new Set(titles).size).toBe(samples.length)
  })

  it('売上区間は塗りつぶし、回送・区分なしは同じ色の薄い版 (文字色だけ)', () => {
    expect(legCellClass({ legSeq: 1, kind: 'haul' })).toContain('bg-blue-100')
    expect(legCellClass({ legSeq: 1, kind: 'approach' })).toBe('text-blue-600 dark:text-blue-400')
    expect(legCellClass({ legSeq: 1, kind: 'tail' })).toBe('text-blue-600 dark:text-blue-400')
    expect(legCellClass({ legSeq: 1, kind: 'other' })).toBe('text-blue-600 dark:text-blue-400')
  })

  it('便ごとに色が変わり、既存の 4 色 (緑・黄・紫・青緑) を使わない', () => {
    const used = Array.from({ length: LEG_COLOR_COUNT }, (_, i) => legCellClass({ legSeq: i + 1, kind: 'haul' }))
    expect(new Set(used).size).toBe(LEG_COLOR_COUNT)
    for (const cls of used) {
      expect(cls).not.toMatch(/green|yellow|purple|teal/)
    }
  })

  it('色は循環する (便が多い運行で破綻しない) — 便番号はラベルで読み分ける', () => {
    expect(legCellClass({ legSeq: LEG_COLOR_COUNT + 1, kind: 'haul' }))
      .toBe(legCellClass({ legSeq: 1, kind: 'haul' }))
    expect(legLabel({ legSeq: LEG_COLOR_COUNT + 1, kind: 'haul' }))
      .not.toBe(legLabel({ legSeq: 1, kind: 'haul' }))
  })

  it('便に入らない行は色を持たない', () => {
    expect(legCellClass(NO_LEG_ROW)).toBe('text-gray-400 dark:text-gray-500')
    expect(legCellClass(UNKNOWN_LEG_ROW)).toBe('text-gray-400 dark:text-gray-500')
  })
})

// --- **identity を「はず」で通さないための固定** (Refs #868、親の指摘)。
//     引き当て表を CSV 全行から作り、絞り込んだ行から引く設計は
//     「3 段の絞り込みが行オブジェクトを持ち回る」ことに乗っている。
//     その性質そのものをテストにしておけば、壊れたら CI で落ちる。

describe('絞り込み 3 段は行オブジェクトの identity と順序を保つ', () => {
  const wide = ['開始日時', '終了日時', 'イベントCD', 'イベント名', '区間時間', '区間距離', '対象乗務員区分']
  function wideRow(name: string, role: string, cd = '01'): string[] {
    return ['2026/07/01 00:00:00', '2026/07/01 01:00:00', cd, name, '0', '0', role]
  }
  const all = [
    wideRow('運行開始', '1'), wideRow('急加速', '1', '401'), wideRow('積み', '1'),
    wideRow('一般道空車', '1'), wideRow('降し', '1'), wideRow('積み', '2'),
    wideRow('降し', '2'), wideRow('運行終了', '1'),
  ]

  it('dropIgnoredRows → groupByCrewRole → filterRowsByCategory の後も `===` で元の行', () => {
    const kept = dropIgnoredRows(wide, all, new Set(['401']))
    // 急加速 (401、0km/0分) が落ちていること = このテストが素通りしていない担保。
    expect(kept.length).toBe(all.length - 1)
    const groups = groupByCrewRole(wide, kept)
    expect(groups.length).toBeGreaterThan(1)
    const nameIdx = colIndex(wide, 'イベント名')
    for (const g of groups) {
      const shown = filterRowsByCategory(g.rows, nameIdx, 'event')
      expect(shown.length).toBeGreaterThan(0)
      for (const r of shown) {
        // `includes` は `===` 比較。中身が同じ別オブジェクトでは通らない。
        expect(all.includes(r)).toBe(true)
      }
    }
  })

  it('その identity の上で、便番号は CSV 全行基準になる (乗務員 2 のぶんが 便2)', () => {
    const lookup = rowLegLookup(wide, all)
    const nameIdx = colIndex(wide, 'イベント名')
    const crew2 = groupByCrewRole(wide, all).find(g => g.crewRole === '2')!
    const shown = filterRowsByCategory(crew2.rows, nameIdx, 'event')
    expect(shown.map(r => lookup.get(r))).toEqual([
      { legSeq: 2, kind: 'haul' }, { legSeq: 2, kind: 'haul' },
    ])
  })
})

describe('countUnassigned / unassignedNotice', () => {
  it('便が全部付いていれば注意書きは出ない (null)', () => {
    const assigned = assignRowsToLegs(headers, rows(EXAMPLE_1318))
    expect(countUnassigned(assigned)).toEqual({ noLeg: 0, unknown: 0 })
    expect(unassignedNotice(countUnassigned(assigned))).toBeNull()
  })

  it('判定できなかった行と、便に属さない行を別々に数えて言う', () => {
    expect(unassignedNotice({ unknown: 3, noLeg: 0 })).toBe('便を判定できなかった行 3 件')
    expect(unassignedNotice({ unknown: 0, noLeg: 2 })).toBe('積みが 1 行も無いため便に属さない行 2 件')
    expect(unassignedNotice({ unknown: 3, noLeg: 2 }))
      .toBe('便を判定できなかった行 3 件 / 積みが 1 行も無いため便に属さない行 2 件')
  })

  it('積みが 1 行も無い運行は noLeg として数える (unknown ではない)', () => {
    const assigned = assignRowsToLegs(headers, rows([['運行開始'], ['運転', '3']]))
    expect(countUnassigned(assigned)).toEqual({ noLeg: 2, unknown: 0 })
  })
})

describe('イベントタブに出る行の範囲 (buildOperationRoute の走査を流用できない理由)', () => {
  it('連続運転・急加速系は `event` に落ちてイベントタブに並ぶ', () => {
    for (const name of ['連続運転', '急加速', '急減速', '急カーブ']) {
      expect(classifyEventName(name)).toBe('event')
    }
  })

  it('その 4 つは DISTANCE_EVENT_NAMES に無い — 流用すると便が付かない行になる', () => {
    for (const name of ['連続運転', '急加速', '急減速', '急カーブ']) {
      expect(DISTANCE_EVENT_NAMES).not.toContain(name)
    }
  })

  it('連続運転の行にも位置で便が付く', () => {
    const assigned = assignRowsToLegs(headers, rows([
      ['運行開始'], ['積み'], ['連続運転', '252.9'], ['降し'], ['運行終了'],
    ]))
    expect(shape(assigned)).toEqual([
      '便1:approach', '便1:haul', '便1:haul', '便1:haul', '便1:tail',
    ])
  })
})
