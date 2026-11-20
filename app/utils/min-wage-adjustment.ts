/**
 * 年の最低賃金の不足と「就労調整金」による補填を突き合わせる (Refs #1263)。
 *
 * ## なぜ要るか
 *
 * 月ごとには最低賃金に満たない月があっても、その不足を 8 月・12 月の賞与 (年によっては
 * 月例給与) の「就労調整金」でまとめて補う運用がある。単月の最低賃金チェックだけでは
 * 補填と突き合わせられないので、年 (勤務月 1〜12 月) ごとに 不足合計 と 補填合計 を並べる。
 *
 * ## 不足は既存の「差 (給与 − 計算)」の負の部分だけ (新しい最賃計算は作らない)
 *
 * 月の差は期間集計タブと同じ `monthDiff` (= 単月表の `minWageCompareRow` の `diffTotal` と同じ
 * 定義・同じ向き)。**relay の `WageRow.totalPayDiff` は使わない** — あれは「単価マスタ計算 −
 * 最低賃金計算」で実支給を含まない。プラスの月で他の月の不足を相殺しない (補填は就労調整金で
 * 見る、というのが運用の前提なので、不足は不足として足す)。
 *
 * **集計に入らなかった月は 0 ではない** — 未保存・欠測の月は「不足なし」と読めないので
 * `missingMonths` に出し、判定は「12 か月そろっていない」ことが分かる形にする
 * (欠けたまま「補填済み」と言い切らない。親判断 2026-11-20)。
 *
 * ## 補填は「支給日の年」で拾う
 *
 * 賞与は `GET /api/kyuyo/bonus?year=Y` (支給日の年)、月例は `GET /api/kyuyo/payroll` の
 * 支給日の年が Y の行 (= 勤務月 Y-1/12〜Y/11)。どちらも `payments["就労調整金"]`。
 * 給与社員CD → 乗務員CD は月例と同じ対応表 (`resolveCdKey`、1 人 = 複数の給与社員CD の N:1 も
 * そこで畳まれる)。
 */

import type { MinWageRowAttrs } from './restraint-wage-view'
import type { SalaryCdMap, SalaryCsvRow } from './salary-compare'
import { resolveCdKey } from './salary-compare'
import type { WageRangeRow } from './wage-range-view'
import { monthDiff } from './wage-range-view'
import type { KyuyoPayrollRow } from './kyuyo-fetch'
import { payrollToParsedSalary } from './kyuyo-fetch'

/** 補填に使う支給項目の名前 (給与大臣の項目名そのもの)。 */
export const ADJUSTMENT_ITEM_LABEL = '就労調整金'

/** 年の勤務月 (`YYYY-01`〜`YYYY-12`)。 */
export function yearMonths(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
}

/**
 * 支給日の年が `year` になる月例の勤務月 (= 勤務月 `year-1`/12 〜 `year`/11)。
 * 給与は勤務月の翌月に支給される (画面全体の前提) ので、1 か月前へずらした 12 か月。
 */
export function adjustmentWorkMonths(year: number): string[] {
  return [`${year - 1}-12`, ...yearMonths(year).slice(0, 11)]
}

/** 乗務員CD の突合キー (前ゼロを除く)。期間集計と給与の両側をこれで揃える。 */
function driverKey(cd: string): string {
  const n = Number(cd)
  return Number.isFinite(n) ? String(n) : cd
}

/** 1 乗務員 × 1 年の不足。 */
export interface YearShortfall {
  /** 不足額の合計 (正の円)。不足の月が無ければ 0。 */
  shortfall: number
  /** 差がマイナスだった勤務月。 */
  shortfallMonths: string[]
  /** 差が出せた (集計に入った) 月の数。 */
  countedMonths: number
  /** 差が出せなかった勤務月 (未保存・欠測・給与未取込)。0 円の月ではない。 */
  missingMonths: string[]
}

