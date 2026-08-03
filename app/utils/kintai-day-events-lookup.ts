/**
 * 取り込み漏れ候補 (22桁) から実物の23桁 `unko_no` を引いた結果の表示用 pure
 * ロジック (Refs #625)。
 *
 * `GET /restraint-api/kintai/day-events-lookup` (relay
 * `workers/dtako-scraper-relay/src/dtako-scraper-relay-do.ts` の
 * `handleKintaiDayEventsLookup`、中身は `dtako-day-events-lookup.ts`) の応答を
 * そのまま読む。**新しい判定はしない** — 受け側が返す `status`
 * (found/not_found/ambiguous) をそのまま出すだけ。
 *
 * ★ この口は「② の後に読むだけ」で、②(取り込み)自体は実行しない。②直後に
 * 反映されているかは未確認 (親の 0 段目コメント参照) なので、この関数・呼び出し
 * 側も自動リトライを持たない — 何回でも安全に呼べる (副作用が無い) ことを
 * 利用して、押す/時間をおいてもう一度押すの判断は人に委ねる。
 *
 * すべて `unknown` を受けて防御的に読む (root `npm install` が通らず front は CI
 * が初検証のため、実行時前提を増やさない — CLAUDE.md の規範)。
 */

export type DayEventsLookupStatus = 'found' | 'not_found' | 'ambiguous'

export interface DayEventsLookup {
  driverCd: string | null
  date: string | null
  opeNo: string | null
  status: DayEventsLookupStatus | null
  /** status === 'found' のときだけ非null。 */
  unkoNo: string | null
  /** マッチした23桁の一覧。ambiguous のとき人に選ばせるための候補一覧。 */
  candidates: string[]
}

const STATUSES: readonly DayEventsLookupStatus[] = ['found', 'not_found', 'ambiguous']

function toStringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function toStatusOrNull(v: unknown): DayEventsLookupStatus | null {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v) ? (v as DayEventsLookupStatus) : null
}

/**
 * `lookup.unkoNo` (relay `dtako-day-events-lookup.ts` の `DayEventsLookupResult`
 * がそのまま JSON になった実物のキー、**camelCase**) を優先して読み、無ければ
 * `lookup.unko_no` (snake_case) を fallback として見る。
 *
 * ★ 本番実測で確定したバグ (Refs #633-2、親の実機確認 2026-08-04):
 * `Response.json({ ..., lookup })` の `lookup` は relay 側の TS オブジェクト
 * (`DayEventsLookupResult { status, unkoNo, candidates }`) をそのまま返しており、
 * **`unko_no` へは変換されない**。以前の実装は `lookup.unko_no` だけを読んでいたため
 * 常に `undefined` → `null` になり、`status: 'found'` でも23桁が出ない状態が
 * (この関数が #625 で作られてから) 本番でずっと続いていた可能性が高い。
 * `status`/`candidates` はキー名が一致しているため影響を受けていない。
 * fallback は残す — 受け側の形が将来 snake_case に揃っても壊れないための保険。
 */
function pickUnkoNo(lookup: Record<string, unknown>): string | null {
  if (typeof lookup.unkoNo === 'string') return lookup.unkoNo
  return toStringOrNull(lookup.unko_no)
}

/** `GET /restraint-api/kintai/day-events-lookup` の応答をそのまま camelCase に
 * 読み替える。壊れた形は全部 `null`/空配列に倒す — 呼び出し側は `status: null`
 * を「引けていない (found/not_found/ambiguousのどれとも言えない)」として
 * 「見つからなかった」と混同しないこと。 */
export function parseDayEventsLookup(raw: unknown): DayEventsLookup {
  const r = (raw ?? {}) as Record<string, unknown>
  const lookup = (r.lookup ?? {}) as Record<string, unknown>
  return {
    driverCd: toStringOrNull(r.driver_cd),
    date: toStringOrNull(r.date),
    opeNo: toStringOrNull(r.ope_no),
    status: toStatusOrNull(lookup.status),
    unkoNo: pickUnkoNo(lookup),
    candidates: toStringArray(lookup.candidates),
  }
}
