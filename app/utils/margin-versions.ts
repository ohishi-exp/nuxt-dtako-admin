/**
 * R2 に残した**粗利の集計の版**を一覧するための pure 部分 (Refs #833)。
 *
 * オーナーの要望「**いつ変わったのか追えるようにしたい**」の画面側の前半。保存
 * (`POST /api/profit/margin-summary` → `profit/{ym}/margin-summary/`) は #828 / #830 で
 * 本番に入っているが、**残した版を読む口が画面に無い**。まず一覧を出す。
 * **何が変わったか (差分) はここには無い** — 別 PR。
 *
 * **粗利の数字を 1 円も作らない・変えない。** `margin.ts` の計算にも `MarginCache` の形にも
 * `reconcileVehicles` にも触らず、**既に R2 に残っている版を読んで並べるだけ**。
 *
 * パスの組み立て (`marginR2Paths`) と版キーのラベル化 (`marginVersionLabel`) は
 * `margin-r2.ts` に既にあるので**再発明しない** — ここは import して使う側。
 *
 * IO (R2 list/get) はここに置かない。R2 binding は Nitro server route からしか触れないので
 * `server/api/profit/margin-snapshots.get.ts` が持つ (`margin-r2.ts` と同じ分け方)。
 */
import { marginVersionLabel } from './margin-r2'
import type { MarginTotals } from './margin'

/**
 * **本文 (`v-{ts}.json`) を読んで金額まで出す版の本数の上限。**
 *
 * 版が何本あるかは月によって違い、**事前には分からない** (数字が変わった回数ぶん増える)。
 * 一覧のために R2 を版の数だけ `get()` すると、古い月ほど遅くなる — **本数によらず
 * 一定の回数で済ませる**ためにここで頭を止める。**上限に当たったことは画面に出す**
 * (`marginVersionOmittedNote`) — 黙って切ると「全部出ている」と誤読される。
 */
export const MARGIN_VERSION_BODY_LIMIT = 20

/**
 * 版のキーが `v-{ts}.json` か。**`latest.json` と `history.jsonl` を版として数えない**
 * ための判定 (`profit/{ym}/margin-summary/` にはこの 3 種類しか置かれない)。
 *
 * `startsWith('v-') && endsWith('.json')` と 2 つに割らないのは、`v-` で始まって
 * `.json` で終わらないキーが**構造上存在しない**ため — 割ると片側が永久に通らない
 * 分岐になり、実際に効いている判定と見分けが付かなくなる。
 */
const MARGIN_VERSION_KEY_RE = /^v-.+\.json$/

/** R2 のキー全体 (`profit/{ym}/margin-summary/v-{ts}.json`) を受けて、版かどうかを返す。 */
export function isMarginVersionKey(key: string): boolean {
  return MARGIN_VERSION_KEY_RE.test(key.slice(key.lastIndexOf('/') + 1))
}

/** 一覧の 1 行が持つ、版そのものの識別 (金額を読む前でもタダで作れるぶん)。 */
export interface MarginVersionEntry {
  /** R2 のキー。**画面には出さない** — 版を選んで読み直すときの鍵。 */
  key: string
  /** 人に見せる版の名前 (`v-20260824T102030`)。保存時の注記と同じ呼び方に揃える。 */
  label: string
}

/**
 * 版のラベル (`v-20260824T102030`) の**新しい順**。破壊的変更を避けるため新しい配列を返す
 * (`sortSnapshotListBySavedAtDesc` と同じ流儀。あちらは `savedAt` を持つ別の形なので
 * 直接は使えない)。
 *
 * ラベルは JST の固定長 (`profitVersionTimestamp`) なので**文字列の比較で時刻の順になる**。
 * `savedAt` (UTC・別の `new Date()` 呼び出し) と混ぜて join しない — 秒の境界で食い違う。
 */
export function sortMarginVersionsDesc<T extends MarginVersionEntry>(items: T[]): T[] {
  return [...items].sort((a, b) => b.label.localeCompare(a.label))
}

/** R2 の list 結果 (キーの列) から版だけを拾い、新しい順に並べる。 */
export function listMarginVersionEntries(keys: string[]): MarginVersionEntry[] {
  return sortMarginVersionsDesc(
    keys.filter(isMarginVersionKey).map(key => ({ key, label: marginVersionLabel(key) })),
  )
}

/**
 * 一覧に出す金額。**`MarginTotals` をそのまま返さない** — 版の本文には粗利率の分母や
 * 走行距離の内訳まで入っているが、一覧に要るのは 4 つだけで、載せるほど応答が重くなる。
 * **数字は 1 つも作り直さない** (保存済みの値をそのまま抜くだけ)。
 */
export interface MarginVersionTotals {
  operations: number
  salesYen: number
  allowanceYen: number
  marginYen: number
}

export function pickMarginVersionTotals(totals: MarginTotals): MarginVersionTotals {
  return {
    operations: totals.operations,
    salesYen: totals.salesYen,
    allowanceYen: totals.allowanceYen,
    marginYen: totals.marginYen,
  }
}

/** 一覧の 1 行。**上限より古い版は `totals: null`** (ラベルだけ)。 */
export interface MarginVersionItem extends MarginVersionEntry {
  totals: MarginVersionTotals | null
}

/** `GET /api/profit/margin-snapshots?ym=` の応答。 */
export interface MarginVersionListResult {
  ym: string
  items: MarginVersionItem[]
  /** 版の総数 (**金額を省いたぶんも含む**)。 */
  total: number
  /** 本文を読んだ本数の上限 (`MARGIN_VERSION_BODY_LIMIT`)。画面が注記に使う。 */
  bodyLimit: number
  /** 金額を省いた本数 (`total - bodyLimit`、上限に届かなければ 0)。 */
  omitted: number
}

/** 金額を省いた本数。**負にしない** (版が上限に届かない月では 0)。 */
export function marginVersionOmittedCount(total: number, limit: number): number {
  return Math.max(0, total - limit)
}

/**
 * **上限に当たったことを画面に出す**ための文言。省いていなければ空文字 (何も出さない)。
 *
 * 「金額は版を選んだときに読みます」とは書かない — **この画面にまだ版を選ぶ口が無い**
 * (差分ビューは別 PR) ので、無い操作を案内すると読んだ人が探して見つけられない。
 * 事実 (新しい方から何本ぶんだけ本文を読んだか) だけを書く。
 */
export function marginVersionOmittedNote(omitted: number, limit: number): string {
  if (omitted <= 0) return ''
  return `古い ${omitted} 本は金額を省いています — この一覧が本文を読むのは新しい ${limit} 本までです`
    + ' (版そのものは R2 に残っています)。'
}
