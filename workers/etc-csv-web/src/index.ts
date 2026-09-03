/**
 * etc-csv-web — R2 に溜まった ETC 明細 CSV を配り、**その取得を今すぐ 1 回起こす**
 * worker (`POST /run`、Refs #1111)。
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
 * 口は 4 つ。**読むのが 3 つ、起こすのが 1 つ**:
 *   GET  /list?user_id=<id>                  → 日付ディレクトリ一覧
 *   GET  /list?user_id=<id>&date=YYYY-MM-DD  → その日のオブジェクト [{key,size,uploaded}]
 *   GET  /download?key=<r2 key>              → R2 の本体 (Shift_JIS のまま)
 *   POST /run                                → ETC 取得を今すぐ 1 回起こす (Refs #1111)
 *   OPTIONS                                  → preflight 応答
 * それ以外 (GET 以外の 3 口 / POST 以外の `/run`) はすべて 405。
 *
 * ★ **`/run` を足すまで、この worker には「書き込み/実行の口」が 1 つも無かった。**
 * R2 へ書くわけではないが、押すと relay 経由で etc-meisai.jp へのログインと
 * スクレイプが起きる。**「読み取り専用」という説明はもう当たらない** ので、
 * README / map skill の記述も #1111 で同時に書き換えてある。到達性を既存 3 口と
 * 同じ (無認証公開・CORS はオリジン完全一致) にしたのはオーナー判断で、その理由と
 * 「旧構成との比較がこの口には効かないこと」は `run.ts` の doc にある。
 *
 * 判断そのものは `handlers.ts` / `keys.ts` / `allowlist.ts` / `cors.ts` / `r2.ts` /
 * `config.ts` / `run.ts` に
 * 分離してあり (100% gate 対象)、ここは HTTP との変換と、allowlist 2 つの解決
 * (`config.ts`、KV 正・plain 変数 fallback) の呼び出しだけを持つ。
 */

import { resolveAllowedOrigin, resolveAllowedUserIds, type EtcCsvConfigKvBinding } from './config'
import { corsHeaders } from './cors'
import { downloadResult, listResult, type EtcCsvConfig } from './handlers'
import type { R2BucketLite } from './r2'
import { runResult, type RelayServiceBinding } from './run'

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
  /**
   * `workers/dtako-scraper-relay` への service binding (Refs #1111)。`POST /run` が
   * relay の `POST /kintai-relay/etc-run` を叩くのに使う。relay は
   * `workers_dev = false` で公開ルートを持たないので、**これが唯一の経路**。
   */
  SCRAPER_RELAY?: RelayServiceBinding
  /** relay が要求する consumer proof (`X-Alc-Proxy-Secret`)。既存 Secrets Store entry。 */
  INTERNAL_SHARED_SECRET?: unknown
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

    const url = new URL(request.url)

    // ★ この worker で唯一 GET でない口 (Refs #1111)。**method 判定より先に置く** —
    // 後ろに置くと下の `method !== 'GET'` が先に 405 を返してしまう。POST 以外の
    // `/run` は既存 3 口と同じく 405。
    if (url.pathname === '/run') {
      if (request.method !== 'POST') {
        return json({ status: 405, body: { error: 'method not allowed' } }, cors)
      }
      return json(await runResult(env.SCRAPER_RELAY, env.INTERNAL_SHARED_SECRET), cors)
    }

    if (request.method !== 'GET') {
      return json({ status: 405, body: { error: 'method not allowed' } }, cors)
    }

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
