/**
 * 賃金確定値の月次スナップショットを組む (Refs #677、PR-D)。
 *
 * 最低賃金チェックの右端 3 ブロック (計算 / 給与 / 差 × 基本給 / 残業代 / 合計) が
 * 確定した時点で、その**画面表示の写し**を
 * `POST /api/kyuyo/wage-snapshot` (ohishi-exp/rust-ichibanboshi#292) へ送る。
 * 期間集計タブはこの保存を合算するだけで済む (単月あたり 15〜64 秒の再計算が要らない)。
 *
 * ここには**組み立てだけ**を置く。送信と「いつ送るか」の判断は画面 (`restraint-wage.vue`)。
 *
 * ## 差は送らない
 *
 * `paid - calc` はサーバも持たない。単月表の `minWageCompareRow` と定義を 1 箇所に
 * 保つため、送るのは 計算 / 給与 の素の値だけ。
 *
 * ## 最低賃金マスタの版は持たない (2026-08-05 に廃止)
 *
 * 保存する 9 数値は**単価マスタ・拘束時間・支給項目区分**で決まり、最低賃金は 1 円も
 * 動かさない (割れているかの判定に使うだけ)。影響しないものを鮮度メタに入れたせいで、
 * 「最低賃金カードを開かないと版が付かない」という **UI の折りたたみ状態への依存**が
 * 生まれていた。
 *
 * ## 版 (sha) は「変わったか」だけ判れば良い
 *
 * 単価マスタ・支給項目区分が動いた月を「要再計算」にするための材料なので、
 * 暗号学的強度は要らない。**キー順に依存しない安定した文字列**にしてから
 * FNV-1a で畳む — `JSON.stringify` そのままだとキーの並びが変わっただけで
 * 別物と判定され、全月が無意味に stale になる。
 */

import type { MinWageRowAttrs, WageMaster } from './restraint-wage-view'
import type { SalaryItemConfig } from './salary-compare'

/**
 * 賃金計算ロジックの版。**計算の意味が変わる修正を入れたら必ず上げる。**
 *
 * 上げると全月のスナップショットが「要再計算」になり、期間集計から古い計算式の
 * 値が消える。#673 (計算列の残業代が 5 区分を取りこぼしていた) のような修正が
 * これに当たる。表示の見た目だけを変えた時は上げない。
 *
 * 命名は `wage-<YYYYMMDD><連番>`。
 */
export const WAGE_LOGIC_VERSION = 'wage-2026082601'

/** 画面が持っている 1 行ぶんの材料 (最低賃金チェックの表 1 行に対応)。 */
export interface SnapshotSourceRow {
  driverCd: string
  driverName: string
  /** その月に適用された基礎単価。未設定なら null。 */
  hourlyRate: number | null
  calcBase: number | null
  calcOvertime: number | null
  calcTotal: number | null
  paidBase: number | null
  paidOvertime: number | null
  workingMinutes: number | null
  /** 拘束ソースにこの乗務員 × この月の行が無かった (0 分ではない)。 */
  restraintMissing: boolean
  /** 社員マスタ由来の属性 (会社・営業所・職種)。引けなければ null。 */
  attrs: MinWageRowAttrs | null
  /** 給与区分 (1=月給 2=日給 3=時給 4=その他)。 */
  payKubun: number | null
}

/** POST body の 1 行 (サーバの `WageSnapshotRow` と同型)。 */
export interface SnapshotPayloadRow {
  driver_cd: number
  driver_name: string
  company: string | null
  branch_name: string | null
  branch_code: number | null
  job_name: string | null
  pay_kubun: number | null
  hourly_rate: number | null
  calc_base: number | null
  calc_overtime: number | null
  calc_total: number | null
  paid_base: number | null
  paid_overtime: number | null
  working_minutes: number | null
  restraint_missing: boolean
}

/** POST body 全体。 */
export interface SnapshotPayload {
  comp_id: string
  month: string
  restraint_source: string
  wage_logic_version: string
  masters: {
    salary_item_sha: string
    payroll_synced_at: string | null
  }
  rows: SnapshotPayloadRow[]
}

