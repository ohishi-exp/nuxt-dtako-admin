import { describe, expect, it } from 'vitest'
import { legKey } from '~/utils/allowance-ichiban'
import { customersOfSlips } from '~/utils/margin'
import {
  LEG_SALES_SNAPSHOT_NOTE,
  LEG_SALES_TITLE,
  OPERATION_LEG_SALES_KEY,
  buildOperationLegSales,
  legSaleYen,
  legSalesNote,
  lookupOperationLegSales,
  lookupUsedSlipIds,
  parseOperationLegSales,
  serializeOperationLegSales,
  usedSlipsNote,
  type LegSalesInput,
  type OperationLegSalesCache,
} from '~/utils/operation-leg-sales'

/**
 * 運行詳細 (`/operations/{運行NO}`) の便ごとの一番星売上 (Refs #820)。
 *
 * **突合は 1 行も無い** — 粗利タブが突合したときに書いた要約を読むだけ。だから
 * ここのテストも「粗利タブが出した額をそのまま持ち回れているか」と「無いときに
 * 無いと言えるか」の 2 点に絞ってある。
 */

/** 本番と同じ形の運行NO (`2607…` = 運行日が頭に付く 22 桁)。 */
const OP_A = '2607031000000000001109'
const OP_B = '2607111000000000001109'

function input(unkoNo: string, seq: number, customers: { name: string, yen: number }[], slipIds: string[] = []): LegSalesInput {
  return { key: `${unkoNo}#${seq}`, customers, slipIds }
}

describe('OPERATION_LEG_SALES_KEY — MarginCache とは別のキー', () => {
  it('★ 別キーであることを固定する (MarginCache の形は変えない作法)', () => {
    expect(OPERATION_LEG_SALES_KEY).toBe('dtako:operations:leg-sales:v1')
  })
})

/**
 * 運行詳細には**突合の数字が 2 つ並ぶ** — こちら (粗利タブの計上額) と `ProfitPanel` の
 * 検証スナップショット。構造的に違う額なので、**ラベルが混ざったら誤読される。**
 * 文言が黙って変わらないよう CI で固定する。
 */
describe('ラベル — 2 つの突合結果を混ぜて読ませない', () => {
  it('★ 見出しは「粗利タブの計上額」と言い切る (「一番星売上」では検証スナップショットと区別が付かない)', () => {
    expect(LEG_SALES_TITLE).toBe('粗利タブの計上額')
  })

  it('★ 注記が「収支パネル」を名指しし、どちらが粗利・印刷に乗るかまで言う', () => {
    expect(LEG_SALES_SNAPSHOT_NOTE).toContain('収支パネル')
    expect(LEG_SALES_SNAPSHOT_NOTE).toContain('検証スナップショット')
    expect(LEG_SALES_SNAPSHOT_NOTE).toContain('印刷に乗るのはこちらの計上額')
  })
})

