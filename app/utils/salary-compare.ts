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
  /** 【 補助 】セクションの単価。base = 基本単価 (日額)、overtime = 残業単価 (時給)。
   * 列が無い・0 の場合は null (その行の計算列は出せない)。 */
  rates: { base: number | null, overtime: number | null }
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

  // 【 補助 】セクションの単価列 (基本単価 = 日額 / 残業単価 = 時給)。無ければ -1
  const baseRateCol = header.indexOf('基本単価')
  const overtimeRateCol = header.indexOf('残業単価')

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
  /** 年月形式でない 給与・賞与名 のスキップ行 (給与合計・賞与合計・賞与等) は
   * 実ファイルで乗務員ごとに数十行出るため、名前×件数に集約して 1 警告にする。 */
  const skippedPayNames = new Map<string, number>()

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
      skippedPayNames.set(payName || '空', (skippedPayNames.get(payName || '空') ?? 0) + 1)
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

    // 単価 (0 や非数値は「単価なし」として null)
    const rateAt = (col: number): number | null => {
      if (col < 0) return null
      const v = parseAmount(cells[col] ?? '')
      return v !== null && v > 0 ? v : null
    }

    months.add(month)
    rows.push({
      driverCd: cd,
      cdKey: String(Number(cd)),
      // 年月チェックを通過した時点で cells.length > payNameIdx >= 1 なので cells[1] は存在する
      driverName: cells[1]!,
      month,
      amounts,
      reportedTotal,
      rates: { base: rateAt(baseRateCol), overtime: rateAt(overtimeRateCol) },
    })
  }

  if (skippedPayNames.size > 0) {
    const total = [...skippedPayNames.values()].reduce((a, b) => a + b, 0)
    const detail = [...skippedPayNames.entries()].map(([name, count]) => `${name} ×${count}`).join(', ')
    warnings.push(`給与・賞与名が年月形式でない ${total} 行をスキップしました (${detail})`)
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
// 社員コード突合マスタ (給与コード|氏名 → 乗務員CD、Refs #253)
// 給与システムの社員コードは会社毎に別体系で乗務員CDと一致しないことがある。
// ---------------------------------------------------------------------------

/** worker 側 normalizeSalaryCdMap と同型。key は salaryCdMapKey の形式。 */
export interface SalaryCdMap { entries: Record<string, string> }

/** 氏名の突合用正規化 (NFKC + 空白全除去)。 */
export function normalizeNameKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '')
}

/** 突合マスタのキー: "給与コード(前ゼロ除去)|氏名(空白除去)"。会社毎にコード体系が
 * 分かれて衝突しうるため、コード単独ではなく氏名も含めて引き当てる。 */
export function salaryCdMapKey(payrollCd: string, name: string): string {
  return `${String(Number(payrollCd))}|${normalizeNameKey(name)}`
}

/** CSV 行の突合キー (マスタにあれば引き当てた乗務員CD、無ければ給与コードをそのまま)。 */
export function resolveCdKey(row: SalaryCsvRow, cdMap: SalaryCdMap): string {
  const mapped = cdMap.entries[salaryCdMapKey(row.driverCd, row.driverName)]
  return mapped !== undefined ? String(Number(mapped)) : row.cdKey
}

/**
 * 乗務員CDで突合できなかった CSV 行に対し、氏名の完全一致 (両側で一意) で
 * 乗務員CDを自動提案する。戻り値は salary-cd-map の entries に merge できる形。
 */
export function suggestCdMapEntries(
  csvRows: SalaryCsvRow[],
  reportRows: WageReportRow[],
  cdMap: SalaryCdMap,
): Record<string, string> {
  const reportCds = new Set(reportRows.map(r => String(Number(r.summary.driverCd))))
  // 氏名 → 乗務員CD 群 (一意な氏名だけ提案に使う)
  const byName = new Map<string, string[]>()
  for (const r of reportRows) {
    const key = normalizeNameKey(r.summary.driverName)
    byName.set(key, [...(byName.get(key) ?? []), r.summary.driverCd])
  }
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  for (const row of csvRows) {
    const mapKey = salaryCdMapKey(row.driverCd, row.driverName)
    if (seen.has(mapKey)) continue
    seen.add(mapKey)
    // 既にマスタ登録済み / コードがそのまま一致する行は提案不要
    if (cdMap.entries[mapKey] !== undefined || reportCds.has(row.cdKey)) continue
    const candidates = byName.get(normalizeNameKey(row.driverName))
    if (candidates && candidates.length === 1) out[mapKey] = candidates[0]!
  }
  return out
}

