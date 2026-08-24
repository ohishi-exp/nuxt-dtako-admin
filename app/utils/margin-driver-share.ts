/**
 * 粗利タブ「乗務員 / 運行」の表の**直後**に出す、**乗務員ごとの 100% 積み上げ棒**の素材
 * (Refs #760 の 39)。pure — DOM も fetch も持たない。
 *
 * オーナー (2026-08-23): 「乗務員毎の 100% 積み上げグラフ をこの後に追加」。
 *
 * ## 既存の「売上の内訳 (取引先ごと)」の乗務員版でしかない
 *
 * 区分 (`ShareSegmentKey` の 5 つ)・凡例・色・先頭に「合計」を置く流儀・pct を丸めない
 * ところまで `margin.ts` の `customerShareBars` に合わせてある。**新しい見せ方は 1 つも
 * 足していない。** 別ファイルなのは `app/utils/margin.ts` (95KB・粗利の不変条件が乗る
 * 中核) に足さないため。**新しい計算も 1 つも足していない** — 表がそのまま使っている
 * `DriverMargin.totals` (`MarginTotals`) を並べ替えているだけで、合計の棒も
 * `summarizeMargins` (中核) にもう一度畳ませて出す。
 *
 * ## 5 区分は**表の 5 列そのもの**
 *
 * | 区分 | 表の列 | `MarginTotals` |
 * |---|---|---|
 * | 手当 | 手当 | `allowanceYen` |
 * | 燃料代(売上走行) | 燃料代 (売上走行) | `fuelHaulYen` |
 * | 回送燃料 | 回送燃料 (按分) | `fuelDeadheadYen` |
 * | 運行経費の配分 | 直課経費 **+** 固定費按分 | `directCostYen + allocatedCostYen` |
 * | 粗利 | 粗利 | `marginYen` |
 *
 * 表は直課経費と固定費按分を別の列に持っているが、**棒では取引先版と同じ「運行経費の
 * 配分」1 区分に束ねる** (区分を増やすと 2 つの棒が見比べられなくなる)。
 *
 * ## 棒が 100% に届かないことがある (どちらも黙って埋めない)
 *
 * 分母は表と同じ `salesYen` (**運行ぜんぶ**)。手当も**運行ぜんぶ**だが、燃料・経費・粗利は
 * `MarginTotals` の流儀どおり**粗利を出せた運行ぶんだけ**なので、
 *
 * - **粗利を出せなかった運行** (`noMarginOperations > 0`) があると、その売上ぶんは
 *   どの色にも塗られない (取引先版の `unsplitLegs` と同じ扱い。画面は `*` を出す)
 * - **売上走行と回送に分けられなかった燃料代** (`fuelUnsplitYen > 0`。`区間距離` の列が
 *   無い CSV で来た運行) があると、そのぶんが 2 つの燃料区分のどちらにも入らない。
 *   **`fuelHaulYen` に寄せない** — 表の「燃料代 (売上走行)」の列も寄せずに
 *   「未分割 ¥x」と別に出しているので、棒だけ寄せると列と額が食い違う
 *
 * 逆に言えば、**この 2 つが 0 の乗務員は 5 区分の pct の和がちょうど 100** になる
 * (`MarginTotals` の不変条件
 * `marginSalesYen − marginAllowanceYen − fuelYen − directCostYen − allocatedCostYen === marginYen`
 * と `fuelYen === fuelHaulYen + fuelDeadheadYen + fuelUnsplitYen` から出る)。
 *
 * 表の数字・検算・CSV は触らない (表示専用)。
 */
import {
  costExceedsSalesAtYen,
  summarizeMargins,
  type DriverMargin,
  type MarginTotals,
  type ShareSegment,
  type ShareSegmentKey,
} from './margin'

/** 棒 1 本 (合計 / 乗務員)。`segments` は `SHARE_SEGMENT_LABELS` の順。 */
export interface DriverShareBar {
  /** 合計は `total`、乗務員は乗務員名 (表の行と同じ鍵)。 */
  key: string
  label: string
  /** 運行の本数 (**ぜんぶ**)。取引先版の `legs` に当たる。 */
  operations: number
  salesYen: number
  segments: ShareSegment[]
  /**
   * 費用 4 区分の和が売上を超えた行 (粗利 < 0) の超過分 `(Σ費用 − 売上) ÷ 売上 × 100`。
   * 棒は 100 に縮めてあるので、画面はこれを「赤字 −x%」で添える。超えていなければ 0。
   */
  overflowPct: number
  /** 粗利を出せなかった運行の本数。> 0 の行は棒が 100% に届かない。 */
  noMarginOperations: number
  /** 売上走行と回送に分けられなかった燃料代。> 0 の行は棒が 100% に届かない。 */
  fuelUnsplitYen: number
}