describe('buildOperationLegSales — 突合結果 → 運行NO 別・便ごとの要約', () => {
  it('運行NO で分け、便 (seq) の昇順に並べる', () => {
    const byUnko = buildOperationLegSales([
      input(OP_A, 2, [{ name: 'B社', yen: 20000 }], ['20260703-13']),
      input(OP_B, 1, [{ name: 'C社', yen: 30000 }]),
      input(OP_A, 1, [{ name: 'A社', yen: 10000 }], ['20260703-12']),
    ])
    expect(Object.keys(byUnko).sort()).toEqual([OP_A, OP_B])
    expect(byUnko[OP_A]!.map(l => l.seq)).toEqual([1, 2])
    expect(byUnko[OP_A]![0]).toEqual({ seq: 1, customers: [{ name: 'A社', yen: 10000 }], slipIds: ['20260703-12'] })
    expect(byUnko[OP_B]).toEqual([{ seq: 1, customers: [{ name: 'C社', yen: 30000 }], slipIds: [] }])
  })

  it('★ 当たっていない便も落とさない (読み側が「当たっていません」と言えるように)', () => {
    const byUnko = buildOperationLegSales([input(OP_A, 1, []), input(OP_A, 2, [{ name: 'A社', yen: 1 }])])
    expect(byUnko[OP_A]).toEqual([
      { seq: 1, customers: [], slipIds: [] },
      { seq: 2, customers: [{ name: 'A社', yen: 1 }], slipIds: [] },
    ])
  })

  it('★ 粗利タブが customersOfSlips で畳んだ額をそのまま持つ (畳み直さない)', () => {
    // 粗利タブ (`reconcileSales`) が渡してくるのと同じ形。同じ取引先Cは 1 行に畳まれ、
    // 便の売上 (`salesYen`) と Σyen が一致する。
    const slips = [
      { customerCode: '000001', customerName: '○○牧場', amount: 41250, rowId: '20260703-12' },
      { customerCode: '000002', customerName: '△△商事', amount: 50000, rowId: '20260703-13' },
      { customerCode: '000001', customerName: '○○牧場(旧名)', amount: 8000, rowId: '20260703-14' },
    ]
    const customers = customersOfSlips(slips)
    const byUnko = buildOperationLegSales([
      { key: legKey({ unkoNo: OP_A, seq: 1 }), customers, slipIds: slips.map(s => s.rowId) },
    ])
    expect(byUnko[OP_A]![0]!.customers).toEqual([
      { name: '○○牧場', yen: 49250 },
      { name: '△△商事', yen: 50000 },
    ])
    expect(legSaleYen(byUnko[OP_A]![0]!)).toBe(slips.reduce((sum, s) => sum + s.amount, 0))
    expect(byUnko[OP_A]![0]!.slipIds).toEqual(['20260703-12', '20260703-13', '20260703-14'])
  })

  it('入力の配列を持ち回さない (元を書き換えても要約は動かない)', () => {
    const customers = [{ name: 'A社', yen: 100 }]
    const slipIds = ['r1']
    const byUnko = buildOperationLegSales([{ key: `${OP_A}#1`, customers, slipIds }])
    customers.push({ name: 'B社', yen: 999 })
    slipIds.push('r2')
    expect(byUnko[OP_A]![0]!.customers).toEqual([{ name: 'A社', yen: 100 }])
    expect(byUnko[OP_A]![0]!.slipIds).toEqual(['r1'])
  })

  it('★ 壊れた鍵は便を作らない (0 番の便をでっち上げない)', () => {
    const byUnko = buildOperationLegSales([
      { key: '#1', customers: [], slipIds: [] },
      { key: 'no-hash', customers: [], slipIds: [] },
      { key: `${OP_A}#`, customers: [], slipIds: [] },
      { key: `${OP_A}#1.5`, customers: [], slipIds: [] },
      { key: `${OP_A}#x`, customers: [], slipIds: [] },
    ])
    expect(byUnko).toEqual({})
  })

  it('運行NO に # が入っていても最後の # で分ける', () => {
    const byUnko = buildOperationLegSales([{ key: 'a#b#3', customers: [], slipIds: [] }])
    expect(byUnko).toEqual({ 'a#b': [{ seq: 3, customers: [], slipIds: [] }] })
  })
})

