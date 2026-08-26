import { describe, it, expect } from 'vitest'

import {
  MARGIN_DIFF_LEG_FIELDS,
  MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE,
  MARGIN_DIFF_OPERATION_FIELDS,
  MARGIN_DIFF_OVERRIDE_CAVEAT,
  MARGIN_DIFF_TOTALS_FIELDS,
  buildMarginDiff,
  marginDiffCodeVersionNote,
  marginDiffCrossMonthNote,
  marginDiffDisplayDelta,
  marginDiffLegCountNote,
  marginDiffLegLabel,
  marginDiffNeedsMoreVersionsNote,
  marginDiffOverrideCaveat,
  marginDiffSchemaMismatchNote,
  marginDiffUncoveredNote,
  type MarginDiffSide,
  type MarginDiffSnapshot,
} from '../../app/utils/margin-diff'
import { emptyMarginTotals, type MarginLegInput, type MarginOperationInput } from '../../app/utils/margin'
import { MARGIN_SUMMARY_SCHEMA_VERSION, buildMarginSummaryInput, type MarginSummarySnapshot } from '../../app/utils/margin-r2'

// --- 版の材料 ---

function leg(over: Partial<MarginLegInput> = {}): MarginLegInput {
  return {
    seq: 1,
    date: '2026-07-03',
    originCity: '帯広',
    destCity: '札幌',
    salesYen: 100000,
    allowanceYen: 12000,
    haulKm: 200,
    deadheadKm: 30,
    haulSec: 7200,
    deadheadSec: 1800,
    customers: [],
    ...over,
  }
}

function op(over: Partial<MarginOperationInput> = {}): MarginOperationInput {
  return {
    unkoNo: '20260703-0040-1',
    date: '2026-07-03',
    driverName: '山田',
    vehicleCode: '0040',
    totalKm: 300,
    listedTotalKm: null,
    kmBreakdown: { preLoadKm: 10, haulKm: 200, betweenKm: 50, postUnloadKm: 30, otherKm: 10 },
    salesYen: 100000,
    allowanceYen: 12000,
    legs: [leg()],
    ...over,
  }
}

function snapshot(over: {
  schemaVersion?: number
  codeVersion?: string
  savedAt?: string
  totals?: Partial<ReturnType<typeof emptyMarginTotals>>
  operations?: MarginOperationInput[]
  uncovered?: MarginDiffSnapshot['cache']['uncovered']
  crossMonth?: MarginDiffSnapshot['cache']['crossMonth']
} = {}): MarginDiffSnapshot {
  return {
    schemaVersion: over.schemaVersion ?? MARGIN_SUMMARY_SCHEMA_VERSION,
    ym: '2026-07',
    codeVersion: over.codeVersion ?? 'v0.0.524',
    savedAt: over.savedAt ?? '2026-08-24T10:01:53.000Z',
    totals: { ...emptyMarginTotals(), ...over.totals },
    cache: {
      ym: '2026-07',
      savedAt: '2026-08-24T10:01:53.000Z',
      operations: over.operations ?? [op()],
      costs: [],
      uncovered: over.uncovered ?? null,
      crossMonth: over.crossMonth ?? null,
    },
  }
}

function side(label: string, snap: MarginDiffSnapshot): MarginDiffSide {
  return { label, snapshot: snap }
}

const OLD = 'v-20260824T100000'
const NEW = 'v-20260824T190153'

// --- 項目の定義 ---

describe('比べる項目の定義', () => {
  it('月全体は 一覧と同じ 4 項目 (運行・売上・手当・粗利)', () => {
    // 一覧 (`pickMarginVersionTotals`) と同じ 4 つに揃える — 同じ画面の中で対応が取れなくなる。
    expect(MARGIN_DIFF_TOTALS_FIELDS.map(f => f.key)).toEqual(['operations', 'salesYen', 'allowanceYen', 'marginYen'])
  })

  it('★ 運行 1 本には marginYen が無い (この画面は粗利を計算し直さないので出さない)', () => {
    // この画面は保存された値を引き算するだけ。再計算すると画面が実際に見た
    // `totals.marginYen` とズレる数字を作りかねないので、運行単位は生の入力値まで。
    // **形式 2 の版は `buildOperationMargins` の `overrides` (燃費の上書き) と
    // `runCostShareMode` を指紋として持つ** (Refs #886) が、**形式 1 の版には無く、
    // そちらは版から運行 1 本の粗利を永久に厳密に再現できない。**
    expect(MARGIN_DIFF_OPERATION_FIELDS.map(f => f.key)).toEqual(['salesYen', 'allowanceYen', 'totalKm', 'legCount'])
    expect(MARGIN_DIFF_OPERATION_FIELDS.some(f => f.key === 'marginYen' as string)).toBe(false)
  })

  it('★ 便にも marginYen は無い', () => {
    expect(MARGIN_DIFF_LEG_FIELDS.map(f => f.key)).toEqual(['salesYen', 'allowanceYen', 'haulKm', 'deadheadKm'])
    expect(MARGIN_DIFF_LEG_FIELDS.some(f => f.key === 'marginYen' as string)).toBe(false)
  })

  it('金額は yen・距離は km・本数は count で出す (書式は画面が持つ)', () => {
    expect(MARGIN_DIFF_TOTALS_FIELDS.map(f => f.unit)).toEqual(['count', 'yen', 'yen', 'yen'])
    expect(MARGIN_DIFF_OPERATION_FIELDS.map(f => f.unit)).toEqual(['yen', 'yen', 'km', 'count'])
    expect(MARGIN_DIFF_LEG_FIELDS.map(f => f.unit)).toEqual(['yen', 'yen', 'km', 'km'])
  })
})

