import { describe, expect, it } from 'vitest'
import { forceMatchKey } from '~/utils/allowance-force-match'
import type { AllowanceLeg } from '~/utils/allowance-trips'
import type { ScoredVehicleDailySlip, VehicleDailySlip } from '~/utils/ichiban'
import {
  FORCE_MATCH_FROZEN_NOTE,
  FORCE_MATCH_ICHIBAN_NOTE,
  FORCE_MATCH_OVERRIDE_NOTE,
  FORCE_MATCH_PANEL_NOTE,
  boundSlips,
  effectiveSlipIds,
  legsInSelection,
  ownSlipIds,
  seedForceMatch,
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

  it('★ 上書きであって足し算ではないと言い切る (金額が下がった理由が分からなくなる)', () => {
    expect(FORCE_MATCH_OVERRIDE_NOTE).toContain('上書きとして保存されます')
    expect(FORCE_MATCH_OVERRIDE_NOTE).toContain('足し算ではありません')
  })

  it('★★ 「①が当てた明細はチェック済みで出ている」と言う (Refs #854)', () => {
    expect(FORCE_MATCH_OVERRIDE_NOTE).toContain('チェック済みで出ています')
  })

  it('★★ 候補の範囲を「どの便にも」と言う (「他の便に」だと、①が当てた明細が候補に無いのを取りこぼしと読む)', () => {
    expect(FORCE_MATCH_OVERRIDE_NOTE).toContain('まだどの便にも当たっていない明細だけ')
    expect(FORCE_MATCH_OVERRIDE_NOTE).not.toContain('他の便に当たっていない明細だけ')
  })

  it('★★ ①が当てている便では「土台にする」「追従をやめる」「全部外すと①に戻る」を言う (Refs #854)', () => {
    expect(FORCE_MATCH_ICHIBAN_NOTE).toContain('粗利タブが当てたもの')
    expect(FORCE_MATCH_ICHIBAN_NOTE).toContain('土台にした上書き')
    // ★ **触ると①の追従が止まる。**「置き換えです」だけだと「今回の集計で置き換わる」と
    // 読まれ、**次の月次で伝票が直っても反映されない**ことに気づけない。
    expect(FORCE_MATCH_ICHIBAN_NOTE).toContain('粗利タブの集計に追従しなくなります')
    // **外し方の帰結を言わないと次の誤読が生まれる** — 空にはならず①の結果に戻る。
    expect(FORCE_MATCH_ICHIBAN_NOTE).toContain('全部外すと粗利タブの結果に戻ります')
    expect(FORCE_MATCH_ICHIBAN_NOTE).toContain('売上 0 円にすることはできません')
  })

  it('★★ 触った便では「もう追従していない」と戻し方を言う (Refs #854)', () => {
    expect(FORCE_MATCH_FROZEN_NOTE).toContain('人の上書きです')
    expect(FORCE_MATCH_FROZEN_NOTE).toContain('集計し直しても')
    expect(FORCE_MATCH_FROZEN_NOTE).toContain('伝票が直っても')
    expect(FORCE_MATCH_FROZEN_NOTE).toContain('追従しません')
    expect(FORCE_MATCH_FROZEN_NOTE).toContain('全部外すと粗利タブの結果に戻ります')
  })
})

/**
 * **①が当てた明細を画面に映す** (Refs #854)。#849 の収支パネルは `FORCE_MATCH_KEY` しか
 * 見ておらず、①が当てている便が「結び 0 件・0 円」に見えた。そのまま 1 件結ぶと
 * `applyForcedSales` の置き換えで①の売上が消え、消えた明細は `usedRowIds` に居るので
 * **候補にも出ず戻せない** (本番 v0.0.532 で実際にこの状態だった)。
 */
