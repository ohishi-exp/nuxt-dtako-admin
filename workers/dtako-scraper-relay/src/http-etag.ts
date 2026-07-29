/**
 * 弱い ETag と If-None-Match の条件付き応答 (Refs #543 PR-5)。
 *
 * kosoku-daily / wage-report の応答は 1.7MB 級で、Tunnel 越しの転送がそのまま
 * 応答時間になる。応答本文の sha256 を `W/"..."` 形式の ETag として付け、
 * ブラウザの再検証 (`cache-control: no-cache` + If-None-Match) に 304 で
 * 応えることで、**内容が変わっていない限り本文を送らない**。
 *
 * 弱い ETag にするのは「バイト同一」ではなく「意味的に同じ JSON」の保証だから
 * (gzip や再シリアライズで바이트は揺れうる)。比較は RFC 9110 §8.8.3.2 の
 * 弱い比較 — `W/` プレフィックスを外して不透明文字列を突き合わせる。
 */

/** sha256 hex から弱い ETag (`W/"<hex>"`) を組む。 */
export function weakEtag(sha256Hex: string): string {
  return `W/"${sha256Hex}"`;
}

/**
 * If-None-Match ヘッダが etag に一致するか (弱い比較)。
 * ヘッダはカンマ区切りの候補列または `*`。無し (null/空) は不一致。
 */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const strip = (v: string) => v.trim().replace(/^W\//, "");
  const target = strip(etag);
  return ifNoneMatch.split(",").some((candidate) => strip(candidate) === target);
}
