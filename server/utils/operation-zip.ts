/**
 * 運行NO から csvdata.zip 取得の引数 (`ope_no_22` / `start_ope`) を組み立てる純関数
 * (Refs #760 の 23)。`server/api/operations/[unko]/csvdata-zip.get.ts` が使う。
 *
 * relay の `POST /kintai-relay/operation-zip` は `{ ope_no_22, start_ope }` を要求する。
 * **出庫日時は運行NO の先頭 12 桁 `YYMMDDHHmmss` から機械的に組める** ので、画面から
 * 運行NO 1 本だけを受け取れば足りる (relay の `deriveOpeNoFromUnkoNo`
 * (`workers/dtako-scraper-relay/src/kintai-diff.ts`) と同じ導出。あちらは別 worker・
 * 別 CI なので import せず、front 側で同じ規則を持つ)。
 *
 * 相違点は**範囲検証を足してあること** — 画面から任意の 22/23 桁が来うるので、
 * `26139904185900...` のような月日時分秒が範囲外の値は `null` にして呼び出し側で
 * 400 にする (relay に投げて theearth まで往復させない)。
 *
 * **時は 0 埋めしない** (`2026/07/06 4:18:59`)。theearth (F-NOS3010) の
 * `START_OPE_RE` がその形なので、`04:18:59` にすると受理されない。
 */

/** 運行NO。GCP 由来は 22 桁、オンプレ由来は 23 桁 (末尾 1 桁が対象乗務員CD)。 */
export const UNKO_NO_RE = /^\d{22,23}$/

/** `YYYY/MM/DD H:mm:ss` (**時は 0 埋めなし**、relay/theearth の `START_OPE_RE` と同形)。 */
export const START_OPE_RE = /^\d{4}\/\d{2}\/\d{2} \d{1,2}:\d{2}:\d{2}$/

/** `s` (数字列) が min..max に収まるか。 */
function inRange(s: string, min: number, max: number): boolean {
  const n = Number(s)
  return n >= min && n <= max
}

/**
 * 運行NO を relay の `ope_no_22` (22 桁) に正規化する。23 桁なら末尾 1 桁
 * (対象乗務員CD) を落とす。22/23 桁の数字でなければ `null`。
 */
export function opeNo22FromUnkoNo(unkoNo: string): string | null {
  if (!UNKO_NO_RE.test(unkoNo)) return null
  return unkoNo.slice(0, 22)
}

/**
 * 運行NO の先頭 12 桁 `YYMMDDHHmmss` から出庫日時 `YYYY/MM/DD H:mm:ss` を組む。
 * 年は 2000 年代決め打ち (theearth/dtako の運用開始が 2000 年以降)。
 *
 * 桁数が違う / 月日時分秒が範囲外なら `null` (呼び出し側が 400 にする)。
 * 暦としての実在 (2 月 31 日など) までは見ない — 存在しない日なら theearth 側が
 * 0 件を返すだけで、front が暦を持つ理由が無い。
 */
export function startOpeFromUnkoNo(unkoNo: string): string | null {
  const opeNo22 = opeNo22FromUnkoNo(unkoNo)
  if (opeNo22 === null) return null
  const yy = opeNo22.slice(0, 2)
  const mm = opeNo22.slice(2, 4)
  const dd = opeNo22.slice(4, 6)
  const hh = opeNo22.slice(6, 8)
  const mi = opeNo22.slice(8, 10)
  const ss = opeNo22.slice(10, 12)
  if (!inRange(mm, 1, 12)) return null
  if (!inRange(dd, 1, 31)) return null
  if (!inRange(hh, 0, 23)) return null
  if (!inRange(mi, 0, 59)) return null
  if (!inRange(ss, 0, 59)) return null
  // 時だけ 0 埋めを外す (`04:18:59` は theearth に弾かれる)。
  return `20${yy}/${mm}/${dd} ${Number(hh)}:${mi}:${ss}`
}
