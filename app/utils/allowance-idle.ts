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
 * **ただし全行を足してはいけない** — 距離を数える行は `DISTANCE_EVENT_NAMES` に限る
 * (重ね掛け行を足すと同じ走行が二重になる。Refs #760 の 7)。
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

/**
 * **`区間距離` を走行距離に数えるイベント名。** この 8 つ以外の行の距離は 0 とみなす。
 *
 * イベントCSV は時間軸を 1 本で刻んだ行 (運転・積み・降し・休憩・休息・アイドリング・
 * 運行開始・運行終了) のほかに、**同じ走行を別の切り口で重ねて持つ行** (状態の重ね掛け:
 * `専用道` / `高速道` / `一般道速度オーバー` / `専用道速度オーバー` / `一般道空車` /
 * `一般道実車` / `連続運転` …) を持つ。重ね掛け行の `区間距離` はタイムライン行と
 * **同じ走行をもう一度**数えたものなので、足すと二重になる (実例: `運転 22:29→0:45
 * 132.7km` と運行全体にまたがる `専用道 23:01→翌9:40 452.9km` が共存し、運転行の合計
 * 478.4 に対して全行Σ 931.3)。
 *
 * **KUDGURI.csv の `総走行距離` (= 運行一覧 API の `total_distance`) と一致するのは
 * この 8 つの和** — 2026-07 帯広5台 90 運行で全件ぴったり (0.05km 以内) 一致を実証。
 * 全行Σは 101,891km だったが、この 8 つの和 = KUDGURI = 57,350km (Refs #760 の 7)。
 *
 * **新しいイベント名が増えたら既定で「数えない」側に落ちる**ので、画面側は
 * `totalKm` と `total_distance` のずれで検出する (`margin.vue`)。
 */
export const DISTANCE_EVENT_NAMES: readonly string[] = [
  '運転',
  '積み',
  '降し',
  '休憩',
  '休息',
  'アイドリング',
  OPERATION_START_EVENT,
  OPERATION_END_EVENT,
]

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
  /**
   * 運行の走行距離 (km) = **`DISTANCE_EVENT_NAMES` の行**の `区間距離` の合計。
   * KUDGURI の `総走行距離` (運行一覧の `total_distance`) と一致する値。
   */
  totalKm: number
  /**
   * **数えなかった行** (`DISTANCE_EVENT_NAMES` に無いイベント名) の Σ`区間距離` (km)。
   *
   * `totalKm` にも内訳にも `legKm` にも入れていない。画面で「重ね掛け N km を除外」と
   * 検算できるようにするためだけに出す (`totalKm + overlayKm` = 旧来の全行Σ)。
   * **`区間距離` の列が無い CSV では 0。**
   */
  overlayKm: number
  // --- `totalKm` の内訳。**5 つを足すと `totalKm` に一致する** (丸めない)。---
  // 時間側 (`preLoadSec` 等) と同じ切り方で距離を数えたもの。按分の分子 (`totalKm`)
  // の中身を人が読めるようにするために出す (Refs #760)。**`区間距離` の列が無い CSV
  // では 5 つとも 0** (`totalKm` も 0 になるのと整合)。
  /** 運行開始 → 最初の積みの行の手前 の Σ区間距離 (km)。積み残しの降しもここ。 */
  preLoadKm: number
  /** 積みの行 → その便の最後の降しの行 の Σ区間距離 (km) = **売上が立つ走行**。`legKm` の和。 */
  haulKm: number
  /** 便の最後の降しの次 → 次の積みの手前 の Σ区間距離 (km)。 */
  betweenKm: number
  /** 最後の便の最後の降しの次 → 末尾 の Σ区間距離 (km)。 */
  postUnloadKm: number
  /**
   * **どの区間とも呼べない走行 (km)。** 内訳を足して `totalKm` に合わせるための受け皿。
   *
   * - 降しが 1 つも無い便 (積んだまま帰庫した便) の 積み → 次の積みの手前
   * - `積み` が 1 行も無い運行の走行ぜんぶ
   */
  otherKm: number
  /**
   * 便ごとの走行距離 (km)。**便の数え方は `haulSec` と同じ**で、降しが無い便も 0 を
   * 置いて間引かない (`extractAllowanceLegs` が返す便と**同じ順・同じ本数**)。
   *
   * **`区間距離` の列が無い CSV では空配列**。「全便が 0km 走った」と
   * 「距離が分からない」を呼び出し側が区別できるようにする。
   */
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
  /**
   * **その便の最後の降しの行より後**の Σ`区間距離` (降しがまだ無ければ積みの行から)。
   *
   * 引き算 (`runningKm - unloadKm`) で出さない — 行の順に足した値でないと
   * 内訳の合計が `totalKm` と 1 ビットずれる。
   */
  tailKm: number
  /** その便に降しの行が 1 つでもあったか。**時刻が読めない降しも数える** (`unloadTs` は null になる)。 */
  hasUnload: boolean
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
    overlayKm: 0,
    preLoadKm: 0,
    haulKm: 0,
    betweenKm: 0,
    postUnloadKm: 0,
    otherKm: 0,
    legKm: [],
  }
}

