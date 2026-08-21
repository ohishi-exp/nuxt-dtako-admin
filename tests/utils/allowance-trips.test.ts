import { describe, it, expect } from 'vitest'
import {
  extractAllowanceLegs,
  addressToCity,
  cityToPlace,
  lookupAllowanceByCity,
  allowanceForLegs,
  totalAllowance,
  CITY_TO_DEST,
} from '~/utils/allowance-trips'

const HEADERS = ['イベント名', '開始日時', '終了日時', '開始市町村名', '終了市町村名']

/** イベントCSV の 1 行。列は HEADERS の順。 */
function ev(name: string, startCity = '', endCity = '', start = '2026/7/1 4:20:0', end = '2026/7/1 6:0:0') {
  return [name, start, end, startCity, endCity]
}

describe('extractAllowanceLegs', () => {
  it('積みごとに 1 便を作り、次の積みまでに降ろした最後の市町村を卸地にする', () => {
    const legs = extractAllowanceLegs(HEADERS, [
      ev('運行開始', '釧路市'),
      ev('積み', '釧路市'),
      ev('運転', '釧路市', '清水町'),
      ev('降し', '', '清水町'),
      ev('降し', '', '帯広市'),
      ev('積み', '苫小牧市'),
      ev('降し', '', '千歳市'),
    ])
    expect(legs).toHaveLength(2)
    expect(legs[0]).toMatchObject({
      originCity: '釧路市', destCity: '帯広市', viaCities: ['清水町', '帯広市'],
      loadRowIndex: 1, unloadRowIndexes: [3, 4],
    })
    expect(legs[1]).toMatchObject({ originCity: '苫小牧市', destCity: '千歳市', viaCities: ['千歳市'] })
  })

  it('最初の積みより前の降し (前の運行の積み残し) は捨てる', () => {
    const legs = extractAllowanceLegs(HEADERS, [
      ev('降し', '', '帯広市'),
      ev('積み', '釧路市'),
      ev('降し', '', '標茶町'),
    ])
    expect(legs).toHaveLength(1)
    expect(legs[0]!.destCity).toBe('標茶町')
  })

  it('降ろした市町村が空の行で卸地を潰さない', () => {
    const legs = extractAllowanceLegs(HEADERS, [
      ev('積み', '釧路市'),
      ev('降し', '', '標茶町'),
      ev('降し', '', ''),
    ])
    expect(legs[0]!.destCity).toBe('標茶町')
    expect(legs[0]!.viaCities).toEqual(['標茶町'])
    // 行 index は空でも記録する (画面から原本に戻れるように)
    expect(legs[0]!.unloadRowIndexes).toEqual([1, 2])
  })

  it('降しが 1 つも無い積みは卸地が空のまま', () => {
    const legs = extractAllowanceLegs(HEADERS, [ev('積み', '釧路市')])
    expect(legs[0]).toMatchObject({ destCity: '', viaCities: [], toTs: null })
  })

  it('日時を epoch 秒にする / 読めなければ null', () => {
    const legs = extractAllowanceLegs(HEADERS, [
      ev('積み', '釧路市', '', '2026/7/1 4:20:0'),
      ev('降し', '', '標茶町', '', '2026/7/1 9:30:0'),
    ])
    expect(legs[0]!.fromTs).toBe(Date.UTC(2026, 6, 1, 4, 20, 0) / 1000)
    expect(legs[0]!.toTs).toBe(Date.UTC(2026, 6, 1, 9, 30, 0) / 1000)
    const broken = extractAllowanceLegs(HEADERS, [ev('積み', '釧路市', '', 'こわれた')])
    expect(broken[0]!.fromTs).toBeNull()
  })

  it('列が足りない行・空行があっても落ちない', () => {
    // 空行はイベント名すら取れない。市町村名・日時が欠けた行と併せて、
    // 列が無い側の分岐を通す。
    const legs = extractAllowanceLegs(HEADERS, [[], ['積み'], ['降し'], []])
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({
      loadRowIndex: 1, unloadRowIndexes: [2],
      originCity: '', destCity: '', viaCities: [], fromTs: null, toTs: null,
    })
  })

  it('必要な列が無い CSV は推測せず空を返す', () => {
    expect(extractAllowanceLegs(['イベント名', '開始日時'], [ev('積み', '釧路市')])).toEqual([])
    expect(extractAllowanceLegs([], [])).toEqual([])
  })
})

describe('addressToCity', () => {
  // 列名は「開始市町村名」だが、実際に入っているのは住所。
  // 2026-08-21 に本番の画面で車輌 1109 の実データを見て確認した値。
  it('都道府県と郡を落として市区町村を取り出す', () => {
    expect(addressToCity('北海道釧路市西港１-98-41')).toBe('釧路市')
    expect(addressToCity('北海道河東郡士幌町中士幌')).toBe('士幌町')
    expect(addressToCity('北海道河東郡上士幌町上士幌東３線')).toBe('上士幌町')
    expect(addressToCity('北海道川上郡標茶町多和星空の黒牛加工・直売所')).toBe('標茶町')
    expect(addressToCity('北海道河東郡音更町豊田東４線')).toBe('音更町')
  })

  it('郡が無い住所も市まで取れる', () => {
    expect(addressToCity('北海道帯広市西22条南')).toBe('帯広市')
    expect(addressToCity('北海道苫小牧市入船町')).toBe('苫小牧市')
  })

  it('取り出せなければ入力をそのまま返す (裸の市町村名・空・都道府県だけ)', () => {
    expect(addressToCity('釧路市')).toBe('釧路市')
    expect(addressToCity('北海道')).toBe('北海道')
    expect(addressToCity('  ')).toBe('')
  })
})

