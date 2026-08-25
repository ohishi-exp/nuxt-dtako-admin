import { describe, it, expect } from 'vitest'

import {
  MARGIN_SUMMARY_SCHEMA_VERSION,
  UNKNOWN_CODE_VERSION,
  buildMarginSummaryInput,
  isRunCostShareMode,
  marginR2Paths,
  marginSummaryHashInput,
  marginSummaryHistoryLine,
  marginSummarySaveNote,
  marginVersionLabel,
  MARGIN_VERSION_UNNAMED,
  resolveCodeVersion,
  ciBuildCodeVersion,
  type MarginSummarySnapshot,
} from '../../app/utils/margin-r2'
import { emptyMarginTotals, type FuelRateMap, type MarginCache, type MarginTotals, type RunCostShareMode } from '../../app/utils/margin'
import { PROFIT_HISTORY_MAX_LINES, appendProfitHistoryJsonl } from '../../app/utils/profit-r2'

function cache(overrides: Partial<MarginCache> = {}): MarginCache {
  return {
    ym: '2026-07',
    savedAt: '2026-08-24T01:23:45.000Z',
    operations: [],
    costs: [],
    uncovered: null,
    crossMonth: null,
    ...overrides,
  }
}

/**
 * 2026-07 の本番値 (issue #826 の不変条件)。運行 91 本 / 売上 ¥10,260,265 /
 * 手当 ¥2,499,500 / 粗利 ¥4,467,597。**この PR は 1 円も動かさない**ので、
 * 保存する形を通しても同じ数字で出てくることを固定する。
 */
function productionTotals(): MarginTotals {
  return {
    ...emptyMarginTotals(),
    operations: 91,
    salesYen: 10260265,
    allowanceYen: 2499500,
    marginYen: 4467597,
  }
}

/**
 * `buildMarginSummaryInput` の呼び出しを 1 か所に畳む。**指紋 2 欄の既定は「上書きなし・
 * 既定の配分」** (Refs #886) — 大半のテストは指紋そのものが主題ではないので、
 * 指紋を見るテストだけが明示的に渡す形にする。
 */
function input(params: {
  cache?: MarginCache
  totals?: MarginTotals
  codeVersion?: unknown
  fuelRateOverrides?: FuelRateMap
  runCostShareMode?: RunCostShareMode
} = {}) {
  return buildMarginSummaryInput({
    cache: params.cache ?? cache(),
    totals: params.totals ?? emptyMarginTotals(),
    codeVersion: params.codeVersion ?? 'v0.0.517',
    fuelRateOverrides: params.fuelRateOverrides ?? {},
    runCostShareMode: params.runCostShareMode ?? 'km',
  })
}

describe('marginR2Paths — 検証スナップショットと同じ作法・別の枝', () => {
  it('profit/{ym}/margin-summary/ の latest / v-{ts} / history', () => {
    const paths = marginR2Paths('2026-07')
    expect(paths.dir).toBe('profit/2026-07/margin-summary')
    expect(paths.latest).toBe('profit/2026-07/margin-summary/latest.json')
    expect(paths.version('20260824T102030')).toBe('profit/2026-07/margin-summary/v-20260824T102030.json')
    expect(paths.history).toBe('profit/2026-07/margin-summary/history.jsonl')
  })

  it('月ごとに別の枝になる (月より細かく割らない)', () => {
    expect(marginR2Paths('2026-08').dir).toBe('profit/2026-08/margin-summary')
    expect(marginR2Paths('2026-08').latest).not.toBe(marginR2Paths('2026-07').latest)
  })
})

describe('resolveCodeVersion — 空文字や undefined を版に混ぜない', () => {
  it('タグ名はそのまま', () => {
    expect(resolveCodeVersion('v0.0.517')).toBe('v0.0.517')
  })

  it('前後の空白は落とす', () => {
    expect(resolveCodeVersion('  v0.0.517\n')).toBe('v0.0.517')
  })

  it('空文字・空白だけは「不明」', () => {
    expect(resolveCodeVersion('')).toBe(UNKNOWN_CODE_VERSION)
    expect(resolveCodeVersion('   ')).toBe(UNKNOWN_CODE_VERSION)
  })

  it('undefined / null / 非文字列も「不明」 (落とさず記録する)', () => {
    expect(resolveCodeVersion(undefined)).toBe(UNKNOWN_CODE_VERSION)
    expect(resolveCodeVersion(null)).toBe(UNKNOWN_CODE_VERSION)
    expect(resolveCodeVersion(42)).toBe(UNKNOWN_CODE_VERSION)
    expect(resolveCodeVersion({ v: 'v1' })).toBe(UNKNOWN_CODE_VERSION)
  })

  it('「不明」は空文字ではない (版のキーが消えない)', () => {
    expect(UNKNOWN_CODE_VERSION).toBe('unknown')
    expect(UNKNOWN_CODE_VERSION.length).toBeGreaterThan(0)
  })
})

