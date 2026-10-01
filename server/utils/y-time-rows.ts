/**
 * Y時間 の Excel に書く行を取ってくる (Refs #1133 c1133-46)。
 *
 * 元は 2 つ在る:
 *
 * | source | 経路 |
 * | --- | --- |
 * | `kintai` | relay `POST /kintai-relay/y-time-shifts` (勤怠の勤務の記録を読んで束ねる) → 上流 `POST /api/dtako/y-time-rows` (勤務の列を行にする) |
 * | `alc` | 上流 `GET /api/dtako/y-time-export` (運行 = デジタコから行を作る。今までの経路) |
 *
 * **行の規則・休憩の欄の配り方・時間の計算はここに 1 行も無い。** relay が返した `shifts` を
 * そのまま上流へ渡し、上流が返した `rows` をそのまま返す (並べ替えない・丸めない・足さない)。
 * wage report と同じ元から作るための口で、2 つ目の計算を置かない。
 *
 * ## どの呼び出しも、まず勤怠の元を試す (Refs #1133 c1133-47)
 *
 * 呼び手は 2 つの route — Excel を作る `POST /api/y-time-export` (訴訟準備の出力タブと Y時間 のページ) と、
 * 行を JSON で返す `POST /api/y-time-rows` (訴訟準備のエラータブの検知と Y時間 のページのプレビュー)。
 * 同じ人・同じ期間なら、どの画面も同じ元の行を見る。運行の元になるのは下の 3 つの形のときだけ。
 *
 * ## 運行の経路へ倒すのは 3 つの形だけ
 *
 * | 形 | `sourceReason` |
 * | --- | --- |
 * | service binding `SCRAPER_RELAY` が無い (手元の dev) | `not_configured` |
 * | relay が 503 で本文の `reason` が {@link RELAY_COMP_ID_UNSET} | `not_configured` |
 * | relay が 403 で本文の `error` が {@link RELAY_OUT_OF_SCOPE} | `out_of_scope` |
 *
 * **binding の有無は relay を呼ぶ前に見る** — `sendToScraperRelay` が投げる 503 (本文なし) と、
 * relay が返した `reason` の無い 503 を、エラーの形から取り違えないため。
 * **それ以外の失敗は倒さずに投げる。** 読めなかったことを、黙って運行の元にすり替えない。
 *
 * ## 1 社固定の認可はここで行う (2 段)
 *
 * 1. relay へ渡す `tenant_id` は**認証結果の値** (`requireAuth`)。利用者の body からは取らない
 * 2. **relay の応答の `tenant_id` が認証結果と一致することを確かめてから**上流へ渡す。
 *    relay の body の `tenant_id` は絞り込みであって認可ではない (relay が実際に読んだ tenant は応答に載る)。
 *    違えば 500 で、勤務を返さず上流も呼ばない
 *
 * 認証結果に `tenant_id` が無いときは照合できないので、relay も上流も呼ばず 500
 * (運行の経路にも倒さない。照合できない状態を通さない)。
 *
 * ## 失敗の運び方
 *
 * 勤怠の経路の失敗には `data.upstream = 'alc'` を**付けない** — 画面は 404 + `upstream: 'alc'` を
 * 「乗務員CD が alc に未登録」と読む。代わりに `data.source = 'kintai'` と、どの段 (`stage`) の
 * どの status・本文の `error` / `reason` かを運ぶ。**relay の本文で運ぶのはその 2 欄だけ。**
 * `statusMessage` は ASCII の決まった語 (日本語は本番で落ちる)、画面に出す 1 文は `message`。
 *
 * 利用者に返す status は、**その人の話のときだけ**そのまま返す (画面は status から「再ログイン」
 * 「送った内容を直す」等の次の一手を組むため):
 *
 * - 上流の 401 / 403 = その人のログイン・権限
 * - **relay の 400** = その人が送った内容 (relay の 400 は乗務員CD・`from` / `to` の形と期間の検証でしか出ない。
 *   例: 期間が relay の上限を超える)。relay の理由は `message` と `data.error` にそのまま載る
 *
 * relay のほかの 4xx (401 / 倒さない形の 403 / 404) と上流のほかの 4xx (400 を含む) は、利用者が送った内容の
 * 話ではないので 502 にする。**期間の上限の規則はここに写さない** (relay が判定し、ここは status を運ぶだけ)。
 */
