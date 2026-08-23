/**
 * 営業所 (出庫・帰庫地点) を差し替えて回送距離を試算するための pure util
 * (Refs #760 の 32、PR1)。**この時点では画面も既存の集計も一切呼んでいない。**
 *
 * ## なぜ「営業所マスタ」を作らないか
 *
 * コードに「営業所」「出庫・帰庫地点」の概念は無い。回送距離は KUDGIVT イベント CSV の
 * **実測走行距離を積算しているだけ** (`allowance-idle.ts` の `preRollKm` / `legKmDetail`)
 * で、運行の起終点も「運行開始 / 運行終了」イベントの**実測 GPS** (`getGpsForCell`) しか無い。
 * 手当は (積地, 卸地) の組で引く便あたり定額 (`allowance-rate.ts` の `lookupAllowance`) なので、
 * **起点を変えても手当額は変わらない**。変わるのは 回送距離 → 燃料代 → 粗利 と、拘束時間だけ。
 * ⇒ 最小の設計は「マスタを作らず、起終点の座標を差し替えて試算する」。
 *
 * ## 距離は直線 (道なり ではない)
 *
 * 初弾は**桁感を掴む**のが目的なので直線距離 (haversine) で出す。道なり距離
 * (Google Distance Matrix 等) はオーナー確認前なので使わない。直線は道なりの下限
 * であって、実距離は必ずこれ以上になる — 呼び出し側はそう読むこと。
 *
 * ## 欠測を 0 に倒さない
 *
 * 緯度経度が欠けている / 壊れているときは **0 km ではなく `null`** を返す。
 * 0 を返すと「営業所のすぐ隣で走り始めた」という**実在しうる値**に化けて、
 * 回送距離が静かに過小になる。最低賃金チェックで「欠測を 0 分に倒さない」のと同じ思想
 * (memory `wage-report-restraint-source.md`)。
 */

// 座標型は新設しない。`event-data-table.ts` の `getGpsForCell` が返す形そのもの
// (度分 → 十進の変換は向こうが済ませている) を受けたいので、既存の `LatLng` を借りる。
// type-only import なので実行時の依存は増えない。
import type { LatLng } from './operation-route-map'

export type { LatLng }

/**
 * 地球の平均半径 (km)。IUGG が定める 算術平均半径 R1 = (2a + b) / 3 = 6371.0088 km
 * (a = 6378.1370 / b = 6356.7523、WGS84)。
 *
 * haversine は球体近似なので、どの半径を採っても中緯度で 0.3% 程度の系統誤差が残る。
 * 「6371 ちょうど」ではなく R1 を採るのは、**桁を丸める根拠を後から説明できるようにする**
 * ため (帯広〜釧路 ≈ 97km なら差は 100m 未満で、この用途では実質どちらでも同じ)。
 */
export const EARTH_RADIUS_KM = 6371.0088

/** 緯度の絶対値の上限 (度)。これを超える値は座標ではない。 */
const LAT_ABS_MAX = 90

/** 経度の絶対値の上限 (度)。 */
const LNG_ABS_MAX = 180

/**
 * 釧路営業所の**暫定**起終点 = 釧路市役所 (北海道釧路市黒金町7丁目5番地)。
 *
 * オーナー (2026-08-23):「とりあえず 釧路市役所 開始終了で 暫定にして、給与・手当を
 * 検討したい」。**正式な所在地が決まったら この 1 定数を差し替えるだけで済む** ように、
 * 座標をここ以外に散らかさないこと (計画の合意事項)。
 */
export const KUSHIRO_CITY_HALL: LatLng = { lat: 42.9849, lng: 144.3817 }

/**
 * 比較基準となる帯広側の起終点 = 帯広市役所 (北海道帯広市西5条南7丁目1番地)。
 *
 * **なぜ「実測 GPS の代表点」ではなく定数か** (Refs #760 の 32 で判断):
 *
 * 1. 実測の代表点は「どの月の・どの車輌の 運行開始 GPS を採ったか」まで固定しないと
 *    定数にならない。月が変われば基準そのものが動き、試算の再現性が無くなる。
 *    始業前に自宅から出た運行・別の車庫から出た運行のばらつきも黙って混ざる。
 * 2. 釧路側が「市役所 (暫定)」なので、比較の**両側を同じ性質の点** (公的に一意な住所)
 *    に揃えないと差分の桁感が読めない。初弾は直線距離で桁感を掴む方針と揃う。
 * 3. 正式所在地が決まったときの差し替えが 1 定数で済む — 釧路側と同じ扱いにできる。
 *
 * ⇒ 実測 GPS は「営業所の座標」ではなく「その運行が実際にどこから走り出したか」として、
 * 距離の**相手側**に渡すのが正しい使い分け (`haversineKm(OBIHIRO_DEPOT, 実測点)`)。
 */
export const OBIHIRO_DEPOT: LatLng = { lat: 42.9240, lng: 143.1964 }

/**
 * 座標として使える値か。`null` / `undefined` / `NaN` / `Infinity` / 範囲外を弾く。
 *
 * `getGpsForCell` は無効な点をすでに `null` にして返すが、`null` を素通しできる
 * 呼び出し口にしておきたいので、ここでも同じ判定を持つ。
 */
export function isValidLatLng(point: LatLng | null | undefined): point is LatLng {
  if (point == null) return false
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false
  if (Math.abs(point.lat) > LAT_ABS_MAX || Math.abs(point.lng) > LNG_ABS_MAX) return false
  return true
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/**
 * 2 点間の**直線**距離 (km)。どちらかが欠測・範囲外なら **`0` ではなく `null`**。
 *
 * `getGpsForCell(headers, row, '開始市町村名')` の戻り値をそのまま渡せる。
 */
export function haversineKm(a: LatLng | null | undefined, b: LatLng | null | undefined): number | null {
  if (!isValidLatLng(a)) return null
  if (!isValidLatLng(b)) return null

  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const dLat = lat2 - lat1
  const dLng = toRadians(b.lng - a.lng)

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  // 対蹠点付近で浮動小数の誤差により h が 1 をわずかに超えると asin が NaN になるため
  // 1 で頭打ちにする (分岐ではなく Math.min で潰す)。
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}