describe('effectiveSlipIds — その便にいま当たっている明細', () => {
  it('★ 人の上書きがあればそれが全部 (①の結果は効いていない = 置き換え)', () => {
    expect(effectiveSlipIds(['x'], ['a', 'b'])).toEqual({ ids: ['x'], source: 'forced' })
  })

  it('★ 上書きが無ければ①の結果 (「結び 0 件」に見せない)', () => {
    expect(effectiveSlipIds(undefined, ['a', 'b'])).toEqual({ ids: ['a', 'b'], source: 'ichiban' })
  })

  it('どちらも無ければ空 (source も none — 誰かが当てたことにしない)', () => {
    expect(effectiveSlipIds(undefined, [])).toEqual({ ids: [], source: 'none' })
  })

  it('★ 元の配列を持ち回らない (呼び出し側の書き換えが保存済みの値に漏れない)', () => {
    const ichiban = ['a']
    const out = effectiveSlipIds(undefined, ichiban)
    out.ids.push('b')
    expect(ichiban).toEqual(['a'])
  })
})

/**
 * **`own` は「いま当たっている」ではない** (Refs #854)。`effectiveSlipIds().ids` を
 * 流用すると、人が①の明細を外した瞬間にそれが `own` から外れ、`usedRowIds` には
 * 残っているので**候補からも消える** = その場で戻せない。
 */
describe('ownSlipIds — その便に出してよい相手', () => {
  it('★★ 人が外した①の明細も出してよい (外すと候補からも消えると押し間違いが取り返せない)', () => {
    // ①が {a,b} を当てていて、人が a を外して {b} にした状態。
    expect(ownSlipIds(['b'], ['a', 'b'])).toEqual(['b', 'a'])
  })

  it('上書きが無ければ①の結果がそのまま (触る前の便)', () => {
    expect(ownSlipIds(undefined, ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('①が当てていなければ人の上書きだけ (降しの記録が無い便)', () => {
    expect(ownSlipIds(['x'], [])).toEqual(['x'])
  })

  it('どちらも無ければ空 (①も人も当てていない便)', () => {
    expect(ownSlipIds(undefined, [])).toEqual([])
  })

  it('重複は 1 つに畳む (同じ明細が 2 行並ばない)', () => {
    expect(ownSlipIds(['a'], ['a'])).toEqual(['a'])
  })

  it('★ 他の便の明細は 1 件も入らない — 入れるのは渡された 2 つだけ (フィルタは緩めない)', () => {
    // 引数に無い `z` (他の便のもの) が混ざらないことを、返り値の集合で固定する。
    expect(new Set(ownSlipIds(['a'], ['b']))).toEqual(new Set(['a', 'b']))
  })
})

describe('seedForceMatch — 人が触った瞬間に①の結果を土台として書き起こす', () => {
  it('★★ ①が当てている便を触ると、その結果が土台になる (土台なしだと 1 件足すだけで残りが消える)', () => {
    expect(seedForceMatch({}, 'op#t1', ['a', 'b'])).toEqual({ 'op#t1': ['a', 'b'] })
  })

  it('★ 既に人の上書きがある便は触らない (人が外したものを勝手に戻さない)', () => {
    const map = { 'op#t1': ['a'] }
    expect(seedForceMatch(map, 'op#t1', ['a', 'b'])).toBe(map)
  })

  it('★ ①も当てていない便は書き起こさない (同じ参照を返す)', () => {
    const map = {}
    expect(seedForceMatch(map, 'op#t1', [])).toBe(map)
  })

  it('★ 他の便の上書きは巻き込まない', () => {
    expect(seedForceMatch({ 'op#t9': ['z'] }, 'op#t1', ['a'])).toEqual({ 'op#t9': ['z'], 'op#t1': ['a'] })
  })

  it('★ 土台は写しで持つ (①の結果の配列をそのまま参照しない)', () => {
    const ichiban = ['a']
    const next = seedForceMatch({}, 'op#t1', ichiban)
    next['op#t1']!.push('b')
    expect(ichiban).toEqual(['a'])
  })
})