describe('cityToPlace', () => {
  it('市町村の接尾辞を落とす', () => {
    expect(cityToPlace('釧路市')).toBe('釧路')
    expect(cityToPlace('士幌町')).toBe('士幌')
    expect(cityToPlace(' 中札内村 ')).toBe('中札内')
  })

  it('接尾辞が無ければそのまま', () => {
    expect(cityToPlace('富士')).toBe('富士')
  })
})

describe('lookupAllowanceByCity', () => {
  it('市町村名から給与を引く', () => {
    expect(lookupAllowanceByCity('釧路市', '上士幌町')).toMatchObject({ status: 'ok', allowanceYen: 9000 })
    expect(lookupAllowanceByCity('広尾町', '安平町')).toMatchObject({ status: 'ok', allowanceYen: 6000 })
  })

  it('帯広市は積地で金額が変わる (市町村名では潰れるが積地込みなら一意)', () => {
    expect(lookupAllowanceByCity('釧路市', '帯広市')).toMatchObject({ status: 'ok', allowanceYen: 9000 })
    expect(lookupAllowanceByCity('広尾町', '帯広市')).toMatchObject({ status: 'ok', allowanceYen: 8000 })
    expect(lookupAllowanceByCity('苫小牧市', '帯広市')).toMatchObject({ status: 'ok', allowanceYen: 12000 })
  })

  it('士幌町は積地で卸し先が変わる', () => {
    expect(lookupAllowanceByCity('釧路市', '士幌町')).toMatchObject({ status: 'ok', dest: '溝口' })
    expect(lookupAllowanceByCity('広尾町', '士幌町')).toMatchObject({ status: 'ok', dest: '松山/士幌' })
  })

  it('対応表に無い市町村は接尾辞を落としてマスタを引く', () => {
    expect(lookupAllowanceByCity('広尾町', '本別町')).toMatchObject({ status: 'ok', allowanceYen: 9000 })
    expect(lookupAllowanceByCity('帯広市', '大樹町')).toMatchObject({ status: 'ok', allowanceYen: 10000 })
  })

  it('マスタに無い経路は unknown (推測しない)', () => {
    expect(lookupAllowanceByCity('広尾町', '芽室町').status).toBe('unknown')
    expect(lookupAllowanceByCity('釧路市', '').status).toBe('unknown')
  })

  it('住所のまま渡しても引ける (本番の実データ 2026-07 車輌1109)', () => {
    const real: [string, string, number | null][] = [
      ['北海道釧路市西港１-98-41', '北海道河東郡士幌町中士幌', 9000],
      ['北海道釧路市西港１-98-41', '北海道河東郡上士幌町上士幌東３線', 9000],
      ['北海道釧路市西港２-101-1', '北海道川上郡標茶町多和', 8000],
      ['北海道釧路市西港２-101-1', '北海道川上郡標茶町多和星空の黒牛加工・直売所', 8000],
      ['北海道釧路市西港２-101-1', '北海道河東郡音更町豊田東４線', 9000],
      ['北海道釧路市西港１-98-41', '', null],
    ]
    for (const [origin, dest, yen] of real) {
      const got = lookupAllowanceByCity(origin, dest)
      if (yen === null) expect(got.status).toBe('unknown')
      else expect(got).toMatchObject({ status: 'ok', allowanceYen: yen })
    }
  })

  it('帯広市は住所で渡しても積地で金額が分かれる', () => {
    expect(lookupAllowanceByCity('北海道釧路市西港１', '北海道帯広市川西町'))
      .toMatchObject({ status: 'ok', allowanceYen: 9000, dest: '川西' })
    expect(lookupAllowanceByCity('北海道広尾郡広尾町会所前', '北海道帯広市富士町'))
      .toMatchObject({ status: 'ok', allowanceYen: 8000, dest: '富士' })
  })

  it('対応表のキーは 積地市|卸地市 の形', () => {
    for (const key of Object.keys(CITY_TO_DEST)) expect(key).toContain('|')
  })
})

describe('allowanceForLegs / totalAllowance', () => {
  const legs = extractAllowanceLegs(HEADERS, [
    ev('積み', '釧路市'),
    ev('降し', '', '上士幌町'),
    ev('積み', '釧路市'),
    ev('降し', '', '標茶町'),
    ev('積み', '広尾町'),
    ev('降し', '', '芽室町'),
  ])

  it('便ごとに手当を引き当てる', () => {
    const items = allowanceForLegs(legs)
    expect(items.map(i => i.lookup.status)).toEqual(['ok', 'ok', 'unknown'])
  })

  it('決まった便だけ合計し、決まらなかった便はそのまま返す', () => {
    const totals = totalAllowance(allowanceForLegs(legs))
    expect(totals).toMatchObject({ totalYen: 17000, okCount: 2 })
    expect(totals.irregular).toHaveLength(1)
    expect(totals.irregular[0]!.leg.destCity).toBe('芽室町')
  })

  it('空なら 0', () => {
    expect(totalAllowance([])).toEqual({ totalYen: 0, okCount: 0, irregular: [] })
  })
})
