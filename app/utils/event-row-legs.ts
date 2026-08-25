/**
 * イベント表 (`EventCrewPanel` の「イベント」タブ) の **便** 列 (pure、Refs #868)。
 *
 * ```
 * 運行開始 ─ 回送 ─ 積み ══ 売上区間 ══ 降し ─ 回送 ─ 積み ══ 売上区間 ══ 降し ─ 帰庫 ─ 運行終了
 *           └──────── 便 1 ────────┘        └──────────── 便 2 ────────────┘
 * ```
 *
 * **割り当ての規則をここで新しく作らない。** 粗利の按分 (`allowance-idle.ts` の
 * `extractOperationIdle` → `LegKmDetail`) が**すでに全行を便へ割り当てている**ので、
 * この列はその結果を描くだけにする。別の規則を作ると**画面の「便」とお金の「便」が
 * 違う意味になる**。同じ規則を GPS 経路側で先に写したのが
 * `operation-route-map.ts` の `buildOperationRoute` (`kind` / `legSeq`) で、ここは
 * その 3 つ目の写しになる:
 *
 * | 区分 | 規則 (`LegKmDetail` の doc より) |
 * |---|---|
 * | `haul` (売上区間、`haulKm`/`haulSec`) | 積みの行 → **その便の最後の降しの行** |
 * | `approach` (回送・往、`approachKm`) | 1 便目 = 先頭 → 積みの手前 / 2 便目以降 = 前の便の最後の降しの次 → 積みの手前 |
 * | `tail` (帰庫、`tailKm`) | **最後の便だけ** — 最後の降しの次 → 末尾 |
 * | `other` (`otherKm`) | **降しの無い便**の 積み → 次の積みの手前。その便自身に乗る |
 *
 * **判定は行の順だけで決まる** (`extractOperationIdle` が行を順に舐めて距離を積むのと
 * 同じ)。**時刻は一切見ない** — 時刻が読めない行でも便は決まる。
 *
 * **便が 1 本 (積みが 1 行) でもあれば、全行がどれかの便に入る** (証明は
 * `assignRowsToLegs` の実装コメント)。よって「便に入らない行」が出るのは
 *
 * - `noLeg` … **積みが 1 行も無い運行** (`extractOperationIdle` が `otherKm` に寄せる側)
 * - `unknown` … **`イベント名` の列が無い CSV** (推測しない。他の pure 関数と同じ方針)
 *
 * の 2 つだけで、**どちらも空欄にせず語で出す**。空欄にすると「まだ判定していない」と
 * 「割り当てられない」が同じ見た目になる。
 *
 * **重ね掛け行も落とさずに位置で分類する。** `extractOperationIdle` が全行を順に舐めるのと
 * 揃えるため (重ね掛け行の距離はあちらが 0 に倒す)。
 *
 * **★ 「重ね掛け行はイベントタブに出ない」は正しくない** (2026-08-25 に `classifyEventName`
 * を実際に通して確認)。`filterRowsByCategory` が別タブへ送るのは **速度オーバー / 一般道空車・
 * 実車 / 専用道 / 高速道 / アイドリング だけ**で、**`連続運転` `急加速` `急減速` `急カーブ` は
 * `event` に落ちてイベントタブに並ぶ**。しかも `連続運転` は 252.9km / 288分 を持つので
 * `dropIgnoredRows` でも落ちない (`dropIgnoredRows` の doc 参照)。
 *
 * ⇒ **`buildOperationRoute` の 1 回目の走査は流用できない。** あちらは
 * `DISTANCE_EVENT_NAMES` の 8 種だけを `timeline` に残すので、`連続運転` の行が
 * 落ちて便が付かない。ここは全行を対象にする (`extractOperationIdle` と同じ範囲)。
 */
import { colIndex, classifyTimeCategory } from './event-data-table'

/**
 * 行 1 つの区分。`haul` / `approach` / `tail` / `other` は `LegKmDetail` の同名フィールドと
 * 同じ意味 (`legSeq` は 1 始まりで `LegKmDetail` の index + 1)。
 */
export type EventRowLegKind = 'haul' | 'approach' | 'tail' | 'other' | 'noLeg' | 'unknown'

export interface EventRowLeg {
  /** 属する便 (1 始まり)。`noLeg` / `unknown` は null。 */
  legSeq: number | null
  kind: EventRowLegKind
}

/** 積みが 1 行も無い運行の行 (どの便にも属さない)。 */
export const NO_LEG_ROW: Readonly<EventRowLeg> = Object.freeze({ legSeq: null, kind: 'noLeg' })

/** 判定に要る列が無い / 対象の行が見つからない。**「便が無い」とは別物**。 */
export const UNKNOWN_LEG_ROW: Readonly<EventRowLeg> = Object.freeze({ legSeq: null, kind: 'unknown' })

