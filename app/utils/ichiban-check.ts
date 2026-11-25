/**
 * 社内 CakePHP の「一番星×デジタコ突合」(relay の `GET /restraint-api/kintai/ichiban-check`) の応答を、
 * 画面の 1 行 = 1 差分 に畳む純粋ロジック。
 *
 * **粗利タブの月次突合 (`profit/margin.vue`) とは別物。** こちらは CakePHP が「一番星へ取り込む CSV を ichizip に
 * 出し直すべき運行」を選ぶための差分で、数字は一致しない。
 *
 * 応答の形 (yhonda-ohishi/nginx#826):
 * - `diffs.勤怠[項目][乗務員CD][YYYY-MM-DD]` = 一番星の値、`[…][YYYY-MM-DD差分]` = 差分
 * - `diffs.{燃料,経費,旅費残業,支払日}[乗務員CD][キー]` = 値。旅費残業・支払日は `キー差分`・`キー_車両番号`・`キー_部門` も並ぶ
 * - `ids` は `diffs` と同じ入れ子で、葉が `dtako_rows.id` (23 桁) の配列。経費の 8 桁キーは `[]` (一番星に対応コードが無く、CSV にしない)
 * - 値は数値のことも文字列のこともある (CakePHP の元データのまま)
 */

export const ICHIBAN_CHECK_CATEGORIES = ['勤怠', '燃料', '経費', '旅費残業', '支払日'] as const
export type IchibanCheckCategory = typeof ICHIBAN_CHECK_CATEGORIES[number]

type Nested<T> = Record<string, Record<string, T>>

export interface IchibanCheckResponse {
  month?: string
  diffs?: Partial<Record<IchibanCheckCategory, unknown>>
  ids?: Partial<Record<IchibanCheckCategory, unknown>>
  idds?: unknown
  drivers?: unknown
  etcExcludedRowIds?: unknown
}

export interface IchibanCheckRow {
  /** 画面の行キー (項目内で一意)。 */
  key: string
  category: IchibanCheckCategory
  /** 勤怠の内訳 (運転・作業・待機・休憩・休息)。勤怠以外は空。 */
  item: string
  driverCd: string
  driverName: string
  /** 日付 (勤怠) か CakePHP のキー (運行日 + 車番・経費コード等)。 */
  label: string
  value: string
  diff: string
  vehicle: string
  dept: string
  /** CSV にする `dtako_rows.id`。空なら CSV にできない行 (経費の未マッピング等)。 */
  ids: string[]
  /** ETC 連携を除外中の車両の運行を含む (経費の差分がそれで説明できる)。 */
  etcExcluded: boolean
}

