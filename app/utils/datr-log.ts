/**
 * 撮影ログ (1 行 = 1 回の測定) の解析と一括検索。拡張子は年代で違い、
 * 2017 年は `.datr` / `.bakr`、2026 年は `.dat` / `.bak` (中身の形は同じ)。
 *
 * 1 行の形 (カンマ区切り、ファイル名だけ "" 囲み):
 *   `1029,0,43019,8.215278E-02,"17101101581600001029.jpg","",0,0,0,0`
 *   - 列 1: コード
 *   - 列 2: アルコール値 (2026-11-28 のファイルで `.062` の行があり、同じコードが
 *     約 30 分後に測り直して 0。単位はファイルに無く未確認)
 *   - 列 3: 日付 (Excel シリアル。43019 = 2017-10-11)
 *   - 列 4: 時刻 (1 日に対する割合。0.5 = 12:00:00)
 *   - 列 5: 画像ファイル名
 *   - 列 6 以降: 意味が未確定 (手元のデータは全部 "" か 0)。`extra` にそのまま残す
 *
 * `.bakr` / `.bak` は `.datr` / `.dat` の控えで中身が同じことが多い。同じ行は 1 件に畳み、
 * どのファイルに入っていたかは `sources` に残す。
 */

import type { IchibanLeaveEmployeeRow } from './employee-master'

export interface DatrRecord {
  code: string
  /** `yyyy-mm-dd` */
  date: string
  /** `HH:MM:SS` */
  time: string
  image: string
  /** アルコール値 (列 2 の生の文字列。`.062` のように先頭の 0 が無いことがある) */
  alcohol: string
  /** 意味が未確定の列 (列 6 以降) の生の値 */
  extra: string[]
  /** この行が入っていたファイル名 (重複を畳んだ数だけ並ぶ) */
  sources: string[]
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)

const pad = (n: number) => String(n).padStart(2, '0')