// ---------------------------------------------------------------------------
// wage-report との突合
// ---------------------------------------------------------------------------

/** 支給項目 1 件の内訳表示用 (項目名 + 金額)。 */
export interface SalaryItemAmount { label: string, amount: number }

export interface SalaryComparisonRow {
  driverCd: string
  /** 突合マスタで引き当てた乗務員CD (マスタ経由の時だけ非 null)。 */
  mappedDriverCd: string | null
  driverName: string
  /** CSV 側: 基本給扱い項目の合計 / 残業扱い項目の合計 / 全支給項目の合計。 */
  csvBase: number
  /** csvBase の内訳 (区分設定で基本給扱いになった支給項目、ヘッダー出現順)。 */
  csvBaseItems: SalaryItemAmount[]
  csvOvertime: number
  /** csvOvertime の内訳。 */
  csvOvertimeItems: SalaryItemAmount[]
  csvTotal: number
  /** CSV の 支給合計額 列 (無ければ null、項目合計との検算用)。 */
  csvReportedTotal: number | null
  /** 計算側は CSV の【 補助 】単価 (基本単価=日額、残業単価=時給) ×
   * システム集計で出す (**単価マスタは使わない** — 単価マスタとの比較は
   * 「最低賃金チェック」タブの責務、Refs #268)。単価が無い行は null
   * (「単価なし」— 独自の按分計算はしない)。 */
  sysBase: number | null
  sysOvertime: number | null
  sysTotal: number | null
  /** 計算根拠の表示用: システム稼働日数と時間外(+深夜) 分。 */
  sysWorkDays: number
  sysOvertimeMinutes: number
  /** CSV − システム (システム側が null なら null)。 */
  diffBase: number | null
  diffOvertime: number | null
  diffTotal: number | null
  /** minWageOvertimePay の計算対象時間 (通常残業+深夜残業、wage-report の
   * overtimeMinutes+nightOvertimeMinutes)。sysOvertimeMinutes (時間外+時間外深夜)
   * と異なり週40超過分も含む。 */
  minWageOvertimeMinutes: number
  /** 残業の最低賃金換算理論値 (wage-report の minWageOvertimePay+
   * minWageNightOvertimePay)。単価マスタとは独立で、最低賃金未設定等で
   * どちらか欠ければ null。「最低賃金チェック」タブの最低賃金換算と同じ理論値。 */
  minWageOvertimePay: number | null
  /** csvOvertime (実際の給与明細の残業代、真の支払い実績) − minWageOvertimePay。
   * 負 = 実際に支払われた残業代が最低賃金換算の理論値を下回っている。
   * 「最低賃金チェック」タブが単価マスタ設定の事前チェックなのに対し、
   * こちらは支払い実績の事後チェック (Refs #268)。 */
  diffCsvVsMinWageOvertime: number | null
}

export interface SalaryComparison {
  rows: SalaryComparisonRow[]
  /** CSV にいるが wage-report にいない乗務員。 */
  csvOnly: Array<{ driverCd: string, driverName: string }>
  /** wage-report にいるが CSV にいない乗務員。 */
  reportOnly: Array<{ driverCd: string, driverName: string }>
  warnings: string[]
}

