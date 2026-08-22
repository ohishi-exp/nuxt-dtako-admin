/**
 * デジタコのイベントCSV から、1 運行の**非売上時間**と**走行距離**を出す (pure)。
 *
 * 売上が立つのは **積み → その便の最後の降し** の区間だけで、それ以外は
 * 時間を使っているのに売上が無い:
 *
 * ```
 * 運行開始 ─ preLoad ─ 積み ══ haul ══ 降し ─ between ─ 積み ══ haul ══ 降し ─ postUnload ─ 運行終了
 * └──────────────────────────────── total ────────────────────────────────┘
 * ```
 *
 * 距離も**同じ CSV に入っている** (`KUDGIVT.csv` の `区間距離`。2026-07-27 の運行で確認)。
 * **燃料代 = 走行距離 × 燃費 × 単価**、**運行に直接紐づかない経費の按分は走行距離の比**
 * と決まったので、CSV を 2 回舐めずに済むようここで一緒に出す。
 *
 * 経費を運行ごとに按分する基礎に使う (Refs #760)。**時間側の按分の基準はまだ
 * 決まっていない**ので、ここでは素の値を出すだけで、金額には触らない。
 *
 * 便の切り出しは `allowance-trips.ts` の `extractAllowanceLegs` と同じ規則
 * (積み = 便の頭 / 最初の積みより前の降しは前の運行の積み残しなので捨てる) だが、
 * あちらは卸地の市町村列を要求するのでここでは使わず、時刻・距離列だけで独立に数える。
 * `legKm` は `extractAllowanceLegs` が返す便と**同じ順・同じ本数**になる。
 */
import { colIndex, classifyTimeCategory, parseEventDatetimeToTs } from './event-data-table'

/** 始業・終業は区分ではなくイベント名で決まる (`classifyTimeCategory` では `other`)。 */
const OPERATION_START_EVENT = '運行開始'
const OPERATION_END_EVENT = '運行終了'

export interface OperationIdle {
  /** 運行開始の epoch 秒。読めなければ null。 */
  startTs: number | null
  /** 運行終了の epoch 秒。読めなければ null。 */
  endTs: number | null
  /** 運行開始 → 最初の積みの開始 (秒)。どちらか読めなければ null。 */
  preLoadSec: number | null
  /** 最後の降しの終了 → 運行終了 (秒)。どちらか読めなければ null。 */
  postUnloadSec: number | null
  /** 便と便の間 (前の便の最後の降しの終了 → 次の積みの開始) の合計 (秒)。 */
  betweenSec: number
  /** 積み開始 → その便の最後の降し終了 の合計 (秒) = **売上が立つ時間**。 */
  haulSec: number
  /** 運行全体 (startTs → endTs)。どちらか読めなければ null。 */
  totalSec: number | null
  /** 運行の全イベントの `区間距離` の合計 (km)。 */
  totalKm: number
  /** 便ごとの走行距離 (km)。`extractAllowanceLegs` が返す便と**同じ順・同じ本数**。 */
  legKm: number[]
}

/** 便 = 積み 1 つと、その便の最後の降しまでの時刻・距離。 */
interface IdleLeg {
  /** 積みの `開始日時` (epoch 秒)。読めなければ null。 */
  loadTs: number | null
  /** その便の最後の降しの `終了日時` (epoch 秒)。降しが無い / 読めなければ null。 */
  unloadTs: number | null
  /** 積みの行から現在行までの Σ`区間距離`。 */
  runningKm: number
  /** 積みの行から**その便の最後の降しの行**までの Σ`区間距離`。降しが無ければ 0。 */
  unloadKm: number
}

function cellAt(row: string[], idx: number): string {
  return row[idx] ?? ''
}

/**
 * `区間距離` を km で読む。
 *
 * 列が無い CSV は距離だけ 0 にする (列が 1 つ無いだけで時間まで捨てない)。
 * **数として読めない行は 0。** NaN を一度混ぜると以降の合計が全部 NaN になる。
 */
function kmAt(row: string[], idx: number): number {
  if (idx < 0) return 0
  const km = Number(cellAt(row, idx))
  return Number.isFinite(km) ? km : 0
}