// --- schemaVersion ---

describe('schemaVersion が違う版どうし', () => {
  it('★ 差分を計算せず「比較できません」を返す', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ schemaVersion: 1, totals: { salesYen: 100 } })),
      side(NEW, snapshot({ schemaVersion: 2, totals: { salesYen: 999 } })),
    )
    expect(diff.state).toBe('schema-mismatch')
    // **黙って旧形式を無視した差分を出さない。** 数字の行を 1 つも作らない。
    expect(diff.totals).toEqual([])
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
    expect(diff.unchangedOperations).toBe(0)
    expect(diff.blockedNote).toContain('比較できません (版の形式が違います)')
    expect(diff.blockedNote).toContain(`${OLD} は形式 1`)
    expect(diff.blockedNote).toContain(`${NEW} は形式 2`)
  })

  it('形式が違っても版そのものの識別は返す (どの 2 版を選んだかは画面に出る)', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ schemaVersion: 1, codeVersion: 'v0.0.520' })),
      side(NEW, snapshot({ schemaVersion: 2, codeVersion: 'v0.0.524' })),
    )
    expect(diff.before).toEqual({ label: OLD, savedAt: '2026-08-24T10:01:53.000Z', codeVersion: 'v0.0.520', schemaVersion: 1 })
    expect(diff.after.schemaVersion).toBe(2)
    // 形式が違う回に**他の注記を混ぜない** (「コード版が違います」だけ出ても読めない)。
    expect(diff.codeVersionNote).toBe('')
    expect(diff.overrideCaveat).toBe('')
    expect(diff.uncoveredNote).toBe('')
    expect(diff.crossMonthNote).toBe('')
  })

  it('形式が同じなら比べる', () => {
    const diff = buildMarginDiff(side(OLD, snapshot()), side(NEW, snapshot()))
    expect(diff.state).toBe('ready')
    expect(diff.blockedNote).toBe('')
    expect(diff.totals).toHaveLength(4)
  })

  it('MarginSummarySnapshot をそのまま渡せる (保存の型と差分の型が食い違わない)', () => {
    // R2 が返すのは `MarginSummarySnapshot`。**代入できることを型でも固定する** —
    // `schemaVersion` をリテラル (いまは `2`) のまま受けると「形式が違う 2 版」が型の上で
    // 存在しなくなり、上の判定が死ぬので、差分側は `number` で受けている。
    const saved: MarginSummarySnapshot = {
      schemaVersion: MARGIN_SUMMARY_SCHEMA_VERSION,
      ym: '2026-07',
      codeVersion: 'v0.0.524',
      savedAt: '2026-08-24T10:01:53.000Z',
      totals: emptyMarginTotals(),
      cache: { ym: '2026-07', savedAt: '', operations: [], costs: [], uncovered: null, crossMonth: null },
      fuelRateOverrides: {},
      runCostShareMode: 'km',
    }
    const asDiffInput: MarginDiffSnapshot = saved
    expect(buildMarginDiff(side(OLD, asDiffInput), side(NEW, asDiffInput)).state).toBe('ready')
  })

  it('★★ 形式 1 の既存版 × 形式 2 の新版 — クラッシュせず理由を出す (Refs #886)', () => {
    // #886 で `MARGIN_SUMMARY_SCHEMA_VERSION` が 2 になり、指紋 2 欄が版に入った。
    // **R2 には形式 1 の版が既に残っている**ので、この 2 つを並べる操作は実際に起きる。
    // `margin-diff.ts` は無改修のまま、既存の不一致メッセージ経路で扱えること
    // (= 落ちない・黙らない・理由を出す) を固定する。

    // 形式 1 の版: **指紋の欄そのものが無い。** R2 から読んだ過去の JSON を模す
    // (いまのコードでは組めない形なので、型を通さず手で作る)。
    const legacy = {
      schemaVersion: 1,
      ym: '2026-07',
      codeVersion: 'v0.0.524',
      savedAt: '2026-08-24T10:01:53.000Z',
      totals: { ...emptyMarginTotals(), operations: 91, salesYen: 10260265, allowanceYen: 2499500, marginYen: 4467597 },
      cache: { ym: '2026-07', savedAt: '', operations: [op()], costs: [], uncovered: null, crossMonth: null },
    } as unknown as MarginDiffSnapshot
    expect('fuelRateOverrides' in (legacy as object)).toBe(false)

    // 形式 2 の版: **いまのコードが実際に組む形**を通す (指紋つき)。
    const current: MarginDiffSnapshot = {
      ...buildMarginSummaryInput({
        cache: { ym: '2026-07', savedAt: '', operations: [op()], costs: [], uncovered: null, crossMonth: null },
        totals: { ...emptyMarginTotals(), operations: 91, salesYen: 10260265, allowanceYen: 2499500, marginYen: 4467597 },
        codeVersion: 'v0.0.542',
        fuelRateOverrides: { '1234': { yenPerLiter: 150, kmPerLiter: null } },
        runCostShareMode: 'time',
      }),
      savedAt: '2026-08-25T10:01:53.000Z',
    }
    expect(current.schemaVersion).toBe(2)

    const diff = buildMarginDiff(side(OLD, legacy), side(NEW, current))
    expect(diff.state).toBe('schema-mismatch')
    // **黙って旧形式を無視した差分を出さない。** 数字の行を 1 つも作らない。
    expect(diff.totals).toEqual([])
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
    expect(diff.unchangedOperations).toBe(0)
    // **理由を出す。** 空の差分を「変わっていない」と誤読させない。
    expect(diff.blockedNote).toContain('比較できません (版の形式が違います)')
    expect(diff.blockedNote).toContain(`${OLD} は形式 1`)
    expect(diff.blockedNote).toContain(`${NEW} は形式 2`)
    // どの 2 版を選んだかは返る (画面の見出しと符号が食い違わない)。
    expect(diff.before.schemaVersion).toBe(1)
    expect(diff.after.schemaVersion).toBe(2)
    // ★ **合計は 4 項目とも同じ値**なのに差分を出さない。「形が違えば比べない」は
    // 「壊れた」ではなく「そもそも指紋の文脈を持たない版を意味のある形で差分にできない」。
    expect(current.totals).toEqual(legacy.totals)
    // 形式が違う回に**他の注記を混ぜない**。
    expect(diff.codeVersionNote).toBe('')
    expect(diff.overrideCaveat).toBe('')
  })

  it('★ 逆向き (形式 2 が古い方) でも同じ経路で理由を出す', () => {
    const legacy = { ...snapshot(), schemaVersion: 1 }
    const current = snapshot({ schemaVersion: MARGIN_SUMMARY_SCHEMA_VERSION })
    const diff = buildMarginDiff(side(OLD, current), side(NEW, legacy))
    expect(diff.state).toBe('schema-mismatch')
    expect(diff.blockedNote).toContain(`${OLD} は形式 2`)
    expect(diff.blockedNote).toContain(`${NEW} は形式 1`)
  })
})

