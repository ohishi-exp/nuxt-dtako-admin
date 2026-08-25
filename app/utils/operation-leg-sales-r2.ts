/**
 * 運行詳細の「粗利タブの計上額」を、**この端末で集計していなくても出す**ための pure
 * (Refs #865 / Refs #820)。
 *
 * オーナーが実際に踏んだ症状は「別のブラウザ・別の端末・別の人からは必ず
 * **『このブラウザの粗利タブで集計すると出ます』**しか出ない」。表示そのものは正しい
 * (`legSalesNote` の `missing`) ので、**直すのはそうなる理由の方**。
 *
 * ## ★ 新しいデータは 1 バイトも要らない
 *
 * `MarginCache.operations[].legs` (= `MarginLegInput[]`) は **#826 で
 * `profit/{ym}/margin-summary/latest.json` に入っている**。その中に
 * `customers: LegCustomerShare[]` (`code` + `name` + `yen`) があり、**計上額パネルが
 * 使うのは `leg.customers` と `legSaleYen(leg)` だけ**。⇒ **読む経路が無かっただけ。**
 *
 * **`margin-summary` の書き込み側には触らない。読むだけ。** `reconcileVehicles` も
 * 回し直さない (明細のプールを順に消費するので、回し直すと粗利タブと違う金額が出る)。
 *
 * ## ★ `slipIds` (伝票番号) は版に無い
 *
 * `leg-sales` (localStorage) にあって版に無いのは `slipIds` ただ 1 つ。計上額パネルは
 * 使っていないので足りるが、**穴を黙らない** — R2 から読んだ回は便ごとの「伝票 …」が
 * 出ないので、**出どころの注記でその理由まで言う** (`legSalesR2Note`)。
 * 空欄を「伝票が無い便」と読ませない。
 *
 * **収支パネルの候補ゲート (`lookupUsedSlipIds`) はここに乗せない。** あちらは
 * 「①が既にどこかの便へ当てた明細」の**和集合**が要り、欠けるとそこが二重計上の口に
 * なる。版は `slipIds` を持たないので、落とすと空集合になり**必ず**壊れる。
 * localStorage のままにしてある (別 issue)。
 *
 * ## ★ 出どころを画面で言い分ける (この issue の中核)
 *
 * 「この端末で集計した結果」と「R2 に保存された版」は**別物**で、**版は古いことがある**
 * (最後に誰かが粗利タブで集計した時点)。**黙って差し替えると、数字が変わった理由が
 * 読めなくなる。** だから
 *
 * - 見出しに**必ず**出どころを出す (`legSalesSourceLabel`)
 * - R2 から読んだ回は**いつの版か (`savedAt`)** と、切り替わる条件を添える
 * - 出せなかった回は**理由を分ける** (版が無い / 本文が読めない / 版にこの運行が無い /
 *   この運行に便が無い / まだ確認中 / 日付が読めず月を決められない)。
 *   **どれも「0 円」ではない**
 *
 * ## ★ localStorage を先に見る順序は変えない
 *
 * 集計直後の値が即反映される今の挙動を壊さないため。**R2 を見ないのは `ready` のとき
 * だけ** — この端末でこの運行を集計してあるので、古い版で上書きしない。
 *
 * **`missing` と `not-aggregated` はどちらも R2 へ落ちる** (Refs #867)。#865 は
 * `missing` だけを指定していたので `not-aggregated` (この端末に**別の月**の突合結果が
 * ある) が落ちず、**R2 に版があるのに「この運行はありません」しか出なかった。**
 *
 * ## ★ 出どころの言い分けが 1 段増える (#867)
 *
 * 「**この端末には 2026-06 の結果があり、R2 の 2026-07 の版から出した**」という状態が
 * 新しく生まれる。**黙って混ぜない:**
 *
 * - 数字が出ているときに「ありません」を横に残さない (`note` は `null` のまま)
 * - **見出しで両方の月を名乗る** (`legSalesSourceLabel` の `localYm`) — 版の月しか
 *   名乗らないと、この端末のキャッシュが別の月だという事実が消える
 * - **嘘になる文は「訂正を後ろに足す」のではなく、その文を直す** — `legSalesR2Note` は
 *   #865 では「この端末の粗利タブで集計すると切り替わります」と言っていたが、
 *   **2026-06 を集計し直しても切り替わらない**。**この運行の月を名乗らせて**正した
 *   (`missing` でも正しく、しかも精密になるので場合分けは増えない)
 * - 注記に足すのは**この端末が持っている月**という新しい事実 1 つだけ
 *   (`legSalesLocalOtherYmNote`) — 出どころと計上額の月は見出しと 1 文目が既に言う
 */

