/**
 * 給与大臣 (`/api/kyuyo/*` / `/api/kyuyo-master/*`) の上流 fetch (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * 上流を `NUXT_KYUYO_UPSTREAM` で切り替える: `onprem` (既定。未設定・空・不明値もここ) =
 * オンプレの rust (`fetchIchiban`) / `shadow` = 応答は onprem、GET の 4 口だけ Worker
 * `ichibanboshi-kyuyo` にも投げて結果を比較ログに出す / `worker` = Service Binding で Worker の `/kyuyo/*` だけ。
 *
 * ★ `fetchIchiban` は ichiban proxy と共有の部品なので変更せず、kyuyo 専用の入口をここに置く。
 * ★ **allowlist 照合は全モード共通で最初に行う。** worker モードは URL を `https://ichibanboshi-kyuyo/kyuyo/<path>`
 *   で組むため、`..` / `%2e%2e` が正規化されると同じ Worker の認可なし `POST /probe` に届き得る。完全一致で塞ぐ。
 * ★ worker モードは CF Access のヘッダ・secret を付けない。認可は Worker 側 (JWT + allowlist) が
 *   `Authorization` で行うので、**Bearer 接頭辞付きのまま落とさず渡す**。
 */
import { cfEnv, fetchIchiban, IchibanUpstreamError } from './ichiban-upstream'
import { sha256Hex } from './profit-r2-io'

interface FetcherLike {
  fetch(input: Request): Promise<Response>
}
interface KyuyoUpstreamEnv {
  NUXT_KYUYO_UPSTREAM?: unknown
  ICHIBAN_KYUYO?: FetcherLike
}
interface WaitUntilContext {
  waitUntil?: (p: Promise<unknown>) => void
}

const GET_PATHS: readonly string[] = ['access', 'synced-months', 'databases', 'companies', 'employees', 'payroll']
const POST_PATHS: readonly string[] = ['sync']
/** shadow で Worker にも投げる GET。synced-months は状態の出所が違い常に不一致、companies は全 DB を開くので 2 本同時に投げない。 */
const SHADOW_PATHS: readonly string[] = ['access', 'databases', 'employees', 'payroll']

function fetchWorker(env: KyuyoUpstreamEnv, method: 'GET' | 'POST', path: string, search: string, authorization: string, body?: string): Promise<Response> {
  const binding = env.ICHIBAN_KYUYO
  if (!binding) return Promise.reject(new IchibanUpstreamError(503, 'ICHIBAN_KYUYO binding が未設定です'))
  const headers: Record<string, string> = { Authorization: authorization, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }
  return binding.fetch(new Request(`https://ichibanboshi-kyuyo/kyuyo/${path}${search}`, { method, headers, body }))
    .catch((e: unknown) => { throw new IchibanUpstreamError(502, `ichibanboshi-kyuyo への接続に失敗しました: ${String(e)}`) })
}

async function digest(res: Response): Promise<{ len: number, hash: string }> {
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { len: bytes.length, hash: (await sha256Hex(bytes)).slice(0, 12) }
}

/** body・JWT・金額は出さない。status・長さ・SHA-256 先頭 12 桁・一致だけ 1 行で残す。 */
async function compareShadow(path: string, onprem: Response, worker: Promise<Response | null>): Promise<void> {
  const w = await worker
  if (!w) return
  const [a, b] = await Promise.all([digest(onprem), digest(w)])
  console.info(`[kyuyo-shadow] ${path} onprem=${onprem.status}/${a.len}/${a.hash} worker=${w.status}/${b.len}/${b.hash} match=${onprem.status === w.status && a.hash === b.hash}`)
}

export async function fetchKyuyo(event: { context: unknown }, method: 'GET' | 'POST', path: string, search: string, authorization: string, body?: string): Promise<Response> {
  if (!(method === 'GET' ? GET_PATHS : POST_PATHS).includes(path)) {
    throw new IchibanUpstreamError(404, '許可されていない給与大臣の path です')
  }
  const env = cfEnv(event) as KyuyoUpstreamEnv
  const mode = env.NUXT_KYUYO_UPSTREAM
  if (mode === 'worker') return fetchWorker(env, method, path, search, authorization, body)

  const shadowed = mode === 'shadow' && method === 'GET' && SHADOW_PATHS.includes(path)
  // 失敗しても本番の応答に影響させない (reject を握って null にし、ログ 1 行で旧の応答を返す)。
  const worker = shadowed ? fetchWorker(env, method, path, search, authorization).catch((e: unknown) => { console.warn(`[kyuyo-shadow] ${path} skip: ${(e as IchibanUpstreamError).statusCode}`); return null }) : null
  const res = await fetchIchiban(env, `api/kyuyo/${path}`, search, { Authorization: authorization }, method === 'POST' ? { method, body } : {})
  if (worker) {
    const ctx = (event.context as { cloudflare?: { context?: WaitUntilContext } }).cloudflare?.context
    const p = compareShadow(path, res.clone(), worker).catch(() => console.warn(`[kyuyo-shadow] ${path} skip: 比較失敗`))
    ctx?.waitUntil?.(p)
  }
  return res
}
