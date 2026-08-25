import { describe, expect, it } from 'vitest'
import {
  LEG_SALES_R2_NOTE,
  LEG_SALES_SOURCE_NAMES,
  legSalesLocalOtherYmNote,
  legSalesSourceLabel,
  legSalesYmCandidates,
  pickBestR2LegSales,
  pickOperationLegSalesFromSnapshot,
  resolveLegSalesPanel,
  type LegSalesR2Fetch,
  type OperationLegSalesR2,
} from '~/utils/operation-leg-sales-r2'
import type { OperationLegSalesLookup } from '~/utils/operation-leg-sales'

/**
 * 運行詳細の計上額を **R2 の版からも読む** (Refs #865)。
 *
 * **突合は 1 行も無い** — #826 で既に R2 に入っている `MarginCache.operations[].legs` を
 * 読むだけ。だからここのテストも「版が出した額をそのまま持ち回れているか」と
 * **「出せないときに理由を言い分けられるか」**の 2 点に絞ってある。
 */

/** 本番と同じ形の運行NO (22 桁)。 */
const OP_A = '2607031000000000001109'
const OP_B = '2607111000000000001109'
const SAVED_AT = '2026-08-24T10:01:53.000Z'

function snapshot(operations: unknown[], savedAt: string | unknown = SAVED_AT) {
  return { schemaVersion: 1, ym: '2026-07', codeVersion: 'v0.0.524', savedAt, totals: {}, cache: { ym: '2026-07', savedAt, operations, costs: [] } }
}

function op(unkoNo: string, legs: unknown[]) {
  return { unkoNo, date: '2026-07-03', driverName: '大石', vehicleCode: '1109', legs }
}

function leg(seq: number, customers: { code?: string, name: string, yen: number }[]) {
  return { seq, date: '2026-07-03', originCity: '帯広', destCity: '釧路', salesYen: 0, allowanceYen: 0, haulKm: 0, deadheadKm: 0, haulSec: null, deadheadSec: null, customers }
}

