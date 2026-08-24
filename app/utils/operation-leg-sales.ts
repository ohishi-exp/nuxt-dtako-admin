/**
 * 運行詳細 (`/operations/{運行NO}`) で**便ごとに「当たった一番星の売上」**を出す素材
 * (pure、Refs #820)。
 *
 * オーナーの言葉は「どの一番星の売り上げと紐づいてるか表示できないか」。粗利タブは
 * 突合済みで取引先も金額も出しているのに、実運行の側から辿れなかった。
 *
 * ```
 * 便1  ¥41,250   ○○牧場                        伝票 20260703-12
 * 便2  ¥82,206   △△商事 ¥50,000 / □□run ¥32,206  伝票 20260703-13, 20260703-14
 * 便3  一番星の明細に当たっていません
 * ```
 *
 * ## ★ 運行詳細で突合をやり直してはいけない
 *
 * `reconcileVehicles` (`allowance-ichiban.ts`) は**明細のプールを順に消費する**
 * (`pool = res.poolLeftovers`)。1 運行だけで突合し直すと、月次の突合が別の運行に
 * 割り当てた明細に当たり得る — 粗利タブと違う金額が出る画面になり、どちらが正しいか
 * 分からなくなる。**だからここには突合が 1 行も無い。**
 * 粗利タブが突合したときに書いたものを読むだけ。
 *
 * ## ★ 既存キャッシュには明細が入っていない
 *
 * `MarginCache` (`margin.ts`) は「便の元になる一番星の明細はキャッシュに持っていない
 * (量が桁違い)」ので合計だけを畳んで持つ。⇒ **既存キャッシュからは読めない。**
 * `MARGIN_LEG_POINTS_KEY` / `UNCOVERED_BY_DRIVER_KEY` と同じ**別キーの作法**で、
 * 便ごとの**要約だけ**を持つ (`MarginCache` の形は変えない — 片方が壊れても
 * もう片方は動く)。
 *
 * ## 決まっていること (勝手に変えない)
 *
 * - **金額を 1 円も作らない・変えない。** 粗利タブが `customersOfSlips` で畳んだ
 *   `{ name, yen }` をそのまま持ち回るだけ (`Σ yen === LegReconcile.salesYen`)。
 *   突合も取引先の畳み方もここでは行わない
 * - **便 (`seq`) の切り方は粗利タブのもの。** 入力の鍵は `legKey()` が作った
 *   `${運行NO}#${seq}` で、運行詳細の側で便を切り直さない
 * - **明細まるごとは持たない** (量が桁違い)。取引先名 / 金額 と、伝票を指す
 *   `rowId` だけ。1 便あたり数十バイトに収める (下記の短い鍵)
 * - **当たっていない便も残す。** `customers` を空で持ち、読み側が「当たっていません」と
 *   言えるようにする。**空欄を 0 円と読ませない** — `legSaleYen()` は空の便に `null` を
 *   返し、`lookupOperationLegSales()` は 1 便も当たっていない運行の合計を `null` にする
 * - **無い運行は「無い」と言う。** 鍵が無ければ `missing`、鍵はあるがその運行が
 *   突合結果に居なければ `not-aggregated` (どちらも画面は「粗利タブで集計すると出ます」)。
 *   **推測で埋めない**
 * - **月違いを「運行の月 vs `ym`」で判定しない。** 粗利タブの月の切り方は運行の開始日
 *   (`buildMonthlyAllowanceByOperationDate`) で、運行詳細が持つ読取日とは 1 日ずれうる。
 *   独自の月判定を足すと「入っているのに月が違うと言う」偽の欠測が出るので、
 *   **その運行NO が突合結果に居るかどうか**だけで分け、居なければ `ym` を添えて出す
 */

import type { LegCustomerShare } from './margin'

/**
 * 便ごとの売上要約の保存先。**`MARGIN_CACHE_KEY` の形は変えない** (別のキーにする) —
 * 粗利の集計はこの要約を 1 円も見ないので、片方が壊れてももう片方は動く。
 */
export const OPERATION_LEG_SALES_KEY = 'dtako:operations:leg-sales:v1'

