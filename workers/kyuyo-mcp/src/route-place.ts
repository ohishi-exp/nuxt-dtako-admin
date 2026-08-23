/**
 * 経路の端 (積地・卸地) の正規化。**app/utils の双子** (Refs #760 の 34)。
 *
 * app 側の実装は `app/utils/allowance-trips.ts` の `addressToCity` / `cityToPlace` と
 * `app/utils/margin.ts` の `routePlace` / `UNKNOWN_PLACE`。**worker から app 側を
 * import できない** (Nuxt の typecheck が worker 全体を厳格検査してしまう罠、Refs #268 —
 * `workers/dtako-scraper-relay/src/employee-master.ts` の `normalizeNameKey` と同じ事情)
 * ため実装は 2 箇所になる。**変更する時は両方に反映すること。**
 *
 * 双子であることは `tests/fixtures/kushiro-loading/` の共有 fixture + golden で
 * 機械的に固定してある (`test/kushiro-twin-parity.test.ts`)。
 */

/** 積地・卸地が空の便の経路の端 (`app/utils/margin.ts` と同一)。 */
export const UNKNOWN_PLACE = "(不明)";

/**
 * イベントCSV の `開始市町村名` / `終了市町村名` から市町村を取り出す。
 * **列名に反して入っているのは住所** (`北海道釧路市西港１-98-41` /
 * `北海道河東郡上士幌町上士幌東３線`)。都道府県と郡を落として市区町村までを返す。
 *
 * 取り出せなければ**入力をそのまま返す** — 適当に切り詰めて別の場所に当たるより、
 * マスタで `unknown` になって人の目に触れる方が安全。
 */
const ADDRESS_CITY_RE = /^(?:.{2,3}[都道府県])(?:[^都道府県市区町村]{1,8}郡)?([^市区町村]{1,8}[市区町村])/;

export function addressToCity(address: string): string {
  const trimmed = address.trim();
  return ADDRESS_CITY_RE.exec(trimmed)?.[1] ?? trimmed;
}

/** `釧路市` → `釧路`。マスタの積地はこの粒度で書かれている。 */
export function cityToPlace(city: string): string {
  return city.trim().replace(/(市|町|村)$/, "");
}

/**
 * 経路の端の正規化 (`cityToPlace(addressToCity(city))` = 手当マスタの引き方)。
 * 空なら `(不明)`。
 */
export function routePlace(city: string): string {
  const place = cityToPlace(addressToCity(city));
  return place === "" ? UNKNOWN_PLACE : place;
}
