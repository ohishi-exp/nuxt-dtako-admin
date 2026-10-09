/**
 * Cloudflare Workers の env binding / Secrets Store 値を取り出す共通ヘルパ。
 * server route ごとに同じ定義がコピーされていたのを 1 本に集約する
 * (Refs ohishi-exp/nuxt-dtako-admin#999)。
 *
 * server/utils/ichiban-upstream.ts にも同名の cfEnv があるが、意図的に統合していない:
 *   - あちらの cfEnv は引数型が { context: unknown } で h3 に依存しない (テスト都合)
 * (あちらに在った、.get() の reject を null に握り潰す resolveSecret は、オンプレ経路の
 *  fetchIchiban ごと撤去した。Refs ohishi-exp/rust-ichibanboshi#322)
 *
 * ## auto-import は **`ichiban-upstream.ts` 版の `cfEnv` を採用している** (別の話)
 *
 * 上の「意図的に統合していない」とは別件。Nitro の auto-import は同名 export の
 * 片方しか採れないので、ビルド時に `Duplicated imports "cfEnv"` が出て
 * **`ichiban-upstream.ts` 版が勝つ**。`nuxt prepare` 後の
 * `.nuxt/types/nitro-imports.d.ts` にそのまま出ている:
 *
 *   const cfEnv: typeof import('../../server/utils/ichiban-upstream').cfEnv
 *   const resolveSecret: typeof import('../../server/utils/cf-env').resolveSecret
 *
 * **`resolveSecret` は競合していない** — 定義はこのファイルだけ。
 * **`cfEnv` だけが影になっている**。
 *
 * **現時点の実害は 0**: `cfEnv` を使う **34 ファイルすべてが明示 import** で、
 * auto-import に頼っているファイルは **0**。内訳は `ichiban-upstream.ts` から **5**、
 * `cf-env.ts` から **29**。
 * (測定条件: このファイルを含む PR の HEAD。
 *  `git grep -l '\bcfEnv\b' -- 'server/**.ts' 'app/**' 'tests/**'` から
 *  定義 2 本を除いた集合を、import 元で分類。数はファイル追加のたびに動く。)
 *
 * **危ないのは新規ファイル**: `server/**` を新しく足す人が import を書かずに
 * `cfEnv(event)` と素で書くと、**黙って `ichiban-upstream.ts` 版を掴む**
 * (型は `{ context: unknown }` を受けるので typecheck も通ってしまう)。
 * このファイルの `cfEnv` を使いたいなら
 * `import { cfEnv } from '../../utils/cf-env'` と明示すること。
 */
import type { H3Event } from 'h3'

/**
 * Cloudflare Workers の env binding を H3Event から取り出す。
 *
 * 型引数で絞り込める: 呼び出し側がローカル interface (CloudflareEnv 等) を
 * 持っている場合は cfEnv<CloudflareEnv>(event) と書くことで R2Bucket 等の
 * 絞り込みを保てる。既定は Record<string, unknown>。ランタイムの挙動は同じ。
 */
export function cfEnv<T = Record<string, unknown>>(event: H3Event): T {
  return ((event.context.cloudflare as { env?: T } | undefined)?.env ?? {}) as T
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す。 */
export async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}
