/**
 * 一番星マッチ率検証結果の R2 永続化 (Refs #330 PR3)。
 *
 * ProfitPanel で確認 (チェック) した伝票の一覧を「検証スナップショット」として
 * R2 に保存し、リロードで確認状態が消えないようにする。バージョン管理は
 * workers/dtako-scraper-relay/src/theearth-restraint-client.ts の
 * restraintR2Paths/restraintVersionTimestamp/appendHistoryJsonl と同じ設計
 * (latest + v-{ts} + history.jsonl、sha256差分検知) を踏襲するが、7日pruneは
 * 採用しない (低頻度手動保存で肥大化リスクが小さく、監査証跡としての価値を優先)。
 *
 * IO (R2 read/write) はこのファイルには置かない。Nitro server route からしか
 * R2 binding にアクセスできないため、`server/utils/profit-r2-io.ts` に分離する。
 */
import { epochToYmd } from './ichiban'
import type { LocationMatchLevel, ProfitEfficiency, ScoredVehicleDailySlip, VehicleDailySlip } from './ichiban'
import type { SelectedRowsLocationRange, SelectedRowsSummary } from './event-data-table'

// --- キー設計 ---

export interface ProfitR2Paths {
  dir: string
  latest: string
  version(ts: string): string
  history: string
}

/**
 * `profit/{ym}/{vehicleCode}/{unkoNo}/{segmentId}/` 配下にスナップショットを置く。
 * 月次集計 (PR4) は `list({prefix: "profit/{ym}/{vehicleCode}/"})` で全件回収する。
 */
export function profitR2Paths(ym: string, vehicleCode: string, unkoNo: string, segmentId: string): ProfitR2Paths {
  const dir = `profit/${ym}/${vehicleCode}/${unkoNo}/${segmentId}`
  return {
    dir,
    latest: `${dir}/latest.json`,
    version: ts => `${dir}/v-${ts}.json`,
    history: `${dir}/history.jsonl`,
  }
}

/** 選択区間の開始/終了 epoch 秒から決定論的なセグメントキーを作る。
 * 同じ区間の再保存は同じキーに載る (SHA-256等のハッシュ不要、値自体が既に一意)。 */
export function segmentId(fromTs: number, toTs: number): string {
  return `${fromTs}-${toTs}`
}

/** 選択区間の開始日時 (JST壁時計) から月キー (YYYY-MM) を算出する。 */
export function profitYm(fromTs: number): string {
  return epochToYmd(fromTs).slice(0, 7)
}

/** R2 の版 suffix 用タイムスタンプ (JST、`YYYYMMDDTHHmmss`)。
 * `restraintVersionTimestamp` (theearth-restraint-client.ts) と同一形式。 */
