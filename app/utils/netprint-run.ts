/**
 * 運転日報 netprint 手動実行 (Refs #874 の 5) の **画面側と server route が共有する
 * pure な部品**。`POST /api/netprint/run` の応答の正規化と、relay が返す target ごとの
 * `detail` (DO の応答本文が文字列に畳まれている) を画面に出せる形にほどく部分を持つ。
 *
 * body の検証は `server/utils/netprint-run.ts` (server 側だけが使う)。app → server の
 * import は無い流儀なので、画面が使う側をこちらに置き、server が `~/utils/netprint-run`
 * を import する (`net780-archive.ts` と同じ向き)。
 *
 * ## 応答が 2 段に畳まれている
 *
 * ```
 * front  POST /api/netprint/run            {date?, branch_cd?, channel_id?, branch_name?, operation_no?, comp_id?}
 *   └ relay POST /kintai-relay/netprint-run
 *       └ DO POST /cron/netprint           ← cron と同じ道 (#874-4)
 * ```
 *
 * relay は target ごとに DO を呼び、結果を **`{kind, target: "compId|branchCd", ok,
 * detail: "HTTP {status}: {DO の応答本文を 200 字で切ったもの}"}`** に畳んで返す
 * (`cron.ts` の `dispatchNetprintTargets`)。DO の応答本文は成功なら
 * `{ok, results: [{detail, branch_cd, channel_id, ok, rows, operations}], theearth_logins}`、
 * 失敗なら `{error}`。**予約番号はこの内側にしか無い**ので、画面に出すにはここで
 * ほどく必要がある。**200 字打ち切りで JSON として壊れていることがある**ので、
 * JSON にならなくても予約番号だけは正規表現で拾い、原文も併せて残す。
 *
 * ## 予約番号は 2 か所から拾う (Refs #874 の 13)
 *
 * **1 運行 = 1 予約番号**になり、番号は `operations[].print_id` に並ぶ。ところが
 * `operations` は JSON の後ろの方にあり、**9 運行の日は 200 字の打ち切りより後ろへ
 * 落ちて 1 つも読めない**。DO 側はこれを見越して target の `detail` の先頭付近に
 * `予約番号 A / B / C` の形でも載せているので、**JSON と本文テキストの両方から拾って
 * 重複を潰す**。片方だけにすると、日によって番号が画面から消える。
 */

/** `date` に受け付ける形式 (relay の `NETPRINT_DATE_RE` と同じ)。 */
export const NETPRINT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** `operation_no` に受け付ける形式 = theearth の運行No 22 桁 (relay の
 * `NETPRINT_OPERATION_NO_RE` と同じ。実測 `2608241017180000003046` =
 * 読取日 2026-08-24 / 本社営業所 の 1 運行)。 */
export const NETPRINT_OPERATION_NO_RE = /^\d{22}$/

/** `POST /api/netprint/run` の body。**全部省略可** (relay と同じ契約)。
 * `branch_cd` と `channel_id` は「両方揃っているか、両方無いか」。 */
export interface NetprintRunInput {
  /** 省略で前日 (JST) = cron と同じ対象日。 */
  date?: string
  branch_cd?: string
  channel_id?: string
  branch_name?: string
  /** 運行No (22 桁)。指定するとその**1 運行だけ**を登録・通知する (Refs #913)。
   *
   * #902 以降は 1 運行 = 1 PDF = 1 予約番号 = 通知 1 通なので、これが無いと
   * 「1 件だけ試す」ができず、**その日その営業所の運行数だけ実在の担当者へ通知が
   * 飛ぶ** (本番で 3 通飛ばした)。営業所の絞り込みの後に掛かるので、通知先の
   * 解決 (`NETPRINT_TARGETS`) は変わらない。 */
  operation_no?: string
  comp_id?: string
}

/** relay が返す target 1 件ぶんの結果 (`CronRunResult`)。 */
export interface NetprintRunResultItem {
  /** `${comp_id}|${branch_cd}` */
  target: string
  ok: boolean
  /** `HTTP {status}: {DO の応答本文}`、または relay 側で投げられた例外の message。 */
  detail: string
}

/** 画面が扱う 1 回ぶんの実行結果 (成功も失敗も同じ形。fetch 自体の失敗だけは投げる)。 */
export interface NetprintRunOutcome {
  /** 全 target が成功したか。 */
  ok: boolean
  /** `/api/netprint/run` の HTTP status。 */
  status: number
  /** relay が実際に使った対象日 (省略時は relay が前日 JST を入れる)。 */
  date: string | null
  results: NetprintRunResultItem[]
  /** route / relay が返した失敗の理由 (成功なら null)。 */
  error: string | null
}

/** 対象日の既定値 = 前日 (JST)。relay の `yesterdayJst` と同じ日を出す。 */
export function yesterdayJstYmd(now: Date): string {
  const jstYesterday = new Date(now.getTime() + 9 * 3600_000 - 24 * 3600_000)
  return jstYesterday.toISOString().slice(0, 10)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  return value as Record<string, unknown>
}

