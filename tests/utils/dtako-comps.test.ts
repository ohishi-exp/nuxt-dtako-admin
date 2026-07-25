/**
 * `app/utils/dtako-comps.ts` のテスト (Refs #367)。
 */

import { describe, it, expect } from 'vitest'
import { DTAKO_COMPS, dtakoCompDisplay, dtakoCompLabel, parseCompMap } from '../../app/utils/dtako-comps'

describe('DTAKO_COMPS', () => {
  it('会社IDは重複しない (社員マスタの会社横断表示がキー衝突しない前提)', () => {
    expect(new Set(DTAKO_COMPS.map(c => c.compId)).size).toBe(DTAKO_COMPS.length)
  })
})

describe('dtakoCompLabel', () => {
  it('登録済みの会社IDは会社名を返す', () => {
    expect(dtakoCompLabel('27324455')).toBe('大石運輸倉庫')
  })

  it('未登録の会社ID (閲覧モードの手入力・ローカル検証) はそのまま返す', () => {
    expect(dtakoCompLabel('local')).toBe('local')
  })
})

describe('dtakoCompDisplay', () => {
  it('登録済みは「ID (会社名)」形式', () => {
    expect(dtakoCompDisplay('75700192')).toBe('75700192 (北海大運)')
  })

  it('未登録は ID のみ', () => {
    expect(dtakoCompDisplay('local')).toBe('local')
  })
})

describe('parseCompMap', () => {
  it('正常な応答を取り出す', () => {
    const out = parseCompMap({
      comps: [{
        compId: '27324455',
        compLabel: '大石運輸倉庫',
        payrollCompanies: [
          { payrollCompany: '0100', legacyLabel: '有' },
          { payrollCompany: '0300', legacyLabel: null },
        ],
      }],
    })
    expect(out).toEqual([{
      compId: '27324455',
      compLabel: '大石運輸倉庫',
      payrollCompanies: [
        { payrollCompany: '0100', legacyLabel: '有' },
        { payrollCompany: '0300', legacyLabel: null },
      ],
    }])
  })

  it('compLabel が無ければ compId を表示名にする', () => {
    const out = parseCompMap({ comps: [{ compId: 'x', payrollCompanies: [] }] })
    expect(out[0]!.compLabel).toBe('x')
  })

  it('compId が無い要素・不正な payrollCompanies 要素は捨てる', () => {
    const out = parseCompMap({ comps: [{ compLabel: 'なし' }, { compId: 'y', payrollCompanies: [{ x: 1 }, 'z'] }] })
    expect(out).toEqual([{ compId: 'y', compLabel: 'y', payrollCompanies: [] }])
  })

  it('payrollCompanies が配列でなければ空配列にする', () => {
    expect(parseCompMap({ comps: [{ compId: 'z' }] })).toEqual([
      { compId: 'z', compLabel: 'z', payrollCompanies: [] },
    ])
  })

  it('応答が壊れていれば空配列 (フォールバックさせる)', () => {
    expect(parseCompMap(null)).toEqual([])
    expect(parseCompMap({})).toEqual([])
    expect(parseCompMap({ comps: 'x' })).toEqual([])
  })
})