/**
 * 画面の見出し。**「粗利タブの計上額」と言い切る** (突合一本化 PR-1)。
 *
 * ## ★ #849 (PR-2) で「もう 1 つの数字」の正体が変わった
 *
 * 運行詳細には数字が 2 か所に出るが、**もう別のエンジンではない。** こちらは
 * **①が月全体を回した結果** (`reconcileVehicles`) のうちこの運行のぶんで、画面下の
 * 「収支パネル」は**その①に対する人の上書き** (`allowance-force-match.ts` の
 * `FORCE_MATCH_KEY`)。**結ぶとこちらの額も動く** (次の集計から)。
 *
 * **#849 より前は本当に別物だった** — あちらは②(`scoreVehicleDailySlips`、車番だけで
 * 引いた候補) の**検証スナップショット**で、`/profit/monthly` のマッチ率にしか効かず、
 * 粗利にも印刷にも乗らなかった。②はもう突合には使っていない (根拠バッジの目印にだけ
 * 残っている。撤去は PR-4)。**この doc と `LEG_SALES_PANEL_NOTE` が②の説明のままだと、
 * 「収支パネルで結んでも粗利には乗らない」という嘘になる** (#851 で実際に本番へ出た)。
 *
 * それでも**ラベルは分ける** — 「集計の結果」と「その結果への上書きの入力」は役割が
 * 違い、**結んだ直後は数字が一致しない** (次に粗利タブで集計するまで)。どちらが何なのかを
 * 毎回言うために定数にして固定する。
 */
export const LEG_SALES_TITLE = '粗利タブの計上額'

/**
 * 計上額を出しているときだけ添える注記。**下の収支パネルとの関係を毎回言う** (#851)。
 *
 * **誤読が 2 方向あるので、両方を塞ぐ。**
 *
 * 1. **「収支パネルで結んでも粗利には乗らない」** — #849 より前の事実で、いまは嘘。
 *    結んだ内容は粗利・乗務員別・取引先別・印刷に乗る。結ぶべき便を「どうせ乗らない」と
 *    読んで結ばなければ**売上が計上されない**
 * 2. **「結んだのにこの額が動かない = 効いていない」** — こちらは**前回の集計結果**
 *    (`OPERATION_LEG_SALES_KEY`) を読んでいるだけなので、結んだ直後に動かないのが正常。
 *    書かないと 1 を直したぶん今度はこちらを踏む
 *
 * **置き換えであって足し算ではない**ことも言う (`applyForcedSales` は便の突合結果を
 * 丸ごと差し替える)。収支パネル側の `FORCE_MATCH_OVERRIDE_NOTE` と同じことを、
 * **結ぶ前に上から読む人にも**見えるようにしておく。
 */
export const LEG_SALES_PANEL_NOTE
  = '※ 画面下の「収支パネル」は、この計上額を出した突合への人の上書きです (便に一番星の明細を手で結びます)。結んだ内容は次に粗利タブで集計したときにこの計上額へ反映されます — 置き換えであって足し算ではありません。結んだ直後にこの額が動かないのは正常です (この額は前回の集計結果を読んでいるだけなので、粗利タブで集計し直してからこの画面を開き直してください)。'

/** 便に当たった取引先 1 つぶん。`LegCustomerShare` の表示に要る 2 列だけ。 */
export interface OperationLegSaleCustomer {
  /** 取引先名 (粗利タブが `customersOfSlips` で採った、最初に見た明細のもの)。 */
  name: string
  /** その取引先ぶんの売上 (円)。 */
  yen: number
}

/** 便 1 本ぶんの売上要約。 */
export interface OperationLegSale {
  /** 便番号 (粗利タブ = 運行手当タブと同じ `seq`)。 */
  seq: number
  /**
   * 当たった取引先 (順は粗利タブのまま = 明細の初出順)。
   * **空なら「一番星の明細に当たっていない」** — 売上 0 円ではない。
   */
  customers: OperationLegSaleCustomer[]
  /** 当たった明細の `rowId` (伝票を特定できる識別子)。当たっていなければ空。 */
  slipIds: string[]
}

/** 運行NO → その運行の便の売上要約 (`seq` の昇順)。 */
export type OperationLegSalesByUnko = Record<string, OperationLegSale[]>

/** 保存する形。`ym` は突合した月 (`MarginCache.ym` と同じもの)。 */
export interface OperationLegSalesCache {
  ym: string
  byUnko: OperationLegSalesByUnko
}

/** `buildOperationLegSales` の入力 (便 1 本)。粗利タブの突合結果から作る。 */
export interface LegSalesInput {
  /** `legKey()` の値 (`${運行NO}#${seq}`)。 */
  key: string
  /** `customersOfSlips(hit.slips)` の結果。**畳み直さない。** */
  customers: readonly Pick<LegCustomerShare, 'name' | 'yen'>[]
  /** `hit.slips.map(s => s.rowId)`。 */
  slipIds: readonly string[]
}

