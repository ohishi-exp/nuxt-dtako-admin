/**
 * デジタコのイベントCSV から「便」を切り出し、運行手当 (給与) を引く (pure)。
 *
 * **便 = 積みイベント。** 2026-07 の実データ (帯広 5 台) で、日を独占している運行
 * 72 本のうち **68 本で 積みの数 == 手当表PDF の便数** だった (94%)。降しの数は
 * 58% しか一致しない (1 回の積みで複数の牧場に降ろす便があるため)。合わなかった
 * 4 本のうち 2 本は月跨ぎで翌月分の便が手元の PDF に無いだけの計測上の差。
 *
 * 卸地は**その積みの次の積みが来るまでに降ろした最後の市町村**を採る。手当表が
 * `清水・富士` のように複数卸しを 1 便として最終卸し地の金額で書いているのと揃う。
 */
import { colIndex, classifyTimeCategory, parseEventDatetimeToTs } from './event-data-table'
import { lookupAllowance, type AllowanceLookup } from './allowance-rate'

export interface AllowanceLeg {
  /** 積みイベントの行 index。 */
  loadRowIndex: number
  /** この便に属する降しイベントの行 index (複数卸しなら複数)。 */
  unloadRowIndexes: number[]
  /** 積みの `開始市町村名`。 */
  originCity: string
  /** 最終卸し地の `終了市町村名`。降しが 1 つも無ければ空。 */
  destCity: string
  /** 降ろした市町村を順に。最後が `destCity`。 */
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
    current.destCity = city
  }
  return legs
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
 * デジタコの市町村名から 1 便の運行手当を引く。
 *
 * `CITY_TO_DEST` に無ければ市町村名から `市/町/村` を落としてマスタを引く
 * (`本別町` → `本別` のように、マスタの卸地がそのまま町名の契約がある)。
 */
export function lookupAllowanceByCity(originCity: string, destCity: string): AllowanceLookup {
  const origin = cityToPlace(originCity)
  const mapped = CITY_TO_DEST[`${originCity.trim()}|${destCity.trim()}`]
  return lookupAllowance(origin, mapped ?? cityToPlace(destCity))
}

export interface LegAllowance {
  leg: AllowanceLeg
  lookup: AllowanceLookup
}

/** 各便に手当を引き当てる。 */
export function allowanceForLegs(legs: AllowanceLeg[]): LegAllowance[] {
  return legs.map(leg => ({ leg, lookup: lookupAllowanceByCity(leg.originCity, leg.destCity) }))
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