describe('serializeOperationLegSales / parseOperationLegSales — 書式', () => {
  const cache: OperationLegSalesCache = {
    ym: '2026-07',
    byUnko: {
      [OP_A]: [
        { seq: 1, customers: [{ name: '○○牧場', yen: 41250 }], slipIds: ['20260703-12'] },
        { seq: 2, customers: [], slipIds: [] },
      ],
    },
  }

  it('往復して同じ形に戻る', () => {
    expect(parseOperationLegSales(serializeOperationLegSales(cache))).toEqual(cache)
  })

  it('★ 空の取引先・空の伝票は書かない (便あたり数十バイトに収める)', () => {
    const json = serializeOperationLegSales(cache)
    expect(JSON.parse(json)).toEqual({
      ym: '2026-07',
      legs: { [OP_A]: [{ s: 1, c: [['○○牧場', 41250]], r: ['20260703-12'] }, { s: 2 }] },
    })
  })

  it('★ 便 1 本の大きさが数十バイトに収まる', () => {
    const json = serializeOperationLegSales({
      ym: '2026-07',
      byUnko: { [OP_A]: [{ seq: 1, customers: [{ name: '○○牧場', yen: 41250 }], slipIds: ['20260703-12'] }] },
    })
    // 運行NO (22 桁) と `ym` を除いた、便 1 本ぶんの長さ。
    expect(json.length - `{"ym":"2026-07","legs":{"${OP_A}":[]}}`.length).toBeLessThan(60)
  })

  it('保存が無い / 空文字は null', () => {
    expect(parseOperationLegSales(null)).toBeNull()
    expect(parseOperationLegSales(undefined)).toBeNull()
    expect(parseOperationLegSales('')).toBeNull()
  })

  it('★ 壊れていても投げない (無かったことにする)', () => {
    expect(parseOperationLegSales('{')).toBeNull()
    expect(parseOperationLegSales('null')).toBeNull()
    expect(parseOperationLegSales('12')).toBeNull()
    expect(parseOperationLegSales('{"legs":{}}')).toBeNull()
    expect(parseOperationLegSales('{"ym":7,"legs":{}}')).toBeNull()
    expect(parseOperationLegSales('{"ym":"2026-07"}')).toBeNull()
    expect(parseOperationLegSales('{"ym":"2026-07","legs":null}')).toBeNull()
    expect(parseOperationLegSales('{"ym":"2026-07","legs":3}')).toBeNull()
  })

  it('運行の便が配列でなければその運行を飛ばす', () => {
    expect(parseOperationLegSales(`{"ym":"2026-07","legs":{"${OP_A}":3,"${OP_B}":[{"s":1}]}}`))
      .toEqual({ ym: '2026-07', byUnko: { [OP_B]: [{ seq: 1, customers: [], slipIds: [] }] } })
  })

  it('★ 読めない便は落とす。1 便も読めなければ鍵を作らない (売上 0 円に見せない)', () => {
    expect(parseOperationLegSales(`{"ym":"2026-07","legs":{"${OP_A}":[3,null,{"s":"1"},{"s":1.5}]}}`))
      .toEqual({ ym: '2026-07', byUnko: {} })
  })

  it('★ 取引先が 1 つでも読めない便は丸ごと落とす (金額を黙って低く出さない)', () => {
    const broken = [
      '{"s":1,"c":3}',
      '{"s":1,"c":[3]}',
      '{"s":1,"c":[[1,2]]}',
      '{"s":1,"c":[["A社","x"]]}',
      '{"s":1,"c":[["A社",null]]}',
      '{"s":1,"c":[["A社",1e999]]}',
    ]
    for (const leg of broken) {
      expect(parseOperationLegSales(`{"ym":"2026-07","legs":{"${OP_A}":[${leg}]}}`))
        .toEqual({ ym: '2026-07', byUnko: {} })
    }
    // 読めた便は残る (落とすのは壊れた便だけ)。
    expect(parseOperationLegSales(`{"ym":"2026-07","legs":{"${OP_A}":[{"s":1,"c":3},{"s":2,"c":[["A社",5]]}]}}`))
      .toEqual({ ym: '2026-07', byUnko: { [OP_A]: [{ seq: 2, customers: [{ name: 'A社', yen: 5 }], slipIds: [] }] } })
  })

  it('★ 伝票の識別子が 1 つでも文字でなければ便を丸ごと落とす', () => {
    for (const leg of ['{"s":1,"r":3}', '{"s":1,"r":[7]}']) {
      expect(parseOperationLegSales(`{"ym":"2026-07","legs":{"${OP_A}":[${leg}]}}`))
        .toEqual({ ym: '2026-07', byUnko: {} })
    }
    expect(parseOperationLegSales(`{"ym":"2026-07","legs":{"${OP_A}":[{"s":1,"r":["a","b"]}]}}`))
      .toEqual({ ym: '2026-07', byUnko: { [OP_A]: [{ seq: 1, customers: [], slipIds: ['a', 'b'] }] } })
  })

  it('★ 金額 0 の取引先は落とさない (当たってはいる)', () => {
    expect(parseOperationLegSales(`{"ym":"2026-07","legs":{"${OP_A}":[{"s":1,"c":[["A社",0]]}]}}`))
      .toEqual({ ym: '2026-07', byUnko: { [OP_A]: [{ seq: 1, customers: [{ name: 'A社', yen: 0 }], slipIds: [] }] } })
  })
})

