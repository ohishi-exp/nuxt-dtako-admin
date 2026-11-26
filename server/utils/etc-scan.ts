/**
 * ETC コーポレートカード発行明細書の scan と、そこから作るカード行の D1 読み書き (Refs #1287)。
 * 表は migration 0021 (`etc_card_scans` / `etc_card_registrations`)。列名は relay
 * (`workers/dtako-scraper-relay`) と共有しているので変えない。
 *
 * 使い手は 2 つ:
 *   - 受け口 `server/routes/dav/[...path].ts` (複合機の PUT → scan 保存 → OCR → 行の作成)
 *   - 画面の API `server/api/etc-cards/**` (一覧・手直し・再 OCR)
 *
 * **テナント**: registrations は tenant 列を持たない。必ず scan (`tenant_id`) を JOIN して絞る。
 * **ログ**: 番号 (カード・車載器・車両) は出さない。sha256 の先頭 12 桁・行数・status だけ。
 */
import { createError } from 'h3'
import type { H3Event } from 'h3'
import { getKyuyoDb, type D1DatabaseLite } from './kyuyo-master-db'
import { authorizeScraperRelay, type ScraperRelayAuth } from './scraper-relay'
import {
  cardLast5,
  initialStatus,
  isEmptyFields,
  normalizeFields,
  plate4Of,
  statusAfterRegistrationDateChange,
  type EtcCardFields,
  type EtcCardStatus,
  type EtcCardView,
  type EtcScanView,
} from '~/utils/etc-cards'

/** auth-worker の AlcRedactEntrypoint (service binding ALC_REDACT) の使う分だけ */
export interface AlcRedactResult {
  status: number
  body: ArrayBuffer
  contentType?: string | null
}
export interface AlcRedactRpc {
  extractEtcCard(pdf: ArrayBuffer): Promise<AlcRedactResult>
}

/** ログ用の sha256 の先頭 12 桁 */
export function shaPrefix(sha256: string): string {
  return sha256.slice(0, 12)
}

export type ExtractOutcome =
  | { ok: true, rows: EtcCardFields[] }
  | { ok: false, error: string }

/**
 * `extractEtcCard` の結果を行にする。非 2xx・JSON でない・`rows` が配列でない → 失敗 (理由の短い文字列)。
 * 各行は {@link normalizeFields} を通し、4 項目とも空の行は落とす。
 * 失敗の理由に本文を入れない (番号が混ざりうる)。alc-redact の `error` コードだけは拾う。
 */
export function parseExtractResult(res: AlcRedactResult): ExtractOutcome {
  let data: unknown = null
  try {
    data = JSON.parse(new TextDecoder().decode(res.body))
  }
  catch {
    data = null
  }
  if (res.status < 200 || res.status >= 300) {
    const code = (data as { error?: unknown } | null)?.error
    return { ok: false, error: typeof code === 'string' ? `HTTP ${res.status} ${code.slice(0, 64)}` : `HTTP ${res.status}` }
  }
  const rows = (data as { rows?: unknown } | null)?.rows
  if (!Array.isArray(rows)) return { ok: false, error: 'invalid_response' }
  return { ok: true, rows: rows.map(normalizeFields).filter(f => !isEmptyFields(f)) }
}

/** D1 の BLOB の読み出し (ArrayBuffer / TypedArray / 数値配列のどれで来ても) を Uint8Array にする */
export function blobToBytes(v: unknown): Uint8Array<ArrayBuffer> | null {
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer)
  if (Array.isArray(v)) return Uint8Array.from(v as number[])
  return null
}