// --- 月全体 ---

describe('月全体 (totals) の差', () => {
  it('保存された実測値どうしを引き算する (作り直さない)', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ totals: { operations: 90, salesYen: 10000000, allowanceYen: 2400000, marginYen: 4400000 } })),
      side(NEW, snapshot({ totals: { operations: 91, salesYen: 10260265, allowanceYen: 2499500, marginYen: 4467597 } })),
    )
    expect(diff.totals).toEqual([
      { key: 'operations', label: '運行', unit: 'count', before: 90, after: 91, delta: 1 },
      { key: 'salesYen', label: '売上', unit: 'yen', before: 10000000, after: 10260265, delta: 260265 },
      { key: 'allowanceYen', label: '手当', unit: 'yen', before: 2400000, after: 2499500, delta: 99500 },
      { key: 'marginYen', label: '粗利', unit: 'yen', before: 4400000, after: 4467597, delta: 67597 },
    ])
  })

  it('★ 動いていない項目も 4 つとも残す (差だけ出すと検算できない)', () => {
    const diff = buildMarginDiff(side(OLD, snapshot()), side(NEW, snapshot()))
    expect(diff.totals.map(r => r.delta)).toEqual([0, 0, 0, 0])
  })

  it('減った側も符号のまま返す (絶対値に潰さない)', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ totals: { marginYen: 5000000 } })),
      side(NEW, snapshot({ totals: { marginYen: 4467597 } })),
    )
    expect(diff.totals[3]).toMatchObject({ key: 'marginYen', delta: -532403 })
  })
})

// --- 浮動小数の尾 (Refs #838) ---

/**
 * 本番 v0.0.526 の 2026-07 に**実際に保存されている**粗利。按分 (`fuelHaul` / `runCost`) が
 * 割り算を含むので尾が付く。**これ自体は正常**で、直すのは比べ方だけ。
 */
const PROD_MARGIN_YEN = 4467597.000000001
/** その隣の double。**合計の足し順が変わるだけのリファクタ**でこの程度は動く。 */
const NEXT_DOUBLE = 4467597.000000002