/** 便 1 本ぶんの行位置 (`allowance-idle.ts` の `IdleLeg` / `operation-route-map.ts` の `LegRows` と同じ数え方)。 */
interface LegRows {
  /** 積みの行 index。 */
  loadAt: number
  /** その便の**最後の**降しの行 index。降しが 1 つも無ければ null。 */
  lastUnloadAt: number | null
}

/**
 * `rows` の各行がどの便のどの区分かを、**`rows` と同じ順・同じ本数**で返す。
 *
 * `rows` には**お金と同じ配列** (`csv.rows` = 運行 1 本の CSV 全行) を渡すこと。
 * 乗務員タブやカテゴリタブで絞った後の配列を渡すと、絞られた側に積みがある運行で
 * 便番号がお金とずれる (KUDGIVT.csv は 1 運行分の**全乗務員**の行を持つ)。
 */
export function assignRowsToLegs(headers: string[], rows: string[][]): EventRowLeg[] {
  const nameIdx = colIndex(headers, 'イベント名')
  if (nameIdx < 0) return rows.map(() => UNKNOWN_LEG_ROW)

  // --- 1 回目: 便の位置を確定する (積み = 便の頭 / 最初の積みより前の降しは前の運行の
  //     積み残しなので、属する便が無い = 捨てる)。
  const legs: LegRows[] = []
  for (let i = 0; i < rows.length; i++) {
    const category = classifyTimeCategory(rows[i]![nameIdx] ?? '')
    if (category === 'loading') {
      legs.push({ loadAt: i, lastUnloadAt: null })
      continue
    }
    const current = legs[legs.length - 1]
    if (category === 'unloading' && current) current.lastUnloadAt = i
  }
  if (legs.length === 0) return rows.map(() => NO_LEG_ROW)

  // --- 2 回目: 行ごとの区分。**この 4 本の for で [0, rows.length) が漏れなく埋まる**:
  //     先頭〜1 便目の積みの手前 = 1 便目の approach / 便 i の 積み〜最後の降し = haul /
  //     その次〜次の便の積みの手前 = 次の便の approach (最後の便なら tail) /
  //     降しの無い便は 積み〜次の便の積みの手前が other (次の便の approach は空になる)。
  const out: EventRowLeg[] = new Array<EventRowLeg>(rows.length).fill(UNKNOWN_LEG_ROW)
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!
    const seq = i + 1
    const prev = legs[i - 1]
    const next = legs[i + 1]
    const end = next ? next.loadAt : rows.length
    // その便へ向かう回送: 1 便目は先頭から、2 便目以降は直前の便の最後の降しの次から。
    // **直前の便に降しが無ければ、その走行は直前の便の `other` に乗せたまま**付け替えない
    // (`LegKmDetail.approachKm` が `prev.hasUnload ? prev.tailKm : 0` なのと同じ判定)。
    const approachFrom = prev ? (prev.lastUnloadAt === null ? leg.loadAt : prev.lastUnloadAt + 1) : 0
    for (let r = approachFrom; r < leg.loadAt; r++) out[r] = { legSeq: seq, kind: 'approach' }
    if (leg.lastUnloadAt === null) {
      for (let r = leg.loadAt; r < end; r++) out[r] = { legSeq: seq, kind: 'other' }
      continue
    }
    for (let r = leg.loadAt; r <= leg.lastUnloadAt; r++) out[r] = { legSeq: seq, kind: 'haul' }
    // 降しの後 → 次の積みの手前 は次の便の approach として上で塗られるので、
    // ここでは**最後の便の帰庫**だけ塗る (`tailKm` が最後の便にしか乗らないのと同じ)。
    if (!next) for (let r = leg.lastUnloadAt + 1; r < end; r++) out[r] = { legSeq: seq, kind: 'tail' }
  }
  return out
}

/**
 * `rows` (お金と同じ配列) の**行オブジェクトそのもの**を key にした引き当て表。
 *
 * `dropIgnoredRows` / `groupByCrewRole` / `filterRowsByCategory` はどれも `filter` /
 * `push` で**同じ行オブジェクトを持ち回る**ので、3 段絞った後の行からでも元の行の
 * 割り当てを引ける (`tests/utils/event-row-legs.test.ts` でこの性質自体を固定してある)。
 * **index で持たない**のは、絞るたびに index がずれるため
 * (`EventCrewPanel` の「filteredRows の並びが変わると選択 index がずれる」と同じ罠)。
 *
 * **呼び出し側は Vue の reactive proxy を剥がしてから渡すこと** (`toRaw`)。引く側も
 * 同じく剥がす。proxy と raw が混ざると全行が引けなくなるが、**その時は黙って別の
 * 便番号が付くのではなく「判定不能 N 件」と画面が言う** (`countUnassigned`)。
 */
export function rowLegLookup(headers: string[], rows: string[][]): Map<string[], EventRowLeg> {
  const assigned = assignRowsToLegs(headers, rows)
  const map = new Map<string[], EventRowLeg>()
  rows.forEach((row, i) => map.set(row, assigned[i]!))
  return map
}

