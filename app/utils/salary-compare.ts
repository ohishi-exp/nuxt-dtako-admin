/**
 * 給与明細一覧 (給与システムの Excel を CSV/TSV にしたもの) の貼り付け解析と、
 * 拘束×賃金 wage-report との乗務員別突合 (Refs #253)。
 *
 * 貼り付けデータは**ブラウザ内でのみ**解析・比較し、サーバーへ送信・保存しない。
 * サーバー (R2 版管理) に保存されるのは支給項目 → 区分 (SalaryItemCategory の
 * 5 区分、Refs #278) の設定 (/restraint-api/salary-item-config) だけ。
 *
 * フォーマット (2025/2026 様式で確認):
 *   社員コード,社員名,給与・賞与名,【 勤怠 】,...,【 支給 】,基本給,...,支給合計額,課税支給額,【 控除 】,...
 * - 項目名は空白パディングつき (NFKC 正規化 + trim して扱う)
 * - 支給項目は年度で構成が変わる (2026 は 残業手当 が 2 列ある → 同名列は合算)
 * - 給与・賞与名 は "2026年 1月" 形式。賞与など年月にならない行はスキップして警告
 */

import type { WageReportRow } from './restraint-wage-view'

/**
 * 支給項目の区分 (Refs #278)。法令上の除外集合は 2 軸で別物のため、
 * 割増賃金の基礎 (労基法37条5項・施行規則21条: 除外は限定列挙 7 種) と
 * 最低賃金の対象賃金 (最低賃金法4条3項) の組合せで 5 区分にする:
 *
 * | 区分               | 代表例                     | 割増基礎 | 最低賃金 |
 * |--------------------|----------------------------|----------|----------|
 * | base               | 基本給・職務・無事故手当   | ○        | ○        |
 * | overtime           | 残業・深夜・休日出勤手当   | —        | ×        |
 * | minwage-only       | 住宅・別居・子女教育手当   | ×        | ○        |
 * | premium-base-only  | 精皆勤手当                 | ○        | ×        |
 * | excluded           | 通勤・家族手当、臨時・賞与 | ×        | ×        |
 *
 * 'base' / 'overtime' は旧 2 区分時代の保存済み設定と同じ値・同じ意味 (後方互換)。
 */
export type SalaryItemCategory = 'base' | 'overtime' | 'minwage-only' | 'premium-base-only' | 'excluded'

/** 区分 → 各集計軸に算入するか。overtime (割増そのもの) はどちらの基礎にも入らず、
 * 支払残業代の束として別扱いする。 */
export const SALARY_CATEGORY_FLAGS: Record<SalaryItemCategory, { premiumBase: boolean, minWage: boolean }> = {
  'base': { premiumBase: true, minWage: true },
  'overtime': { premiumBase: false, minWage: false },
  'minwage-only': { premiumBase: false, minWage: true },
  'premium-base-only': { premiumBase: true, minWage: false },
  'excluded': { premiumBase: false, minWage: false },
}

/** 支給項目名 (NFKC + trim 済み) → 区分。worker 側 normalizeSalaryItemConfig と同型。 */
export interface SalaryItemConfig { items: Record<string, SalaryItemCategory> }