describe('★ 動いたかどうかは「画面に出る精度」で決める (Refs #838)', () => {
  it('前提: 本番の値には尾があり、厳密比較なら「動いた」になってしまう', () => {
    // `===` を直に書くと tsc がリテラル型で「重ならない比較」と言う (TS2367) ので値で比べる。
    expect(PROD_MARGIN_YEN).not.toBe(NEXT_DOUBLE)
    expect(NEXT_DOUBLE - PROD_MARGIN_YEN).not.toBe(0)
    // どちらも画面には同じ ¥4,467,597 と出る = 「粗利: ¥0 動いた」の正体。
    expect(Math.round(PROD_MARGIN_YEN)).toBe(4467597)
    expect(Math.round(NEXT_DOUBLE)).toBe(4467597)
  })

  it('前提: 合計の足し順を変えるだけで合計が変わる (実測)', () => {
    const xs = [1193630.4, 1174178.3, 567715.2, 357645.1]
    const forward = xs.reduce((s, x) => s + x, 0)
    const backward = [...xs].reverse().reduce((s, x) => s + x, 0)
    expect(forward === backward).toBe(false)
    // 足し順を変えただけの版どうしは「動いていない」。
    expect(marginDiffDisplayDelta('yen', forward, backward)).toBe(0)
  })

  it('★ 尾だけの違いは「動いていない」— 月全体の粗利の delta が 0 になる', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ totals: { marginYen: PROD_MARGIN_YEN } })),
      side(NEW, snapshot({ totals: { marginYen: NEXT_DOUBLE } })),
    )
    // 月全体は 4 項目とも出す仕様なので**行は在る**。中の `delta` が 0 になる。
    expect(diff.totals[3]).toMatchObject({ key: 'marginYen', unit: 'yen', delta: 0 })
    // **生値は捨てない** — 丸めた値に差し替えると検算できなくなる。
    expect(diff.totals[3]!.before).toBe(PROD_MARGIN_YEN)
    expect(diff.totals[3]!.after).toBe(NEXT_DOUBLE)
    // 「粗利が ¥0 動いた」回に燃費上書きの注記も出さない。
    expect(diff.overrideCaveat).toBe('')
  })

  it('★ 運行の一覧に「¥0 動いた」行を出さない (動いていない運行として数える)', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ operations: [op({ salesYen: 100000.000000001, totalKm: 300.00000000001 })] })),
      side(NEW, snapshot({ operations: [op({ salesYen: 100000.000000002, totalKm: 300 })] })),
    )
    expect(diff.changed).toEqual([])
    expect(diff.unchangedOperations).toBe(1)
  })

  it('★ 便の一覧にも「¥0 動いた」行を出さない', () => {
    const before = op({ legs: [leg({ seq: 1, salesYen: 60000.000000001, haulKm: 200.00000000001 })] })
    const after = op({ legs: [leg({ seq: 1, salesYen: 60000.000000002, haulKm: 200 })] })
    const diff = buildMarginDiff(side(OLD, snapshot({ operations: [before] })), side(NEW, snapshot({ operations: [after] })))
    expect(diff.changed).toEqual([])
    expect(diff.unchangedOperations).toBe(1)
  })

  it('★ 採ったのは「丸めてから引く」— 「差を丸める」だと画面の 2 数と食い違う', () => {
    // 画面は `¥100` と `¥101`。**1 円違って見えている。**
    const before = 100.4
    const after = 100.6
    expect(Math.round(before)).toBe(100)
    expect(Math.round(after)).toBe(101)
    // 案 2 (差を丸める) — **「動いていない」**になる。画面の 2 数は 1 円違うのに。
    expect(Math.round(after - before)).toBe(0)
    // 案 1 (各版を丸めてから引く) — 画面の数字どうしの引き算と一致する。
    expect(marginDiffDisplayDelta('yen', before, after)).toBe(1)
    const diff = buildMarginDiff(
      side(OLD, snapshot({ totals: { marginYen: before } })),
      side(NEW, snapshot({ totals: { marginYen: after } })),
    )
    expect(diff.totals[3]).toMatchObject({ key: 'marginYen', delta: 1 })
    expect(diff.overrideCaveat).toBe(MARGIN_DIFF_OVERRIDE_CAVEAT)
  })

  it('★ 距離は 0.1km まで — 金額と同じ丸め方にすると 0.4km の実変化が消える', () => {
    expect(marginDiffDisplayDelta('km', 57829.0, 57829.4)).toBe(0.4)
    // 一律 `Math.round` にしていたらこうなっていた (0.4km が落ちる)。
    expect(Math.round(57829.4) - Math.round(57829.0)).toBe(0)
    // 距離でも尾だけの違いは落とす。
    expect(marginDiffDisplayDelta('km', 200.00000000001, 200)).toBe(0)
    // 画面に出ない 0.05km 未満は「動いていない」、出る側は出す。
    expect(marginDiffDisplayDelta('km', 200, 200.04)).toBe(0)
    expect(marginDiffDisplayDelta('km', 200, 200.06)).toBe(0.1)
  })

  it('★ 距離の実変化は運行・便の行として出る (尾を落としても実変化は落とさない)', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ operations: [op({ totalKm: 300, legs: [leg({ haulKm: 200, deadheadKm: 30 })] })] })),
      side(NEW, snapshot({ operations: [op({ totalKm: 300.4, legs: [leg({ haulKm: 200.4, deadheadKm: 30 })] })] })),
    )
    expect(diff.changed[0]!.rows).toEqual([
      { key: 'totalKm', label: '走行km', unit: 'km', before: 300, after: 300.4, delta: 0.4 },
    ])
    expect(diff.changed[0]!.legs.legs[0]!.rows).toEqual([
      { key: 'haulKm', label: '売上km', unit: 'km', before: 200, after: 200.4, delta: 0.4 },
    ])
  })

  it('本数 (count) は整数しか取らないので何もしない (厳密比較のまま)', () => {
    expect(marginDiffDisplayDelta('count', 90, 91)).toBe(1)
    expect(marginDiffDisplayDelta('count', 91, 91)).toBe(0)
    expect(marginDiffDisplayDelta('count', 91, 90)).toBe(-1)
  })

  it('引き算そのものが作る尾も同じ格子に載せ直す — **0 には潰れない**', () => {
    // 丸めた後でも `q(0.3) - q(0.1) === 0.19999999999999998` になる。
    expect(Math.round(0.3 * 10) / 10 - Math.round(0.1 * 10) / 10).not.toBe(0.2)
    expect(marginDiffDisplayDelta('km', 0.1, 0.3)).toBe(0.2)
    expect(marginDiffDisplayDelta('km', 57829.1, 57829.4)).toBe(0.3)
    // 0.1km 格子の**最小差**が 0 に潰れないこと (丸めの粒 0.05 より大きい)。
    expect(marginDiffDisplayDelta('km', 0, 0.1)).toBe(0.1)
    expect(marginDiffDisplayDelta('km', 57829.3, 57829.4)).toBe(0.1)
  })

  it('★ 2026-07 の本番値は 1 円も動かない (同じ版どうしの差はすべて 0)', () => {
    const prod = snapshot({
      totals: { operations: 91, totalKm: 57829.4, salesYen: 10260265, allowanceYen: 2499500, marginYen: PROD_MARGIN_YEN },
      operations: [op({ totalKm: 57829.4, salesYen: 10260265, allowanceYen: 2499500 })],
    })
    const diff = buildMarginDiff(side(OLD, prod), side(NEW, prod))
    expect(diff.totals.map(r => r.delta)).toEqual([0, 0, 0, 0])
    // **保存された生値のまま返している** (丸めた値に差し替えていない)。
    expect(diff.totals.map(r => r.after)).toEqual([91, 10260265, 2499500, PROD_MARGIN_YEN])
    expect(diff.changed).toEqual([])
    expect(diff.unchangedOperations).toBe(1)
    expect(diff.overrideCaveat).toBe('')
  })
})

