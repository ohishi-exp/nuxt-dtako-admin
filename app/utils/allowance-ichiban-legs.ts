/**
 * **デジタコに運行が無い日の便を、一番星の明細から起こす** (pure)。
 *
 * デジタコを積んでいない車輌 (車番 `0001`) や、その日その乗務員の運行が alc に無い
 * 車番 (`0040` 等) で走った日は、**運行データが 1 件も無いので便が作れない**。
 * それでも仕事はしていて売上も立っている。2026-07 の帯広5台では手当表PDF の
 * **39 便 ¥344,000** がこれに当たり、画面の合計から落ちていた。
 *
 * 一番星の明細は **日付・積地・卸地・数量・金額・乗務員CD** を持っているので、
 * **デジタコの代わりに便を起こせる。**
 *
 * ## 便の切り方 (実データで規則を確定させた)
 *
 * **同じ日・同じ積地の明細を畳み、積載量が 1 台ぶんを超えたら分ける。**
 *
 * **卸地では分けない。** 手当表PDF は `広尾 → 札内・音更` `苫小牧 → 清水・富士` のように
 * **複数卸しを 1 便**として扱うのに、一番星は卸地ごとに明細が分かれる。卸地で分けると
 * 便が水増しされる (2026-07 で 41 便 対 PDF 39 便になった)。
 * 2026-07 の手当表PDF と突き合わせて、観測した全ケースが一致した:
 *
 * | 日 | 一番星の明細 | PDF | 畳んだ結果 |
 * |---|---|---|---|
 * | 柳井 07-22 釧路発 | 川西 7.01t + 川西 5.52t | **1 便** | 12.53t ≤ 15t → 1 便 |
 * | 柳井 07-22 帯広発 | 士幌 4t+3.5t+3t+3.5t | **1 便** | 14t ≤ 15t → 1 便 |
 * | 中村 07-24 釧路発 | 標茶 12t + 標茶 12t + 溝口 11.02t | **3 便** | 35.02t → 3 便 |
 * | 増地 07-31 広尾発 | 士幌 12.5t + 札内 6.5t + 音更 6t | **2 便** | 12.5t / 12.5t (**札内・音更 が 1 便**) |
 * | 西島 07-17 士幌発 | 清水 14t | **1 便** | 1 便 |
 *
 * **数量の単位が t でない明細 (`頭`/`箱` 等) は分けない** — 積載量として比べられない。
 *
 * ## 手当は**最終卸し地**で決まる
 *
 * 複数卸しの便は、`allowance-rate.ts` の `placeKey` と同じく**最後に降ろした地**で
 * 手当を引く。**引けなければ手前の卸地へ遡って試す** — 一番星の `着地N` は施設名
 * (`橋本畜産`) のことがあり、最後の 1 つだけを見ると引けずに未確定へ落ちる。
 *
 * ## 卸地は 2 通り試す
 *
 * 一番星の `着地N` は施設名寄り (`標茶FCS` / `溝口牧場` / `清水　ﾉﾍﾞﾙｽﾞDF`) で、
 * マスタの語彙と噛み合わないことがある。**`着地N` で引けなければ `着地域C` 由来の
 * 市区町村名 (`北海道標茶町` → `標茶`) で引き直す。** 逆に `ユナイテッド牧場` のように
 * **地域名が `北海道` までしか無い**代わりに施設名がマスタの語彙そのもの、という行も
 * あるので、どちらか一方では足りない。
 *
 * **推測で金額を作らない。** マスタで決まらなければ `unknown` のまま返し、呼び出し側が
 * 「未確定」として人に見せる (この画面の他の便と同じ扱い)。
 */
import { lookupAllowance, placeKey, normalizePlace, type AllowanceLookup } from './allowance-rate'
import { areaTown } from './allowance-ichiban'
import type { VehicleDailySlip } from './ichiban'

/**
 * 1 台ぶんの積載量 (t)。**これを超えたら別の便**にする。
 *
 * 実データの上限は 14t (柳井 07-22 帯広→士幌 の 4 明細合計) で、これは 1 便。
 * 標茶の 12t + 12t は 2 便。**14 と 24 の間**なら規則は同じなので、切りの良い 15 を採る。
 */
export const MAX_LOAD_TONS = 15

/** 数量を積載量として足してよい単位か。全角 `ｔ` も来る。 */
function isTons(unit: string): boolean {
  return normalizePlace(unit).toLowerCase() === 't'
}

/** 一番星から起こした 1 便。 */
export interface IchibanLeg {
  driverName: string
  /** `YYYY-MM-DD` (売上年月日)。 */
  date: string
  /** マスタ語彙に寄せた積地。 */
  origin: string
  /** 表示用の卸地 (引けたらマスタの語彙、引けなければ一番星の生値)。 */
  dest: string
  /** 引き当てたマスタの卸地。決まらなければ空。 */
  masterDest: string
  /** 決まらなければ null。 */
  allowanceYen: number | null
  status: AllowanceLookup['status']
  /** その便に畳んだ明細の売上合計。 */
  salesYen: number
  quantity: number
  /** 畳んだ明細 (内訳を人が見るため)。 */
  slips: VehicleDailySlip[]
  /** 一番星の車番 (`0001` / `0040` 等)。**どの車で走ったかを隠さない。** */
  vehicleNumber: string
}

