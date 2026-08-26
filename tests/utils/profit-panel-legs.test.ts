import { describe, expect, it } from 'vitest'
import { forceMatchKey } from '~/utils/allowance-force-match'
import type { AllowanceLeg } from '~/utils/allowance-trips'
import type { VehicleDailySlip } from '~/utils/ichiban'
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
  slipMatch,
  slipSideNote,
  LEG_DEST_MISSING_NOTE,
  badgeTargetNote,
  legDestKnown,
  legMatchTarget,
  legRouteLabel,
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

describe('slipMatch — 根拠バッジ (Refs #858)', () => {
  /**
   * **②の `scoreVehicleDailySlips` を撤去して `combinedMatchLevel` に寄せた。**
   * 撤去前は `suggested` (= 積地・卸地の両方が none でない) を `exact` として出していたので、
   * **partial + partial が画面に「完全一致」と出ていた**。`/profit/monthly` の保存済み一覧は
   * 同じものを `combinedMatchLevel` で「部分」と数えており、**同じ言葉が 2 画面で違う意味**
   * だった。ここで固定するのは「**両方 exact のときだけ完全一致**」。
   */
  const badge = (loc: { originCity: string, destCity: string } | null, sl: VehicleDailySlip) =>
    slipMatch(loc, sl).badge

  it('積地・卸地とも完全一致のときだけ「完全一致」', () => {
    const s = slip({ originAreaName: '北海道釧路市', destAreaName: '福岡県北九州市' })
    expect(badge({ originCity: '北海道釧路市', destCity: '福岡県北九州市' }, s)).toBe('exact')
  })

  it('★ 両方 partial は「部分一致」— 撤去前は「完全一致」と出ていた嘘 (帯広の実データで日常的に出る)', () => {
    const s = slip({ originAreaName: '北海道釧路市', destAreaName: '北海道標茶町' })
    expect(badge({ originCity: '北海道釧路市西港２-101-1', destCity: '北海道川上郡標茶町多和' }, s))
      .toBe('partial')
  })

  it('片方が exact でももう片方が partial なら「部分一致」', () => {
    const s = slip({ originAreaName: '北海道釧路市', destAreaName: '北海道標茶町' })
    expect(badge({ originCity: '北海道釧路市', destCity: '北海道川上郡標茶町多和' }, s)).toBe('partial')
  })

  it('★ 片側だけ当たり (もう片方が none) は「根拠なし」— 撤去前は「部分一致」と出ていた', () => {
    const s = slip({ originAreaName: '北海道釧路市', destAreaName: '東京都' })
    expect(badge({ originCity: '北海道釧路市', destCity: '福岡県北九州市' }, s)).toBe('none')
  })

  it('どちらも当たらなければ「根拠なし」', () => {
    const s = slip({ originAreaName: '東京都', destAreaName: '大阪府' })
    expect(badge({ originCity: '北海道釧路市', destCity: '福岡県北九州市' }, s)).toBe('none')
  })

  it('地域ﾏｽﾀ (`originAreaName`) が空なら自由記述 (`origin`) で判定する — ②から引き取った作法', () => {
    const s = slip({ originAreaName: '', origin: '北海道釧路市', destAreaName: '福岡県北九州市' })
    expect(badge({ originCity: '北海道釧路市', destCity: '福岡県北九州市' }, s)).toBe('exact')
  })

  it('地域ﾏｽﾀが当たらなければ自由記述を見る (地域ﾏｽﾀ優先は「空なら」ではなく「none なら」)', () => {
    const s = slip({ originAreaName: '東京都', origin: '北海道釧路市', destAreaName: '福岡県北九州市' })
    expect(badge({ originCity: '北海道釧路市', destCity: '福岡県北九州市' }, s)).toBe('exact')
  })

  it('地域ﾏｽﾀが当たっていれば自由記述は見ない (先に決まる)', () => {
    const s = slip({ originAreaName: '北海道釧路市', origin: '東京都', destAreaName: '福岡県北九州市' })
    expect(badge({ originCity: '北海道釧路市', destCity: '福岡県北九州市' }, s)).toBe('exact')
  })

  it('選択区間の積地・卸地が取れていない (`location` が null) なら「根拠なし」— 「結べない」ではない', () => {
    const s = slip({ originAreaName: '北海道釧路市', destAreaName: '福岡県北九州市' })
    expect(badge(null, s)).toBe('none')
  })

  it('卸地だけ取れていない選択区間は「根拠なし」(積地が完全一致でも)', () => {
    const s = slip({ originAreaName: '北海道釧路市', destAreaName: '福岡県北九州市' })
    expect(badge({ originCity: '北海道釧路市', destCity: '' }, s)).toBe('none')
  })

  it('★ 畳む前の両側を必ず返す (バッジだけにしない)', () => {
    const s = slip({ originAreaName: '北海道釧路市', destAreaName: '東京都' })
    expect(slipMatch({ originCity: '北海道釧路市', destCity: '福岡県北九州市' }, s))
      .toEqual({ badge: 'none', originMatch: 'exact', destMatch: 'none' })
  })
})