/**
 * キー順に依存しない JSON 文字列。オブジェクトのキーを再帰的に並べ替える。
 * 配列の順序は**意味があるので保つ** (単価履歴は適用開始日順)。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    // キーは一意なので「等しい」枝は存在しない (三項を 2 分岐に保つ)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/**
 * 内容ハッシュ (FNV-1a 32bit、8 桁 hex)。**変更検知専用** — 秘密も署名も守らない。
 * Web Crypto の SHA-256 を使わないのは、同期関数の方がテストしやすく、
 * 用途 (「前と違うか」) に強度が要らないため。
 */
export function contentHash(value: unknown): string {
  const s = stableStringify(value)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // FNV prime 16777619 を シフト加算で (32bit を超えないように Math.imul)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 乗務員CD を数値キーにする (前ゼロ除去)。数値にならなければ null。 */
export function driverCdNumber(driverCd: string): number | null {
  const n = Number(driverCd)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

/**
 * 保存 payload を組む。
 *
 * - **乗務員CD が数値にならない行は落とす** (サーバの主キーが `BIGINT`)。落ちた数は
 *   戻り値の `skipped` で分かるようにし、黙って減らさない
 * - **金額は整数に丸める** (円未満は保存しない。表示も円単位)
 * - 欠測・単価未設定・給与に無い行も**そのまま送る** — 集計から外すかはサーバの
 *   規則 (`row_counts`) が決める。ここで落とすと「その月にその人が居なかった」と
 *   区別が付かなくなる
 */
export function buildSnapshotPayload(input: {
  compId: string
  month: string
  restraintSource: string
  rows: SnapshotSourceRow[]
  salaryItemConfig: SalaryItemConfig
  payrollSyncedAt: string | null
}): { payload: SnapshotPayload, skipped: string[] } {
  const skipped: string[] = []
  const rows: SnapshotPayloadRow[] = []
  const seen = new Set<number>()
  for (const r of input.rows) {
    const cd = driverCdNumber(r.driverCd)
    if (cd === null || seen.has(cd)) {
      skipped.push(r.driverCd)
      continue
    }
    seen.add(cd)
    rows.push({
      driver_cd: cd,
      driver_name: r.driverName,
      company: r.attrs?.company ?? null,
      branch_name: r.attrs?.branchName ?? null,
      branch_code: r.attrs?.branchCode ?? null,
      job_name: r.attrs?.jobName ?? null,
      pay_kubun: r.payKubun,
      hourly_rate: intOrNull(r.hourlyRate),
      calc_base: intOrNull(r.calcBase),
      calc_overtime: intOrNull(r.calcOvertime),
      calc_total: intOrNull(r.calcTotal),
      paid_base: intOrNull(r.paidBase),
      paid_overtime: intOrNull(r.paidOvertime),
      working_minutes: intOrNull(r.workingMinutes),
      restraint_missing: r.restraintMissing,
    })
  }
  return {
    payload: {
      comp_id: input.compId,
      month: input.month,
      restraint_source: input.restraintSource,
      wage_logic_version: WAGE_LOGIC_VERSION,
      masters: {
        salary_item_sha: contentHash(input.salaryItemConfig),
        payroll_synced_at: input.payrollSyncedAt,
      },
      rows,
    },
    skipped,
  }
}

function intOrNull(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(v) ? null : Math.round(v)
}

/**
 * 単価マスタから「その月に適用される単価」を引く (`rateForMonth` の画面版)。
 *
 * 保存する `hourly_rate` は**その月に実際に使われた単価**でなければ意味がない
 * (期間集計が行単位で「要再計算」を判定する材料になる)。`wage-report` の応答は
 * 既にこの単価で計算されているので、行から取れる場合はそちらを優先すること —
 * これは取れなかった時の後詰め。
 */
export function rateForMonthFromMaster(
  master: WageMaster,
  driverCd: string,
  ym: string,
): number | null {
  const rates = master.drivers[driverCd]?.rates ?? []
  let picked: number | null = null
  for (const r of rates) {
    // effectiveFrom は "YYYY-MM-DD"。月頭比較なので "YYYY-MM" で切って比べる
    if (r.effectiveFrom.slice(0, 7) <= ym) picked = r.hourlyRate
  }
  return picked
}
