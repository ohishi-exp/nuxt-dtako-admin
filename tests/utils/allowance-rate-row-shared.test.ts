// **共有 fixture の front 側** (Refs #1017 ④)。相方は
// `workers/dtako-scraper-relay/test/restraint-wage-allowance-rate-shared.test.ts`。
//
// `tests/fixtures/allowance-rate/row-validation.ts` の同じ行を両側へ流し、
// **受理/拒否が一致すること**だけを見る (文言は揃えない — front は文字列 sentinel、
// relay は throw)。片側だけ規則が動いたとき、ここが落ちる。
//
// front 側の `parseRateRow` は export されていないので、**実装は変えずに**
// 公開関数 `resolveAllowanceRateMaster` を 1 行だけの応答で通す。
// `status === 'r2'` が受理、`'error'` が拒否。
import { describe, expect, it } from 'vitest'
import { resolveAllowanceRateMaster } from '~/utils/allowance-rate-source'
import {
  ALLOWANCE_RATE_ROW_CASES,
  SHARED_TEXT_FIELDS,
} from '../fixtures/allowance-rate/row-validation'

/** relay の `handleWageMasterRoute` が返す「在る」応答の形。 */
function getResponse(row: unknown): unknown {
  return { exists: true, data: { rows: [row] }, updated_at: '2026-07-01T00:00:00Z', version: 'sha256:x' }
}

/** front 側の判定を「受理したか」の 1 bit に畳む。 */
function frontAccepts(row: unknown): boolean {
  return resolveAllowanceRateMaster(getResponse(row)).status === 'r2'
}

describe('運行手当マスタ 1 行の検証 — 共有 fixture (front 側)', () => {
  // fixture が空/縮んでいたら for が 0 件でも緑になる。母数を先に固定する。
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
      expect(frontAccepts(testCase.row)).toBe(testCase.accept)
    },
  )
})
