/**
 * 乗務員未登録 (乗務員CD=0) のまま走った運行の警告 (Refs ippoan/alc-app#676)。
 * 運行一覧 (`/operations`) の上の警告帯が使う。
 *
 * theearth は乗務員を登録しないまま走った運行を「対象乗務員CD=0・名前が空」で出す。
 * alc はそれを乗務員CD "0" の社員 1 名として取り込むので、一覧 API の `driver_cd=0` で絞れる。
 *
 * - 1 運行ずつ見て、総走行距離が {@link DRIVER0_MIN_DISTANCE_KM} km 以上のものだけを出す
 *   (10km 未満は構内の移動などで、警告にしない。ユーザー判断)
 * - 期間は**読取日**で直近 {@link DRIVER0_WINDOW_DAYS} 日 (今日を含む)
 * - 始業・終業は**出庫・帰庫** (`garage_out_at` / `garage_in_at`、KUDGURI の 出庫日時 / 帰庫日時)。
 *   一覧には時刻が無いので、該当の運行だけ 1 件ずつ詳細を引く
 *
 * LINE WORKS 側 (前日の読取日の分を毎朝 1 通) は relay の `driver0-alert.ts`。
 */

import type { Operation, OperationFilter, OperationListItem, OperationsResponse } from '~/types'

/** 乗務員未登録の運行に付く乗務員CD。 */
export const DRIVER0_CD = '0'
/** これ未満の距離 (km) の運行は警告しない。 */
export const DRIVER0_MIN_DISTANCE_KM = 10
/** 警告帯が見る期間 (読取日、今日を含む日数)。 */
export const DRIVER0_WINDOW_DAYS = 30
/** 一覧を引く 1 ページの件数 (alc の上限が 200)。 */
export const DRIVER0_PER_PAGE = 200

const DAY_MS = 24 * 60 * 60 * 1000
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

export interface Driver0Alert {
  unko_no: string
  vehicle_name: string | null
  /** 出庫日時。値の末尾に Z が付くが中身は日本時間 ({@link formatWallClock})。 */
  garage_out_at: string | null
  /** 帰庫日時。 */
  garage_in_at: string | null
  total_distance: number
}

export interface Driver0AlertDeps {
  getOperations: (filter: OperationFilter) => Promise<OperationsResponse>
  getOperation: (unkoNo: string) => Promise<Operation[]>
}

/** 直近 {@link DRIVER0_WINDOW_DAYS} 日の読取日の範囲 (JST の今日まで)。 */
export function driver0Window(now: Date): { date_from: string; date_to: string } {
  const today = now.getTime() + JST_OFFSET_MS
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  return { date_from: ymd(today - (DRIVER0_WINDOW_DAYS - 1) * DAY_MS), date_to: ymd(today) }
}

/** 警告に出す運行か (距離が分からない運行は出さない)。 */
export function isDriver0AlertDistance(op: Pick<OperationListItem, 'total_distance'>): boolean {
  return op.total_distance != null && op.total_distance >= DRIVER0_MIN_DISTANCE_KM
}

/**
 * alc の日時 (`2026-11-27T08:15:00Z` の形) を `2026/11/27 08:15` にする。
 * **末尾の Z は付いているが中身は日本時間の壁時計**なので、時差を足さずに文字列のまま並べ替える。
 * 無い・形が違うときは `-`。
 */
export function formatWallClock(value: string | null): string {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value) : null
  if (!m) return '-'
  return `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}`
}

/**
 * 直近 {@link DRIVER0_WINDOW_DAYS} 日の、乗務員未登録で {@link DRIVER0_MIN_DISTANCE_KM} km 以上走った運行。
 * 一覧を全ページ引き (2 マン運行は乗務の役ごとに行があるので運行NO で 1 つにする)、該当の運行だけ詳細を引いて
 * 出庫・帰庫を足す。どれかの取得が失敗したら throw する (呼び手が「確かめられなかった」と出す)。
 */
export async function loadDriver0Alerts(deps: Driver0AlertDeps, now: Date): Promise<Driver0Alert[]> {
  const window = driver0Window(now)
  const picked = new Map<string, OperationListItem>()
  for (let page = 1; ; page++) {
    const res = await deps.getOperations({
      ...window,
      driver_cd: DRIVER0_CD,
      page,
      per_page: DRIVER0_PER_PAGE,
    })
    for (const op of res.operations) {
      if (isDriver0AlertDistance(op) && !picked.has(op.unko_no)) picked.set(op.unko_no, op)
    }
    if (res.operations.length === 0 || page * DRIVER0_PER_PAGE >= res.total) break
  }
  return Promise.all(
    [...picked.values()].map(async (op): Promise<Driver0Alert> => {
      const rows = await deps.getOperation(op.unko_no)
      return {
        unko_no: op.unko_no,
        vehicle_name: op.vehicle_name,
        garage_out_at: rows.find(r => r.garage_out_at)?.garage_out_at ?? null,
        garage_in_at: rows.find(r => r.garage_in_at)?.garage_in_at ?? null,
        total_distance: op.total_distance!,
      }
    }),
  )
}
