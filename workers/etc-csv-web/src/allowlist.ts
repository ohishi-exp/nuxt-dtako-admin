/**
 * `user_id` の allowlist (pure ロジック)。
 *
 * 値 (カンマ区切り) の出どころは **KV `AUTH_CONFIG` の
 * `etc-csv:allowed-user-ids` が正**で、無ければ dashboard の plain 変数
 * `ETC_CSV_ALLOWED_USER_IDS` にフォールバックする (解決は `config.ts`)。
 * リポジトリにも wrangler.toml にも値は書かない (この repo は public)。
 *
 * ★ `user_id` を自由入力にしないための仕掛け。自由入力だと総当たりで他アカウントの
 * 明細の存在と鍵が引け、`/download` で本文まで取れてしまう。
 * 判定は **完全一致のみ** — 前方一致・後方一致・正規表現は使わない。
 * **未設定なら誰も通さない (fail-closed)。**
 */

/** カンマ区切りを分解する。空要素は捨てる。未設定なら空配列 (= 誰も通らない)。 */
export function parseAllowedUserIds(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** allowlist に **完全一致**で含まれるか。 */
export function isAllowedUserId(raw: string | undefined, userId: string): boolean {
  return parseAllowedUserIds(raw).includes(userId)
}
