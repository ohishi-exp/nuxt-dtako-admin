/**
 * **人が手で確定したもの**を R2 (全員で共有) に 1 件ずつ残す口 (Refs #845 / Refs #820)。
 *
 * `POST /api/profit/allowance-override` に**1 件の操作** (`{schemaVersion, kind, key, value}`)
 * を投げると、サーバー側で `PROFIT_R2` の `latest.json` を読み、**その 1 件だけを畳み込んで**
 * 版管理保存する (`putVersionedProfit`、**値が同じなら版を増やさない**)。
 * `history.jsonl` には**誰が・いつ・どの鍵を・何から何に**したかを 1 行残す。
 *
 * ## ★ 画面から全体マップを送らせない
 *
 * 「いまは端末が 1 台」は前提にならない — この機能の目的が「端末依存をやめて全員で
 * 共有する」ことなので、**うまくいけば必ず複数端末になる**。全体マップを受ける口を
 * 作ると、2 台目が現れた瞬間に**片方が押すたびに相手の確定を消す**。だから
 * **受けるのは 1 件だけ**にして、畳み込みはここでやる
 * (`applyAllowanceOverrideOperation`)。UI の操作 (`saveProvisional(key, yen)`) は
 * もともと 1 件単位なので、画面側は素直に書ける。
 *
 * **消したことも値として残す** (`value: null` = tombstone)。単純な和集合にすると
 * 「解除した除外」が他端末の push で復活するため (`allowance-overrides-r2.ts` 参照)。
 *
 * ## `requireAuth` を付ける
 *
 * 権限範囲が「その端末の人だけ」→「R2 に触れる人全員」に広がるので、ログイン必須にして
 * **誰が触ったか** (`by` = email) を履歴の 1 行に残す。**既存の `snapshot.post.ts` /
 * `margin-summary.post.ts` には足していない** (この PR のスコープ外)。
 *
 * ## `codeVersion` を刻まない
 *
 * `margin-summary` が `codeVersion` を刻むのは、**同じ入力でもロジックが変われば数字が
 * 動く**ため。こちらの値は**人が入力した数そのもの**でコードが作っていないので、
 * 版に刻んでも「いつ変わったか」の役に立たない。
 *
 *   200 — `{saved, changed, savedAt, by, key, value, entries, versionKey}`
 *         (`value` は**保存された後の値**。送った値のエコーではない)
 *   400 — body の形式不正 (`kind` は provisional のみ / `value` は正の整数か null)
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / PROFIT_R2 binding 未設定
 */
import type { H3Event } from 'h3'
import { defineEventHandler, readBody, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import {
  allowanceOverrideHashInput,
  allowanceOverrideHistoryLine,
  allowanceOverrideR2Paths,
  allowanceOverrideValue,
  applyAllowanceOverrideOperation,
  isProvisionalOverrideValue,
  liveAllowanceOverrideCount,
  parseAllowanceOverrideBody,
  parseAllowanceOverrideSnapshot,
  resolveOverrideBy,
} from '~/utils/allowance-overrides-r2'
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
 * (`net780/archive.post.ts` / `etc-csv/download.get.ts` と同実装)。 */
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
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
  // **書く前に誰かを確定させる。** 履歴の `by` はここでしか取れない。
  const auth = await requireAuth(event, { authWorkerUrl, sharedSecret })

  const r2 = env.PROFIT_R2
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  // body が JSON でない (readBody が投げる) のも 400 に寄せる。
  const body = await readBody(event).catch(() => null)
  const parsed = parseAllowanceOverrideBody(body)
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.error })
  }

  const by = resolveOverrideBy(auth.email)
  const savedAt = new Date().toISOString()
  const paths = allowanceOverrideR2Paths(parsed.kind)

  // **read-modify-write。** 全体像は R2 が持っていて、画面は 1 件しか知らない。
  const stored = await r2.get(paths.latest)
  const before = parseAllowanceOverrideSnapshot<number>(
    stored ? await stored.text() : null,
    parsed.kind,
    isProvisionalOverrideValue,
  )
  const beforeValue = allowanceOverrideValue(before, parsed.key)
  const after = applyAllowanceOverrideOperation(before, { key: parsed.key, value: parsed.value }, by, savedAt)

  const ts = profitVersionTimestamp(new Date())
  // savedAt と by/at は毎回変わるのでハッシュ対象から除く (allowanceOverrideHashInput)。
  const result = await putVersionedProfit(
    r2,
    paths.latest,
    paths.version(ts),
    JSON.stringify(after),
    allowanceOverrideHashInput(after),
    savedAt,
  )
  // **値が動かなかった回も 1 行残す** — 「誰がいつ触ったか」は版ではなく履歴の持ち物。
  await appendProfitHistory(r2, paths.history, JSON.stringify(allowanceOverrideHistoryLine({
    snapshot: after,
    key: parsed.key,
    by,
    before: beforeValue,
    changed: result.changed,
  })))

  return {
    saved: true,
    changed: result.changed,
    savedAt,
    by,
    key: parsed.key,
    // **保存した後の全体像から読み直す。**受け取った `parsed.value` をそのまま返す
    // (エコー) と、畳み込みが値を取り違えても応答は正しく見える。**この PR には
    // 読む口 (GET) が無い**ので、R2 に何が入ったかを確かめられるのはここだけになる。
    value: allowanceOverrideValue(after, parsed.key),
    entries: liveAllowanceOverrideCount(after),
    versionKey: result.versionKey,
  }
})