/**
 * イベントCSV の行から 1 運行の非売上時間と走行距離を出す。
 *
 * - 必要な列 (`イベント名` / `開始日時` / `終了日時`) が無い CSV は**全部 null / 0**
 *   を返す。推測しない (`extractAllowanceLegs` が空配列を返すのと同じ方針)。
 *   `区間距離` は必須ではなく、**無ければ距離だけ 0 / `legKm` は空配列**で時間は出す
 * - 時刻が読めない区間は**その区間だけ** null / 加算しない。運行まるごとは捨てない
 * - **負の秒は 0 に丸めない。** イベントの順序が壊れている運行を黙って正常に見せると、
 *   呼び出し側が気づけなくなる
 * - `運行開始` / `運行終了` が複数ある運行は、**最初の `運行開始` と最後の `運行終了`**
 * - 降しが 1 つも無い便も `legKm` に **0 を置く** (便の本数を揃える。間引かない)
 * - **距離は `DISTANCE_EVENT_NAMES` の行だけ数える。** 重ね掛け行 (速度オーバー・
 *   専用道・一般道空車/実車・連続運転 …) の `区間距離` は **ここ 1 か所で 0 に倒す**ので、
 *   `totalKm` / `legKm` / 内訳 (`preLoadKm` 等) が別々の判定を持たずに同時に揃う。
 *   数えなかったぶんは `overlayKm` に別建てで出す。**時間側はイベント名で絞らない**
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
  let overlayKm = 0
  /** 最初の積みより前の Σ`区間距離`。積みが 1 行も無ければ運行ぜんぶ。 */
  let preRollKm = 0
  const legs: IdleLeg[] = []

  for (const row of rows) {
    const name = cellAt(row, nameIdx).trim()
    // **重ね掛け行の距離はここで 0 に倒す** — 以降の `km` はぜんぶこの値を使うので、
    // 合計・便ごと・内訳のどれにも重ね掛け行は入らない (判定はこの 1 行だけ)。
    const rowKm = kmAt(row, distIdx)
    let km = 0
    if (DISTANCE_EVENT_NAMES.includes(name)) km = rowKm
    else overlayKm += rowKm
    totalKm += km
    const category = classifyTimeCategory(name)

    if (category === 'loading') {
      // 積み は便の頭。距離はここから数え直す (前の便には足さない)。
      legs.push({
        loadTs: parseEventDatetimeToTs(cellAt(row, startIdx)),
        unloadTs: null,
        runningKm: km,
        unloadKm: 0,
        tailKm: km,
        hasUnload: false,
      })
      continue
    }

    // 積みより後の行は、その便が走った距離として積む。
    const current = legs[legs.length - 1]
    if (current) {
      current.runningKm += km
      current.tailKm += km
    }
    // 最初の積みより前 (運行開始・積み残しの降し) の走行。どの便にも属さない。
    else preRollKm += km

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
    current.hasUnload = true
    // ここまでが売上走行。以降は「次の積みまで」か「終業まで」に付け替える。
    current.tailKm = 0
  }

  let betweenSec = 0
  let haulSec = 0
  let haulKm = 0
  let betweenKm = 0
  let postUnloadKm = 0
  let otherKm = 0
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!
    if (leg.loadTs !== null && leg.unloadTs !== null) haulSec += leg.unloadTs - leg.loadTs
    const prev = legs[i - 1]
    // 積みが連続した便 (前の便に降しが無い) は「便と便の間」に数えない。
    if (prev && prev.unloadTs !== null && leg.loadTs !== null) betweenSec += leg.loadTs - prev.unloadTs
    // 距離は**時刻が読めたかに関わらず**数える (`legKm` と同じ規則)。
    haulKm += leg.unloadKm
    // 降しが 1 つも無い便は、積み以降がまるごと分類不能 (`unloadKm` は 0 なので二重に数えない)。
    if (!leg.hasUnload) otherKm += leg.tailKm
    // 降しの後に次の便があれば便間、無ければ 降し→終業。
    else if (i < legs.length - 1) betweenKm += leg.tailKm
    else postUnloadKm += leg.tailKm
  }

  let preLoadKm = preRollKm
  if (legs.length === 0) {
    // 積みが 1 行も無い運行に「始業 → 積み」は無い。走ったぶんは分類不能に寄せる。
    otherKm += preRollKm
    preLoadKm = 0
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
    overlayKm,
    preLoadKm,
    haulKm,
    betweenKm,
    postUnloadKm,
    otherKm,
    // 距離の列そのものが無い CSV は空配列。「全便 0km」と混同させない。
    legKm: distIdx < 0 ? [] : legs.map(leg => leg.unloadKm),
  }
}