describe('slipSideNote — 畳んで隠したことを言う一言 (Refs #858)', () => {
  /**
   * `combinedMatchLevel` は「片方でも none なら none」なので、**積地だけ当たっている明細と
   * 何ひとつ当たっていない明細が同じ「根拠なし」**になる。本番 2026-07 の候補一覧では
   * 1,668 件中 455 件 (27.3%) がこれに当たり、候補が 2 件以上ある便 380 本のうち
   * **41 本**がバッジ一色なのに両側を見れば見分けが付く状態だった。**その 1 行は残す。**
   *
   * **★ この数字は「選択区間をその便だけにしたとき」のもの。**`location` は選択区間の
   * 積地・卸地なので、**選択の取り方で分布がまるごと変わる** (運行まるごとを選ぶと
   * 車庫→車庫になりほぼ全件 `none`)。**測り直すときは選択の条件を必ず書く。**
   */
  const note = (o: string, d: string) => slipSideNote({ badge: 'none', originMatch: o as never, destMatch: d as never })

  it('積地だけ当たっている明細は「積地のみ一致」と言う', () => {
    expect(note('partial', 'none')).toBe('積地のみ一致')
    expect(note('exact', 'none')).toBe('積地のみ一致')
  })

  it('卸地だけ当たっている明細は「卸地のみ一致」と言う', () => {
    expect(note('none', 'partial')).toBe('卸地のみ一致')
  })

  it('何も当たっていない明細には何も足さない (バッジが隠したものが無い)', () => {
    expect(note('none', 'none')).toBeNull()
  })

  it('★ バッジが none でなければ何も足さない — 両側とも当たっており、畳んで隠したものが無い', () => {
    expect(slipSideNote({ badge: 'partial', originMatch: 'partial', destMatch: 'partial' })).toBeNull()
    expect(slipSideNote({ badge: 'exact', originMatch: 'exact', destMatch: 'exact' })).toBeNull()
  })

  it('★ 実物の突合結果とつないでも同じことを言う (本番 2026-07 の実データ形)', () => {
    const onlyOrigin = slip({ originAreaName: '北海道釧路市', origin: '北海道釧路市', destAreaName: '東京都', dest: '東京都' })
    // **自由記述 (`origin` / `dest`) も潰しておく** — 素の `slip()` は `origin: '釧路'` なので、
    // 地域ﾏｽﾀが外れると `bestMatch` がそちらで partial を拾い「何も当たらない」にならない。
    const neither = slip({ originAreaName: '東京都', origin: '東京都', destAreaName: '大阪府', dest: '大阪府' })
    const loc = { originCity: '北海道釧路市西港２-101-1', destCity: '北海道川上郡標茶町多和' }
    expect(slipSideNote(slipMatch(loc, onlyOrigin))).toBe('積地のみ一致')
    expect(slipSideNote(slipMatch(loc, neither))).toBeNull()
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

/**
 * ## ★ 根拠バッジの相手は「その便」 (Refs #860)
 *
 * 候補は `forceMatchCandidates` が**便ごと** (`leg.originCity` / `leg.date`) に出しているのに、
 * そこへ貼る根拠だけが**選択区間 1 つぶんの積地・卸地**を相手にしていた。
 * **同じ表の中で、並びは便基準・ラベルは区間基準**という食い違いだった。
 */
describe('legMatchTarget / legDestKnown / legRouteLabel — 根拠の相手 (Refs #860)', () => {
  const panelLeg = { seq: 1, key: 'k', date: '2026-07-16', originCity: '釧路市', destCity: '上士幌町' }

  it('★ 相手はその便の積地・卸地 (`SelectedRowsLocationRange` と同じ形で返す)', () => {
    expect(legMatchTarget(panelLeg)).toEqual({ originCity: '釧路市', destCity: '上士幌町' })
  })

  it('★ 便を相手にすると、選択区間がどうであれ同じ結果になる', () => {
    const s = slip({ originAreaName: '釧路市', destAreaName: '上士幌町' })
    expect(slipMatch(legMatchTarget(panelLeg), s).badge).toBe('exact')
    // 選択区間 (車庫→車庫) を相手にすると根拠なしに落ちていた = #860 で直したところ
    expect(slipMatch({ originCity: '音更町駒場北町', destCity: '音更町駒場北町' }, s).badge).toBe('none')
  })

  it('★ 卸地が取れているかを言う (空 / 空白だけ は「取れていない」)', () => {
    expect(legDestKnown({ destCity: '上士幌町' })).toBe(true)
    expect(legDestKnown({ destCity: '' })).toBe(false)
    expect(legDestKnown({ destCity: '  ' })).toBe(false)
  })

  /**
   * `matchLocationLevel` は片方が空なら無条件 `none`、`combinedMatchLevel` は片方でも
   * `none` なら `none`。⇒ **卸地が取れていない便は、積地が完全一致でも `none`。**
   * **消えるのはバッジ色の区別だけで、側注は残る**ことを両方固定する。
   */
  it('★★ 卸地が取れていない便は積地が完全一致でも `none`。ただし側注は残る', () => {
    const s = slip({ originAreaName: '釧路市', destAreaName: '上士幌町' })
    const match = slipMatch(legMatchTarget({ ...panelLeg, destCity: '' }), s)
    expect(match.badge).toBe('none')
    expect(match.originMatch).toBe('exact')
    expect(slipSideNote(match)).toBe('積地のみ一致')
  })

  it('区間の書き方は 1 か所 — 取れていない側は伏せず言葉にする', () => {
    expect(legRouteLabel('釧路市', '上士幌町')).toBe('釧路市 → 上士幌町')
    expect(legRouteLabel('', '上士幌町')).toBe('(積地なし) → 上士幌町')
    expect(legRouteLabel('釧路市', '')).toBe('釧路市 → (卸地なし)')
    expect(legRouteLabel('', '')).toBe('(積地なし) → (卸地なし)')
  })
})

/**
 * ## ★ 何を相手に突合したのかを画面に出す (Refs #860)
 *
 * #860 の本題は「相手が違う」ことより**画面に相手が出ていない**こと。相手だけ黙って
 * 変えると、昨日「根拠なし」だった行が今日「部分一致」になる理由がどこにも出ない。
 */
describe('badgeTargetNote / LEG_DEST_MISSING_NOTE — 相手を画面に出す (Refs #860)', () => {
  const panelLeg = { seq: 1, key: 'k', date: '2026-07-16', originCity: '釧路市', destCity: '上士幌町' }

  it('★ 便と選択区間の両方を出す (どちらも「いま何と比べているか」なので腐らない)', () => {
    const note = badgeTargetNote({ originCity: '音更町駒場北町', destCity: '音更町駒場北町' }, panelLeg)
    expect(note).toContain('根拠はこの便の積地・卸地 (釧路市 → 上士幌町) と比べた結果です')
    expect(note).toContain('選択した区間は 音更町駒場北町 → 音更町駒場北町')
  })

  it('★ 選択区間が取れていなければ、そう言う (空欄にして黙らない)', () => {
    const note = badgeTargetNote(null, panelLeg)
    expect(note).toContain('選択した区間の積地・卸地は取れていません')
    expect(note).toContain('根拠はこの便の積地・卸地 (釧路市 → 上士幌町) と比べた結果です')
  })

  /**
   * **逆方向の誤読を同時に潰す** — 複数便を選んでいると「部分一致」が一気に増えるので、
   * 「確認済み」と読まれないよう地名だけの目安であることを同じ 1 行で言う。
   * (`exact` は #858 の実測で候補 1,668 件中 0 件。増えるのは「部分一致」の方。)
   */
  it('★ 地名だけの目安であることを同じ 1 行で言う', () => {
    expect(badgeTargetNote(null, panelLeg)).toContain('金額・品名・日付は必ず自分で確かめてください')
  })

  it('★ 便の卸地が取れていない便では、バッジが一色になる理由を言う', () => {
    expect(LEG_DEST_MISSING_NOTE).toContain('降しイベントが無く卸地が取れていない')
    expect(LEG_DEST_MISSING_NOTE).toContain('積地だけで見ています')
    // **側注が残ることまで書く** — 「情報が消えた」と読ませない
    expect(LEG_DEST_MISSING_NOTE).toContain('積地のみ一致')
  })
})
