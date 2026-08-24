/**
 * **収支パネル (`ProfitPanel`) が「どの便に結ぶのか」を決める素材** (pure、Refs #848)。
 *
 * 突合一本化 (#820) の PR-2 で、収支パネルの「確定」は**検証スナップショット
 * (R2、区間ごと) から、①の人の確定 (`allowance-force-match.ts`、便ごと) へ**移った。
 * 単位が **区間 → 便** に変わるので、**選択した区間に入る便**を出すのがこの module。
 *
 * ## ★ 便の鍵は①と同じ関数で作る (作り直さない)
 *
 * 便は `extractAllowanceLegs`(イベントCSV) の**積みイベント 1 つ = 1 便**で、
 * `seq` はその並び順 (`i + 1`)。鍵は `forceMatchKey` (= `excludedKey`) が作る
 * `運行NO#t<積みの開始日時>`。**①(運行手当タブ・粗利タブ)も同じ CSV に同じ関数を
 * 当てている**ので、ここで作った鍵は①が読む鍵と 1 文字も違わない。
 * 独自に `seq` を数え直したり、区間の `fromTs` をそのまま鍵にしたりしないこと —
 * 選択区間の `fromTs` は手動選択なら積みの行ですらない。
 *
 * ## ★ 開始日時が読めない積みは**黙って落とさず数える**
 *
 * 選択区間に入るかどうかは積みの開始日時でしか判定できない。読めない積みは
 * 「入っていない」ではなく「**判定できない**」ので、件数を返して画面に言わせる。
 * 落として黙ると「この区間には便が 1 本しかない」と読めてしまう。
 */
import { forceMatchKey } from './allowance-force-match'
import type { AllowanceLeg } from './allowance-trips'
import { epochToYmd, type ScoredVehicleDailySlip, type VehicleDailySlip } from './ichiban'

/** 収支パネルが結び先として出す便 1 本。 */
export interface ProfitPanelLeg {
  /** 便番号 (①と同じ = 積みの並び順)。 */
  seq: number
  /** `forceMatchKey` の値。**保存の鍵はこれだけ。** */
  key: string
  /** 積みの日 (`YYYY-MM-DD`)。候補の日付 ±1 日を測る基準になる。 */
  date: string
  /** 積みの `開始市町村名` (実体は住所)。**候補の並べ替えに使う。** */
  originCity: string
  /** 最初の降しの `終了市町村名`。**空なら卸地が取れていない便** (結ぶと決まる)。 */
  destCity: string
}

/** `legsInSelection` の返り値。 */
export interface LegSelection {
  /** 選択区間に積みが入っている便 (`seq` の昇順)。 */
  legs: ProfitPanelLeg[]
  /** **積みの開始日時が読めず、区間に入るか判定できなかった**便の数。 */
  undated: number
}

/**
 * 選択したイベント区間に**積みが入っている便**を出す (Refs #848)。
 *
 * 区間の端は**両端を含む** — 提案 (`proposeEventRowRange`) は積みの `開始日時` を
 * そのまま `fromTs` にするので、含めないとその便自身が落ちる。
 */
export function legsInSelection(
  unkoNo: string,
  legs: readonly AllowanceLeg[],
  range: { fromTs: number, toTs: number } | null,
): LegSelection {
  if (range === null) return { legs: [], undated: 0 }
  const out: ProfitPanelLeg[] = []
  let undated = 0
  legs.forEach((leg, i) => {
    if (leg.fromTs === null) {
      undated++
      return
    }
    if (leg.fromTs < range.fromTs || leg.fromTs > range.toTs) return
    const seq = i + 1
    out.push({
      seq,
      key: forceMatchKey({ unkoNo, seq, fromTs: leg.fromTs }),
      date: epochToYmd(leg.fromTs),
      originCity: leg.originCity,
      destCity: leg.destCity,
    })
  })
  return { legs: out, undated }
}