import { shiftYmd } from './profit-compare'
import {
  legSalesNote,
  legSalesReadyLookup,
  type OperationLegSale,
  type OperationLegSaleCustomer,
  type OperationLegSalesLookup,
  type OperationLegSalesReady,
} from './operation-leg-sales'
import { savedAtLabel } from './allowance-cache'

// --- R2 の版 1 本を引いた結果 ---------------------------------------------

/**
 * `GET /api/profit/operation-leg-sales?ym=&unkoNo=` の応答 (= 版 1 本をその運行で引いた
 * 結果)。**「無い」も正常な答え**なので 200 で返す — 404 に潰すと、版が無いのか本文が
 * 読めないのかその運行が居ないのかを画面が言い分けられない。
 *
 * **`ym` は R2 のキーを組んだ月**そのもの (`marginR2Paths(ym).latest`)。本文の中の `ym`
 * は使わない — 書き側が `cache.ym === body.ym` を強制し、キーも `snapshot.ym` から
 * 組むので、食い違いは構造上起こらない (**通らない判定を書かない**)。
 */
export type OperationLegSalesR2 =
  /** `latest.json` が無い (その月は一度も保存されていない)。 */
  | { status: 'no-version', ym: string }
  /** `latest.json` はあるが本文が読めない。**0 円ではない。** */
  | { status: 'unreadable', ym: string }
  /** 版にこの運行が入っていない。 */
  | { status: 'not-aggregated', ym: string, savedAt: string }
  /** 版にこの運行はあるが、**便が 1 本も無い** (`noLegOperations` の運行)。 */
  | { status: 'no-legs', ym: string, savedAt: string }
  /** 便が読めた。**`slipIds` は版に無いので必ず空。** */
  | { status: 'ready', ym: string, savedAt: string, legs: OperationLegSale[] }

/** 版の本文のうち、`customers` 1 つぶんを読む。**1 つでも読めなければ `null`。** */
function snapshotCustomers(value: unknown): OperationLegSaleCustomer[] | null {
  if (!Array.isArray(value)) return null
  const out: OperationLegSaleCustomer[] = []
  for (const c of value as unknown[]) {
    if (typeof c !== 'object' || c === null) return null
    const { name, yen } = c as { name?: unknown, yen?: unknown }
    if (typeof name !== 'string') return null
    if (typeof yen !== 'number' || !Number.isFinite(yen)) return null
    out.push({ name, yen })
  }
  return out
}

/**
 * 版の便を計上額パネルの形にする。**1 便でも読めなければ `null`** (= 版まるごと
 * `unreadable`)。読めたぶんだけ出すと、**金額が黙って低く出る** — 粗利タブが出した額を
 * 変えてしまうので、`storedCustomers` と同じ流儀で全部やめる。
 *
 * **`code` は落とす。** 画面が出すのは名前と金額だけで、載せるほど応答が重くなる
 * (`pickMarginVersionTotals` と同じ判断)。**金額は 1 円も作り直さない。**
 */