import { createError } from 'h3'
import type { H3Event } from 'h3'
import type {
  YTimeExcludedShift,
  YTimeExportResponse,
  YTimeRow,
  YTimeRowsResponse,
  YTimeSource,
  YTimeSourceReason,
} from '~/types'
import { alcProxyFetch } from './alc-proxy'
import { cfEnv } from './cf-env'
import { sendToScraperRelay } from './scraper-relay'

/** relay の 403 の本文の `error` (body の `tenant_id` が relay の読む tenant と違う) */
const RELAY_OUT_OF_SCOPE = 'kintai_out_of_scope'
/** relay の 503 の本文の `reason` (relay に勤怠の会社が設定されていない) */
const RELAY_COMP_ID_UNSET = 'kintai_comp_id_unset'

/** relay が入力の検証 (乗務員CD・期間) で返す status。利用者が直せる内容なので、そのまま利用者へ返す */
const RELAY_BAD_INPUT = 400

const RELAY_PATH = '/kintai-relay/y-time-shifts'
/** 応答ヘッダ `x-y-time-excluded` に載せる上限 (全件の件数は `-excluded-reasons` が持つ) */
export const Y_TIME_EXCLUDED_HEADER_LIMIT = 20

export interface YTimeRowsInput {
  driverCd: string
  /** `YYYY-MM-DD` */
  from: string
  /** `YYYY-MM-DD` */
  to: string
}

/** `authorizeScraperRelay` の戻り値がそのまま渡せる形 */
export interface YTimeRowsOptions {
  /** `requireAuth` の結果の `tenant_id` */
  tenantId?: string
  /** 呼び手が解決済みの共有 secret (relay の関門に渡す) */
  sharedSecret: string
}

/**
 * route の body から `driver_cd` / `from` / `to` を読む (`POST /api/y-time-export` と
 * `POST /api/y-time-rows` が共用。同じ検証を 2 つ持たない)。3 つとも空でない文字列でなければ 400。
 * **日付の形と期間の長さはここで見ない** — relay と上流がそれぞれ見る (規則の写しを置かない)。
 */
export function yTimeRowsInputFromBody(body: unknown): YTimeRowsInput {
  const b = isRecord(body) ? body : {}
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const input = { driverCd: text(b.driver_cd), from: text(b.from), to: text(b.to) }
  if (!input.driverCd || !input.from || !input.to) {
    throw createError({ statusCode: 400, statusMessage: 'driver_cd / from / to are required' })
  }
  return input
}

