/**
 * 給与DB取得 (/kyuyo-fetch) の純粋ロジック (Refs #369)。
 *
 * - 会社 (複数) × 月範囲 (from〜to) の取得プラン展開
 * - 取得結果 / サーバー同期状態の表示用整形
 *
 * fetch はページ側の責務 — ここは判定と変換のみ。
 *
 * ## sessionStorage の明細キャッシュは廃止した (Refs #467 PR-A3)
 *
 * 氏名と金額を含む明細をブラウザに平文で置かないため (#367 の方針と揃える)。
 * 鮮度の正は **サーバー側の給与アーカイブ** (`GET /api/kyuyo/synced-months` /
 * `payroll` 応答の `synced_at`) 1 か所だけになった。
 *
 * **同時に 1 件の欠陥が消えた** (Refs #934): 2 画面が同じ `kyuyo-payroll:{会社}:{月}`
 * キーを**違う意味の「月」**で使っていた — `/kyuyo-fetch` は勤務月、`/restraint-wage` は
 * 支給月 (`nextYm(勤務月)`) で書いていたため、`/kyuyo-fetch` で勤務月 N を取ると
 * `/restraint-wage` の勤務月 N-1 に命中し、**1 か月ずれた明細が給与比較・最低賃金
 * チェックに載った**。キー生成関数ごと消したので構造的に再発しない。
 */
import type { ParsedSalaryCsv, SalaryCsvRow } from './salary-compare'

/** 月範囲の上限 (会社数と掛け算になるため控えめに)。 */
export const MAX_RANGE_MONTHS = 12

/** "YYYY-MM" 同士の from〜to を月の配列に展開する。 */
export function expandMonthRange(
  from: string,
  to: string,
  maxMonths: number = MAX_RANGE_MONTHS,
): { months: string[] } | { error: string } {
  const parse = (s: string): number | null => {
    const matched = /^(\d{4})-(\d{2})$/.exec(s)
    if (!matched) return null
    const month = Number(matched[2])
    if (month < 1 || month > 12) return null
    return Number(matched[1]) * 12 + (month - 1)
  }
  const start = parse(from)
  const end = parse(to)
  if (start == null || end == null) return { error: '月は YYYY-MM で指定してください' }
  if (start > end) return { error: '開始月が終了月より後になっています' }
  if (end - start + 1 > maxMonths) return { error: `一度に取得できるのは ${maxMonths} ヶ月までです` }
  const months: string[] = []
  for (let index = start; index <= end; index++) {
    const year = Math.floor(index / 12)
    const month = (index % 12) + 1
    months.push(`${year}-${String(month).padStart(2, '0')}`)
  }
  return { months }
}

/** 会社×月の取得プラン (会社ごとに月昇順)。 */
export function buildFetchPlan(
  companies: string[],
  months: string[],
): { company: string, month: string }[] {
  return companies.flatMap(company => months.map(month => ({ company, month })))
}

// ── 取得結果の保持形 ─────────────────────────────────────────

/**
 * 画面が**メモリ上に**持つ 1 件 (会社×月)。rows は payroll 応答そのまま。
 * **ブラウザには保存しない** — リロードすれば消える (Refs #467 PR-A3)。
 */
export interface StoredPayroll {
  database: string
  rowCount: number
  warningCount: number
  rows: unknown[]
  warnings: string[]
  /**
   * upstream がこの応答をどこから返したか (Refs #467)。
   *
   * - `cache` — rust-ichibanboshi の derived store から (給与大臣 PC に触っていない)
   * - `live` — 給与大臣 DB を実際に読んだ
   *
   * **旧版 upstream では `undefined`** (判らない、の意味)。
   */
  source?: 'cache' | 'live'
  /**
   * **サーバ側でこの会社×月を最後に同期した時刻** (RFC3339)。ブラウザの受信時刻と違い
   * ブラウザを跨いで意味を持つ — 賃金スナップショットの鮮度判定はこちらを使う
   * (ohishi-exp/nuxt-dtako-admin#677)。取れなければ `null`。
   */
  syncedAt?: string | null
}

