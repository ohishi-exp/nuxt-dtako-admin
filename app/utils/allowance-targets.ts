/**
 * 運行手当の「対象乗務員」の保存 (pure)。
 *
 * 全乗務員を集計すると、帯広のバルク車以外の運行まで引き当てにいって未確定が数百件に
 * なる (2026-07 の実測で 便45 / 未確定472)。**対象を保存して、その乗務員の運行だけを
 * `/api/operations` に引かせる**ための道具。
 *
 * **キーは乗務員CD。** 名前で保存して一覧を全件取ってから絞る作りにしていたが、
 * `/api/operations` は `per_page` を 200 に丸めるので月の後ろ 200 件しか返らず、
 * 月の前半がまるごと落ちていた (2026-07 は全社 1142 運行)。CD なら
 * `driver_cd` を渡して**サーバ側で絞れる**ので、対象 5 人なら 5 回の呼び出しで済む。
 */

/** 保存・比較に使う形。前後の空白だけ落とす (CD は数字文字列)。 */
export function normalizeDriverCd(cd: string | null | undefined): string {
  return (cd ?? '').trim()
}

/**
 * 乗務員CD として妥当な形か。**氏名が紛れ込むのを弾くための番人。**
 *
 * 対象を氏名で保存していた版があり、同じキーのまま CD へ意味を変えたせいで、
 * 氏名が `driver_cd` として API に渡り「運行が見つかりません」になった
 * (2026-08-21 に実際に踏んだ)。保存キーは分けたうえで、ここでも弾く。
 * 氏名は漢字や空白を含むので `\w` に通らない。
 */
export function isDriverCd(value: string): boolean {
  return /^[\w-]+$/.test(value)
}

/** 保存済みの対象乗務員CD を読む。壊れた値・空・氏名は「対象なし」として扱う。 */
export function parseTargets(raw: string | null | undefined): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const codes = parsed
    .filter((v): v is string => typeof v === 'string')
    .map(normalizeDriverCd)
    .filter(isDriverCd)
  return [...new Set(codes)].sort()
}

export function serializeTargets(codes: string[]): string {
  return JSON.stringify(parseTargets(JSON.stringify(codes)))
}

/** 対象に入っていれば外し、入っていなければ足す。 */
export function toggleTarget(codes: string[], cd: string): string[] {
  const key = normalizeDriverCd(cd)
  if (!isDriverCd(key)) return codes
  const set = new Set(codes.map(normalizeDriverCd))
  if (set.has(key)) set.delete(key)
  else set.add(key)
  return [...set].sort()
}

/** 乗務員CD → 表示名 (`1412 中村 一由`)。マスタに無い CD は CD だけ返す。 */
export function driverLabel(drivers: { driver_cd: string, driver_name: string }[], cd: string): string {
  const hit = drivers.find(d => normalizeDriverCd(d.driver_cd) === normalizeDriverCd(cd))
  return hit ? `${hit.driver_cd} ${hit.driver_name}` : cd
}