export interface DriverShareBars {
  /** 先頭は「合計」、続けて乗務員 (**渡された順のまま** = 表と同じ 乗務員CD 順)。 */
  bars: DriverShareBar[]
  /** 売上 0 の乗務員で棒にしなかった数。 */
  skipped: number
}

/**
 * 1 行を棒にする。売上 0 以下は棒にしない (null — 0 で割らない)。
 *
 * **4 区分の和が売上を超えた** 行は、粗利の pct を 0 にし、4 区分の pct を
 * `salesYen ÷ costSum` で縮めて合計 100 にする (棒をはみ出させない)。超過分は
 * `overflowPct` に出す。粗利が負でも和が売上を超えていなければ縮めない —
 * 粗利の pct だけ 0 に止める。**`customerShareBars` の `shareBarOf` と同じ**。
 *
 * ★ **超えたかどうかは `costExceedsSalesAtYen` (円に丸めてから比べる) で決める** (Refs #840)。
 * 判定を `margin.ts` と**同じ 1 つの関数**に預けてあるので、取引先別と乗務員別で挙動が割れない
 * (生の `costSum > salesYen` だと、粗利がちょうど 0 の行で尾だけの超過を拾って
 * **「赤字 −0%」が赤で出る**)。
 */
function driverShareBarOf(key: string, label: string, t: MarginTotals): DriverShareBar | null {
  if (t.salesYen <= 0) return null
  const costs: { key: ShareSegmentKey, yen: number }[] = [
    { key: 'allowance', yen: t.allowanceYen },
    { key: 'fuelHaul', yen: t.fuelHaulYen },
    { key: 'fuelDeadhead', yen: t.fuelDeadheadYen },
    // 表の 直課経費 + 固定費按分。取引先版の `runCostShareYen` と同じ束ね方。
    { key: 'runCost', yen: t.directCostYen + t.allocatedCostYen },
  ]
  const costSum = costs.reduce((sum, c) => sum + c.yen, 0)
  const overflow = costExceedsSalesAtYen(costSum, t.salesYen)
  const scale = overflow ? t.salesYen / costSum : 1
  return {
    key,
    label,
    operations: t.operations,
    salesYen: t.salesYen,
    segments: [
      ...costs.map(c => ({ key: c.key, yen: c.yen, pct: (c.yen * 100 * scale) / t.salesYen })),
      { key: 'margin', yen: t.marginYen, pct: (Math.max(0, t.marginYen) * 100) / t.salesYen },
    ],
    overflowPct: overflow ? ((costSum - t.salesYen) * 100) / t.salesYen : 0,
    noMarginOperations: t.noMarginOperations,
    fuelUnsplitYen: t.fuelUnsplitYen,
  }
}

/**
 * 乗務員 / 運行 の表の下に出す **売上 = 100% の横積み上げ棒**。
 *
 * - 渡すのは**画面が表に出しているのと同じ配列** (`visibleDrivers`)。並びも絞り込み
 *   (「粗利を出せない運行だけ」) も表と揃う — 棒だけ別の母集団になると読み違える
 * - 先頭の 1 本は**合計**。**乗務員の棒の和ではなく `summarizeMargins` にもう一度
 *   畳ませる** — 合計の出し方が中核と 1 つになり、棒だけずれる余地が無い
 * - **売上 0 以下の乗務員は棒にしない** (0 で割らない) → `skipped` に数える。
 *   合計には入れる (売上 0 でも手当・経費は乗っている)
 * - pct は丸めない (表示側で小数 1 桁)
 */
export function driverShareBars(drivers: DriverMargin[]): DriverShareBars {
  let skipped = 0
  const bars: DriverShareBar[] = []
  for (const d of drivers) {
    const bar = driverShareBarOf(d.driverName, d.driverName, d.totals)
    if (bar === null) {
      skipped += 1
      continue
    }
    bars.push(bar)
  }
  const totalBar = driverShareBarOf('total', '合計', summarizeMargins(drivers.flatMap(d => d.operations)))
  return { bars: totalBar === null ? bars : [totalBar, ...bars], skipped }
}
