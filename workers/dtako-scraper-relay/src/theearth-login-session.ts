/**
 * theearth ログインセッションを DO インスタンス内 (メモリ上のみ) で使い回すための
 * 判断ロジック (pure、cloudflare 非依存)。実際のログイン実行・cookie jar の生成・
 * 保持は `dtako-scraper-relay-do.ts` 側 (配線) が持つ — このモジュールは
 * 「今のキャッシュをそのまま使ってよいか」「セッション切れを検知した後に
 * 再ログインしてよいか」を判定するだけ (Refs #633-20)。
 *
 * theearth-venus skill の「罠2: セッション重複 = 強制ログイン」「罠2b: ライセンス数
 * 超過」参照: theearth は同一アカウントの同時ログインを許さず、ログインのたびに
 * 生きている自分の前セッションか他の利用者のセッションを蹴る。ログイン回数
 * そのものを減らすのが目的 — DO storage には保存しない (evict されたら
 * ログインし直すだけで十分、これは最適化であって契約ではない)。
 *
 * ## TTL は未確認の保守的な既定 (★重要、書き換える前に必ず読むこと)
 *
 * `IDLE_TTL_MS` (15分) / `ABSOLUTE_TTL_MS` (2時間) はどちらも「1回のログインが
 * 実際に何分 / 何件のダウンロードで切れるか」を実測していない。ASP.NET の既定
 * セッションタイムアウトが20分であることから安全側に置いただけの値。実測で
 * 違うと分かっても、この定数を静かに書き換えるのではなく、まず事実を報告すること。
 *
 * ## 正しさを TTL に依存させない — 本体は検知 + 張り直し
 *
 * `isEntryReusable` は「どうせ死んでいる cookie で1往復無駄にしない」ための
 * best-effort な事前フィルタでしかない。TTL 内でも実際には切れていることが
 * あるし、TTL 超過後もまだ生きていることがありうる。正しさは呼び出し側が
 * 実際に theearth を叩いて `VenusSessionExpiredError` を受け取る (= 検知) →
 * `decideRelogin` で許可された時だけ張り直す、という実測ベースの経路が担保する。
 */

/** DO インスタンス内メモリだけに置くログインセッションのキャッシュ 1 件。
 * `TJar` は呼び出し側 (`theearth-client.ts` の `CookieJar`) の型をそのまま
 * 通す — このモジュールは jar の中身を見ない。 */
export interface LoginSessionEntry<TJar> {
  compId: string;
  jar: TJar;
  /** login() が成功した時刻 (ms epoch)。絶対上限 (`ABSOLUTE_TTL_MS`) の起点。 */
  loggedInAt: number;
  /** 直近に「成功した」利用の時刻 (ms epoch)。idle TTL (`IDLE_TTL_MS`) の起点。
   * 呼び出し側は利用が成功するたびにこの値を更新する (失敗時は更新しない)。 */
  lastUsedAt: number;
}

/** idle TTL (最後に成功した利用からの経過)。未確認の保守的な既定 — module doc 参照。 */
export const IDLE_TTL_MS = 15 * 60 * 1000;

/** 絶対上限 (ログインからの経過)。未確認の保守的な既定 — module doc 参照。 */
export const ABSOLUTE_TTL_MS = 2 * 60 * 60 * 1000;

/** 捨てるセッションのログインからの経過がこれ未満なら再ログインしない
 * (最短寿命ガード、★最重要)。theearth-venus skill「罠2」参照 — 60秒未満で
 * 死ぬのは同一アカウントに他の誰か (人) が並行してログインしているシグナルで、
 * ここで張り直すとその人を蹴り、蹴られた人が張り直してこちらを蹴り……と
 * 実在の利用者との蹴り合いになる。繰り返し蹴るより、止まって人に見えるように
 * する方が安い。 */
export const MIN_SESSION_LIFETIME_MS = 60 * 1000;

/** 1 job あたりの再ログイン予算。使い切ったら残りは打ち切る (呼び出し側が
 * 理由を応答に書く)。 */
export const MAX_RELOGIN_ATTEMPTS_PER_JOB = 2;

/**
 * 今のキャッシュ (`entry`) をそのまま使い回してよいか。
 * comp_id が一致し、かつ idle TTL / 絶対 TTL の両方に収まっている時だけ true。
 * `entry` が無い (null) 場合は当然 false — 呼び出し側は新規ログインへ回る。
 */
export function isEntryReusable<TJar>(
  entry: LoginSessionEntry<TJar> | null,
  compId: string,
  now: number,
): boolean {
  if (!entry) return false;
  if (entry.compId !== compId) return false;
  if (now - entry.lastUsedAt >= IDLE_TTL_MS) return false;
  if (now - entry.loggedInAt >= ABSOLUTE_TTL_MS) return false;
  return true;
}

export interface ReloginDecision {
  allow: boolean;
  /** allow=false の理由 (構造化ログ・応答用の説明文、credential 等の機微情報は
   * 含めない)。allow=true の時は undefined。 */
  reason?: string;
}

/**
 * `VenusSessionExpiredError` を受けてセッション (`discardedEntry`) を捨てた
 * 直後に呼ぶ。予算超過・最短寿命未満のどちらかに触れたら再ログインを許可しない
 * (allow: false)。両方クリアした時だけ allow: true を返す。
 *
 * `discardedEntry` が null (= このセッションで初回ログイン自体が
 * `VenusSessionExpiredError` を投げた、極端に早い kick) の場合は最短寿命ガードを
 * 適用しようがないため予算だけで判定する — この場合も呼び出し側は
 * `loggedInAt` を渡せる限り null にしないことが望ましいが、安全側 (判定不能で
 * ブロックしない) に倒す。
 */
export function decideRelogin<TJar>(
  discardedEntry: LoginSessionEntry<TJar> | null,
  now: number,
  reloginAttemptsUsed: number,
): ReloginDecision {
  if (reloginAttemptsUsed >= MAX_RELOGIN_ATTEMPTS_PER_JOB) {
    return {
      allow: false,
      reason: `再ログイン予算 (${MAX_RELOGIN_ATTEMPTS_PER_JOB} 回/job) を使い切りました`,
    };
  }
  if (discardedEntry) {
    const lifetimeMs = now - discardedEntry.loggedInAt;
    if (lifetimeMs < MIN_SESSION_LIFETIME_MS) {
      return {
        allow: false,
        reason:
          `セッションがログインから ${lifetimeMs}ms (最短寿命 ${MIN_SESSION_LIFETIME_MS}ms 未満) で切れました — ` +
          "同一アカウントへの並行ログインの可能性があるため再ログインしません",
      };
    }
  }
  return { allow: true };
}
