/**
 * `POST /run` の判断そのもの — ETC 明細の取得を **今すぐ 1 回起こす** (Refs #1111)。
 *
 * ★★ **この worker で唯一「読む」以外のことをする口である。**
 * ここが R2 に書くわけではないが、**押すと外 (etc-meisai.jp) へのログインとスクレイプが
 * 起きる**ので、既存 3 口 (`/list` / `/list?date=` / `/download`) の「読むだけ」とは
 * 性質が違う。README / `src/index.ts` / map skill の「書き込みの口は無い」という記述は
 * この口の追加に合わせて**同じ PR で書き換えてある**。
 *
 * ## 到達性は既存の GET 3 口と**同じ** (オーナー判断 Refs #1111)
 *
 * **追加の認証・IP 制限・レート制限・クールダウンを置かない。** 無認証公開で、
 * CORS はオリジン完全一致 — 既存の口と揃える。歯止めを置いていないのは、置く理由が
 * 実測されていないため:
 *   - **etc-meisai.jp にアカウントロックは無い** (オーナー確認済み)。「連打でロック
 *     される」を理由に歯止めを足さないこと
 *   - relay の DO は**アカウント単位で直列化する** (`etc-{user_id}` DO の `scrapeQueue`)
 *     ので、連打しても並列ログインにはならず順番に流れる。**これは既存の性質**であって
 *     この口のために足したものではない
 *
 * ⚠ ただし `src/index.ts` の doc にあるとおり「旧構成より厳格」は**口ごとにしか
 * 言えない**。旧サービス (停止済みの外部 VPS 上の gRPC) には**そもそも実行の口が無かった**
 * ので、この口については「旧より厳格」とは言えない — **新設された実行口**である。
 *
 * ## 経路
 *
 * ```
 * POST /run → service binding (SCRAPER_RELAY)
 *           → relay の POST /kintai-relay/etc-run
 *           → cron と同じ関数 (dispatchEtcAccounts) → 各 etc-{user_id} DO の /cron/etc
 * ```
 *
 * relay は `workers_dev = false` で公開ルートを持たないので、**service binding が
 * 唯一の経路**である。relay 側の関門は `X-Alc-Proxy-Secret` (Secrets Store の
 * `INTERNAL_SHARED_SECRET`) の constant-time 検証。
 */

// `INTERNAL_SHARED_SECRET` は Secrets Store binding (`.get()`) にも dashboard の
// plain 変数 (文字列) にもなりうる。**同じ relay を同じ secret で叩く先行例**として
// `workers/kyuyo-mcp/src/mcp/tools.ts` が relay の実装をそのまま import しているので、
// 3 つ目の写しを作らずそれに倣う (worker 間 import の前例はこの 1 件)。
import { resolveSecretBinding } from '../../dtako-scraper-relay/src/cron'
import type { JsonResult } from './handlers'

/** service binding の最小形 (cloudflare:workers の型に依存しないための構造的型)。 */
export interface RelayServiceBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>
}

/**
 * relay の口。**service binding 越しなので host は何でもよい**が、relay 側のログと
 * 突き合わせやすいよう他の consumer (`kyuyo-mcp`) と同じ `relay.internal` を使う。
 */
export const RELAY_ETC_RUN_URL = 'https://relay.internal/kintai-relay/etc-run'

/** 応答本文をエラーに載せるときの上限 (`kyuyo-mcp` の `callRelay` と同じ既定)。 */
const MAX_ERROR_CHARS = 200

/**
 * relay の `POST /kintai-relay/etc-run` を service binding で叩く。
 *
 * **body を送らない** — relay 側の口はパラメータを取らない (ETC cron が取らないため)。
 * 1 アカウントに絞る経路をここに生やすと、cron に無い道ができる。
 *
 * relay の応答 (`{results: CronRunResult[]}`) は**そのまま透過**する。ここで畳むと
 * 「どのアカウントが失敗したか」が画面から見えなくなる。status も relay のものを
 * そのまま返す — 1 件でも通れば 200 / 全滅で 502 / **`ETC_ACCOUNTS` が 0 件なら 404**
 * (relay 側の手動口は cron と違って 0 件を skip にしない。押した人に「200 だが何も
 * 起きていない」を返さないため。理由は relay の `handleEtcRun` の doc)。
 */
export async function runResult(
  relay: RelayServiceBinding | undefined,
  secretBinding: unknown,
): Promise<JsonResult> {
  if (!relay) {
    return { status: 503, body: { error: 'service binding (SCRAPER_RELAY) not available' } }
  }
  const secret = await resolveSecretBinding(secretBinding)
  if (!secret) return { status: 503, body: { error: 'INTERNAL_SHARED_SECRET not available' } }

  const res = await relay.fetch(RELAY_ETC_RUN_URL, {
    method: 'POST',
    headers: { 'X-Alc-Proxy-Secret': secret },
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // relay が JSON を返さないのは想定外 (500 の素の本文等)。**握って 200 にしない** —
    // 「押したのに何も起きない」を成功として返さないため。
    return {
      status: 502,
      body: { error: `relay: parse failed: ${text.slice(0, MAX_ERROR_CHARS)}` },
    }
  }
  return { status: res.status, body: parsed }
}