/** payroll 応答 → 画面が持つ形。応答形式が想定外なら null。 */
export function toStoredPayroll(body: unknown): StoredPayroll | null {
  const rows = (body as { rows?: unknown } | null)?.rows
  const database = (body as { database?: unknown } | null)?.database
  if (!Array.isArray(rows) || typeof database !== 'string') return null
  const warningsRaw = (body as { warnings?: unknown }).warnings
  const warnings = Array.isArray(warningsRaw)
    ? warningsRaw.filter((w): w is string => typeof w === 'string')
    : []
  // `source` / `synced_at` は upstream が返しているのにここで捨てていた (Refs #467)。
  // **形が想定外でも取り込み自体は失敗させない** — 明細が読めることの方が大事で、
  // 判らない時は「判らない」(undefined / null) として持つ
  const sourceRaw = (body as { source?: unknown }).source
  const source = sourceRaw === 'cache' || sourceRaw === 'live' ? sourceRaw : undefined
  const syncedRaw = (body as { synced_at?: unknown }).synced_at
  const syncedAt = typeof syncedRaw === 'string' && syncedRaw !== '' ? syncedRaw : null
  return {
    database,
    rowCount: rows.length,
    warningCount: warnings.length,
    rows,
    warnings,
    ...(source === undefined ? {} : { source }),
    syncedAt,
  }
}

// ── サーバー同期済み一覧 (Refs #467 PR-A3) ───────────────────

/** `GET /api/kyuyo/synced-months` の 1 件 (rust-ichibanboshi `SyncedMonthEntry`)。 */
export interface SyncedMonthEntry {
  company: string
  /** **勤務月** ("YYYY-MM")。payroll API の `month` と同じ基準 (支給月ではない)。 */
  month: string
  synced_at: string
  row_count: number
}

/** サーバー同期済み一覧の表示行 (会社 → 月 の昇順)。 */
export interface SyncedMonthRow {
  company: string
  month: string
  rowCount: number
  syncedAt: string
}

/**
 * `synced-months` 応答 → 表示行 (会社 → 月 の昇順)。
 *
 * 旧 `summarizeStored` (sessionStorage 由来) の置き換え (Refs #467 PR-A3)。
 * **形が想定外の行は黙って落とす** — 一覧が出ないより、読める行だけでも出す方が良い。
 */
export function summarizeSyncedMonths(entries: unknown): SyncedMonthRow[] {
  const list = Array.isArray(entries) ? entries : []
  return list
    .flatMap((raw) => {
      const e = raw as Partial<SyncedMonthEntry> | null
      if (typeof e?.company !== 'string' || typeof e?.month !== 'string') return []
      return [{
        company: e.company,
        month: e.month,
        rowCount: typeof e.row_count === 'number' ? e.row_count : 0,
        syncedAt: typeof e.synced_at === 'string' ? e.synced_at : '',
      }]
    })
    .sort((a, b) => a.company.localeCompare(b.company) || a.month.localeCompare(b.month))
}

/**
 * 同期の出どころ・時刻を 1 行で表す (Refs #467)。
 *
 * 「サーバーには保存しません」という旧来の案内が実態と合っていない
 * (rust-ichibanboshi は derived store に持っていて、sync 済みなら 3 社 169 行が 1.4 秒で返る)。
 * **どこから来た値をいつ同期したのか**を画面に出して、取り込みボタンを押すべきかを
 * 読み手が判断できるようにする。
 *
 * 判らないもの (旧版 upstream / 古い保存) は黙って埋めず `-`。
 */
export function fmtPayrollSync(entry: { source?: 'cache' | 'live', syncedAt?: string | null }): string {
  const label = entry.source === 'cache'
    ? 'サーバー保存'
    : entry.source === 'live'
      ? '給与大臣から取得'
      : ''
  if (!entry.syncedAt) return label || '-'
  const d = new Date(entry.syncedAt)
  if (Number.isNaN(d.getTime())) return label || '-'
  const ts = d.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  return label ? `${ts} (${label})` : ts
}

// ── 給与比較への橋渡し (Refs #369 PR-B2) ─────────────────────