export interface YTimeRowsResult {
  source: YTimeSource
  /** 勤怠を試して運行の元へ倒したときだけ値を持つ */
  sourceReason: YTimeSourceReason | null
  rows: YTimeRow[]
  warnings: string[]
  /** 上流が行を作れなかった勤務 (勤怠の元だけ。運行の元は空) */
  excluded: YTimeExcludedShift[]
  /** 勤務の記録が 1 本も無い月 `YYYY-MM` (勤怠の元だけ。運行の元は空) */
  missingMonths: string[]
  /** 運行の元だけが持つ (勤怠の元には乗務員の名前が無い) */
  driver?: YTimeExportResponse['driver']
  period?: YTimeExportResponse['period']
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')

/** 勤怠の経路の失敗。`upstream: 'alc'` は付けない (ファイル冒頭の「失敗の運び方」)。 */
function kintaiError(
  statusCode: number,
  stage: 'auth' | 'relay' | 'upstream',
  message: string,
  detail: { status?: number, error?: string, reason?: string } = {},
) {
  return createError({
    statusCode,
    statusMessage: `kintai y-time rows failed (${stage})`,
    message,
    data: { source: 'kintai', stage, ...detail },
  })
}

/** 運行の経路 (GET)。非 2xx は `data.upstream = 'alc'` を付けて、上流の status のまま投げる。 */
async function rowsFromAlc(event: H3Event, input: YTimeRowsInput, sourceReason: YTimeSourceReason | null): Promise<YTimeRowsResult> {
  // #434 step 3 (方式 B): rust-alc-api を直叩きせず auth-worker `/alc-proxy` に委譲する。
  // introspect / ACL / OIDC mint / identity 注入は auth-worker 側で行われる。
  const res = await alcProxyFetch(event, {
    path: '/api/dtako/y-time-export',
    query: { driver_cd: input.driverCd, from: input.from, to: input.to },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw createError({
      statusCode: res.status,
      statusMessage: `backend error: ${text || res.statusText}`,
      data: { upstream: 'alc' },
    })
  }
  const data = (await res.json()) as YTimeExportResponse
  return {
    source: 'alc',
    sourceReason,
    rows: data.rows,
    warnings: data.warnings,
    excluded: [],
    missingMonths: [],
    driver: data.driver,
    period: data.period,
  }
}

/** relay の失敗から、運行の経路へ倒す形か (倒すなら理由) を読む。倒さない形は null。 */
function fallbackReasonOf(status: unknown, body: unknown): YTimeSourceReason | null {
  if (!isRecord(body)) return null
  if (status === 403 && body.error === RELAY_OUT_OF_SCOPE) return 'out_of_scope'
  if (status === 503 && body.reason === RELAY_COMP_ID_UNSET) return 'not_configured'
  return null
}

const MONTH_RE = /^\d{4}-\d{2}$/

/** relay の勤務の列。`shifts` の中身は読まずに上流へ渡す (配列であることだけ見る)。 */
async function shiftsFromRelay(
  event: H3Event,
  input: YTimeRowsInput,
  tenantId: string,
  sharedSecret: string,
): Promise<{ shifts: unknown[], missingMonths: string[] } | { fallback: YTimeSourceReason }> {
  let raw: unknown
  try {
    raw = await sendToScraperRelay(event, { sharedSecret }, RELAY_PATH, {
      driver_cd: input.driverCd,
      from: input.from,
      to: input.to,
      tenant_id: tenantId,
    })
  }
  catch (e) {
    const err = (isRecord(e) ? e : {}) as { statusCode?: unknown, data?: unknown }
    const fallback = fallbackReasonOf(err.statusCode, err.data)
    if (fallback) return { fallback }
    const status = typeof err.statusCode === 'number' ? err.statusCode : undefined
    const body = isRecord(err.data) ? err.data : {}
    const error = typeof body.error === 'string' ? body.error : undefined
    const reason = typeof body.reason === 'string' ? body.reason : undefined
    throw kintaiError(
      status !== undefined && (status >= 500 || status === RELAY_BAD_INPUT) ? status : 502,
      'relay',
      `勤怠の勤務の記録を読めませんでした (relay ${status ?? '応答なし'}${error ? `: ${error}` : ''})`,
      { status, error, reason },
    )
  }
  if (!isRecord(raw) || typeof raw.tenant_id !== 'string' || !Array.isArray(raw.shifts)
    || !isStringArray(raw.missing_months) || !raw.missing_months.every(m => MONTH_RE.test(m))) {
    throw kintaiError(502, 'relay', '勤怠の勤務の記録の応答が読めない形でした (relay)')
  }
  // ★ relay が実際に読んだ tenant を、認証済みの身元と突き合わせる。違えば勤務を 1 本も先へ渡さない
  if (raw.tenant_id !== tenantId) {
    throw kintaiError(500, 'auth', '勤怠の勤務の記録が、ログイン中の会社のものではありませんでした')
  }
  return { shifts: raw.shifts, missingMonths: raw.missing_months }
}

function isExcludedShift(v: unknown): v is YTimeExcludedShift {
  return isRecord(v) && typeof v.start === 'string' && typeof v.end === 'string' && typeof v.reason === 'string'
}

/** 上流の新しい口。勤務の列をそのまま渡し、行をそのまま受け取る。 */
async function rowsFromShifts(event: H3Event, input: YTimeRowsInput, shifts: unknown[]): Promise<YTimeRowsResponse> {
  const res = await alcProxyFetch(event, {
    path: '/api/dtako/y-time-rows',
    method: 'POST',
    body: JSON.stringify({ from: input.from, to: input.to, shifts }),
    contentType: 'application/json',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const error = text || res.statusText
    throw kintaiError(
      res.status === 401 || res.status === 403 || res.status >= 500 ? res.status : 502,
      'upstream',
      `勤務の記録から Y時間 の行を作れませんでした (上流 ${res.status}: ${error})`,
      { status: res.status, error },
    )
  }
  const data: unknown = await res.json().catch(() => null)
  if (!isRecord(data) || !Array.isArray(data.rows) || !isStringArray(data.warnings)
    || !Array.isArray(data.excluded) || !data.excluded.every(isExcludedShift)) {
    throw kintaiError(502, 'upstream', 'Y時間 の行の応答が読めない形でした (上流)')
  }
  return { rows: data.rows as YTimeRow[], warnings: data.warnings, excluded: data.excluded }
}

/**
 * Y時間 の行と、その元を返す。呼び手 (route) は返った `rows` をそのまま Excel に書くか、そのまま返す。
 * 認証 (`requireAuth`) と role の確認は呼び手が済ませてから呼ぶ (`authorizeScraperRelay`)。
 */
export async function fetchYTimeRows(event: H3Event, input: YTimeRowsInput, opts: YTimeRowsOptions): Promise<YTimeRowsResult> {
  if (!opts.tenantId) {
    throw kintaiError(500, 'auth', 'ログイン中の会社を特定できないため、勤怠の勤務の記録を読みませんでした')
  }
  if (!cfEnv(event).SCRAPER_RELAY) return rowsFromAlc(event, input, 'not_configured')
  const got = await shiftsFromRelay(event, input, opts.tenantId, opts.sharedSecret)
  if ('fallback' in got) return rowsFromAlc(event, input, got.fallback)
  const data = await rowsFromShifts(event, input, got.shifts)
  return {
    source: 'kintai',
    sourceReason: null,
    rows: data.rows,
    warnings: data.warnings,
    excluded: data.excluded,
    missingMonths: got.missingMonths,
  }
}

/** ヘッダに載せてよい語か (ASCII の英数字・`_`・`-` だけ)。違えば `fallback` に置き換える。 */
function headerToken(s: string, fallback: string): string {
  return /^[\w-]+$/.test(s) ? s : fallback
}

/**
 * 行の元を応答ヘッダにする (本文が binary の route 用)。**値は ASCII の決まった語だけ**
 * (日本語をヘッダに入れると 500 になる)。読む側は `app/utils/litigation-output.ts` の
 * `yTimeSourceFromHeaders` (訴訟準備の出力タブと Y時間 のページのダウンロードが使う)。
 * 本文が JSON の route (`POST /api/y-time-rows`) はヘッダを使わず、結果を本文で返す。
 *
 * - `x-y-time-source`: `kintai` | `alc`
 * - `x-y-time-source-reason`: 倒したときだけ
 * - `x-y-time-excluded-reasons`: `reason=件数` を `,` で連結 (**全件ぶん**。合計はここから出す)
 * - `x-y-time-excluded`: 先頭 {@link Y_TIME_EXCLUDED_HEADER_LIMIT} 件の `<始業の日付>:<reason>`
 *   (上流の時刻の区切りが空白でも `T` でも、日付は先頭 10 文字)
 * - `x-y-time-missing-months`: `YYYY-MM` を `,` で連結
 */
export function yTimeSourceHeaders(result: YTimeRowsResult): Record<string, string> {
  const headers: Record<string, string> = { 'x-y-time-source': result.source }
  if (result.sourceReason) headers['x-y-time-source-reason'] = result.sourceReason
  if (result.excluded.length > 0) {
    const counts = new Map<string, number>()
    for (const e of result.excluded) {
      const reason = headerToken(e.reason, 'other')
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
    }
    headers['x-y-time-excluded-reasons'] = [...counts].map(([reason, n]) => `${reason}=${n}`).join(',')
    headers['x-y-time-excluded'] = result.excluded
      .slice(0, Y_TIME_EXCLUDED_HEADER_LIMIT)
      .map(e => `${headerToken(e.start.slice(0, 10), 'unknown')}:${headerToken(e.reason, 'other')}`)
      .join(',')
  }
  if (result.missingMonths.length > 0) headers['x-y-time-missing-months'] = result.missingMonths.join(',')
  return headers
}