function emptyIdle(): OperationIdle {
  return {
    startTs: null,
    endTs: null,
    preLoadSec: null,
    postUnloadSec: null,
    betweenSec: 0,
    haulSec: 0,
    totalSec: null,
    totalKm: 0,
    legKm: [],
  }
}

/**
 * イベントCSV の行から 1 運行の非売上時間と走行距離を出す。
 *
 * - 必要な列 (`イベント名` / `開始日時` / `終了日時`) が無い CSV は**全部 null / 0**
 *   を返す。推測しない (`extractAllowanceLegs` が空配列を返すのと同じ方針)。
 *   `区間距離` は必須ではなく、**無ければ距離だけ 0** で時間は出す
 * - 時刻が読めない区間は**その区間だけ** null / 加算しない。運行まるごとは捨てない
 * - **負の秒は 0 に丸めない。** イベントの順序が壊れている運行を黙って正常に見せると、
 *   呼び出し側が気づけなくなる
 * - `運行開始` / `運行終了` が複数ある運行は、**最初の `運行開始` と最後の `運行終了`**
 * - 降しが 1 つも無い便も `legKm` に **0 を置く** (便の本数を揃える。間引かない)
 */
export function extractOperationIdle(headers: string[], rows: string[][]): OperationIdle {
  const nameIdx = colIndex(headers, 'イベント名')
  const startIdx = colIndex(headers, '開始日時')
  const endIdx = colIndex(headers, '終了日時')
  const distIdx = colIndex(headers, '区間距離')
  if ([nameIdx, startIdx, endIdx].some(i => i < 0)) return emptyIdle()

  let startTs: number | null = null
  let seenStartEvent = false
  let endTs: number | null = null
  /** 運行の中で**最後**に降ろした時刻。便に属さない (積み残しの) 降しも含む。 */
  let lastUnloadTs: number | null = null
  let totalKm = 0
  const legs: IdleLeg[] = []

  for (const row of rows) {
    const name = cellAt(row, nameIdx).trim()
    const km = kmAt(row, distIdx)
    totalKm += km
    const category = classifyTimeCategory(name)

    if (category === 'loading') {
      // 積み は便の頭。距離はここから数え直す (前の便には足さない)。
      legs.push({
        loadTs: parseEventDatetimeToTs(cellAt(row, startIdx)),
        unloadTs: null,
        runningKm: km,
        unloadKm: 0,
      })
      continue
    }

    // 積みより後の行は、その便が走った距離として積む。
    const current = legs[legs.length - 1]
    if (current) current.runningKm += km

    if (name === OPERATION_START_EVENT) {
      // 最初の 運行開始 を採る。2 つ目以降で上書きしない。
      if (!seenStartEvent) {
        seenStartEvent = true
        startTs = parseEventDatetimeToTs(cellAt(row, startIdx))
      }
      continue
    }
    if (name === OPERATION_END_EVENT) {
      // 最後の 運行終了 を採る。
      endTs = parseEventDatetimeToTs(cellAt(row, endIdx))
      continue
    }
    if (category !== 'unloading') continue
    const unloadTs = parseEventDatetimeToTs(cellAt(row, endIdx))
    lastUnloadTs = unloadTs
    // 最初の積みより前の降し = 前の運行の積み残し。属する便が無いので便には入れない。
    if (!current) continue
    current.unloadTs = unloadTs
    current.unloadKm = current.runningKm
  }

  let betweenSec = 0
  let haulSec = 0
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!
    if (leg.loadTs !== null && leg.unloadTs !== null) haulSec += leg.unloadTs - leg.loadTs
    const prev = legs[i - 1]
    // 積みが連続した便 (前の便に降しが無い) は「便と便の間」に数えない。
    if (prev && prev.unloadTs !== null && leg.loadTs !== null) betweenSec += leg.loadTs - prev.unloadTs
  }

  const firstLoadTs = legs.length > 0 ? legs[0]!.loadTs : null
  return {
    startTs,
    endTs,
    preLoadSec: startTs !== null && firstLoadTs !== null ? firstLoadTs - startTs : null,
    postUnloadSec: endTs !== null && lastUnloadTs !== null ? endTs - lastUnloadTs : null,
    betweenSec,
    haulSec,
    totalSec: startTs !== null && endTs !== null ? endTs - startTs : null,
    totalKm,
    legKm: legs.map(leg => leg.unloadKm),
  }
}