/**
 * `${運行NO}#${seq}` を分ける。**壊れた鍵は `null`** (でっち上げの便を作らない)。
 *
 * **数字だけを便番号として受ける。** `Number('')` は 0 なので、`運行NO#` のような
 * 鍵をそのまま数にすると**存在しない「便0」**が画面に並ぶ。
 */
function splitLegKey(key: string): { unkoNo: string, seq: number } | null {
  const at = key.lastIndexOf('#')
  if (at <= 0) return null
  const seq = key.slice(at + 1)
  if (!/^\d+$/.test(seq)) return null
  return { unkoNo: key.slice(0, at), seq: Number(seq) }
}

/**
 * 粗利タブの突合結果を**運行NO 別・便ごとの要約**に畳む (Refs #820)。
 *
 * **突合はしない。** 渡された `customers` / `slipIds` をそのまま並べ替えるだけなので、
 * 金額は粗利タブが出したものと 1 円も違わない。**当たっていない便も落とさない**
 * (`customers: []` で残し、読み側が「当たっていません」と言えるようにする)。
 */
export function buildOperationLegSales(legs: Iterable<LegSalesInput>): OperationLegSalesByUnko {
  const byUnko: OperationLegSalesByUnko = {}
  for (const leg of legs) {
    const at = splitLegKey(leg.key)
    if (at === null) continue
    const list = byUnko[at.unkoNo] ?? []
    list.push({
      seq: at.seq,
      customers: leg.customers.map(c => ({ name: c.name, yen: c.yen })),
      slipIds: [...leg.slipIds],
    })
    byUnko[at.unkoNo] = list
  }
  for (const list of Object.values(byUnko)) list.sort((a, b) => a.seq - b.seq)
  return byUnko
}

/**
 * 保存する JSON の便 1 本。**鍵を 1 文字にしてある** — 1 便あたり数十バイトに
 * 収めるため (`{"s":1,"c":[["○○牧場",41250]],"r":["20260703-12"]}` ≒ 50 バイト、
 * 当たっていない便は `{"s":3}` ≒ 8 バイト)。`c` / `r` は空なら書かない。
 */
interface StoredLeg {
  /** `seq`。 */
  s: number
  /** 取引先 (`[名前, 円]` の組)。 */
  c?: [string, number][]
  /** 明細の `rowId`。 */
  r?: string[]
}

export function serializeOperationLegSales(cache: OperationLegSalesCache): string {
  const legs: Record<string, StoredLeg[]> = {}
  for (const [unkoNo, list] of Object.entries(cache.byUnko)) {
    legs[unkoNo] = list.map((leg) => {
      const stored: StoredLeg = { s: leg.seq }
      if (leg.customers.length > 0) stored.c = leg.customers.map(c => [c.name, c.yen])
      if (leg.slipIds.length > 0) stored.r = leg.slipIds
      return stored
    })
  }
  return JSON.stringify({ ym: cache.ym, legs })
}

/**
 * 保存済みの取引先。**1 つでも読めない組があれば `null`** を返し、呼び出し側が
 * **その便を丸ごと落とす**。読めたぶんだけ足すと、金額が黙って低く出る
 * (= 粗利タブが出した額を変えてしまう)。
 */
function storedCustomers(value: unknown): OperationLegSaleCustomer[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const out: OperationLegSaleCustomer[] = []
  for (const pair of value as unknown[]) {
    if (!Array.isArray(pair)) return null
    const [name, yen] = pair as unknown[]
    if (typeof name !== 'string' || typeof yen !== 'number' || !Number.isFinite(yen)) return null
    out.push({ name, yen })
  }
  return out
}

/** 保存済みの `rowId`。**1 つでも文字でなければ `null`** (便を丸ごと落とす)。 */
function storedSlipIds(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const id of value as unknown[]) {
    if (typeof id !== 'string') return null
    out.push(id)
  }
  return out
}

/** 保存済みの便 1 本。**読めなければ `null`** (推測で埋めない)。 */
function storedLeg(value: unknown): OperationLegSale | null {
  const leg = value as StoredLeg | null | undefined
  if (typeof leg?.s !== 'number' || !Number.isInteger(leg.s)) return null
  const customers = storedCustomers(leg.c)
  if (customers === null) return null
  const slipIds = storedSlipIds(leg.r)
  if (slipIds === null) return null
  return { seq: leg.s, customers, slipIds }
}

