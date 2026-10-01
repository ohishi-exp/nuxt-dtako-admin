/**
 * 訴訟準備の「出力」タブ (Refs #1133 c1133-2) の pure ロジック。
 *
 * 案件 (開始月〜終了月 × 乗務員CD) を **1 冊 = 乗務員 1 名 × 最大 12 か月** に区切り、
 * 区切りごとに `POST /api/y-time-export` (`period_rewrite: true`) を呼んで Y時間 Excel を作る。
 * ZIP に束ねるのはブラウザ (JSZip) — ここは区切り・名前・結果の分類だけを持つ。
 *
 * ## なぜ 12 か月で区切るか
 *
 * テンプレの `月所` シートは 1 年度のカレンダー (`E6 = EDATE(B6,12)-1`) なので、
 * 12 か月を超える 1 冊にすると月別の集計が追従しない。区切りの開始日を `月所!B6` に
 * 入れる (`writeYTimeRows` の `period`) ので、区切りと年度がちょうど重なる。
 *
 * ## 結果の 4 分類 — 「0 件」「未登録」「失敗」を同じ見た目にしない
 *
 * | status | 意味 | 根拠 |
 * | --- | --- | --- |
 * | `ok` | xlsx ができた | 2xx かつ `x-y-time-rows` > 0 |
 * | `empty` | 行が 0 件。**何の 0 件かは元で違う** ({@link litigationEmptyMessage}) | 2xx かつ `x-y-time-rows` = 0 |
 * | `not_found` | 乗務員CD が alc に登録されていない | 404 かつ本文の `data.upstream = 'alc'` |
 * | `error` | それ以外の失敗 (通信・認証・テンプレ不在・500 等) | — |
 *
 * **404 だけでは `not_found` にしない** — R2 にテンプレが無いときも 404 になる。
 * `data.upstream` は `server/api/y-time-export.post.ts` が上流由来のエラーにだけ付ける。
 * alc の dtako は 2024-04〜2025-12 が 0 件 (nuxt-dtako-admin-map skill「Y時間 エクスポート」)
 * なので、運行から作った `empty` は「働いていない」ではなく「alc に材料が無い」と読ませる。
 *
 * ## 行の元 (Refs #1133 c1133-46)
 *
 * Excel の行は、勤怠の勤務の記録 (wage report と同じ元) から作る。勤怠の記録が無い会社・勤怠の設定が
 * 無い環境だけ、運行 (デジタコ) から作る。どちらで作ったか・行を作れなかった勤務・勤務の記録の無い月は
 * サーバが応答ヘッダで返し ({@link yTimeSourceFromHeaders})、結果の 5 欄 (どれも optional) に持つ。
 * **この欄の無い結果 (前に保存した版) は運行から作ったものとして読む**
 * (`litigation-errors.ts` の `litigationResultFromKintai` が、元を決めるただ 1 つの場所)。
 * 冊ごとに画面と紙面へ出す行は {@link litigationOutputSourceLines} が組む。
 *
 * ## 月ごとの時間の表 (Refs #1133 c1133-36)
 *
 * 出力タブと紙面の「月ごとの時間 (wage report)」は、**給与比較タブと同じ保存済みの wage report**
 * (エラータブの `errWageReports`) の月の区分から作る ({@link buildLitigationHoursBooks})。
 * 「ZIP を作る」の結果 (この上の 4 分類) には依らない — Excel を作れなかった冊も、wage report が
 * 在る月は出る。ここで時間を計算し直さない (区分を足すだけ。残業時間と月 60h 超は
 * `restraint-wage-view.ts` の式をそのまま呼ぶ)。
 */
