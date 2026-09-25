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
 * | `empty` | その期間に運行が 0 件 (alc に取り込まれていない可能性) | 2xx かつ `x-y-time-rows` = 0 |
 * | `not_found` | 乗務員CD が alc に登録されていない | 404 かつ本文の `data.upstream = 'alc'` |
 * | `error` | それ以外の失敗 (通信・認証・テンプレ不在・500 等) | — |
 *
 * **404 だけでは `not_found` にしない** — R2 にテンプレが無いときも 404 になる。
 * `data.upstream` は `server/api/y-time-export.post.ts` が上流由来のエラーにだけ付ける。
 * alc の dtako は 2024-04〜2025-12 が 0 件 (nuxt-dtako-admin-map skill「Y時間 エクスポート」)
 * なので、`empty` は「働いていない」ではなく「alc に材料が無い」と読ませる。
 */
import { monthRange } from './restraint-wage-view'
import { daysInMonth } from './timecard-view'
import { LITIGATION_CASE_MAX_MONTHS } from './litigation-case-form'

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

/** 区切り 1 つの結果 (後続のエラータブ #c1133-5 が読む。保存はしない) */
export interface LitigationOutputResult {
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

export const LITIGATION_EMPTY_MESSAGE = 'この期間に運行が 0 件 (alc に取り込まれていない可能性)'
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
 * 2xx の応答ヘッダから結果を作る。`x-y-time-rows` が 0 なら `empty`。
 * **件数ヘッダが読めないときは `ok` のまま rows を null にし、0 件かどうか判定できないと
 * 言う** (読めなかったことを 0 件と同じ見た目にしない)。
 */
export function litigationResultFromHeaders(
  chunk: LitigationOutputChunk,
  headers: HeaderReader,
): LitigationOutputResult {
  const rows = parseCount(headers.get('x-y-time-rows'))
  const missingDates = (headers.get('x-y-time-missing-dates') ?? '').split(',').filter(Boolean)
  const rawWarnings = headers.get('x-y-time-warnings')
  const warnings = rawWarnings ? decodeURIComponent(rawWarnings).split(' / ') : []
  const status: LitigationOutputStatus = rows === 0 ? 'empty' : 'ok'
  let message: string
  if (rows === null) message = '行数が返らなかった (0 件かどうか判定できない)'
  else if (rows === 0) message = LITIGATION_EMPTY_MESSAGE
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
  const upstream = (body as { data?: { upstream?: unknown } } | null)?.data?.upstream
  const notFound = httpStatus === 404 && upstream === 'alc'
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