/** 卸地の候補を 2 通り作る。`着地N` を先に、`着地域C` 由来の市区町村名を後に。 */
function destCandidates(slip: VehicleDailySlip): string[] {
  const out: string[] = []
  const raw = normalizePlace(slip.dest)
  if (raw) out.push(raw)
  const town = areaTown(slip.destAreaName)
  if (town && town !== raw) out.push(town)
  return out
}

/**
 * 便 1 つぶん (複数卸しなら複数明細) の積地・卸地をマスタで引く。
 *
 * **最終卸し地から遡って試し、先に `ok` になった候補を採る。** どれも引けなければ
 * 最終卸し地の見え方をそのまま返して `unknown` にする (推測で金額を作らない)。
 */
function resolve(group: VehicleDailySlip[]): { origin: string, dest: string, lookup: AllowanceLookup } {
  const origin = placeKey(group[0]!.origin)
  const candidates = [...group].reverse().flatMap(destCandidates)
  let fallback: { dest: string, lookup: AllowanceLookup } | null = null
  for (const dest of candidates) {
    const lookup = lookupAllowance(origin, dest)
    if (lookup.status === 'ok') return { origin, dest, lookup }
    if (fallback === null) fallback = { dest, lookup }
  }
  if (fallback === null) return { origin, dest: '', lookup: { status: 'unknown', dest: '' } }
  return { origin, dest: fallback.dest, lookup: fallback.lookup }
}

/** 同じ日・同じ経路の明細を、1 台ぶんずつの便に切る。 */
function splitByLoad(slips: VehicleDailySlip[]): VehicleDailySlip[][] {
  const out: VehicleDailySlip[][] = []
  let current: VehicleDailySlip[] = []
  let load = 0
  for (const slip of slips) {
    // 単位が t でない明細は積載量として比べられないので、切らずに同じ便へ入れる。
    const tons = isTons(slip.unit) ? slip.quantity : 0
    if (current.length > 0 && load + tons > MAX_LOAD_TONS) {
      out.push(current)
      current = []
      load = 0
    }
    current.push(slip)
    load += tons
  }
  if (current.length > 0) out.push(current)
  return out
}

function toLeg(driverName: string, date: string, group: VehicleDailySlip[]): IchibanLeg {
  const first = group[0]!
  const { origin, dest, lookup } = resolve(group)
  return {
    driverName,
    date,
    origin,
    dest,
    masterDest: lookup.status === 'ok' ? lookup.dest : '',
    allowanceYen: lookup.status === 'ok' ? lookup.allowanceYen : null,
    status: lookup.status,
    salesYen: group.reduce((sum, s) => sum + s.amount, 0),
    quantity: group.reduce((sum, s) => sum + (isTons(s.unit) ? s.quantity : 0), 0),
    slips: group,
    vehicleNumber: first.vehicleNumber,
  }
}

/** 並べ替えのキー。日付 → 積地 → 卸地 の順に固定する (`localeCompare` は使わない)。 */
function legSortKey(leg: IchibanLeg): string {
  return `${leg.date}|${leg.origin}|${leg.dest}`
}

/**
 * **デジタコに便が 1 つも無い日**の明細から便を起こす。
 *
 * `coveredDates` はその乗務員にデジタコ由来の便がある日 (`YYYY-MM-DD`)。
 * **その日は触らない** — 一部だけ取れている日に足すと、同じ仕事が二重に載る。
 * 「まるごと無い日」だけを埋めるので、足しすぎない代わりに埋め残しは出る。
 *
 * `ym` は対象月 (`2026-07`)。月の外の明細は返さない。
 */
export function buildIchibanLegs(
  driverName: string,
  slips: VehicleDailySlip[],
  coveredDates: Set<string>,
  ym: string,
): IchibanLeg[] {
  const byKey = new Map<string, VehicleDailySlip[]>()
  for (const slip of slips) {
    const date = slip.saleDate.slice(0, 10)
    if (!date.startsWith(ym)) continue
    if (coveredDates.has(date)) continue
    // **積地だけで束ねる。** 卸地で分けると複数卸しの便が水増しされる。
    const key = `${date}|${placeKey(slip.origin)}`
    const list = byKey.get(key) ?? []
    list.push(slip)
    byKey.set(key, list)
  }
  const legs: IchibanLeg[] = []
  for (const [key, group] of byKey) {
    const date = key.slice(0, 10)
    for (const part of splitByLoad(group)) legs.push(toLeg(driverName, date, part))
  }
  return legs.sort((a, b) => (legSortKey(a) > legSortKey(b) ? 1 : -1))
}

/** 一番星から起こした便の合計。**確定の手当とは別に数える。** */
export interface IchibanLegTotals {
  trips: number
  /** マスタで金額が決まった便の手当合計。 */
  allowanceYen: number
  /** 金額が決まらなかった便数。 */
  unknownTrips: number
  salesYen: number
}

export function summarizeIchibanLegs(legs: IchibanLeg[]): IchibanLegTotals {
  const out: IchibanLegTotals = { trips: 0, allowanceYen: 0, unknownTrips: 0, salesYen: 0 }
  for (const leg of legs) {
    out.trips += 1
    out.salesYen += leg.salesYen
    if (leg.allowanceYen === null) out.unknownTrips += 1
    else out.allowanceYen += leg.allowanceYen
  }
  return out
}