/**
 * 保存済みの便ごとの売上要約を読む。**壊れていても投げない** — 無かったことにする
 * (`parseMarginCache` / `parseLegPoints` と同じ流儀)。読めなかった便は
 * 「その運行の便として出てこない」= 画面が金額を語らないだけで、0 円にはならない。
 */
export function parseOperationLegSales(raw: string | null | undefined): OperationLegSalesCache | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const cache = parsed as { ym?: unknown, legs?: unknown }
  if (typeof cache.ym !== 'string') return null
  if (typeof cache.legs !== 'object' || cache.legs === null) return null
  const byUnko: OperationLegSalesByUnko = {}
  for (const [unkoNo, list] of Object.entries(cache.legs as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const legs: OperationLegSale[] = []
    for (const value of list as unknown[]) {
      const leg = storedLeg(value)
      if (leg !== null) legs.push(leg)
    }
    // **1 便も読めなかった運行は鍵を作らない** — 空の配列を残すと、画面が
    // 「突合済みだが便が 0 本」= 売上 0 円 に見える。`not-aggregated` に倒す。
    if (legs.length > 0) byUnko[unkoNo] = legs
  }
  return { ym: cache.ym, byUnko }
}

/**
 * 便 1 本の売上 (円)。**当たっていない便は `null`** — 0 を返すと画面が
 * 「売上 0 円の便」として出してしまう。
 */
export function legSaleYen(leg: OperationLegSale): number | null {
  if (leg.customers.length === 0) return null
  return leg.customers.reduce((sum, c) => sum + c.yen, 0)
}

/** 運行詳細が受け取る形。**`missing` / `not-aggregated` は「粗利タブで集計すると出ます」。** */
export type OperationLegSalesLookup =
  /** 突合結果がまだ無い (キーが無い / 読めなかった)。 */
  | { status: 'missing' }
  /** 突合結果はあるが、その運行が入っていない (別の月を集計している等)。 */
  | { status: 'not-aggregated', ym: string }
  /** その運行の便が読めた。 */
  | {
    status: 'ready'
    /** 突合した月 (`YYYY-MM`)。画面に添えて「いつの突合か」を言う。 */
    ym: string
    /** `seq` の昇順。当たっていない便も入っている。 */
    legs: OperationLegSale[]
    /** 当たったぶんの合計 (円)。**1 便も当たっていなければ `null`** (0 にしない)。 */
    salesYen: number | null
    /** 売上が当たった便の数。 */
    matchedLegs: number
    /** 当たらなかった便の数。 */
    unmatchedLegs: number
  }

/**
 * 突合結果が引けないときに**画面へ必ず出す一言** (Refs #820)。`ready` なら `null`。
 *
 * **推測で突合し直して埋めない**ので、「無い」ことを言うのがこの画面の仕事になる。
 * 何も言わずに空にすると「この運行には売上が無い (0 円)」と読まれる。
 *
 * **`missing` は「このブラウザの」と言う** — 保存先が localStorage なので、他端末・
 * 他ブラウザ・別の人からは必ず空に見える (PR-1 の既知の弱点。R2 へ移すのは PR-3)。
 * 「集計されていない」ではなく「この端末では集計されていない」が事実。
 */
export function legSalesNote(lookup: OperationLegSalesLookup): string | null {
  if (lookup.status === 'missing') return 'このブラウザの粗利タブで集計すると出ます (便ごとの突合結果がまだありません)'
  if (lookup.status === 'not-aggregated') {
    return `粗利タブの突合結果 (${lookup.ym}) にこの運行はありません。この運行の月を粗利タブで集計すると出ます`
  }
  return null
}

/**
 * その運行の便ごとの売上を引く (Refs #820)。**突合はしない・推測で埋めない。**
 *
 * @param cache `parseOperationLegSales` の返り値 (読めなければ `null`)
 * @param unkoNo 運行NO
 */
export function lookupOperationLegSales(
  cache: OperationLegSalesCache | null,
  unkoNo: string,
): OperationLegSalesLookup {
  if (cache === null) return { status: 'missing' }
  const legs = cache.byUnko[unkoNo]
  if (legs === undefined) return { status: 'not-aggregated', ym: cache.ym }
  let salesYen = 0
  let matchedLegs = 0
  for (const leg of legs) {
    const yen = legSaleYen(leg)
    if (yen === null) continue
    salesYen += yen
    matchedLegs++
  }
  return {
    status: 'ready',
    ym: cache.ym,
    legs,
    // **1 便も当たっていない運行の合計は `null`。** 0 と出すと「この運行の売上は
    // 0 円」と読めるが、実際は「一番星の明細に当たっていない」だけ。
    salesYen: matchedLegs === 0 ? null : salesYen,
    matchedLegs,
    unmatchedLegs: legs.length - matchedLegs,
  }
}