/** `boundSlips` の返り値。 */
export interface BoundSlips {
  /** 結んである明細 (保存した順)。 */
  slips: VehicleDailySlip[]
  /** **結んであるのに手元の明細に見当たらない数。** 0 なら全部引けている。 */
  missing: number
}

/**
 * その便に結んである明細を、引いてある明細から取り出す (Refs #848)。
 *
 * **引けなかった `rowId` は黙って落とさず数える。** 落として黙ると「結びつけが
 * 消えた」ように見えるが、実際は保存されたまま — 日付の範囲外・別の乗務員で
 * 引いた等で**手元に無いだけ**で、①の集計では効いている。
 */
export function boundSlips(
  rowIds: readonly string[],
  byRowId: Map<string, VehicleDailySlip>,
): BoundSlips {
  const slips: VehicleDailySlip[] = []
  let missing = 0
  for (const id of rowIds) {
    const slip = byRowId.get(id)
    if (slip === undefined) missing++
    else slips.push(slip)
  }
  return { slips, missing }
}

/**
 * 画面に並べる明細。**結んである明細を先に、候補を後ろに**置く。
 *
 * `forceMatchCandidates` は**日付 ±1 日**で候補を絞るので、**日付の外に結んだ明細は
 * 候補に出てこない**。結んである明細を別に足しておかないと、一度結ぶと**外せなくなる。**
 */
export function slipRows(
  bound: readonly VehicleDailySlip[],
  candidates: readonly VehicleDailySlip[],
): VehicleDailySlip[] {
  const boundIds = new Set(bound.map(s => s.rowId))
  return [...bound, ...candidates.filter(s => !boundIds.has(s.rowId))]
}

/** 明細の売上合計 (円)。`forcedLeg` の `salesYen` と同じ足し方。 */
export function sumAmount(slips: readonly VehicleDailySlip[]): number {
  return slips.reduce((sum, s) => sum + s.amount, 0)
}

/**
 * 収支パネルの見出しの下に**必ず出す一言** (Refs #848)。
 *
 * **日常この画面を使う人がいる。** 同じチェックボックスが**別の意味**になったので
 * (検証スナップショット → ①への結びつけ)、何がどう変わったかを画面で読めるようにする。
 * 文言を定数にするのは `LEG_SALES_TITLE` と同じ理由 — 混ぜて読ませたら意味が無い。
 */
export const FORCE_MATCH_PANEL_NOTE
  = '確定の保存先が変わりました。チェックした明細は「その便への結びつけ」として保存され、粗利タブ・運行手当タブの集計 (粗利・乗務員別・取引先別・印刷) に効くようになります。以前の「検証結果を保存」で残した検証スナップショットは消えていませんが、これ以降は増えません。'

/**
 * 結ぶ前に読ませる一言 (Refs #848)。**置き換えであって足し算ではない。**
 *
 * `applyForcedSales` は結んだ明細で便の突合結果を**丸ごと差し替える**ので、①が既に
 * 当てていた明細があれば外れる。「足される」と読まれると金額が下がった理由が分からなくなる。
 */
export const FORCE_MATCH_OVERRIDE_NOTE
  = 'その便に粗利タブが既に当てている明細があるときは、結んだ内容で置き換わります (足し算ではありません)。候補は同じ乗務員・日付 ±1 日で、他の便に当たっていない明細だけです。'

/** 明細に出す「根拠」バッジ。`scoreVehicleDailySlips` の結果を 3 段に畳んだもの。 */
export type SlipBadge = 'exact' | 'partial' | 'none'

/**
 * 根拠バッジ。**候補の並べ替えには使わない** — 並びは `forceMatchCandidates`
 * (積地が一致する明細が先) のもので、こちらは目印だけ。
 *
 * スコアを持っていない明細 (`undefined`) は `none` — 「根拠が無い」であって
 * 「結べない」ではない。
 */
export function slipBadge(scored: Pick<ScoredVehicleDailySlip, 'score' | 'suggested'> | undefined): SlipBadge {
  if (scored === undefined) return 'none'
  if (scored.suggested) return 'exact'
  return scored.score > 0 ? 'partial' : 'none'
}
