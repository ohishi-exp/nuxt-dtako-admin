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
import { epochToYmd, matchLocationLevel, type LocationMatchLevel, type VehicleDailySlip } from './ichiban'
import { combinedMatchLevel } from './profit-r2'
import type { SelectedRowsLocationRange } from './event-data-table'

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

/**
 * 明細に出す「根拠」バッジ。**`combinedMatchLevel` と同じ 3 段**なので、
 * `/profit/monthly` の保存済み一覧と**同じ言葉が同じ意味**になる (Refs #858)。
 */
export type SlipBadge = LocationMatchLevel

/**
 * `origin_area_name` (地域ﾏｽﾀ由来) を優先し、`none` なら `origin` (発地N) で判定する。
 *
 * ②の `scoreVehicleDailySlips` を撤去したとき (#858) に**この作法だけ引き取った** —
 * 消えたのはスコアリング (exact=2/partial=1 の合算と並べ替え) であって、**地域マスタが
 * 空なら自由記述で見る**という地名突合の作法ではない。一番星の `dest_area_name` は
 * 地域マスタに載っていない地名だと空で返り、そのとき手入力の `dest` にしか手掛かりが無い。
 */
function bestMatch(dtakoName: string, areaName: string, freeText: string): LocationMatchLevel {
  const primary = matchLocationLevel(dtakoName, areaName)
  if (primary !== 'none') return primary
  return matchLocationLevel(dtakoName, freeText)
}

/** 明細 1 件の突合結果。**畳んだ `badge` と、畳む前の両側**を必ずセットで持つ。 */
export interface SlipMatch {
  /** `combinedMatchLevel` の 3 段。**`/profit/monthly` の一覧と同じ言葉・同じ意味。** */
  badge: SlipBadge
  /** 選択区間の積地 vs 明細の積地。 */
  originMatch: LocationMatchLevel
  /** 選択区間の卸地 vs 明細の卸地。 */
  destMatch: LocationMatchLevel
}

/**
 * 根拠バッジ。**候補の並べ替えには使わない** — 並びは `forceMatchCandidates`
 * (積地が一致する明細が先) のもので、こちらは目印だけ。
 *
 * ## ★★ 「完全一致」は**両方 exact のときだけ** (Refs #858)
 *
 * 撤去前は②の `suggested` (= 積地・卸地の**両方が none でない**) をそのまま `exact` =
 * 「完全一致」として出していたので、**partial + partial も「完全一致」**と表示されていた。
 * 帯広の実データは `北海道釧路市西港２-101-1` vs `北海道釧路市` のような partial が主で、
 * **日常的に出る嘘**だった。一方で `/profit/monthly` の保存済み一覧は同じものを
 * `combinedMatchLevel` で「部分」と数えていて、**同じ言葉が 2 画面で違う意味**だった。
 *
 * ⇒ **`combinedMatchLevel` に寄せた。**変わるのは 2 か所:
 *
 * - **both partial (や exact+partial) → 「完全一致」から「部分一致」へ。**壊れたのではなく、
 *   いままでが嘘だった
 * - **片側だけ当たり (もう片方が none) → 「部分一致」から「根拠なし」へ**
 *
 * ## ★ 畳んだ両側を捨てない (`slipSideNote`)
 *
 * 後者は**候補一覧の 3 割**に当たる (本番 2026-07 で 1,971 候補中 589 件)。バッジだけに
 * すると「積地は合っている明細」と「何も合っていない明細」が**同じ「根拠なし」に潰れる** —
 * 候補が 2 件以上ある便 471 本のうち **113 本**が、バッジ一色なのに両側を見れば
 * 見分けが付く状態になる。**畳んだことを黙らない**ために両側を返し、
 * `slipSideNote` が「片側だけ当たり」を画面に言わせる。
 *
 * 選択区間の積地・卸地が取れていない (`location` が `null`) ときは、突合する相手が
 * 無いので全件 `none` — 「根拠が無い」であって「結べない」ではない。
 */
export function slipMatch(location: SelectedRowsLocationRange | null, slip: VehicleDailySlip): SlipMatch {
  const originMatch = bestMatch(location?.originCity ?? '', slip.originAreaName, slip.origin)
  const destMatch = bestMatch(location?.destCity ?? '', slip.destAreaName, slip.dest)
  return { badge: combinedMatchLevel(originMatch, destMatch), originMatch, destMatch }
}

