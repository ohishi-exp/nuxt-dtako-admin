/**
 * 月タブの「畳み直しが要る月」丸の表示用 pure ロジック (Refs #620)。
 *
 * `GET /restraint-api/kintai/stale-months` (relay
 * `workers/dtako-scraper-relay/src/kintai-relay.ts` の `relayKintaiStaleMonths`。
 * 受け側は rust-ichibanboshi `src/routes/stale_months.rs`) の応答を読む。
 * **新しい計算はしない** — 既に本番にある軽い口 (Postgres 1 往復、`unko_diff` の
 * etags 掃引を含まない) をそのまま読むだけ。`/restraint-api/kintai/diff`
 * (フル突合、約50秒) は月タブのために叩かない (Refs #620 本文)。
 *
 * ★ `stale_drivers: 0` だけでは判断できない — この module の一番の目的。
 * `total_drivers` と組で読むこと (#620 の受け入れ条件):
 *
 * | 条件 | 意味 | 丸 |
 * |---|---|---|
 * | `total_drivers === 0` | その月は `day_summaries` が1行も無い (未取り込み/対象外) | データ無し |
 * | `total_drivers > 0 && stale_drivers === 0` | 畳み済みで最新 | 塗らない |
 * | `stale_drivers > 0` | 畳み直しが要る | 塗る |
 *
 * **`total_drivers === 0` を「収束済み」と同じ見た目にしないこと** — 未取り込みの月が
 * 「畳み済みで最新」に見えるのは #620 が解こうとしている問題を作り直すことになる。
 *
 * ★ もう1つの落とし穴 (#620 コメント参照): 同じタブの観測値「対象月に GCP にしか
 * 無い運行数」で丸を塗ってはいけない。打刻システムが無い営業所の乗務員 (`never_onprem`)
 * が実測の大半 (2026-06 で93%) を占め、差ではなく毎月必ず点灯する無意味な警告になる
 * (#613 で決着済み)。**この module は `stale_drivers` しか読まない** — そもそも
 * `unko_diff` 系の値をこの応答は持たない (受け側の設計自体がそう分離してある)。
 *
 * すべて `unknown` を受けて防御的に読む (root `npm install` が通らず front は CI が
 * 初検証のため、実行時前提を増やさない — CLAUDE.md の規範)。
 */

export interface KintaiStaleMonthEntry {
  month: string
  staleDrivers: number
  totalDrivers: number
}

export interface KintaiStaleMonthsResponse {
  logicVersion: string | null
  from: string | null
  to: string | null
  defaultWindowMonths: number | null
  months: KintaiStaleMonthEntry[]
}

function toNumberOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function parseStaleMonthEntry(raw: unknown): KintaiStaleMonthEntry | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.month !== 'string') return null
  return {
    month: r.month,
    staleDrivers: toNumberOr0(r.stale_drivers),
    totalDrivers: toNumberOr0(r.total_drivers),
  }
}

/** `GET /restraint-api/kintai/stale-months` の応答をそのまま camelCase に読み替える。
 * 壊れた形は空 (`months: []`) に倒す — 呼び出し側は「1件も読めなかった」を
 * `unknown` バッジ (全月まとめて) として扱う。 */
export function parseKintaiStaleMonths(raw: unknown): KintaiStaleMonthsResponse {
  const r = (raw ?? {}) as Record<string, unknown>
  const monthsRaw = Array.isArray(r.months) ? r.months : []
  return {
    logicVersion: typeof r.logic_version === 'string' ? r.logic_version : null,
    from: typeof r.from === 'string' ? r.from : null,
    to: typeof r.to === 'string' ? r.to : null,
    defaultWindowMonths:
      typeof r.default_window_months === 'number' && Number.isFinite(r.default_window_months)
        ? r.default_window_months
        : null,
    months: monthsRaw
      .map(parseStaleMonthEntry)
      .filter((m): m is KintaiStaleMonthEntry => m !== null),
  }
}

/**
 * 月タブの丸の4値。**塗る (`stale`) 条件は `staleDrivers > 0` のみ**
 * (Refs #620 決定: 「GCPにしか無い運行」では塗らない)。
 *
 * - `stale`: 畳み直しが要る (赤)
 * - `no_data`: `day_summaries` が1行も無い月 (灰、「収束済み」とは別扱い)
 * - `ok`: 畳み済みで最新 (塗らない)
 * - `unknown`: 応答に無い月 (窓の外、または未取得。「合っている」と混同しない)
 */
export type KintaiStaleMonthBadge = 'stale' | 'no_data' | 'ok' | 'unknown'

/** `monthKey` (`YYYY-MM`) の丸を判定する。 */
export function kintaiStaleMonthBadge(
  monthKey: string,
  months: readonly KintaiStaleMonthEntry[],
): KintaiStaleMonthBadge {
  const entry = months.find(m => m.month === monthKey)
  if (!entry) return 'unknown'
  if (entry.totalDrivers === 0) return 'no_data'
  if (entry.staleDrivers > 0) return 'stale'
  return 'ok'
}

/** `entry.staleDrivers` を出すための lookup (ツールチップ用)。無ければ `null`。 */
export function kintaiStaleMonthEntry(
  monthKey: string,
  months: readonly KintaiStaleMonthEntry[],
): KintaiStaleMonthEntry | null {
  return months.find(m => m.month === monthKey) ?? null
}

/** `YYYY` + 月番号(1-12) から `YYYY-MM` キーを組む (月タブの year/month セレクタと同形)。 */
export function kintaiStaleMonthKey(year: number, monthNo: number): string {
  return `${year}-${String(monthNo).padStart(2, '0')}`
}