describe('pickOperationLegSalesFromSnapshot — 版 1 本からその運行の便を抜く', () => {
  it('版の customers をそのまま持ち回る (code は落とし、名前と金額は 1 円も作り直さない)', () => {
    const r = pickOperationLegSalesFromSnapshot(
      snapshot([op(OP_B, []), op(OP_A, [leg(1, [{ code: '0012', name: '○○牧場', yen: 41250 }])])]),
      '2026-07',
      OP_A,
    )
    expect(r).toEqual({
      status: 'ready',
      ym: '2026-07',
      savedAt: SAVED_AT,
      legs: [{ seq: 1, customers: [{ name: '○○牧場', yen: 41250 }], slipIds: [] }],
    })
  })

  it('★ 伝票番号 (slipIds) は版に無いので必ず空 — 作らない', () => {
    const r = pickOperationLegSalesFromSnapshot(
      snapshot([op(OP_A, [leg(1, [{ code: 'a', name: 'A社', yen: 1 }]), leg(2, [])])]),
      '2026-07',
      OP_A,
    )
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.legs.every(l => l.slipIds.length === 0)).toBe(true)
    // 当たっていない便も落とさない (画面が「当たっていません」と言えるように)。
    expect(r.legs[1]).toEqual({ seq: 2, customers: [], slipIds: [] })
  })

  it('★ ym は R2 のキーを組んだ月を返す (本文の ym は見ない — 書き側が一致を強制している)', () => {
    const r = pickOperationLegSalesFromSnapshot(snapshot([op(OP_A, [leg(1, [])])]), '2026-06', OP_A)
    expect(r.ym).toBe('2026-06')
  })

  it('版にこの運行が居なければ not-aggregated (savedAt 付き)', () => {
    expect(pickOperationLegSalesFromSnapshot(snapshot([op(OP_B, [leg(1, [])])]), '2026-07', OP_A))
      .toEqual({ status: 'not-aggregated', ym: '2026-07', savedAt: SAVED_AT })
  })

  it('★★ 「居るが便が 0 本」を not-aggregated に混ぜない (noLegOperations の運行)', () => {
    expect(pickOperationLegSalesFromSnapshot(snapshot([op(OP_A, [])]), '2026-07', OP_A))
      .toEqual({ status: 'no-legs', ym: '2026-07', savedAt: SAVED_AT })
  })

  it.each([
    ['object でない', 'not json'],
    ['null', null],
    ['savedAt が無い', { cache: { operations: [op(OP_A, [leg(1, [])])] } }],
    ['savedAt が文字列でない', snapshot([op(OP_A, [leg(1, [])])], 1756000000)],
    ['cache が無い', { savedAt: SAVED_AT }],
    ['cache が null', { savedAt: SAVED_AT, cache: null }],
    ['operations が配列でない', { savedAt: SAVED_AT, cache: { operations: {} } }],
    ['operations の要素が object でない', { savedAt: SAVED_AT, cache: { operations: ['x'] } }],
    ['operations の要素が null', { savedAt: SAVED_AT, cache: { operations: [null] } }],
    ['legs が配列でない', snapshot([{ unkoNo: OP_A, legs: 'x' }])],
    ['leg が object でない', snapshot([{ unkoNo: OP_A, legs: [1] }])],
    ['leg が null', snapshot([{ unkoNo: OP_A, legs: [null] }])],
    ['seq が数でない', snapshot([op(OP_A, [{ seq: '1', customers: [] }])])],
    ['seq が整数でない', snapshot([op(OP_A, [{ seq: 1.5, customers: [] }])])],
    ['customers が配列でない', snapshot([op(OP_A, [{ seq: 1, customers: {} }])])],
    ['customer が object でない', snapshot([op(OP_A, [{ seq: 1, customers: ['A社'] }])])],
    ['customer が null', snapshot([op(OP_A, [{ seq: 1, customers: [null] }])])],
    ['name が文字列でない', snapshot([op(OP_A, [{ seq: 1, customers: [{ name: 1, yen: 1 }] }])])],
    ['yen が数でない', snapshot([op(OP_A, [{ seq: 1, customers: [{ name: 'A社', yen: '1' }] }])])],
    ['yen が有限でない', snapshot([op(OP_A, [{ seq: 1, customers: [{ name: 'A社', yen: Number.NaN }] }])])],
  ])('★ 読めない本文は unreadable — %s (0 円に倒さない)', (_label, body) => {
    expect(pickOperationLegSalesFromSnapshot(body, '2026-07', OP_A))
      .toEqual({ status: 'unreadable', ym: '2026-07' })
  })

  it('★ 1 便でも読めなければ版まるごと unreadable (読めたぶんだけ足すと額が黙って低く出る)', () => {
    const r = pickOperationLegSalesFromSnapshot(
      snapshot([op(OP_A, [leg(1, [{ name: 'A社', yen: 41250 }]), { seq: 2, customers: 'x' }])]),
      '2026-07',
      OP_A,
    )
    expect(r).toEqual({ status: 'unreadable', ym: '2026-07' })
  })
})

describe('legSalesYmCandidates — 探しに行く月 (粗利タブの月の切り方は運行の開始日)', () => {
  it('月の途中なら 1 つだけ (普段は 1 回の取得)', () => {
    expect(legSalesYmCandidates('2026-07-15')).toEqual(['2026-07'])
  })

  it('★ 月初は前月も見る (読取日と運行開始日が 1 日ずれると偽の欠測が出る)', () => {
    expect(legSalesYmCandidates('2026-07-01')).toEqual(['2026-07', '2026-06'])
  })

  it('★ 月末は翌月も見る', () => {
    expect(legSalesYmCandidates('2026-07-31')).toEqual(['2026-07', '2026-08'])
  })

  it('年をまたいでも正しい月になる', () => {
    expect(legSalesYmCandidates('2026-01-01')).toEqual(['2026-01', '2025-12'])
    expect(legSalesYmCandidates('2026-12-31')).toEqual(['2026-12', '2027-01'])
  })

  it.each([['null', null], ['undefined', undefined], ['空', ''], ['形が違う', '2026/07/15'], ['月まで', '2026-07']])(
    '★ 日付が読めなければ空 — %s (推測で今月を見に行かない)',
    (_label, date) => {
      expect(legSalesYmCandidates(date)).toEqual([])
    },
  )
})

