import { describe, it, expect } from 'vitest'
import type { VehicleDailySlip } from '~/utils/ichiban'
import {
  MAX_LOAD_TONS,
  buildIchibanLegs,
  summarizeIchibanLegs,
} from '~/utils/allowance-ichiban-legs'

/** 2026-07 の実データ (車番 0040 枝番 01 / 0001 枝番 06 に載っていた行) の形。 */
function slip(over: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-07-18',
    vehicleNumber: '0040',
    customerCode: '015204',
    customerName: '大　石　畜　産',
    originAreaName: '北海道釧路市',
    destAreaName: '北海道浦幌町',
    origin: '釧路',
    dest: '浦幌',
    isSubcontracted: false,
    amount: 34403,
    itemCode: '1516',
    itemName: '大石後期',
    quantity: 12.51,
    unitPrice: 2750,
    unit: 'ｔ',
    rowId: '20260718-1',
    ...over,
  }
}
const build = (
  slips: VehicleDailySlip[],
  usedRowIds: string[] = [],
  provisional = {},
  coveredOrigins: string[] = [],
) => buildIchibanLegs('柳井 亮祐', slips, new Set(usedRowIds), new Set(coveredOrigins), '2026-07', provisional)

describe('buildIchibanLegs', () => {
  it('どのデジタコ便にも当たらなかった明細から便を起こし、マスタで手当を引く', () => {
    const legs = build([slip()])
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({
      driverName: '柳井 亮祐',
      date: '2026-07-18',
      origin: '釧路',
      dest: '浦幌',
      masterDest: '浦幌',
      allowanceYen: 9000,
      status: 'ok',
      salesYen: 34403,
      vehicleNumber: '0040',
    })
    expect(legs[0]!.quantity).toBeCloseTo(12.51)
  })

  it('デジタコ便に当たった明細は触らない (同じ仕事が二重に載るため)', () => {
    expect(build([slip()], ['20260718-1'])).toEqual([])
  })

  it('同じ日にデジタコ便があっても、当たらなかった明細からは起こす', () => {
    // 増地 07-18 の実データ: 釧路→川西 はデジタコ便に当たり、広尾→芽室 だけ余る
    const legs = build([
      slip({ saleDate: '2026-07-18', origin: '釧路', dest: '川西', destAreaName: '北海道帯広市', rowId: 'used' }),
      slip({ saleDate: '2026-07-18', origin: '広尾', dest: '大野ﾌｧｰﾑ', destAreaName: '北海道芽室町', unit: 't', quantity: 12.5, rowId: 'left' }),
    ], ['used'])
    expect(legs).toHaveLength(1)
    // 施設名 (`大野ﾌｧｰﾑ`) ではなく市町村名を採る — デジタコ側の経路キーと揃えるため
    expect(legs[0]).toMatchObject({ origin: '広尾', dest: '芽室', status: 'unknown', allowanceYen: null })
  })

  it('同じ日・同じ積地にデジタコ便があれば起こさない (複数卸しの片割れ)', () => {
    // 西島 07-21 の実データ: デジタコ便は 苫小牧発。余った `橋本畜産` は
    // PDF では `苫小牧 → 清水・富士` の一部で、別の便ではない
    const legs = build(
      [slip({ saleDate: '2026-07-21', origin: '苫小牧', dest: '橋本畜産', destAreaName: '北海道音更町', unit: 't', quantity: 6.5 })],
      [],
      {},
      ['2026-07-21|苫小牧'],
    )
    expect(legs).toEqual([])
  })

  it('積地が違えば、同じ日にデジタコ便があっても起こす', () => {
    const legs = build(
      [slip({ saleDate: '2026-07-18', origin: '広尾', dest: '大野ﾌｧｰﾑ', destAreaName: '北海道芽室町', unit: 't', quantity: 12.5 })],
      [],
      {},
      ['2026-07-18|釧路'],
    )
    expect(legs).toHaveLength(1)
    expect(legs[0]!.origin).toBe('広尾')
  })

  it('マスタに無い経路には暫定手当を当てる (デジタコ由来の便と同じ経路キー)', () => {
    const legs = build(
      [slip({ origin: '広尾', dest: '大野ﾌｧｰﾑ', destAreaName: '北海道芽室町', unit: 't', quantity: 12.5 })],
      [],
      { '広尾|芽室': 9000 },
    )
    expect(legs[0]).toMatchObject({ allowanceYen: 9000, isProvisional: true, status: 'unknown' })
  })

  it('マスタで決まる便には暫定を当てない', () => {
    const legs = build([slip()], [], { '釧路|浦幌': 99999 })
    expect(legs[0]).toMatchObject({ allowanceYen: 9000, isProvisional: false })
  })

  it('対象月の外の明細は返さない', () => {
    expect(build([slip({ saleDate: '2026-08-01' })])).toEqual([])
  })

  it('同じ日・同じ積地の明細は 1 便に畳む (卸地が違っても = 複数卸し)', () => {
    // 増地 07-31 の実データ: 広尾発 士幌 12.5t / 札内 6.5t / 音更 6t → PDF は 2 便
    const legs = build([
      slip({ saleDate: '2026-07-31', origin: '広尾', dest: '士幌', destAreaName: '北海道士幌町', quantity: 12.5, unit: 't' }),
      slip({ saleDate: '2026-07-31', origin: '広尾', dest: '札内　松山牧場', destAreaName: '北海道幕別町', quantity: 6.5, unit: 't', rowId: 'b' }),
      slip({ saleDate: '2026-07-31', origin: '広尾', dest: '音更', destAreaName: '北海道音更町', quantity: 6, unit: 't', rowId: 'c' }),
    ])
    expect(legs).toHaveLength(2)
    expect(legs.map(l => l.slips.length)).toEqual([1, 2])
    // **手当は最終卸し地で決まる** (札内・音更 の便は 音更 で引く)
    expect(legs[1]!.dest).toBe('音更')
    expect(legs[1]!.allowanceYen).toBe(9000)
  })

  it('1 台ぶんを超えたら分ける', () => {
    // 中村 07-24 の実データ: 釧路発 標茶 12t + 標茶 12t + 溝口 11.02t → PDF は 3 便
    const legs = build([
      slip({ saleDate: '2026-07-24', dest: '標茶FCS', destAreaName: '北海道標茶町', quantity: 12, unit: 'ｔ', amount: 36000 }),
      slip({ saleDate: '2026-07-24', dest: '標茶FCS', destAreaName: '北海道標茶町', quantity: 12, unit: 'ｔ', amount: 36000, rowId: 'b' }),
      slip({ saleDate: '2026-07-24', dest: '溝口牧場', destAreaName: '北海道士幌町', quantity: 11.02, unit: 'ｔ', amount: 42978, rowId: 'c' }),
    ])
    expect(legs).toHaveLength(3)
    // 並びは 日付 → 積地 → 卸地 なので 士幌(溝口) が先、標茶 が後ろ 2 つ
    expect(legs.map(l => l.allowanceYen)).toEqual([9000, 8000, 8000])
    // 施設名 (`標茶FCS`) では引けず、地域名 (`北海道標茶町` → `標茶`) で引けている
    expect(legs[1]!.masterDest).toBe('FCS標茶')
    expect(legs[0]!.masterDest).toBe('溝口')
  })

  it('1 台ぶんに収まるなら畳む', () => {
    // 柳井 07-22 帯広発: 4t+3.5t+3t+3.5t = 14t → PDF は 1 便
    const legs = build([1, 2, 3, 4].map(i => slip({
      saleDate: '2026-07-22', origin: '帯広', dest: '士幌　桑原牧場', destAreaName: '北海道士幌町',
      quantity: i === 1 ? 4 : 3.5, unit: 't', amount: 15200, rowId: `r${i}`,
    })))
    expect(legs).toHaveLength(1)
    expect(legs[0]!.quantity).toBeCloseTo(14.5)
    expect(legs[0]!.allowanceYen).toBe(10000)
  })

  it('単位が t でない明細は積載量で分けない (頭・箱は比べられない)', () => {
    const legs = build([1, 2, 3].map(i => slip({
      saleDate: '2026-07-19', origin: '清水', dest: '帯広', destAreaName: '北海道帯広市',
      quantity: 25, unit: '頭', amount: 10000, rowId: `h${i}`,
    })))
    expect(legs).toHaveLength(1)
    expect(legs[0]!.quantity).toBe(0)
  })

  it('マスタに無い経路は推測せず未確定にする', () => {
    // 増地 07-04 等の実データ (広尾 → 芽室)。マスタには広尾発の卸地が 12 通り
    // 載っているのに芽室が 1 行も無い (`allowance-provisional.ts` の実例)。
    const legs = build([slip({ saleDate: '2026-07-17', origin: '広尾', dest: '芽室', destAreaName: '北海道芽室町', quantity: 12.5, unit: 't' })])
    expect(legs[0]).toMatchObject({ status: 'unknown', allowanceYen: null, masterDest: '' })
    expect(legs[0]!.dest).toBe('芽室')
  })

  it('卸地の手がかりがまったく無い明細も落とさない', () => {
    const legs = build([slip({ dest: '', destAreaName: '' })])
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({ dest: '', status: 'unknown' })
  })

  it('地域名が着地Nと同じなら候補を重ねない', () => {
    const legs = build([slip({ dest: '浦幌', destAreaName: '浦幌' })])
    expect(legs[0]!.allowanceYen).toBe(9000)
  })

  it('日付 → 積地 → 卸地 の順に並べる (入れ替えが起きる順で渡す)', () => {
    const legs = build([
      slip({ saleDate: '2026-07-20', origin: '苫小牧', dest: '富士', destAreaName: '北海道帯広市', rowId: 'x' }),
      slip({ saleDate: '2026-07-18', rowId: 'y' }),
    ])
    expect(legs.map(l => l.date)).toEqual(['2026-07-18', '2026-07-20'])
  })

  it('最初から順に並んでいても崩さない (比較関数の両側を通す)', () => {
    const legs = build([
      slip({ saleDate: '2026-07-18', rowId: 'a' }),
      slip({ saleDate: '2026-07-20', origin: '苫小牧', dest: '富士', destAreaName: '北海道帯広市', rowId: 'b' }),
      slip({ saleDate: '2026-07-21', origin: '広尾', dest: '安平', destAreaName: '北海道安平町', rowId: 'c' }),
    ])
    expect(legs.map(l => l.date)).toEqual(['2026-07-18', '2026-07-20', '2026-07-21'])
  })

  it('明細が無ければ空', () => {
    expect(build([])).toEqual([])
  })
})