function changes(res: unknown): number {
  return (res as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0
}

export interface NewScan {
  sha256: string
  pdf: Uint8Array<ArrayBuffer>
  tenantId: string
  receivedAt: string
}

/**
 * scan を保存する (sha256 で冪等)。新しく入れたら true、既にあれば false。
 * OCR の前に `ocr_status='failed'` (`ocr_error='ocr_pending'`) で入れておき、OCR が終わったら書き換える —
 * OCR の途中で worker が落ちても、画面に「再 OCR」の対象として残るように。
 */
export async function insertScan(db: D1DatabaseLite, scan: NewScan): Promise<boolean> {
  const res = await db
    .prepare(`INSERT OR IGNORE INTO etc_card_scans (sha256, pdf, bytes, tenant_id, received_at, ocr_status, ocr_error, row_count)
      VALUES (?, ?, ?, ?, ?, 'failed', 'ocr_pending', 0)`)
    .bind(scan.sha256, scan.pdf.buffer, scan.pdf.byteLength, scan.tenantId, scan.receivedAt)
    .run()
  return changes(res) > 0
}

export type OcrOutcome =
  | { ok: true, rowCount: number, inserted: number }
  | { ok: false, error: string }

/**
 * OCR して行を作り、scan の `ocr_status` を書き換える。
 * 行は `INSERT OR IGNORE` — 同じ card_number が既にあれば足さない (部分 UNIQUE index)。
 * `row_count` は明細書から読めた行数 (足さなかった行も数える)。
 */
export async function runOcr(
  db: D1DatabaseLite,
  redact: AlcRedactRpc,
  sha256: string,
  pdf: Uint8Array<ArrayBuffer>,
  now: string,
): Promise<OcrOutcome> {
  let outcome: ExtractOutcome
  try {
    outcome = parseExtractResult(await redact.extractEtcCard(pdf.buffer))
  }
  catch (e) {
    outcome = { ok: false, error: `rpc_error ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` }
  }
  if (!outcome.ok) {
    await db
      .prepare(`UPDATE etc_card_scans SET ocr_status = 'failed', ocr_error = ? WHERE sha256 = ?`)
      .bind(outcome.error, sha256)
      .run()
    return outcome
  }
  let inserted = 0
  for (const f of outcome.rows) {
    const res = await db
      .prepare(`INSERT OR IGNORE INTO etc_card_registrations
        (scan_sha256, kubun, card_number, vehicle_number, plate4, obu_number, status, attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .bind(sha256, f.kubun, f.card_number, f.vehicle_number, plate4Of(f.vehicle_number), f.obu_number, initialStatus(f), now, now)
      .run()
    inserted += changes(res)
  }
  await db
    .prepare(`UPDATE etc_card_scans SET ocr_status = 'ok', ocr_error = NULL, row_count = ? WHERE sha256 = ?`)
    .bind(outcome.rows.length, sha256)
    .run()
  return { ok: true, rowCount: outcome.rows.length, inserted }
}

/** D1 の registrations 1 行 (card_number は全桁) */
export interface RegistrationRow extends EtcCardFields {
  id: number
  scan_sha256: string
  plate4: string | null
  status: EtcCardStatus
  run_date: string | null
  unko_no: string | null
  registration_date: string | null
  /** JOIN した scan の `received_at` */
  received_at: string
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

/** 画面へ返す形にする (カード番号は末尾 5 桁だけ) */
export function toView(r: RegistrationRow): EtcCardView {
  return {
    id: r.id,
    scan_sha256: r.scan_sha256,
    kubun: r.kubun,
    card_last5: cardLast5(r.card_number),
    vehicle_number: r.vehicle_number,
    plate4: r.plate4,
    obu_number: r.obu_number,
    status: r.status,
    run_date: r.run_date,
    unko_no: r.unko_no,
    registration_date: r.registration_date,
    received_at: r.received_at,
    attempts: r.attempts,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

const REG_COLUMNS = `r.id, r.scan_sha256, r.kubun, r.card_number, r.vehicle_number, r.plate4, r.obu_number, r.status,
  r.run_date, r.unko_no, r.registration_date, s.received_at, r.attempts, r.last_error, r.created_at, r.updated_at`

/** テナントのカード行 (新しい順) と OCR に失敗した scan */
export async function listForTenant(db: D1DatabaseLite, tenantId: string): Promise<{ registrations: EtcCardView[], failed_scans: EtcScanView[] }> {
  const regs = await db
    .prepare(`SELECT ${REG_COLUMNS} FROM etc_card_registrations r
      JOIN etc_card_scans s ON s.sha256 = r.scan_sha256
      WHERE s.tenant_id = ? ORDER BY r.id DESC`)
    .bind(tenantId)
    .all<RegistrationRow>()
  const scans = await db
    .prepare(`SELECT sha256, bytes, received_at, ocr_error FROM etc_card_scans
      WHERE tenant_id = ? AND ocr_status = 'failed' ORDER BY received_at DESC`)
    .bind(tenantId)
    .all<EtcScanView>()
  return { registrations: regs.results.map(toView), failed_scans: scans.results }
}

/** テナントのカード行 1 件 (無い・他テナントは null) */
export async function getRegistration(db: D1DatabaseLite, tenantId: string, id: number): Promise<RegistrationRow | null> {
  return db
    .prepare(`SELECT ${REG_COLUMNS} FROM etc_card_registrations r
      JOIN etc_card_scans s ON s.sha256 = r.scan_sha256
      WHERE s.tenant_id = ? AND r.id = ?`)
    .bind(tenantId, id)
    .first<RegistrationRow>()
}

/** 手直しの保存。plate4 と status は 4 項目から作り直す。card_number の重複は UNIQUE 違反で throw */
export async function updateRegistrationFields(db: D1DatabaseLite, id: number, f: EtcCardFields, now: string): Promise<void> {
  await db
    .prepare(`UPDATE etc_card_registrations
      SET kubun = ?, card_number = ?, vehicle_number = ?, plate4 = ?, obu_number = ?, status = ?, updated_at = ?
      WHERE id = ?`)
    .bind(f.kubun, f.card_number, f.vehicle_number, plate4Of(f.vehicle_number), f.obu_number, initialStatus(f), now, id)
    .run()
}

/**
 * 登録日の保存。走行日の下限が変わるので、確認済みの `run_date` / `unko_no` は消して探し直させ、
 * status は {@link statusAfterRegistrationDateChange} で戻す (古い走行日で登録されないように)。
 */
export async function updateRegistrationDate(db: D1DatabaseLite, id: number, date: string | null, status: EtcCardStatus, now: string): Promise<void> {
  await db
    .prepare(`UPDATE etc_card_registrations
      SET registration_date = ?, run_date = NULL, unko_no = NULL, status = ?, updated_at = ?
      WHERE id = ?`)
    .bind(date, statusAfterRegistrationDateChange(status), now, id)
    .run()
}

/** D1 の UNIQUE 違反か (card_number の重複) */
export function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))
}

/** テナントの scan 1 件 (PDF 込み。無い・他テナントは null) */
export async function getScan(db: D1DatabaseLite, tenantId: string, sha256: string): Promise<{ pdf: unknown, ocr_status: string } | null> {
  return db
    .prepare('SELECT pdf, ocr_status FROM etc_card_scans WHERE tenant_id = ? AND sha256 = ?')
    .bind(tenantId, sha256)
    .first<{ pdf: unknown, ocr_status: string }>()
}

/** 64 桁の小文字 hex か (URL の sha256) */
export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
}

/** URL の id (正の整数) */
export function parseId(v: unknown): number | null {
  if (typeof v !== 'string' || !/^[1-9]\d{0,15}$/.test(v)) return null
  return Number(v)
}

/**
 * `/api/etc-cards/**` の前置き: {@link authorizeScraperRelay} (secret → `requireAuth` → `assertAllowedRole`) を
 * 通し、tenant と D1 を返す。tenant が取れなければ 403、DTAKO_DB が無ければ 503。
 * register は返り値の `auth` をそのまま {@link sendToScraperRelay} に渡す。
 */
export async function etcCardsContext(event: H3Event): Promise<{ auth: ScraperRelayAuth, tenantId: string, db: D1DatabaseLite }> {
  const auth = await authorizeScraperRelay(event)
  if (!auth.tenantId) throw createError({ statusCode: 403, statusMessage: 'tenant が分かりません' })
  const db = getKyuyoDb(event)
  if (!db) throw createError({ statusCode: 503, statusMessage: 'DTAKO_DB binding が未設定です' })
  return { auth, tenantId: auth.tenantId, db }
}
