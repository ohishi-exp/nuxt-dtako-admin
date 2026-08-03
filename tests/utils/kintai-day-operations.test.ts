import { describe, it, expect } from 'vitest'
import { parseKintaiDayOperations, isKintaiDayOperationUnkoNo23Digit } from '~/utils/kintai-day-operations'

const OPE_NO_22 = '2606050753300000004286'
const UNKO_NO_23 = `${OPE_NO_22}1`
const START_OPE = '2026/06/05 7:53:30'

function body(over: Record<string, unknown> = {}) {
  return {
    driver_cd: '1526',
    date: '2026-03-11',
    operations: [
      { unko_no: UNKO_NO_23, ope_no: OPE_NO_22, start_ope: START_OPE, run_start: '2026-06-05 07:53:30', vehicle: '長崎100か1234' },
    ],
    ...over,
  }
}

describe('parseKintaiDayOperations', () => {
  it('運行1件をそのまま camelCase に読み替える', () => {
    expect(parseKintaiDayOperations(body())).toEqual({
      driverCd: '1526',
      date: '2026-03-11',
      operations: [
        { unkoNo: UNKO_NO_23, opeNo: OPE_NO_22, startOpe: START_OPE, runStart: '2026-06-05 07:53:30', vehicle: '長崎100か1234' },
      ],
    })
  })

  it('運行0件でも空配列 (「運行が無い」は正常な答え、エラーと混同しない)', () => {
    expect(parseKintaiDayOperations(body({ operations: [] }))).toEqual({
      driverCd: '1526',
      date: '2026-03-11',
      operations: [],
    })
  })

  it('run_start/vehicle が無い (null) 運行でも通す', () => {
    const r = parseKintaiDayOperations(
      body({ operations: [{ unko_no: UNKO_NO_23, ope_no: OPE_NO_22, start_ope: START_OPE, run_start: null, vehicle: null }] }),
    )
    expect(r.operations).toEqual([{ unkoNo: UNKO_NO_23, opeNo: OPE_NO_22, startOpe: START_OPE, runStart: null, vehicle: null }])
  })

  it('unko_no/ope_no/start_ope のいずれかが欠けている運行は落とす (捏造しない)', () => {
    expect(parseKintaiDayOperations(body({ operations: [{ ope_no: OPE_NO_22, start_ope: START_OPE }] })).operations).toEqual([])
    expect(parseKintaiDayOperations(body({ operations: [{ unko_no: UNKO_NO_23, start_ope: START_OPE }] })).operations).toEqual([])
    expect(parseKintaiDayOperations(body({ operations: [{ unko_no: UNKO_NO_23, ope_no: OPE_NO_22 }] })).operations).toEqual([])
  })

  it('複数運行をすべて並べる (自動で1件を選ばない)', () => {
    const opB = { unko_no: `${OPE_NO_22}2`, ope_no: '2606050900000000004287', start_ope: '2026/06/05 9:00:00', run_start: null, vehicle: null }
    const r = parseKintaiDayOperations(body({ operations: [body().operations[0], opB] }))
    expect(r.operations).toHaveLength(2)
  })

  it('raw が壊れた形 (null/非object/operations欠落/非配列要素) でも例外を投げず空配列に倒す', () => {
    expect(parseKintaiDayOperations(null)).toEqual({ driverCd: null, date: null, operations: [] })
    expect(parseKintaiDayOperations('garbage')).toEqual({ driverCd: null, date: null, operations: [] })
    expect(parseKintaiDayOperations({})).toEqual({ driverCd: null, date: null, operations: [] })
    expect(parseKintaiDayOperations({ operations: [null, 'x', 123] }).operations).toEqual([])
  })
})

describe('isKintaiDayOperationUnkoNo23Digit', () => {
  it('23桁の数字なら true', () => {
    expect(isKintaiDayOperationUnkoNo23Digit(UNKO_NO_23)).toBe(true)
  })

  it('22桁 (対象CD無し) は false', () => {
    expect(isKintaiDayOperationUnkoNo23Digit(OPE_NO_22)).toBe(false)
  })

  it('空文字/24桁/数字以外は false (捏造しない — あるものをそのまま判定するだけ)', () => {
    expect(isKintaiDayOperationUnkoNo23Digit('')).toBe(false)
    expect(isKintaiDayOperationUnkoNo23Digit(`${UNKO_NO_23}9`)).toBe(false)
    expect(isKintaiDayOperationUnkoNo23Digit(`${OPE_NO_22}a`)).toBe(false)
  })
})
