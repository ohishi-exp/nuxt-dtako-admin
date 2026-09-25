/**
 * 訴訟準備の「変更記録」タブ (Refs #1133 c1133-6) の pure ロジック。
 *
 * 目標は「出力分ではなく差分」— **取り込んだ時点の値を基準に、あとで変わった記録**を
 * 1 つの表にまとめる (ユーザー決定、#c1133-5 の申し送り参照)。記録は仕組みを作った日
 * (2026-09-25) から — それより前の変更は記録されていない。
 *
 * 素材は 2 系統、どちらも読むだけ (新しい計算はしない):
 *
 * | 種別 | 口 | 受け側 |
 * | --- | --- | --- |
 * | 打刻 (`打刻`) | `GET /restraint-api/kintai/change-log` (relay `kintai-relay.ts` の `relayKintaiChangeLog`) | ohishi-exp/rust-ichibanboshi#320 |
 * | 運行 (`運行`) | `GET /api/proxy/api/dtako/operation-changes` (既存の alc-proxy 経由。`app/utils/api.ts` の `getDtakoOperationChanges`) | ippoan/rust-alc-api#679 |
 *
 * 応答は防御的に読む (`unknown` を受ける、壊れた形は空/null に倒す — `kintai-unko-gaps.ts`
 * と同じ作法。root `npm install` が通らず front は CI が初検証のため実行時前提を増やさない)。
 *
 * ## 要約 (`summary`) は「変わったものだけ」
 *
 * 打刻: before/after の events を `state` ごとに突き合わせ、時刻 (JST HH:mm) が
 * 変わった state だけを列に出す (「始業 08:00 → 07:30」)。after が丸ごと `null`
 * (その日の記録が消えた) なら、before に居た state 全部が「→ (消えた)」になる。
 *
 * 運行: `reason: 'manual_delete'` (または `after === null`) はそのまま「手動削除」。
 * それ以外 (`reupload`) は乗務員CD・休憩・休息・運転・荷役の分数を before/after で
 * 比べ、変わったものだけを列に出す。`before.before_kudgivt === 'unavailable'`
 * (旧 KUDGIVT が読めなかった回) は分数を比較せず「前回の休憩・休息は記録なし」と
 * 明示する (取れない値を「変化なし」と誤読させない)。
 */
import { csvCell } from './wage-range-view'
import { daysInMonth } from './timecard-view'

/** 案件の期間 (開始月〜終了月) を実際の日付範囲にする — 開始月の1日〜終了月の末日
 * (画面の指示「期間は案件の開始月初〜終了月末」)。 */
export function litigationCaseDateBounds(fromMonth: string, toMonth: string): { from: string, to: string } {
  const [y, m] = toMonth.split('-').map(Number) as [number, number]
  return { from: `${fromMonth}-01`, to: `${toMonth}-${String(daysInMonth(y, m)).padStart(2, '0')}` }
}

/**
 * `from`〜`to` (両端含む、`YYYY-MM-DD`) を `maxDays` 日以内のチャンクに分ける
 * (打刻の変更記録は relay が 400 日上限を強制するため、案件の期間がそれを超えたら
 * 分けて読む)。`from > to` は空配列。
 */