export interface SalaryCsvRow {
  /** 社員コード (trim 済みの原文)。 */
  driverCd: string
  /** 前ゼロを除いた突合キー (wage-report の driverCd と数値同値で突合)。 */
  cdKey: string
  /** 取り込み元の会社ラベル (parseSalaryCsv は関与しないファイル単位の属性、
   * 呼び出し側が付与する。空文字 = 未設定/単一会社)。社員コードは会社毎に
   * 別体系のため、複数社の CSV を合算すると番号が衝突しうる (Refs #253)。 */
  company: string
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
  /**
   * 【 勤怠 】セクションの日数 (項目名 → 値)。出勤日数・公休日数・有休日数・欠勤日数 等
   * (Refs #433)。**セクションが無ければ空オブジェクト**。
   *
   * 給与DB 経由 (`payrollToParsedSalary`) では常に空 — rust-ichibanboshi の
   * `/api/kyuyo/payroll` が支給項目 (MONEY 列) しか返さないため。
   *
   * **optional** — この項目より前に取り込んでタブに残っている解析結果 (画面は
   * 取り込み結果をタブを閉じるまで保持する) にも無いので、読む側は `?? {}` する。
   */
  attendance?: Record<string, number>
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

/** 支給項目名から区分の初期候補を推定する (未設定項目の既定値、Refs #278)。 */
export function suggestCategory(label: string): SalaryItemCategory {
  if (/残業|時間外|深夜|休日出勤/.test(label)) return 'overtime'
  if (/住宅|別居|子女教育/.test(label)) return 'minwage-only'
  if (/精勤|皆勤/.test(label)) return 'premium-base-only'
  if (/通勤|家族|賞与|臨時/.test(label)) return 'excluded'
  return 'base'
}

/** 設定に無い項目は suggestCategory で補完した実効区分。 */
export function effectiveCategory(label: string, config: SalaryItemConfig): SalaryItemCategory {
  return config.items[label] ?? suggestCategory(label)
}

/**
 * 貼り付けテキストを解析する。構造がフォーマットと合わない場合は Error を投げる。
 * 行単位の不正 (社員コードなし・賞与行・数値でないセル) はスキップ + warnings。
 * company は呼び出し側 (1 ファイル = 1 社) が付与する会社ラベル (省略時は未設定)。
 */
export function parseSalaryCsv(text: string, company = ''): ParsedSalaryCsv {
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

  // 【 勤怠 】セクションの日数列 (出勤日数・公休日数 等、Refs #433)。
  // 支給と同じ作法で見出しの次〜次セクションの手前を拾う。**無くてもよい** —
  // 様式によっては勤怠を出さない設定があるので、その場合は空のまま進む
  const attendanceCols = new Map<string, number>()
  for (let i = 0; i < header.length; i++) {
    if (sectionName(header[i]!) !== '勤怠') continue
    for (let j = i + 1; j < header.length && sectionName(header[j]!) === null; j++) {
      // 空セル (様式のパディング) は項目にしない。同名列が 2 つ来る想定は無い
      // (勤怠は 1 項目 1 列) ので、来たら後勝ちで構わない
      if (header[j]!) attendanceCols.set(header[j]!, j)
    }
    break
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

    // 勤怠の日数。空欄・非数値は「その項目は無い」として載せない — 0 を入れると
    // 「公休 0 日」と「公休の欄が無い」が画面で区別できなくなる
    const attendance: Record<string, number> = {}
    for (const [label, col] of attendanceCols) {
      const v = parseAmount(cells[col] ?? '')
      if (v !== null) attendance[label] = v
    }

    months.add(month)
    rows.push({
      driverCd: cd,
      cdKey: String(Number(cd)),
      company,
      // 年月チェックを通過した時点で cells.length > payNameIdx >= 1 なので cells[1] は存在する
      driverName: cells[1]!,
      month,
      amounts,
      reportedTotal,
      rates: { base: rateAt(baseRateCol), overtime: rateAt(overtimeRateCol) },
      attendance,
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

/** 突合ロジックが読む「キー → 乗務員CD」の索引。key は salaryCdMapKey の形式。
 * 実体は社員マスタ (D1) から `buildCdMapEntries()` が組み立てる — 旧 R2 マスタ
 * (`salary-cd-map`) は 2026-07-25 に撤去済みで、この形はもう永続化されない。 */
export interface SalaryCdMap { entries: Record<string, string> }

/** 氏名の突合用正規化 (NFKC + 空白全除去)。 */
export function normalizeNameKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '')
}

/** 突合マスタのキー: "給与コード(前ゼロ除去)|氏名(空白除去)" (会社ラベル無し)、
 * 会社ラベルがあれば先頭に付与した "会社|給与コード|氏名"。会社毎にコード体系が
 * 分かれて衝突しうるため、コード単独ではなく氏名 (と会社) も含めて引き当てる。
 * company 省略時は旧形式 (2 部) と完全に同じ文字列になる — 会社ラベル導入前に
 * 保存された突合マスタ (R2) をそのまま読めるようにするための後方互換 (Refs #253)。 */
export function salaryCdMapKey(payrollCd: string, name: string, company = ''): string {
  const base = `${String(Number(payrollCd))}|${normalizeNameKey(name)}`
  return company ? `${norm(company)}|${base}` : base
}

/**
 * CSV 行の突合キー (マスタにあれば引き当てた乗務員CD、無ければ給与コードをそのまま)。
 * 会社スコープのキーで引けなければ、会社ラベル導入前に保存された旧形式 (会社無し)
 * のキーも試す — 既存の突合マスタを消さずに会社スコープへ移行できるようにする。
 */
function lookupCdMap(row: SalaryCsvRow, cdMap: SalaryCdMap): string | undefined {
  const scoped = cdMap.entries[salaryCdMapKey(row.driverCd, row.driverName, row.company)]
  if (scoped !== undefined) return String(Number(scoped))
  if (row.company) {
    const legacy = cdMap.entries[salaryCdMapKey(row.driverCd, row.driverName)]
    if (legacy !== undefined) return String(Number(legacy))
  }
  return undefined
}

export function resolveCdKey(row: SalaryCsvRow, cdMap: SalaryCdMap): string {
  return lookupCdMap(row, cdMap) ?? row.cdKey
}

/**
 * 乗務員CDで突合できなかった CSV 行に対し、氏名の完全一致 (両側で一意) で
 * 乗務員CDを自動提案する。戻り値は `SalaryCdMap.entries` に merge できる形。
 */
export function suggestCdMapEntries(
  csvRows: SalaryCsvRow[],
  reportRows: WageReportRow[],
  cdMap: SalaryCdMap,
): Record<string, string> {
  // 乗務員CD (前ゼロ除去) → 氏名の正規化キー。コードがそのまま一致していても
  // 氏名まで一致していなければ「本当の直接一致」ではない (会社を跨いだ偶然の
  // コード衝突、Refs #253) — その場合は生コードへ逃げず氏名一致で提案する。
  const reportNameByCd = new Map<string, string>()
  // 氏名 → 乗務員CD 群 (一意な氏名だけ提案に使う)
  const byName = new Map<string, string[]>()
  for (const r of reportRows) {
    const nameKey = normalizeNameKey(r.summary.driverName)
    reportNameByCd.set(String(Number(r.summary.driverCd)), nameKey)
    byName.set(nameKey, [...(byName.get(nameKey) ?? []), r.summary.driverCd])
  }
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  for (const row of csvRows) {
    const mapKey = salaryCdMapKey(row.driverCd, row.driverName, row.company)
    if (seen.has(mapKey)) continue
    seen.add(mapKey)
    // 既にマスタ登録済み (会社スコープ / 旧形式のどちらか) の行は提案不要
    const legacyKey = row.company ? salaryCdMapKey(row.driverCd, row.driverName) : mapKey
    if (cdMap.entries[mapKey] !== undefined || cdMap.entries[legacyKey] !== undefined) continue
    const rowNameKey = normalizeNameKey(row.driverName)
    // コードがそのまま driverCd と一致し、かつ氏名も一致するなら本当の直接
    // 一致なので提案不要。氏名が違えば偶然のコード衝突 (Refs #253) なので
    // 生コードへ逃げず、下の氏名一意一致で正しい乗務員CDを提案する。
    if (reportNameByCd.get(row.cdKey) === rowNameKey) continue
    const candidates = byName.get(rowNameKey)
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
  /** 複数会社の給与行を 1 人として合算した場合の内訳 (会社ラベル昇順)。
   * 単一行なら null (従来の挙動と区別できるようにする、Refs #403)。 */
  mergedFrom: Array<{ company: string, driverCd: string }> | null
  /** CSV 側: 基本給扱い項目の合計 / 残業扱い項目の合計 / 全支給項目の合計。 */
  csvBase: number
  /** csvBase の内訳 (区分設定で基本給扱いになった支給項目、ヘッダー出現順)。 */
  csvBaseItems: SalaryItemAmount[]
  csvOvertime: number
  /** csvOvertime の内訳。 */
  csvOvertimeItems: SalaryItemAmount[]
  /**
   * 給与明細の**残業時間** (`KINDATA` の「残業時間」、Refs #447)。
   *
   * `csvOvertime` が金額なのに対しこちらは時間。打刻から計算した残業と**同じ単位で
   * 並べられる**ので、金額だけの比較より食い違いの原因が見える (単価の違いか
   * 時間の違いか)。欄が無い様式もあるので取れなければ null。
   */
  csvOvertimeHours: number | null
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
  /** 割増基礎に算入する支給項目の合計 (base + premium-base-only、Refs #278)。 */
  csvPremiumBase: number
  /** csvPremiumBase の内訳。 */
  csvPremiumBaseItems: SalaryItemAmount[]
  /** 最低賃金の対象賃金に算入する支給項目の合計 (base + minwage-only)。
   * 最低賃金の法定チェックの分子はこちらを使う — 通勤・家族手当等 (excluded) を
   * 混入させない (割れ見逃し方向の誤りを防ぐ、Refs #278)。 */
  csvMinWageEligible: number
  /** csvMinWageEligible の内訳。 */
  csvMinWageEligibleItems: SalaryItemAmount[]
  /** デジタコ法定内時間 (wage-report の minutes.statutory、分)。 */
  statutoryMinutes: number
  /** 基礎単価(実績) = csvPremiumBase ÷ 法定内時間 (円/h、丸めなし)。
   * 法定内時間 0 や割増基礎算入分 0 の行は null (算出不可)。
   * 単価マスタの時給との検算にもなる (Refs #278)。 */
  baseRateActual: number | null
  /** 基礎単価(実績) を基礎額とした割増残業代の理論値 (労基法37条、
   * computeOvertimePayAtRate)。baseRateActual が null なら null。 */
  baseRateOvertimePay: number | null
  /** csvOvertime (支払残業代) − baseRateOvertimePay。負 = 実際の基礎単価に
   * 対する法定割増を下回っている (**主判定・37条**)。残業(最低賃金) は
   * 絶対下限の併記に回る (Refs #278)。 */
  diffCsvVsBaseRateOvertime: number | null
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
  /**
   * 勤怠日数の突合 (Refs #433)。`sys` は打刻から数えた日数
   * (`countWorkKinds` 相当、タイムカード由来の行だけ非ゼロ)、`csv` は給与明細の
   * 【 勤怠 】セクションの値 (欄が無ければ undefined)。
   *
   * **差の判定はしない** — 事務員は実残業をつけていない運用があるように、
   * 日数の付け方も運用差がある。並べて見せるのが目的で、異常扱いはしない
   * (Refs #424 の「差は出るのが前提」と同じ方針)。
   */
  attendanceDays: {
    sys: { work: number, publicHoliday: number, paidLeave: number, absence: number, punchError: number }
    csv: { work?: number, publicHoliday?: number, paidLeave?: number, absence?: number }
  }
}

/** 給与明細の【 勤怠 】項目名 → 突合する軸 (Refs #433)。給与大臣の様式に合わせた
 * 名前で、無い様式もあるので**引けなければ undefined のまま**にする。 */
const CSV_ATTENDANCE_LABELS = {
  work: '出勤日数',
  publicHoliday: '公休日数',
  paidLeave: '有休日数',
  absence: '欠勤日数',
} as const

/** 給与明細の残業時間の項目名 (`KINDATA`)。本番実データで 0100/0200/0300 の 3 社とも
 * この名前 (Refs #447)。 */
const CSV_OVERTIME_HOURS_LABEL = '残業時間'

/** 給与明細の残業時間 (時間)。欄が無ければ null。 */
export function csvOvertimeHoursOf(csv: SalaryCsvRow): number | null {
  const v = (csv.attendance ?? {})[CSV_OVERTIME_HOURS_LABEL]
  return typeof v === 'number' ? v : null
}

/**
 * 勤怠日数の突合セル (Refs #433)。
 *
 * `sys` の休暇日数は**サマリの `leaveCounts`** (worker が `countLeaves` で出した値) を
 * そのまま使う — 画面側で日別から数え直すと worker と規則がずれた時に静かに食い違う。
 * theearth 由来の行は `leaveCounts` を持たないので 0 になる (打刻が無いので当然)。
 */
function buildAttendanceDays(
  report: WageReportRow,
  csv: SalaryCsvRow,
): SalaryComparisonRow['attendanceDays'] {
  const leaves = report.summary.leaveCounts
  const csvDays: SalaryComparisonRow['attendanceDays']['csv'] = {}
  for (const [key, label] of Object.entries(CSV_ATTENDANCE_LABELS)) {
    const v = (csv.attendance ?? {})[label]
    if (v !== undefined) csvDays[key as keyof typeof CSV_ATTENDANCE_LABELS] = v
  }
  return {
    sys: {
      work: report.summary.workDays,
      publicHoliday: leaves?.publicHoliday ?? 0,
      paidLeave: leaves?.paidLeave ?? 0,
      absence: leaves?.absence ?? 0,
      punchError: report.summary.punchErrorDays ?? 0,
    },
    csv: csvDays,
  }
}

export interface SalaryComparison {
  rows: SalaryComparisonRow[]
  /** まだ乗務員CDを確認できていない給与明細行 (突合マスタ未登録かつ、給与コードの
   * 直接一致も取れない行)。乗務員CDが確定済みだが今月の wage-report にその
   * 乗務員がいないだけの行 (退職・休職等) はここに出さない — 比較対象が無い
   * だけで人が何か確認する必要はないため (Refs #253)。会社ラベルは突合マスタ
   * 登録用。 */
  csvOnly: Array<{ driverCd: string, driverName: string, company: string }>
  /** wage-report にいるが CSV にいない乗務員。 */
  reportOnly: Array<{ driverCd: string, driverName: string }>
  /** 同じ乗務員CDへ解決された行のうち**氏名が一致しない**もの (Refs #253 会社スコープ)。
   * 氏名が一致する複数会社の行は同一人物として `rows` で合算するため、ここには
   * 「同名別人・登録ミスの疑い」だけが残る (Refs #403)。rows/csvOnly には出さない —
   * 社員マスタで引き当て直すまで比較対象から外れる。 */
  conflicts: Array<{ driverCd: string, entries: Array<{ company: string, driverCd: string, driverName: string }> }>
  warnings: string[]
}

/** 区分 1 束の集計 (合計 + 内訳)。 */
export interface CategorySum { total: number, items: SalaryItemAmount[] }

export interface SalaryCategorySums {
  /** 5 区分それぞれの束。 */
  buckets: Record<SalaryItemCategory, CategorySum>
  /** 割増賃金の基礎 (37条): base + premium-base-only。 */
  premiumBase: CategorySum
  /** 最低賃金の対象賃金 (4条3項): base + minwage-only。 */
  minWageEligible: CategorySum
  /** 全支給項目の合計 (excluded 含む — 支給合計額列との検算用)。 */
  total: number
}

/** CSV 1 行を区分設定で 5 区分に集計する (内訳つき、Refs #278)。 */
export function sumByCategory(row: SalaryCsvRow, config: SalaryItemConfig): SalaryCategorySums {
  const buckets: Record<SalaryItemCategory, CategorySum> = {
    'base': { total: 0, items: [] },
    'overtime': { total: 0, items: [] },
    'minwage-only': { total: 0, items: [] },
    'premium-base-only': { total: 0, items: [] },
    'excluded': { total: 0, items: [] },
  }
  const premiumBase: CategorySum = { total: 0, items: [] }
  const minWageEligible: CategorySum = { total: 0, items: [] }
  let total = 0
  for (const [label, amount] of Object.entries(row.amounts)) {
    const category = effectiveCategory(label, config)
    const item = { label, amount }
    buckets[category].total += amount
    buckets[category].items.push(item)
    const flags = SALARY_CATEGORY_FLAGS[category]
    if (flags.premiumBase) {
      premiumBase.total += amount
      premiumBase.items.push(item)
    }
    if (flags.minWage) {
      minWageEligible.total += amount
      minWageEligible.items.push(item)
    }
    total += amount
  }
  return { buckets, premiumBase, minWageEligible, total }
}

/**
 * 残業の「時間」比較 (タイムカード表示用、Refs #441)。
 *
 * 拘束時間上の残業 (打刻から計算した時間) と、給与明細に計上された残業代を
 * **基礎単価(実績) で時間へ逆算した値**を並べる。**逆算は法定割増
 * (1.25/1.5倍・深夜0.25倍) を戻さない単純な「金額 ÷ 基礎単価」** — 円ベースの
 * 主判定 (`diffCsvVsBaseRateOvertime`) の理論値とは別の、時間の桁感を掴むための
 * 簡易換算であることに注意 (割増が乗っている分、実際の残業時間より大きく出る)。
 *
 * 基礎単価(実績) が無ければ (`baseRateActual` が null か 0 以下) 支給側は
 * 計算不能 = null (独自の按分計算はしない、Refs #253 の方針と同じ)。
 */
export interface OvertimeHoursComparison {
  /** 拘束時間上の残業 (分、時間外+時間外深夜+週40超過)。`sysOvertimeMinutes` と同じ。 */
  restraintMinutes: number
  /** 給与の残業計上額 ÷ 基礎単価(実績) を時間へ逆算した値 (分)。計算不能なら null。 */
  paidMinutes: number | null
  /** 拘束時間上の残業 − 支給分の残業 (分)。正 = 打刻の方が多い (未払いの疑い)。
   * `paidMinutes` が null なら null。 */
  diffMinutes: number | null
}

export function overtimeHoursComparison(
  row: Pick<SalaryComparisonRow, 'sysOvertimeMinutes' | 'csvOvertime' | 'baseRateActual'>,
): OvertimeHoursComparison {
  const restraintMinutes = row.sysOvertimeMinutes
  const paidMinutes = row.baseRateActual !== null && row.baseRateActual > 0
    ? Math.round((row.csvOvertime / row.baseRateActual) * 60)
    : null
  return {
    restraintMinutes,
    paidMinutes,
    diffMinutes: paidMinutes === null ? null : restraintMinutes - paidMinutes,
  }
}

/** 月の時間外割増の法定上限 (worker computeMinWageOvertimePay と同じ閾値)。 */
const MONTHLY_OVERTIME_THRESHOLD_MINUTES = 60 * 60

/**
 * rate を基礎額とした割増残業代の理論値 (労基法37条、Refs #278)。
 * worker の computeMinWageOvertimePay と同一ロジック — 時間外軸 (月60hまで
 * 1.25倍・超過分1.5倍) と深夜軸 (常時+0.25倍) の独立加算。係数は既定値固定
 * (rate に給与明細由来の基礎単価を渡すため、ブラウザ内で完結して計算する)。
 *
 * @param overtimeMinutes 時間外 + 時間外深夜 + 週40超過 の合計 (分、月60h判定の対象)
 * @param overtimeNightMinutes うち時間外深夜 (分、深夜加算 0.25 の対象)
 */
export function computeOvertimePayAtRate(
  overtimeMinutes: number,
  overtimeNightMinutes: number,
  rate: number,
): number {
  const under = Math.min(overtimeMinutes, MONTHLY_OVERTIME_THRESHOLD_MINUTES)
  const over = Math.max(0, overtimeMinutes - MONTHLY_OVERTIME_THRESHOLD_MINUTES)
  return Math.round(
    (under / 60) * rate * 1.25
    + (over / 60) * rate * 1.5
    + (overtimeNightMinutes / 60) * rate * 0.25,
  )
}

/**
 * 会社ラベルの**決定的な**比較 (コードポイント順)。
 *
 * `localeCompare` は使わない — ICU の照合順が環境で違い、`株` と `有` の順が
 * Windows と CI (Linux) で逆になる。合算の内訳順や属性の連結順が環境依存に
 * なると「不定性を消す」という目的自体が壊れるため、ここは locale を持ち込まない。
 * 人向けの表示順 (社員マスタ一覧) は `sortEmployeeEntries` が `'ja'` で行う。
 */
export function compareCompanyLabel(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/**
 * 同一人物 (氏名一致) の複数会社の給与行を 1 行に合算する (Refs #403)。
 * 呼び出し側は会社ラベル昇順に並べた配列を渡す (結果を決定的にするため)。
 *
 * - 支給項目 (`amounts`) は**項目名ごとに合算**する
 * - `reportedTotal` (支給合計額列) は**全行が値を持つ時だけ合算**する — 欠損が
 *   あると検算にならないため null にする
 * - 単価 (`rates`) は**全行で同値の時だけ採用**する。会社ごとに単価が違う場合、
 *   合算後の日額/時給を機械的に決める根拠が無いので null (=「単価なし」) にする。
 *   独自の按分計算はしない (Refs #253 の方針と同じ)
 * - `company` は会社ラベルを ` / ` で連結する (表示用)
 *
 * 1 件だけならその行をそのまま返す。
 */
export function mergeSalaryCsvRows(rows: SalaryCsvRow[]): SalaryCsvRow {
  const first = rows[0]!
  if (rows.length === 1) return first

  const amounts: Record<string, number> = {}
  for (const row of rows) {
    for (const [label, amount] of Object.entries(row.amounts)) {
      amounts[label] = (amounts[label] ?? 0) + amount
    }
  }
  // 1 行でも欠けていたら検算にならないので null にする (0 で埋めない)
  let reportedTotal: number | null = 0
  for (const row of rows) {
    if (row.reportedTotal === null) {
      reportedTotal = null
      break
    }
    reportedTotal += row.reportedTotal
  }
  const uniformRate = (pick: (r: SalaryCsvRow) => number | null): number | null => {
    const value = pick(first)
    return rows.every(r => pick(r) === value) ? value : null
  }
  return {
    ...first,
    company: rows.map(r => r.company).join(' / '),
    amounts,
    reportedTotal,
    rates: { base: uniformRate(r => r.rates.base), overtime: uniformRate(r => r.rates.overtime) },
  }
}

/** 給与区分 (`SHAIN3.KKUBUN`)。給与大臣の社員情報画面「2 給与区分」の並び順。 */
export const PAY_KUBUN_MONTHLY = 1
export const PAY_KUBUN_DAILY = 2
export const PAY_KUBUN_HOURLY = 3

/**
 * 「基本給(計算)」= 給与明細の【補助】基本単価 × システム集計。**単価の単位が
 * 給与区分で変わる**ので掛ける相手を変える (Refs #429)。
 *
 * | 区分 | 計算 |
 * |---|---|
 * | 2 日給 | 日額 × 稼働日数 |
 * | 3 時給 | 時給 × 実働時間 |
 * | 1 月給 / 4 その他 / 不明 | **null (「単価なし」)** |
 *
 * 月給を null にするのは、月額に稼働日数を掛けても実額に対応しないため。実額
 * (`csvBase`) 側だけが残り、意味のない差が出なくなる。**不明も null に倒す**のが
 * 要点で、既定を日給にすると月給者へ日額計算を掛ける今回の壊れ方が再発する。
 *
 * 時給の実働時間はタイムカード由来なら「拘束 − 中抜け − 昼休憩」(Refs #424 PR-B)、
 * デジタコ由来なら CSV の実働がそのまま入る。
 */
export function computeSysBase(
  baseRate: number | null,
  payKubun: number | null,
  workDays: number,
  workingMinutes: number,
): number | null {
  if (baseRate === null) return null
  if (payKubun === PAY_KUBUN_DAILY) return Math.round(baseRate * workDays)
  if (payKubun === PAY_KUBUN_HOURLY) return Math.round((baseRate * workingMinutes) / 60)
  return null
}

/**
 * 対象月の CSV 行と wage-report を乗務員CD (数値同値) で突合する。
 * 給与コードが乗務員CDと別体系の乗務員は cdMap (給与コード|氏名 → 乗務員CD) で
 * 引き当てる。同一乗務員の行が重複していたら後勝ち + 警告。
 *
 * 同じ乗務員CD に**複数会社の氏名一致行**が来たら同一人物として合算する
 * (Refs #403)。氏名が一致しない行だけを `conflicts` に隔離する。
 */
export function compareSalaryMonth(
  csvRows: SalaryCsvRow[],
  reportRows: WageReportRow[],
  config: SalaryItemConfig,
  cdMap: SalaryCdMap = { entries: {} },
): SalaryComparison {
  const warnings: string[] = []

  // 乗務員CD (前ゼロ除去) → 氏名の正規化キー。デジタコの乗務員一覧を正として、
  // 給与コードは氏名で照合してから初めて信用する (Refs #253)。生の給与コードが
  // 乗務員CDと数字だけ一致していても、氏名まで一致しなければ「その人だと確認
  // できた」ことにはならない — 会社が違えば給与コードの体系は無関係なので、
  // 数字の一致は単なる偶然でしかありえない。
  const reportNameByCd = new Map<string, string>()
  for (const r of reportRows) {
    reportNameByCd.set(String(Number(r.summary.driverCd)), normalizeNameKey(r.summary.driverName))
  }

  // 「確認済み」の行だけを乗務員CDごとにグループ化する。確認済み = ①突合
  // マスタに明示登録済み (氏名一致の自動設定 or 手動登録を保存済み)、または
  // ②生の給与コードが乗務員CDと数字・氏名の両方一致 (本当の直接一致)。
  // どちらの確認も取れない行は最初からキーの取り合いに参加させず、単なる
  // 未突合 (csvOnly) へ回す — 当てずっぽうの数字一致を突合の当事者にしない。
  // 同一識別子 (会社+氏名) の重複行は従来どおり後勝ち + 警告。複数の異なる
  // 確認済み行が同じキーに来るのは、登録ミス等で機械的に決められない本当の
  // 衝突なので conflicts に隔離する。
  const byKey = new Map<string, Map<string, SalaryCsvRow>>()
  const unverified: SalaryCsvRow[] = []
  for (const row of csvRows) {
    const mapped = lookupCdMap(row, cdMap)
    const directVerified = reportNameByCd.get(row.cdKey) === normalizeNameKey(row.driverName)
    const key = mapped ?? (directVerified ? row.cdKey : null)
    if (key === null) {
      unverified.push(row)
      continue
    }
    const identity = `${row.company}|${normalizeNameKey(row.driverName)}`
    const byIdentity = byKey.get(key) ?? new Map<string, SalaryCsvRow>()
    if (byIdentity.has(identity)) {
      warnings.push(`乗務員 ${row.driverCd} の行が重複しています (後の行を採用)`)
    }
    byIdentity.set(identity, row)
    byKey.set(key, byIdentity)
  }

  // 同じ乗務員CD に複数の会社の行が来た時、**氏名が一致すれば同一人物**として
  // 合算する (Refs #403 — 有限会社と株式会社の両方から支給される乗務員が実在し、
  // 従来は conflicts に隔離されて最低賃金チェックから落ちていた)。氏名が一致
  // しないのは同名別人か登録ミスなので、合算せず conflicts へ隔離する。
  const byCd = new Map<string, { row: SalaryCsvRow, mergedFrom: SalaryComparisonRow['mergedFrom'] }>()
  const conflicts: SalaryComparison['conflicts'] = []
  for (const [key, byIdentity] of byKey.entries()) {
    const grouped = [...byIdentity.values()]
    if (new Set(grouped.map(row => normalizeNameKey(row.driverName))).size > 1) {
      const entries = grouped.map(row => ({
        company: row.company, driverCd: row.driverCd, driverName: row.driverName,
      }))
      conflicts.push({ driverCd: key, entries })
      warnings.push(
        `乗務員CD ${key} に氏名の異なる複数の給与コードが解決されました `
        + `(${entries.map(e => `${e.company || '会社未設定'}:${e.driverCd} ${e.driverName}`).join(' / ')}) `
        + '— 同名別人か登録ミスの可能性があります。社員マスタで引き当て直してください',
      )
      continue
    }
    if (grouped.length === 1) {
      byCd.set(key, { row: grouped[0]!, mergedFrom: null })
      continue
    }
    const sorted = [...grouped].sort((a, b) => compareCompanyLabel(a.company, b.company))
    const merged = mergeSalaryCsvRows(sorted)
    byCd.set(key, { row: merged, mergedFrom: sorted.map(r => ({ company: r.company, driverCd: r.driverCd })) })
    const rateNote = merged.rates.base === null || merged.rates.overtime === null
      ? ' — 会社ごとに単価が異なるため計算列は「単価なし」になります'
      : ''
    warnings.push(
      `乗務員CD ${key} は複数会社の給与行を 1 人として合算しました `
      + `(${sorted.map(r => `${r.company || '会社未設定'}:${r.driverCd}`).join(' / ')})${rateNote}`,
    )
  }

  const rows: SalaryComparisonRow[] = []
  const reportOnly: SalaryComparison['reportOnly'] = []

  for (const report of reportRows) {
    const cdKey = String(Number(report.summary.driverCd))
    const hit = byCd.get(cdKey)
    if (!hit) {
      reportOnly.push({ driverCd: report.summary.driverCd, driverName: report.summary.driverName })
      continue
    }
    const csv = hit.row
    const sums = sumByCategory(csv, config)
    const base = sums.buckets['base'].total
    const overtime = sums.buckets['overtime'].total
    const workDays = report.summary.workDays
    const workingMinutes = report.summary.workingMinutes ?? 0
    const overtimeMinutes = (report.summary.overtimeMinutes ?? 0) + (report.summary.overtimeNightMinutes ?? 0)

    // 計算側: CSV の単価 × システム集計。単価が無い行は独自の按分計算をせず null
    // (「単価なし」— 最低賃金比較は既存の最低賃金チェックタブに任せる、Refs #253)。
    //
    // **基本単価の掛け方は給与区分で変わる** (Refs #429)。以前は全員を日給者と
    // みなして `単価 × 稼働日数` にしていたため、月給者では桁が 1 つ以上ずれた値が
    // 「差」として並んでいた (実データで基本給 165,000 の月給者に 2,640,000)。
    // 残業側は区分に関わらず時給単価なので従来どおり。
    const sysBase = computeSysBase(csv.rates.base, report.pay_kubun ?? null, workDays, workingMinutes)
    const sysOvertime = csv.rates.overtime !== null ? Math.round((csv.rates.overtime * overtimeMinutes) / 60) : null
    const sysTotal = sysBase !== null && sysOvertime !== null ? sysBase + sysOvertime : null

    // 支払い実績 (csvOvertime) と直接比較する最低賃金理論値。時間軸は
    // 「最低賃金チェック」タブと同じ (時間外+時間外深夜+週40超過)。
    const minWageOvertimeMinutes = report.wage.overtimeMinutes + report.wage.nightOvertimeMinutes
    const minWageOvertimePay
      = report.wage.minWageOvertimePay !== null && report.wage.minWageNightOvertimePay !== null
        ? report.wage.minWageOvertimePay + report.wage.minWageNightOvertimePay
        : null

    // 基礎単価(実績) = 割増基礎算入分 ÷ デジタコ法定内時間 と、それを基礎額に
    // した割増残業代の理論値 (労基法37条の主判定、Refs #278)。時間軸は
    // 残業(最低賃金) と同じ — 週40超過分を含む。
    const statutoryMinutes = report.wage.minutes.statutory
    const baseRateActual = statutoryMinutes > 0 && sums.premiumBase.total > 0
      ? sums.premiumBase.total / (statutoryMinutes / 60)
      : null
    const baseRateOvertimePay = baseRateActual !== null
      ? computeOvertimePayAtRate(minWageOvertimeMinutes, report.wage.nightOvertimeMinutes, baseRateActual)
      : null

    rows.push({
      driverCd: csv.driverCd,
      mappedDriverCd: csv.cdKey === cdKey ? null : report.summary.driverCd,
      driverName: csv.driverName,
      mergedFrom: hit.mergedFrom,
      csvBase: base,
      csvBaseItems: sums.buckets['base'].items,
      csvOvertime: overtime,
      csvOvertimeItems: sums.buckets['overtime'].items,
      csvOvertimeHours: csvOvertimeHoursOf(csv),
      csvTotal: sums.total,
      csvReportedTotal: csv.reportedTotal,
      sysBase,
      sysOvertime,
      sysTotal,
      sysWorkDays: workDays,
      sysOvertimeMinutes: overtimeMinutes,
      diffBase: sysBase === null ? null : base - sysBase,
      diffOvertime: sysOvertime === null ? null : overtime - sysOvertime,
      diffTotal: sysTotal === null ? null : sums.total - sysTotal,
      csvPremiumBase: sums.premiumBase.total,
      csvPremiumBaseItems: sums.premiumBase.items,
      csvMinWageEligible: sums.minWageEligible.total,
      csvMinWageEligibleItems: sums.minWageEligible.items,
      statutoryMinutes,
      baseRateActual,
      baseRateOvertimePay,
      diffCsvVsBaseRateOvertime: baseRateOvertimePay === null ? null : overtime - baseRateOvertimePay,
      minWageOvertimeMinutes,
      minWageOvertimePay,
      diffCsvVsMinWageOvertime: minWageOvertimePay === null ? null : overtime - minWageOvertimePay,
      attendanceDays: buildAttendanceDays(report, csv),
    })
  }

  // csvOnly は「乗務員CDが未確認」の行だけ。乗務員CDが確定済み (byCd) でも
  // 今月の wage-report にその乗務員がいないだけの行 (退職・休職等) は、比較
  // 対象が無いだけで人が確認する対象ではないので、ここにもどこにも出さない。
  const csvOnly: SalaryComparison['csvOnly'] = unverified.map(row => ({
    driverCd: row.driverCd, driverName: row.driverName, company: row.company,
  }))

  return { rows, csvOnly, reportOnly, conflicts, warnings }
}
