import { describe, expect, it } from 'vitest'
import type { FuelIntankRow, FuelStart } from '~/types'
import { comparableDatetime, fuelPickCandidates, fuelQuantityText, startsCovering } from '~/utils/daily-report-fuel-pick'

function row(datetime: string, qt: number | null, vehicleCd: string | null | undefined, card = 1, dtakoRowId: string | null = null): FuelIntankRow {
  return {
    datetime, fuel_card_id: card, slip_num: 1, slip_num_parent: null, quantity: qt === null ? null : qt * 100, qt,
    type: null, detail: null, dtako_row_id: dtakoRowId, manual: null, id_st: null,
    car: vehicleCd === undefined ? undefined : { id: 'c', name: 'n', vehicle_cd: vehicleCd },
  }
}

describe('comparableDatetime', () => {
  it('theearth の 1 桁の時・分止まり・fuel の形をそろえる', () => {
    expect(comparableDatetime('2026/11/21 1:03:16')).toBe('2026-11-21 01:03')
    expect(comparableDatetime('2026/11/21 13:55')).toBe('2026-11-21 13:55')
    expect(comparableDatetime('2026-11-21 13:55:00')).toBe('2026-11-21 13:55')
  })
  it('読めない形・空は null', () => {
    expect(comparableDatetime('26/11/21 13:55')).toBeNull()
    expect(comparableDatetime('')).toBeNull()
    expect(comparableDatetime(null)).toBeNull()
    expect(comparableDatetime(undefined)).toBeNull()
  })
})

describe('startsCovering', () => {
  // 新しい順
  const starts: FuelStart[] = [
    { datetime: '2026-11-25 08:00:00', fuel_card_id: 9999, slip_num: 3 },
    { datetime: '2026-11-20 08:00:00', fuel_card_id: 9999, slip_num: 2 },
    { datetime: 'bad', fuel_card_id: 9999, slip_num: 1 },
    { datetime: '2026-11-10 08:00:00', fuel_card_id: 9999, slip_num: 0 },
  ]
  it('運行の時間帯にかかる start だけ (窓は次に新しい start の直前まで)', () => {
    expect(startsCovering(starts, '2026-11-21 05:00', '2026-11-22 18:00')).toEqual(['2026-11-20 08:00:00'])
  })
  it('境目をまたぐ運行は両方、最新の start は終わり無し', () => {
    expect(startsCovering(starts, '2026-11-24 20:00', '2026-11-26 10:00')).toEqual(['2026-11-25 08:00:00', '2026-11-20 08:00:00'])
    expect(startsCovering(starts, '2027-01-01 00:00', '2027-01-02 00:00')).toEqual(['2026-11-25 08:00:00'])
  })
  it('次の start の時刻ちょうどに始まる運行は前の start に入れない・読めない start は飛ばす', () => {
    expect(startsCovering(starts, '2026-11-25 08:00', '2026-11-25 09:00')).toEqual(['2026-11-25 08:00:00'])
    expect(startsCovering(starts, '2026-11-11 00:00', '2026-11-12 00:00')).toEqual(['2026-11-10 08:00:00'])
  })
  it('一番古い start より前の運行は空', () => {
    expect(startsCovering(starts, '2026-11-01 00:00', '2026-11-02 00:00')).toEqual([])
  })
})

describe('fuelQuantityText', () => {
  it('小数 1 桁以上、2 桁まで', () => {
    expect(fuelQuantityText(330)).toBe('330.0')
    expect(fuelQuantityText(330.5)).toBe('330.5')
    expect(fuelQuantityText(330.25)).toBe('330.25')
    expect(fuelQuantityText(-0.001)).toBe('0.0')
  })
})

describe('fuelPickCandidates', () => {
  const opeNo = '2611210441070000004031'
  const from = '2026-11-21 05:00'
  const to = '2026-11-21 18:00'
  it('車輌CD が一致し数量のある行だけ、運行中を先に日時順。先頭ゼロの差は吸収', () => {
    const rows = [
      row('2026-11-22 09:00:00', 100, '0000004031'),
      row('2026-11-21 13:55:00', 330, '4031'),
      row('2026-11-21 06:00:00', 50.25, '4031', 2),
      row('2026-11-20 06:00:00', 80, '4031'),
      row('2026-11-21 10:00:00', 999, '6572'),
      row('2026-11-21 10:00:00', null, '4031'),
      row('2026-11-21 11:00:00', 10, null),
      row('2026-11-21 12:00:00', 10, undefined),
      row('bad', 10, '4031'),
    ]
    const got = fuelPickCandidates(rows, opeNo, '4031', from, to, ['26/11/21 13:55'])
    expect(got.map(c => [c.dateTime, c.quantity, c.inOperation, c.alreadyEntered])).toEqual([
      ['26/11/21 06:00', '50.25', true, false],
      ['26/11/21 13:55', '330.0', true, true],
      ['26/11/20 06:00', '80.0', false, false],
      ['26/11/22 09:00', '100.0', false, false],
    ])
    expect(got[1]!.label).toBe('26/11/21 13:55 330.0L (運行中・入力済み)')
    expect(got[2]!.label).toBe('26/11/20 06:00 80.0L (運行外)')
    expect(got[0]!.key).toBe('2026-11-21 06:00:00;2')
  })
  it('dtako_row_id の先頭 22 桁がこの運行No の行は、時間帯の外でも最優先', () => {
    const rows = [
      row('2026-11-21 13:55:00', 330, '4031'),
      row('2026-11-22 20:00:00', 200, '4031', 1, `${opeNo}1`),
      row('2026-11-22 21:00:00', 10, '4031', 1, '99999999999999999999991'),
    ]
    const got = fuelPickCandidates(rows, opeNo, '4031', from, to, [])
    expect(got.map(c => [c.dateTime, c.linked, c.inOperation])).toEqual([
      ['26/11/22 20:00', true, false],
      ['26/11/21 13:55', false, true],
      ['26/11/22 21:00', false, false],
    ])
    expect(got[0]!.label).toBe('26/11/22 20:00 200.0L (この運行)')
  })
  it('同じ行が 2 つの start から来ても 1 つ', () => {
    const r = row('2026-11-21 13:55:00', 330, '4031')
    expect(fuelPickCandidates([r, { ...r }], opeNo, '4031', from, to, [])).toHaveLength(1)
  })
  it('日報行の車輌CD が読めなければ空', () => {
    expect(fuelPickCandidates([row('2026-11-21 13:55:00', 330, '4031')], opeNo, null, from, to, [])).toEqual([])
    expect(fuelPickCandidates([row('2026-11-21 13:55:00', 330, '4031')], opeNo, 'x', from, to, [])).toEqual([])
  })
})