describe('summarizeIchibanLegs', () => {
  it('手当が決まった便と決まらなかった便を分けて数える', () => {
    const legs = build([
      slip(),
      slip({ saleDate: '2026-07-17', origin: '広尾', dest: '芽室', destAreaName: '北海道芽室町', unit: 't', amount: 22000 }),
    ])
    expect(summarizeIchibanLegs(legs)).toEqual({
      trips: 2,
      allowanceYen: 9000,
      provisionalYen: 0,
      provisionalTrips: 0,
      unknownTrips: 1,
      salesYen: 34403 + 22000,
    })
  })

  it('暫定を当てた便は「うち暫定」として別に数える', () => {
    const legs = build(
      [
        slip(),
        slip({ origin: '広尾', dest: '大野ﾌｧｰﾑ', destAreaName: '北海道芽室町', unit: 't', quantity: 12.5, amount: 41250, rowId: 'p' }),
      ],
      [],
      { '広尾|芽室': 9000 },
    )
    expect(summarizeIchibanLegs(legs)).toMatchObject({
      trips: 2, allowanceYen: 18000, provisionalYen: 9000, provisionalTrips: 1, unknownTrips: 0,
    })
  })

  it('便が無ければ全部 0', () => {
    expect(summarizeIchibanLegs([])).toEqual({
      trips: 0, allowanceYen: 0, provisionalYen: 0, provisionalTrips: 0, unknownTrips: 0, salesYen: 0,
    })
  })
})

describe('MAX_LOAD_TONS', () => {
  it('実データの上限 14t と、分けるべき 24t の間にある', () => {
    expect(MAX_LOAD_TONS).toBeGreaterThan(14)
    expect(MAX_LOAD_TONS).toBeLessThan(24)
  })
})