describe('pickBestR2LegSales — 月の候補から 1 つ選ぶ', () => {
  const ready: OperationLegSalesR2 = { status: 'ready', ym: '2026-07', savedAt: SAVED_AT, legs: [] }
  const noLegs: OperationLegSalesR2 = { status: 'no-legs', ym: '2026-06', savedAt: SAVED_AT }
  const unreadable: OperationLegSalesR2 = { status: 'unreadable', ym: '2026-06' }
  const notAgg: OperationLegSalesR2 = { status: 'not-aggregated', ym: '2026-06', savedAt: SAVED_AT }
  const noVersion: OperationLegSalesR2 = { status: 'no-version', ym: '2026-06' }

  it('空なら null', () => {
    expect(pickBestR2LegSales([])).toBeNull()
  })

  it('数字が出る ready が最優先 (後ろに来ても勝つ)', () => {
    expect(pickBestR2LegSales([notAgg, ready])).toBe(ready)
    expect(pickBestR2LegSales([ready, notAgg])).toBe(ready)
  })

  it('no-legs は not-aggregated より優先 (版にこの運行が居ることの方が具体的)', () => {
    expect(pickBestR2LegSales([notAgg, noLegs])).toBe(noLegs)
  })

  it('★ unreadable を not-aggregated / no-version より優先 (異常を正常で隠さない)', () => {
    expect(pickBestR2LegSales([notAgg, unreadable])).toBe(unreadable)
    expect(pickBestR2LegSales([noVersion, unreadable])).toBe(unreadable)
  })

  it('not-aggregated は no-version より優先 (版はあるという事実の方が具体的)', () => {
    expect(pickBestR2LegSales([noVersion, notAgg])).toBe(notAgg)
  })

  it('1 つだけならそれ', () => {
    expect(pickBestR2LegSales([noVersion])).toBe(noVersion)
  })
})

describe('出どころのラベル — この端末で集計した結果 / R2 に保存された版', () => {
  it('★ 2 つの出どころを名前で言い分ける', () => {
    expect(LEG_SALES_SOURCE_NAMES.local).toBe('この端末で集計した結果')
    expect(LEG_SALES_SOURCE_NAMES.r2).toBe('R2 に保存された版')
  })

  it('local は突合した月だけ (保存時刻は無い)', () => {
    expect(legSalesSourceLabel('local', '2026-07', null)).toBe('この端末で集計した結果 (2026-07 の突合)')
  })

  it('★ r2 は「いつの版か」を必ず添える (版は古いことがある)', () => {
    expect(legSalesSourceLabel('r2', '2026-07', '2026-08-24T10:01:53.000Z'))
      .toMatch(/^R2 に保存された版 \(2026-07 の突合 \/ \d+\/\d+ \d{2}:\d{2} 保存\)$/)
  })

  it('★ 保存時刻が読めなくても空白にしない (穴はレンダリングの不具合にしか読めない)', () => {
    expect(legSalesSourceLabel('r2', '2026-07', 'こわれた'))
      .toBe('R2 に保存された版 (2026-07 の突合 / 保存時刻が読めません)')
  })

  it('★★ この端末が別の月を集計しているときは、両方の月を名乗る (Refs #867)', () => {
    // 版の月しか名乗らないと、**この端末のキャッシュが別の月だという事実が消える**。
    expect(legSalesSourceLabel('r2', '2026-07', 'こわれた', '2026-06'))
      .toBe('R2 に保存された版 (2026-07 の突合 / 保存時刻が読めません / この端末の集計は 2026-06)')
  })

  it('★ 見出しには否定語を入れない (金額が出ている行の横に「ありません」を置かない)', () => {
    const label = legSalesSourceLabel('r2', '2026-07', SAVED_AT, '2026-06')
    expect(label).not.toContain('ありません')
    expect(label).not.toContain('無し')
  })

  it('この端末に突合結果そのものが無いとき (missing) は名乗る月が無い', () => {
    expect(legSalesSourceLabel('r2', '2026-07', 'こわれた', null))
      .toBe('R2 に保存された版 (2026-07 の突合 / 保存時刻が読めません)')
  })
})