function snapshotLegs(value: unknown): OperationLegSale[] | null {
  if (!Array.isArray(value)) return null
  const out: OperationLegSale[] = []
  for (const leg of value as unknown[]) {
    if (typeof leg !== 'object' || leg === null) return null
    const { seq, customers } = leg as { seq?: unknown, customers?: unknown }
    if (typeof seq !== 'number' || !Number.isInteger(seq)) return null
    const read = snapshotCustomers(customers)
    if (read === null) return null
    // **`slipIds` は版に持っていない。** 空で埋めるが、空欄が「伝票の無い便」に
    // 読まれないよう、出どころの注記 (`legSalesR2Note`) が理由を言う。
    out.push({ seq, customers: read, slipIds: [] })
  }
  return out
}

/**
 * 版の本文 (`JSON.parse` した生の値) から、その運行の便だけを抜く (Refs #865)。
 *
 * **`MarginSummarySnapshot` 型をそのまま要求しない** — R2 から来るのは `unknown` で、
 * 型を名乗らせても中身の保証にはならない。読むのは `savedAt` と
 * `cache.operations[].{unkoNo, legs[].{seq, customers[].{name, yen}}}` だけ。
 *
 * **`not-aggregated` と `no-legs` を混ぜない。** 「版にこの運行が居ない」(別の月を
 * 集計した / まだ取り込んでいない) と「居るが便が 1 本も無い」(`noLegOperations`) は
 * 別のことで、同じ文言にすると読む人が次にやることを間違える。
 */
export function pickOperationLegSalesFromSnapshot(
  parsed: unknown,
  ym: string,
  unkoNo: string,
): OperationLegSalesR2 {
  if (typeof parsed !== 'object' || parsed === null) return { status: 'unreadable', ym }
  const body = parsed as { savedAt?: unknown, cache?: unknown }
  if (typeof body.savedAt !== 'string') return { status: 'unreadable', ym }
  const savedAt = body.savedAt
  if (typeof body.cache !== 'object' || body.cache === null) return { status: 'unreadable', ym }
  const operations = (body.cache as { operations?: unknown }).operations
  if (!Array.isArray(operations)) return { status: 'unreadable', ym }

  let hit: { legs?: unknown } | null = null
  for (const op of operations as unknown[]) {
    if (typeof op !== 'object' || op === null) return { status: 'unreadable', ym }
    if ((op as { unkoNo?: unknown }).unkoNo !== unkoNo) continue
    hit = op as { legs?: unknown }
    break
  }
  if (hit === null) return { status: 'not-aggregated', ym, savedAt }

  const legs = snapshotLegs(hit.legs)
  if (legs === null) return { status: 'unreadable', ym }
  if (legs.length === 0) return { status: 'no-legs', ym, savedAt }
  return { status: 'ready', ym, savedAt, legs }
}

// --- 探しに行く月 -----------------------------------------------------------

/**
 * 版を探しに行く月の候補 (Refs #865)。**最大 2 つ**、可能性の高い順。
 *
 * ★ **粗利タブの月の切り方は運行の開始日** (`buildMonthlyAllowanceByOperationDate` →
 * `operationRunDate`) で、運行詳細が持つ読取日 / 運行日とは**1 日ずれうる**。
 * 月末・月初の運行を 1 か月だけ見ると、**入っているのに「版にこの運行はありません」**と
 * 出る (`operation-leg-sales.ts` が「独自の月判定を足さない」と言っているのと同じ罠)。
 * だから**前後 1 日ぶんの月も候補に入れ、その運行が居る版を採る**。
 *
 * 月境界でしか 2 つにならない (`YYYY-MM` の重複は畳む) ので、**普段は 1 回の取得**。
 * 日付が読めなければ空 — **推測で今月を見に行かない** (別の月の数字を出しかねない)。
 */
export function legSalesYmCandidates(date: string | null | undefined): string[] {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  const out = [date.slice(0, 7)]
  for (const delta of [-1, 1]) {
    const ym = shiftYmd(date, delta).slice(0, 7)
    if (!out.includes(ym)) out.push(ym)
  }
  return out
}

