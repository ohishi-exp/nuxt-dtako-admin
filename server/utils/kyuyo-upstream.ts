/**
 * 給与大臣 (`/api/kyuyo/*` / `/api/kyuyo-master/*`) の上流 fetch (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * 上流は Service Binding (`ICHIBAN_KYUYO`) の給与大臣 Worker `ichibanboshi-kyuyo` の `/kyuyo/*` だけ。オンプレ経路は撤去済み。
 *
 * ★ **allowlist 照合を最初に行う。** URL を `https://ichibanboshi-kyuyo/kyuyo/<path>` で組むため、
 *   `..` / `%2e%2e` が正規化されると同じ Worker の認可なし `POST /probe` に届き得る。完全一致で塞ぐ。
 * ★ CF Access のヘッダ・secret は付けない。認可は Worker 側 (JWT + allowlist) が
 *   `Authorization` で行うので、**Bearer 接頭辞付きのまま落とさず渡す**。
 */
import { cfEnv, IchibanUpstreamError } from './ichiban-upstream'

interface FetcherLike {
  fetch(input: Request): Promise<Response>
}
interface KyuyoUpstreamEnv {
  ICHIBAN_KYUYO?: FetcherLike
}

const GET_PATHS: readonly string[] = ['access', 'synced-months', 'databases', 'companies', 'employees', 'payroll']
const POST_PATHS: readonly string[] = ['sync']

function fetchWorker(env: KyuyoUpstreamEnv, method: 'GET' | 'POST', path: string, search: string, authorization: string, body?: string): Promise<Response> {
  const binding = env.ICHIBAN_KYUYO
  if (!binding) return Promise.reject(new IchibanUpstreamError(503, 'ICHIBAN_KYUYO binding が未設定です'))
  const headers: Record<string, string> = { Authorization: authorization, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }
  return binding.fetch(new Request(`https://ichibanboshi-kyuyo/kyuyo/${path}${search}`, { method, headers, body }))
    .catch((e: unknown) => { throw new IchibanUpstreamError(502, `ichibanboshi-kyuyo への接続に失敗しました: ${String(e)}`) })
}

export async function fetchKyuyo(event: { context: unknown }, method: 'GET' | 'POST', path: string, search: string, authorization: string, body?: string): Promise<Response> {
  if (!(method === 'GET' ? GET_PATHS : POST_PATHS).includes(path)) {
    throw new IchibanUpstreamError(404, '許可されていない給与大臣の path です')
  }
  return fetchWorker(cfEnv(event) as KyuyoUpstreamEnv, method, path, search, authorization, body)
}