/**
 * バッジが**畳んで隠した**ことを言う一言。隠していなければ `null` (何も出さない)。
 *
 * `combinedMatchLevel` は「片方でも `none` なら根拠なし」なので、**積地だけ当たっている
 * 明細と、何ひとつ当たっていない明細が同じ「根拠なし」になる。**候補を選ぶ人にとっては
 * これが唯一の手掛かりであることがあるので、**その 1 行だけは残す。**
 *
 * **バッジが `none` でないときは `null`** — 両側とも当たっているので畳んで隠したものが
 * 無く、書くと全行に同じ文字が並んで候補一覧が読みにくくなるだけ。
 */
export function slipSideNote(match: SlipMatch): string | null {
  if (match.badge !== 'none') return null
  if (match.originMatch !== 'none') return '積地のみ一致'
  if (match.destMatch !== 'none') return '卸地のみ一致'
  return null
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
 * **その便に出してよい相手** (`forceMatchCandidates` の `ownRowIds`、Refs #854)。
 *
 * ## ★ `effectiveSlipIds().ids` を流用してはいけない
 *
 * あちらは「**いま当たっている**」(表示・合計)、こちらは「**この便に出してよい**」で
 * 意味が違う。流用すると、**人が①の明細を外した瞬間にそれが `own` から外れ**、
 * `usedRowIds` (キャッシュはまだ①の結果) に残っているので**候補からも消える** —
 * `bound` にも `候補` にも居ない = **その場では戻せない**。#854 で直したはずの
 * 「結ぶと戻せない」が符号を変えて残る形になる (押し間違いが取り返せない)。
 *
 * **`forced ∪ ①がこの便に当てたぶん`** を返す。**他の便の明細は 1 件も入らない**ので、
 * `forceMatchCandidates` のフィルタ (`own.has(...) || !usedRowIds.has(...)`) を
 * **1 文字も緩めずに**、二重計上の口も開かない。
 */
export function ownSlipIds(
  forced: readonly string[] | undefined,
  ichibanIds: readonly string[],
): string[] {
  const out = [...(forced ?? [])]
  const seen = new Set(out)
  for (const id of ichibanIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
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
 * **「結び 0 件」ではなく「①が当てている」と言う**のが本題だが、**触った結果**まで
 * 言わないと次の誤読が生まれる:
 *
 * 1. **触るとその便は①の追従をやめる。** `applyForcedSales` は `FORCE_MATCH_KEY` が
 *    あれば必ず置き換えるので、**あとで一番星の伝票が直っても・粗利タブを集計し直しても
 *    その便は触ったときの内容のまま**になる。「置き換えです」だけだと「今回の集計で
 *    置き換わる」と読まれ、**次の月次で伝票が直っても反映されない**ことに気づけない
 * 2. **全部外すと空にはならず①の結果に戻る** (`toggleForceMatch` が最後の 1 件で
 *    キーごと消し、`resolveForceMatches` は明細 0 件の便を飛ばす)。**売上 0 円の便には
 *    できない** — `ForceMatchMap` が「空 = 結んでいない」形なので構造上そうなる
 */
export const FORCE_MATCH_ICHIBAN_NOTE
  = 'この便の明細は粗利タブが当てたものです (まだ人の上書きはありません)。チェックを変えると、この内容を土台にした上書きとして保存され、以後この便は粗利タブの集計に追従しなくなります (集計し直しても内容はそのままになります)。全部外すと粗利タブの結果に戻ります — この便を売上 0 円にすることはできません。'

/**
 * **人が触った便**に出す一言 (Refs #854)。**もう①には追従していない。**
 *
 * `applyForcedSales` は `FORCE_MATCH_KEY` があれば①の突合結果を丸ごと置き換えるので、
 * この便は**集計し直しても・一番星の伝票が直っても**この内容のまま。**画面から読めない**
 * ままだと、月次で直したはずの伝票が反映されない理由に誰も辿り着けない。
 *
 * **戻し方も同じ場所で言う** — 全部外せば①の結果に戻る。
 */
export const FORCE_MATCH_FROZEN_NOTE
  = 'この便は人の上書きです。粗利タブで集計し直しても、一番星の伝票が直っても、内容はこのままです (①の突合には追従しません)。全部外すと粗利タブの結果に戻ります。'