/**
 * `/api/kyuyo/payroll` の 1 行 (rust-ichibanboshi#94 以降)。
 *
 * **`payments` と `deductions` は分かれている** — 以前の `amounts` は支給と控除が
 * 混在しており、そのまま給与比較へ流すと健康保険料・所得税が支給項目として
 * 集計され支給合計が過大になった (Refs rust-ichibanboshi#93)。
 */
export interface KyuyoPayrollRow {
  /** 社員番号 (原文、前ゼロあり)。 */
  employee_code: string
  /** 前ゼロ除去済みの突合キー。 */
  employee_code_key: string
  employee_name: string
  /** 支給日 ("YYYY-MM-DD")。給与明細 CSV の「給与・賞与名」の年月に相当する。 */
  pay_date: string
  /** **支給**項目名 → 金額 (円)。 */
  payments: Record<string, number>
  /**
   * **勤怠**項目名 → 値 (出勤日数・公休日数・有休日数・欠勤日数・残業時間 等、
   * rust-ichibanboshi#104)。単位は項目ごとに違う (日 / 時間 / 回)。
   *
   * **optional** — この項目を返さない版の rust-ichibanboshi が動いている環境でも
   * 取り込みを成功させるため (デプロイ順に依存しない)。
   */
  attendance?: Record<string, number>
  /** 基本単価 (日額)。取れなければ null。 */
  base_rate: number | null
  /** 残業単価 (時給)。取れなければ null。 */
  overtime_rate: number | null
  /** `SHUKEI1` の計算済み合計。無い月は null。 */
  totals: { soshikyu: number } | null
}

const PAY_DATE_RE = /^(\d{4})-(\d{2})-\d{2}$/

/**
 * 給与DB の取得結果を給与比較の `ParsedSalaryCsv` 形へ変換する (Refs #369 PR-B2)。
 *
 * 貼り付け CSV と同じ形に寄せることで、突合・比較計算 (`compareSalaryMonth`) を
 * 一切変更せずに DB 由来のデータを流せる。
 *
 * - **`company` は給与大臣の会社コード** — 社員マスタの突合キーと同じ体系
 *   (Refs #405。CONAME1 は表記揺れするうえ payroll 応答に無い)
 * - **月は `pay_date` から採る** (支給月)。給与比較は「勤務月の翌月に支給」で
 *   突合するため、賃金期間ではなく支給日が正しい
 * - **控除は載せない** — API が `payments` / `deductions` を分けているので支給だけ使う
 * - 支給項目が 1 つも無い行 (全額 0 等) と `pay_date` が壊れた行は落として warning
 */
export function payrollToParsedSalary(
  rows: KyuyoPayrollRow[],
  company: string,
): ParsedSalaryCsv {
  const warnings: string[] = []
  const itemLabels: string[] = []
  const seenLabel = new Set<string>()
  const months = new Set<string>()
  const out: SalaryCsvRow[] = []

  for (const row of rows) {
    const matched = PAY_DATE_RE.exec(row.pay_date)
    if (!matched) {
      warnings.push(`社員 ${row.employee_code}: 支給日が不正なため除外しました (${row.pay_date || '空'})`)
      continue
    }
    const month = `${matched[1]}-${matched[2]}`
    const amounts: Record<string, number> = {}
    for (const [label, amount] of Object.entries(row.payments)) {
      amounts[label] = amount
      if (!seenLabel.has(label)) {
        seenLabel.add(label)
        itemLabels.push(label)
      }
    }
    months.add(month)
    out.push({
      driverCd: row.employee_code,
      cdKey: row.employee_code_key,
      company,
      driverName: row.employee_name,
      month,
      amounts,
      reportedTotal: row.totals?.soshikyu ?? null,
      rates: { base: row.base_rate, overtime: row.overtime_rate },
      // 勤怠日数 (`KINDATA*` 由来、rust-ichibanboshi#104)。項目名は給与明細の
      // 【勤怠】欄の見出しと同じなので、貼り付け CSV 経路と同じキーで引ける。
      // 返さない版の API でも空で通す (Refs #433)
      attendance: row.attendance ?? {},
    })
  }

  return { rows: out, itemLabels, months: [...months].sort(), warnings }
}