describe('legSaleYen — 便 1 本の売上', () => {
  it('取引先ぶんを足す', () => {
    expect(legSaleYen({ seq: 1, customers: [{ name: 'A社', yen: 10 }, { name: 'B社', yen: 32 }], slipIds: [] })).toBe(42)
  })

  it('★ 当たっていない便は null (0 と出すと「売上 0 円の便」に読める)', () => {
    expect(legSaleYen({ seq: 1, customers: [], slipIds: [] })).toBeNull()
  })

  it('当たったうえで 0 円なら 0 (null にしない)', () => {
    expect(legSaleYen({ seq: 1, customers: [{ name: 'A社', yen: 0 }], slipIds: [] })).toBe(0)
  })
})

describe('lookupOperationLegSales — 運行NO で引く', () => {
  const cache = parseOperationLegSales(serializeOperationLegSales({
    ym: '2026-07',
    byUnko: {
      [OP_A]: [
        { seq: 1, customers: [{ name: 'A社', yen: 10000 }], slipIds: ['20260703-12'] },
        { seq: 2, customers: [], slipIds: [] },
        { seq: 3, customers: [{ name: 'B社', yen: 32000 }], slipIds: [] },
      ],
    },
  }))!

  it('その運行の便と合計を返す', () => {
    const hit = lookupOperationLegSales(cache, OP_A)
    expect(hit.status).toBe('ready')
    expect(hit).toEqual({
      status: 'ready',
      ym: '2026-07',
      legs: cache.byUnko[OP_A],
      salesYen: 42000,
      matchedLegs: 2,
      unmatchedLegs: 1,
    })
  })

  it('★ キーが無ければ missing (推測で突合し直さない)', () => {
    expect(lookupOperationLegSales(null, OP_A)).toEqual({ status: 'missing' })
  })

  it('★ 突合結果にその運行が無ければ not-aggregated (ym を添える)', () => {
    expect(lookupOperationLegSales(cache, OP_B)).toEqual({ status: 'not-aggregated', ym: '2026-07' })
  })

  it('★ 1 便も当たっていない運行の合計は null (0 円と読ませない)', () => {
    const empty = parseOperationLegSales(serializeOperationLegSales({
      ym: '2026-08',
      byUnko: { [OP_B]: [{ seq: 1, customers: [], slipIds: [] }, { seq: 2, customers: [], slipIds: [] }] },
    }))
    expect(lookupOperationLegSales(empty, OP_B)).toEqual({
      status: 'ready',
      ym: '2026-08',
      legs: [{ seq: 1, customers: [], slipIds: [] }, { seq: 2, customers: [], slipIds: [] }],
      salesYen: null,
      matchedLegs: 0,
      unmatchedLegs: 2,
    })
  })
})