// --- 運行 ---

describe('運行 (unkoNo) の 追加 / 削除 / 変更', () => {
  it('新しい版にしかない運行は 追加、古い版にしかない運行は 削除', () => {
    const kept = op({ unkoNo: 'KEEP' })
    const gone = op({ unkoNo: 'GONE', driverName: '佐藤', totalKm: 111, salesYen: 50000, allowanceYen: 6000 })
    const born = op({ unkoNo: 'NEW', driverName: '鈴木', totalKm: 222, salesYen: 70000, allowanceYen: 8000, legs: [leg(), leg({ seq: 2 })] })
    const diff = buildMarginDiff(
      side(OLD, snapshot({ operations: [kept, gone] })),
      side(NEW, snapshot({ operations: [kept, born] })),
    )
    expect(diff.added).toEqual([{
      unkoNo: 'NEW', date: '2026-07-03', driverName: '鈴木', vehicleCode: '0040',
      salesYen: 70000, allowanceYen: 8000, totalKm: 222, legCount: 2,
    }])
    expect(diff.removed).toEqual([{
      unkoNo: 'GONE', date: '2026-07-03', driverName: '佐藤', vehicleCode: '0040',
      salesYen: 50000, allowanceYen: 6000, totalKm: 111, legCount: 1,
    }])
    // 変わっていない運行は**数える**。落とすと何本比べたのか分からない。
    expect(diff.changed).toEqual([])
    expect(diff.unchangedOperations).toBe(1)
  })

  it('動いた項目だけを行にする (動いていない項目は運行の行に出さない)', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ operations: [op({ salesYen: 100000, totalKm: 300 })] })),
      side(NEW, snapshot({ operations: [op({ salesYen: 120000, totalKm: 300 })] })),
    )
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]!.rows).toEqual([
      { key: 'salesYen', label: '売上', unit: 'yen', before: 100000, after: 120000, delta: 20000 },
    ])
    expect(diff.changed[0]).toMatchObject({ unkoNo: '20260703-0040-1', date: '2026-07-03', driverName: '山田', vehicleCode: '0040' })
    expect(diff.unchangedOperations).toBe(0)
  })

  it('便数 (legs.length) も運行の項目として比べる', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ operations: [op({ legs: [leg()] })] })),
      side(NEW, snapshot({ operations: [op({ legs: [leg(), leg({ seq: 2 })] })] })),
    )
    expect(diff.changed[0]!.rows).toEqual([
      { key: 'legCount', label: '便数', unit: 'count', before: 1, after: 2, delta: 1 },
    ])
  })

  it('★ 運行の合計が同じでも便の中身が動いていれば「変更」に出す', () => {
    // 売上が便をまたいで移ると運行の合計は動かない。**畳むと変化が消える。**
    const before = op({ legs: [leg({ seq: 1, salesYen: 60000 }), leg({ seq: 2, salesYen: 40000 })] })
    const after = op({ legs: [leg({ seq: 1, salesYen: 40000 }), leg({ seq: 2, salesYen: 60000 })] })
    const diff = buildMarginDiff(side(OLD, snapshot({ operations: [before] })), side(NEW, snapshot({ operations: [after] })))
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]!.rows).toEqual([])
    expect(diff.changed[0]!.legs.legs.map(l => l.seq)).toEqual([1, 2])
    expect(diff.unchangedOperations).toBe(0)
  })

  it('新しい版の並び順のまま出す (新しい comparator を作らない)', () => {
    const a = op({ unkoNo: 'A', salesYen: 1 })
    const b = op({ unkoNo: 'B', salesYen: 1 })
    const c = op({ unkoNo: 'C', salesYen: 1 })
    const diff = buildMarginDiff(
      side(OLD, snapshot({ operations: [a, b, c] })),
      side(NEW, snapshot({ operations: [
        { ...c, salesYen: 2 }, { ...a, salesYen: 2 }, { ...b, salesYen: 2 },
      ] })),
    )
    expect(diff.changed.map(o => o.unkoNo)).toEqual(['C', 'A', 'B'])
  })
})

