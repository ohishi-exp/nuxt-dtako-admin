import type { R2BucketLite, R2ListOptionsLite, R2ListResultLite, R2ObjectLite } from '../src/r2'

/** `bucket.list()` が返すページを並べて与える偽バケット (cursor 分岐の検証用)。 */
export function fakeBucket(
  pages: R2ListResultLite[],
  body?: Record<string, string>,
): R2BucketLite & { calls: R2ListOptionsLite[] } {
  const calls: R2ListOptionsLite[] = []
  let i = 0
  return {
    calls,
    async list(options?: R2ListOptionsLite): Promise<R2ListResultLite> {
      calls.push(options ?? {})
      const page = pages[i]
      i += 1
      return page ?? { objects: [], truncated: false }
    },
    async get(key: string) {
      const text = body?.[key]
      if (text === undefined) return null
      return { async arrayBuffer() { return new TextEncoder().encode(text).buffer as ArrayBuffer } }
    },
  }
}

export function obj(key: string, size = 10, uploaded: Date | string = new Date('2026-09-01T00:00:00Z')): R2ObjectLite {
  return { key, size, uploaded }
}
