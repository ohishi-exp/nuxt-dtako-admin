/**
 * `POST /api/net780/archive` (Refs #760 の 27) の body 検証 (pure)。
 * `server/api/net780/archive.post.ts` が使う。
 *
 * 画面からは **運行NO の配列** (`{ operationNos: string[] }`) だけを受け、relay の
 * `POST /kintai-relay/net780-archive` が要求する `{ ope_no (22桁), start_ope }` は
 * ここで組む — `start_ope` は運行NO の先頭 12 桁から機械的に導ける
 * (`server/utils/operation-zip.ts` の `startOpeFromUnkoNo`、#786 と同じ導出) ので、
 * 画面に出庫日時を持たせない。
 *
 * 上限 (`NET780_ARCHIVE_MAX_ITEMS` = relay の `items` 上限) と型・桁は**ここで弾いて
 * 400** にする。relay に投げて theearth まで往復させてから 400 をもらう理由が無い。
 *
 * 23 桁 (オンプレ由来、末尾が対象乗務員CD) は 22 桁に落とす。2マン運行の `…1` / `…2`
 * は同じ 22 桁になるので **dedupe** する (relay に同じ運行を 2 回検索させない。
 * 上限の判定は dedupe 前の件数で行う — 21 件送ったら 400、が画面から見た契約)。
 */

import { NET780_ARCHIVE_MAX_ITEMS } from '~/utils/net780-archive'
import { opeNo22FromUnkoNo, startOpeFromUnkoNo } from './operation-zip'

/** relay の `items` の要素。 */
export interface Net780ArchiveItem {
  /** 22 桁 */
  ope_no: string
  /** `YYYY/MM/DD H:mm:ss` (時は 0 埋めなし) */
  start_ope: string
}

export type Net780ArchiveBodyParse
  = { ok: true, items: Net780ArchiveItem[] }
    | { ok: false, error: string }

/**
 * body を検証して relay の `items` に変換する。失敗は `{ ok: false, error }`
 * (呼び出し側が 400 のメッセージにそのまま使う)。
 */
export function parseNet780ArchiveBody(body: unknown): Net780ArchiveBodyParse {
  const operationNos = (body as { operationNos?: unknown } | null)?.operationNos
  if (!Array.isArray(operationNos)) {
    return { ok: false, error: 'operationNos (string[]) が必要です' }
  }
  if (operationNos.length === 0) {
    return { ok: false, error: 'operationNos が空です' }
  }
  if (operationNos.length > NET780_ARCHIVE_MAX_ITEMS) {
    return { ok: false, error: `operationNos は 1 回に ${NET780_ARCHIVE_MAX_ITEMS} 件までです (${operationNos.length} 件)` }
  }
  const items: Net780ArchiveItem[] = []
  const seen = new Set<string>()
  for (const raw of operationNos) {
    if (typeof raw !== 'string') {
      return { ok: false, error: 'operationNos は文字列の配列で指定してください' }
    }
    const opeNo = opeNo22FromUnkoNo(raw)
    if (opeNo === null) {
      return { ok: false, error: `運行NO は 22 桁または 23 桁の数値で指定してください (${raw})` }
    }
    const startOpe = startOpeFromUnkoNo(opeNo)
    if (startOpe === null) {
      return { ok: false, error: `運行NO の先頭 12 桁が日時として不正です (${raw})` }
    }
    if (seen.has(opeNo)) continue
    seen.add(opeNo)
    items.push({ ope_no: opeNo, start_ope: startOpe })
  }
  return { ok: true, items }
}
