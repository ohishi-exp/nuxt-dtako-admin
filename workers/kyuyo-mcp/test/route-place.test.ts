// `src/route-place.ts` (app/utils/allowance-trips.ts + margin.ts の双子) のテスト。
// **同じ正規化になることは共有 fixture の golden (経路の行 `from`/`to`) が固定する**
// ので、ここは単体の境界だけを見る。
import { describe, expect, it } from 'vitest'
import { UNKNOWN_PLACE, addressToCity, cityToPlace, routePlace } from '../src/route-place'

describe('addressToCity (列名に反して中身は住所)', () => {
  it('都道府県と郡を落として市区町村までを返す', () => {
    expect(addressToCity('北海道釧路市西港1-98-41')).toBe('釧路市')
    expect(addressToCity('北海道河東郡上士幌町上士幌東3線')).toBe('上士幌町')
    expect(addressToCity('北海道川上郡標茶町多和星空の黒牛')).toBe('標茶町')
    expect(addressToCity('北海道野付郡別海町中西別')).toBe('別海町')
  })

  it('前後の空白は落とす', () => {
    expect(addressToCity('  北海道帯広市川西町  ')).toBe('帯広市')
  })

  it('取り出せなければ入力をそのまま返す (適当に切り詰めない)', () => {
    expect(addressToCity('釧路')).toBe('釧路')
    expect(addressToCity('')).toBe('')
  })
})

describe('cityToPlace', () => {
  it('末尾の 市/町/村 を 1 つだけ落とす', () => {
    expect(cityToPlace('釧路市')).toBe('釧路')
    expect(cityToPlace('標茶町')).toBe('標茶')
    expect(cityToPlace('鶴居村')).toBe('鶴居')
    expect(cityToPlace('釧路')).toBe('釧路')
  })
})

describe('routePlace', () => {
  it('住所でも語彙でも同じ端に落ちる', () => {
    expect(routePlace('北海道釧路市西港1-98-41')).toBe('釧路')
    expect(routePlace('釧路')).toBe('釧路')
  })

  it('空なら (不明)', () => {
    expect(routePlace('')).toBe(UNKNOWN_PLACE)
    expect(routePlace('   ')).toBe(UNKNOWN_PLACE)
  })
})
