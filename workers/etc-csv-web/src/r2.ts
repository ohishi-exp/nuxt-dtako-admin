/**
 * R2 の list / get を「構造的型 + cursor 全件回収」で包む層。
 *
 * `@cloudflare/workers-types` の実体に依存しない最小インターフェースにしてあるので、
 * node の vitest から偽のバケットで直接テストできる
 * (`server/api/vehicle-settings/history.get.ts` / `server/utils/profit-r2-io.ts` と
 *  同じ流儀。ただし日付一覧は `delimitedPrefixes` を読むので戻り値の形が違う)。
 */

import { ETC_CSV_DATE_PATTERN, ETC_CSV_KEY_PATTERN } from './keys'

export interface R2ObjectLite {
  key: string
  size: number
  uploaded: Date | string
}

export interface R2ListResultLite {
  objects: R2ObjectLite[]
  truncated: boolean
  cursor?: string
  /** `delimiter` を渡したときだけ返る「ディレクトリ名」の一覧 (末尾に delimiter 付き)。 */
  delimitedPrefixes?: string[]
}

export interface R2ListOptionsLite {
  prefix?: string
  delimiter?: string
  cursor?: string
  limit?: number
}

export interface R2BodyLite {
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface R2BucketLite {
  list(options?: R2ListOptionsLite): Promise<R2ListResultLite>
  get(key: string): Promise<R2BodyLite | null>
}

/** `/list?user_id=…&date=…` が返す 1 件。 */
export interface EtcCsvObject {
  key: string
  size: number
  uploaded: string
}

function toIso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString()
}

/**
 * `prefix` 直下のディレクトリ名 (= `YYYY-MM-DD`) を集める。
 *
 * R2 の list は **1 回 1000 件が上限**なので、`truncated` / `cursor` を必ず回す。
 * 日付の形をしていないディレクトリは捨てる。
 */
export async function listDateDirs(bucket: R2BucketLite, prefix: string): Promise<string[]> {
  const dates: string[] = []
  let cursor: string | undefined
  do {
    const res: R2ListResultLite = await bucket.list({ prefix, delimiter: '/', cursor, limit: 1000 })
    for (const p of res.delimitedPrefixes ?? []) {
      const name = p.slice(prefix.length).replace(/\/$/, '')
      if (ETC_CSV_DATE_PATTERN.test(name)) dates.push(name)
    }
    cursor = res.truncated ? res.cursor : undefined
  } while (cursor)
  dates.sort()
  return dates
}

/**
 * `prefix` 配下のオブジェクトを集める (cursor で全件)。
 *
 * `ETC_CSV_KEY_PATTERN` に一致しない鍵は返さない — 返した鍵は必ず `/download` でも
 * 通る、という不変条件を保つため。
 */
export async function listEtcCsvObjects(
  bucket: R2BucketLite,
  prefix: string,
): Promise<EtcCsvObject[]> {
  const out: EtcCsvObject[] = []
  let cursor: string | undefined
  do {
    const res: R2ListResultLite = await bucket.list({ prefix, cursor, limit: 1000 })
    for (const o of res.objects) {
      if (!ETC_CSV_KEY_PATTERN.test(o.key)) continue
      out.push({ key: o.key, size: o.size, uploaded: toIso(o.uploaded) })
    }
    cursor = res.truncated ? res.cursor : undefined
  } while (cursor)
  out.sort((a, b) => (a.key < b.key ? -1 : 1))
  return out
}