/** 期間集計の 1 行から、その年の不足を数える。 */
export function yearShortfall(row: Pick<WageRangeRow, 'byMonth'>, year: number): YearShortfall {
  const out: YearShortfall = { shortfall: 0, shortfallMonths: [], countedMonths: 0, missingMonths: [] }
  for (const ym of yearMonths(year)) {
    const d = monthDiff(row.byMonth[ym]).total
    if (d == null) {
      out.missingMonths.push(ym)
      continue
    }
    out.countedMonths += 1
    if (d < 0) {
      out.shortfall += -d
      out.shortfallMonths.push(ym)
    }
  }
  return out
}

/** 賞与・月例の行 (`/api/kyuyo/{bonus,payroll}` の `rows[]`)。補填に要るキーだけ。 */
export type AdjustmentSourceRow = Pick<
  KyuyoPayrollRow,
  'employee_code' | 'employee_code_key' | 'employee_name' | 'pay_date' | 'payments'
>

/**
 * 賞与の行を給与比較の行の形へ寄せる。賞与には単価が無いので null で埋めてから
 * 月例と同じ `payrollToParsedSalary` に通す (支給日の壊れた行はそこで落ちる)。
 */
export function bonusToSalaryRows(rows: readonly AdjustmentSourceRow[], company: string): SalaryCsvRow[] {
  return payrollToParsedSalary(
    rows.map(r => ({ ...r, base_rate: null, overtime_rate: null, totals: null })),
    company,
  ).rows
}

/** 1 乗務員の補填 (円)。 */
export interface DriverAdjustment {
  bonus: number
  payroll: number
  /** 給与側の氏名 (期間集計に行が無い人の表示用)。 */
  driverName: string
}

/**
 * 支給日の年が `year` の行から「就労調整金」を乗務員ごとに足す。
 * 同じ (会社, 支給月) を 2 回渡さないのは呼び出し側の責任 (ここでは重複を見分けられない)。
 * 0 円・項目なしの行は数えない。
 */
export function sumAdjustments(
  sources: ReadonlyArray<{ kind: 'bonus' | 'payroll', rows: readonly SalaryCsvRow[] }>,
  cdMap: SalaryCdMap,
  year: number,
): Map<string, DriverAdjustment> {
  const out = new Map<string, DriverAdjustment>()
  const prefix = `${year}-`
  for (const { kind, rows } of sources) {
    for (const row of rows) {
      if (!row.month.startsWith(prefix)) continue
      const amount = row.amounts[ADJUSTMENT_ITEM_LABEL] ?? 0
      if (amount === 0) continue
      const key = driverKey(resolveCdKey(row, cdMap))
      const cur = out.get(key) ?? { bonus: 0, payroll: 0, driverName: row.driverName }
      cur[kind] += amount
      out.set(key, cur)
    }
  }
  return out
}

/** 判定。`unmatched` = 期間集計にこの乗務員の行が無く、不足を数えられない (補填だけ見えている)。 */
export type AdjustmentStatus = 'no-shortfall' | 'covered' | 'short' | 'unmatched'

/**
 * 期間集計に行が無い人の判定。「不足なし」とは書かない — 不足は 0 ではなく**数えられない**。
 * 多いのは給与社員CD が社員マスタで乗務員CD に対応付いていない人 (その場合 CD 欄は給与社員CD)。
 */
const UNMATCHED: AdjustmentJudgement = {
  status: 'unmatched',
  remaining: 0,
  incomplete: true,
  label: '不足を数えられない (期間集計に行が無い — 社員マスタで乗務員CD の対応を確認)',
}

export interface AdjustmentJudgement {
  status: AdjustmentStatus
  /** 補填しきれていない不足額 (`short` のときだけ正、それ以外は 0)。 */
  remaining: number
  /** 12 か月そろっていない (未集計の月がある)。判定はその月を含まない。 */
  incomplete: boolean
  /** 画面に出す 1 文。 */
  label: string
}

