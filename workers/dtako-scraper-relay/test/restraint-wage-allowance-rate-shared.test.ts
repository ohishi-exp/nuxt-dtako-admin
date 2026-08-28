// **共有 fixture の relay 側** (Refs #1017 ④)。相方は
// `tests/utils/allowance-rate-row-shared.test.ts`。
//
// `tests/fixtures/allowance-rate/row-validation.ts` の同じ行を両側へ流し、
// **受理/拒否が一致すること**だけを見る。通知方式の違い (front は文字列 sentinel、
// relay は `WageMasterError` を throw) は 1 bit に畳んで吸収し、**文言は揃えない**。
//
// `tests/fixtures/restraint-wage/` の golden と同じ流儀で、fixture は repo 直下の
// `tests/fixtures/` に置き、worker 側からは相対 path で読む
// (`app/` から `workers/` は import できないため、共有できるのは fixture だけ)。
import { describe, expect, it } from 'vitest'

import { normalizeAllowanceRateMaster } from '../src/restraint-wage'
import {
  ALLOWANCE_RATE_ROW_CASES,
  SHARED_TEXT_FIELDS,
} from '../../../tests/fixtures/allowance-rate/row-validation'

/** relay 側の判定を「受理したか」の 1 bit に畳む。 */
function relayAccepts(row: unknown): boolean {
  try {
    normalizeAllowanceRateMaster({ rows: [row] })
    return true
  } catch {
    return false
  }
}

describe('運行手当マスタ 1 行の検証 — 共有 fixture (relay 側)', () => {
  // fixture が空/縮んでいたら for が 0 件でも緑になる。母数を先に固定する。
  // **front 側の同じ assert と数字を揃えてある** — 片方だけ通る fixture にしない。
  it('fixture は受理・拒否の両方を持ち、7 テキスト列すべてを網羅している', () => {
    expect(SHARED_TEXT_FIELDS).toHaveLength(7)
    expect(ALLOWANCE_RATE_ROW_CASES.filter((c) => c.accept).length).toBe(5)
    expect(ALLOWANCE_RATE_ROW_CASES.filter((c) => !c.accept).length).toBe(27)
    for (const field of SHARED_TEXT_FIELDS) {
      expect(ALLOWANCE_RATE_ROW_CASES.some((c) => c.name === `${field} が欠落`)).toBe(true)
      expect(ALLOWANCE_RATE_ROW_CASES.some((c) => c.name === `${field} が非文字列 (数値)`)).toBe(true)
    }
  })

  it.each(ALLOWANCE_RATE_ROW_CASES.map((c) => [c.name, c] as const))(
    '%s',
    (_name, testCase) => {
      expect(relayAccepts(testCase.row)).toBe(testCase.accept)
    },
  )
})