/**
 * 月の候補ぶんの応答から 1 つ選ぶ (Refs #865)。空なら `null`。
 *
 * 優先順は **`ready` > `no-legs` > `unreadable` > `not-aggregated` > `no-version`**。
 *
 * - 数字が出る `ready` が最優先。**2 つの月の両方に居ることは無い** (版は月ごとの系列で、
 *   運行は開始日で 1 つの月に入る) ので、ここで額を選び間違えることはない
 * - `unreadable` を `not-aggregated` より上に置くのは、**異常を正常で隠さない**ため。
 *   本当にその運行が居るなら `ready` が勝つので、この 2 つが並ぶのは
 *   「片方に居ない・片方は読めない」= 読めた方だけ見て「ありません」と言い切れない状態
 */
export function pickBestR2LegSales(results: OperationLegSalesR2[]): OperationLegSalesR2 | null {
  const rank: Record<OperationLegSalesR2['status'], number> = {
    ready: 0,
    'no-legs': 1,
    unreadable: 2,
    'not-aggregated': 3,
    'no-version': 4,
  }
  let best: OperationLegSalesR2 | null = null
  for (const r of results) {
    if (best === null || rank[r.status] < rank[best.status]) best = r
  }
  return best
}

// --- 画面が受け取る状態 -----------------------------------------------------

/**
 * R2 側の取得がどこまで進んでいるか。**`ready` 以外のときに画面が見る**
 * (`missing` も `not-aggregated` も落ちてくる、Refs #867)。
 */
export type LegSalesR2Fetch =
  /** まだ確認中 (運行の読み込み待ちを含む)。 */
  | { state: 'loading' }
  /** 運行の日付が読めず、**どの月の版を見ればよいか決められない**。 */
  | { state: 'no-date' }
  /**
   * 取得そのものが失敗した (通信・503 等)。**0 円ではない。**
   *
   * **`checkedYms` を持つ** (Refs #867) — 失敗の文言はどこにも月を書かないので、
   * 付けないと**どの月を見に行って失敗したのか**が読めない (「見に行かなかった」と
   * 区別が付かない)。`done` と同じく**取りに行った月を全部**入れる。
   */
  | { state: 'failed', message: string, checkedYms: string[] }
  /** 候補の月を全部見終わった。 */
  | { state: 'done', result: OperationLegSalesR2, checkedYms: string[] }

/** 計上額の出どころ。**「この端末で集計した結果」と「R2 に保存された版」は別物。** */
export type LegSalesSource = 'local' | 'r2'

/** 見出しに出す出どころの名前。**必ずどちらかを出す** (黙ると版の古さが読めない)。 */
export const LEG_SALES_SOURCE_NAMES: Record<LegSalesSource, string> = {
  local: 'この端末で集計した結果',
  r2: 'R2 に保存された版',
}