const SUFFIXES = ['差分', '_車両番号', '_部門', '_dtako_row_id'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asNested(v: unknown): Nested<unknown> {
  if (!isRecord(v)) return {}
  const out: Nested<unknown> = {}
  for (const [k, inner] of Object.entries(v)) {
    if (isRecord(inner)) out[k] = inner
  }
  return out
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function text(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'string') return String(v)
  return ''
}

/** `キー差分` などの付き物を外した本体のキー。付き物でなければそのまま。 */
export function baseKey(key: string): string {
  for (const s of SUFFIXES) {
    if (key.endsWith(s) && key.length > s.length) return key.slice(0, -s.length)
  }
  return key
}

/** 乗務員 1 人ぶんの `{キー: 値}` を、本体のキーごとの行の材料にする。 */
function rowsOfDriver(
  values: Record<string, unknown>,
  ids: Record<string, unknown> | undefined,
): Array<Pick<IchibanCheckRow, 'label' | 'value' | 'diff' | 'vehicle' | 'dept' | 'ids'>> {
  const bases = [...new Set(Object.keys(values).map(baseKey))].sort()
  return bases.map(b => ({
    label: b,
    value: text(values[b]),
    diff: text(values[`${b}差分`]),
    vehicle: text(values[`${b}_車両番号`]),
    dept: text(values[`${b}_部門`]),
    ids: [...new Set([...stringList(ids?.[b]), ...stringList(ids?.[`${b}差分`])])],
  }))
}

/** 応答を表の行へ。並びは 項目 → (勤怠の内訳) → 乗務員CD → キー。 */
export function flattenIchibanCheck(res: IchibanCheckResponse): IchibanCheckRow[] {
  const names = isRecord(res.drivers) ? res.drivers : {}
  const etc = new Set(stringList(res.etcExcludedRowIds))
  const rows: IchibanCheckRow[] = []
  const push = (category: IchibanCheckCategory, item: string, byDriver: Nested<unknown>, idsByDriver: Nested<unknown>) => {
    for (const cd of Object.keys(byDriver).sort()) {
      for (const r of rowsOfDriver(byDriver[cd]!, idsByDriver[cd])) {
        rows.push({
          ...r,
          key: `${category}|${item}|${cd}|${r.label}`,
          category,
          item,
          driverCd: cd,
          driverName: text(names[cd]),
          etcExcluded: r.ids.some(id => etc.has(id)),
        })
      }
    }
  }
  for (const category of ICHIBAN_CHECK_CATEGORIES) {
    const diffs = res.diffs?.[category]
    const ids = res.ids?.[category]
    if (category === '勤怠') {
      const byItem = asNested(diffs)
      const idsByItem = asNested(ids)
      for (const item of Object.keys(byItem).sort()) {
        push(category, item, asNested(byItem[item]), asNested(idsByItem[item]))
      }
    }
    else {
      push(category, '', asNested(diffs), asNested(ids))
    }
  }
  return rows
}

/** 行の並びを崩さずに id を重複なく集める。 */
export function idsOfRows(rows: readonly IchibanCheckRow[]): string[] {
  return [...new Set(rows.flatMap(r => r.ids))]
}

/** relay・勤怠 Worker の 1 回あたりの上限 (勤怠 Worker の `MAKECSV_MAX_IDS`)。 */
export const MAKECSV_CHUNK = 500

/** id を 1 回で送れる大きさに分ける。 */
export function chunkIds(ids: readonly string[], size = MAKECSV_CHUNK): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

export type MakecsvStatus = 'written' | 'skipped' | 'error'

export interface MakecsvResult {
  id: string
  status: MakecsvStatus
  reason: string | null
  written: string[]
  message?: string
}

const REASON_LABELS: Record<string, string> = {
  invalid_id: 'id の形が違う',
  not_found: '運行が見つからない',
  not_ending_with_1: '主乗務員の行ではない (末尾が 1 でない)',
  empty_driver_cd1: '乗務員CD1 が空',
  ichizip_folder_missing: 'ichizip の取り込みフォルダが無い',
  exception: '書き出し中に例外',
}

/** 理由コードを日本語へ。知らないコードはそのまま出す。 */
export function describeMakecsvReason(reason: string | null): string {
  if (!reason) return ''
  return REASON_LABELS[reason] ?? reason
}

/** CakePHP の `{results: [...]}` を読む。形が違う要素は落とす。 */
export function parseMakecsvResults(body: unknown): MakecsvResult[] {
  const list = isRecord(body) && Array.isArray(body.results) ? body.results : []
  return list.filter(isRecord).flatMap((r) => {
    const status = r.status
    if (typeof r.id !== 'string' || (status !== 'written' && status !== 'skipped' && status !== 'error')) return []
    return [{
      id: r.id,
      status,
      reason: typeof r.reason === 'string' ? r.reason : null,
      written: stringList(r.written),
      ...(typeof r.message === 'string' ? { message: r.message } : {}),
    }]
  })
}

/** 結果の件数 (書いた / 飛ばした / 失敗)。 */
export function countMakecsv(results: readonly MakecsvResult[]): Record<MakecsvStatus, number> {
  const n: Record<MakecsvStatus, number> = { written: 0, skipped: 0, error: 0 }
  for (const r of results) n[r.status] += 1
  return n
}
