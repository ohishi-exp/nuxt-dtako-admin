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
import { MARGIN_SUMMARY_SCHEMA_VERSION, type MarginSummarySnapshot } from '../../app/utils/margin-r2'

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

  it('★ 運行 1 本には marginYen が無い (版から厳密に再現できないので出さない)', () => {
    // `buildOperationMargins` の `overrides` (燃費の上書き) と `runCostShareMode` は
    // **その端末の localStorage にしか無く版に入っていない**。再計算すると画面が実際に
    // 見た `totals.marginYen` とズレる数字を作りかねないので、運行単位は生の入力値まで。
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
    // `schemaVersion` をリテラル `1` のまま受けると「形式が違う 2 版」が型の上で
    // 存在しなくなり、上の判定が死ぬので、差分側は `number` で受けている。
    const saved: MarginSummarySnapshot = {
      schemaVersion: MARGIN_SUMMARY_SCHEMA_VERSION,
      ym: '2026-07',
      codeVersion: 'v0.0.524',
      savedAt: '2026-08-24T10:01:53.000Z',
      totals: emptyMarginTotals(),
      cache: { ym: '2026-07', savedAt: '', operations: [], costs: [], uncovered: null, crossMonth: null },
    }
    const asDiffInput: MarginDiffSnapshot = saved
    expect(buildMarginDiff(side(OLD, asDiffInput), side(NEW, asDiffInput)).state).toBe('ready')
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
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('版に入っていない')
    expect(MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE).toContain('月全体の粗利は保存された実測値です')
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
    expect(note).toContain('粗利タブで集計して、前の版と数字が変わったとき')
  })

  it('版が 0 本でも本数をそのまま言う', () => {
    expect(marginDiffNeedsMoreVersionsNote(0)).toContain('版が 0 本しかないので')
  })

  it('2 本以上あれば何も出さない', () => {
    expect(marginDiffNeedsMoreVersionsNote(2)).toBe('')
    expect(marginDiffNeedsMoreVersionsNote(20)).toBe('')
  })
})