describe('ciBuildCodeVersion — タグ以外のビルドで版に名前を付けない', () => {
  it('タグリリースだけが値を持つ', () => {
    expect(ciBuildCodeVersion('tag', 'v0.0.517')).toBe('v0.0.517')
  })

  it('★ staging (main への push) は空文字 — `main` は中身が動き続ける名前で「版」ではない', () => {
    expect(ciBuildCodeVersion('branch', 'main')).toBe('')
  })

  it('★ preview (branch への push) も空文字', () => {
    expect(ciBuildCodeVersion('branch', 'claude/loving-shannon-125496')).toBe('')
  })

  it('★ CI の外 (env が無い) は空文字 — undefined を版に混ぜない', () => {
    expect(ciBuildCodeVersion(undefined, undefined)).toBe('')
    expect(ciBuildCodeVersion(undefined, 'v0.0.517')).toBe('')
  })

  it('タグなのに名前が無い / 空白だけなら空文字', () => {
    expect(ciBuildCodeVersion('tag', undefined)).toBe('')
    expect(ciBuildCodeVersion('tag', '   ')).toBe('')
  })

  it('★ 空文字はそのままでは版にならない (resolveCodeVersion が unknown に倒す)', () => {
    expect(resolveCodeVersion(ciBuildCodeVersion('branch', 'main'))).toBe(UNKNOWN_CODE_VERSION)
    expect(resolveCodeVersion(ciBuildCodeVersion(undefined, undefined))).toBe(UNKNOWN_CODE_VERSION)
    expect(resolveCodeVersion(ciBuildCodeVersion('tag', 'v0.0.517'))).toBe('v0.0.517')
  })
})

describe('marginVersionLabel — 人に見せる版の名前', () => {
  it('R2 キーから v-{ts} だけ取る', () => {
    expect(marginVersionLabel('profit/2026-07/margin-summary/v-20260824T102030.json')).toBe('v-20260824T102030')
  })

  it('版キーを持たない古い保存は空文字のまま', () => {
    expect(marginVersionLabel('')).toBe('')
  })

  it('.json が付いていなくても壊れない', () => {
    expect(marginVersionLabel('v-20260824T102030')).toBe('v-20260824T102030')
  })
})

describe('buildMarginSummaryInput', () => {
  it('月は cache.ym から採る (保存先と中身の月がずれない)', () => {
    const built = input({ cache: cache({ ym: '2026-06' }) })
    expect(built.ym).toBe('2026-06')
    expect(built.schemaVersion).toBe(MARGIN_SUMMARY_SCHEMA_VERSION)
  })

  it('コード版はここで正規化する', () => {
    expect(input({ codeVersion: '' }).codeVersion).toBe(UNKNOWN_CODE_VERSION)
    expect(input({ codeVersion: 'v0.0.517' }).codeVersion).toBe('v0.0.517')
  })

  it('★ 2026-07 の本番値を 1 円も動かさない (合計をそのまま持ち回るだけ)', () => {
    const built = input({ totals: productionTotals() })
    expect(built.totals.operations).toBe(91)
    expect(built.totals.salesYen).toBe(10260265)
    expect(built.totals.allowanceYen).toBe(2499500)
    expect(built.totals.marginYen).toBe(4467597)

    // ★ 指紋が入っても合計は動かない。**上書きが「入っている」場合も**同じことを見る —
    // `buildMarginSummaryInput` は指紋を持ち回るだけで、`totals` を作り直さない。
    const withOverrides = input({
      totals: productionTotals(),
      fuelRateOverrides: { '1234': { yenPerLiter: 150, kmPerLiter: 3.2 } },
      runCostShareMode: 'time',
    })
    expect(withOverrides.totals).toEqual(built.totals)
  })

  it('MarginCache は形も中身も変えずそのまま入れる', () => {
    const c = cache({ uncovered: { trips: 36, salesYen: 1649681, allowanceYen: 413000 } })
    expect(input({ cache: c }).cache).toEqual(c)
  })

  it('★ その端末の設定を指紋としてそのまま入れる (Refs #886)', () => {
    const overrides: FuelRateMap = { '1234': { yenPerLiter: 150, kmPerLiter: null }, '5678': { yenPerLiter: null, kmPerLiter: 3.2 } }
    const built = input({ fuelRateOverrides: overrides, runCostShareMode: 'time' })
    expect(built.fuelRateOverrides).toEqual(overrides)
    expect(built.runCostShareMode).toBe('time')
  })

  it('★ 上書きが 1 台も無ければ空オブジェクト — null に倒さない', () => {
    // 「上書きしていない」と「指紋そのものが無い (形式 1)」は別の意味。
    // 形式 1 かどうかを言うのは `schemaVersion` の仕事で、この欄ではない。
    const built = input({ fuelRateOverrides: {} })
    expect(built.fuelRateOverrides).toEqual({})
    expect(built.fuelRateOverrides).not.toBeNull()
  })

  it('★ 指紋を既定に倒したり作り直したりしない (渡されたものを名乗る)', () => {
    // 版が名乗る指紋は**その数字を実際に作った設定**でなければ意味が無いので、
    // 既定 (`km`) 以外もそのまま通ることを固定する。
    expect(input({ runCostShareMode: 'legs' }).runCostShareMode).toBe('legs')
    expect(input({ runCostShareMode: 'km' }).runCostShareMode).toBe('km')
  })

  it('★ 形式は 2 (指紋が入った版)', () => {
    expect(MARGIN_SUMMARY_SCHEMA_VERSION).toBe(2)
    expect(input().schemaVersion).toBe(2)
  })
})

