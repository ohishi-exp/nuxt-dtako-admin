/**
 * DTAKO_R2 (dtako-uploads) の read-only アクセスヘルパー。
 * `dtako-scraper-relay-do.ts::listAllR2` と同じ cursor loop パターンを
 * DO instance に依存しない形で移植する。
 */

/** key の JSON を読んで parse する。無い/壊れている場合は `null`。 */
export async function getJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as T;
  } catch {
    return null;
  }
}

/** R2 list を cursor で全件回す (`listAllR2` と同一)。 */
export async function listAllR2(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const res: R2Objects = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    out.push(...res.objects);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

/** `delimiter: "/"` で得られる直下ディレクトリ名 (末尾 `/` 込み) を cursor で全件回す。
 *  `handleArchiveMonths` の company/month 列挙と同じ pattern。 */
export async function listDelimitedPrefixes(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const res: R2Objects = await bucket.list({ prefix, delimiter: "/", cursor });
    out.push(...res.delimitedPrefixes);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}