// --- 便 ---

describe('便 (seq) の突き合わせ', () => {
  it('★ 便数が違えば便ごとの数値を出さない (seq が総ずれするため)', () => {
    const before = op({ legs: [leg({ seq: 1 }), leg({ seq: 2, originCity: '札幌', destCity: '旭川' })] })
    const after = op({ legs: [leg({ seq: 1 })] })
    const diff = buildMarginDiff(side(OLD, snapshot({ operations: [before] })), side(NEW, snapshot({ operations: [after] })))
    const legs = diff.changed[0]!.legs
    expect(legs.state).toBe('count-changed')
    expect(legs.legs).toEqual([])
    expect(legs.beforeCount).toBe(2)
    expect(legs.afterCount).toBe(1)
    expect(marginDiffLegCountNote(legs)).toContain('便数が 2 → 1 に変わったので、便ごとの数値は比べていません')
  })

  it('便数が同じなら seq 順に 1:1 で比べ、動いた便だけ出す', () => {
    const before = op({ legs: [
      leg({ seq: 1, salesYen: 60000 }),
      leg({ seq: 2, originCity: '札幌', destCity: '旭川', salesYen: 40000 }),
    ] })
    const after = op({ legs: [
      leg({ seq: 1, salesYen: 60000 }),
      leg({ seq: 2, originCity: '札幌', destCity: '旭川', salesYen: 45000, haulKm: 210 }),
    ] })
    const diff = buildMarginDiff(side(OLD, snapshot({ operations: [before] })), side(NEW, snapshot({ operations: [after] })))
    const legs = diff.changed[0]!.legs
    expect(legs.state).toBe('compared')
    expect(marginDiffLegCountNote(legs)).toBe('')
    expect(legs.legs).toHaveLength(1)
    expect(legs.legs[0]!.seq).toBe(2)
    expect(legs.legs[0]!.routeChanged).toBe(false)
    expect(legs.legs[0]!.rows.map(r => r.key)).toEqual(['salesYen', 'haulKm'])
  })

  it('★ 同じ seq に別の便が来ていれば、金額が同じでも出す', () => {
    // 往復や同一区間を複数回通る運行では `date`+`originCity`+`destCity` が重なるので
    // **寄せない**。寄せずに seq で見ると「別の便になっている」ことがそのまま出る。
    const before = op({ legs: [leg({ seq: 1, originCity: '帯広', destCity: '札幌' })] })
    const after = op({ legs: [leg({ seq: 1, originCity: '札幌', destCity: '帯広' })] })
    const diff = buildMarginDiff(side(OLD, snapshot({ operations: [before] })), side(NEW, snapshot({ operations: [after] })))
    const changedLeg = diff.changed[0]!.legs.legs[0]!
    expect(changedLeg.routeChanged).toBe(true)
    expect(changedLeg.beforeLabel).toBe('2026-07-03 帯広 → 札幌')
    expect(changedLeg.afterLabel).toBe('2026-07-03 札幌 → 帯広')
    expect(changedLeg.rows).toEqual([])
  })

  it('便が 1 本も動いていなければ compared のまま空 (「比べていない」と区別する)', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ operations: [op({ salesYen: 100000 })] })),
      side(NEW, snapshot({ operations: [op({ salesYen: 120000 })] })),
    )
    expect(diff.changed[0]!.legs.state).toBe('compared')
    expect(diff.changed[0]!.legs.legs).toEqual([])
  })

  it('marginDiffLegLabel は 日付 積地 → 卸地', () => {
    expect(marginDiffLegLabel(leg({ date: '2026-07-31', originCity: '釧路', destCity: '帯広' }))).toBe('2026-07-31 釧路 → 帯広')
  })
})

// --- 注記 ---