/**
 * **①が既にどこかの便へ当てた明細**を引いた結果 (Refs #848)。
 * `forceMatchCandidates` の `usedRowIds` に渡すためだけのもの。
 */
export type UsedSlipsLookup =
  /** 突合結果が無い / 読めない。**候補を出してはいけない。** */
  | { status: 'missing' }
  /** 突合結果はあるが、その運行が入っていない (別の月を集計している等)。**候補を出してはいけない。** */
  | { status: 'not-aggregated', ym: string }
  /** 使用済みの `rowId` が全部揃った。**このときだけ候補を出してよい。** */
  | { status: 'ready', ym: string, usedRowIds: Set<string> }

/**
 * **既にどこかの便に当たっている明細の `rowId`** を、保存済みの要約から集める
 * (Refs #848)。`byUnko` 全体の `slipIds` の和集合で、運行手当タブの
 * `usedSlipRowIds` (`byLeg` 全体の `slips[].rowId`) と同じもの — どちらも①の
 * `byLeg` から作られている。**①を回し直さない。**
 *
 * ## ★ 空集合に倒さない (倒すと同じ売上が 2 つの便に乗る)
 *
 * `forceMatchCandidates` は `usedRowIds` に入っていない明細を候補に出す。空を渡すと
 * **①が既に別の便へ当てた明細まで候補に並び**、人がそれを結べば**二重計上**になる。
 * だから読めないときは空の `Set` を返さず `missing` / `not-aggregated` を返し、
 * 呼び出し側に**候補欄そのものを出させない** (`usedSlipsNote` を出す)。
 *
 * ## ★ `parseOperationLegSales` より厳しい
 *
 * あちらは表示用で「読めた便だけ出す」(欠けても画面が金額を語らないだけ)。こちらは
 * **1 便でも読めなければ全部やめる** — 読めなかった便が当てていた明細が「まだ誰にも
 * 当たっていない」ように見え、そこが二重計上の口になるため。
 *
 * **その運行が入っているかどうかで分ける** — 月の判定を自前でやらない理由は
 * `lookupOperationLegSales` と同じ (粗利タブの月の切り方は運行の開始日で、
 * 運行詳細が持つ読取日とは 1 日ずれうる)。
 */
export function lookupUsedSlipIds(raw: string | null | undefined, unkoNo: string): UsedSlipsLookup {
  if (!raw) return { status: 'missing' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return { status: 'missing' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { status: 'missing' }
  const cache = parsed as { ym?: unknown, legs?: unknown }
  if (typeof cache.ym !== 'string') return { status: 'missing' }
  if (typeof cache.legs !== 'object' || cache.legs === null) return { status: 'missing' }
  const usedRowIds = new Set<string>()
  let hasOperation = false
  for (const [key, list] of Object.entries(cache.legs as Record<string, unknown>)) {
    if (!Array.isArray(list)) return { status: 'missing' }
    for (const value of list as unknown[]) {
      const leg = storedLeg(value)
      if (leg === null) return { status: 'missing' }
      for (const id of leg.slipIds) usedRowIds.add(id)
    }
    if (key === unkoNo && list.length > 0) hasOperation = true
  }
  if (!hasOperation) return { status: 'not-aggregated', ym: cache.ym }
  return { status: 'ready', ym: cache.ym, usedRowIds }
}

/**
 * 候補を出せないときに**画面へ必ず出す一言** (Refs #848)。`ready` なら `null`。
 *
 * **空の候補一覧を「結べる明細が無い」と読ませない。** 出していないのは
 * 「どれが空いているか分からないから」で、**明細が無いからではない**。
 */
export function usedSlipsNote(lookup: UsedSlipsLookup): string | null {
  if (lookup.status === 'missing') {
    return 'このブラウザの粗利タブでこの月を集計すると、結べる候補が出ます (どの明細が既に他の便に当たっているかが分からないため、候補を出していません)'
  }
  if (lookup.status === 'not-aggregated') {
    return `粗利タブの突合結果 (${lookup.ym}) にこの運行はありません。この運行の月を粗利タブで集計すると、結べる候補が出ます (どの明細が既に他の便に当たっているかが分からないため、候補を出していません)`
  }
  return null
}
