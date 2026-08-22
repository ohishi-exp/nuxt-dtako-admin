import { describe, it, expect } from 'vitest'
import {
  KIND_BILLING_ONLY,
  KIND_UNBILLED,
  RELAY_DAY_WINDOW,
  findRelayGroups,
  nonTransportRowIds,
  transportSlips,
} from '~/utils/allowance-relay'
import type { VehicleDailySlip } from '~/utils/ichiban'

let seq = 0
function slip(over: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  seq += 1
  return {
    saleDate: '2026-07-16',
    vehicleNumber: '1318',
    customerCode: '041280',
    customerName: 'タイセイ飼料株式会社',
    originAreaName: '北海道釧路市',
    destAreaName: '北海道',
    origin: '釧路',
    dest: 'ユナイテッド牧場',
    isSubcontracted: false,
    amount: 43750,
    itemCode: '1531',
    itemName: '搾りﾏｯｼｭ',
    quantity: 12.5,
    unitPrice: 3500,
    unit: 't',
    rowId: `r${seq}`,
    requestKind: '0',
    ...over,
  }
}

/** 実データ (2026-07-16〜17、タイセイ飼料 搾りマッシュ 12.5t) の 3 行。 */
function realRelay() {
  return [
    slip({ requestKind: KIND_BILLING_ONLY, amount: 43750, rowId: '20260716-115' }),
    slip({ requestKind: KIND_UNBILLED, amount: 21750, dest: '駒場', rowId: '20260717-195' }),
    slip({
      requestKind: KIND_UNBILLED,
      amount: 22000,
      saleDate: '2026-07-17',
      vehicleNumber: '0040',
      origin: '駒場',
      rowId: '20260717-196',
    }),
  ]
}

describe('findRelayGroups', () => {
  it('通しの請求と、和が一致する按分を 1 組にする', () => {
    const groups = findRelayGroups(realRelay())
    expect(groups).toHaveLength(1)
    expect(groups[0]!.through.rowId).toBe('20260716-115')
    expect(groups[0]!.legs.map(l => l.amount)).toEqual([21750, 22000])
  })

  it('脚を日付順に並べる (渡す順に依存しない)', () => {
    const [through, a, b] = realRelay()
    const groups = findRelayGroups([through!, b!, a!])
    expect(groups[0]!.legs.map(l => l.saleDate)).toEqual(['2026-07-16', '2026-07-17'])
  })

  it('和が一致しなければ組にしない (推測で束ねない)', () => {
    const [through, a, b] = realRelay()
    expect(findRelayGroups([through!, a!, { ...b!, amount: 21999 }])).toEqual([])
  })

  it('得意先が違う按分は脚にしない', () => {
    const [through, a, b] = realRelay()
    expect(findRelayGroups([through!, a!, { ...b!, customerCode: '999999' }])).toEqual([])
  })

  it('品名が違う按分は脚にしない', () => {
    const [through, a, b] = realRelay()
    expect(findRelayGroups([through!, a!, { ...b!, itemCode: '9999' }])).toEqual([])
  })

  it('日数の窓の外にある按分は脚にしない', () => {
    const [through, a, b] = realRelay()
    const far = { ...b!, saleDate: '2026-07-30' }
    expect(findRelayGroups([through!, a!, far])).toEqual([])
    // 窓のちょうど端は入る (境界の両側を通す)。
    const edge = { ...b!, saleDate: '2026-07-23' }
    expect(RELAY_DAY_WINDOW).toBe(7)
    expect(findRelayGroups([through!, a!, edge])).toHaveLength(1)
  })

  it('日付が読めない明細は窓の外として扱う', () => {
    const [through, a, b] = realRelay()
    expect(findRelayGroups([through!, a!, { ...b!, saleDate: '' }])).toEqual([])
  })

  it('脚は 1 つの組にしか使わない (通しが 2 行あっても二重に出さない)', () => {
    // 実データ (2026-07 の 全酪連) で、同じ脚の組に通しが 2 行当たった。
    const [through, a, b] = realRelay()
    const groups = findRelayGroups([through!, { ...through!, rowId: 'dup' }, a!, b!])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.through.rowId).toBe('20260716-115')
  })

  it('脚が 3 本以上でも組にする', () => {
    const through = slip({ requestKind: KIND_BILLING_ONLY, amount: 100000, rowId: 't' })
    const legs = [25000, 50000, 25000].map((amount, i) =>
      slip({ requestKind: KIND_UNBILLED, amount, rowId: `l${i}` }))
    expect(findRelayGroups([through, ...legs])[0]!.legs).toHaveLength(3)
  })

  it('金額 0 の行は通しにも脚にもしない (和が 0 で偶然一致するのを防ぐ)', () => {
    const through = slip({ requestKind: KIND_BILLING_ONLY, amount: 0, rowId: 't' })
    const legs = [0, 0].map((amount, i) => slip({ requestKind: KIND_UNBILLED, amount, rowId: `l${i}` }))
    expect(findRelayGroups([through, ...legs])).toEqual([])
  })

  it('脚が 1 本しか無ければ組にしない (中継ではない)', () => {
    const through = slip({ requestKind: KIND_BILLING_ONLY, amount: 43750, rowId: 't' })
    const leg = slip({ requestKind: KIND_UNBILLED, amount: 43750, rowId: 'l' })
    expect(findRelayGroups([through, leg])).toEqual([])
  })

  it('通常運送 (請求K=0) だけなら組は出ない', () => {
    expect(findRelayGroups([slip(), slip()])).toEqual([])
    expect(findRelayGroups([])).toEqual([])
  })
})

describe('transportSlips / nonTransportRowIds', () => {
  it('請求のみ (請求K=1) を落とす', () => {
    const rows = [slip({ rowId: 'a' }), slip({ requestKind: KIND_BILLING_ONLY, rowId: 'b' })]
    expect(transportSlips(rows).map(s => s.rowId)).toEqual(['a'])
    expect(nonTransportRowIds(rows)).toEqual(new Set(['b']))
  })

  it('非請求 (請求K=2) は残す — 実際に走った脚なので便になる', () => {
    const rows = [slip({ requestKind: KIND_UNBILLED, rowId: 'c' })]
    expect(transportSlips(rows).map(s => s.rowId)).toEqual(['c'])
    expect(nonTransportRowIds(rows)).toEqual(new Set())
  })

  it('請求区分が空の明細は落とさない (古い API の応答を「請求のみ」と読まない)', () => {
    const rows = [slip({ requestKind: '', rowId: 'd' })]
    expect(transportSlips(rows).map(s => s.rowId)).toEqual(['d'])
    expect(nonTransportRowIds(rows)).toEqual(new Set())
  })
})