export interface UnassignedCounts {
  /** 積みが 1 行も無い運行の行 (属する便が無い、という**確定した答え**)。 */
  noLeg: number
  /** 便を**判定できなかった**行。`イベント名` の列が無い CSV か、引き当て表に無い行。 */
  unknown: number
}

export function countUnassigned(legs: Iterable<EventRowLeg>): UnassignedCounts {
  const counts: UnassignedCounts = { noLeg: 0, unknown: 0 }
  for (const leg of legs) {
    if (leg.kind === 'noLeg') counts.noLeg++
    else if (leg.kind === 'unknown') counts.unknown++
  }
  return counts
}

/**
 * 便が付かなかった行の**件数を画面に言わせる**ための 1 行 (無ければ null)。
 *
 * **「判定できなかった」を黙らせないための検知器**でもある。引き当て表と表示行の
 * 行オブジェクトが食い違えば**全行が `unknown` に倒れる**ので、誤った便番号が静かに
 * 出るのではなく、件数として画面に出る。
 */
export function unassignedNotice(counts: UnassignedCounts): string | null {
  const parts: string[] = []
  if (counts.unknown > 0) parts.push(`便を判定できなかった行 ${counts.unknown} 件`)
  if (counts.noLeg > 0) parts.push(`積みが 1 行も無いため便に属さない行 ${counts.noLeg} 件`)
  return parts.length === 0 ? null : parts.join(' / ')
}

/**
 * 便の色。**既存の 4 色 (緑=積み / 黄=降し / 紫=休息 / 青緑=休憩、`eventCellStyleMap`) を
 * 使わない**ので、青・橙・桃・藍・赤 で回す。**便が多い運行では色が一周する**が、
 * ラベルに必ず便番号が入るので読み分けられる (色だけに情報を載せない)。
 */
export const LEG_COLOR_COUNT = 5

/** 売上区間 (`haul`) のセル。**塗りつぶし**で「この便の売上が立つ行」を強く出す。 */
const HAUL_CLASSES: readonly string[] = [
  'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-medium',
  'bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300 font-medium',
  'bg-pink-100 dark:bg-pink-900/50 text-pink-700 dark:text-pink-300 font-medium',
  'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 font-medium',
  'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 font-medium',
]

/**
 * 回送 (`approach` / `tail`) と分類不能 (`other`) のセル = **同じ色の薄い版**。
 * 塗りつぶさず文字色だけにする (選択行の `bg-blue-50` と重ならないようにするためでもある)。
 */
const DEADHEAD_CLASSES: readonly string[] = [
  'text-blue-600 dark:text-blue-400',
  'text-orange-600 dark:text-orange-400',
  'text-pink-600 dark:text-pink-400',
  'text-indigo-600 dark:text-indigo-400',
  'text-red-600 dark:text-red-400',
]

/** 便に入らない行 (`noLeg` / `unknown`)。色を持たせない。 */
const UNASSIGNED_CLASS = 'text-gray-400 dark:text-gray-500'

export function legCellClass(leg: EventRowLeg): string {
  if (leg.legSeq === null) return UNASSIGNED_CLASS
  const i = (leg.legSeq - 1) % LEG_COLOR_COUNT
  return (leg.kind === 'haul' ? HAUL_CLASSES : DEADHEAD_CLASSES)[i]!
}

/**
 * セルの文字。**色だけに頼らない** — 印刷・色覚の条件で色が落ちても
 * 売上区間 (`便2`) と回送 (`便2 回送` / `便2 帰庫`) が読み分けられるようにする。
 */
export function legLabel(leg: EventRowLeg): string {
  switch (leg.kind) {
    case 'haul': return `便${leg.legSeq}`
    case 'approach': return `便${leg.legSeq} 回送`
    case 'tail': return `便${leg.legSeq} 帰庫`
    case 'other': return `便${leg.legSeq} 区分なし`
    case 'noLeg': return '便なし'
    default: return '判定不能'
  }
}

/** セルの `title` (ホバー)。ラベルが短いぶんの説明をここに置く。 */
export function legTitle(leg: EventRowLeg): string {
  switch (leg.kind) {
    case 'haul': return `便${leg.legSeq} の売上区間 (積み開始 → その便の最後の降し終了)`
    case 'approach': return `便${leg.legSeq} へ向かう回送 (運行開始 / 前の便の降し終了 → 積み開始)`
    case 'tail': return `便${leg.legSeq} の帰庫 (最後の降し終了 → 運行終了)`
    case 'other': return `便${leg.legSeq} の走行。降しが無い便なのでどの区分にも入らない`
    case 'noLeg': return 'この運行には積みが 1 行も無いため、属する便がない'
    default: return 'イベント名の列が無いため判定できない'
  }
}