/**
 * 不足合計 ≤ 補填合計 なら補填済み、超えれば残りの不足額。
 * **未集計の月がある間は言い切らない** — 文に「N か月未集計」を必ず添える。
 */
export function judgeAdjustment(shortfall: number, adjustment: number, missingMonths: number): AdjustmentJudgement {
  const incomplete = missingMonths > 0
  const suffix = incomplete ? ` (${missingMonths} か月未集計のため確定でない)` : ''
  if (shortfall === 0) {
    return { status: 'no-shortfall', remaining: 0, incomplete, label: `不足なし${suffix}` }
  }
  if (shortfall <= adjustment) {
    return { status: 'covered', remaining: 0, incomplete, label: `補填済み${suffix}` }
  }
  const remaining = shortfall - adjustment
  return { status: 'short', remaining, incomplete, label: `残り不足 ${remaining.toLocaleString('ja-JP')} 円${suffix}` }
}

/** 年の補填の表の 1 行。 */
export interface AdjustmentRow {
  driverCd: string
  driverName: string
  /** 期間集計 (社員マスタ) の属性。期間集計に行が無い人は null (並びは「会社不明」へ)。 */
  attrs: MinWageRowAttrs | null
  /** 期間集計に行が無い人は null (不足を数えられない)。 */
  shortfall: YearShortfall | null
  bonus: number
  payroll: number
  adjustment: number
  judgement: AdjustmentJudgement
}

/**
 * 期間集計の行と補填を乗務員で突き合わせる。
 * 期間集計に居ない人 (補填だけある) も落とさない — 不足は数えられないので 12 か月未集計扱い。
 */
export function buildAdjustmentRows(
  rangeRows: readonly WageRangeRow[],
  adjustments: ReadonlyMap<string, DriverAdjustment>,
  year: number,
): AdjustmentRow[] {
  const rows: AdjustmentRow[] = []
  const seen = new Set<string>()
  for (const r of rangeRows) {
    const key = driverKey(r.driverCd)
    seen.add(key)
    const s = yearShortfall(r, year)
    const adj = adjustments.get(key)
    const bonus = adj?.bonus ?? 0
    const payroll = adj?.payroll ?? 0
    rows.push({
      driverCd: r.driverCd,
      driverName: r.driverName,
      attrs: r.attrs,
      shortfall: s,
      bonus,
      payroll,
      adjustment: bonus + payroll,
      judgement: judgeAdjustment(s.shortfall, bonus + payroll, s.missingMonths.length),
    })
  }
  for (const [key, adj] of adjustments) {
    if (seen.has(key)) continue
    rows.push({
      driverCd: key,
      driverName: adj.driverName,
      attrs: null,
      shortfall: null,
      bonus: adj.bonus,
      payroll: adj.payroll,
      adjustment: adj.bonus + adj.payroll,
      judgement: UNMATCHED,
    })
  }
  return rows
}

/** 「不足または補填がある人」だけに絞る (どちらも 0 の人は見に来る対象でない)。 */
export function hasShortfallOrAdjustment(row: AdjustmentRow): boolean {
  return (row.shortfall?.shortfall ?? 0) > 0 || row.adjustment > 0
}

/** 応答の鮮度 (`source` / `synced_at`)。賞与の保存が入る前の応答には無いので両方 optional。 */
export function describeBonusFreshness(entries: ReadonlyArray<{ company: string, source?: 'cache' | 'live', syncedAt: string | null }>): string {
  const parts = entries
    .filter(e => e.source !== undefined || e.syncedAt !== null)
    .map((e) => {
      const src = e.source === 'cache' ? '保存済み' : e.source === 'live' ? '給与大臣から直接' : ''
      const at = e.syncedAt ? `${src ? ' ' : ''}同期 ${e.syncedAt}` : ''
      return `${e.company}: ${src}${at}`
    })
  return parts.join(' / ')
}
