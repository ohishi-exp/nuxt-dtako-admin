/**
 * `GET/PUT /api/netprint/targets` (Refs #874 の 12) が使う pure な部品。
 *
 * **検証はここに書かない。** 通知先の規則 (宛先の排他・Uuid・`branch_cd` 必須) は
 * relay の `validateNetprintTargetsPayload` が正で、front は relay が返した理由を
 * 画面へ運ぶだけ — 同じ規則を 2 か所に持つと「画面では保存できたのに cron が
 * 落とす」設定が作れる (`server/utils/netprint-run.ts` の二重ガードとは事情が違う。
 * あちらは**誤配を防ぐため**に敢えて二重にしている)。
 */

/**
 * relay が非 2xx を返したときに `statusMessage` に載せる 1 行。
 *
 * relay は `{error}` を返す (401/400/500/503)。読めない形なら status だけの
 * 定型文に倒す — 「保存できたのか分からない」を作らないため、成功以外は必ず
 * 何かしらの理由を出す。
 */
export function describeNetprintTargetsFailure(data: unknown, status: number): string {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : null
  const error = record?.error
  if (typeof error === 'string' && error !== '') return error
  return `通知先の設定に失敗しました (HTTP ${status})`
}
