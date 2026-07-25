/**
 * `app/utils/dtako-comps.ts` のテスト (Refs #367)。
 */

import { describe, it, expect } from 'vitest'
import { DTAKO_COMPS, dtakoCompDisplay, dtakoCompLabel } from '../../app/utils/dtako-comps'

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
