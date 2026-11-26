/**
 * ETC コーポレートカード発行明細書の 1 行 (= カード 1 枚) の正規化・判定・表示 (Refs #1287)。
 *
 * server (`server/utils/etc-scan.ts` の OCR 取り込み、`PATCH /api/etc-cards/[id]` の手直し) と
 * 画面 (`app/pages/etc-cards.vue`) の両方が使う。D1 `etc_card_registrations` (migration 0021) の
 * 列と同じ名前で持つ。
 *
 * 正規化の規則は alc-redact の `src/etc_card.rs` (OCR 側の正規化) と同じ: 全角数字を半角にし、
 * カード番号は数字 16 桁・車載器番号は数字 19 桁のときだけ値にする (それ以外は null)。
 * OCR 側で正規化済みでも、ここで同じ規則をもう一度かける (手入力と同じ関門を通すため)。
 */
import { caughtErrorStatus, describeCaughtError } from '~/utils/api-error'
import { formatIssuedDate } from '~/utils/machine-credentials'

export const KUBUN = ['新規', '追加', '再発行'] as const
export type Kubun = (typeof KUBUN)[number]

export const CARD_NUMBER_DIGITS = 16
export const OBU_NUMBER_DIGITS = 19

export const STATUSES = ['needs_review', 'waiting_run', 'dry_run_ok', 'registered', 'failed'] as const
export type EtcCardStatus = (typeof STATUSES)[number]

export const STATUS_LABEL: Record<EtcCardStatus, string> = {
  needs_review: '要確認',
  waiting_run: '走行待ち',
  dry_run_ok: '登録の試行 OK',
  registered: '登録済み',
  failed: '失敗',
}

/** OCR / 手入力から取る 4 項目 (車両番号は原文) */
export interface EtcCardFields {
  kubun: Kubun | null
  card_number: string | null
  vehicle_number: string | null
  obu_number: string | null
}

/** 全角数字・全角ハイフンを半角にする */
export function halfwidth(s: string): string {
  return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/－/g, '-')
}

function asText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = halfwidth(v).trim()
  return t === '' ? null : t
}

/** 数字以外を落とし、桁数が `digits` のときだけ返す */
export function normalizeDigits(v: unknown, digits: number): string | null {
  const t = asText(v)
  if (t === null) return null
  const d = t.replace(/\D/g, '')
  return d.length === digits ? d : null
}

/**
 * 3 種のどれかなら返す。「新規発行」「追加発行」のような末尾の「発行」も落として読む。
 * **そのままの形を先に見る** — 「再発行」は末尾の「発行」を落とすと「再」になって消えるため。
 */
export function normalizeKubun(v: unknown): Kubun | null {
  const t = asText(v)
  if (t === null) return null
  const known = (k: string) => (KUBUN as readonly string[]).includes(k)
  if (known(t)) return t as Kubun
  const k = t.endsWith('発行') ? t.slice(0, -2) : t
  return known(k) ? k as Kubun : null
}

/** OCR の 1 行 (形が崩れていても) を 4 項目にする。読めない項目は null */
export function normalizeFields(raw: unknown): EtcCardFields {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    kubun: normalizeKubun(r.kubun),
    card_number: normalizeDigits(r.card_number, CARD_NUMBER_DIGITS),
    vehicle_number: asText(r.vehicle_number),
    obu_number: normalizeDigits(r.obu_number, OBU_NUMBER_DIGITS),
  }
}

/** 4 項目とも null の行 (空行) か */
export function isEmptyFields(f: EtcCardFields): boolean {
  return f.kubun === null && f.card_number === null && f.vehicle_number === null && f.obu_number === null
}

/**
 * 車両番号の末尾の数字からナンバー下 4 桁を作る (先頭の 0 は落とす)。
 * 一連指定番号の表記 `12-34` / `・・12` の区切り (`-` `・` 空白) は数字の間にあっても読み飛ばす。
 * 数字が無い・4 桁を超える・0 だけ → null。
 */
