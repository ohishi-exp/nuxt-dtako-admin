/**
 * `.datr` / `.bakr` ログ (1 行 = 1 撮影) の解析と一括検索。
 *
 * 1 行の形 (カンマ区切り、ファイル名だけ "" 囲み):
 *   `1029,0,43019,8.215278E-02,"17101101581600001029.jpg","",0,0,0,0`
 *   - 列 1: コード
 *   - 列 3: 日付 (Excel シリアル。43019 = 2017-10-11)
 *   - 列 4: 時刻 (1 日に対する割合。0.5 = 12:00:00)
 *   - 列 5: 画像ファイル名
 *
 * `.bakr` は `.datr` の控えで中身が同じことが多い。同じ行は 1 件に畳み、
 * どのファイルに入っていたかは `sources` に残す。
 */

export interface DatrRecord {
  code: string
  /** `yyyy-mm-dd` */
  date: string
  /** `HH:MM:SS` */
  time: string
  image: string
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
  const [code, , dateCol, timeCol, image] = cols as [string, string, string, string, string]
  const serial = Number(dateCol)
  const fraction = Number(timeCol)
  if (!code || !Number.isInteger(serial) || serial <= 0 || !Number.isFinite(fraction) || fraction < 0 || fraction >= 1) return null
  return { code, date: serialToDate(serial), time: fractionToTime(fraction), image }
}

export interface DatrParseResult {
  records: DatrRecord[]
  /** 読めなかった行 (空行は数えない) */
  skipped: { source: string, line: number, text: string }[]
}

/**
 * 複数ファイルを読んで 1 本にまとめる。同じ行は 1 件に畳み、日時順に並べる。
 */
export function parseDatrFiles(files: { name: string, text: string }[]): DatrParseResult {
  const byKey = new Map<string, DatrRecord>()
  const skipped: DatrParseResult['skipped'] = []
  for (const file of files) {
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
  const records = [...byKey.values()].sort((a, b) =>
    `${a.date} ${a.time} ${a.code}`.localeCompare(`${b.date} ${b.time} ${b.code}`))
  return { records, skipped }
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
}

export interface DatrSearchResult {
  hits: DatrRecord[]
  /** 指定コードごとの件数 (指定順。0 件も含む) */
  perCode: { code: string, count: number }[]
}

export function searchDatr(records: DatrRecord[], q: DatrQuery): DatrSearchResult {
  const wanted = new Set(q.codes)
  const hits = records.filter(r =>
    (wanted.size === 0 || wanted.has(r.code))
    && (!q.from || r.date >= q.from)
    && (!q.to || r.date <= q.to))
  const counts = new Map<string, number>()
  for (const r of hits) counts.set(r.code, (counts.get(r.code) ?? 0) + 1)
  const perCode = q.codes.map(code => ({ code, count: counts.get(code) ?? 0 }))
  return { hits, perCode }
}