describe('legSalesNote — 無いときに「無い」と言う', () => {
  it('★ キーが無いときは「このブラウザの粗利タブで集計すると出ます」', () => {
    // **「このブラウザの」を落とさない** — 保存先が localStorage なので、他端末・他ブラウザ
    // からは必ず空に見える (PR-1 の既知の弱点)。「集計されていない」と言い切ると嘘になる。
    expect(legSalesNote({ status: 'missing' }))
      .toBe('このブラウザの粗利タブで集計すると出ます (便ごとの突合結果がまだありません)')
  })

  it('★ その運行が突合結果に無いときは、集計済みの月を添えて言う', () => {
    expect(legSalesNote({ status: 'not-aggregated', ym: '2026-07' }))
      .toBe('粗利タブの突合結果 (2026-07) にこの運行はありません。この運行の月を粗利タブで集計すると出ます')
  })

  it('便が読めているときは何も言わない (便を並べる)', () => {
    expect(legSalesNote({
      status: 'ready',
      ym: '2026-07',
      legs: [{ seq: 1, customers: [{ name: 'A社', yen: 1 }], slipIds: [] }],
      salesYen: 1,
      matchedLegs: 1,
      unmatchedLegs: 0,
    })).toBeNull()
  })
})

/**
 * **粗利タブ (`reconcileSales`) の突合結果 → 保存 → 運行詳細** を通しで 1 本。
 * 途中でどこも金額を作らない・変えないことを、明細の `amount` の和と突き合わせる。
 */
describe('通し — 粗利タブが出した額がそのまま運行詳細に出る', () => {
  it('明細の amount の和と、運行詳細に出る合計が一致する', () => {
    const slipsBySeq = [
      [
        { customerCode: '000001', customerName: '○○牧場', amount: 41250, rowId: '20260703-12' },
        { customerCode: '000001', customerName: '○○牧場', amount: 8000, rowId: '20260703-13' },
      ],
      [{ customerCode: '000002', customerName: '△△商事', amount: 50000, rowId: '20260703-14' }],
      [],
    ]
    const built = buildOperationLegSales(slipsBySeq.map((slips, i) => ({
      key: legKey({ unkoNo: OP_A, seq: i + 1 }),
      customers: customersOfSlips(slips),
      slipIds: slips.map(s => s.rowId),
    })))
    const hit = lookupOperationLegSales(
      parseOperationLegSales(serializeOperationLegSales({ ym: '2026-07', byUnko: built })), OP_A)
    const expected = slipsBySeq.flat().reduce((sum, s) => sum + s.amount, 0)
    expect(hit).toEqual({
      status: 'ready',
      ym: '2026-07',
      legs: [
        { seq: 1, customers: [{ name: '○○牧場', yen: 49250 }], slipIds: ['20260703-12', '20260703-13'] },
        { seq: 2, customers: [{ name: '△△商事', yen: 50000 }], slipIds: ['20260703-14'] },
        { seq: 3, customers: [], slipIds: [] },
      ],
      salesYen: expected,
      matchedLegs: 2,
      unmatchedLegs: 1,
    })
  })
})

/**
 * **①が既にどこかの便へ当てた明細** (突合一本化 PR-2、Refs #848)。
 *
 * `forceMatchCandidates` の `usedRowIds` に渡すためだけの読み。**空集合に倒したら
 * 二重計上**なので、テストは「読めないときに `ready` を返さないこと」に寄せてある。
 * `parseOperationLegSales` (表示用・読めた便だけ出す) との**厳しさの違い**もここで固定する。
 */