import { monthRange, monthlyOvertimeMinutes, monthlyOvertimeOver60hMinutes } from './restraint-wage-view'
import type { WageCategoryKey, WageReportResponse, WageRow } from './restraint-wage-view'
import { daysInMonth } from './timecard-view'
import { LITIGATION_CASE_MAX_MONTHS } from './litigation-case-form'
import { fmtTimecardCompareMinutes } from './timecard-compare-view'
import { fmtJstDateTime } from './litigation-changes'
import {
  LITIGATION_REFOLD_NOTICE,
  litigationCheckedAtKey,
  litigationChunkMonths,
  litigationDriverMonthKey,
  litigationExcludedReasonLabel,
  litigationExcludedSummary,
  litigationResultFromKintai,
  sameLitigationDriverCd,
  Y_TIME_SOURCES,
  Y_TIME_SOURCE_REASONS,
} from './litigation-errors'
import type { LitigationFetched } from './litigation-errors'
import { isAlcDriverNotFound } from './api-error'
import type { YTimeExcludedShift, YTimeRow, YTimeRowsPreview, YTimeSource, YTimeSourceReason } from '~/types'

/** 京都ソフト案件の Y時間 テンプレ (y-time-export.vue の既定と同じ R2 key) */
export const LITIGATION_TEMPLATE_KEY = 'templates/kyoto-soft/base.xlsx'
/** 1 冊に入れる最大月数 (テンプレの `月所` が 1 年度スコープのため) */
export const LITIGATION_CHUNK_MONTHS = 12

/** 1 冊ぶんの区切り */
export interface LitigationOutputChunk {
  driverCd: string
  /** `YYYY-MM-01` */
  from: string
  /** その月の末日 `YYYY-MM-DD` */
  to: string
  /** 画面表示用 `YYYY-MM〜YYYY-MM` */
  label: string
  /** ZIP 内のファイル名 `{乗務員CD}_{YYYY-MM}-{YYYY-MM}.xlsx` */
  filename: string
}

export type LitigationOutputStatus = 'ok' | 'empty' | 'not_found' | 'error'

/** 行を作れなかった勤務 1 本 (始業の日付と理由)。サーバが返すのは先頭だけ */
export interface YTimeExcludedDay {
  /** 始業の日付 `YYYY-MM-DD` */
  date: string
  reason: string
}

/**
 * Y時間 の行の元 (応答ヘッダから読む 5 欄)。**サーバが元を返さなかった応答は全部の欄を持たない**
 * (= 運行の元として読む)。元を返した応答は、件数が 0 でも下の 3 欄を空で持つ。
 */
export interface YTimeSourceInfo {
  source?: YTimeSource
  /** 勤怠の元を試して運行の元へ倒した理由 */
  sourceReason?: YTimeSourceReason
  /** 行を作れなかった勤務の、理由ごとの件数 (**全件ぶん**。合計はここから出す) */
  excludedReasons?: Record<string, number>
  /** 行を作れなかった勤務 (サーバがヘッダで返す先頭 20 件まで) */
  excluded?: YTimeExcludedDay[]
  /** 勤務の記録が 1 本も無い月 `YYYY-MM` */
  missingMonths?: string[]
}

/** 区切り 1 つの結果 (エラータブ #c1133-5 が読む)。「ZIP を作る」のたびに、版の結果として relay に保存する
 * (`litigation-output-version.ts`、#c1133-34) */
export interface LitigationOutputResult extends YTimeSourceInfo {
  driverCd: string
  from: string
  to: string
  status: LitigationOutputStatus
  /** 上流が返した行数。失敗時と、サーバが件数を返さなかったときは null */
  rows: number | null
  /** テンプレに行が無く書けなかった日 (サーバがヘッダで返す先頭 30 件まで) */
  missingDates: string[]
  /** 書けなかった日の総数 (`missingDates` は切り詰められている) */
  missingCount: number
  /** 上流の警告 (サーバがヘッダで返す先頭 5 件まで) */
  warnings: string[]
  /** 警告の総数 (`warnings` は切り詰められている) */
  warningsCount: number
  /** 画面に出す 1 文 */
  message: string
}

/** 応答ヘッダを読むための最小の形 (`Headers` がそのまま渡せる) */
export interface HeaderReader {
  get(name: string): string | null
}

