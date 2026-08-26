// 共有 fixture golden テスト (Refs #268、org 方針: local-first-testing skill)
//
// tests/fixtures/restraint-wage/ の入力 (拘束サマリ・単価マスタ・最低賃金マスタ) を
// 本物の computeWageRow に通し、golden/wage-rows.json と全件突合する。期待値は
// 手計算しない — 意図したロジック変更のときは (この worker ディレクトリで)
//   UPDATE_GOLDEN=1 npx vitest run test/restraint-wage-golden.test.ts
// で golden を再生成し、diff を PR でレビューする。
//
// 同じ fixture は「給与比較」側のテストとローカル seed (`npm run seed:local`、
// PR-C/PR-D 予定) も共有する — 入力を別管理にしない (docs/plan-268-wage-tab-separation.md)。
import { describe, expect, it } from 'vitest'
import {
  computeWageRow,
  DEFAULT_WAGE_CONFIG,
  normalizeMinWageMaster,
  normalizeWageMaster,
} from '../src/restraint-wage'
import type { RestraintDriverSummary } from '../src/theearth-restraint-client'
import rawSummaries from '../../../tests/fixtures/restraint-wage/summaries.json'
import rawWageMaster from '../../../tests/fixtures/restraint-wage/wage-master.json'
import rawMinWageMaster from '../../../tests/fixtures/restraint-wage/min-wage-master.json'
import golden from '../../../tests/fixtures/restraint-wage/golden/wage-rows.json'

// fixture の対象年月 (2026-07 の平日 20 日で設計されている)。
const YEAR = 2026
const MONTH = 7

// tsconfig は @cloudflare/workers-types のみ (node 型を足すと workers 型と衝突
// する) ため、golden 再生成に使う node:fs は非リテラル指定子の動的 import で
// 型解決を回避する。vitest は node 環境で走るので実行時は素の import になる。
const UPDATE_GOLDEN = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN,
)

describe('restraint-wage golden (共有 fixture)', () => {
  // マスタ fixture は R2 に PUT するのと同じ経路の validator を通す (形式が
  // 本番で通らない fixture を golden の入力にしない)。
  const wageMaster = normalizeWageMaster(rawWageMaster)
  const minWageMaster = normalizeMinWageMaster(rawMinWageMaster)
  const summaries = rawSummaries as unknown as RestraintDriverSummary[]

  const rows = summaries.map(summary => ({
    driverCd: summary.driverCd,
    wage: computeWageRow(summary, YEAR, MONTH, wageMaster, minWageMaster, DEFAULT_WAGE_CONFIG),
  }))

  if (UPDATE_GOLDEN) {
    it('golden を再生成した (UPDATE_GOLDEN)', async () => {
      const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as {
        writeFileSync: (path: string, data: string) => void
      }
      // vitest の cwd = workers/dtako-scraper-relay 前提の相対パス。
      fs.writeFileSync(
        '../../tests/fixtures/restraint-wage/golden/wage-rows.json',
        `${JSON.stringify(rows, null, 2)}\n`,
      )
      expect(rows.length).toBeGreaterThan(0)
    })
    return
  }

  it('4 乗務員 (正常 / 時給割れ / 月60h超 / 単価未設定) を網羅している', () => {
    expect(summaries.map(s => s.driverCd)).toEqual(['9901', '9902', '9903', '9904'])
  })

  it('computeWageRow の出力が golden と全件一致する', () => {
    expect(rows).toEqual(golden)
  })

  it('シナリオの意図が成り立っている (golden の腐り検知)', () => {
    const byCd = Object.fromEntries(rows.map(r => [r.driverCd, r.wage]))
    // 9901: 正常 — 総支給時給も残業代も最低賃金水準以上
    expect(byCd['9901']!.minWageDiff).toBeGreaterThanOrEqual(0)
    expect(byCd['9901']!.overtimePayDiff).toBeGreaterThanOrEqual(0)
    // 9902: 時給 900 円 < 最低賃金 956 円
    expect(byCd['9902']!.minWageDiff).toBeLessThan(0)
    // 9903: 月60h超 (100h)。**単価マスタ側にも 60h 超の 1.5 倍が入った** (Refs #670) ので、
    // 60h まで 1.25 / 超過 40h を 1.5 で計算する。係数一定に戻したらこの等式が落ちる。
    expect(byCd['9903']!.overtimeMinutes).toBe(100 * 60)
    expect(byCd['9903']!.nightOvertimeMinutes).toBe(0)
    expect(byCd['9903']!.actualOvertimePay).toBe(Math.round(60 * 960 * 1.25 + 40 * 960 * 1.5))
    // 以前はここが「基礎単価 (960) の方が最低賃金 (956) より高いのに残業代が下回る」
    // という逆転になっていた (単価マスタ側だけ一律 1.25 だったため、diff は −9,060)。
    // 両側が同じ 60h ルールになったので、差は基礎単価の差 (960 − 956) だけが残る。
    expect(byCd['9903']!.overtimePayDiff).toBeGreaterThanOrEqual(0)
    // 9904: 単価マスタ未登録 — 金額系は null、時間分類と最低賃金換算は出る
    expect(byCd['9904']!.hourlyRate).toBeNull()
    expect(byCd['9904']!.amounts).toBeNull()
    expect(byCd['9904']!.minWageTotalPay).not.toBeNull()
  })
})
