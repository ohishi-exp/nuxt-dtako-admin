/**
 * NET780 一括取得 (Refs #760 の 27) の **画面側と server route が共有する pure な部品**。
 * relay の `POST /kintai-relay/net780-archive` (#760-26) の応答の型と、画面が
 * `NET780_ARCHIVE_BATCH_SIZE` 件ずつ直列に呼ぶための分割・残りの計算・結果の集計を持つ。
 *
 * body の検証 (運行NO → `ope_no` / `start_ope`) は `server/utils/net780-archive.ts`
 * (server 側だけが使う。`server/utils/operation-zip.ts` に依存するので app に置かない)。
 * app → server の import は無い流儀なので、画面が使う側をこちらに置き、server が
 * `~/utils/net780-archive` を import する (`server/utils/profit-r2-io.ts` と同じ向き)。
 *
 * relay との契約 (front からは Nitro の `POST /api/net780/archive` 越しに叩く):
 *
 * ```
 * POST /kintai-relay/net780-archive   X-Alc-Proxy-Secret
 *   { items: { ope_no (22桁), start_ope ("YYYY/MM/DD H:mm:ss") }[] }   ← 上限 20、超過は 400
 *   200 { ok: true, comp_id, results: { ope_no, status, bytes?, message? }[],
 *         success_count, failure_count, truncated, remaining,
 *         theearth_logins, theearth_kicked }
 * ```
 *
 * 1 件ごとに theearth を検索してダウンロードするので **1 件 数秒〜十数秒**。
 * relay が時間切れで途中までしか処理しなかったときは `truncated: true` と
 * `results` に載らない運行が残る (`results.length + remaining === items.length` が
 * relay 側の不変条件) — 画面は `results` に載った運行だけを「済み」と見て、残りを
 * 続けて呼ぶ (`remainingNet780ArchiveTargets`)。
 *
 * **「未取得」の数え方は relay の `already` 判定と同じ条件**にしてある —
 * D1 `dtako_uploads` に `operation_count === 1` の行があるか (= `/api/net780/by-operation`
 * が 200 を返す条件、relay の `isNet780CatalogRowUsable`)。画面は同じ endpoint を
 * `useNet780OperationData` 越しに引いていて、404 = `not-found` を「未取得」に数える。
 */

/** relay が 1 回の呼び出しで受ける `items` の上限 (超過は relay が 400)。 */
export const NET780_ARCHIVE_MAX_ITEMS = 20

/**
 * 画面が 1 回の呼び出しに載せる件数 (Refs #760 の 29)。relay は 1 運行ずつ theearth を
 * 検索→ダウンロード→R2 保存 (1 運行 約 5 秒、同時 1) なので、上限の 20 件をまとめて
 * 投げると 1 分以上「0/N」のまま動かず、進んでいるのか分からない (オーナー 2026-08-23)。
 * 4 件なら 20 秒前後ごとに `k/N` が進む。`NET780_ARCHIVE_MAX_ITEMS` 以下であること。
 */
export const NET780_ARCHIVE_BATCH_SIZE = 4

/** relay が返す運行 1 本ぶんの結果。 */
export type Net780ArchiveStatus = 'archived' | 'already' | 'not_found' | 'error'

export interface Net780ArchiveResultItem {
  /** 22 桁 */
  ope_no: string
  /** `already` = D1 カタログに単一運行の行が既にある (theearth へ行かない)。 */
  status: Net780ArchiveStatus
  /** `archived` のとき、R2 に保存した zip のサイズ。 */
  bytes?: number
  /** `not_found` / `error` の理由。 */
  message?: string
}

/** `POST /kintai-relay/net780-archive` の 200 応答 (front の server route は素通しで返す)。 */
export interface Net780ArchiveResult {
  ok: true
  comp_id: string
  results: Net780ArchiveResultItem[]
  /** `archived` + `already`。 */
  success_count: number
  /** `not_found` + `error`。 */
  failure_count: number
  /** 時間切れ (theearth の session 切れ) などで `items` を全部処理しきれなかった。 */
  truncated: boolean
  /** `truncated` のとき、処理されなかった件数 (`results.length + remaining === items.length`)。 */
  remaining: number
  /** その呼び出しで theearth にログインした回数 (DO がセッションを使い回すと 0)。 */
  theearth_logins: number
  /** 誰かの theearth セッションを蹴ったか (同一アカウントの同時ログインを許さないため)。 */
  theearth_kicked: boolean
}

/** `archived / already / not_found / error` の件数。 */
export interface Net780ArchiveSummary {
  archived: number
  already: number
  not_found: number
  error: number
}

/** `items` を `size` 件ずつに割る (最後は端数)。空なら `[]`。 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * 結果の集計。relay が知らない status を返したら `error` に数える
 * (黙って落とさない — 合計が `results.length` と必ず一致する)。
 */
export function summarizeNet780ArchiveResults(results: readonly Pick<Net780ArchiveResultItem, 'status'>[]): Net780ArchiveSummary {
  const s: Net780ArchiveSummary = { archived: 0, already: 0, not_found: 0, error: 0 }
  for (const r of results) {
    if (r.status === 'archived') s.archived += 1
    else if (r.status === 'already') s.already += 1
    else if (r.status === 'not_found') s.not_found += 1
    else s.error += 1
  }
  return s
}

/** 見出し横に出す 1 行 (`archived 1 / already 0 / not_found 3 / error 0`)。4 つとも常に出す。 */
export function formatNet780ArchiveSummary(s: Net780ArchiveSummary): string {
  return `archived ${s.archived} / already ${s.already} / not_found ${s.not_found} / error ${s.error}`
}

/**
 * 1 回の応答を受けて、まだ処理されていない運行NO だけを残す。
 *
 * 画面が持つ運行NO は 22 桁 (GCP 由来) だが 23 桁 (オンプレ由来) が混ざっても
 * よいよう **先頭 22 桁**で relay の `ope_no` と突き合わせる。`results` に載った運行は
 * status に関わらず「処理済み」(`error` も再投入しない — 同じ theearth 検索を
 * 繰り返すだけなので、人が見て押し直す)。
 */
export function remainingNet780ArchiveTargets(
  queue: readonly string[],
  results: readonly Pick<Net780ArchiveResultItem, 'ope_no'>[],
): string[] {
  const done = new Set(results.map(r => r.ope_no))
  return queue.filter(no => !done.has(no.slice(0, 22)))
}