/** 運行から作った冊の 0 件 */
export const LITIGATION_EMPTY_ALC_MESSAGE = 'この期間に運行が 0 件 (alc に取り込まれていない可能性)'
/** 勤怠の勤務の記録から作った冊の 0 件 (勤務そのものが無い) */
export const LITIGATION_EMPTY_KINTAI_MESSAGE = 'この期間に勤務が 0 件'
export const LITIGATION_NOT_FOUND_MESSAGE = 'この乗務員CD は alc に登録が無い'

/**
 * 案件を区切りの配列にする。並びは乗務員ごと・期間の古い順。
 * 開始月と終了月が逆でも並べ直す (`monthRange` と同じ扱い)。形式違いは空配列。
 */
export function buildLitigationOutputChunks(input: {
  fromMonth: string
  toMonth: string
  driverCds: readonly string[]
}): LitigationOutputChunk[] {
  const months = monthRange(input.fromMonth, input.toMonth, LITIGATION_CASE_MAX_MONTHS)
  const periods: string[][] = []
  for (let i = 0; i < months.length; i += LITIGATION_CHUNK_MONTHS) {
    periods.push(months.slice(i, i + LITIGATION_CHUNK_MONTHS))
  }
  const out: LitigationOutputChunk[] = []
  for (const driverCd of input.driverCds) {
    for (const period of periods) {
      const first = period[0]!
      const last = period[period.length - 1]!
      out.push({
        driverCd,
        from: `${first}-01`,
        to: `${last}-${String(monthEndDay(last)).padStart(2, '0')}`,
        label: `${first}〜${last}`,
        filename: `${driverCd}_${first}-${last}.xlsx`,
      })
    }
  }
  return out
}

function monthEndDay(ym: string): number {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return daysInMonth(y, m)
}