/**
 * R2 から読んだ回にだけ添える注記 (Refs #865 / Refs #867)。
 *
 * **local 側には付けない** — 見出しの出どころ名で足りるうえ、この区画には既に
 * `LEG_SALES_PANEL_NOTE` (収支パネルとの関係) が出ている。R2 の回だけ**この出どころに
 * しか無い事実が 2 つある**ので、そのぶんだけ言う:
 *
 * 1. **版は古いことがある** — 最後に誰かが粗利タブで集計して保存した時点のもの
 * 2. **伝票番号が入っていない** — 便ごとの「伝票 …」が出ないのは、伝票が無いからでは
 *    なく版が持っていないから
 *
 * 切り替わる条件 (この端末で集計し直せば local に戻る) も書く — 書かないと
 * 「なぜ数字が変わったのか」が後から読めない。
 *
 * ## ★ 定数ではなく関数 (`ym` を取る、Refs #867)
 *
 * #865 では 3 文目が「**この端末の粗利タブで集計すると**、この画面はそちらの結果に
 * 切り替わります」だった。**`not-aggregated` の端末ではこれが嘘になる** — その端末は
 * **既に集計してある** (別の月) ので、その月を集計し直しても切り替わらない。
 *
 * **後ろに訂正文を足す形にしない。**先に読まれる方が間違ったままなら、1 文目で止まった
 * 読者は誤解して終わる (#851 と同じ型)。**その文自体を正しくする** —
 * **この運行の月 (`ym`) を名乗らせる**と `not-aggregated` で正しくなり、`missing` でも
 * 正しい (しかもどの月を集計すればよいかまで言えるので今より精密)。**場合分けは増えない。**
 *
 * **中身が可変になったので名前も定数のままにしない** (`LEG_SALES_R2_NOTE` →
 * `legSalesR2Note(ym)`) — 名前だけ残すと次の人が「固定文言だ」と誤解する。
 *
 * @param ym **この運行が入っていた版の月** (= 出した計上額の月)。**この端末の
 *   キャッシュの月ではない** — 集計すべきなのはこちら。
 */
export function legSalesR2Note(ym: string): string {
  return '※ この計上額は、この端末ではなく R2 に保存された版から読んでいます。'
    + '最後に誰かが粗利タブで集計して保存した時点のものなので、それ以降に取り込んだデータは入っていません。'
    + `この運行の月 (${ym}) をこの端末の粗利タブで集計すると、この画面はそちらの結果に切り替わります。`
    + 'なお、この版は伝票番号を持っていないため便ごとの「伝票 …」は出ません '
    + '(計上額の内訳には要らないので保存していません — 伝票が無いという意味ではありません)。'
}

/** 計上額パネルが出すもの。**`ready` が無いときは必ず `note` を出す** (黙ると 0 円に読まれる)。 */
export interface LegSalesPanelState {
  /** 並べる中身。`null` なら並べるものが無い。 */
  ready: OperationLegSalesReady | null
  /** `ready` の出どころ。**見出しに出す。** */
  source: LegSalesSource | null
  /** 見出しに出す一行 (`この端末で集計した結果 (2026-07 の突合)`)。`ready` が無ければ空文字。 */
  sourceLabel: string
  /** `ready` の下に添える注記。**local は空文字** (見出しで足りる)。 */
  sourceNote: string
  /** `ready` が無いときの一言。**理由まで言う。** `ready` があれば `null`。 */
  note: string | null
}

/** 保存時刻の表示。**読めない値を空白にしない** (穴はレンダリングの不具合にしか読めない)。 */
function savedAtText(savedAt: string): string {
  const label = savedAtLabel(savedAt)
  return label === '' ? '保存時刻が読めません' : `${label} 保存`
}

/**
 * 見出しの一行。**出どころ・突合した月・(R2 なら) いつの版か**を必ず並べる。
 *
 * **`localYm` は「この端末のキャッシュは別の突合 (別の月) だ」という事実** (Refs #867)。
 * `not-aggregated` の端末で R2 の版から出したときに渡す — **版の月しか名乗らないと、
 * この端末が持っている月が画面から消える**。渡さない (`null`) のは、この端末に
 * そもそも突合結果が無い (`missing`) ときと local から出したとき。
 *
 * **ここには否定語を入れない。** この見出しは**金額が出ている行の横**に並ぶので、
 * 「ありません」の類を置くと出ている数字の方に掛かって読める (この repo で最も多い
 * 欠陥の型)。**月を名乗るだけ**にして、事情は下の注記
 * (`legSalesLocalOtherYmNote`) が出どころを名指しして言う。
 */
