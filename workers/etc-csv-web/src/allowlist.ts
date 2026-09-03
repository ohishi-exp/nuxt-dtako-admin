/**
 * `user_id` の allowlist (pure ロジック)。
 *
 * 値は **dashboard の plain Environment Variable `ETC_CSV_ALLOWED_USER_IDS`**
 * (カンマ区切り) から来る — `ETC_ACCOUNTS` と同じ流儀で、リポジトリにも
 * wrangler.toml にも値は書かない (この repo は public)。
 * wrangler.toml の `keep_vars = true` が deploy での消滅を防いでいる。
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
