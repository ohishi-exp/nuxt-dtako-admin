import { describe, expect, it } from 'vitest'
import { forceMatchKey } from '~/utils/allowance-force-match'
import type { AllowanceLeg } from '~/utils/allowance-trips'
import type { ScoredVehicleDailySlip, VehicleDailySlip } from '~/utils/ichiban'
import {
  FORCE_MATCH_OVERRIDE_NOTE,
  FORCE_MATCH_PANEL_NOTE,
  boundSlips,
  legsInSelection,
  slipBadge,
  slipRows,
  sumAmount,
} from '~/utils/profit-panel-legs'

/**
 * 収支パネルの「どの便に結ぶか」(突合一本化 PR-2、Refs #848)。
 *
 * **突合は 1 行も無い。** 便の切り出しは `extractAllowanceLegs`、候補は
 * `forceMatchCandidates` が持っていて、ここにあるのは「選択区間に入る便を出す」
 * 「結んである明細を必ず外せるように並べる」「引けなかったぶんを黙って落とさない」
 * の 3 点だけ。テストもそこに絞る。
 */

/** 本番と同じ形の運行NO (22 桁)。 */
const UNKO = '2607161000000000001318'

/** 2026-07-16 09:31 JST 相当の epoch 秒 (`parseEventDatetimeToTs` と同じ単位)。 */
const T0916 = Date.UTC(2026, 6, 16, 0, 31) / 1000

function leg(overrides: Partial<AllowanceLeg> = {}): AllowanceLeg {
  return {
    loadRowIndex: 0,
    unloadRowIndexes: [],
    originCity: '北海道釧路市西港1-98-41',
    destCity: '',
    viaCities: [],
    fromTs: T0916,
    toTs: null,
    ...overrides,
  }
}

function slip(overrides: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-07-16',
    vehicleNumber: '1318',
    customerCode: '000001',
    customerName: '㈱田浦畜産',
    originAreaName: '釧路',
    destAreaName: '上士幌',
    origin: '釧路',
    dest: '上士幌',
    isSubcontracted: false,
    amount: 41250,
    itemCode: '',
    itemName: '',
    quantity: 0,
    unitPrice: 0,
    unit: '',
    rowId: '20260716-12',
    requestKind: '0',
    ...overrides,
  }
}

describe('legsInSelection — 選択区間に積みが入っている便', () => {
  it('★ 鍵は forceMatchKey と 1 文字も違わない (①が読む鍵と同じでなければ結んでも届かない)', () => {
    const { legs } = legsInSelection(UNKO, [leg()], { fromTs: T0916, toTs: T0916 + 3600 })
    expect(legs).toHaveLength(1)
    expect(legs[0]!.key).toBe(forceMatchKey({ unkoNo: UNKO, seq: 1, fromTs: T0916 }))
    expect(legs[0]!.key).toBe(`${UNKO}#t${T0916}`)
  })

  it('★ seq は積みの並び順 (①の legKey と同じ数え方) で、区間の外の便は出さない', () => {
    const legs = [
      leg({ fromTs: T0916 - 7200 }),
      leg({ fromTs: T0916 }),
      leg({ fromTs: T0916 + 7200 }),
    ]
    const picked = legsInSelection(UNKO, legs, { fromTs: T0916 - 60, toTs: T0916 + 60 })
    expect(picked.legs.map(l => l.seq)).toEqual([2])
  })

  it('区間の両端を含む (提案区間の fromTs は積みの開始日時そのものなので、含めないと自分が落ちる)', () => {
    const legs = [leg({ fromTs: T0916 }), leg({ fromTs: T0916 + 3600 })]
    const picked = legsInSelection(UNKO, legs, { fromTs: T0916, toTs: T0916 + 3600 })
    expect(picked.legs.map(l => l.seq)).toEqual([1, 2])
  })

  it('積地・卸地・日付をそのまま持ち回る (卸地が空の便もそのまま = 結ぶと決まる便)', () => {
    const { legs } = legsInSelection(
      UNKO,
      [leg({ originCity: '北海道釧路市西港1', destCity: '' })],
      { fromTs: T0916, toTs: T0916 },
    )
    expect(legs[0]).toMatchObject({
      seq: 1,
      date: '2026-07-16',
      originCity: '北海道釧路市西港1',
      destCity: '',
    })
  })

  it('★ 開始日時が読めない積みは「入っていない」ではなく undated に数える (黙って落とすと便が 1 本しか無いように読める)', () => {
    const picked = legsInSelection(UNKO, [leg({ fromTs: null }), leg()], { fromTs: T0916, toTs: T0916 })
    expect(picked.legs.map(l => l.seq)).toEqual([2])
    expect(picked.undated).toBe(1)
  })

  it('区間が無ければ便も出さない (undated も数えない — 判定する対象が無い)', () => {
    expect(legsInSelection(UNKO, [leg({ fromTs: null }), leg()], null)).toEqual({ legs: [], undated: 0 })
  })

  it('便が 1 本も無い CSV では空 (推測で便を作らない)', () => {
    expect(legsInSelection(UNKO, [], { fromTs: 0, toTs: 1 })).toEqual({ legs: [], undated: 0 })
  })
})