export function legSalesSourceLabel(
  source: LegSalesSource,
  ym: string,
  savedAt: string | null,
  localYm: string | null = null,
): string {
  const parts = [`${ym} の突合`]
  if (savedAt !== null) parts.push(savedAtText(savedAt))
  if (localYm !== null) parts.push(`この端末の集計は ${localYm}`)
  return `${LEG_SALES_SOURCE_NAMES[source]} (${parts.join(' / ')})`
}

/**
 * `not-aggregated` の端末が R2 の版から出したときに、`legSalesR2Note` の**後ろへ足す**
 * 一言 (Refs #867)。
 *
 * **足すのは「この出どころにしか無い新しい事実」1 つだけ** — **この端末は既に集計して
 * あるが、それは別の月で、この運行はそこに入っていない**。書かないと、
 * 「R2 から出した」だけが読まれて**この端末の集計が別の月だという事実が消える**
 * (次に粗利タブを開いた人が「もう集計してある」と読む)。
 *
 * **出どころと計上額の月は繰り返さない** — 見出し (`legSalesSourceLabel`) と
 * `legSalesR2Note` の 1 文目が既に言っている。**同じことを 3 か所で言うと、どれが本文か
 * 分からなくなる。**
 *
 * **否定は「そこ (この端末の別の月の突合) に入っていない」と出どころを名指しした形だけ**
 * にする。裸の「ありません」を金額の横に置かない。
 */
export function legSalesLocalOtherYmNote(localYm: string): string {
  return `この端末の粗利タブが集計してあるのは ${localYm} の突合で、そこにこの運行は入っていません。`
}

/**
 * R2 の版を見に行ってよいか (Refs #867)。**見ないのは `ready` のときだけ** —
 * この端末でこの運行を集計してあるので、**古い版で上書きしない**。
 *
 * **`missing` と `not-aggregated` はどちらも「この端末に**この運行の**答えが無い」**ので
 * 見に行く。#865 は `missing` だけを見ており、別の月を集計してある端末では
 * **R2 に版があるのに**「この運行はありません」しか出なかった (#867)。
 *
 * **画面 (`[unko_no].vue`) の取得ゲートはこの 1 行に寄せてある** — ここが壊れると
 * **集計直後の結果を古い版で上書きする**という一番危ない事故になるので、
 * 判断を画面側に散らさずテストで両側を固定する。
 */
export function shouldLoadLegSalesFromR2(local: OperationLegSalesLookup): boolean {
  return local.status !== 'ready'
}

/** 見に行った月を名乗る (Refs #867 で `checkedYmsSuffix` から切り出した)。 */
function checkedYmsPhrase(checkedYms: string[]): string {
  return `(確認した月: ${checkedYms.join(' / ')})`
}

/**
 * 見に行った月を添える一言。**1 つなら何も言わない** (本文が既にその月を書いている)。
 * 2 つ見たのに 1 つしか書かないと、「もう片方は見ていない」と読まれる。
 *
 * **`failed` はこちらを使わない** (Refs #867) — あの本文は月をどこにも書かないので、
 * 1 つのときに省くと「見に行かなかった」と区別が付かなくなる。
 */
function checkedYmsSuffix(checkedYms: string[]): string {
  if (checkedYms.length <= 1) return ''
  return ` ${checkedYmsPhrase(checkedYms)}`
}

