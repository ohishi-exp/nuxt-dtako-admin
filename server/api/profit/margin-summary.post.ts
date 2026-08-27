/**
 * 粗利の集計結果 (`MarginCache`) の版管理保存 (Refs #826)。
 *
 * `POST /api/profit/margin-summary` に画面の集計 (`MarginSummaryInput`) を投げると、
 * サーバー側で `savedAt` (時計) を埋めて `PROFIT_R2` にバージョン管理保存する
 * (`putVersionedProfit`、**内容不変なら版を増やさず** `lastVerifiedAt` /
 * `lastVerifiedCodeVersion` のみ更新)。履歴 (`history.jsonl`) にも 1 行追記する。
 * **確定ボタンは無い** — 粗利タブが再計算するたびにここへ来る。
 *
 * ★ **形式 2 から「その版を作った端末の設定」の指紋も受ける** (Refs #886) —
 * 燃費の上書き (`fuelRateOverrides`) と運行経費の配分の比 (`runCostShareMode`)。
 * どちらも localStorage 由来で画面にしか無く、**版に入っていないと「なぜその数字に
 * なったか」が版のどこにも残らない**。ここでも**数字は 1 円も作らない** — 受け取った値を
 * そのまま本文に載せ、`marginSummaryHashInput` 経由で差分検知の対象に含めるだけ。
 * **形式 1 の body はここで 400 になる** (`schemaVersion` の厳格一致)。既に R2 にある
 * 形式 1 の版はそのまま残り、遡って指紋は付かない。
 *
 * `codeVersion` (ビルド時定数) は**画面が名乗る** — 数字を計算するのは画面なので、
 * 画面の版がその数字を作った版そのものになる。ここでは `resolveCodeVersion` で
 * 正規化するだけで、**空文字や undefined を版に混ぜない**。
 *
 * 作りは `snapshot.post.ts` (検証スナップショット) と同じ。**別の口にしてある**のは
 * 突合が 2 系統あるためで、混ぜると**保存済み検証一覧**が粗利の集計をスナップショットとして
 * 読み始める (map skill「突合は 2 系統ある — 混ぜない」。**#850 で実際に踏んだ形**で、
 * #856 の `isProfitSnapshotKey` が今はそこを弾く)。**#859 でマッチ率の月次比較が消えた後も
 * この境界は要る** — 読み手が一覧に変わっただけで、混ぜたときの壊れ方は同じ。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ので、A 段の `requireAuth`
 * (`allowance-override.post.ts` と同じ 2 行) をここにも入れる。
 * 呼ぶのは粗利タブ (`/profit/margin`) の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / PROFIT_R2 binding 未設定
 */
import type { H3Event } from 'h3'
import { defineEventHandler, readBody, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import {
  isRunCostShareMode,
  marginR2Paths,
  marginSummaryHashInput,
  marginSummaryHistoryLine,
  resolveCodeVersion,
  MARGIN_SUMMARY_SCHEMA_VERSION,
  type MarginSummaryInput,
  type MarginSummarySnapshot,
} from '~/utils/margin-r2'
import { profitVersionTimestamp } from '~/utils/profit-r2'
import { putVersionedProfit, appendProfitHistory, type R2BucketLite } from '../../utils/profit-r2-io'

interface CloudflareEnv {
  PROFIT_R2?: R2BucketLite
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

function cfEnv(event: H3Event): CloudflareEnv {
  return (event.context.cloudflare as { env?: CloudflareEnv } | undefined)?.env ?? {}
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す
 * (`allowance-override.post.ts` と同実装)。 */
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

/**
 * **月の集計そのもの**が要る。`cache.ym` が body の `ym` と違うものは受けない —
 * 保存先 (`profit/{ym}/margin-summary/`) と中身の月がずれると、後から版を読んだ側が
 * 別の月の数字を見る。
 *
 * ★ **形式 2 から指紋 2 欄を必須にする** (Refs #886)。**欠けた body を受けて既定で埋めない** —
 * 埋めると「上書きしていない端末が集計した」という**嘘の指紋**が版に残り、指紋を足した意味が
 * 逆転する (理由の分からない版が、理由を偽った版になる)。形式 1 の body は
 * `schemaVersion` の厳格一致でここまで来ない。
 *
 * `fuelRateOverrides` の中身までは検めない (`totals` / `cache` と同じ深さ) —
 * 組むのは画面の `parseFuelRates` で、そこで既に正の有限数以外は落ちている。
 * ここで深く検めて 400 にすると、**指紋が少し変でも版そのものが残らなくなる**方が損失が大きい。
 * `runCostShareMode` だけは値が 3 つしか無い列挙なので厳格に見る (`isRunCostShareMode`)。
 */
function isValidInput(body: unknown): body is MarginSummaryInput {
  if (!body || typeof body !== 'object') return false
  const b = body as Partial<MarginSummaryInput>
  if (b.schemaVersion !== MARGIN_SUMMARY_SCHEMA_VERSION) return false
  if (typeof b.ym !== 'string' || !/^\d{4}-\d{2}$/.test(b.ym)) return false
  if (!b.totals || typeof b.totals !== 'object') return false
  if (!b.cache || typeof b.cache !== 'object') return false
  if (b.cache.ym !== b.ym) return false
  if (!b.fuelRateOverrides || typeof b.fuelRateOverrides !== 'object') return false
  if (!isRunCostShareMode(b.runCostShareMode)) return false
  return Array.isArray(b.cache.operations) && Array.isArray(b.cache.costs)
}

export default defineEventHandler(async (event) => {
  const env = cfEnv(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **R2 を触る前に認証する。** 版を増やせる範囲が「Access を通れる人」から
  // 「auth-worker にログインしている人」に狭まる。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const r2 = env.PROFIT_R2
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const body = await readBody(event)
  if (!isValidInput(body)) {
    throw createError({
      statusCode: 400,
      statusMessage: `schemaVersion(=${MARGIN_SUMMARY_SCHEMA_VERSION})/ym/totals/cache (ym 一致)`
        + '/fuelRateOverrides/runCostShareMode が必要です',
    })
  }

  // 画面が名乗るビルド時定数。タグリリース以外のビルドでは空で来るので、
  // **空文字や undefined を版に混ぜず**「不明」に倒してから使う。
  const codeVersion = resolveCodeVersion(body.codeVersion)
  const savedAt = new Date().toISOString()
  const snapshot: MarginSummarySnapshot = { ...body, codeVersion, savedAt }
  const paths = marginR2Paths(snapshot.ym)
  const ts = profitVersionTimestamp(new Date())
  // savedAt / codeVersion は毎回変わりうるのでハッシュ対象から除く (marginSummaryHashInput)。
  const result = await putVersionedProfit(
    r2,
    paths.latest,
    paths.version(ts),
    JSON.stringify(snapshot),
    marginSummaryHashInput(snapshot),
    savedAt,
    codeVersion,
  )
  await appendProfitHistory(r2, paths.history, JSON.stringify(marginSummaryHistoryLine(snapshot, result.changed)))

  return { saved: true, changed: result.changed, savedAt, codeVersion, versionKey: result.versionKey }
})
