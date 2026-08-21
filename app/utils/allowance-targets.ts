/**
 * 運行手当の「対象乗務員」の保存 (pure)。
 *
 * 全社を集計すると、帯広のバルク車以外の運行まで引き当てにいって未確定が数百件になる
 * (2026-07 の実測で 便45 / 未確定472)。**対象の乗務員を保存して、その人の運行だけを
 * 集計する**ための最小の道具。
 *
 * キーは**乗務員名**。`/api/operations` の一覧が返すのは `driver_name` だけで
 * 乗務員CD は入っていないため、一覧から選ばせるにはこれしか無い。表記ゆれは
 * `normalizeDriverName` で吸収する (給与大臣由来の名前は全角スペースの数が揺れる)。
 */

/** 全角スペースを半角へ倒し、連続空白を 1 つに潰して trim する。 */
export function normalizeDriverName(name: string | null | undefined): string {
  return (name ?? '').replace(/[\s　]+/g, ' ').trim()
}

/** 保存済みの対象乗務員を読む。壊れた値・空は「対象なし」として扱う。 */
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
  const names = parsed
    .filter((v): v is string => typeof v === 'string')
    .map(normalizeDriverName)
    .filter(name => name !== '')
  return [...new Set(names)].sort()
}

export function serializeTargets(names: string[]): string {
  return JSON.stringify(parseTargets(JSON.stringify(names)))
}

/** 対象に入っていれば外し、入っていなければ足す。 */
export function toggleTarget(names: string[], name: string): string[] {
  const key = normalizeDriverName(name)
  if (key === '') return names
  const set = new Set(names.map(normalizeDriverName))
  if (set.has(key)) set.delete(key)
  else set.add(key)
  return [...set].sort()
}

/**
 * 対象に入っているか。**対象が空なら全員が対象** — 保存前の状態で何も出ないより、
 * 全部出て「絞り込みが要る」と分かる方がよい。
 */
export function matchesTargets(targets: string[], name: string | null | undefined): boolean {
  if (targets.length === 0) return true
  return targets.includes(normalizeDriverName(name))
}

/** 運行一覧から対象乗務員のぶんだけ残す。**イベントCSV を引く前に通す** (重い処理を減らす)。 */
export function filterByTargets<T extends { driver_name: string | null }>(
  operations: T[],
  targets: string[],
): T[] {
  return operations.filter(op => matchesTargets(targets, op.driver_name))
}

/** 運行一覧に出てくる乗務員名を重複なく昇順で返す (対象を選ばせる候補)。 */
export function driverCandidates(operations: { driver_name: string | null }[]): string[] {
  const names = operations
    .map(op => normalizeDriverName(op.driver_name))
    .filter(name => name !== '')
  return [...new Set(names)].sort()
}
