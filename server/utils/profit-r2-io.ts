/**
 * 一番星マッチ率検証スナップショット (Refs #330 PR3) の R2 IO。
 * バージョン管理ロジックは workers/dtako-scraper-relay/src/dtako-scraper-relay-do.ts の
 * putVersionedR2/listAllR2 と同じ設計 (sha256差分検知、latest+v-{ts})。DO の private
 * メソッドで export されておらず import できないため、Nitro server route 用に移植する。
 */
import { appendProfitHistoryJsonl } from '~/utils/profit-r2'

export interface R2ObjectLite {
  key: string
  customMetadata?: Record<string, string>
}
export interface R2ObjectBodyLite extends R2ObjectLite {
  text(): Promise<string>
}
interface R2PutOptions {
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}
interface R2ListOptionsLite {
  prefix?: string
  cursor?: string
}
interface R2ListResultLite {
  objects: R2ObjectLite[]
  truncated: boolean
  cursor?: string
}
export interface R2BucketLite {
  get(key: string): Promise<R2ObjectBodyLite | null>
  head(key: string): Promise<{ customMetadata?: Record<string, string> } | null>
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: R2PutOptions): Promise<unknown>
  list(options?: R2ListOptionsLite): Promise<R2ListResultLite>
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Uint8Array<ArrayBufferLike> は BufferSource (ArrayBuffer 前提) と型が合わないため
  // cast する (dtako-scraper-relay-do.ts の sha256Hex と同じ回避)。
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `latest` の customMetadata.sha256 と比較するバージョン管理 put。
 *
 * `body` (実際に保存する内容) と `hashInput` (差分判定に使う内容) を分けているのは、
 * `body` 側には呼び出し都度変わる `savedAt` (保存時刻) が含まれるため — これをそのまま
 * ハッシュ対象にすると保存する度に「内容が変わった」ことになり dedup が機能しない。
 * `hashInput` には確認済み伝票一覧等の意味のある内容だけを渡す想定 (savedAt を除いた
 * スナップショット)。内容不変なら latest の本文 (savedAt 込み) は最新化しつつ
 * `lastVerifiedAt` だけ更新 (version は増やさない)、意味のある内容が変われば latest
 * 上書き + `v-{ts}` 版を追加する。
 */
export async function putVersionedProfit(
  bucket: R2BucketLite,
  latestKey: string,
  versionKey: string,
  body: string,
  hashInput: string,
  fetchedAt: string,
): Promise<{ changed: boolean, sha256: string }> {
  const hash = await sha256Hex(new TextEncoder().encode(hashInput))
  const bytes = new TextEncoder().encode(body)
  const latest = await bucket.head(latestKey)
  if (latest?.customMetadata?.sha256 === hash) {
    await bucket.put(latestKey, bytes, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { ...latest.customMetadata, lastVerifiedAt: fetchedAt },
    })
    return { changed: false, sha256: hash }
  }
  const options: R2PutOptions = {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { sha256: hash, fetchedAt, lastVerifiedAt: fetchedAt },
  }
  await bucket.put(latestKey, bytes, options)
  await bucket.put(versionKey, bytes, options)
  return { changed: true, sha256: hash }
}

/** R2 list を cursor で全件回す。 */
export async function listAllProfit(bucket: R2BucketLite, prefix: string): Promise<R2ObjectLite[]> {
  const out: R2ObjectLite[] = []
  let cursor: string | undefined
  do {
    const res = await bucket.list({ prefix, cursor })
    out.push(...res.objects)
    cursor = res.truncated ? res.cursor : undefined
  } while (cursor)
  return out
}

/** 確認履歴 (history.jsonl) に 1 行追記する (R2 は append 不可のため read-modify-write)。 */
export async function appendProfitHistory(bucket: R2BucketLite, historyKey: string, line: string): Promise<void> {
  const existing = await bucket.get(historyKey)
  const text = existing ? await existing.text() : null
  await bucket.put(historyKey, appendProfitHistoryJsonl(text, line), {
    httpMetadata: { contentType: 'application/x-ndjson' },
  })
}
