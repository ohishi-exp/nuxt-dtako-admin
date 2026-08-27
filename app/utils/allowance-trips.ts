/**
 * デジタコのイベントCSV から「便」を切り出し、運行手当 (給与) を引く (pure)。
 *
 * **便 = 積みイベント。** 2026-07 の実データ (帯広 5 台) で、日を独占している運行
 * 72 本のうち **68 本で 積みの数 == 手当表PDF の便数** だった (94%)。降しの数は
 * 58% しか一致しない (1 回の積みで複数の牧場に降ろす便があるため)。合わなかった
 * 4 本のうち 2 本は月跨ぎで翌月分の便が手元の PDF に無いだけの計測上の差。
 *
 * 卸地は**その積みの次の積みが来るまでに降ろした最初の市町村**を採る。
 *
 * **「最後」ではない (2026-08-21 に帯広 5 台で訂正)。** 1109 には卸地が 2 つ以上に
 * 割れる便が 1 つも無く、どちらの規則でも同じ結果になっていた。他の 4 台で割れる便が
 * 8 件出て、**8 件とも手当表PDF の金額は最初の卸し地のもの**だった:
 *
 * ```
 * 苫小牧 → 帯広市富士町 → 清水町     PDF 「苫小牧〜清水・富士」 ¥12,000 = 苫小牧|富士
 * 帯広   → 士幌町       → 音更町     PDF 「帯広〜士幌」        ¥10,000 = 帯広|士幌
 * 広尾   → 安平町       → 帯広市富士町 PDF 「広尾〜安平」        ¥6,000  = 広尾|安平
 * 士幌   → 清水町       → 鹿追町     PDF 「士幌〜清水」        ¥8,000  = 士幌|清水DF
 * ```
 *
 * 手当表の `清水・富士` は**表記の順で、降ろした順ではない** (実際は 富士 が先)。
 * ここを「最後」と読んだのが元の誤りだった。
 */
import { colIndex, classifyTimeCategory, parseEventDatetimeToTs } from './event-data-table'
import { lookupAllowance, type AllowanceLookup } from './allowance-rate'
import type { RateRow } from './allowance-rate-master'

export interface AllowanceLeg {
  /** 積みイベントの行 index。 */
  loadRowIndex: number
  /** この便に属する降しイベントの行 index (複数卸しなら複数)。 */
  unloadRowIndexes: number[]
  /** 積みの `開始市町村名`。 */
  originCity: string
  /** **最初の**卸し地の `終了市町村名`。降しが 1 つも無ければ空。 */
  destCity: string
  /** 降ろした市町村を順に。最初が `destCity`。 */
  viaCities: string[]
  /** 積みの `開始日時` (epoch 秒)。読めなければ null。 */
  fromTs: number | null
  /** 最後の降しの `終了日時` (epoch 秒)。読めなければ null。 */
  toTs: number | null
}

/**
 * イベントCSV の行から便を切り出す。
 *
 * 最初の積みより前にある降し (前の運行の積み残し) は、属する積みが無いので捨てる。
 * 必要な列が無い CSV は空配列 (推測しない)。
 */
export function extractAllowanceLegs(headers: string[], rows: string[][]): AllowanceLeg[] {
  const nameIdx = colIndex(headers, 'イベント名')
  const startCityIdx = colIndex(headers, '開始市町村名')
  const endCityIdx = colIndex(headers, '終了市町村名')
  const startIdx = colIndex(headers, '開始日時')
  const endIdx = colIndex(headers, '終了日時')
  if ([nameIdx, startCityIdx, endCityIdx].some(i => i < 0)) return []

  const legs: AllowanceLeg[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const category = classifyTimeCategory(row[nameIdx] ?? '')
    if (category === 'loading') {
      legs.push({
        loadRowIndex: i,
        unloadRowIndexes: [],
        originCity: (row[startCityIdx] ?? '').trim(),
        destCity: '',
        viaCities: [],
        fromTs: parseEventDatetimeToTs(row[startIdx] ?? ''),
        toTs: null,
      })
      continue
    }
    const current = legs[legs.length - 1]
    if (category !== 'unloading' || !current) continue
    current.unloadRowIndexes.push(i)
    current.toTs = parseEventDatetimeToTs(row[endIdx] ?? '')
    const city = (row[endCityIdx] ?? '').trim()
    // 市町村名が欠けている降し行が実在する。空で上書きすると卸地を見失うので飛ばす。
    if (!city) continue
    current.viaCities.push(city)
    // 手当は**最初の**卸し地で決まる。後から来た降しで上書きしない。
    if (!current.destCity) current.destCity = city
  }
  return legs
}

