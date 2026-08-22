/**
 * **中継 (1 つの荷を複数の車輌でつなぐ運行) を一番星の明細から組み立てる** (pure)。
 *
 * 一番星は 1 運行を 2 台以上で分けたとき、伝票を**通しの請求 1 本 + 車輌ごとの
 * 按分 N 本**に割る。区別は `請求K` (`requestKind`):
 *
 * | 請求K | 意味 |
 * |---|---|
 * | `0` | 通常運送 (請求あり)。1 台で完結した普通の便 |
 * | `1` | **請求のみ** — 荷主への請求。運送そのものは表さない |
 * | `2` | **非請求** — 車輌収支用の按分。**実際に走ったのはこちら** |
 *
 * 実データ (2026-07-16〜17、タイセイ飼料 搾りマッシュ 12.5t):
 *
 * ```text
 * 請求K=1  07-16 車1318  釧路 → ユナイテッド牧場  ¥43,750   ← 通しの請求
 * 請求K=2  07-16 車1318  釧路 → 駒場             ¥21,750   ┐ 実際に走った 2 本
 * 請求K=2  07-17 車0040  駒場 → ユナイテッド牧場  ¥22,000   ┘ 和が通しと一致
 * ```
 *
 * 同じ経路を 1 台で走った日は `請求K=0` の通し 1 本 (¥43,750) で立つ (2026-07 に 9 回)。
 * **中継になった日だけ**この 3 行の形になる。
 *
 * ## 2 つの規則を分ける — 「運送でない」と「中継だと証明できた」
 *
 * **(1) `請求K=1` は運送を伴わない。これは例外なく効く。** 便を起こす材料にも
 * 強制突合の候補にもしない (`transportSlips` / `nonTransportRowIds`)。
 *
 * **(2) 中継として組にできるのは、金額の和が証明できたものだけ** (`findRelayGroups`)。
 * 署名は「同じ得意先C + 同じ品名C で、`請求K=2` の金額の和が `請求K=1` と
 * **ぴったり一致**する」こと。一致を条件から外すと、関係のない請求のみ行に脚を
 * ぶら下げてしまう。
 *
 * **(2) は中継の全部を拾わない。** 2026-07 の全社 116 件 (金額 > 0) で組にできたのは
 * 12 件で、残り 104 件の内訳は 1 つではない:
 *
 * - **料金・手数料の行** — 燃料油価格変動調整金 12 / 積み置き料金 5 / 出庫手数料 3 /
 *   貨物保険料 2 / 倉庫保管料 2 / 待機料・月極め・故障修理休車料 等。運送ではない
 * - **中継料** (品名C `4210`) 18 件 — 中継所の利用料 (得意先名が
 *   `株式会社 北海大運（滋賀中継所利用）`)。**中継に伴う料金であって運送ではない**
 * - **貨物名の行** 46 件 — うち 27 件は同じ得意先の `請求K=2` が ±7 日以内に居る
 *   (SBS東芝 `300mmウェーハ` ¥550,000、SUMCO `工場間輸送`、耶馬渓ファーム `乳牛` 等)。
 *   **通しの請求である可能性が高いが、和が一致しないので組にできない** — 脚が
 *   月をまたぐ・別の運行の按分が混ざる等で、この署名では届かない
 *
 * **⇒ 「組にできなかった = 中継ではない」と読まないこと。** 組にできたものだけを
 * 中継として見せ、それ以外は `請求K=1` (運送ではない) として扱うにとどめる。
 *
 * 成立した 12 組 (2026-07): 弘和産業 / 全酪連 / サカイ引越 / ダイチク / タイセイ飼料 /
 * 北海大石ファーム / 北海大運 / 梶原運輸 / ミナト重機 / 吉田海運。脚は 2〜4 本、
 * 日付は最大 3 日ずれた。
 *
 * ## 手当は脚ごとに引く
 *
 * **通しの請求には手当を付けない** — 走っていないので便ではない。手当は脚
 * (`請求K=2`) それぞれがマスタから引く (実例は `釧路 → 駒場` ¥4,500 と
 * `駒場 → ユナイテッド牧場` ¥4,500 で、片道ずつ)。売上も脚の按分額を使う。
 * **通しの ¥43,750 を足すと二重計上**になる。
 */
import type { VehicleDailySlip } from './ichiban'

/** 通しの請求 (`請求K=1`)。 */
export const KIND_BILLING_ONLY = '1'
/** 車輌収支用の按分 (`請求K=2`)。**実際に走った脚。** */
export const KIND_UNBILLED = '2'

/**
 * 脚を探す日数の窓 (前後何日まで見るか)。
 *
 * 2026-07 の 12 組で最大 3 日ずれた (`全酪連 07-24` の脚が `07-26`/`07-27`)。
 * 余裕を見て 7 日。**広げすぎると別の月の同じ荷を巻き込む**ので月内で足りる幅にする。
 */
