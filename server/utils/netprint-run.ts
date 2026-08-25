/**
 * `POST /api/netprint/run` (Refs #874 の 5) の body 検証と、relay の失敗応答を
 * 1 行にまとめる部分 (pure)。`server/api/netprint/run.post.ts` が使う。
 *
 * body は relay の `POST /kintai-relay/netprint-run` と同じ
 * `{date?, branch_cd?, channel_id?, branch_name?, comp_id?}` を素通しする。**relay 側にも
 * 同じガードがあるが、front でも持つ** — `branch_cd` と `channel_id` は「両方揃っているか、
 * 両方無いか」で、片方だけを黙って補完すると**設定側の target と混ざって意図しない
 * トークルームへ送りうる**。誤配は取り消せないので二重に弾く (relay の
 * `planNetprintRun` の doc と同じ理由)。
 *
 * 型 (`NetprintRunInput`) は画面と共有する `~/utils/netprint-run` が持つ
 * (`server/utils/net780-archive.ts` と同じ向き)。
 */

import { NETPRINT_DATE_RE, type NetprintRunInput } from '~/utils/netprint-run'

/** 素通しする body のキー。全部 optional な文字列。 */
const BODY_KEYS = ['date', 'branch_cd', 'channel_id', 'branch_name', 'comp_id'] as const

export type NetprintRunBodyParse
  = { ok: true, body: NetprintRunInput }
    | { ok: false, error: string }

/** `YYYY-MM-DD` で、かつ実在する日付か (`2026-02-31` を relay まで運ばない)。 */
export function isValidNetprintDate(value: string): boolean {
  if (!NETPRINT_DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  // 範囲外は必ず別の月へ繰り上がる (13 月 → 翌年 1 月 / 2 月 31 日 → 3 月 /
  // 0 日 → 前月末) ので、月の一致だけで日まで含めて判定できる。日の一致は
  // 追加で見ても常に真になる (= 死んだ分岐) ので置かない。
  return new Date(Date.UTC(year, month - 1, day)).getUTCMonth() === month - 1
}

/**
 * body を検証して relay に渡す形にする。失敗は `{ ok: false, error }`
 * (呼び出し側が 400 のメッセージにそのまま使う)。空文字のキーは**送らない**
 * (relay 側で「指定あり」と読まれないように)。
 */
export function parseNetprintRunBody(body: unknown): NetprintRunBodyParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body は JSON オブジェクト ({} でも可) で指定してください' }
  }
  const record = body as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const key of BODY_KEYS) {
    const raw = record[key]
    if (raw === undefined || raw === null) {
      fields[key] = ''
      continue
    }
    if (typeof raw !== 'string') {
      return { ok: false, error: `${key} は文字列で指定してください` }
    }
    fields[key] = raw.trim()
  }

  const date = fields.date!
  if (date !== '' && !isValidNetprintDate(date)) {
    return { ok: false, error: 'date は YYYY-MM-DD (実在する日付) で指定してください' }
  }
  const branchCd = fields.branch_cd!
  const channelId = fields.channel_id!
  if ((branchCd === '') !== (channelId === '')) {
    return { ok: false, error: 'branch_cd と channel_id は両方まとめて指定してください (片方だけだと意図しないトークルームへ送りうるため)' }
  }
  if (fields.branch_name !== '' && branchCd === '') {
    return { ok: false, error: 'branch_name だけの指定はできません (branch_cd / channel_id と一緒に指定してください)' }
  }

  const out: NetprintRunInput = {}
  for (const key of BODY_KEYS) {
    if (fields[key] !== '') out[key] = fields[key]
  }
  return { ok: true, body: out }
}

/**
 * relay が非 2xx を返したときに `statusMessage` に載せる 1 行。
 *
 * relay は **`{error}` を返す場合** (401/400/503) と、**target ごとの結果を持ったまま
 * 502 を返す場合** (`{ok: false, date, results}`) がある。後者を「HTTP 502」だけに
 * 潰すと、どの営業所がなぜ失敗したのかが画面から消える — 件数を数えて出し、
 * 内訳は `createError` の `data` (relay の応答そのもの) に載せる。
 */
export function describeNetprintRunFailure(data: unknown, status: number): string {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : null
  const error = record?.error
  if (typeof error === 'string' && error !== '') return error
  const results = record?.results
  if (Array.isArray(results) && results.length > 0) {
    const failed = results.filter(item => (item as { ok?: unknown } | null)?.ok !== true)
    return `${results.length} 件中 ${failed.length} 件の営業所が失敗しました (HTTP ${status})`
  }
  return `日報 netprint の実行に失敗しました (HTTP ${status})`
}
