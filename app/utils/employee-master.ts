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
import { compareCompanyLabel, normalizeNameKey, salaryCdMapKey } from './salary-compare'

export interface EmployeeAttrRow {
  effectiveFrom: string
  /** 所属の表示名 (`SHOZOKU.SNAME` = `本社　乗務員`)。 */
  branch: string | null
  payScheme: string | null
  /** 所属コード (`SHOZOKU.INCODE`)。**並べ替えの基準** (Refs #409)。
   * migration 0010 以前に取り込んだ行は null。 */
  branchCode: number | null
  /** 営業所名 (`SHOZOKU.NAME1`)。拠点 = 最低賃金を引く単位。 */
  branchName: string | null
  /** 職種名 (`SHOZOKU.NAME2`)。 */
  jobName: string | null
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
}

/** PUT の `attrs` 要素 (属性行 + 所属先の社員キー)。 */
export interface EmployeeAttrPutRow extends EmployeeAttrRow {
  company: string
  payrollCd: string
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

// ---------------------------------------------------------------------------
// 社員マスタタブ (一覧・属性履歴の編集、Refs #367 PR-C)
// ---------------------------------------------------------------------------

/**
 * 属性履歴に 1 行を追加する (同じ `effectiveFrom` の行があれば置換)。
 * 返り値は `effectiveFrom` 昇順の新しい配列 — 元配列は変更しない
 * (Vue の ref に代入して差し替える前提)。
 */
export function upsertAttrRow(attrs: EmployeeAttrRow[], row: EmployeeAttrRow): EmployeeAttrRow[] {
  const next = attrs.filter(a => a.effectiveFrom !== row.effectiveFrom)
  next.push(row)
  next.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  return next
}

/** 属性履歴から `effectiveFrom` の行を除いた新しい配列を返す。 */
export function removeAttrRow(attrs: EmployeeAttrRow[], effectiveFrom: string): EmployeeAttrRow[] {
  return attrs.filter(a => a.effectiveFrom !== effectiveFrom)
}

/**
 * 全社員の属性履歴を PUT の `attrs` 形 (社員キー込みの平坦な配列) に展開する。
 * PUT は upsert (last-write-wins) なので全件送っても冪等 (Refs #367)。
 */
export function collectAttrRows(employees: EmployeeMasterEntry[]): EmployeeAttrPutRow[] {
  return employees.flatMap(e =>
    e.attrs.map(a => ({ company: e.company, payrollCd: e.payrollCd, ...a })))
}

/**
 * 乗務員CD の突合キー。マスタ側は保存時に前ゼロ除去済み (`String(Number(cd))`)
 * だが、wage-report の `summary.driverCd` は theearth 由来の原文なので、両者を
 * 同じ規則へ寄せてから引き当てる。数字でない値はそのまま返す (fail-soft)。
 */
export function normalizeDriverCdKey(driverCd: string): string {
  const trimmed = driverCd.trim()
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed
}

/** 1 人 (乗務員CD = 一番星社員C) に紐づく 1 会社ぶんの属性。 */
export interface DriverAttrEntry {
  /** 給与会社ラベル。 */
  company: string
  attrs: EmployeeAttrRow
}

/**
 * 乗務員CD → 対象月末時点の属性 (所属・給与体系) の逆引き表を作る
 * (月次集計 CSV の `所属(マスタ)`・`給与体系` 列用、Refs #367)。
 *
 * `driverCd` 未突合の社員と、対象月末時点で有効な属性行が無い社員は表に載せない
 * (= CSV 側は空欄)。
 *
 * **1 つの乗務員CD に複数会社の行が紐づくのは異常ではなく事実** — 同一人物が
 * 複数の給与会社から支給される運用が実在する (Refs #403、本番実測で 5 件)。
 * 以前は先勝ちで 1 件に潰していたが、渡される配列順が D1 の `SELECT` 順
 * (`ORDER BY` なし) なのでどの会社の値が残るか不定だった。**会社ラベル昇順の
 * 配列を返して呼び出し側に全部渡す**ことで、不定性を消しつつ情報も捨てない。
 */
export function buildDriverAttrIndex(
  employees: EmployeeMasterEntry[],
  yearMonth: string,
): Map<string, DriverAttrEntry[]> {
  const index = new Map<string, DriverAttrEntry[]>()
  for (const e of employees) {
    if (!e.driverCd) continue
    const resolved = resolveAttrsAt(e, yearMonth)
    if (!resolved) continue
    const key = normalizeDriverCdKey(e.driverCd)
    const list = index.get(key) ?? []
    list.push({ company: e.company, attrs: resolved })
    index.set(key, list)
  }
  for (const list of index.values()) list.sort((a, b) => compareCompanyLabel(a.company, b.company))
  return index
}

/**
 * 月次集計 CSV の 1 セル用に属性を連結する (`所属(マスタ)`・`給与体系`、Refs #403)。
 *
 * 複数会社に在籍する人は `本社 乗務員 / 帯広 乗務員` のように並べる。**同値は
 * 1 つに畳む**ので、会社が違っても所属が同じなら従来と同じ 1 値になる。
 * 該当なし・値が全て未設定なら空文字 (CSV 側は空欄)。
 */
export function joinDriverAttr(
  entries: DriverAttrEntry[] | undefined,
  field: 'branch' | 'payScheme',
): string {
  if (!entries) return ''
  const values = entries.map(e => e.attrs[field]).filter((v): v is string => v !== null && v !== '')
  return [...new Set(values)].join(' / ')
}

// ---------------------------------------------------------------------------
// 給与DB (rust-ichibanboshi GET /api/kyuyo/employees) からの取り込み、Refs #367
// ---------------------------------------------------------------------------

/** `/api/kyuyo/employees` の 1 行 (identity only — 金額は含まれない)。 */
export interface KyuyoEmployeeRow {
  employee_code: string
  /** 前ゼロ除去済みの突合キー (= 社員マスタの payrollCd)。 */
  employee_code_key: string
  employee_name: string
  /** 所属の表示名 (SHOZOKU.SNAME)。 */
  department: string
  // 以下 3 列は rust-ichibanboshi#98 で足したもの。**任意** にしてあるのは、
  // それ以前の版が本番に居る (ロールバック等) 場合でも取り込みを落とさないため —
  // 欠けていれば所属コード無しの行として扱い、拠点は表示名から引く。
  /** 所属コード (SHOZOKU.INCODE)。給与大臣が持つ所属の並び順 (Refs #409)。 */
  department_code?: number
  /** 営業所名 (SHOZOKU.NAME1)。拠点はこれをそのまま使う。 */
  branch_name?: string
  /** 職種名 (SHOZOKU.NAME2)。 */
  job_name?: string
  /** 給与体系コード (SHOZOKU.TAIKEI)。 */
  taikei: number
  retired: boolean
}

export interface KyuyoEmployeesResponse {
  company: string
  /** KYCOMSTD.CONAME1 (会社ラベルに使う)。 */
  company_name: string
  month: string
  database: string
  employees: KyuyoEmployeeRow[]
  warnings: string[]
}

export interface PayrollImportPlan {
  employees: Array<{ company: string, payrollCd: string, name: string, driverCd: string | null }>
  attrs: EmployeeAttrPutRow[]
  /** 旧ラベルから統合した (= 削除する) 社員行。 */
  deleteEmployees: Array<{ company: string, payrollCd: string }>
  /** 新規に社員マスタへ載る人数。 */
  added: number
  /** 旧ラベル行から乗務員CD突合を引き継いだ人数。 */
  merged: number
}

/** 会社ラベルの正規化 (worker 側 PUT の normalizeCompany と同一規則: NFKC + trim)。
 * ローカル状態とサーバー保存値がズレないよう、取り込み時も同じ規則を通す。 */
export function normalizeCompanyLabel(name: string): string {
  return name.normalize('NFKC').trim()
}

/** 属性テキスト (所属・給与体系) の正規化。worker 側 PUT の normalizeOptionalText と
 * 同一規則 (NFKC + trim、空は null)。**取り込み時にも通すこと** — 通さないと
 * 給与DB由来の全角スペースが保存時だけ半角化され、次回の取り込みで毎回
 * 「変更あり」と誤判定して履歴が汚れる (実機で 51 件の偽差分が出た、Refs #367)。 */
export function normalizeAttrText(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.normalize('NFKC').trim()
  return trimmed || null
}

/** 給与体系コード → 表示用ラベル。0 (未設定) は null。 */
export function payScheme(taikei: number): string | null {
  return taikei > 0 ? `体系${taikei}` : null
}

/** 所属コードの正規化 (worker 側 PUT の normalizeBranchCode と同一規則)。
 * `0` は給与大臣側の「未設定」なので null。整数でない値も fail-soft に null —
 * これは並べ替えのヒントであって識別情報ではないため。 */
export function normalizeBranchCode(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return null
  return raw
}

/**
 * 給与DBの社員一覧を社員マスタへ反映する計画を作る (Refs #367)。
 *
 * - 会社ラベルは `company_name` (KYCOMSTD.CONAME1) を正規化したもの
 * - `legacyLabel` (R2 突合マスタ由来の "有"/"株") の行が同じ給与コードで存在したら、
 *   **乗務員CDの突合を引き継いで旧行を削除する** (二重登録を作らない)
 * - 所属・給与体系は「取り込む月の初日」を適用開始日にする。ただし**その月末時点で
 *   既に同じ値が効いているなら履歴を増やさない** (毎月押しても履歴が汚れない)
 * - 退職者も含める — 過去月の突合に要るため (`retired` は保存しない)
 * - `employee_code_key` が空の行は捨てる (社員番号が無い行)
 */
export function planPayrollDbImport(
  res: KyuyoEmployeesResponse,
  existing: EmployeeMasterEntry[],
  yearMonth: string,
  legacyLabel: string | null,
): PayrollImportPlan {
  // 突合キーの会社部分は**給与大臣の会社コード** (0100 等)。CONAME1 は自由文字列で
  // 表記揺れがキー分裂を生むうえ、`/api/kyuyo/payroll` が返さないため給与比較の
  // DB 直読み (#369) から引けなかった (Refs #405)。会社名は表示専用で別に持つ。
  const company = normalizeCompanyLabel(res.company)
  const byKey = new Map(existing.map(e => [`${e.company}|${e.payrollCd}`, e]))
  const plan: PayrollImportPlan = { employees: [], attrs: [], deleteEmployees: [], added: 0, merged: 0 }
  const effectiveFrom = `${yearMonth}-01`

  for (const row of res.employees) {
    const payrollCd = row.employee_code_key.trim()
    if (!payrollCd) continue
    const current = byKey.get(`${company}|${payrollCd}`)
    const legacy = legacyLabel ? byKey.get(`${legacyLabel}|${payrollCd}`) : undefined
    const driverCd = current?.driverCd ?? legacy?.driverCd ?? null

    if (!current) plan.added += 1
    if (!current && legacy) {
      plan.merged += 1
      plan.deleteEmployees.push({ company: legacyLabel!, payrollCd })
    }
    plan.employees.push({ company, payrollCd, name: row.employee_name, driverCd })

    const branch = normalizeAttrText(row.department)
    const scheme = normalizeAttrText(payScheme(row.taikei))
    const branchCode = normalizeBranchCode(row.department_code)
    const branchName = normalizeAttrText(row.branch_name ?? null)
    const jobName = normalizeAttrText(row.job_name ?? null)
    const active = current ? resolveAttrsAt(current, yearMonth) : null
    // 所属コード・営業所名・職種名 (Refs #409) も差分判定に入れる — 既存行は
    // これらが null なので、再取り込みで同じ `effective_from` の行が埋まる。
    if (active?.branch === branch && active?.payScheme === scheme
      && active?.branchCode === branchCode && active?.branchName === branchName
      && active?.jobName === jobName) continue
    if (branch === null && scheme === null && branchName === null && !active) continue
    plan.attrs.push({ company, payrollCd, effectiveFrom, branch, payScheme: scheme, branchCode, branchName, jobName })
  }
  return plan
}

// ---------------------------------------------------------------------------
// 一番星 社員ﾏｽﾀ からの突合 (Refs #403)
// ---------------------------------------------------------------------------
// **dtako 乗務員CD と一番星 `[社員ﾏｽﾀ].社員C` は同一の番号体系** (2026-07-25 に
// 本番実データで確認。石坂彰 給与1767 → 乗務員CD 1729 = 社員C 1729 ほか全件一致)。
// 一番星は非乗務員 (役員・事務員・作業員) にも番号を振っているため、社員マスタの
// 未突合行をここから埋められる。
//
// 一番星社員ﾏｽﾀに**給与コード列は無い**ので、突合鍵は**氏名だけ**になる。

/** `GET /api/employees` (rust-ichibanboshi) の 1 行。 */
export interface IchibanEmployeeRow {
  /** 社員C。dtako 乗務員CD と同一体系。 */
  employee_code: string
  /** 社員N (氏名)。 */
  employee_name: string
  /** 社員R (表示名)。 */
  employee_r: string
}

/** 一番星突合の提案 (どれも「保存」まではローカル)。 */
export interface IchibanMatchPlan {
  /** 氏名が一意に決まった行 — 社員C を埋めてよい。 */
  matched: Array<{ company: string, payrollCd: string, name: string, personCd: string }>
  /** 同名が複数いて機械的に決められない行 — 人が選ぶ。 */
  ambiguous: Array<{ company: string, payrollCd: string, name: string, candidates: string[] }>
  /** 一番星に居ない行。 */
  notFound: Array<{ company: string, payrollCd: string, name: string }>
}

/**
 * 一番星の氏名が無効行 (`×` 始まり) か。
 *
 * 一番星は無効な社員を氏名の先頭 `×` で表す慣習を持つ (`1005 ×俵坂`、
 * `1137 ×大石和也` 等)。**社員N と社員R で付き方が揃っていない** —
 * `9903` は社員N が `×松江隆` なのに社員R は `松江隆` なので、
 * **両フィールドを見ないと落とせない**。
 */
function isVoidedIchibanRow(row: IchibanEmployeeRow): boolean {
  return normalizeNameKey(row.employee_name).startsWith('×') || normalizeNameKey(row.employee_r).startsWith('×')
}

/**
 * 一番星社員ﾏｽﾀと社員マスタの未突合行を氏名で照合する (Refs #403)。
 *
 * **乗務員CD が既に入っている行は触らない** — 手で直した値を上書きしないため。
 *
 * **番号帯で一番星の行を落としてはいけない** — 9000 番台には拠点 (`9101` 佐賀(営)、
 * `9107` 帯広(営)、`9109` 釧路営業所)・法人 (`9102` 佐賀大石、`9997` 大石畜産)・
 * 集計枠 (`9998` フリー、`9999` 収支用) が混ざるが、**`9001` 加納和広北海大運 の
 * ような実在社員も居る**。これらは給与側に同名が存在しないため照合で自然に外れる。
 * 機械的に落とすのは `×` 始まりの無効行だけ。
 */
export function planIchibanMatch(
  ichiban: IchibanEmployeeRow[],
  employees: EmployeeMasterEntry[],
): IchibanMatchPlan {
  const byName = new Map<string, Set<string>>()
  for (const row of ichiban) {
    if (isVoidedIchibanRow(row)) continue
    for (const raw of [row.employee_r, row.employee_name]) {
      const key = normalizeNameKey(raw)
      if (!key) continue
      const codes = byName.get(key) ?? new Set<string>()
      codes.add(row.employee_code.trim())
      byName.set(key, codes)
    }
  }

  // 表示順は `sortEmployeeEntries` ('ja' 照合) ではなく決定的な順にする —
  // 提案結果が環境で入れ替わるとテストも人の確認もあてにならないため。
  const ordered = [...employees].sort((a, b) =>
    compareCompanyLabel(a.company, b.company)
    || Number(a.payrollCd) - Number(b.payrollCd))

  const plan: IchibanMatchPlan = { matched: [], ambiguous: [], notFound: [] }
  for (const e of ordered) {
    if (e.driverCd) continue
    const where = { company: e.company, payrollCd: e.payrollCd, name: e.name }
    const codes = byName.get(normalizeNameKey(e.name))
    if (!codes) {
      plan.notFound.push(where)
      continue
    }
    const candidates = [...codes]
    if (candidates.length > 1) {
      plan.ambiguous.push({ ...where, candidates })
      continue
    }
    plan.matched.push({ ...where, personCd: String(Number(candidates[0])) })
  }
  return plan
}

/** 社員マスタ一覧の表示順 (会社ラベル昇順 → 給与コード数値昇順)。 */
export function sortEmployeeEntries(employees: EmployeeMasterEntry[]): EmployeeMasterEntry[] {
  return [...employees].sort((a, b) =>
    a.company.localeCompare(b.company, 'ja')
    || a.payrollCd.localeCompare(b.payrollCd, undefined, { numeric: true }))
}