/** CSV 1 行を区分設定で 基本給/残業 の 2 束に集計する (内訳つき)。 */
export function sumByCategory(row: SalaryCsvRow, config: SalaryItemConfig): {
  base: number
  overtime: number
  baseItems: SalaryItemAmount[]
  overtimeItems: SalaryItemAmount[]
} {
  let base = 0
  let overtime = 0
  const baseItems: SalaryItemAmount[] = []
  const overtimeItems: SalaryItemAmount[] = []
  for (const [label, amount] of Object.entries(row.amounts)) {
    if (effectiveCategory(label, config) === 'overtime') {
      overtime += amount
      overtimeItems.push({ label, amount })
    } else {
      base += amount
      baseItems.push({ label, amount })
    }
  }
  return { base, overtime, baseItems, overtimeItems }
}

/**
 * 対象月の CSV 行と wage-report を乗務員CD (数値同値) で突合する。
 * 給与コードが乗務員CDと別体系の乗務員は cdMap (給与コード|氏名 → 乗務員CD) で
 * 引き当てる。同一乗務員の行が重複していたら後勝ち + 警告。
 */
export function compareSalaryMonth(
  csvRows: SalaryCsvRow[],
  reportRows: WageReportRow[],
  config: SalaryItemConfig,
  cdMap: SalaryCdMap = { entries: {} },
): SalaryComparison {
  const warnings: string[] = []
  const byCd = new Map<string, SalaryCsvRow>()
  for (const row of csvRows) {
    const key = resolveCdKey(row, cdMap)
    if (byCd.has(key)) {
      warnings.push(`乗務員 ${row.driverCd} の行が重複しています (後の行を採用)`)
    }
    byCd.set(key, row)
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
    const { base, overtime, baseItems, overtimeItems } = sumByCategory(csv, config)
    const workDays = report.summary.workDays
    const overtimeMinutes = (report.summary.overtimeMinutes ?? 0) + (report.summary.overtimeNightMinutes ?? 0)

    // 計算側: CSV の単価 × システム集計 (基本単価は日額、残業単価は時給)。
    // 単価が無い行は独自の按分計算をせず null (「単価なし」— 最低賃金比較は
    // 既存の最低賃金チェックタブに任せる、Refs #253)。
    const sysBase = csv.rates.base !== null ? Math.round(csv.rates.base * workDays) : null
    const sysOvertime = csv.rates.overtime !== null ? Math.round((csv.rates.overtime * overtimeMinutes) / 60) : null
    const sysTotal = sysBase !== null && sysOvertime !== null ? sysBase + sysOvertime : null

    // 支払い実績 (csvOvertime) と直接比較する最低賃金理論値。時間軸は
    // 「最低賃金チェック」タブと同じ (時間外+時間外深夜+週40超過)。
    const minWageOvertimeMinutes = report.wage.overtimeMinutes + report.wage.nightOvertimeMinutes
    const minWageOvertimePay
      = report.wage.minWageOvertimePay !== null && report.wage.minWageNightOvertimePay !== null
        ? report.wage.minWageOvertimePay + report.wage.minWageNightOvertimePay
        : null

    rows.push({
      driverCd: csv.driverCd,
      mappedDriverCd: csv.cdKey === cdKey ? null : report.summary.driverCd,
      driverName: csv.driverName,
      csvBase: base,
      csvBaseItems: baseItems,
      csvOvertime: overtime,
      csvOvertimeItems: overtimeItems,
      csvTotal: base + overtime,
      csvReportedTotal: csv.reportedTotal,
      sysBase,
      sysOvertime,
      sysTotal,
      sysWorkDays: workDays,
      sysOvertimeMinutes: overtimeMinutes,
      diffBase: sysBase === null ? null : base - sysBase,
      diffOvertime: sysOvertime === null ? null : overtime - sysOvertime,
      diffTotal: sysTotal === null ? null : base + overtime - sysTotal,
      minWageOvertimeMinutes,
      minWageOvertimePay,
      diffCsvVsMinWageOvertime: minWageOvertimePay === null ? null : overtime - minWageOvertimePay,
    })
  }

  const csvOnly: SalaryComparison['csvOnly'] = []
  for (const [key, row] of byCd.entries()) {
    if (!matched.has(key)) {
      csvOnly.push({ driverCd: row.driverCd, driverName: row.driverName })
    }
  }

  return { rows, csvOnly, reportOnly, warnings }
}
