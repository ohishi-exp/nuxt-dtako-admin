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