describe('isRunCostShareMode — 保存の口で既定に倒さない (Refs #886)', () => {
  it('3 つの比だけ通す', () => {
    expect(isRunCostShareMode('km')).toBe(true)
    expect(isRunCostShareMode('legs')).toBe(true)
    expect(isRunCostShareMode('time')).toBe(true)
  })

  it('★ 知らない文字列は通さない (`parseRunCostShareMode` と違って km に丸めない)', () => {
    // 画面側の `parseRunCostShareMode` は読めない値を既定に丸めるが、**保存の口で丸めると
    // 嘘の指紋を版に刻む**。版は「その数字を実際に作った設定」を名乗るものなので、
    // 名乗れないものは受けない。
    expect(isRunCostShareMode('KM')).toBe(false)
    expect(isRunCostShareMode('')).toBe(false)
    expect(isRunCostShareMode('toString')).toBe(false)
  })

  it('文字列でないものも通さない', () => {
    expect(isRunCostShareMode(undefined)).toBe(false)
    expect(isRunCostShareMode(null)).toBe(false)
    expect(isRunCostShareMode(0)).toBe(false)
    expect(isRunCostShareMode({ km: true })).toBe(false)
  })
})

describe('marginSummaryHashInput — 差分検知', () => {
  const base = input({ totals: productionTotals() })

  it('保存時刻が違うだけなら同じ (毎回版が増えるのを防ぐ)', () => {
    const later = input({ cache: cache({ savedAt: '2026-08-25T09:00:00.000Z' }), totals: productionTotals() })
    expect(marginSummaryHashInput(later)).toBe(marginSummaryHashInput(base))
  })

  it('コード版が違うだけなら同じ (数字が動いていないのに版を増やさない)', () => {
    const newer = input({ totals: productionTotals(), codeVersion: 'v0.0.518' })
    expect(marginSummaryHashInput(newer)).toBe(marginSummaryHashInput(base))
  })

  it('合計が 1 円でも動けば違う', () => {
    const moved = input({ totals: { ...productionTotals(), marginYen: 4467598 } })
    expect(marginSummaryHashInput(moved)).not.toBe(marginSummaryHashInput(base))
  })

  it('キャッシュの中身が変われば違う (合計が同じでも内訳の差を拾う)', () => {
    const moved = input({
      cache: cache({ uncovered: { trips: 36, salesYen: 1649681, allowanceYen: 413000 } }),
      totals: productionTotals(),
    })
    expect(marginSummaryHashInput(moved)).not.toBe(marginSummaryHashInput(base))
  })

  it('月が変われば違う', () => {
    const other = input({ cache: cache({ ym: '2026-06' }), totals: productionTotals() })
    expect(marginSummaryHashInput(other)).not.toBe(marginSummaryHashInput(base))
  })

  it('保存時刻はハッシュ対象の文字列に残らない', () => {
    expect(marginSummaryHashInput(base)).not.toContain('2026-08-24T01:23:45.000Z')
  })

  it('★ 燃費の上書きが変われば違う (版が増えた理由を版が名乗れるようにする、Refs #886)', () => {
    const overridden = input({ totals: productionTotals(), fuelRateOverrides: { '1234': { yenPerLiter: 150, kmPerLiter: null } } })
    expect(marginSummaryHashInput(overridden)).not.toBe(marginSummaryHashInput(base))
  })

  it('★★ 配分の比だけ変わっても違う — `totals` が 1 円も動かない回でも版を分ける (Refs #886)', () => {
    // `runCostShareMode` は `buildLegMargins` にしか流れず `totals` を動かさない。
    // だからハッシュに入れないと**本文は違うのに同じ版**になり、指紋を足した意味が消える。
    // 便の内訳は実際に変わっているので、版が 1 本増えるのが正しい。
    const timeShare = input({ totals: productionTotals(), runCostShareMode: 'time' })
    expect(timeShare.totals).toEqual(base.totals)
    expect(marginSummaryHashInput(timeShare)).not.toBe(marginSummaryHashInput(base))
  })

  it('★ 上書きの入れた順が違うだけなら同じ (中身が同じなのに版を増やさない)', () => {
    // ★ **車輌C が 1000 未満だと並びが入れた順になる。** `vehicleCodeFromUnkoNo` は
    // `padStart(4, '0')` を通すので `'0123'` になり、これは整数として正規な文字列ではない
    // ので JS が昇順に揃えてくれない (`'1234'` のような 4 桁は揃う)。
    // 1 台消して入れ直すだけで版が増えると、**理由の無い版**がまた溜まる。
    const a = input({ totals: productionTotals(), fuelRateOverrides: {
      '0123': { yenPerLiter: 150, kmPerLiter: null },
      '0456': { yenPerLiter: null, kmPerLiter: 3.2 },
    } })
    const b = input({ totals: productionTotals(), fuelRateOverrides: {
      '0456': { yenPerLiter: null, kmPerLiter: 3.2 },
      '0123': { yenPerLiter: 150, kmPerLiter: null },
    } })
    // 前提 (この差が実在すること) をまず固定する — 消えたらこのテストが空回りする。
    expect(JSON.stringify(a.fuelRateOverrides)).not.toBe(JSON.stringify(b.fuelRateOverrides))
    expect(marginSummaryHashInput(a)).toBe(marginSummaryHashInput(b))
  })

  it('4 桁が全部数字なら JS が元から昇順に揃える (こちらは並べ直さなくても同じ)', () => {
    // **測ってから書く。** `'1234'` / `'5678'` は整数として正規な文字列なので、
    // 入れた順に関わらず `Object.keys` は昇順になる (node で実測)。
    // 上のテストが `'0123'` を使っているのはそのため。
    const literalOrder = { '5678': { yenPerLiter: 1, kmPerLiter: 2 }, '1234': { yenPerLiter: 3, kmPerLiter: 4 } }
    expect(Object.keys(literalOrder)).toEqual(['1234', '5678'])
  })

  it('★ 並べ直すのは比べるときだけ — 保存する本文は端末が持っていた順のまま', () => {
    const built = input({ fuelRateOverrides: { '0456': { yenPerLiter: 1, kmPerLiter: 2 }, '0123': { yenPerLiter: 3, kmPerLiter: 4 } } })
    expect(Object.keys(built.fuelRateOverrides)).toEqual(['0456', '0123'])
  })

  it('上書きの値が動けば違う (キーの数が同じでも拾う)', () => {
    const a = input({ totals: productionTotals(), fuelRateOverrides: { '1234': { yenPerLiter: 150, kmPerLiter: null } } })
    const b = input({ totals: productionTotals(), fuelRateOverrides: { '1234': { yenPerLiter: 151, kmPerLiter: null } } })
    expect(marginSummaryHashInput(a)).not.toBe(marginSummaryHashInput(b))
  })
})