/** 応答から target ごとの結果を取り出す。形が違う要素は落とさず既定値で受ける
 * (relay が知らない形を返したら「空の行」として見えた方が、黙って消えるより良い)。 */
function readResults(value: unknown): NetprintRunResultItem[] {
  const rec = asRecord(value)
  if (rec === null || !Array.isArray(rec.results)) return []
  const items: NetprintRunResultItem[] = []
  for (const raw of rec.results) {
    const r = asRecord(raw)
    if (r === null) continue
    items.push({
      target: typeof r.target === 'string' ? r.target : '',
      ok: r.ok === true,
      detail: typeof r.detail === 'string' ? r.detail : '',
    })
  }
  return items
}

function readDate(value: unknown): string | null {
  const date = asRecord(value)?.date
  return typeof date === 'string' ? date : null
}

/**
 * `POST /api/netprint/run` の応答を画面が読む形に揃える。
 *
 * - 2xx: relay の `{ok, date, results}` をそのまま読む
 * - 非 2xx: server route が `createError` で返す `{statusMessage, message, data}` を読む。
 *   **`data` には relay の応答 (target ごとの `results`) がそのまま載っている** ので、
 *   一部の営業所だけ失敗した 502 でも各営業所の理由が画面に出る
 */
export function normalizeNetprintRunOutcome(status: number, ok: boolean, body: unknown): NetprintRunOutcome {
  const rec = asRecord(body)
  if (ok) {
    return { ok: rec?.ok === true, status, date: readDate(body), results: readResults(body), error: null }
  }
  const statusMessage = rec?.statusMessage
  const message = rec?.message
  const error = typeof statusMessage === 'string'
    ? statusMessage
    : typeof message === 'string' ? message : `HTTP ${status}`
  return { ok: false, status, date: readDate(rec?.data), results: readResults(rec?.data), error }
}

/** 画面の 1 行 (営業所 1 件ぶん)。 */
export interface NetprintTargetView {
  /** `${comp_id}|${branch_cd}` の営業所コード側。 */
  branchCd: string
  ok: boolean
  /** プリント予約番号 (netprint の `printID`)。取れなければ空配列。 */
  printIds: string[]
  /** 成否の理由として画面に出す 1 行。 */
  message: string
}

/** relay が付ける `HTTP {status}: ` の前置き。 */
const HTTP_DETAIL_RE = /^HTTP \d{3}: ([\s\S]*)$/
/** 200 字打ち切りで JSON が壊れていても予約番号だけは拾う (`operations[].print_id`)。 */
const PRINT_ID_RE = /"print_id"\s*:\s*"([0-9A-Za-z]+)"/g
/** target の `detail` が先頭付近に載せる `予約番号 A / B / C` から拾う。予約番号は
 * 8 桁英数固定なので、打ち切りで途中まで残った端数は**マッチさせない** (半端な
 * 番号を画面に出すと、入力しても通らない番号を人が試すことになる)。 */
const PRINT_ID_SUMMARY_RE = /予約番号 ([0-9A-Za-z]{8}(?: \/ [0-9A-Za-z]{8})*)/g

/** 応答本文から予約番号を拾う (JSON と本文テキストの両方、出現順で重複を潰す)。 */
function readPrintIds(body: string): string[] {
  const ids = [...body.matchAll(PRINT_ID_RE)].map(m => m[1]!)
  for (const m of body.matchAll(PRINT_ID_SUMMARY_RE)) ids.push(...m[1]!.split(' / '))
  return [...new Set(ids)]
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text))
  }
  catch {
    return null
  }
}

/** DO の応答本文 (`{ok, results}` / `{error}`) を 1 行の日本語にする。読めなければ null。 */
function describeDoBody(doc: Record<string, unknown> | null): string | null {
  if (doc === null) return null
  if (typeof doc.error === 'string') return doc.error
  if (!Array.isArray(doc.results)) return null
  const details = doc.results
    .map(raw => asRecord(raw)?.detail)
    .filter((detail): detail is string => typeof detail === 'string')
  return details.length === 0 ? null : details.join(' / ')
}

/** relay の 1 件を画面の 1 行にほどく。 */
export function viewNetprintRunResult(item: NetprintRunResultItem): NetprintTargetView {
  const sep = item.target.indexOf('|')
  const branchCd = sep < 0 ? item.target : item.target.slice(sep + 1)
  const matched = HTTP_DETAIL_RE.exec(item.detail)
  // DO を呼ぶ前に relay 側で例外になった場合は前置きが無く、message がそのまま入る。
  const body = matched === null ? item.detail : matched[1]!
  return {
    branchCd,
    ok: item.ok,
    printIds: readPrintIds(body),
    message: describeDoBody(parseJsonObject(body)) ?? body,
  }
}