describe('legSalesLocalOtherYmNote — 別の月を集計してある端末で R2 から出した回 (Refs #867)', () => {
  const note = legSalesLocalOtherYmNote('2026-06', '2026-07')

  it('★ この端末のキャッシュの月と、出した版の月の両方を名乗る', () => {
    expect(note).toContain('2026-06 の突合')
    expect(note).toContain('R2 の 2026-07 の版から出しています')
  })

  it('★★ 切り替わる月を名指しし直す (別の月を集計し直しても切り替わらない)', () => {
    // `LEG_SALES_R2_NOTE` の一般文は「この端末の粗利タブで集計すると切り替わります」。
    // この状態では **2026-06 を集計し直しても切り替わらない** ので、
    // **この運行の月**を名指しする (逆方向の誤読つぶし)。
    expect(note).toContain('この運行の月 (2026-07) をこの端末の粗利タブで集計したとき')
  })

  it('★ 否定は出どころを名指しした形だけ (裸の「ありません」を金額の横に置かない)', () => {
    expect(note).toContain('そちらにこの運行が入っていないため')
    expect(note).not.toContain('ありません')
  })
})

describe('LEG_SALES_R2_NOTE — R2 から読んだ回にしか無い事実を言う', () => {
  it('★ 版が古いことがある (最後に集計して保存した時点) と言う', () => {
    expect(LEG_SALES_R2_NOTE).toContain('R2 に保存された版から読んでいます')
    expect(LEG_SALES_R2_NOTE).toContain('それ以降に取り込んだデータは入っていません')
  })

  it('★ この端末で集計すると切り替わると言う (数字が変わる理由が後から読めるように)', () => {
    expect(LEG_SALES_R2_NOTE).toContain('この端末の粗利タブで集計すると')
  })

  it('★★ 「伝票 …」が出ない理由を言う (伝票が無いという意味ではない)', () => {
    expect(LEG_SALES_R2_NOTE).toContain('伝票番号を持っていない')
    expect(LEG_SALES_R2_NOTE).toContain('伝票が無いという意味ではありません')
  })
})

// --- 画面が出すもの ---------------------------------------------------------

const LOCAL_READY: OperationLegSalesLookup = {
  status: 'ready',
  ym: '2026-07',
  legs: [{ seq: 1, customers: [{ name: '○○牧場', yen: 41250 }], slipIds: ['20260703-12'] }],
  salesYen: 41250,
  matchedLegs: 1,
  unmatchedLegs: 0,
}
const LOADING: LegSalesR2Fetch = { state: 'loading' }

describe('resolveLegSalesPanel — localStorage を先に見る順序は変えない', () => {
  it('★ この端末に結果があれば local を出す (R2 は見ない — 古い版で上書きしない)', () => {
    const done: LegSalesR2Fetch = {
      state: 'done',
      result: { status: 'ready', ym: '2026-07', savedAt: SAVED_AT, legs: [{ seq: 1, customers: [{ name: '別', yen: 1 }], slipIds: [] }] },
      checkedYms: ['2026-07'],
    }
    const panel = resolveLegSalesPanel(LOCAL_READY, done)
    expect(panel.source).toBe('local')
    expect(panel.ready).toBe(LOCAL_READY)
    expect(panel.sourceLabel).toBe('この端末で集計した結果 (2026-07 の突合)')
    // **local には注記を足さない** — 見出しで足りる (この区画には既に別の注記がある)。
    expect(panel.sourceNote).toBe('')
    expect(panel.note).toBeNull()
  })

  it('★ R2 を見ないのは ready のときだけ (not-aggregated は落ちる、Refs #867)', () => {
    // `missing` と `not-aggregated` は**どちらも「この端末に答えが無い」**。
    // ここを `missing` だけにしていたのが #867 の正体。
    const panel = resolveLegSalesPanel({ status: 'not-aggregated', ym: '2026-06' }, LOADING)
    expect(panel.ready).toBeNull()
    expect(panel.note).toContain('R2 に保存された版を確認しています')
  })
})