describe('marginSummaryHistoryLine — 1 行は小さく保つ', () => {
  function snapshot(overrides: Partial<MarginSummarySnapshot> = {}): MarginSummarySnapshot {
    return {
      ...input({ totals: productionTotals() }),
      savedAt: '2026-08-24T10:20:30.000Z',
      ...overrides,
    }
  }

  it('いつ・どの版で・いくらだったかを持つ', () => {
    expect(marginSummaryHistoryLine(snapshot(), true)).toEqual({
      ts: '2026-08-24T10:20:30.000Z',
      changed: true,
      codeVersion: 'v0.0.517',
      ym: '2026-07',
      operations: 91,
      salesYen: 10260265,
      allowanceYen: 2499500,
      marginYen: 4467597,
    })
  })

  it('版が増えなかった回も残す (changed=false)', () => {
    expect(marginSummaryHistoryLine(snapshot(), false).changed).toBe(false)
  })

  it('本文 (operations / costs) は 1 件も入れない', () => {
    const line = JSON.stringify(marginSummaryHistoryLine(snapshot({
      cache: cache({ costs: [{ 巨大: '本文' }] as unknown as MarginCache['costs'] }),
    }), true))
    expect(line).not.toContain('巨大')
    expect(line.length).toBeLessThan(300)
  })

  it('保持行数は検証スナップショットの上限に合わせる (既存の仕組みそのまま)', () => {
    const line = JSON.stringify(marginSummaryHistoryLine(snapshot(), true))
    let text: string | null = null
    for (let i = 0; i < PROFIT_HISTORY_MAX_LINES + 5; i++) text = appendProfitHistoryJsonl(text, line)
    expect(text!.split('\n').filter(l => l !== '')).toHaveLength(PROFIT_HISTORY_MAX_LINES)
  })
})

