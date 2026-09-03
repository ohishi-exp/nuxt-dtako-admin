/**
 * etc-csv-web — R2 に溜まった ETC 明細 CSV を **読み取り専用**で配る worker。
 *
 * ★★ この worker は **無認証の公開 ETC 明細配信**である。**CORS は認可ではない** —
 * Origin ヘッダを送らない client (curl 等) は素通りで読める。守っているのは
 * 「どの画面が読めるか」であって「誰が読めるか」ではない。 ★★
 *
 * 受け側の認証を置かないのは計画上の明示的な決定 (オーナー判断 2026-09-03、Refs #1103)。
 * 置き換え対象だった旧サービス (停止済み VPS 上の gRPC) は
 * `CorsLayer::new().allow_origin(Any)` で、セッション一覧・ファイル一覧・download の
 * いずれにも受け側の認証が 0 件だった。つまり本番は「任意オリジン・認証なしの公開
 * ホスト」で同じ CSV を配っていた。オリジン 1 件限定 + `user_id` allowlist は
 * それより厳格である。
 *
 * ⚠ ただし「旧構成より厳格」は口ごとにしか言えない。この worker に**新しい口を
 * 足すとき**は、その口について改めて比較すること。
 *
 * 口は 3 つだけ、すべて GET (書き込みの口は無い):
 *   GET /list?user_id=<id>                  → 日付ディレクトリ一覧
 *   GET /list?user_id=<id>&date=YYYY-MM-DD  → その日のオブジェクト [{key,size,uploaded}]
 *   GET /download?key=<r2 key>              → R2 の本体 (Shift_JIS のまま)
 *   OPTIONS                                 → preflight 応答
 * GET / OPTIONS 以外はすべて 405。
 *
 * 判断そのものは `handlers.ts` / `keys.ts` / `allowlist.ts` / `cors.ts` / `r2.ts` /
 * `config.ts` に
 * 分離してあり (100% gate 対象)、ここは HTTP との変換と、allowlist 2 つの解決
 * (`config.ts`、KV 正・plain 変数 fallback) の呼び出しだけを持つ。
 */

import { resolveAllowedOrigin, resolveAllowedUserIds, type EtcCsvConfigKvBinding } from './config'
import { corsHeaders } from './cors'
import { downloadResult, listResult, type EtcCsvConfig } from './handlers'
import type { R2BucketLite } from './r2'

export interface Env {
  DTAKO_R2?: R2BucketLite
  /** wrangler.toml `[vars]`。 */
  ETC_R2_PREFIX?: string
  /**
   * allowlist 2 つの**正** (KV 優先、無ければ下の plain 変数)。auth-worker と同じ
   * namespace を read-only で借りている。**読むキーは `config.ts` の定数 2 つだけ** —
   * 同じ namespace に OAuth の refresh token / DCR / device 系が同居しているため、
   * リクエスト由来の文字列が `.get()` に到達する経路を作らないこと。
   */
  AUTH_CONFIG?: EtcCsvConfigKvBinding
  /** dashboard の plain 変数 (KV 未投入のあいだの fallback。値は repo に書かない)。 */
  ETC_CSV_ALLOWED_ORIGIN?: string
  ETC_CSV_ALLOWED_USER_IDS?: string
}

function json(result: { status: number; body: unknown }, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // allowlist 2 つは KV が正、無ければ plain 変数 (`config.ts`)。CORS ヘッダは
    // どの応答にも載るので、method 分岐より前に解決する。
    const allowedOrigin = await resolveAllowedOrigin(env.AUTH_CONFIG, env.ETC_CSV_ALLOWED_ORIGIN)
    const cors = corsHeaders(request.headers.get('Origin'), allowedOrigin)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'GET') {
      return json({ status: 405, body: { error: 'method not allowed' } }, cors)
    }

    const url = new URL(request.url)
    const config: EtcCsvConfig = {
      r2Prefix: env.ETC_R2_PREFIX,
      allowedUserIds: await resolveAllowedUserIds(env.AUTH_CONFIG, env.ETC_CSV_ALLOWED_USER_IDS),
    }

    if (url.pathname === '/list') {
      const result = await listResult(
        env.DTAKO_R2,
        config,
        url.searchParams.get('user_id'),
        url.searchParams.get('date'),
      )
      return json(result, cors)
    }

    if (url.pathname === '/download') {
      const result = await downloadResult(env.DTAKO_R2, config, url.searchParams.get('key'))
      if (result.kind === 'json') return json(result, cors)
      // etc-meisai の CSV は Shift_JIS。UTF-8 に変換せずそのまま返す。
      return new Response(result.bytes, {
        status: 200,
        headers: {
          ...cors,
          'content-type': 'text/csv; charset=shift_jis',
          'content-disposition': `attachment; filename="${result.filename}"`,
        },
      })
    }

    return json({ status: 404, body: { error: 'not found' } }, cors)
  },
}
