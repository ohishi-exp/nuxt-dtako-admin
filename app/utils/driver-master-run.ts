/**
 * 乗務員マスタ同期手動実行 (`POST /api/driver-master/run`、Refs ippoan/alc-app-s3#125) の
 * 応答を画面が読む形に正規化する pure な部品。`app/pages/scraper.vue` が使う。
 *
 * relay の応答は今のところ **1 社ぶんの単体形**
 * `{ok, comp_id, created, updated, skipped:[{code,reason}], unreadable, error?}` だが、
 * 兄弟タスク (Refs ippoan/alc-app-s3#125 の c125-4) が複数 comp を逐次実行する
 * `{results:[{comp_id,status,created,updated,skipped,error?}]}` 形に変える予定。
 * どちらが来ても同じ行配列に揃えておけば、relay 側の形が変わっても画面を直さずに済む。
 *
 * **★ `{results:[...]}` 形は現時点の relay には存在しない** (c125-4 未マージ、実測は
 * simplify-reviewer が base で確認済み)。ここでの対応は前方互換のための先回りで、
 * 実在しない分岐を実物の応答で検証できないため **coverage_100.toml には登録しない**
 * (c125-4 マージ後、実物の応答で測ってから登録する)。
 */
import { pickBodyReason } from '~/utils/api-error'
import { fmtJstDateTime } from '~/utils/litigation-changes'

/** relay が返す `skipped` の 1 要素。 */
export interface DriverMasterSkipRow {
  code: string
  reason: string
}

/** 画面の 1 行 (会社 1 社ぶん)。 */
export interface DriverMasterRunRow {
  compId: string
  ok: boolean
  created: number
  updated: number
  skipped: DriverMasterSkipRow[]
  /** 失敗理由 (成功なら null)。 */
  error: string | null
}

/** `POST /api/driver-master/run` 1 回ぶんの実行結果。 */
export interface DriverMasterRunOutcome {
  /** 全社成功したか (fetch 自体の失敗は含まない — 呼び出し側が別途扱う)。 */
  ok: boolean
  status: number
  rows: DriverMasterRunRow[]
  /** route / relay が返した失敗の理由 (成功なら null)。 */
  error: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  return value as Record<string, unknown>
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readSkipped(value: unknown): DriverMasterSkipRow[] {
  if (!Array.isArray(value)) return []
  const rows: DriverMasterSkipRow[] = []
  for (const raw of value) {
    const r = asRecord(raw)
    if (r === null) continue
    rows.push({
      code: typeof r.code === 'string' ? r.code : '',
      reason: typeof r.reason === 'string' ? r.reason : '',
    })
  }
  return rows
}

/** 単体形の 1 件を行にする。`compId` は呼び出し側 (画面が選んだ会社) から補う —
 * 応答に `comp_id` が無い失敗形もあるため。 */
function rowFromSingle(rec: Record<string, unknown>, fallbackCompId: string): DriverMasterRunRow {
  const compId = typeof rec.comp_id === 'string' && rec.comp_id !== '' ? rec.comp_id : fallbackCompId
  const error = typeof rec.error === 'string' && rec.error !== '' ? rec.error : null
  return {
    compId,
    ok: rec.ok === true,
    created: readNumber(rec.created),
    updated: readNumber(rec.updated),
    skipped: readSkipped(rec.skipped),
    error,
  }
}

/** `{results:[...]}` 形の 1 件を行にする。`status` は `'ok'` だけを成功として読み、
 * 未知の値は失敗扱いにする (fail-closed — 「成功と分からない」を成功と読まない)。 */
function rowFromResultItem(raw: unknown, fallbackCompId: string): DriverMasterRunRow | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const compId = typeof rec.comp_id === 'string' && rec.comp_id !== '' ? rec.comp_id : fallbackCompId
  const error = typeof rec.error === 'string' && rec.error !== '' ? rec.error : null
  return {
    compId,
    ok: rec.status === 'ok',
    created: readNumber(rec.created),
    updated: readNumber(rec.updated),
    skipped: readSkipped(rec.skipped),
    error,
  }
}

/**
 * 応答本文 (2xx の body、または非 2xx の `createError` data) を画面の行配列にする。
 *
 * - `results` 配列があれば (将来形) それぞれを 1 行にする
 * - 無ければ単体形として 1 行にする
 * - どちらの形も読めなければ空配列
 */
export function normalizeDriverMasterRunRows(body: unknown, fallbackCompId: string): DriverMasterRunRow[] {
  const rec = asRecord(body)
  if (rec === null) return []
  if (Array.isArray(rec.results)) {
    return rec.results
      .map(raw => rowFromResultItem(raw, fallbackCompId))
      .filter((row): row is DriverMasterRunRow => row !== null)
  }
  return [rowFromSingle(rec, fallbackCompId)]
}

/**
 * `POST /api/driver-master/run` の応答を画面が読む形に揃える
 * (`normalizeNetprintRunOutcome` と同じ向き)。
 *
 * - 2xx: relay の応答 (単体形 / `results[]` 形) を {@link normalizeDriverMasterRunRows} で行にする
 * - 非 2xx: server route が `createError` で返す `{statusMessage, message, data}` を読む。
 *   `data` に relay の応答本文 (途中まで進んだ会社の件数を含むことがある) が載っていれば
 *   同じく行にする
 */