describe('marginSummarySaveNote — どちらが正かを画面で明示する', () => {
  const result = {
    saved: true,
    changed: true,
    savedAt: '2026-08-24T10:20:30.000Z',
    codeVersion: 'v0.0.517',
    versionKey: 'profit/2026-07/margin-summary/v-20260824T102030.json',
  }

  it('★ 新しい版を残せたら、版の名前を出す (「保存しました」だけにしない)', () => {
    const note = marginSummarySaveNote(result, null)
    expect(note).toContain('新しい版 v-20260824T102030 として保存しました')
    expect(note).toContain('v0.0.517')
    expect(note).toContain('R2 の版で追えます')
  })

  it('★ 内容が同じなら「どの版から変わっていないか」を名前で出す', () => {
    const note = marginSummarySaveNote({ ...result, changed: false }, null)
    expect(note).toContain('前回の版 v-20260824T102030 から変わっていない')
    expect(note).toContain('版は増やしていません')
    expect(note).toContain('R2 の版で追えます')
  })

  it('★ 版キーを持たない古い保存では、空白ではなく言葉で「名前が無い」と出す (Refs #831)', () => {
    const note = marginSummarySaveNote({ ...result, changed: false, versionKey: '' }, null)
    expect(note).toContain(`前回の版 ${MARGIN_VERSION_UNNAMED} から変わっていない`)
    // **穴が空かないこと自体を固定する。** 本番 v0.0.522 は「前回の版 から」と
    // 空いていて、レンダリングの不具合にしか読めなかった。
    expect(note).not.toContain('前回の版 から')
    expect(note).toContain('版は増やしていません')
    expect(note).toContain('R2 の版で追えます')
  })

  it('★ 名前あり ⇄ 名前なし で文言が入れ替わる (どちらか一方を出しっぱなしにしない)', () => {
    const named = marginSummarySaveNote({ ...result, changed: false }, null)
    const unnamed = marginSummarySaveNote({ ...result, changed: false, versionKey: '' }, null)
    expect(named).toContain('v-20260824T102030')
    expect(named).not.toContain(MARGIN_VERSION_UNNAMED)
    expect(unnamed).toContain(MARGIN_VERSION_UNNAMED)
    expect(unnamed).not.toContain('v-20260824T102030')
  })

  it('文言は定数で固定する (画面の文と定数がずれない)', () => {
    expect(MARGIN_VERSION_UNNAMED).toBe('(この機能より前に保存されたため名前がありません)')
  })

  it('★ 残せなかったら黙らない (端末のキャッシュだけだと言う)', () => {
    const note = marginSummarySaveNote(null, '503 PROFIT_R2 binding が未設定です')
    expect(note).toContain('残せませんでした')
    expect(note).toContain('503')
    expect(note).toContain('この端末のキャッシュだけ')
  })

  it('まだ保存していなければ何も出さない', () => {
    expect(marginSummarySaveNote(null, null)).toBe('')
  })

  it('失敗の注記は成功の注記より優先する (両方あっても失敗を出す)', () => {
    expect(marginSummarySaveNote(result, 'timeout')).toContain('残せませんでした')
  })
})
