/**
 * dtako-scraper-relay WebSocket ハンドシェイクの認可判定 (純粋関数 / cloudflare 非依存)。
 *
 * nuxt-items の ItemsSyncDO (`workers/items-sync/src/auth-decision.ts`) と同じ形。
 * この relay は org 単位の broadcast ではなく 1 セッション = 1 DO の中継用途なので
 * tenant 突き合わせは不要 — auth-worker `/auth/introspect` が `active: true` を
 * 返す (= browser JWT が有効) ことだけを確認する。
 */

/** auth-worker `/auth/introspect` 応答の必要 field。 */
export interface IntrospectResult {
  active: boolean
  /** active:true の時に introspect が返す tenant。restraint viewer 経路 (Refs #272)
   * の comp スコープ判定 (DTAKO_ACCOUNTS 逆引き) に使う。WS ハンドシェイク判定
   * (decideRelayAuth) は従来どおり active しか見ない。 */
  tenant_id?: string
  /** active:true の時に introspect が返す JWT の role claim。
   * **★ 認可には使わない (Refs #1049)** — 以前は restraint viewer 経路で
   * 「admin は全会社」を判定していたが、全社許可は下の `org_wide`
   * (= auth-worker の `USER_ACL`) だけで決めるようになった。WS ハンドシェイク判定
   * (decideRelayAuth) は従来どおり active しか見ない。 */
  role?: string
  /** active:true の時に introspect が返す JWT の email claim (Refs #554)。
   * kintai 上流キャッシュを**人単位の DO** に分けるための鍵に使う。
   * theearth のユーザー名は共有アカウントになりうるので鍵にしない。
   * **認可には使わない** — テナントを越えてよいかは `org_wide` が答える。
   * WS ハンドシェイク判定 (decideRelayAuth) は従来どおり active しか見ない。 */
  email?: string
  /** active:true の時だけ返る「**テナント境界を越えて org 全体を見てよい人か**」
   * (Refs #1049 / ippoan/auth-worker#497)。正本は auth-worker の `USER_ACL`
   * (`checkOrgAccess` が `TENANT_ACL` と OR 合成する側) で、**この repo は写しを
   * 持たない**。restraint viewer 経路の全社許可はこれだけで決まる。
   *
   * - **`true` は「管理者」でも「開発者」でもない。role とは無関係**
   * - **`DEVELOPER_EMAILS` とは別物** (あちらは UI の出し分け専用で認可ではない)
   * - **`active: false` の応答には含まれない** (情報リーク回避の既存方針)
   * - **★ `undefined` は `false` として扱うこと** — 古い auth-worker はこのキーを
   *   返さない (additive な変更)。倒し方は `restraint-viewer-auth.ts` の
   *   `isAllCompsViewer` (真の boolean の `true` だけを通す)
   *
   * WS ハンドシェイク判定 (decideRelayAuth) は従来どおり active しか見ない。 */
  org_wide?: boolean
}

/** ハンドシェイク判定結果。`status === 101` の時だけ accept する。 */
export interface RelayAuthDecision {
  /** 101 = accept / 401 = token invalid */
  status: 101 | 401
}

/** introspect 結果から WS ハンドシェイクの可否を決める。 */
export function decideRelayAuth(
  result: IntrospectResult | null | undefined,
): RelayAuthDecision {
  if (!result || result.active !== true) {
    return { status: 401 }
  }
  return { status: 101 }
}