export function plate4Of(vehicle: string | null): string | null {
  if (vehicle === null) return null
  const tail = /[0-9・･\-\s]+$/.exec(halfwidth(vehicle))?.[0] ?? ''
  const digits = tail.replace(/\D/g, '')
  if (digits === '' || digits.length > 4) return null
  const n = digits.replace(/^0+/, '')
  return n === '' ? null : n
}

/** 4 項目 (card_number / plate4 / obu_number / kubun) が揃えば waiting_run、どれか欠ければ needs_review */
export function initialStatus(f: EtcCardFields): 'needs_review' | 'waiting_run' {
  return f.card_number !== null && plate4Of(f.vehicle_number) !== null && f.obu_number !== null && f.kubun !== null
    ? 'waiting_run'
    : 'needs_review'
}

/** 手直しの入力 (画面の 4 つの欄)。card_number は空なら「今の値のまま」 */
export interface EtcCardEdit {
  kubun: string
  card_number: string
  vehicle_number: string
  obu_number: string
}

export type EditResult =
  | { ok: true, fields: EtcCardFields }
  | { ok: false, error: string }

/**
 * 手直しの入力を今の値に重ねて 4 項目にする。OCR と違い、入れた値が規則に合わなければ
 * null に落とさず誤りにする (黙って消えると「保存したのに要確認のまま」になるため)。
 * card_number は画面に全桁を出さないので、空欄は「今の値のまま」。他の 3 つは空欄で消せる。
 */
export function applyEdit(current: EtcCardFields, input: unknown): EditResult {
  if (!input || typeof input !== 'object') return { ok: false, error: '入力の形が違います' }
  const e = input as Record<string, unknown>
  const fields = { ...current }

  if (e.kubun !== undefined) {
    const t = asText(e.kubun)
    const k = normalizeKubun(t)
    if (t !== null && k === null) return { ok: false, error: `区分は ${KUBUN.join(' / ')} のどれかです` }
    fields.kubun = k
  }
  if (e.card_number !== undefined && asText(e.card_number) !== null) {
    const c = normalizeDigits(e.card_number, CARD_NUMBER_DIGITS)
    if (c === null) return { ok: false, error: `カード番号は数字 ${CARD_NUMBER_DIGITS} 桁です` }
    fields.card_number = c
  }
  if (e.vehicle_number !== undefined) {
    const v = asText(e.vehicle_number)
    if (v !== null && plate4Of(v) === null) return { ok: false, error: '車両番号の末尾にナンバー (4 桁以内の数字) が読めません' }
    fields.vehicle_number = v
  }
  if (e.obu_number !== undefined) {
    const t = asText(e.obu_number)
    const o = normalizeDigits(t, OBU_NUMBER_DIGITS)
    if (t !== null && o === null) return { ok: false, error: `車載器番号は数字 ${OBU_NUMBER_DIGITS} 桁です` }
    fields.obu_number = o
  }
  return { ok: true, fields }
}