describe('boundSlips — 結んである明細', () => {
  const byRowId = new Map([['a', slip({ rowId: 'a' })], ['b', slip({ rowId: 'b' })]])

  it('保存した順で返す', () => {
    expect(boundSlips(['b', 'a'], byRowId).slips.map(s => s.rowId)).toEqual(['b', 'a'])
  })

  it('★ 引けなかった rowId は黙って落とさず数える (「結びつけが消えた」と読ませない)', () => {
    const { slips, missing } = boundSlips(['a', 'zzz'], byRowId)
    expect(slips.map(s => s.rowId)).toEqual(['a'])
    expect(missing).toBe(1)
  })

  it('1 つも結んでいなければ空・欠けも 0', () => {
    expect(boundSlips([], byRowId)).toEqual({ slips: [], missing: 0 })
  })
})

describe('slipRows — 結んである明細を先に置く', () => {
  it('★ 日付の外に結んだ明細も必ず並ぶ (候補に出ない明細を外せなくなるのを防ぐ)', () => {
    const bound = [slip({ rowId: 'far', saleDate: '2026-07-20' })]
    const candidates = [slip({ rowId: 'near' })]
    expect(slipRows(bound, candidates).map(s => s.rowId)).toEqual(['far', 'near'])
  })

  it('候補に混ざっている「結んである明細」は二重に並べない', () => {
    const bound = [slip({ rowId: 'a' })]
    const candidates = [slip({ rowId: 'a' }), slip({ rowId: 'b' })]
    expect(slipRows(bound, candidates).map(s => s.rowId)).toEqual(['a', 'b'])
  })
})

describe('sumAmount', () => {
  it('売上を足す (forcedLeg の salesYen と同じ足し方)', () => {
    expect(sumAmount([slip({ amount: 41250 }), slip({ amount: 22000 })])).toBe(63250)
  })

  it('明細が無ければ 0', () => {
    expect(sumAmount([])).toBe(0)
  })
})

describe('slipBadge — 根拠バッジ', () => {
  function scored(score: number, suggested: boolean): Pick<ScoredVehicleDailySlip, 'score' | 'suggested'> {
    return { score, suggested }
  }

  it('積地・卸地とも当たれば完全一致', () => {
    expect(slipBadge(scored(4, true))).toBe('exact')
  })

  it('片側だけ当たれば部分一致', () => {
    expect(slipBadge(scored(1, false))).toBe('partial')
  })

  it('どちらも当たらなければ根拠なし', () => {
    expect(slipBadge(scored(0, false))).toBe('none')
  })

  it('スコアを持っていない明細は「根拠なし」(「結べない」ではない)', () => {
    expect(slipBadge(undefined)).toBe('none')
  })
})

describe('画面の文言 — 何がどう変わったかを読めるようにする', () => {
  it('★ 保存先が変わったこと・粗利に効くこと・古いスナップショットが残ることを全部言う', () => {
    expect(FORCE_MATCH_PANEL_NOTE).toContain('確定の保存先が変わりました')
    expect(FORCE_MATCH_PANEL_NOTE).toContain('粗利タブ・運行手当タブの集計')
    expect(FORCE_MATCH_PANEL_NOTE).toContain('消えていません')
    expect(FORCE_MATCH_PANEL_NOTE).toContain('これ以降は増えません')
  })

  it('★ 結ぶと「置き換わる」と言い切る (足し算だと読まれると金額が下がった理由が分からない)', () => {
    expect(FORCE_MATCH_OVERRIDE_NOTE).toContain('置き換わります')
    expect(FORCE_MATCH_OVERRIDE_NOTE).toContain('足し算ではありません')
    expect(FORCE_MATCH_OVERRIDE_NOTE).toContain('他の便に当たっていない明細だけ')
  })
})