/**
 * イベントCSV の `開始市町村名` / `終了市町村名` から市町村を取り出す。
 *
 * **列名に反して、入っているのは市町村名ではなく住所**
 * (`北海道釧路市西港１-98-41` / `北海道河東郡上士幌町上士幌東３線`)。
 * 2026-08-21 に本番の画面で実データを見て判明した。都道府県と郡を落として
 * 市区町村までを返す。
 *
 * 取り出せなければ**入力をそのまま返す** — 適当に切り詰めて別の場所に当たるより、
 * マスタで `unknown` になって人の目に触れる方が安全。
 */
const ADDRESS_CITY_RE = /^(?:.{2,3}[都道府県])(?:[^都道府県市区町村]{1,8}郡)?([^市区町村]{1,8}[市区町村])/

export function addressToCity(address: string): string {
  const trimmed = address.trim()
  return ADDRESS_CITY_RE.exec(trimmed)?.[1] ?? trimmed
}

/** `釧路市` → `釧路`。マスタの積地はこの粒度で書かれている。 */
export function cityToPlace(city: string): string {
  return city.trim().replace(/(市|町|村)$/, '')
}

/**
 * デジタコの市町村名 (`積地市|卸地市`) → マスタの卸地。
 *
 * 市町村名では届かない対応だけを書く。**帯広市の中の 川西・富士 は市町村名では
 * 潰れるが、積地が違えば金額も違う (釧路発 9,000 / 広尾発 8,000 / 苫小牧発 12,000)
 * ので、積地込みのキーなら一意に決まる。** 2026-07 の 313 便で給与が割れる組は 0 件。
 */
export const CITY_TO_DEST: Record<string, string> = {
  '士幌町|清水町': '清水DF',
  '広尾町|士幌町': '松山/士幌',
  '広尾町|帯広市': '富士',
  '広尾町|幕別町': '松山/札内',
  '苫小牧市|千歳市': '千代田',
  '苫小牧市|帯広市': '富士',
  '釧路市|別海町': 'ユナイテッド牧場',
  '釧路市|士幌町': '溝口',
  '釧路市|帯広市': '川西',
  '釧路市|標茶町': 'FCS標茶',
  '釧路市|音更町': 'ノベルズ音更',
}

/**
 * デジタコの `開始/終了市町村名` (実体は住所) から 1 便の運行手当を引く。
 *
 * `CITY_TO_DEST` に無ければ市町村名から `市/町/村` を落としてマスタを引く
 * (`本別町` → `本別` のように、マスタの卸地がそのまま町名の契約がある)。
 *
 * `master` は **R2 から解決したマスタ** (Refs #805 PR-2)。省略すると
 * `lookupAllowance` の既定 (`RATE_MASTER` = 同梱の初期値) に落ちる。
 * **既定を持たせない** — ここで `= RATE_MASTER` と書くと「渡し忘れ」と
 * 「初期値で計算してよい」が区別できなくなる。
 */
export function lookupAllowanceByCity(
  originCity: string,
  destCity: string,
  master?: RateRow[],
): AllowanceLookup {
  const origin = addressToCity(originCity)
  const dest = addressToCity(destCity)
  const mapped = CITY_TO_DEST[`${origin}|${dest}`]
  return lookupAllowance(cityToPlace(origin), mapped ?? cityToPlace(dest), master)
}

/**
 * 卸地の出どころ。
 *
 * - `event` … その便の中の降しイベントから取れた (確定)
 * - `carried` … **次の運行の先頭にある降しから引き継いだ (推定)**
 * - `forced` … **人が結んだ一番星の明細から決めた** (強制突合、
 *   `allowance-force-match.ts`)。降しイベントが 1 つも無い便の卸地はこれでしか決まらない
 */
export type DestSource = 'event' | 'carried' | 'forced'

export interface LegAllowance {
  leg: AllowanceLeg
  lookup: AllowanceLookup
  destSource: DestSource
}

/** 各便に手当を引き当てる。`master` は R2 から解決したマスタ (Refs #805 PR-2)。 */
export function allowanceForLegs(legs: AllowanceLeg[], master?: RateRow[]): LegAllowance[] {
  return legs.map(leg => ({
    leg,
    lookup: lookupAllowanceByCity(leg.originCity, leg.destCity, master),
    destSource: 'event' as const,
  }))
}