export function buildDriverMasterRunOutcome(
  status: number,
  ok: boolean,
  body: unknown,
  fallbackCompId: string,
): DriverMasterRunOutcome {
  if (ok) {
    return { ok: true, status, rows: normalizeDriverMasterRunRows(body, fallbackCompId), error: null }
  }
  const rec = asRecord(body)
  const error = pickBodyReason(rec) ?? `HTTP ${status}`
  return { ok: false, status, rows: normalizeDriverMasterRunRows(rec?.data, fallbackCompId), error }
}

// --- 最後に同期が走った記録 (`GET /api/driver-master/status`、Refs #1186) ---

/** 直近 1 回の同期の記録のうち、画面が使う欄 (server route が絞って返す形)。 */
export interface DriverMasterLastRunView {
  /** きっかけ。`cron` = 定時、`manual` = 手動。読めなければ null。 */
  trigger: 'cron' | 'manual' | null
  /** 終了時刻 (UTC の ISO 文字列)。 */
  finished_at: string
  ok: boolean
  /** 失敗の理由 (成功なら null)。 */
  error: string | null
}

/** 会社 1 社ぶんの、最後に同期が走った記録。 */
export interface DriverMasterStatusItem {
  comp_id: string
  /** まだ 1 回も走っていなければ null。 */
  last: DriverMasterLastRunView | null
  /** その会社の記録を読めなかったか。 */
  error: boolean
}

/** 欄に出す 1 行。 */
export interface DriverMasterStatusLine {
  compId: string
  /** 色分け用。`ok` = 成功、`error` = 失敗・取得できない、`muted` = 記録なし。 */
  level: 'ok' | 'error' | 'muted'
  text: string
  /** 失敗の理由 (1 行に収まる長さに切ってある)。無ければ null。 */
  detail: string | null
}

/** 失敗の理由を 1 行に収める長さ。 */
const STATUS_DETAIL_MAX = 120

/** `GET /api/driver-master/status` の応答を、会社ごとの配列にする。読めない要素は捨てる。 */
export function normalizeDriverMasterStatus(body: unknown): DriverMasterStatusItem[] {
  const results = asRecord(body)?.results
  if (!Array.isArray(results)) return []
  const items: DriverMasterStatusItem[] = []
  for (const raw of results) {
    const rec = asRecord(raw)
    if (rec === null || typeof rec.comp_id !== 'string' || rec.comp_id === '') continue
    const last = asRecord(rec.last)
    items.push({
      comp_id: rec.comp_id,
      last: last === null
        ? null
        : {
            trigger: last.trigger === 'cron' || last.trigger === 'manual' ? last.trigger : null,
            finished_at: typeof last.finished_at === 'string' ? last.finished_at : '',
            ok: last.ok === true,
            error: typeof last.error === 'string' && last.error !== '' ? last.error : null,
          },
      error: rec.error === true,
    })
  }
  return items
}

/** 会社 1 社ぶんの記録を、欄に出す 1 行にする。`label` は行の頭に付ける社名 (付けないなら空文字)。 */
function driverMasterStatusLine(item: DriverMasterStatusItem, label: string): DriverMasterStatusLine {
  const head = label === '' ? '最終同期: ' : `${label}: `
  if (item.error) {
    return { compId: item.comp_id, level: 'error', text: `${head}取得できませんでした`, detail: null }
  }
  const last = item.last
  if (last === null) {
    return { compId: item.comp_id, level: 'muted', text: `${head}記録なし`, detail: null }
  }
  const trigger = last.trigger === 'cron' ? '定時' : last.trigger === 'manual' ? '手動' : '不明'
  const text = `${head}${fmtJstDateTime(last.finished_at)} ${last.ok ? '成功' : '失敗'} (${trigger})`
  if (last.ok || last.error === null) {
    return { compId: item.comp_id, level: last.ok ? 'ok' : 'error', text, detail: null }
  }
  const oneLine = last.error.replace(/\s+/g, ' ').trim()
  const detail = oneLine.length > STATUS_DETAIL_MAX ? `${oneLine.slice(0, STATUS_DETAIL_MAX)}…` : oneLine
  return { compId: item.comp_id, level: 'error', text, detail }
}

/**
 * 欄に出す行を組み立てる。
 *
 * - 会社を選んでいるとき (`selectedCompId` が空でない): その会社の 1 行 (応答に無ければ「記録なし」)。行の頭は「最終同期: 」
 * - 「全企業」のとき: 応答の会社ごとに 1 行ずつ。行の頭は社名 (`labels` に無ければ comp_id)
 *
 * 日時は日本時間の `YYYY-MM-DD HH:mm` (`fmtJstDateTime`)。
 */
export function driverMasterStatusLines(
  items: DriverMasterStatusItem[],
  selectedCompId: string,
  labels: Record<string, string>,
): DriverMasterStatusLine[] {
  if (selectedCompId !== '') {
    const item = items.find(i => i.comp_id === selectedCompId) ?? { comp_id: selectedCompId, last: null, error: false }
    return [driverMasterStatusLine(item, '')]
  }
  return items.map(item => driverMasterStatusLine(item, labels[item.comp_id] || item.comp_id))
}
