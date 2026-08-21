/**
 * ページ分割された一覧を最後まで取る。
 *
 * **rust-alc-api の `/api/operations` は `per_page` を 200 に丸める**
 * (`crates/alc-dtako/src/repo/dtako_operations.rs`: `unwrap_or(50).min(200)`)。
 * 大きい `per_page` を渡しても黙って 200 になるだけで、エラーにも警告にもならない。
 * 1 ページしか取らないと**新しい方から 200 件だけ**が返り、月の前半がまるごと消える
 * (2026-07 は全社で 1142 運行あり、07-27 以降しか出ていなかった)。
 */
export interface FetchedPage<T> {
  items: T[]
  /** サーバが返す総件数。これに届いたら止める。 */
  total: number
}

/**
 * `fetchPage(1)`, `fetchPage(2)`, … と総件数に届くまで呼ぶ。
 *
 * 空ページが返ったら止める (`total` が信用できないときの保険)。`maxPages` は
 * 暴走止めで、届かないまま打ち切ったかどうかは呼び出し側からは分からないので
 * **十分大きく取る**こと。
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<FetchedPage<T>>,
  maxPages = 50,
): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const { items, total } = await fetchPage(page)
    all.push(...items)
    if (items.length === 0) break
    if (all.length >= total) break
  }
  return all
}
