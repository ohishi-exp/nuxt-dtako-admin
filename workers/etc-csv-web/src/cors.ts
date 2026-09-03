/**
 * CORS ヘッダの組み立て (pure ロジック)。
 *
 * ★★ **CORS は認可ではない。** ここで決めているのは「どの画面 (オリジン) が
 * ブラウザから読めるか」であって「誰が読めるか」ではない。`Origin` ヘッダを
 * 送らない client (curl 等) はそもそもこの判定を通らず素通りで読める。
 * この worker の唯一の実効的な絞りは `user_id` の allowlist (`allowlist.ts`) である。
 *
 * 許可オリジンは **KV `AUTH_CONFIG` の `etc-csv:allowed-origin` が正**で、
 * 無ければ dashboard の plain 変数 `ETC_CSV_ALLOWED_ORIGIN` にフォールバックする
 * (解決は `config.ts`)。この repo は public なので、ホスト名を wrangler.toml にも
 * コードにも書かない。**どちらにも無ければ CORS ヘッダを一切付けない (fail-closed)。**
 */

/**
 * 許可オリジンと **完全一致**したときだけ `Access-Control-Allow-Origin` を返す。
 * ワイルドカードも後方一致も使わない (`endsWith('.example.org')` 型は
 * `evil-example.org` を通してしまう)。
 *
 * `Vary: Origin` は常に付ける — オリジンごとに応答ヘッダが変わるので、
 * CDN / ブラウザキャッシュに混ぜさせない。
 */
export function corsHeaders(
  requestOrigin: string | null,
  allowedOrigin: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' }
  const allowed = (allowedOrigin ?? '').trim()
  if (allowed !== '' && requestOrigin === allowed) {
    headers['Access-Control-Allow-Origin'] = allowed
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
    headers['Access-Control-Max-Age'] = '600'
  }
  return headers
}