describe('注記', () => {
  it('★ 粗利が動いた回は「端末の燃費上書きでも起こりえる」と断る', () => {
    expect(marginDiffOverrideCaveat(1)).toBe(MARGIN_DIFF_OVERRIDE_CAVEAT)
    expect(marginDiffOverrideCaveat(-1)).toBe(MARGIN_DIFF_OVERRIDE_CAVEAT)
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).toContain('燃費の上書き')
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).toContain('データが 1 円も変わっていないのに版が増えていることがあります')
  })

  it('★★ 指紋が入った後も「版には残っていない」と言い続けない (Refs #886)', () => {
    // #886 で形式 2 の版は指紋 (燃費の上書き・運行経費の配分) を持つようになった。
    // **触っていない文言が嘘になる型** (map skill の「PR の基準」(7)) なので、
    // 「版には残っていません」を言い切らないことを固定する。
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).not.toContain('版には残っていません')
  })

  it('★★ この注記は「版に有る/無い」を語らない — 版によって真偽が変わる文にしない (Refs #886)', () => {
    // 「版には残っていません」は**形式 2 どうしなら偽・形式 1 が絡めば真**。
    // 定数として成立しないので、**版に依存しない事実** (この差分が何を出しているか) で書く。
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).toContain('この差分は保存された値を引き算するだけなので')
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).toContain('どちらが原因だったかまでは出していません')
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).not.toContain('形式 1')
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).not.toContain('形式 2')
  })

  it('★★ 逆方向の誤読を潰す — 「記録されるようになった」と読ませない (#854 の型)', () => {
    // 「指紋が記録されるようになりました」と書くと「じゃあ差分に出るはず」と期待されるが、
    // `buildMarginDiff` は指紋を突き合わせない (この PR ではロジック無改変)。
    // **出ないものを出るように読ませない。**
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).not.toContain('指紋')
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).not.toContain('記録されるようになりました')
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).not.toContain('残るようになりました')
  })

  it('★ 版が増えること自体は指紋を足しても止まらない — その 1 文は残す (Refs #886)', () => {
    // 指紋が入って変わったのは「増えた理由が版に残る」ことだけで、
    // **増えること自体は止まらない**。ここは今も真なので消さない。
    expect(MARGIN_DIFF_OVERRIDE_CAVEAT).toContain('データが 1 円も変わっていないのに版が増えていることがあります')
  })

  it('粗利が動いていない回は出さない (常に出すと読み飛ばされる)', () => {
    expect(marginDiffOverrideCaveat(0)).toBe('')
  })

  it('buildMarginDiff は粗利の差から注記を決める', () => {
    const same = buildMarginDiff(side(OLD, snapshot()), side(NEW, snapshot()))
    expect(same.overrideCaveat).toBe('')
    const moved = buildMarginDiff(
      side(OLD, snapshot({ totals: { marginYen: 4400000 } })),
      side(NEW, snapshot({ totals: { marginYen: 4467597 } })),
    )
    expect(moved.overrideCaveat).toBe(MARGIN_DIFF_OVERRIDE_CAVEAT)
  })

  it('★ 運行 1 本ごとの粗利を出していない理由を画面に出す文言がある', () => {
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('運行 1 本ごとの粗利')
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('粗利を計算し直さない')
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('月全体の粗利は保存された実測値です')
  })

  it('★★ 出していない理由は 2 段 — 版に依存しない方を先に書く (Refs #886)', () => {
    // 形式 2 の版は指紋を持つので、**「版に入っていない」は形式 1 についてしか成り立たない。**
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).not.toContain('版に入っていない')
    // ① 版に依存しない本体の理由 (この差分は再計算しない)。
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('この差分は保存された値を引き算するだけで、粗利を計算し直さないためです')
    // ② 形式 1 はそもそも再現できない。**「再現できるようになった」とは書かない。**
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('形式 1 の版は燃費の上書きと運行経費の配分を持たない')
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('厳密に再現できません')
  })

  it('★★ 非対称性はここに 1 か所だけ残す — 過去の版には遡って付かない (Refs #886)', () => {
    // 指紋が付くのは**これから保存される版だけ**。この 1 文をどこかに残すのが #886 の条件で、
    // 置き場所はこの注記 (もう一方の注記は版に依存しない書き方に寄せた)。
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('指紋が付くのは形式 2 以降に保存された版だけ')
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('過去の版に遡って付けることはできません')
  })

  it('コード版が違えば断る (同じ入力でもロジックが変われば数字は動く)', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot({ codeVersion: 'v0.0.520' })),
      side(NEW, snapshot({ codeVersion: 'v0.0.524' })),
    )
    expect(diff.codeVersionNote).toContain('v0.0.520 → v0.0.524')
    expect(marginDiffCodeVersionNote(
      { label: OLD, savedAt: '', codeVersion: 'v0.0.524', schemaVersion: 1 },
      { label: NEW, savedAt: '', codeVersion: 'v0.0.524', schemaVersion: 1 },
    )).toBe('')
  })

  it('形式が違う旨には両方の形式を書く', () => {
    expect(marginDiffSchemaMismatchNote(
      { label: OLD, savedAt: '', codeVersion: 'v0.0.520', schemaVersion: 1 },
      { label: NEW, savedAt: '', codeVersion: 'v0.0.524', schemaVersion: 2 },
    )).toBe(
      '比較できません (版の形式が違います) — '
      + 'v-20260824T100000 は形式 1、v-20260824T190153 は形式 2 です。'
      + '形式が違う版を突き合わせると、形が変わっただけなのに数字が動いたように見えるので、差分は出していません。',
    )
  })

  it('粗利の対象外の便は動いたときだけ 1 行', () => {
    expect(marginDiffUncoveredNote(null, null)).toBe('')
    expect(marginDiffUncoveredNote(
      { trips: 36, salesYen: 1649681, allowanceYen: 413000 },
      { trips: 36, salesYen: 1649681, allowanceYen: 413000 },
    )).toBe('')
    expect(marginDiffUncoveredNote(null, { trips: 36, salesYen: 1649681, allowanceYen: 413000 }))
      .toBe('粗利の対象外の便が変わりました: 0 便 → 36 便 (売上 ¥1,649,681、手当 ¥413,000) (この額は粗利の内訳とは足し合わせません)。')
    expect(marginDiffUncoveredNote({ trips: 36, salesYen: 1649681, allowanceYen: 413000 }, null))
      .toContain('→ 0 便')
  })

  /**
   * **注記に `¥-0` を出さない** (Refs #843 / #840)。対象外の便の売上・手当は
   * 一番星の額をそのまま足したもので**負にもなる**が、`Math.round` は `-0.5 ≤ v < 0` で
   * `-0` を返し、`(-0).toLocaleString()` が **`"-0"`** を返す。注記に `¥-0` と書かれると
   * 「0 円」なのか「符号が化けた」のか読めない。
   *
   * **陽性対照 (`-0.6` → `¥-1`) つき** — `Math.abs` で符号ごと消す直しを弾くため。
   */
  it('注記に `¥-0` を出さない (負の額は負のまま)', () => {
    const noteOf = (salesYen: number) =>
      marginDiffUncoveredNote(null, { trips: 1, salesYen, allowanceYen: 0 })

    expect(noteOf(-0.4)).toContain('売上 ¥0')
    expect(noteOf(-0.5)).toContain('売上 ¥0')
    expect(noteOf(-0.0004)).toContain('売上 ¥0')
    expect(noteOf(-0)).toContain('売上 ¥0')
    expect(noteOf(0)).toContain('売上 ¥0')
    // 陽性対照: 符号を消していない
    expect(noteOf(-0.6)).toContain('売上 ¥-1')
    expect(noteOf(-413000)).toContain('売上 ¥-413,000')
    // 正の額は動かない
    expect(noteOf(1649681)).toContain('売上 ¥1,649,681')

    // 手当の側も同じ (`yenText` は 1 本)
    expect(marginDiffUncoveredNote(null, { trips: 1, salesYen: 0, allowanceYen: -0.4 }))
      .toContain('手当 ¥0')
    expect(marginDiffUncoveredNote(null, { trips: 1, salesYen: 0, allowanceYen: -0.6 }))
      .toContain('手当 ¥-1')
  })

  it('月を跨いだ便は動いたときだけ 1 行', () => {
    expect(marginDiffCrossMonthNote(null, null)).toBe('')
    const c = { nextMonthLegs: 2, nextMonthAllowanceYen: 24000, prevMonthOpsLegsInMonth: 1, prevMonthOpsAllowanceYen: 12000 }
    expect(marginDiffCrossMonthNote(c, c)).toBe('')
    expect(marginDiffCrossMonthNote(null, c)).toBe(
      '月を跨いだ便が変わりました: なし → 翌月日付の便 2 便 (手当 ¥24,000) / 前月開始の運行の当月便 1 便 (手当 ¥12,000)。',
    )
    expect(marginDiffCrossMonthNote(c, { ...c, nextMonthLegs: 3 })).toContain('翌月日付の便 3 便')
  })

  it('buildMarginDiff が uncovered / crossMonth の注記まで持つ', () => {
    const diff = buildMarginDiff(
      side(OLD, snapshot()),
      side(NEW, snapshot({
        uncovered: { trips: 1, salesYen: 1000, allowanceYen: 100 },
        crossMonth: { nextMonthLegs: 1, nextMonthAllowanceYen: 100, prevMonthOpsLegsInMonth: 0, prevMonthOpsAllowanceYen: 0 },
      })),
    )
    expect(diff.uncoveredNote).toContain('粗利の対象外の便が変わりました')
    expect(diff.crossMonthNote).toContain('月を跨いだ便が変わりました')
  })
})