/**
 * ★ #867 の本体。**この端末には 2026-06 の結果があり、R2 の 2026-07 の版から出した**
 * という状態が新しく生まれる。**黙って混ぜない。**
 */
describe('resolveLegSalesPanel — 別の月を集計してある端末 (not-aggregated) でも R2 から出す', () => {
  const LOCAL_OTHER: OperationLegSalesLookup = { status: 'not-aggregated', ym: '2026-06' }
  const R2_READY: LegSalesR2Fetch = {
    state: 'done',
    checkedYms: ['2026-07'],
    result: {
      status: 'ready',
      ym: '2026-07',
      savedAt: SAVED_AT,
      legs: [
        { seq: 1, customers: [{ name: '○○牧場', yen: 41250 }], slipIds: [] },
        { seq: 2, customers: [], slipIds: [] },
      ],
    },
  }

  it('★★ R2 に版があれば出す (これが直したこと)', () => {
    const panel = resolveLegSalesPanel(LOCAL_OTHER, R2_READY)
    expect(panel.source).toBe('r2')
    expect(panel.ready).toMatchObject({ ym: '2026-07', salesYen: 41250, matchedLegs: 1, unmatchedLegs: 1 })
  })

  it('★★ 数字が出ているときに「ありません」を同じ画面に残さない', () => {
    // 出ているものが別の意味に読める — この repo で最も多い欠陥の型 (#851 / #854 / #861)。
    const panel = resolveLegSalesPanel(LOCAL_OTHER, R2_READY)
    expect(panel.note).toBeNull()
    expect(panel.sourceLabel).not.toContain('ありません')
    // **裸の「この運行はありません」を出さない** — 出ている金額に掛かって読める。
    // (`LEG_SALES_R2_NOTE` の「伝票が無いという意味ではありません」等は**否定する対象を
    // 名指ししている**ので別物。ここで見ているのは「この運行が無い」の方。)
    expect(panel.sourceNote).not.toContain('この運行はありません')
  })

  it('★★ この端末のキャッシュの月と、出した版の月の両方が画面から読める', () => {
    const panel = resolveLegSalesPanel(LOCAL_OTHER, R2_READY)
    expect(panel.sourceLabel).toContain('2026-07 の突合')
    expect(panel.sourceLabel).toContain('この端末の集計は 2026-06')
    expect(panel.sourceNote).toContain('2026-06 の突合')
  })

  it('★★ 逆方向の誤読も潰す — R2 の注記に端末側の事情を足す (順序も固定)', () => {
    const panel = resolveLegSalesPanel(LOCAL_OTHER, R2_READY)
    // 版が古いこと・伝票が出ない理由 (R2 の回にしか無い事実) は今までどおり出す。
    expect(panel.sourceNote.startsWith(LEG_SALES_R2_NOTE)).toBe(true)
    // **後ろに**足す — 前に置くと一般文「この端末の粗利タブで集計すると切り替わります」が
    // 後から読め、**2026-06 を集計し直しても切り替わらない**ことが伝わらない。
    expect(panel.sourceNote).toBe(LEG_SALES_R2_NOTE + legSalesLocalOtherYmNote('2026-06', '2026-07'))
  })

  it('★ この端末に何も無いとき (missing) は端末側の事情を足さない (名乗る月が無い)', () => {
    const panel = resolveLegSalesPanel({ status: 'missing' }, R2_READY)
    expect(panel.sourceNote).toBe(LEG_SALES_R2_NOTE)
    expect(panel.sourceLabel).not.toContain('この端末の集計は')
  })

  it('★★ R2 も出せなかったら、この端末の事情と R2 の事情を両方言う (合成後の 1 文で判断)', () => {
    const note = resolveLegSalesPanel(LOCAL_OTHER, {
      state: 'done',
      checkedYms: ['2026-07', '2026-06'],
      result: { status: 'not-aggregated', ym: '2026-07', savedAt: SAVED_AT },
    }).note
    // 「この運行の月を粗利タブで集計すると出ます。」だけで終わると、**R2 を見たことが
    // 伝わらない**。文末の `。` はこの連結のためにある (繋がって読めなくならないように)。
    expect(note).toContain('粗利タブの突合結果 (2026-06) にこの運行はありません。')
    expect(note).toContain('この運行の月を粗利タブで集計すると出ます。')
    expect(note).toContain('R2 の版 (2026-07')
    expect(note).toContain('にもこの運行はありません (確認した月: 2026-07 / 2026-06)。')
    expect(note).not.toContain('出ますR2')
  })

  it('★ R2 の取得が失敗した回も両方言う', () => {
    const note = resolveLegSalesPanel(LOCAL_OTHER, {
      state: 'failed', message: '503', checkedYms: ['2026-07'],
    }).note
    expect(note).toContain('粗利タブの突合結果 (2026-06) にこの運行はありません。')
    expect(note).toContain('R2 に保存された版 (確認した月: 2026-07) も読めませんでした (503)')
  })
})

