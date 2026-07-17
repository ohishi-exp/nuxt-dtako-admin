/**
 * 給与明細一覧 (給与システムの Excel を CSV/TSV にしたもの) の貼り付け解析と、
 * 拘束×賃金 wage-report との乗務員別突合 (Refs #253)。
 *
 * 貼り付けデータは**ブラウザ内でのみ**解析・比較し、サーバーへ送信・保存しない。
 * サーバー (R2 版管理) に保存されるのは支給項目 → 基本給/残業 の区分設定
 * (/restraint-api/salary-item-config) だけ。
 *
 * フォーマット (2025/2026 様式で確認):
 *   社員コード,社員名,給与・賞与名,【 勤怠 】,...,【 支給 】,基本給,...,支給合計額,課税支給額,【 控除 】,...
 * - 項目名は空白パディングつき (NFKC 正規化 + trim して扱う)
 * - 支給項目は年度で構成が変わる (2026 は 残業手当 が 2 列ある → 同名列は合算)
 * - 給与・賞与名 は "2026年 1月" 形式。賞与など年月にならない行はスキップして警告
 */

import type { WageReportRow } from './restraint-wage-view'

export type SalaryItemCategory = 'base' | 'overtime'

/** 支給項目名 (NFKC + trim 済み) → 区分。worker 側 normalizeSalaryItemConfig と同型。 */
export interface SalaryItemConfig { items: Record<string, SalaryItemCategory> }

export interface SalaryCsvRow {
  /** 社員コード (trim 済みの原文)。 */
  driverCd: string
  /** 前ゼロを除いた突合キー (wage-report の driverCd と数値同値で突合)。 */
  cdKey: string
  driverName: string
  /** "YYYY-MM"。 */
  month: string
  /** 支給項目 (同名列は合算済み) → 金額 (円)。 */
  amounts: Record<string, number>
  /** 支給合計額 列の値 (列が無ければ null)。 */
  reportedTotal: number | null
}

export interface ParsedSalaryCsv {
  rows: SalaryCsvRow[]
  /** ヘッダー出現順の支給項目名 (支給合計額・課税支給額は除く)。 */
  itemLabels: string[]
  /** 行に出現した月 (昇順ユニーク)。 */
  months: string[]
  warnings: string[]
}

/** NFKC 正規化 + 前後空白除去 (全角空白・半角カナ・全角数字を吸収する)。 */
function norm(s: string): string {
  return s.normalize('NFKC').trim()
}

/** 1 行を delimiter で分割する。CSV のダブルクォート ("" エスケープ) に対応。 */
export function splitDelimitedLine(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        }
        else {
          inQuotes = false
        }
      }
      else {
        cur += ch
      }
    }
    else if (ch === '"') {
      inQuotes = true
    }
    else if (ch === delim) {
      out.push(cur)
      cur = ''
    }
    else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

/** 【 支給 】等のセクション見出しセルなら内側の名前 ("支給" 等) を返す。 */
function sectionName(cell: string): string | null {
  const m = cell.match(/^【\s*(.+?)\s*】$/)
  return m ? m[1]!.replace(/\s+/g, '') : null
}