/** R2 側が出せなかった理由。**どれも「0 円」ではない**ことが分かる書き方にする。 */
function r2Note(fetch: LegSalesR2Fetch): string {
  if (fetch.state === 'loading') return 'R2 に保存された版を確認しています…'
  if (fetch.state === 'no-date') {
    return 'この運行の日付が読めないため、R2 のどの月の版を見ればよいか決められませんでした。'
  }
  if (fetch.state === 'failed') {
    return `R2 に保存された版 ${checkedYmsPhrase(fetch.checkedYms)} も読めませんでした (${fetch.message})`
      + ` — 計上額が 0 円なのではありません。`
  }
  const tail = checkedYmsSuffix(fetch.checkedYms)
  const r = fetch.result
  if (r.status === 'no-version') {
    return `R2 にも ${r.ym} の保存された版がありません${tail} — 粗利タブでこの月を集計すると、この端末にも R2 にも残ります。`
  }
  if (r.status === 'unreadable') {
    return `R2 の版 (${r.ym}) の本文を読めませんでした${tail} — 計上額が 0 円なのではなく、読めていません。`
  }
  if (r.status === 'not-aggregated') {
    return `R2 の版 (${r.ym}、${savedAtText(r.savedAt)}) にもこの運行はありません${tail}。`
  }
  // `no-legs` — **`not-aggregated` と同じ文言にしない。** 版にこの運行は居る。
  return `R2 の版 (${r.ym}、${savedAtText(r.savedAt)}) にこの運行はありますが、便が 1 本もありません`
    + ` — 計上額を出す便が無いだけで、売上 0 円ではありません。`
}

/**
 * 計上額パネルが出すものを決める (Refs #865 / Refs #867)。**pure** — 取得はしない。
 *
 * **localStorage を先に見る順序は変えない** (集計直後の値が即反映される今の挙動を壊さない)。
 * **R2 を見ないのは `ready` のときだけ**:
 *
 * - `ready` — この端末でこの運行を集計してある。**R2 は見ない** (古い版で上書きしない)
 * - `not-aggregated` — この端末に**別の月**の結果がある。**R2 へ落ちる** (#867)。
 *   この端末に答えが無いことに変わりはなく、R2 に版があるなら出せる。
 *   ただし**出どころは 2 つの月を名乗って言い分ける** (`legSalesLocalOtherYmNote`)
 * - `missing` — R2 へ落ちる。**出せた回も出せなかった回も、出どころ / 理由を必ず言う**
 *
 * **どちらの落ち方でも、出せたときに `note` は `null`** — 数字が出ている横に
 * 「この運行はありません」を残さない (出ているものが別の意味に読める)。
 */
export function resolveLegSalesPanel(
  local: OperationLegSalesLookup,
  fetch: LegSalesR2Fetch,
): LegSalesPanelState {
  if (local.status === 'ready') {
    return {
      ready: local,
      source: 'local',
      sourceLabel: legSalesSourceLabel('local', local.ym, null),
      sourceNote: '',
      note: null,
    }
  }
  // **この端末が別の月を集計してある**ときだけ、その月を持ち回る (#867)。
  // `missing` は端末に突合結果そのものが無いので名乗る月が無い (`null`)。
  const localYm = local.status === 'not-aggregated' ? local.ym : null
  if (fetch.state === 'done' && fetch.result.status === 'ready') {
    const r = fetch.result
    return {
      ready: legSalesReadyLookup(r.ym, r.legs),
      source: 'r2',
      sourceLabel: legSalesSourceLabel('r2', r.ym, r.savedAt, localYm),
      // **`legSalesR2Note` 自身が「この運行の月 (`r.ym`) を集計すると切り替わる」と
      // 言う** ので、この端末が別の月を集計してあっても嘘にならない (#867)。
      // 足すのは**この端末が持っている月**という新しい事実 1 つだけ。
      sourceNote: legSalesR2Note(r.ym) + (localYm === null ? '' : legSalesLocalOtherYmNote(localYm)),
      note: null,
    }
  }
  // **この端末の事情と R2 の事情を両方言う。** 片方だけだと「もう片方は見ていない」
  // (あるいは「見たが黙っている」) と読まれる。**`not-aggregated` も同じ形で言う** —
  // 「この運行の月を粗利タブで集計すると出ます。」で終わらせると、R2 を見たことが
  // 伝わらない (#867)。`legSalesNote` の文末の `。` はこの連結のためにある。
  return {
    ready: null,
    source: null,
    sourceLabel: '',
    sourceNote: '',
    note: `${legSalesNote(local)} ${r2Note(fetch)}`,
  }
}