describe('resolveLegSalesPanel — この端末に無いとき (missing) だけ R2 へ落ちる', () => {
  const MISSING: OperationLegSalesLookup = { status: 'missing' }
  /** `legSalesNote(missing)` の一言。**先頭に必ず付く** (どちらの事情も言う)。 */
  const LOCAL_HEAD = 'このブラウザの粗利タブで集計すると出ます (便ごとの突合結果がまだありません)。'

  it('★★ R2 に版があればそこから出す — 合計は local と同じ式で畳む', () => {
    const panel = resolveLegSalesPanel(MISSING, {
      state: 'done',
      checkedYms: ['2026-07'],
      result: {
        status: 'ready',
        ym: '2026-07',
        savedAt: SAVED_AT,
        legs: [
          { seq: 1, customers: [{ name: '○○牧場', yen: 41250 }], slipIds: [] },
          { seq: 2, customers: [], slipIds: [] },
        ],
      },
    })
    expect(panel.source).toBe('r2')
    expect(panel.note).toBeNull()
    expect(panel.ready).toMatchObject({ ym: '2026-07', salesYen: 41250, matchedLegs: 1, unmatchedLegs: 1 })
    expect(panel.sourceLabel).toContain('R2 に保存された版 (2026-07 の突合 /')
    expect(panel.sourceNote).toBe(LEG_SALES_R2_NOTE)
  })

  it('★ 1 便も当たっていない版の合計は null (0 円と読ませない)', () => {
    const panel = resolveLegSalesPanel(MISSING, {
      state: 'done',
      checkedYms: ['2026-07'],
      result: { status: 'ready', ym: '2026-07', savedAt: SAVED_AT, legs: [{ seq: 1, customers: [], slipIds: [] }] },
    })
    expect(panel.ready?.salesYen).toBeNull()
  })

  it('確認中は確認中と言う (黙ると「無い」と読まれる)', () => {
    const panel = resolveLegSalesPanel(MISSING, LOADING)
    expect(panel.ready).toBeNull()
    expect(panel.note).toBe(`${LOCAL_HEAD} R2 に保存された版を確認しています…`)
  })

  it('★ 運行の日付が読めないときは「月を決められない」と言う (推測で別の月を見に行かない)', () => {
    expect(resolveLegSalesPanel(MISSING, { state: 'no-date' }).note)
      .toBe(`${LOCAL_HEAD} この運行の日付が読めないため、R2 のどの月の版を見ればよいか決められませんでした。`)
  })

  it('★ 取得が失敗したら黙らない (0 円ではない)', () => {
    const note = resolveLegSalesPanel(MISSING, { state: 'failed', message: '503', checkedYms: ['2026-07'] }).note
    expect(note).toBe(`${LOCAL_HEAD} R2 に保存された版 (確認した月: 2026-07) も読めませんでした (503) — 計上額が 0 円なのではありません。`)
  })

  it('★★ 失敗した回も「どの月を見に行ったか」を言う (見に行かなかったのと区別が付かない、Refs #867)', () => {
    // 失敗の文言は本文のどこにも月を書かないので、**1 つでも必ず名乗る**
    // (`checkedYmsSuffix` を省けるのは、本文がその月を書いている回だけ)。
    const note = resolveLegSalesPanel(MISSING, {
      state: 'failed', message: 'Failed to fetch', checkedYms: ['2026-07', '2026-06'],
    }).note
    expect(note).toContain('(確認した月: 2026-07 / 2026-06)')
  })

  it('版が無い月は「集計すれば残る」まで言う', () => {
    const note = resolveLegSalesPanel(MISSING, {
      state: 'done', checkedYms: ['2026-07'], result: { status: 'no-version', ym: '2026-07' },
    }).note
    expect(note).toBe(`${LOCAL_HEAD} R2 にも 2026-07 の保存された版がありません — 粗利タブでこの月を集計すると、この端末にも R2 にも残ります。`)
  })

  it('★ 本文が読めなかった版は「0 円ではなく読めていない」と言う', () => {
    const note = resolveLegSalesPanel(MISSING, {
      state: 'done', checkedYms: ['2026-07'], result: { status: 'unreadable', ym: '2026-07' },
    }).note
    expect(note).toContain('本文を読めませんでした')
    expect(note).toContain('計上額が 0 円なのではなく、読めていません')
  })

  it('版にこの運行が居なければ、いつの版を見たかを添えて言う', () => {
    const note = resolveLegSalesPanel(MISSING, {
      state: 'done', checkedYms: ['2026-07'], result: { status: 'not-aggregated', ym: '2026-07', savedAt: SAVED_AT },
    }).note
    expect(note).toMatch(/R2 の版 \(2026-07、\d+\/\d+ \d{2}:\d{2} 保存\) にもこの運行はありません。$/)
  })

  it('★★ 「居るが便が 0 本」を「この運行はありません」と同じ文言にしない', () => {
    const note = resolveLegSalesPanel(MISSING, {
      state: 'done', checkedYms: ['2026-07'], result: { status: 'no-legs', ym: '2026-07', savedAt: SAVED_AT },
    }).note
    expect(note).toContain('この運行はありますが、便が 1 本もありません')
    expect(note).toContain('売上 0 円ではありません')
  })

  it('★ 2 つの月を見たときは、見た月を全部書く (1 つだけ書くと「もう片方は見ていない」と読まれる)', () => {
    const note = resolveLegSalesPanel(MISSING, {
      state: 'done', checkedYms: ['2026-07', '2026-06'], result: { status: 'no-version', ym: '2026-07' },
    }).note
    expect(note).toContain('(確認した月: 2026-07 / 2026-06)')
  })

  it('1 つしか見ていないときは「確認した月」を書かない (本文が既にその月を書いている)', () => {
    const note = resolveLegSalesPanel(MISSING, {
      state: 'done', checkedYms: ['2026-07'], result: { status: 'no-version', ym: '2026-07' },
    }).note
    expect(note).not.toContain('確認した月')
  })

  it('★ どの理由でも「この端末の事情」と「R2 の事情」の両方を言う', () => {
    const fetches: LegSalesR2Fetch[] = [
      LOADING,
      { state: 'no-date' },
      { state: 'failed', message: 'x', checkedYms: ['2026-07'] },
      { state: 'done', checkedYms: ['2026-07'], result: { status: 'no-version', ym: '2026-07' } },
      { state: 'done', checkedYms: ['2026-07'], result: { status: 'unreadable', ym: '2026-07' } },
      { state: 'done', checkedYms: ['2026-07'], result: { status: 'not-aggregated', ym: '2026-07', savedAt: SAVED_AT } },
      { state: 'done', checkedYms: ['2026-07'], result: { status: 'no-legs', ym: '2026-07', savedAt: SAVED_AT } },
    ]
    for (const f of fetches) {
      const note = resolveLegSalesPanel(MISSING, f).note
      expect(note).toContain(LOCAL_HEAD)
      expect(note?.length).toBeGreaterThan(LOCAL_HEAD.length + 1)
    }
  })

  it('★ 保存時刻が読めない版でも空白にしない', () => {
    const note = resolveLegSalesPanel(MISSING, {
      state: 'done', checkedYms: ['2026-07'], result: { status: 'no-legs', ym: '2026-07', savedAt: '' },
    }).note
    expect(note).toContain('2026-07、保存時刻が読めません')
  })
})
