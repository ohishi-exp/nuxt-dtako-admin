/**
 * 社員マスタ (D1、Refs #367) の型・表示ヘルパ。
 *
 * GET /restraint-api/employee-master の応答形は
 * workers/dtako-scraper-relay/src/employee-master.ts の型と同一 — worker から
 * import できない (Nuxt typecheck が worker 全体を厳格検査してしまう罠、Refs
 * #268) ため実装は 2 箇所になるが、ロジックはどちらも worker 側が正。変更する
 * 時は両方に反映すること。
 *
 * 給与比較タブ (`app/pages/restraint-wage.vue`) は、突合ロジック本体
 * (`app/utils/salary-compare.ts` の `compareSalaryMonth`/`suggestCdMapEntries`)
 * を変更せずに社員マスタを消費するため、`buildCdMapEntries` で従来の
 * `SalaryCdMap` 形へ変換して橋渡しする。
 */
import type { SalaryCdMap, SalaryCsvRow } from './salary-compare'
import { salaryCdMapKey } from './salary-compare'

export interface EmployeeAttrRow {
  effectiveFrom: string
  branch: string | null
  payScheme: string | null
}

export interface EmployeeMasterEntry {
  company: string
  payrollCd: string
  name: string
  driverCd: string | null
  attrs: EmployeeAttrRow[]
}

export interface EmployeeMasterGetResponse {
  employees: EmployeeMasterEntry[]
  migratable: boolean
}

const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/

/** "YYYY-MM" の末日を "YYYY-MM-DD" で返す。不正な形式は null。 */
function lastDayOfMonth(yearMonth: string): string | null {
  const m = YEAR_MONTH_RE.exec(yearMonth)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${m[1]}-${m[2]}-${String(day).padStart(2, '0')}`
}

/**
 * 対象月 (`yearMonth`, "YYYY-MM") の末日時点で `entry` に効いている属性行を
 * 解決する。worker 側 employee-master.ts の `resolveAttrsAt` と同一ロジック
 * (「対象月の末日時点で効いている値」、Refs #367)。`effectiveFrom` が月末以下の
 * 行のうち最新のものを返す。無ければ (全て月末より後、attrs が空、yearMonth が
 * 不正な形式) null。
 */
export function resolveAttrsAt(entry: EmployeeMasterEntry, yearMonth: string): EmployeeAttrRow | null {
  const monthEnd = lastDayOfMonth(yearMonth)
  if (!monthEnd) return null
  let resolved: EmployeeAttrRow | null = null
  for (const a of entry.attrs) {
    if (a.effectiveFrom > monthEnd) continue
    if (!resolved || a.effectiveFrom > resolved.effectiveFrom) resolved = a
  }
  return resolved
}

/**
 * 社員マスタを `SalaryCdMap` 形 (salary-compare.ts の突合ロジックが読む形) へ
 * 変換する。`driverCd` が未設定 (null) の行は突合キーとして使えないため除外する。
 */
export function buildCdMapEntries(employees: EmployeeMasterEntry[]): SalaryCdMap {
  const entries: Record<string, string> = {}
  for (const e of employees) {
    if (!e.driverCd) continue
    entries[salaryCdMapKey(e.payrollCd, e.name, e.company)] = e.driverCd
  }
  return { entries }
}

/**
 * `salaryCdMapKey` が組み立てたキー ("会社|給与コード|氏名" または旧形式
 * "給与コード|氏名") を表示用に分解する。氏名に `|` を含む場合を考慮し、
 * 3部以上は company を先頭 1 要素、残りを氏名として結合し直す。
 */
export function splitCdMapKey(key: string): { company: string, payrollCd: string, name: string } {
  const parts = key.split('|')
  if (parts.length >= 3) {
    return { company: parts[0]!, payrollCd: parts[1]!, name: parts.slice(2).join('|') }
  }
  // String#split は常に length >= 1 の配列を返す (空文字でも ['']) ので parts[0] は必ず存在する
  return { company: '', payrollCd: parts[0]!, name: parts[1] ?? '' }
}

/**
 * 給与明細 CSV の行のうち、社員マスタに (company, payrollCd) の組がまだ存在
 * しない = 一度もマスタへ登録されたことがない行を、一意な組ごとに列挙する
 * (「取り込み後『未登録 N 名をマスタへ登録』」ボタン用、Refs #367)。
 *
 * 乗務員CDへの突合有無は問わない — CSV に新しい社員が現れたら (突合できて
 * いなくても) まず識別情報だけマスタへ記録し、突合は別途「社員コード突合
 * マスタ」カードで行う想定。登録は company・payrollCd・name のみ送信し、金額
 * (amounts 等) は一切送らない。
 *
 * `company` が未設定 (空文字、取り込み時に会社名を入力していない CSV) の行は
 * 除外する — D1 社員マスタの PK は (company, payrollCd) で company は非空必須
 * (worker 側 employee-master.ts の検証)。空文字のまま登録すると会社を跨いだ
 * 給与コード衝突対策 (Refs #364-366) が効かなくなるため、ここで弾いて先に
 * 「会社名」入力 (CSV 取り込みカードの会社名欄) を促す。
 */
export function findUnregistered(
  csvRows: SalaryCsvRow[],
  employees: EmployeeMasterEntry[],
): Array<{ company: string, payrollCd: string, name: string }> {
  const known = new Set(employees.map(e => `${e.company}|${e.payrollCd}`))
  const seen = new Set<string>()
  const out: Array<{ company: string, payrollCd: string, name: string }> = []
  for (const row of csvRows) {
    if (!row.company) continue
    const key = `${row.company}|${row.cdKey}`
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push({ company: row.company, payrollCd: row.cdKey, name: row.driverName })
  }
  return out
}