/** ファイル名に使えない文字 (Windows の禁止文字と制御文字) */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/** ZIP 名 `訴訟準備_{案件名}_{作成日 (JST) YYYY-MM-DD}.zip` */
export function litigationZipFilename(caseName: string, now: Date): string {
  const safe = caseName.replace(UNSAFE_FILENAME_CHARS, '_').trim() || '案件'
  const jst = new Date(now.getTime() + 9 * 3600 * 1000)
  const ymd = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`
  return `訴訟準備_${safe}_${ymd}.zip`
}

function parseCount(raw: string | null): number | null {
  if (raw == null || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

/**
 * 応答ヘッダから Y時間 の行の元を読む (書く側は `server/utils/y-time-rows.ts` の `yTimeSourceHeaders`)。
 * 冊を引数に取らない — 訴訟準備の出力タブ以外 (Y時間 の単独のページ) も同じ読み方をするため。
 * `x-y-time-source` が無い・知らない値の応答は何も返さない (元を言えない結果を、勤怠の元に見せない)。
 */
export function yTimeSourceFromHeaders(headers: HeaderReader): YTimeSourceInfo {
  const source = headers.get('x-y-time-source')
  if (!Y_TIME_SOURCES.includes(source)) return {}
  const info: YTimeSourceInfo = { source: source as YTimeSource, excludedReasons: {}, excluded: [], missingMonths: [] }
  const reason = headers.get('x-y-time-source-reason')
  if (Y_TIME_SOURCE_REASONS.includes(reason)) info.sourceReason = reason as YTimeSourceReason
  for (const part of (headers.get('x-y-time-excluded-reasons') ?? '').split(',')) {
    const at = part.indexOf('=')
    const n = parseCount(part.slice(at + 1))
    if (at > 0 && n !== null) info.excludedReasons![part.slice(0, at)] = n
  }
  for (const part of (headers.get('x-y-time-excluded') ?? '').split(',')) {
    const at = part.indexOf(':')
    if (at > 0) info.excluded!.push({ date: part.slice(0, at), reason: part.slice(at + 1) })
  }
  info.missingMonths = (headers.get('x-y-time-missing-months') ?? '').split(',').filter(Boolean)
  return info
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')

/**
 * `POST /api/y-time-rows` の応答の形を検査して返す (呼ぶのは `app/utils/api.ts` の `getYTimeRows`)。
 * **欄が欠けている・型が違う応答は null** — 読めなかった応答を、行が 0 件・除外が 0 件の応答として
 * 先へ進めない。行の中身は見ない (月に畳むのに使う `date` が文字列であることだけ)。
 */
export function parseYTimeRowsPreview(raw: unknown): YTimeRowsPreview | null {
  if (!isRecord(raw)) return null
  const { source, source_reason: sourceReason, rows, warnings, excluded, missing_months: missingMonths } = raw
  if (!Y_TIME_SOURCES.includes(source)) return null
  if (sourceReason !== null && !Y_TIME_SOURCE_REASONS.includes(sourceReason)) return null
  if (!Array.isArray(rows) || !rows.every(r => isRecord(r) && typeof r.date === 'string')) return null
  if (!isStringArray(warnings) || !isStringArray(missingMonths)) return null
  if (!Array.isArray(excluded)
    || !excluded.every(e => isRecord(e) && typeof e.start === 'string' && typeof e.end === 'string' && typeof e.reason === 'string')) return null
  return {
    source: source as YTimeSource,
    source_reason: sourceReason as YTimeSourceReason | null,
    rows: rows as YTimeRow[],
    warnings,
    excluded: excluded as YTimeExcludedShift[],
    missing_months: missingMonths,
  }
}

/**
 * JSON の応答 ({@link parseYTimeRowsPreview}) から行の元の 5 欄を作る — 応答ヘッダから読む
 * {@link yTimeSourceFromHeaders} と同じ形にして、{@link litigationOutputSourceLines} にそのまま渡せるようにする
 * (Y時間 のページのプレビューが、ダウンロードと同じ行を出す)。本文は切り詰めが無いので、
 * 行を作れなかった勤務は全件ぶん持つ。
 */
export function yTimeSourceFromPreview(preview: YTimeRowsPreview): YTimeSourceInfo {
  const excludedReasons: Record<string, number> = {}
  for (const e of preview.excluded) excludedReasons[e.reason] = (excludedReasons[e.reason] ?? 0) + 1
  return {
    source: preview.source,
    ...(preview.source_reason ? { sourceReason: preview.source_reason } : {}),
    excludedReasons,
    excluded: preview.excluded.map(e => ({ date: e.start.slice(0, 10), reason: e.reason })),
    missingMonths: preview.missing_months,
  }
}

/**
 * 行が 0 件の冊に出す 1 文。**何の 0 件かを元で言い分ける** — 勤怠の元の 0 件を「運行が 0 件」と
 * 言わない (運行を取り込んでも直らない)。行を作れなかった勤務が在るなら、勤務が無いとは言わない。
 */
export function litigationEmptyMessage(result: Pick<LitigationOutputResult, 'source' | 'excludedReasons'>): string {
  if (!litigationResultFromKintai(result)) return LITIGATION_EMPTY_ALC_MESSAGE
  const { total } = litigationExcludedSummary(result)
  return total > 0 ? `行を作れた勤務が 0 件 (行を作れなかった勤務 ${total} 件)` : LITIGATION_EMPTY_KINTAI_MESSAGE
}

/** 冊ごとに、結果の文の下へ出す 1 行。`kind` で見た目を分ける (`refold` は目立たせる) */
export interface LitigationOutputSourceLine {
  kind: 'source' | 'excluded' | 'refold' | 'missingMonths'
  text: string
}

const SOURCE_LINE_KINTAI = '勤怠の記録から作成'
const SOURCE_LINE_ALC = '運行から作成'
const SOURCE_REASON_TEXT: Record<YTimeSourceReason, string> = {
  out_of_scope: 'この会社は勤怠の記録が無い',
  not_configured: 'この環境は勤怠の設定が無い',
}

/**
 * 冊ごとの表示 (どの元で作ったか・行を作れなかった勤務・畳み直しの案内・勤務の記録の無い月) を組む。
 * 出力タブの表と紙面の両方がこれを使う。**行を作れなかった勤務を黙って落とさない** — 件数と理由を必ず言う。
 * 失敗・未登録の冊は何も作っていないので、元を言わない (空)。
 */
export function litigationOutputSourceLines(
  result: YTimeSourceInfo & { status: LitigationOutputStatus },
): LitigationOutputSourceLine[] {
  if (result.status === 'error' || result.status === 'not_found') return []
  const lines: LitigationOutputSourceLine[] = []
  if (litigationResultFromKintai(result)) lines.push({ kind: 'source', text: SOURCE_LINE_KINTAI })
  else if (result.sourceReason) lines.push({ kind: 'source', text: `${SOURCE_LINE_ALC} (${SOURCE_REASON_TEXT[result.sourceReason]})` })
  else lines.push({ kind: 'source', text: SOURCE_LINE_ALC })
  const excluded = litigationExcludedSummary(result)
  if (excluded.total > 0) {
    const listed = result.excluded ?? []
    const days = listed.map(e => `${e.date} (${litigationExcludedReasonLabel(e.reason)})`).join(', ')
    const more = excluded.total > listed.length ? ' ほか' : ''
    lines.push({
      kind: 'excluded',
      text: `行を作れなかった勤務 ${excluded.total} 件 (${excluded.reasonsText}) — 始業の日付: ${days}${more}`,
    })
  }
  if (excluded.refold > 0) {
    lines.push({ kind: 'refold', text: `${LITIGATION_REFOLD_NOTICE} (まだ畳み直していない勤務 ${excluded.refold} 件)` })
  }
  if (result.missingMonths && result.missingMonths.length > 0) {
    lines.push({ kind: 'missingMonths', text: `勤務の記録が無い月: ${result.missingMonths.join(', ')}` })
  }
  return lines
}

/**
 * 2xx の応答ヘッダから結果を作る。`x-y-time-rows` が 0 なら `empty`。
 * **件数ヘッダが読めないときは `ok` のまま rows を null にし、0 件かどうか判定できないと
 * 言う** (読めなかったことを 0 件と同じ見た目にしない)。
 */
export function litigationResultFromHeaders(
  chunk: Pick<LitigationOutputChunk, 'driverCd' | 'from' | 'to'>,
  headers: HeaderReader,
): LitigationOutputResult {
  const rows = parseCount(headers.get('x-y-time-rows'))
  const missingDates = (headers.get('x-y-time-missing-dates') ?? '').split(',').filter(Boolean)
  const rawWarnings = headers.get('x-y-time-warnings')
  const warnings = rawWarnings ? decodeURIComponent(rawWarnings).split(' / ') : []
  const status: LitigationOutputStatus = rows === 0 ? 'empty' : 'ok'
  const source = yTimeSourceFromHeaders(headers)
  let message: string
  if (rows === null) message = '行数が返らなかった (0 件かどうか判定できない)'
  else if (rows === 0) message = litigationEmptyMessage(source)
  else message = `${rows} 行`
  return {
    driverCd: chunk.driverCd,
    from: chunk.from,
    to: chunk.to,
    status,
    rows,
    missingDates,
    missingCount: parseCount(headers.get('x-y-time-missing-count')) ?? missingDates.length,
    warnings,
    warningsCount: parseCount(headers.get('x-y-time-warnings-count')) ?? warnings.length,
    message,
    ...source,
  }
}

/**
 * 失敗 (非 2xx・通信失敗) から結果を作る。`reason` は呼び出し側が `api-error.ts` で
 * 組んだ 1 文。404 かつ本文の `data.upstream` が `'alc'` のときだけ `not_found`。
 * 通信失敗 (応答が無い) は `httpStatus` / `body` を null で渡す。
 */
export function litigationResultFromFailure(
  chunk: LitigationOutputChunk,
  httpStatus: number | null,
  body: unknown,
  reason: string,
): LitigationOutputResult {
  const notFound = isAlcDriverNotFound(httpStatus, body)
  return {
    driverCd: chunk.driverCd,
    from: chunk.from,
    to: chunk.to,
    status: notFound ? 'not_found' : 'error',
    rows: null,
    missingDates: [],
    missingCount: 0,
    warnings: [],
    warningsCount: 0,
    message: notFound ? LITIGATION_NOT_FOUND_MESSAGE : reason,
  }
}

/** 状態ごとの件数 (進捗の下の要約と、ZIP に入る冊数の表示に使う) */
export function countLitigationResults(
  results: readonly LitigationOutputResult[],
): Record<LitigationOutputStatus, number> {
  const counts: Record<LitigationOutputStatus, number> = { ok: 0, empty: 0, not_found: 0, error: 0 }
  for (const r of results) counts[r.status]++
  return counts
}

// ---- ZIP の中身の概要 (画面に出す) ----

/**
 * ZIP に入るファイル 1 つぶんの概要。
 *
 * | state | 意味 |
 * | --- | --- |
 * | `included` | 入る (作った / 作れる) |
 * | `pending` | まだ作っていない — 「ZIP を作る」で Y時間 Excel を作る |
 * | `excluded` | 入らない (行が 0 件・未登録・失敗。理由は `detail`) |
 */
export interface LitigationZipSummaryItem {
  filename: string
  state: 'included' | 'pending' | 'excluded'
  detail: string
}

export interface LitigationZipSummaryInput {
  chunks: readonly LitigationOutputChunk[]
  /** 出力の結果 (添字を `chunks` に揃える。未実行は null) */
  results: readonly (LitigationOutputResult | null)[]
  changesCsv: {
    filename: string
    /** 変更記録タブで取りに行ったか */
    finished: boolean
    rows: number
  }
}

/** ZIP に入るファイルの一覧と、それぞれの中身の要点。並びは ZIP に入れる順 (Excel → 変更記録.csv)。 */
export function buildLitigationZipSummary(input: LitigationZipSummaryInput): LitigationZipSummaryItem[] {
  const excel = input.chunks.map((c, i): LitigationZipSummaryItem => {
    const r = input.results[i]
    const period = `${c.label} (乗務員 ${c.driverCd})`
    if (!r) return { filename: c.filename, state: 'pending', detail: `${period} — 「ZIP を作る」で Y時間 Excel を作る` }
    if (r.status !== 'ok') return { filename: c.filename, state: 'excluded', detail: `${period} — 入らない: ${r.message}` }
    const rows = r.rows === null ? '' : ` ${r.rows} 行`
    const missing = r.missingCount > 0 ? ` / テンプレに書けなかった日 ${r.missingCount} 日` : ''
    const warnings = r.warningsCount > 0 ? ` / 警告 ${r.warningsCount} 件` : ''
    return { filename: c.filename, state: 'included', detail: `${period} —${rows}${missing}${warnings}`.replace('— /', '—') }
  })
  const ch = input.changesCsv
  const changes: LitigationZipSummaryItem = {
    filename: ch.filename,
    state: 'included',
    detail: ch.finished ? `変更 ${ch.rows} 件` : '変更記録タブで「検知を実行」していない — 空の表 (その旨を備考に書く)',
  }
  return [...excel, changes]
}

// ---- 月ごとの時間 (wage report。出力タブの表と紙面) ----

/** 表の時間の列。wage report の月の区分をそのまま出す (Excel の列名には寄せない) */
export const LITIGATION_HOURS_COLUMNS = ['法定時間内', '法外残業', 'うち月60h超', '法定外休日', '法定休日', '深夜 (内数)', '総労働時間'] as const

export const LITIGATION_HOURS_NOT_APPLIED = '不適用'
/** まだ取りに行っていない月 */
export const LITIGATION_HOURS_PENDING = '未取得'
/** 取りに行って取れなかった月 (後ろに理由を続ける) */
export const LITIGATION_HOURS_FAILED = '取得に失敗'
/** 取れたが、その月にこの乗務員の行が無い (取り直しても同じ) */
export const LITIGATION_HOURS_NO_ROW = '拘束の記録なし'
/** GCP の拘束時間が欠測の月 (0 分ではない) */
export const LITIGATION_HOURS_MISSING = '欠測'

export interface LitigationHoursRow {
  /** 対象月 `YYYY-MM` (合計行は「合計 (N か月ぶん)」) */
  month: string
  /** `LITIGATION_HOURS_COLUMNS` の順の `H:MM` (月 60h 超が不適用なら「不適用」)。値の無い月は空 */
  cells: string[]
  /** 値の無い月の状態 (未取得 / 取得に失敗: 理由 / 拘束の記録なし / 欠測)。値の在る月は null */
  note: string | null
}

/** 1 冊ぶんの表。「ZIP を作る」の結果に依らず、案件の全部の冊について作る */
export interface LitigationHoursBook {
  driverCd: string
  /** 冊の期間 `YYYY-MM〜YYYY-MM` */
  label: string
  /** 冊の月ごとの行 (古い順)。値の無い月も行を持つ */
  rows: LitigationHoursRow[]
  /** 値の在る月だけの合計。値の在る月が 1 つも無ければ null */
  total: LitigationHoursRow | null
  /** 値の在る月の数 (紙面は 1 つ以上の冊だけ刷る) */
  valueMonths: number
  /** 未取得か取得に失敗の月が在る (「拘束の材料を取ると出ます」を出す条件。記録なし・欠測は入れない) */
  needsFetch: boolean
  /** この冊の月の wage report を取った時刻のうち、いちばん新しいもの (JST `YYYY-MM-DD HH:mm`)。1 つも無ければ null */
  checkedAtText: string | null
}

/** 1 か月ぶんの値 (分)。`over60` が null = 月 60h 超の割増が適用されない月 */
interface HoursMinutes {
  statutory: number
  overtime: number
  over60: number | null
  nonLegalHoliday: number
  legalHoliday: number
  night: number
  total: number
}

const WAGE_CATEGORY_KEYS = [
  'statutory', 'overtime', 'night', 'overtimeNight', 'nonLegalHoliday', 'nonLegalHolidayNight',
  'legalHoliday', 'legalHolidayNight', 'weekly40Excess',
] as const satisfies readonly WageCategoryKey[]

/**
 * wage report の 1 行を表の列にする。**`night` は `statutory` の内数**なので総労働時間に足さない
 * (深夜の列にだけ入れる)。区分が数でない行 (保存の検査は `wage.minutes` の形まで見ない) は null。
 */
function hoursMinutes(wage: WageRow, month: string): HoursMinutes | null {
  const m: Partial<Record<WageCategoryKey, unknown>> | undefined = wage.minutes
  const isMinutes = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  if (!m || !WAGE_CATEGORY_KEYS.every(k => isMinutes(m[k]))) return null
  if (!isMinutes(wage.overtimeMinutes) || !isMinutes(wage.nightOvertimeMinutes)) return null
  const v = wage.minutes
  return {
    statutory: v.statutory,
    overtime: monthlyOvertimeMinutes(wage),
    over60: monthlyOvertimeOver60hMinutes(wage, month),
    nonLegalHoliday: v.nonLegalHoliday + v.nonLegalHolidayNight,
    legalHoliday: v.legalHoliday + v.legalHolidayNight,
    night: v.night + v.overtimeNight + v.nonLegalHolidayNight + v.legalHolidayNight,
    total: v.statutory + v.overtime + v.overtimeNight + v.weekly40Excess
      + v.nonLegalHoliday + v.nonLegalHolidayNight + v.legalHoliday + v.legalHolidayNight,
  }
}

function hoursCells(m: HoursMinutes): string[] {
  return [
    fmtTimecardCompareMinutes(m.statutory),
    fmtTimecardCompareMinutes(m.overtime),
    m.over60 === null ? LITIGATION_HOURS_NOT_APPLIED : fmtTimecardCompareMinutes(m.over60),
    fmtTimecardCompareMinutes(m.nonLegalHoliday),
    fmtTimecardCompareMinutes(m.legalHoliday),
    fmtTimecardCompareMinutes(m.night),
    fmtTimecardCompareMinutes(m.total),
  ]
}

/** 値の在る月の合計。月 60h 超は適用される月の超過ぶんだけを足し、適用される月が無ければ null (不適用) */
function sumHours(months: readonly HoursMinutes[]): HoursMinutes {
  const sum = (pick: (m: HoursMinutes) => number) => months.reduce((acc, m) => acc + pick(m), 0)
  const applied = months.filter(m => m.over60 !== null)
  return {
    statutory: sum(m => m.statutory),
    overtime: sum(m => m.overtime),
    over60: applied.length === 0 ? null : applied.reduce((acc, m) => acc + m.over60!, 0),
    nonLegalHoliday: sum(m => m.nonLegalHoliday),
    legalHoliday: sum(m => m.legalHoliday),
    night: sum(m => m.night),
    total: sum(m => m.total),
  }
}

/** 乗務員 × 月の値か、値が無い理由 (`fetch` = 取り直すと出る可能性が在る)。 */
function hoursOfMonth(
  entry: LitigationFetched<WageReportResponse> | undefined,
  driverCd: string,
  month: string,
): { minutes: HoursMinutes } | { note: string, fetch: boolean } {
  if (!entry) return { note: LITIGATION_HOURS_PENDING, fetch: true }
  if (!entry.ok) return { note: `${LITIGATION_HOURS_FAILED}: ${entry.reason}`, fetch: true }
  const rows = entry.value.rows.filter(r => sameLitigationDriverCd(r.summary.driverCd, driverCd))
  if (rows.length === 0) return { note: LITIGATION_HOURS_NO_ROW, fetch: false }
  if (rows.some(r => r.restraint_missing)) return { note: LITIGATION_HOURS_MISSING, fetch: false }
  const minutes = hoursMinutes(rows[0]!.wage, month)
  return minutes ? { minutes } : { note: `${LITIGATION_HOURS_FAILED}: 保存された区分が読めない形`, fetch: true }
}

/**
 * 冊ごとの「月ごとの時間」の表を作る。行は**暦月** (wage report の月。締め日ではまとめ直さない)。
 * `wageReports` は給与比較タブと同じ Map (キー `乗務員CD|YYYY-MM`)、`checkedAt` はその保存時刻
 * (キー `種類|乗務員CD|YYYY-MM`)。**値の在る月だけを合計する** — 未取得・失敗・記録なし・欠測の月を
 * 0 時間として足さない。
 */
export function buildLitigationHoursBooks(
  chunks: readonly LitigationOutputChunk[],
  wageReports: ReadonlyMap<string, LitigationFetched<WageReportResponse>>,
  checkedAt: ReadonlyMap<string, string>,
): LitigationHoursBook[] {
  return chunks.map((chunk) => {
    const values: HoursMinutes[] = []
    const times: string[] = []
    let needsFetch = false
    const rows = litigationChunkMonths(chunk).map((month): LitigationHoursRow => {
      const key = litigationDriverMonthKey(chunk.driverCd, month)
      const at = checkedAt.get(litigationCheckedAtKey('wageReport', key))
      if (at !== undefined) times.push(at)
      const got = hoursOfMonth(wageReports.get(key), chunk.driverCd, month)
      if ('note' in got) {
        needsFetch ||= got.fetch
        return { month, cells: [], note: got.note }
      }
      values.push(got.minutes)
      return { month, cells: hoursCells(got.minutes), note: null }
    })
    return {
      driverCd: chunk.driverCd,
      label: chunk.label,
      rows,
      total: values.length === 0
        ? null
        : { month: `合計 (${values.length} か月ぶん)`, cells: hoursCells(sumHours(values)), note: null },
      valueMonths: values.length,
      needsFetch,
      checkedAtText: times.length === 0 ? null : fmtJstDateTime(times.reduce((a, b) => (b > a ? b : a))),
    }
  })
}
