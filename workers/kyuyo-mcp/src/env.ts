/**
 * Worker の binding 型。
 *
 * kyuyo-mcp は R2 read-only + auth-worker introspect のみで完結する薄い worker。
 * CF API token 等の secret は不要 (cf-access-mcp と異なり、外部 API を代理呼び出し
 * しないため)。
 */
export interface Env {
  /** 給与比較 R2 アーカイブ (dtako-uploads バケット、read-only 運用)。 */
  DTAKO_R2: R2Bucket;
  /** アーカイブ key の prefix。workers/dtako-scraper-relay と同じ規約 (既定 "restraint")。 */
  RESTRAINT_R2_PREFIX?: string;
  /** binding_jwt introspect / discovery proxy 先 (auth-worker)。例: https://auth-staging.ippoan.org */
  AUTH_WORKER_ORIGIN: string;
  /** auth-worker への Service Binding (`/mcp/introspect` 呼び出し用、Refs #387)。 */
  AUTH_WORKER: Fetcher;
  /** deploy 元の commit SHA (`kyuyo-mcp-deploy.yml` が `wrangler deploy --var
   *  GIT_SHA:${{ github.sha }}` で注入、Refs #374)。/healthz で「今動いているのは
   *  どの commit か」を確認するため。wrangler.toml の既定値 "unknown" はローカル
   *  実行 (CI 外) 用のフォールバック。 */
  GIT_SHA?: string;
  /** Cloudflare 側のデプロイバージョン (`[version_metadata]` binding、実行時に
   *  自動注入される。GIT_SHA と揃わない = deploy 反映漏れの検知に使える)。 */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** 勤怠の生イベント取得先 = rust-ichibanboshi の CF Tunnel origin
   *  (Refs #470、ohishi-exp/rust-ichibanboshi#116)。**この worker で唯一の
   *  上流 fetch** — 他の tool は R2 直読みで完結する。未設定なら
   *  `get_kosoku_events` だけが明示エラーになる (他 tool は無関係に動く)。 */
  NUXT_ICHIBAN_API_URL?: string;
  /** 一番星 CF Access Service Token の client_id (公開識別子)。 */
  NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID?: string;
  /** 同 client_secret。Secrets Store binding (`.get()`) だが、ローカルや
   *  dashboard の plain 変数では文字列で来るため `unknown` で受ける
   *  (relay の `ICHIBAN_CF_ACCESS_CLIENT_SECRET` と同じ扱い)。 */
  ICHIBAN_CF_ACCESS_CLIENT_SECRET?: unknown;
  /** dtako-scraper-relay への service binding。打刻を GCP へ運ぶ
   *  `POST /kintai-relay/run` (Refs ohishi-exp/rust-ichibanboshi#205 の 04b) と、
   *  全量再計算を進める `POST /kintai-relay/recalc` (同 #205 の 10) を叩く。
   *  **運ぶ/畳むロジックは relay 側の 1 実装のまま** — こちらは認証付きの入口を出すだけ。 */
  SCRAPER_RELAY?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  /** relay が要求する consumer proof (`X-Alc-Proxy-Secret`)。 */
  INTERNAL_SHARED_SECRET?: unknown;
}