export const RELAY_DAY_WINDOW = 7

/** 中継 1 組。 */
export interface RelayGroup {
  /** 通しの請求 (`請求K=1`)。**便ではない。** */
  through: VehicleDailySlip
  /** 実際に走った脚 (`請求K=2`)。日付順。 */
  legs: VehicleDailySlip[]
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD` 同士の日数差 (絶対値)。読めない日付は窓の外にする。 */
function dayGap(a: string, b: string): number {
  const gap = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY
  return Number.isFinite(gap) ? gap : Number.POSITIVE_INFINITY
}

/** 脚をまとめる鍵。**得意先と品名が同じものだけ**を候補にする。 */
function groupKey(slip: VehicleDailySlip): string {
  return `${slip.customerCode}|${slip.itemCode}`
}

/**
 * 金額の和が `target` になる組み合わせを探す (2 本以上)。
 *
 * 脚は 2026-07 の実データで最大 4 本だったので、**総当たりで足りる**。
 * 見つからなければ null。`used` に入っている脚は他の組で使い切られているので飛ばす。
 */
function findCombo(
  pool: VehicleDailySlip[],
  target: number,
  used: Set<string>,
): VehicleDailySlip[] | null {
  const free = pool.filter(s => !used.has(s.rowId))
  // **添字の組み合わせを 2 本以上で全部試す。** ビット全探索にすると本数の上限を
  // 別に決めることになるので、素直に再帰で積む。
  let found: VehicleDailySlip[] | null = null
  const walk = (start: number, picked: VehicleDailySlip[], sum: number) => {
    if (found !== null) return
    if (picked.length >= 2 && sum === target) {
      found = [...picked]
      return
    }
    // 金額は正なので、超えたらその枝は伸ばさない。
    if (sum >= target) return
    for (let i = start; i < free.length; i++) {
      picked.push(free[i]!)
      walk(i + 1, picked, sum + free[i]!.amount)
      picked.pop()
    }
  }
  walk(0, [], 0)
  return found
}

/**
 * 明細から中継の組を取り出す。
 *
 * **脚は 1 つの組にしか使わない。** 同じ荷に対して通しの請求が 2 行立つことがあり
 * (2026-07 の 全酪連 は `07-24` と `07-27` の 2 行が同じ脚の組に当たった)、
 * 使い回すと同じ運行が二重に出る。
 *
 * 通しの請求が新しい順に処理すると当たり方が日付に依存するので、**渡された順**に
 * 見て先に当たった方を採る (呼び出し側が並びを決められる)。
 */
export function findRelayGroups(slips: VehicleDailySlip[]): RelayGroup[] {
  const legPool = new Map<string, VehicleDailySlip[]>()
  for (const slip of slips) {
    if (slip.requestKind !== KIND_UNBILLED || slip.amount <= 0) continue
    const key = groupKey(slip)
    const list = legPool.get(key) ?? []
    list.push(slip)
    legPool.set(key, list)
  }
  const used = new Set<string>()
  const groups: RelayGroup[] = []
  for (const through of slips) {
    if (through.requestKind !== KIND_BILLING_ONLY || through.amount <= 0) continue
    const pool = (legPool.get(groupKey(through)) ?? [])
      .filter(s => dayGap(s.saleDate, through.saleDate) <= RELAY_DAY_WINDOW)
    const combo = findCombo(pool, through.amount, used)
    if (combo === null) continue
    for (const leg of combo) used.add(leg.rowId)
    groups.push({
      through,
      legs: [...combo].sort((a, b) => (a.saleDate > b.saleDate ? 1 : -1)),
    })
  }
  return groups
}

/**
 * **便として扱ってはいけない明細**の `rowId`。
 *
 * `請求K=1` は運送を伴わない請求行なので、中継の通しであっても純粋な請求のみで
 * あっても、**便を起こす材料にも強制突合の候補にもしない**。押せてしまうと、
 * 中継では脚とあわせて売上が二重に乗る (実例 +¥22,000)。
 *
 * **`請求K` が空 (古い API の応答) の明細は外さない。** 区分が取れないことを
 * 「請求のみ」と読むと、まだ deploy が回っていない間に本物の便が黙って消える。
 */
export function nonTransportRowIds(slips: VehicleDailySlip[]): Set<string> {
  return new Set(slips.filter(s => s.requestKind === KIND_BILLING_ONLY).map(s => s.rowId))
}

/** 便の材料になる明細だけに絞る (`請求K=1` を落とす)。 */
export function transportSlips(slips: VehicleDailySlip[]): VehicleDailySlip[] {
  return slips.filter(s => s.requestKind !== KIND_BILLING_ONLY)
}
