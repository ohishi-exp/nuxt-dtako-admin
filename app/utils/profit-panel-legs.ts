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
import { forceMatchKey, type ForceMatchMap } from './allowance-force-match'
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
 *
 * ## ★ 「他の便に」ではなく「どの便にも」 (Refs #854)
 *
 * `forceMatchCandidates` が外すのは `usedRowIds` **全部** = ①が当てた明細の
 * **運行をまたいだ和集合**で、例外は `ownRowIds` だけ。#854 で `ownRowIds` に
 * **その便に①が当てた明細**を混ぜたので、いまは**この便のぶんは「結んである」側に出る**。
 * 候補に出ないのは**他の便に当たっているもの**だけになった。
 *
 * **直す前は「他の便に当たっていない明細だけ」と書いてあった** — 実際にはこの便に①が
 * 当てた明細も候補から外れていたので、**上の「粗利タブの計上額」に出ている伝票が候補に
 * 無い**のを見た人が「取りこぼしでは」と読める状態だった (本番 2026-08-24、運行
 * `2607010419590000001109` 便1 = 伝票 `20260701-154`)。
 */
export const FORCE_MATCH_OVERRIDE_NOTE
  = 'その便に粗利タブが既に当てている明細は、チェック済みで出ています。チェックを変えると、その内容を土台にした上書きとして保存されます (足し算ではありません)。候補として新しく出るのは、同じ乗務員・日付 ±1 日で、まだどの便にも当たっていない明細だけです。'

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

/**
 * その便の「結んである」の**出どころ** (Refs #854)。
 *
 * - `ichiban` — **①が当てた** (`OPERATION_LEG_SALES_KEY` の per-leg `slipIds`)。
 *   `FORCE_MATCH_KEY` には 1 文字も入っていない
 * - `forced` — **人が結んだ** (`FORCE_MATCH_KEY`)。`applyForcedSales` は便の突合結果を
 *   **丸ごと差し替える**ので、こちらがあるときは①の結果はもう効いていない
 * - `none` — どちらも無い
 */
export type BoundSource = 'forced' | 'ichiban' | 'none'

export interface EffectiveSlipIds {
  ids: string[]
  source: BoundSource
}

/**
 * その便に**いま当たっている**明細。**人の上書き > ①の結果**の順に採る (Refs #854)。
 *
 * これを画面に映さないと、①が当てている便が「**結び 0 件・0 円**」に見える。そのまま
 * 何か 1 件結ぶと**置き換えで①の売上が消え**、消えた明細は `usedRowIds` に居るので
 * **候補にも出ず戻せない** (本番 v0.0.532 で実際にこの状態だった)。
 *
 * **①の結果を `FORCE_MATCH_KEY` から読まない** — そこには書いていない。読むのは
 * `lookupUsedSlipIds` の `slipIdsBySeq` で、**書き込みは人が触るまで起こさない**
 * (`seedForceMatch`)。
 *
 * **空配列の上書き (`forced: []`) は「人が空にした」ではない** — `toggleForceMatch` は
 * 最後の 1 件を外すとキーごと消すので、そもそも空配列は保存されない。`undefined`
 * (キーが無い) だけが「上書きしていない」。
 */
export function effectiveSlipIds(
  forced: readonly string[] | undefined,
  ichibanIds: readonly string[],
): EffectiveSlipIds {
  if (forced !== undefined) return { ids: [...forced], source: 'forced' }
  if (ichibanIds.length > 0) return { ids: [...ichibanIds], source: 'ichiban' }
  return { ids: [], source: 'none' }
}

/**
 * **人が触った瞬間に、①の結果を土台として書き起こす** (Refs #854)。
 *
 * `applyForcedSales` は置き換えなので、①が {A,B,C} を当てている便で人が B だけ外したい
 * とき、土台が無いまま `toggleForceMatch` すると **`{B}` だけが残って A と C が消える**
 * (= #854 の欠陥そのもの)。**土台を敷いてから差分を乗せる。**
 *
 * **触るまでは書かない。**①の結果を先回りして保存すると「人が確定した」ことになって
 * しまう (#854 の禁止事項)。既に上書きがある便・①も当てていない便では**同じ参照を
 * そのまま返す** (無駄に identity を変えない)。
 *
 * **全部外すと `toggleForceMatch` がキーごと消す = ①の結果に戻る。**「売上 0 の便」には
 * できない (`ForceMatchMap` が「空 = 結んでいない」形なので構造上そうなる)。
 * **画面でそう言うのは呼び出し側の責務** (`FORCE_MATCH_ICHIBAN_NOTE`)。
 */
export function seedForceMatch(
  map: ForceMatchMap,
  legKey: string,
  ichibanIds: readonly string[],
): ForceMatchMap {
  if (map[legKey] !== undefined) return map
  if (ichibanIds.length === 0) return map
  return { ...map, [legKey]: [...ichibanIds] }
}

/**
 * ①が当てている便を開いたときに出す一言 (Refs #854)。
 *
 * **「結び 0 件」ではなく「①が当てている」と言う**のが本題だが、**外し方の帰結**まで
 * 言わないと次の誤読が生まれる — 全部外すと空にはならず**①の結果に戻る**。
 */
export const FORCE_MATCH_ICHIBAN_NOTE
  = 'この便は粗利タブが当てた明細です (まだ人の上書きはありません)。チェックを変えると、この内容を土台にした上書きとして保存されます。全部外すと粗利タブの結果に戻ります — この便を売上 0 円にすることはできません。'