/** 金額セル → 円。空は 0。桁区切りカンマを除去。数値でなければ null (呼び出し側で警告)。 */
function parseAmount(cell: string): number | null {
  const s = cell.replace(/[,¥\s]/g, '')
  if (s === '') return 0
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

/** 支給項目名から区分の初期候補を推定する (未設定項目の既定値)。 */
export function suggestCategory(label: string): SalaryItemCategory {
  return /残業|時間外|深夜|休日出勤/.test(label) ? 'overtime' : 'base'
}

/** 設定に無い項目は suggestCategory で補完した実効区分。 */
export function effectiveCategory(label: string, config: SalaryItemConfig): SalaryItemCategory {
  return config.items[label] ?? suggestCategory(label)
}

/**
 * 貼り付けテキストを解析する。構造がフォーマットと合わない場合は Error を投げる。
 * 行単位の不正 (社員コードなし・賞与行・数値でないセル) はスキップ + warnings。
 */
export function parseSalaryCsv(text: string): ParsedSalaryCsv {
  const lines = text.replace(/\uFEFF/g, '').split(/\r\n|\r|\n/).filter(l => l.trim() !== '')
  if (lines.length === 0) {
    throw new Error('貼り付けデータが空です')
  }
  const delim = lines[0]!.includes('\t') ? '\t' : ','
  const header = splitDelimitedLine(lines[0]!, delim).map(norm)

  if (header[0] !== '社員コード') {
    throw new Error('1 行目がヘッダーではありません (先頭列が「社員コード」の表を貼り付けてください)')
  }
  const payNameIdx = header.indexOf('給与・賞与名')
  if (payNameIdx < 0) {
    throw new Error('ヘッダーに「給与・賞与名」列がありません')
  }

  // 【 支給 】セクションの範囲 (見出しの次〜次セクション見出しの手前) を特定する
  let payStart = -1
  let payEnd = header.length
  for (let i = 0; i < header.length; i++) {
    const sec = sectionName(header[i]!)
    if (sec === null) continue
    if (sec === '支給') {
      payStart = i
    }
    else if (payStart >= 0) {
      payEnd = i
      break
    }
  }
  if (payStart < 0) {
    throw new Error('ヘッダーに【 支給 】セクションがありません')
  }

  // 支給項目列: 合計系 (支給合計額・課税支給額) は項目から除外し、支給合計額は突合用に保持
  const TOTAL_LABELS = new Set(['支給合計額', '課税支給額'])
  let totalIdx = -1
  const itemLabels: string[] = []
  const labelToCols = new Map<string, number[]>()
  for (let i = payStart + 1; i < payEnd; i++) {
    const label = header[i]!
    if (label === '') continue
    if (TOTAL_LABELS.has(label)) {
      if (label === '支給合計額') totalIdx = i
      continue
    }
    const cols = labelToCols.get(label)
    if (cols) {
      cols.push(i)
    }
    else {
      labelToCols.set(label, [i])
      itemLabels.push(label)
    }
  }
  if (itemLabels.length === 0) {
    throw new Error('【 支給 】セクションに支給項目列がありません')
  }

  const rows: SalaryCsvRow[] = []
  const warnings: string[] = []
  const months = new Set<string>()

  for (let li = 1; li < lines.length; li++) {
    // splitDelimitedLine は必ず 1 要素以上返すので cells[0] は常に存在する
    const cells = splitDelimitedLine(lines[li]!, delim).map(norm)
    const cd = cells[0]!
    if (!/^\d+$/.test(cd)) {
      warnings.push(`${li + 1} 行目: 社員コードが数値ではないためスキップしました (${cd || '空'})`)
      continue
    }
    const payName = cells[payNameIdx] ?? ''
    const ym = payName.match(/^(\d{4})年\s*(\d{1,2})月$/)
    if (!ym) {
      warnings.push(`${li + 1} 行目: 給与・賞与名「${payName}」が年月形式でないためスキップしました (賞与等)`)
      continue
    }
    const month = `${ym[1]}-${ym[2]!.padStart(2, '0')}`

    const amounts: Record<string, number> = {}
    for (const label of itemLabels) {
      let sum = 0
      for (const col of labelToCols.get(label)!) {
        const v = parseAmount(cells[col] ?? '')
        if (v === null) {
          warnings.push(`${li + 1} 行目: ${label} の値「${cells[col]}」が数値でないため 0 として扱いました`)
        }
        else {
          sum += v
        }
      }
      amounts[label] = sum
    }
    const reportedTotal = totalIdx >= 0 ? parseAmount(cells[totalIdx] ?? '') : null

    months.add(month)
    rows.push({
      driverCd: cd,
      cdKey: String(Number(cd)),
      // 年月チェックを通過した時点で cells.length > payNameIdx >= 1 なので cells[1] は存在する
      driverName: cells[1]!,
      month,
      amounts,
      reportedTotal,
    })
  }

  return { rows, itemLabels, months: [...months].sort((a, b) => a.localeCompare(b)), warnings }
}

/**
 * 複数回取り込んだ解析結果を 1 つにまとめる (Refs #253 複数取り込み対応)。
 * 年度で様式 (支給項目の構成) が違っても、項目名は初出順の和集合になる。
 * 行は取り込み順に連結する (同一乗務員 × 同一月の重複は compareSalaryMonth が
 * 後勝ち + 警告で扱う)。
 */
export function mergeParsedSalaryCsv(parsedList: ParsedSalaryCsv[]): ParsedSalaryCsv {
  const rows: SalaryCsvRow[] = []
  const itemLabels: string[] = []
  const months = new Set<string>()
  const warnings: string[] = []
  for (const parsed of parsedList) {
    rows.push(...parsed.rows)
    for (const label of parsed.itemLabels) {
      if (!itemLabels.includes(label)) itemLabels.push(label)
    }
    for (const ym of parsed.months) months.add(ym)
    warnings.push(...parsed.warnings)
  }
  return { rows, itemLabels, months: [...months].sort((a, b) => a.localeCompare(b)), warnings }
}

// ---------------------------------------------------------------------------
// wage-report との突合
// ---------------------------------------------------------------------------

export interface SalaryComparisonRow {
  driverCd: string
  driverName: string
  /** CSV 側: 基本給扱い項目の合計 / 残業扱い項目の合計 / 全支給項目の合計。 */
  csvBase: number
  csvOvertime: number
  csvTotal: number
  /** CSV の 支給合計額 列 (無ければ null、項目合計との検算用)。 */
  csvReportedTotal: number | null
  /** システム側: 法定時間内額 / 割増額 (合計 − 法定時間内) / 合計。単価未設定は null。 */
  sysBase: number | null
  sysOvertime: number | null
  sysTotal: number | null
  /** CSV − システム (システム側が null なら null)。 */
  diffBase: number | null
  diffOvertime: number | null
  diffTotal: number | null
}

export interface SalaryComparison {
  rows: SalaryComparisonRow[]
  /** CSV にいるが wage-report にいない乗務員。 */
  csvOnly: Array<{ driverCd: string, driverName: string }>
  /** wage-report にいるが CSV にいない乗務員。 */
  reportOnly: Array<{ driverCd: string, driverName: string }>
  warnings: string[]
}

/** CSV 1 行を区分設定で 基本給/残業 の 2 束に集計する。 */
export function sumByCategory(row: SalaryCsvRow, config: SalaryItemConfig): { base: number, overtime: number } {
  let base = 0
  let overtime = 0
  for (const [label, amount] of Object.entries(row.amounts)) {
    if (effectiveCategory(label, config) === 'overtime') overtime += amount
    else base += amount
  }
  return { base, overtime }
}

/**
 * 対象月の CSV 行と wage-report を乗務員CD (数値同値) で突合する。
 * 同一乗務員の行が重複していたら後勝ち + 警告。
 */
export function compareSalaryMonth(
  csvRows: SalaryCsvRow[],
  reportRows: WageReportRow[],
  config: SalaryItemConfig,
): SalaryComparison {
  const warnings: string[] = []
  const byCd = new Map<string, SalaryCsvRow>()
  for (const row of csvRows) {
    if (byCd.has(row.cdKey)) {
      warnings.push(`乗務員 ${row.driverCd} の行が重複しています (後の行を採用)`)
    }
    byCd.set(row.cdKey, row)
  }

  const rows: SalaryComparisonRow[] = []
  const reportOnly: SalaryComparison['reportOnly'] = []
  const matched = new Set<string>()

  for (const report of reportRows) {
    const cdKey = String(Number(report.summary.driverCd))
    const csv = byCd.get(cdKey)
    if (!csv) {
      reportOnly.push({ driverCd: report.summary.driverCd, driverName: report.summary.driverName })
      continue
    }
    matched.add(cdKey)
    const { base, overtime } = sumByCategory(csv, config)
    const sysBase = report.wage.amounts?.statutory ?? null
    const sysTotal = report.wage.totalAmount
    const sysOvertime = sysBase !== null && sysTotal !== null ? sysTotal - sysBase : null
    rows.push({
      driverCd: csv.driverCd,
      driverName: csv.driverName,
      csvBase: base,
      csvOvertime: overtime,
      csvTotal: base + overtime,
      csvReportedTotal: csv.reportedTotal,
      sysBase,
      sysOvertime,
      sysTotal,
      diffBase: sysBase === null ? null : base - sysBase,
      diffOvertime: sysOvertime === null ? null : overtime - sysOvertime,
      diffTotal: sysTotal === null ? null : base + overtime - sysTotal,
    })
  }

  const csvOnly: SalaryComparison['csvOnly'] = []
  for (const row of byCd.values()) {
    if (!matched.has(row.cdKey)) {
      csvOnly.push({ driverCd: row.driverCd, driverName: row.driverName })
    }
  }

  return { rows, csvOnly, reportOnly, warnings }
}
