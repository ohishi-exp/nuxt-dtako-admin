import { describe, it, expect } from 'vitest'

import {
  MARGIN_SUMMARY_SCHEMA_VERSION,
  UNKNOWN_CODE_VERSION,
  buildMarginSummaryInput,
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
import { emptyMarginTotals, type MarginCache, type MarginTotals } from '../../app/utils/margin'
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
    const input = buildMarginSummaryInput({ cache: cache({ ym: '2026-06' }), totals: emptyMarginTotals(), codeVersion: 'v0.0.517' })
    expect(input.ym).toBe('2026-06')
    expect(input.schemaVersion).toBe(MARGIN_SUMMARY_SCHEMA_VERSION)
  })

  it('コード版はここで正規化する', () => {
    expect(buildMarginSummaryInput({ cache: cache(), totals: emptyMarginTotals(), codeVersion: '' }).codeVersion)
      .toBe(UNKNOWN_CODE_VERSION)
    expect(buildMarginSummaryInput({ cache: cache(), totals: emptyMarginTotals(), codeVersion: 'v0.0.517' }).codeVersion)
      .toBe('v0.0.517')
  })

  it('★ 2026-07 の本番値を 1 円も動かさない (合計をそのまま持ち回るだけ)', () => {
    const input = buildMarginSummaryInput({ cache: cache(), totals: productionTotals(), codeVersion: 'v0.0.517' })
    expect(input.totals.operations).toBe(91)
    expect(input.totals.salesYen).toBe(10260265)
    expect(input.totals.allowanceYen).toBe(2499500)
    expect(input.totals.marginYen).toBe(4467597)
  })

  it('MarginCache は形も中身も変えずそのまま入れる', () => {
    const c = cache({ uncovered: { trips: 36, salesYen: 1649681, allowanceYen: 413000 } })
    expect(buildMarginSummaryInput({ cache: c, totals: emptyMarginTotals(), codeVersion: 'v1' }).cache).toEqual(c)
  })
})

describe('marginSummaryHashInput — 差分検知', () => {
  const base = buildMarginSummaryInput({ cache: cache(), totals: productionTotals(), codeVersion: 'v0.0.517' })

  it('保存時刻が違うだけなら同じ (毎回版が増えるのを防ぐ)', () => {
    const later = buildMarginSummaryInput({
      cache: cache({ savedAt: '2026-08-25T09:00:00.000Z' }),
      totals: productionTotals(),
      codeVersion: 'v0.0.517',
    })
    expect(marginSummaryHashInput(later)).toBe(marginSummaryHashInput(base))
  })

  it('コード版が違うだけなら同じ (数字が動いていないのに版を増やさない)', () => {
    const newer = buildMarginSummaryInput({ cache: cache(), totals: productionTotals(), codeVersion: 'v0.0.518' })
    expect(marginSummaryHashInput(newer)).toBe(marginSummaryHashInput(base))
  })

  it('合計が 1 円でも動けば違う', () => {
    const moved = buildMarginSummaryInput({
      cache: cache(),
      totals: { ...productionTotals(), marginYen: 4467598 },
      codeVersion: 'v0.0.517',
    })
    expect(marginSummaryHashInput(moved)).not.toBe(marginSummaryHashInput(base))
  })

  it('キャッシュの中身が変われば違う (合計が同じでも内訳の差を拾う)', () => {
    const moved = buildMarginSummaryInput({
      cache: cache({ uncovered: { trips: 36, salesYen: 1649681, allowanceYen: 413000 } }),
      totals: productionTotals(),
      codeVersion: 'v0.0.517',
    })
    expect(marginSummaryHashInput(moved)).not.toBe(marginSummaryHashInput(base))
  })

  it('月が変われば違う', () => {
    const other = buildMarginSummaryInput({ cache: cache({ ym: '2026-06' }), totals: productionTotals(), codeVersion: 'v0.0.517' })
    expect(marginSummaryHashInput(other)).not.toBe(marginSummaryHashInput(base))
  })

  it('保存時刻はハッシュ対象の文字列に残らない', () => {
    expect(marginSummaryHashInput(base)).not.toContain('2026-08-24T01:23:45.000Z')
  })
})

describe('marginSummaryHistoryLine — 1 行は小さく保つ', () => {
  function snapshot(overrides: Partial<MarginSummarySnapshot> = {}): MarginSummarySnapshot {
    return {
      ...buildMarginSummaryInput({ cache: cache(), totals: productionTotals(), codeVersion: 'v0.0.517' }),
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