export function splitDateRangeByMaxDays(from: string, to: string, maxDays: number): { from: string, to: string }[] {
  const out: { from: string, to: string }[] = []
  let cur = from
  while (cur <= to) {
    const curMs = new Date(`${cur}T00:00:00Z`).getTime()
    const chunkEnd = new Date(curMs + (maxDays - 1) * 86_400_000).toISOString().slice(0, 10)
    const end = chunkEnd < to ? chunkEnd : to
    out.push({ from: cur, to: end })
    cur = new Date(new Date(`${end}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)
  }
  return out
}

// ---- 打刻の変更記録 (`GET /restraint-api/kintai/change-log`) ----

export interface KintaiChangeEvent {
  /** ISO 文字列 (UTC)。壊れていても文字列のまま持つ (表示側で捨てる)。 */
  occurredAt: string
  state: string
  source: string
  unkoNo: string | null
}

export interface KintaiChangeLogEntry {
  driverCd: string | null
  /** `YYYY-MM-DD` */
  date: string
  /** ISO 文字列 (UTC) */
  recordedAt: string
  before: KintaiChangeEvent[]
  /** `null` = その日の記録が丸ごと消えた */
  after: KintaiChangeEvent[] | null
}

export interface KintaiChangeLogResponse {
  driver: string | null
  from: string | null
  to: string | null
  /** `null` = まだ1件も記録されていない */
  recordingSince: string | null
  changes: KintaiChangeLogEntry[]
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function parseKintaiChangeEvent(raw: unknown): KintaiChangeEvent | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.occurred_at !== 'string' || typeof r.state !== 'string') return null
  return {
    occurredAt: r.occurred_at,
    state: r.state,
    source: typeof r.source === 'string' ? r.source : '',
    unkoNo: toStringOrNull(r.unko_no),
  }
}

function parseKintaiChangeEvents(raw: unknown): KintaiChangeEvent[] {
  return Array.isArray(raw)
    ? raw.map(parseKintaiChangeEvent).filter((e): e is KintaiChangeEvent => e !== null)
    : []
}

function parseKintaiChangeLogEntry(raw: unknown): KintaiChangeLogEntry | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.date !== 'string' || typeof r.recorded_at !== 'string') return null
  const driverCd = typeof r.driver_cd === 'string'
    ? r.driver_cd
    : typeof r.driver_cd === 'number'
      ? String(r.driver_cd)
      : null
  return {
    driverCd,
    date: r.date,
    recordedAt: r.recorded_at,
    before: parseKintaiChangeEvents(r.before),
    after: r.after === null ? null : parseKintaiChangeEvents(r.after),
  }
}

/** `GET /restraint-api/kintai/change-log` の応答を読む。壊れた形は空 (`changes: []`、
 * `recordingSince: null`) に倒す — 「記録が無い」と混同しないよう、呼び出し側が
 * 403 (会社不一致) やその他の失敗は別扱いにすること (このパーサは 2xx 応答用)。 */
export function parseKintaiChangeLog(raw: unknown): KintaiChangeLogResponse {
  const r = (raw ?? {}) as Record<string, unknown>
  const changesRaw = Array.isArray(r.changes) ? r.changes : []
  return {
    driver: toStringOrNull(r.driver) ?? (typeof r.driver === 'number' ? String(r.driver) : null),
    from: toStringOrNull(r.from),
    to: toStringOrNull(r.to),
    recordingSince: toStringOrNull(r.recording_since),
    changes: changesRaw
      .map(parseKintaiChangeLogEntry)
      .filter((e): e is KintaiChangeLogEntry => e !== null),
  }
}

// ---- 運行の変更記録 (`GET /api/proxy/api/dtako/operation-changes`) ----

export type AlcOperationChangeReason = 'reupload' | 'manual_delete'

export interface AlcOperationSnapshot {
  driverCd: string | null
  departureAt: string | null
  returnAt: string | null
  driveMinutes: number | null
  cargoMinutes: number | null
  breakMinutes: number | null
  restMinutes: number | null
  /** 旧 KUDGIVT が読めなかった回 (`before_kudgivt: "unavailable"`)。このときは
   * 上の 4 つの分数キーが応答に無い (`null` で受ける)。 */
  kudgivtUnavailable: boolean
}

export interface AlcOperationChangeEntry {
  /** 22 桁 */
  unkoNo: string
  /** 1 = 主、2 = 助手。壊れていれば `null`。 */
  crewRole: number | null
  /** ISO 文字列 (UTC) */
  recordedAt: string
  reason: AlcOperationChangeReason | null
  before: AlcOperationSnapshot | null
  /** `null` = 手動削除 (この運行がまるごと削られた) */
  after: AlcOperationSnapshot | null
}

export interface AlcOperationChangesResponse {
  driverCd: string | null
  from: string | null
  to: string | null
  recordingSince: string | null
  changes: AlcOperationChangeEntry[]
}

function toNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parseAlcOperationSnapshot(raw: unknown): AlcOperationSnapshot | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kudgivtUnavailable = r.before_kudgivt === 'unavailable'
  return {
    driverCd: toStringOrNull(r.driver_cd) ?? (typeof r.driver_cd === 'number' ? String(r.driver_cd) : null),
    departureAt: toStringOrNull(r.departure_at),
    returnAt: toStringOrNull(r.return_at),
    // 読めなかった回は分数キーが応答に無い前提 — 万一値が乗っていても、比較しない
    // (`kudgivtUnavailable` を先に見る呼び出し側の作法) ので拾っても害は無いが、
    // 「読めなかった」を hallucinate しないよう明示的に null へ倒す。
    driveMinutes: kudgivtUnavailable ? null : toNumberOrNull(r.drive_minutes),
    cargoMinutes: kudgivtUnavailable ? null : toNumberOrNull(r.cargo_minutes),
    breakMinutes: kudgivtUnavailable ? null : toNumberOrNull(r.break_minutes),
    restMinutes: kudgivtUnavailable ? null : toNumberOrNull(r.rest_minutes),
    kudgivtUnavailable,
  }
}

function parseAlcReason(v: unknown): AlcOperationChangeReason | null {
  return v === 'reupload' || v === 'manual_delete' ? v : null
}

function parseAlcOperationChangeEntry(raw: unknown): AlcOperationChangeEntry | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.unko_no !== 'string' || typeof r.recorded_at !== 'string') return null
  return {
    unkoNo: r.unko_no,
    crewRole: toNumberOrNull(r.crew_role),
    recordedAt: r.recorded_at,
    reason: parseAlcReason(r.reason),
    before: parseAlcOperationSnapshot(r.before),
    after: r.after === null ? null : parseAlcOperationSnapshot(r.after),
  }
}

/** `GET /api/proxy/api/dtako/operation-changes` の応答を読む。壊れた形は空に倒す
 * (`parseKintaiChangeLog` と同じ作法)。 */
export function parseAlcOperationChanges(raw: unknown): AlcOperationChangesResponse {
  const r = (raw ?? {}) as Record<string, unknown>
  const changesRaw = Array.isArray(r.changes) ? r.changes : []
  return {
    driverCd: toStringOrNull(r.driver_cd) ?? (typeof r.driver_cd === 'number' ? String(r.driver_cd) : null),
    from: toStringOrNull(r.from),
    to: toStringOrNull(r.to),
    recordingSince: toStringOrNull(r.recording_since),
    changes: changesRaw
      .map(parseAlcOperationChangeEntry)
      .filter((e): e is AlcOperationChangeEntry => e !== null),
  }
}

// ---- 1 つの表にまとめる ----

export type LitigationChangeKind = '打刻' | '運行'

export interface LitigationChangeRow {
  /** 表示用 (JST) `YYYY-MM-DD HH:mm` */
  recordedAt: string
  /** 並び替え用 (元の ISO 文字列。壊れていれば空文字 = 最も古い扱い) */
  recordedAtSort: string
  kind: LitigationChangeKind
  target: string
  summary: string
  /** 打刻は空文字 (このAPIに reason は無い)。運行は「上げ直し」/「手動削除」/(不明なら空)。 */
  reason: string
}

/** ISO 文字列 (UTC) を JST の `YYYY-MM-DD HH:mm` にする。パースできなければ元の文字列。
 * (`kintai-diff-view.ts` の `fmtKintaiDiffLastVerified` と同じ JST 変換の作法 — 壁時計を
 * UTC getter で読む。ここでは日付も出すので桁数が違う。) */
function fmtJstDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const jst = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`
}

/** ISO 文字列 (UTC) を JST の `HH:mm` だけにする。パースできなければ `不明`。 */
function fmtJstHHMM(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '不明'
  const jst = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`
}

/** state ごとの時刻一覧 (JST HH:mm、同じ state が複数あれば時刻順)。 */
function timesByState(events: readonly KintaiChangeEvent[]): Map<string, string> {
  const grouped = new Map<string, string[]>()
  for (const e of events) {
    const list = grouped.get(e.state) ?? []
    list.push(fmtJstHHMM(e.occurredAt))
    grouped.set(e.state, list)
  }
  const out = new Map<string, string>()
  for (const [state, times] of grouped) out.set(state, [...times].sort().join('/'))
  return out
}

/** 打刻 1 件の要約。state ごとに before/after を突き合わせ、変わったものだけを並べる。 */
export function kintaiChangeSummary(entry: Pick<KintaiChangeLogEntry, 'before' | 'after'>): string {
  const before = timesByState(entry.before)
  const after = entry.after === null ? new Map<string, string>() : timesByState(entry.after)
  const states = [...new Set([...before.keys(), ...after.keys()])]
  const parts: string[] = []
  for (const state of states) {
    const b = before.get(state) ?? null
    const a = after.get(state) ?? null
    if (b === a) continue
    parts.push(`${state} ${b ?? '(無かった)'} → ${a ?? '(消えた)'}`)
  }
  if (parts.length > 0) return parts.join(' / ')
  return entry.after === null ? '日ごと消えた (記録なし)' : '変化なし'
}

/** 乗務区分の表示名。1=主、2=助手。それ以外/不明はそのまま出す。 */
function crewRoleLabel(crewRole: number | null): string {
  if (crewRole === 1) return '主'
  if (crewRole === 2) return '助手'
  return crewRole === null ? '不明' : `区分${crewRole}`
}

const ALC_MINUTE_FIELDS: readonly { key: keyof AlcOperationSnapshot, label: string }[] = [
  { key: 'breakMinutes', label: '休憩' },
  { key: 'restMinutes', label: '休息' },
  { key: 'driveMinutes', label: '運転' },
  { key: 'cargoMinutes', label: '荷役' },
]

function fmtMinutesOrUnknown(v: number | null): string {
  return v === null ? '不明' : String(v)
}

/** 運行 1 件の要約。`manual_delete` (または `after === null`) はそのまま「手動削除」。
 * それ以外は乗務員CD・分数フィールドを before/after で比べ、変わったものだけ並べる。
 * `before.kudgivtUnavailable` (旧 KUDGIVT が読めなかった回) は分数を比較せず明示する。 */
export function alcChangeSummary(entry: Pick<AlcOperationChangeEntry, 'reason' | 'before' | 'after'>): string {
  if (entry.reason === 'manual_delete' || entry.after === null) return '手動削除'
  const { before, after } = entry
  const parts: string[] = []
  if (before?.kudgivtUnavailable) parts.push('前回の休憩・休息は記録なし')
  if (before && after && before.driverCd !== after.driverCd) {
    parts.push(`乗務員 ${before.driverCd ?? '不明'} → ${after.driverCd ?? '不明'}`)
  }
  if (before && after && !before.kudgivtUnavailable) {
    for (const f of ALC_MINUTE_FIELDS) {
      const b = before[f.key] as number | null
      const a = after[f.key] as number | null
      if (b !== a) parts.push(`${f.label} ${fmtMinutesOrUnknown(b)} → ${fmtMinutesOrUnknown(a)} 分`)
    }
  }
  return parts.length > 0 ? parts.join(' / ') : '変化なし'
}

export const ALC_REASON_LABEL: Record<AlcOperationChangeReason, string> = {
  reupload: '上げ直し',
  manual_delete: '手動削除',
}

/** 打刻の変更記録を表の行に変換する (古い順/新しい順は呼び出し側で並べ替える)。 */
export function buildKintaiChangeRows(entries: readonly KintaiChangeLogEntry[]): LitigationChangeRow[] {
  return entries.map(e => ({
    recordedAt: fmtJstDateTime(e.recordedAt),
    recordedAtSort: e.recordedAt,
    kind: '打刻' as const,
    target: e.date,
    summary: kintaiChangeSummary(e),
    reason: '',
  }))
}

/** 運行の変更記録を表の行に変換する。 */
export function buildAlcChangeRows(entries: readonly AlcOperationChangeEntry[]): LitigationChangeRow[] {
  return entries.map(e => ({
    recordedAt: fmtJstDateTime(e.recordedAt),
    recordedAtSort: e.recordedAt,
    kind: '運行' as const,
    target: `${e.unkoNo} (${crewRoleLabel(e.crewRole)})`,
    summary: alcChangeSummary(e),
    reason: e.reason ? ALC_REASON_LABEL[e.reason] : '',
  }))
}

/** 打刻・運行の行をまとめ、記録時刻の新しい順にする (壊れた `recordedAtSort` = 空文字は
 * 最も古い扱いなので末尾に落ちる)。 */
export function mergeLitigationChangeRows(
  kintaiRows: readonly LitigationChangeRow[],
  alcRows: readonly LitigationChangeRow[],
): LitigationChangeRow[] {
  return [...kintaiRows, ...alcRows].sort((a, b) => b.recordedAtSort.localeCompare(a.recordedAtSort))
}

// ---- 記録開始日の文言 (「変更なし」「記録が無い」「読めなかった」を混同しない) ----

/** 打刻の記録開始日の文言。`recordingSince` が `null` なら「まだ1件も記録されていない」。 */
export function kintaiRecordingSinceNotice(recordingSince: string | null): string {
  return recordingSince
    ? `打刻の変更記録は ${recordingSince} から。それより前の変更は記録されていません。`
    : 'まだ打刻の変更記録が1件も無い (仕組みは2026-09-25に入った — それ以降まだ何も変わっていない)。'
}

/** 運行の記録開始日の文言。 */
export function alcRecordingSinceNotice(recordingSince: string | null): string {
  return recordingSince
    ? `運行の変更記録は ${recordingSince} から。それより前の変更は記録されていません。`
    : 'まだ運行の変更記録が1件も無い (仕組みは2026-09-25に入った — それ以降まだ何も変わっていない)。'
}

/** KINTAI_COMP_ID 以外の会社が打刻の変更記録 (403) を読もうとしたときの文言。 */
export const KINTAI_CHANGE_LOG_FORBIDDEN_NOTICE = 'この会社の打刻の変更記録は読めません。'

/** relay `kintai-relay.ts` の `CHANGE_LOG_MAX_DAYS` と同じ値。front と relay は別
 * バンドルなので import できず、値を手で揃える (relay 側を変えたらここも)。 */
export const LITIGATION_CHANGE_LOG_MAX_DAYS = 400

// ---- CSV ----

export const LITIGATION_CHANGES_CSV_FILENAME = '変更記録.csv'

/**
 * 変更記録 CSV。**先頭に UTF-8 BOM** (litigation-errors.ts の `litigationErrorsCsv` と
 * 同じ作法 — Excel が Shift_JIS と誤認しないため)。`notices` (記録開始日の文言・
 * 403・読めなかった旨) は空行のあとに別の表として続ける
 * (`litigationErrorsCsv` の警告ブロックと同じ形)。
 */
export function litigationChangesCsv(rows: readonly LitigationChangeRow[], notices: readonly string[] = []): string {
  const header = ['記録日時', '種別', '対象', '内容', '理由']
  const lines = [header.map(csvCell).join(',')]
  for (const r of rows) {
    lines.push([r.recordedAt, r.kind, r.target, r.summary, r.reason].map(csvCell).join(','))
  }
  if (notices.length > 0) {
    lines.push('')
    lines.push(['備考'].map(csvCell).join(','))
    for (const n of notices) lines.push([n].map(csvCell).join(','))
  }
  return `﻿${lines.join('\n')}\n`
}
