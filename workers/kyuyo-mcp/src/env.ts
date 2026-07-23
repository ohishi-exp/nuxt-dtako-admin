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
  /** deploy 元の commit SHA (`kyuyo-mcp-deploy.yml` が `wrangler deploy --var
   *  GIT_SHA:${{ github.sha }}` で注入、Refs #374)。/healthz で「今動いているのは
   *  どの commit か」を確認するため。wrangler.toml の既定値 "unknown" はローカル
   *  実行 (CI 外) 用のフォールバック。 */
  GIT_SHA?: string;
  /** Cloudflare 側のデプロイバージョン (`[version_metadata]` binding、実行時に
   *  自動注入される。GIT_SHA と揃わない = deploy 反映漏れの検知に使える)。 */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}
