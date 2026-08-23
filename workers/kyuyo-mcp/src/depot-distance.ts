/**
 * 営業所 (出庫・帰庫地点) を差し替えて回送距離を試算するための pure util。
 * **`app/utils/depot-distance.ts` (Refs #760 の 32、#795) の双子** — ロジックは
 * 1 行も変えていない。移植の理由は `route-place.ts` の冒頭に書いたのと同じ
 * (worker から app 側は import できない、Refs #268)。**変更する時は両方に反映すること。**
 *
 * 移植で変わったのは 1 点だけ: app 側は座標型 `LatLng` を `operation-route-map.ts`
 * (= `getGpsForCell` の戻り値) から type-only import しているが、worker 側にその
 * モジュールは無いので**同じ形の型をここで宣言**している。
 *
 * ## 距離は直線 (道なり ではない)
 *
 * 初弾は桁感を掴むのが目的なので直線距離 (haversine) で出す。**直線は道なりの下限**
 * であって、実距離は必ずこれ以上になる。
 *
 * ## 欠測を 0 に倒さない
 *
 * 緯度経度が欠けている / 壊れているときは **0 km ではなく `null`**。0 を返すと
 * 「営業所のすぐ隣で走り始めた」という実在しうる値に化けて、回送距離が静かに過小になる。
 *
 * ## 推定 (直線) と 実測 を混ぜない
 *
 * **この util が出すのは推定であって、実績の回送km ではない。** 「帯広 = 実測 /
 * 釧路 = 推定」の比較は営業所の差ではなく測り方の差を見ていることになる。
 */

/** 十進度の緯度経度。app 側 `operation-route-map.ts` の `LatLng` と同じ形。 */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * 地球の平均半径 (km)。IUGG の算術平均半径 R1 = (2a + b) / 3 = 6371.0088 km (WGS84)。
 */
export const EARTH_RADIUS_KM = 6371.0088;

/** 緯度の絶対値の上限 (度)。 */
const LAT_ABS_MAX = 90;

/** 経度の絶対値の上限 (度)。 */
const LNG_ABS_MAX = 180;

/**
 * 釧路営業所の**暫定**起終点 = 釧路市役所 (北海道釧路市黒金町7丁目5番地)。
 * 正式な所在地が決まったら**この 1 定数を差し替えるだけ**で済むよう、座標をここ以外に
 * 散らかさないこと。
 */
export const KUSHIRO_CITY_HALL: LatLng = { lat: 42.9849, lng: 144.3817 };

/**
 * 比較基準となる帯広側の起終点 = 帯広市役所 (北海道帯広市西5条南7丁目1番地)。
 * 実測 GPS の代表点ではなく定数なのは、月が変わっても基準が動かないようにするため
 * (詳細は app 側の JSDoc)。
 */
export const OBIHIRO_DEPOT: LatLng = { lat: 42.924, lng: 143.1964 };

/**
 * 営業所をキーで選べる形。**これは営業所マスタではない** — 座標を差し替えて試算する
 * ための一覧であって、所属乗務員も車輌も持たない。
 */
export const DEPOTS = {
  obihiro: OBIHIRO_DEPOT,
  kushiro: KUSHIRO_CITY_HALL,
} as const;

/** `DEPOTS` のキー (`'obihiro' | 'kushiro'`)。 */
export type DepotKey = keyof typeof DEPOTS;

/** 座標として使える値か。`null` / `undefined` / `NaN` / `Infinity` / 範囲外を弾く。 */
export function isValidLatLng(point: LatLng | null | undefined): point is LatLng {
  if (point == null) return false;
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
  if (Math.abs(point.lat) > LAT_ABS_MAX || Math.abs(point.lng) > LNG_ABS_MAX) return false;
  return true;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** 2 点間の**直線**距離 (km)。どちらかが欠測・範囲外なら **`0` ではなく `null`**。 */
export function haversineKm(
  a: LatLng | null | undefined,
  b: LatLng | null | undefined,
): number | null {
  if (!isValidLatLng(a)) return null;
  if (!isValidLatLng(b)) return null;

  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRadians(b.lng - a.lng);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  // 対蹠点付近で浮動小数の誤差により h が 1 をわずかに超えると asin が NaN になるため
  // 1 で頭打ちにする (分岐ではなく Math.min で潰す)。
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
