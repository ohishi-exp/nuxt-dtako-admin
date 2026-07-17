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