describe('marginDiffNeedsMoreVersionsNote', () => {
  it('★ 版が 1 本しかないときに黙って空にしない (本番 2026-07 がこの状態)', () => {
    const note = marginDiffNeedsMoreVersionsNote(1)
    expect(note).toContain('版が 1 本しかないので、まだ差分を出せません')
    expect(note).toContain('比べるには 2 本以上要ります')
    // **どうすれば版が増えるのか**まで書く (待てば増えるものではない)。
    expect(note).toContain('粗利タブで集計して、前の版と中身が変わったとき')
  })

  it('★ 「同じ数字なら増えない」とは言わない — 数字はハッシュ対象の一部でしかない (Refs #891)', () => {
    const note = marginDiffNeedsMoreVersionsNote(1)
    // 本番 v0.0.556 で、運行 91 本 / 売上 ¥10,260,265 / 手当 ¥2,499,500 / 粗利 ¥4,467,597 が
    // 4 項目とも同一の版が 2 本並んだ (形式 1 → 形式 2 の最初の集計)。**この 1 文が嘘だった。**
    expect(note).not.toContain('同じ数字なら版は増えません')
    // `marginSummaryHashInput` が数字の他に見ているもの (Refs #886) を、両方とも言う。
    expect(note).toContain('集計した端末の設定 (燃費の上書き・運行経費の配分) が変わったとき')
    expect(note).toContain('保存の形式が上がった後の最初の集計では増えます')
  })

  it('★ 逆方向の誤読も潰す — 「集計すれば必ず増える」と読ませない (#854 の型)', () => {
    // 中身が同じなら `putVersionedProfit` は `changed: false` で本当に増やさない。
    expect(marginDiffNeedsMoreVersionsNote(1)).toContain('どれも前の版と同じなら、何度集計しても増えません')
  })

  it('版が 0 本でも本数をそのまま言う', () => {
    expect(marginDiffNeedsMoreVersionsNote(0)).toContain('版が 0 本しかないので')
  })

  it('2 本以上あれば何も出さない', () => {
    expect(marginDiffNeedsMoreVersionsNote(2)).toBe('')
    expect(marginDiffNeedsMoreVersionsNote(20)).toBe('')
  })
})
