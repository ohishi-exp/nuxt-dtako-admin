/**
 * 保存済み検証スナップショットの一覧 (Refs #330)。
 *
 * GET /api/profit/snapshots?ym=&vehicle=&limit= → 車輌・年月を指定しなくても保存済み
 * スナップショットを保存日時の新しい順に一覧表示できるようにする (「マッチ率(月次集計)
 * より先に、まず保存したものから検索したい」というユーザー要望)。
 * **その「マッチ率(月次集計)」の側は #859 で廃止した** — いま `/profit/monthly` に残るのは
 * この一覧だけで、**この口がその画面の中身そのもの**になった。
 *
 * - `ym` を指定すると R2 prefix (`profit/{ym}/`) で絞り込む (効率的)。
 * - `vehicle` は `ym` と同時指定なら prefix (`profit/{ym}/{vehicle}/`) で絞り込めるが、
 *   単独指定の場合は R2 のキー構造上 (`profit/{ym}/{vehicle}/...`) prefix 検索できないため、
 *   全件取得後にメモリ上でフィルタする (現状の保存件数規模では許容範囲)。
 * - どちらも未指定なら `profit/` 配下を全件取得する。
 *
 * **`profit/` 配下の `latest.json` が全部スナップショットだとは限らない** (Refs #850)。
 * 版管理の連載で別種の `latest.json` が同じ prefix の下に増えた
 * (`profit/{ym}/margin-summary/latest.json` #826、`profit/allowance-overrides/{kind}/latest.json`
 * #845)。**キーの形** (`isProfitSnapshotKey`) と**本文の形** (`parseProfitSnapshot`) の
 * 二重で見分ける。
 *
 * **弾いたものと読めなかったものを同じ扱いにしない**:
 * - **形で弾いたもの**は数えない。そもそもスナップショットではないので「欠けている」ではない
 * - **形は合っているのに本文を読めなかったもの**は `unreadable` として数え、**画面に出す**
 *   (`/profit/monthly`)。黙って飛ばすと「この条件では保存が無い」と同じ見た目になる
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'
import { listAllProfit, type R2BucketLite } from '../../utils/profit-r2-io'
import {
  isProfitSnapshotKey,
  parseProfitSnapshot,
  toSnapshotListItem,
  sortSnapshotListBySavedAtDesc,
  type ProfitSnapshot,
  type SnapshotListItem,
  type SnapshotListResult,
} from '~/utils/profit-r2'

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { PROFIT_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.PROFIT_R2 ?? null
}

const DEFAULT_LIMIT = 200

export default defineEventHandler(async (event): Promise<SnapshotListResult> => {
  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const query = getQuery(event)
  const ym = typeof query.ym === 'string' ? query.ym : ''
  const vehicle = typeof query.vehicle === 'string' ? query.vehicle : ''
  const limitParam = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : NaN
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, DEFAULT_LIMIT) : DEFAULT_LIMIT

  const prefix = ym && vehicle ? `profit/${ym}/${vehicle}/` : ym ? `profit/${ym}/` : 'profit/'
  const objects = await listAllProfit(r2, prefix)

  const snapshots: ProfitSnapshot[] = []
  let unreadable = 0
  for (const obj of objects) {
    // 仲間ではないもの (別種の latest.json、v-*.json、history.jsonl) は**数えない**。
    if (!isProfitSnapshotKey(obj.key)) continue
    const body = await r2.get(obj.key)
    // ここから先は「スナップショットのはずのものが読めなかった」= 本当の欠測。
    // list に出たのに get が null なのは削除 race 等。
    if (!body) {
      unreadable++
      continue
    }
    const snapshot = parseProfitSnapshot(await body.text())
    if (!snapshot) {
      unreadable++
      continue
    }
    snapshots.push(snapshot)
  }

  let items: SnapshotListItem[] = snapshots.map(toSnapshotListItem)
  if (vehicle && !ym) {
    items = items.filter(i => i.vehicleCode === vehicle)
  }
  items = sortSnapshotListBySavedAtDesc(items)

  return { items: items.slice(0, limit), total: items.length, unreadable }
})