describe('lookupUsedSlipIds — 候補を出してよいかの門番', () => {
  const cache = serializeOperationLegSales({
    ym: '2026-07',
    byUnko: {
      [OP_A]: [
        { seq: 1, customers: [{ name: '○○牧場', yen: 41250 }], slipIds: ['20260703-12'] },
        { seq: 2, customers: [], slipIds: [] },
      ],
      [OP_B]: [{ seq: 1, customers: [{ name: '△△商事', yen: 50000 }], slipIds: ['20260711-30', '20260711-31'] }],
    },
  })

  it('★ byUnko 全体の slipIds の和集合を返す (別の運行が当てた明細も「使用済み」)', () => {
    const hit = lookupUsedSlipIds(cache, OP_A)
    expect(hit.status).toBe('ready')
    expect(hit.status === 'ready' && [...hit.usedRowIds].sort()).toEqual(['20260703-12', '20260711-30', '20260711-31'])
    expect(hit.status === 'ready' && hit.ym).toBe('2026-07')
  })

  it('★ キーが無ければ missing (空の Set を返さない — 空だと①が当てた明細まで候補に並ぶ)', () => {
    expect(lookupUsedSlipIds(null, OP_A)).toEqual({ status: 'missing' })
    expect(lookupUsedSlipIds('', OP_A)).toEqual({ status: 'missing' })
  })

  it('JSON として壊れていれば missing (投げない)', () => {
    expect(lookupUsedSlipIds('{壊れ', OP_A)).toEqual({ status: 'missing' })
  })

  it('object でない / null の JSON も missing', () => {
    expect(lookupUsedSlipIds('5', OP_A)).toEqual({ status: 'missing' })
    expect(lookupUsedSlipIds('null', OP_A)).toEqual({ status: 'missing' })
  })

  it('ym が無い / legs が object でない / legs が null なら missing', () => {
    expect(lookupUsedSlipIds(JSON.stringify({ legs: {} }), OP_A)).toEqual({ status: 'missing' })
    expect(lookupUsedSlipIds(JSON.stringify({ ym: '2026-07', legs: 'x' }), OP_A)).toEqual({ status: 'missing' })
    expect(lookupUsedSlipIds(JSON.stringify({ ym: '2026-07', legs: null }), OP_A)).toEqual({ status: 'missing' })
  })

  it('★ 便が 1 つでも読めなければ全部やめる (parseOperationLegSales より厳しい)', () => {
    const broken = JSON.stringify({ ym: '2026-07', legs: { [OP_A]: [{ s: 1, r: ['20260703-12'] }, { s: 'x' }] } })
    // 表示用は読めた便だけ出す (金額を語らないだけで害が無い)。
    expect(parseOperationLegSales(broken)?.byUnko[OP_A]).toHaveLength(1)
    // こちらは候補を出さない — 読めなかった便が当てた明細が「未使用」に見えると二重計上になる。
    expect(lookupUsedSlipIds(broken, OP_A)).toEqual({ status: 'missing' })
  })

  it('★ 便の一覧が配列でなければ missing (読めた運行だけで済ませない)', () => {
    const broken = JSON.stringify({ ym: '2026-07', legs: { [OP_A]: [{ s: 1 }], [OP_B]: 3 } })
    expect(lookupUsedSlipIds(broken, OP_A)).toEqual({ status: 'missing' })
  })

  it('★ その運行が突合結果に居なければ not-aggregated (月違い。ym を添えて出す)', () => {
    expect(lookupUsedSlipIds(cache, '2608011000000000001109')).toEqual({ status: 'not-aggregated', ym: '2026-07' })
  })

  it('その運行の便が 0 本でも not-aggregated (突合済みで便が無い、とは読ませない)', () => {
    const empty = JSON.stringify({ ym: '2026-07', legs: { [OP_A]: [] } })
    expect(lookupUsedSlipIds(empty, OP_A)).toEqual({ status: 'not-aggregated', ym: '2026-07' })
  })
})

describe('usedSlipsNote — 空の候補一覧を「結べる明細が無い」と読ませない', () => {
  it('★ missing は「このブラウザの粗利タブで集計すると出る」と理由まで言う', () => {
    const note = usedSlipsNote({ status: 'missing' })
    expect(note).toContain('このブラウザの粗利タブ')
    expect(note).toContain('結べる候補が出ます')
    expect(note).toContain('候補を出していません')
  })

  it('★ not-aggregated はどの月の突合結果を見ているかを言う', () => {
    const note = usedSlipsNote({ status: 'not-aggregated', ym: '2026-06' })
    expect(note).toContain('2026-06')
    expect(note).toContain('この運行はありません')
    expect(note).toContain('候補を出していません')
  })

  it('ready のときは何も言わない (候補を出せている)', () => {
    expect(usedSlipsNote({ status: 'ready', ym: '2026-07', usedRowIds: new Set() })).toBeNull()
  })
})