/** 一覧 API (`GET /api/etc-cards`) の 1 行。カード番号は末尾 5 桁しか返さない */
export interface EtcCardView {
  id: number
  scan_sha256: string
  kubun: Kubun | null
  card_last5: string | null
  vehicle_number: string | null
  plate4: string | null
  obu_number: string | null
  status: EtcCardStatus
  run_date: string | null
  unko_no: string | null
  /** 画面で入れた登録日 (`YYYY-MM-DD`、JST) or null。null なら {@link received_at} の日付で代える */
  registration_date: string | null
  /** 明細書 (scan) を受けた時刻 (`etc_card_scans.received_at`、UTC の ISO8601) */
  received_at: string
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

/** OCR に失敗した scan (画面の「再 OCR」の対象) */
export interface EtcScanView {
  sha256: string
  bytes: number
  received_at: string
  ocr_error: string | null
}

export interface EtcCardsResponse {
  registrations: EtcCardView[]
  failed_scans: EtcScanView[]
}

/** カード番号の末尾 5 桁 (無ければ null) */
export function cardLast5(card: string | null): string | null {
  return card === null ? null : card.slice(-5)
}

/** 画面のカード番号欄 */
export function maskedCard(last5: string | null): string {
  return last5 === null ? '(未読)' : `…${last5}`
}

/** scan の大きさ。1KB 未満を「0 KB」に丸めない */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** status ごとの件数 (0 件の status も 0 で並べる) */
export function countByStatus(rows: readonly { status: string }[]): Record<EtcCardStatus, number> {
  const out = Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<EtcCardStatus, number>
  for (const r of rows) {
    if ((STATUSES as readonly string[]).includes(r.status)) out[r.status as EtcCardStatus] += 1
  }
  return out
}

/** ISO8601 (UTC) の時刻の JST の日付 `YYYY-MM-DD` (画面の「受信日」)。 */
export function receivedDate(receivedAt: string): string {
  return formatIssuedDate(receivedAt)
}

/**
 * カード行の**実効の登録日**: 入れた `registration_date`、空なら受信日 (JST)。relay はこの日より前の
 * 走行を、そのカードの利用日にしない (カードを受け取る前の走行は古いカードで走った分のため)。
 *
 * relay (`workers/dtako-scraper-relay/src/etc-card-register.ts`) の同名関数と同じ規則
 * (front は relay を import できない)。入出力は両方のテストで同じ表に固定している。
 */
export function effectiveRegistrationDate(registrationDate: string | null, receivedAt: string): string {
  return registrationDate ?? receivedDate(receivedAt)
}

export type RegistrationDateInput =
  | { ok: true, value: string | null }
  | { ok: false, error: string }

/**
 * `PATCH /api/etc-cards/[id]/registration-date` の本文 `{registration_date}` を読む。
 * `YYYY-MM-DD` の実在する日付か、`null` / 空文字 (= 受信日に戻す) だけ通す。
 */
export function parseRegistrationDateInput(input: unknown): RegistrationDateInput {
  if (!input || typeof input !== 'object' || !('registration_date' in input)) {
    return { ok: false, error: '入力の形が違います' }
  }
  const v = (input as Record<string, unknown>).registration_date
  if (v === null || v === '') return { ok: true, value: null }
  // 月 13 は Date が NaN、2/30 は 3/2 に繰り上がるので、読み戻して同じ文字列かで実在を確かめる
  const t = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Number.NaN
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) {
    return { ok: false, error: '登録日は YYYY-MM-DD の日付です' }
  }
  return { ok: true, value: v as string }
}

/**
 * 登録日を変えたあとの status。`dry_run_ok` / `failed` は `waiting_run` に戻す (古い走行日で
 * 確認・登録したものを、新しい下限で探し直すため)。他はそのまま。`registered` は呼び手が 409 にする。
 */
export function statusAfterRegistrationDateChange(status: EtcCardStatus): EtcCardStatus {
  return status === 'dry_run_ok' || status === 'failed' ? 'waiting_run' : status
}

/** 「今すぐ登録」を出す行か (要確認と登録済みには出さない) */
export function canRegister(status: EtcCardStatus): boolean {
  return status !== 'needs_review' && status !== 'registered'
}

/** 「走行日を探し直す」を出す行か (走行待ちで下 4 桁があるものだけ。relay がそれ以外を 404 にする) */
export function canRescan(r: Pick<EtcCardView, 'status' | 'plate4'>): boolean {
  return r.status === 'waiting_run' && r.plate4 !== null
}

/** 「走行日を探し直す」を受け付けたときに行の下へ出す文 (relay は 202 で受けて後で回す) */
export const RESCAN_ACCEPTED_TEXT = '探し直しを受け付けました。数分後に再読み込みしてください'

/** API の失敗を画面の文にする。404 は relay 側の口がまだ無い (未デプロイ) か、行が無い */
export function etcCardErrorText(e: unknown, retry: string): string {
  const status = caughtErrorStatus(e)
  if (status === 404) return '見つかりません (登録の仕組みがまだ入っていないか、行が消えています)'
  if (status === 409) return '今の状態ではこの操作はできません。再読み込みしてください'
  return describeCaughtError(e, retry)
}