export function profitVersionTimestamp(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}`
    + `T${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}${p(jst.getUTCSeconds())}`
}

/** 確認履歴 (history.jsonl) の保持行数上限 (直近のみ、肥大化防止)。 */
export const PROFIT_HISTORY_MAX_LINES = 1000

/** JSONL に 1 行追記して直近 maxLines に丸める (R2 は append 不可のため read-modify-write)。
 * `appendHistoryJsonl` (theearth-restraint-client.ts) と同一ロジック。 */
export function appendProfitHistoryJsonl(
  existing: string | null,
  line: string,
  maxLines: number = PROFIT_HISTORY_MAX_LINES,
): string {
  const lines = existing ? existing.split('\n').filter(l => l.trim() !== '') : []
  lines.push(line)
  return lines.slice(-maxLines).join('\n') + '\n'
}

// --- スナップショット JSON shape ---

export interface ProfitSnapshotSlip {
  rowId: string
  saleDate: string
  customerCode: string
  customerName: string
  originAreaName: string
  destAreaName: string
  origin: string
  dest: string
  isSubcontracted: boolean
  amount: number
  itemCode: string
  itemName: string
  quantity: number
  unitPrice: number
  unit: string
  originMatch: LocationMatchLevel
  destMatch: LocationMatchLevel
}

/**
 * 一番星の伝票から複数レグ (往復2回以上、日付をまたぐ等) を提案した際、日付ごとの
 * デジタコ実績 (距離・時間) を ProfitPanel に伝えるための単位 (Refs #356 派生要望:
 * 「日付が違う部分を分けて別々に登録したい」)。`date` は `groupLegsByDate` の
 * `EventLegDateGroup.date` と同じ規約 (YYYY-MM-DD)。ProfitPanel はこれを使って
 * 伝票候補を日付ごとにグループ化し、日付単位で個別に検証結果を保存できるようにする。
 */
export interface ProfitPanelLegGroup {
  date: string
  range: { fromTs: number, toTs: number }
  summary: SelectedRowsSummary
}

export interface ProfitSnapshot {
  schemaVersion: 1
  vehicleCode: string
  unkoNo: string
  segmentId: string
  ym: string
  range: { fromTs: number, toTs: number }
  location: { originCity: string, destCity: string }
  dtakoSummary: SelectedRowsSummary
  confirmedSlips: ProfitSnapshotSlip[]
  confirmedAmount: number
  efficiency: ProfitEfficiency
  savedAt: string
}

/**
 * ProfitPanel の現在の確認状態からスナップショットを組み立てる。
 * `savedAt` だけ呼び出し側 (server route) が実行時刻で埋める — この関数自体は
 * `new Date()` に依存しない pure 関数のままにする (テスト容易性のため)。
 */
export function buildProfitSnapshot(params: {
  vehicleCode: string
  unkoNo: string
  range: { fromTs: number, toTs: number }
  location: SelectedRowsLocationRange | null
  summary: SelectedRowsSummary
  scoredSlips: ScoredVehicleDailySlip[]
  confirmedRowIds: Set<string>
  confirmedAmount: number
  efficiency: ProfitEfficiency
  savedAt: string
}): ProfitSnapshot {
  const confirmedSlips: ProfitSnapshotSlip[] = params.scoredSlips
    .filter(s => params.confirmedRowIds.has(s.slip.rowId))
    .map(s => ({
      rowId: s.slip.rowId,
      saleDate: s.slip.saleDate,
      customerCode: s.slip.customerCode,
      customerName: s.slip.customerName,
      originAreaName: s.slip.originAreaName,
      destAreaName: s.slip.destAreaName,
      origin: s.slip.origin,
      dest: s.slip.dest,
      isSubcontracted: s.slip.isSubcontracted,
      amount: s.slip.amount,
      itemCode: s.slip.itemCode,
      itemName: s.slip.itemName,
      quantity: s.slip.quantity,
      unitPrice: s.slip.unitPrice,
      unit: s.slip.unit,
      originMatch: s.originMatch,
      destMatch: s.destMatch,
    }))

  return {
    schemaVersion: 1,
    vehicleCode: params.vehicleCode,
    unkoNo: params.unkoNo,
    segmentId: segmentId(params.range.fromTs, params.range.toTs),
    ym: profitYm(params.range.fromTs),
    range: params.range,
    location: { originCity: params.location?.originCity ?? '', destCity: params.location?.destCity ?? '' },
    dtakoSummary: params.summary,
    confirmedSlips,
    confirmedAmount: params.confirmedAmount,
    efficiency: params.efficiency,
    savedAt: params.savedAt,
  }
}

// --- 月次検証 (Refs #330 PR4) ---

/**
 * 月キー (YYYY-MM) から vehicle-daily API に渡す半開区間の from/to を算出する。
 * `vehicleDailyDateRange` (選択区間の epoch 秒から算出) とは入力が異なるため別関数にする。
 */
export function monthRange(ym: string): { from: string, to: string } {
  const [yStr, mStr] = ym.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const from = `${yStr}-${mStr}-01`
  const nextY = m === 12 ? y + 1 : y
  const nextM = m === 12 ? 1 : m + 1
  const to = `${nextY}-${String(nextM).padStart(2, '0')}-01`
  return { from, to }
}

export interface MonthlyMatchCounts {
  exact: number
  partial: number
  none: number
}

export interface MonthlySummary {
  /** 一番星側の月計 (vehicle-daily を月全体で合算、月計一致ルール適用済み)。 */
  ichibanTotal: number
  /** 保存済み検証スナップショットの確認済み金額合計。 */
  confirmedTotal: number
  /** ichibanTotal - confirmedTotal (未確認分・誤マッチ等の差異)。 */
  diff: number
  /** 確認済み伝票の積地・卸地マッチレベル内訳 (どちらかが none なら none、両方 exact なら exact、それ以外 partial)。 */
  matchCounts: MonthlyMatchCounts
  /** 集計対象になった検証スナップショット数 (= 確認済み運行区間の数)。 */
  snapshotCount: number
}

/** 積地・卸地の突合レベルを1つに統合する。片方でも none なら根拠なし、両方 exact のみ exact、それ以外 partial。 */
export function combinedMatchLevel(originMatch: LocationMatchLevel, destMatch: LocationMatchLevel): LocationMatchLevel {
  if (originMatch === 'none' || destMatch === 'none') return 'none'
  if (originMatch === 'exact' && destMatch === 'exact') return 'exact'
  return 'partial'
}

/**
 * 車輌+月単位で、一番星側の月計と保存済み検証スナップショットの確認済み金額を
 * 突き合わせる (Task #1: 実データでのマッチ率検証の集計本体)。
 */
export function summarizeMonthly(ichibanRows: VehicleDailySlip[], snapshots: ProfitSnapshot[]): MonthlySummary {
  const ichibanTotal = ichibanRows.reduce((sum, r) => sum + r.amount, 0)
  const confirmedTotal = snapshots.reduce((sum, s) => sum + s.confirmedAmount, 0)
  const matchCounts: MonthlyMatchCounts = { exact: 0, partial: 0, none: 0 }
  for (const snapshot of snapshots) {
    for (const slip of snapshot.confirmedSlips) {
      matchCounts[combinedMatchLevel(slip.originMatch, slip.destMatch)]++
    }
  }
  return {
    ichibanTotal,
    confirmedTotal,
    diff: ichibanTotal - confirmedTotal,
    matchCounts,
    snapshotCount: snapshots.length,
  }
}

// --- 保存済みスナップショット一覧 (Refs #330、「マッチ率よりまず保存したやつから検索したい」要望) ---

export interface SnapshotListItem {
  vehicleCode: string
  unkoNo: string
  segmentId: string
  ym: string
  savedAt: string
  confirmedAmount: number
  slipCount: number
  /** 確認済み伝票の得意先名 (重複除去)。 */
  customerNames: string[]
  /** 確認済み伝票の売上年月日の最小/最大 (区間の目安表示用)。伝票が無ければ空文字。 */
  saleDateFrom: string
  saleDateTo: string
  matchCounts: MonthlyMatchCounts
}

/** 保存済みスナップショット1件を一覧表示用に要約する。 */
export function toSnapshotListItem(snapshot: ProfitSnapshot): SnapshotListItem {
  const customerNames = [...new Set(snapshot.confirmedSlips.map(s => s.customerName).filter(Boolean))]
  const saleDates = snapshot.confirmedSlips.map(s => s.saleDate).filter(Boolean).sort()
  const matchCounts: MonthlyMatchCounts = { exact: 0, partial: 0, none: 0 }
  for (const slip of snapshot.confirmedSlips) {
    matchCounts[combinedMatchLevel(slip.originMatch, slip.destMatch)]++
  }
  return {
    vehicleCode: snapshot.vehicleCode,
    unkoNo: snapshot.unkoNo,
    segmentId: snapshot.segmentId,
    ym: snapshot.ym,
    savedAt: snapshot.savedAt,
    confirmedAmount: snapshot.confirmedAmount,
    slipCount: snapshot.confirmedSlips.length,
    customerNames,
    saleDateFrom: saleDates[0] ?? '',
    saleDateTo: saleDates[saleDates.length - 1] ?? '',
    matchCounts,
  }
}

/** 保存日時 (savedAt、ISO8601文字列) の新しい順に並べる。破壊的変更を避けるため新しい配列を返す。 */
export function sortSnapshotListBySavedAtDesc(items: SnapshotListItem[]): SnapshotListItem[] {
  return [...items].sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}
