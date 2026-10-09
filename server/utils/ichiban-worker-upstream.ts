/**
 * 一番星 (`/api/ichiban/**`) の上流切替 (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * 上流を `NUXT_ICHIBAN_UPSTREAM` で切り替える: `onprem` (既定。未設定・空・不明値もここ) =
 * オンプレの rust (`fetchIchiban`) / `shadow` = 応答は onprem、`/health` を除く GET 5 本だけ Worker
 * `ichibanboshi-ichiban` にも投げて結果を比較ログに出す / `worker` = Service Binding で Worker だけ。
 *
 * ★ `fetchIchiban` は変更せず、切替の入口をここに置く (給与大臣の撤去前の `kyuyo-upstream.ts` と同じ形)。
 * ★ **allowlist 照合は全モード共通で最初に行う。** route でも照合しているが、Worker の URL を
 *   path から組むので、ここでも完全一致で塞ぐ (`..` 等が正規化されて Worker の `/probe` に届かないように)。
 * ★ Worker は認可なし (Service Binding 専用。関門は route の requireAuth と allowlist)。
 *   **Authorization も CF Access のヘッダも付けない。**
 */
// cfEnv は ichiban-upstream.ts 版と cf-env.ts 版があり auto-import は前者を採る。取り違えないよう明示する。
import { cfEnv, fetchIchiban, IchibanUpstreamError, isAllowedIchibanProxyPath } from './ichiban-upstream'
import { sha256Hex } from './profit-r2-io'

interface FetcherLike {
  fetch(input: Request): Promise<Response>
}
interface WaitUntilContext {
  waitUntil?: (p: Promise<unknown>) => void
}

/** shadow で Worker にも投げる path。`health` は Worker が `{"status":"ok"}`、オンプレが commit を含み常に不一致になるので外す。 */
const SHADOW_PATHS: readonly string[] = ['api/employees', 'api/vehicles', 'api/sales/departments', 'api/sales/vehicle-daily', 'api/costs/vehicle-daily']

function fetchWorker(env: Record<string, unknown>, path: string, search: string): Promise<Response> {
  const binding = env.ICHIBAN_DB as FetcherLike | undefined
  if (!binding) return Promise.reject(new IchibanUpstreamError(503, 'ICHIBAN_DB binding が未設定です'))
  return binding.fetch(new Request(`https://ichibanboshi-ichiban/${path}${search}`, { method: 'GET', headers: { Accept: 'application/json' } }))
    .catch((e: unknown) => { throw new IchibanUpstreamError(502, `ichibanboshi-ichiban への接続に失敗しました: ${String(e)}`) })
}

async function readBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer())
}

async function digest(bytes: Uint8Array): Promise<{ len: number, hash: string }> {
  return { len: bytes.length, hash: (await sha256Hex(bytes)).slice(0, 12) }
}

type Obj = Record<string, unknown>
const MAX_FIELDS = 20
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isRows = (v: unknown): v is Obj[] => Array.isArray(v) && v.every(isObj)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const keysOf = (a: Obj, b: Obj) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
const len = (v: unknown) => Array.isArray(v) ? String(v.length) : '-'

/** 違うフィールドの「名前」だけを 1 行にする (値は出さない)。fields は行の直下のキー 1 段だけ (入れ子へは潜らない)。 */
function diffLine(onprem: string, worker: string): string {
  let a: unknown, b: unknown
  try {
    a = JSON.parse(onprem)
    b = JSON.parse(worker)
  }
  catch { return 'diff: parse 失敗' }
  if (!isObj(a) || !isObj(b)) return 'diff: parse 失敗'
  const keys = keysOf(a, b)
  const parts = [`top=${keys.filter(k => !same(a[k], b[k])).join(',')}`]
  for (const k of keys.filter(k => Array.isArray(a[k]) || Array.isArray(b[k]))) {
    const x = a[k], y = b[k]
    let part = `${k}=${len(x)}/${len(y)}`
    if (isRows(x) && isRows(y)) {
      const fields = new Set<string>()
      let rows = 0
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const diff = keysOf(x[i]!, y[i]!).filter(f => !same(x[i]![f], y[i]![f]))
        if (diff.length) rows++
        diff.forEach(f => fields.add(f))
      }
      const names = [...fields]
      part += ` rows_diff=${rows} fields=${names.slice(0, MAX_FIELDS).join(',')}${names.length > MAX_FIELDS ? ',…' : ''}`
    }
    parts.push(part)
  }
  return `diff: ${parts.join(' ')}`
}

// 一時的な診断。shadow モードを撤去する (worker へ切り替えた後) ときに compareShadow ごと消す。
/** body (社員名・金額) は出さない。status・長さ・SHA-256 先頭 12 桁・一致だけ 1 行で残す。不一致 (両 200) のときだけ違うフィールド名の 2 行目。 */
async function compareShadow(path: string, onprem: Response, worker: Promise<Response | null>): Promise<void> {
  const w = await worker
  if (!w) return
  const [x, y] = await Promise.all([readBytes(onprem), readBytes(w)])
  const [a, b] = await Promise.all([digest(x), digest(y)])
  const match = onprem.status === w.status && a.hash === b.hash
  console.info(`[ichiban-shadow] ${path} onprem=${onprem.status}/${a.len}/${a.hash} worker=${w.status}/${b.len}/${b.hash} match=${match}`)
  if (!match && onprem.status === 200 && w.status === 200) {
    const td = new TextDecoder()
    console.info(`[ichiban-shadow] ${path} ${diffLine(td.decode(x), td.decode(y))}`)
  }
}

/**
 * `/api/ichiban/{path}{search}` の上流を呼ぶ。失敗は `IchibanUpstreamError` (403 allowlist 外 /
 * 503 binding 未設定 / 502 接続失敗) で投げる — route の catch がそのまま `createError` に変換する。
 */
export async function fetchIchibanUpstream(event: { context: unknown }, env: Record<string, unknown>, path: string, search: string): Promise<Response> {
  if (!isAllowedIchibanProxyPath(path)) {
    throw new IchibanUpstreamError(403, 'この proxy が中継するパスではありません')
  }
  const mode = env.NUXT_ICHIBAN_UPSTREAM
  if (mode === 'worker') return fetchWorker(env, path, search)

  const shadowed = mode === 'shadow' && SHADOW_PATHS.includes(path)
  // 失敗しても本番の応答に影響させない (reject を握って null にし、ログ 1 行で旧の応答を返す)。
  const worker = shadowed ? fetchWorker(env, path, search).catch((e: unknown) => { console.warn(`[ichiban-shadow] ${path} skip: ${(e as IchibanUpstreamError).statusCode}`); return null }) : null
  const res = await fetchIchiban(env, path, search)
  if (worker) {
    const ctx = (event.context as { cloudflare?: { context?: WaitUntilContext } }).cloudflare?.context
    const p = compareShadow(path, res.clone(), worker).catch(() => console.warn(`[ichiban-shadow] ${path} skip: 比較失敗`))
    ctx?.waitUntil?.(p)
  }
  return res
}
