/**
 * 一番星 (`/api/ichiban/**`) の上流 fetch (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * 上流は Service Binding (`ICHIBAN_DB`) の Worker `ichibanboshi-ichiban` だけ。オンプレ経路と shadow 比較は撤去済み。
 *
 * ★ **allowlist 照合を最初に行う。** route でも照合しているが、Worker の URL を
 *   path から組むので、ここでも完全一致で塞ぐ (`..` 等が正規化されて Worker の `/probe` に届かないように)。
 * ★ Worker は認可なし (Service Binding 専用。関門は route の requireAuth と allowlist)。
 *   **Authorization も CF Access のヘッダも付けない。**
 */
import { IchibanUpstreamError, isAllowedIchibanProxyPath } from './ichiban-upstream'

interface FetcherLike {
  fetch(input: Request): Promise<Response>
}

/**
 * `/api/ichiban/{path}{search}` の上流を呼ぶ。失敗は `IchibanUpstreamError` (403 allowlist 外 /
 * 503 binding 未設定 / 502 接続失敗) で投げる — route の catch がそのまま `createError` に変換する。
 */
export async function fetchIchibanUpstream(env: Record<string, unknown>, path: string, search: string): Promise<Response> {
  if (!isAllowedIchibanProxyPath(path)) {
    throw new IchibanUpstreamError(403, 'この proxy が中継するパスではありません')
  }
  const binding = env.ICHIBAN_DB as FetcherLike | undefined
  if (!binding) throw new IchibanUpstreamError(503, 'ICHIBAN_DB binding が未設定です')
  return binding.fetch(new Request(`https://ichibanboshi-ichiban/${path}${search}`, { method: 'GET', headers: { Accept: 'application/json' } }))
    .catch((e: unknown) => { throw new IchibanUpstreamError(502, `ichibanboshi-ichiban への接続に失敗しました: ${String(e)}`) })
}