function serialToDate(serial: number): string {
  const d = new Date(EXCEL_EPOCH_MS + serial * 86400000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function fractionToTime(fraction: number): string {
  const sec = Math.min(Math.round(fraction * 86400), 86399)
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`
}

/**
 * 1 行を読む。形が合わない行 (空行・列不足・数値でない日付) は null。
 */
export function parseDatrLine(line: string): Omit<DatrRecord, 'sources'> | null {
  const cols = line.trim().split(',').map(c => c.replace(/^"|"$/g, ''))
  if (cols.length < 5) return null
  const [code, alcohol, dateCol, timeCol, image] = cols as [string, string, string, string, string]
  const serial = Number(dateCol)
  const fraction = Number(timeCol)
  if (!code || !Number.isInteger(serial) || serial <= 0 || !Number.isFinite(fraction) || fraction < 0 || fraction >= 1) return null
  return { code, date: serialToDate(serial), time: fractionToTime(fraction), image, alcohol, extra: cols.slice(5) }
}

/** アルコール値が 0 でないか (空や数値でないものも「0 でない」に数えて見落とさない) */
export function hasAlcohol(r: Pick<DatrRecord, 'alcohol'>): boolean {
  return Number(r.alcohol || 'x') !== 0
}

/** 対象のログファイルか (拡張子で判定) */
export function isDatrLogFile(name: string): boolean {
  return /\.(datr?|bakr?)$/i.test(name)
}

export interface DatrParseResult {
  records: DatrRecord[]
  /** 読めなかった行 (空行は数えない) */
  skipped: { source: string, line: number, text: string }[]
}

/**
 * 読み込みの途中でも結果を出せるよう、ファイルを 1 本ずつ足していく入れ物。
 * 同じ行は 1 件に畳み、`records()` で日時順の配列を返す。
 */
export class DatrIndex {
  private byKey = new Map<string, DatrRecord>()
  readonly skipped: DatrParseResult['skipped'] = []

  add(file: { name: string, text: string }): void {
    const { byKey, skipped } = this
    file.text.split(/\r?\n/).forEach((text, i) => {
      if (!text.trim()) return
      const rec = parseDatrLine(text)
      if (!rec) {
        skipped.push({ source: file.name, line: i + 1, text })
        return
      }
      const key = `${rec.code}|${rec.date}|${rec.time}|${rec.image}`
      const hit = byKey.get(key)
      if (hit) hit.sources.push(file.name)
      else byKey.set(key, { ...rec, sources: [file.name] })
    })
  }

  records(): DatrRecord[] {
    // 数十万件になるので localeCompare は使わず、キーを先に作って比べる。
    // キーは Map のキーと同じ要素から作るので重複しない (同値の比較は起きない)
    return [...this.byKey.values()]
      .map(r => [`${r.date} ${r.time} ${r.code} ${r.image}`, r] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([, r]) => r)
  }
}

/** 複数ファイルを読んで 1 本にまとめる。同じ行は 1 件に畳み、日時順に並べる。 */
export function parseDatrFiles(files: { name: string, text: string }[]): DatrParseResult {
  const index = new DatrIndex()
  for (const file of files) index.add(file)
  return { records: index.records(), skipped: index.skipped }
}

/** 改行・カンマ・空白・読点で区切ったコードの一覧 (重複除去、入力順) */
export function parseCodeList(input: string): string[] {
  return [...new Set(input.split(/[\s,、]+/).filter(Boolean))]
}

export interface DatrQuery {
  /** 空なら全コード */
  codes: string[]
  /** `yyyy-mm-dd`。空なら下限なし */
  from: string
  /** `yyyy-mm-dd`。空なら上限なし */
  to: string
  /** true ならアルコール値が 0 でない行だけ */
  alcoholOnly?: boolean
  /** 結果から外すコード (コード指定より優先) */
  excludeCodes?: string[]
}

export interface DatrSearchResult {
  hits: DatrRecord[]
  /** 指定コードごとの件数 (指定順。0 件も含む) */
  perCode: { code: string, count: number }[]
}

/** 既定で外すコード (2017 年のデータに混ざっていた 99999999。画面のチェックで外せる) */
export const DEFAULT_EXCLUDED_CODES = ['99999999']

export function searchDatr(records: DatrRecord[], q: DatrQuery): DatrSearchResult {
  const wanted = new Set(q.codes)
  const excluded = new Set(q.excludeCodes)
  const hits = records.filter(r =>
    (wanted.size === 0 || wanted.has(r.code))
    && !excluded.has(r.code)
    && (!q.from || r.date >= q.from)
    && (!q.to || r.date <= q.to)
    && (!q.alcoholOnly || hasAlcohol(r)))
  const counts = new Map<string, number>()
  for (const r of hits) counts.set(r.code, (counts.get(r.code) ?? 0) + 1)
  const perCode = q.codes.map(code => ({ code, count: counts.get(code) ?? 0 }))
  return { hits, perCode }
}

/**
 * 通算回数の元: 読み込んだ全ログで、コードごとにアルコール検知 (値が 0 でない行) のあった日の一覧
 * (昇順・重複なし)。**同じ日に何回検知しても 1 回**と数えるため日単位にする。
 * 期間などの絞り込みに関係なく作る。検知の無いコードは載らない
 */
export function alcoholDaysByCode(records: DatrRecord[]): Map<string, string[]> {
  const days = new Map<string, Set<string>>()
  for (const r of records) {
    if (!hasAlcohol(r)) continue
    const set = days.get(r.code) ?? new Set<string>()
    set.add(r.date)
    days.set(r.code, set)
  }
  return new Map([...days].map(([code, set]) => [code, [...set].sort()]))
}

/** `date` の日までに検知した日数 (その日を含む)。検知の無いコードは 0 */
export function alcoholDayCountUntil(days: Map<string, string[]>, code: string, date: string): number {
  return (days.get(code) ?? []).filter(d => d <= date).length
}

export interface EmployeeInfo {
  name: string
  /** 入社年月日 (`YYYY-MM-DD`)。未設定は null */
  hireDate: string | null
  /** 退職年月日 (`YYYY-MM-DD`)。在籍中・未設定は null */
  retireDate: string | null
}

/**
 * 一番星 社員ﾏｽﾀ (`GET /api/leave/employees`) から「コード → 氏名・入社日・退職日」の表を作る。
 * ログのコードは一番星の社員C と同じ番号体系 (dtako 乗務員CD と同じ。
 * `app/utils/employee-master.ts` の `IchibanEmployeeRow` 参照)。
 *
 * 退職者は一番星で氏名の先頭に `×` が付くが、古いログはその人の記録なので落とさず
 * そのまま出す。コードが空の行は捨てる (氏名が空でも日付があれば残す)。
 */
export function buildEmployeeInfoMap(rows: IchibanLeaveEmployeeRow[]): Map<string, EmployeeInfo> {
  const map = new Map<string, EmployeeInfo>()
  for (const row of rows) {
    const code = row.employee_code.trim()
    if (code) map.set(code, { name: row.employee_name.trim(), hireDate: row.hire_date, retireDate: row.retire_date })
  }
  return map
}
