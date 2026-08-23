/**
 * 運行 N 本の csvdata.zip を 1 つの zip に同梱する (Refs #760 の 25)。粗利タブの
 * 経路 / 取引先の重ね合わせ地図の「zip 一括 (N 運行)」が使う。
 *
 * - 取得 (運行ごとに `/api/operations/<unko>/csvdata-zip` を**直列**で引く。relay が
 *   1 運行ごとに theearth にログインしうるので並列にしない) は呼び出し側 (`margin.vue`)。
 *   ここは**バイト列を zip に詰めるだけ** (pure 寄り。JSZip は `net780.ts` /
 *   `y-time-xlsx.ts` と同じもの)
 * - 中身は `csvdata-<運行NO>.zip` を N 個、そのまま (展開しない。原本を手元に置くのが目的)
 * - 圧縮はしない (`STORE`)。中身が zip なので縮まない
 */
import JSZip from 'jszip'

export interface ZipBundleEntry {
  /** zip 内のファイル名 (例 `csvdata-2607010533090000004219.zip`)。 */
  name: string
  bytes: ArrayBuffer | Uint8Array
}

export async function bundleZips(entries: ZipBundleEntry[]): Promise<Blob> {
  const zip = new JSZip()
  for (const e of entries) zip.file(e.name, e.bytes)
  return zip.generateAsync({ type: 'blob', compression: 'STORE' })
}

/**
 * 一括 zip のファイル名: `csvdata-<取引先コード or 取引先名>-<積地→卸地 or all>-<ym>.zip`。
 * `customer` は取引先コード (無ければ名前) を呼び出し側が決めて渡す。`route` は
 * 経路行なら `積地→卸地`、取引先行 (全経路) なら null → `all`。
 * ファイル名に使えない文字 (`/` `\` `:` `*` `?` `"` `<` `>` `|`) は `_` に寄せる。
 */
export function bulkZipFilename(customer: string, route: string | null, ym: string): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_')
  return `csvdata-${safe(customer)}-${safe(route ?? 'all')}-${ym}.zip`
}