/**
 * 運行の**先頭** (最初の積みより前) にある降し = 前の運行の積み残しを降ろしたもの。
 *
 * 2026-07 の 1109 (中村 一由) で、卸地が決まらなかった便 3 件はすべて
 * **運行の最終便 (最後の積みの後に降しが 1 つも無い)** で、その降しは
 * **次の運行の先頭**に記録されていた (オンプレ `dtako_events` の 14 運行で確認):
 *
 * ```
 * 26070604185900000011091  [LULULUrLULUL   ← 末尾が積み (07-07 の便6)
 * 26070804190900000011091  [ULULUrLULU     ← 先頭が降し ★これが上の便の卸地
 * 26071504161600000011091  [LULULUrLULUL   ← 末尾が積み (07-16 の便6)
 * 26071704155800000011091  [ULULULUrLULU   ← 先頭が降し
 * 26073104154100000011091  [ULULUrLULUL    ← 先頭が降し / 末尾が積み (08-01 の便5)
 * ```
 *
 * (`L`=積み `U`=降し `r`=休息 `[`=運行開始)。積んだまま帰庫し、翌朝の運行の頭で
 * 降ろす形で、**イベントの欠落ではない**。
 */
export interface CarryInUnload {
  /** 最初の積みより前に降ろした市町村 (順に。市町村名が空の行は入らない)。 */
  cities: string[]

  /** その最後の降しの `終了日時` (epoch 秒)。読めなければ null。 */
  toTs: number | null
}

/** イベントCSV の先頭 (最初の積みより前) にある降しを取り出す。 */
export function extractCarryInUnloads(headers: string[], rows: string[][]): CarryInUnload {
  const nameIdx = colIndex(headers, 'イベント名')
  const endCityIdx = colIndex(headers, '終了市町村名')
  const endIdx = colIndex(headers, '終了日時')
  const carry: CarryInUnload = { cities: [], toTs: null }
  if (nameIdx < 0 || endCityIdx < 0) return carry
  for (const row of rows) {
    const category = classifyTimeCategory(row[nameIdx] ?? '')
    if (category === 'loading') break
    if (category !== 'unloading') continue
    carry.toTs = parseEventDatetimeToTs(row[endIdx] ?? '')
    const city = (row[endCityIdx] ?? '').trim()
    if (city) carry.cities.push(city)
  }
  return carry
}

/**
 * 運行の最終便に降しが 1 つも無いとき、**次の運行の先頭の降し**を卸地として引き継ぐ。
 *
 * 引き継いだ便は `destSource: 'carried'` になる。**推測で埋めているのではなく、
 * 実在する降しイベントを別の運行から持ってきている**が、便との対応づけは
 * 「運行をまたいだ隣接」という規則に頼っているので、確定した便とは区別して見せる。
 *
 * 降しが 1 つでもある便 (卸地の市町村名だけが空の便) には触らない — そちらは
 * 別の原因なので、引き継ぎで塗り潰すと間違いが黙って混ざる。
 */
export function carryOverDest(
  items: LegAllowance[],
  carryIn: CarryInUnload,
  master?: RateRow[],
): LegAllowance[] {
  const last = items[items.length - 1]
  if (!last || last.leg.unloadRowIndexes.length > 0 || carryIn.cities.length === 0) return items
  const leg: AllowanceLeg = {
    ...last.leg,
    destCity: carryIn.cities[0]!,
    viaCities: [...last.leg.viaCities, ...carryIn.cities],
    toTs: carryIn.toTs,
  }
  return [
    ...items.slice(0, -1),
    { leg, lookup: lookupAllowanceByCity(leg.originCity, leg.destCity, master), destSource: 'carried' },
  ]
}

export interface AllowanceTotals {
  /** 金額が決まった便の合計 (円)。 */
  totalYen: number
  /** 金額が決まった便数。 */
  okCount: number
  /** マスタで決まらなかった便。**人が見る対象**で、合計には入れない。 */
  irregular: LegAllowance[]
}

/** 便ごとの引き当てを合計する。決まらなかった便は合計に入れず、そのまま返す。 */
export function totalAllowance(items: LegAllowance[]): AllowanceTotals {
  let totalYen = 0
  let okCount = 0
  const irregular: LegAllowance[] = []
  for (const item of items) {
    if (item.lookup.status !== 'ok') {
      irregular.push(item)
      continue
    }
    totalYen += item.lookup.allowanceYen
    okCount += 1
  }
  return { totalYen, okCount, irregular }
}
