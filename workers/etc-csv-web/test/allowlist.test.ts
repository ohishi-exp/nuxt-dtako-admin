import { describe, expect, it } from 'vitest'
import { isAllowedUserId, parseAllowedUserIds } from '../src/allowlist'

describe('parseAllowedUserIds', () => {
  it('カンマ区切りを分解し、空白と空要素を落とす', () => {
    expect(parseAllowedUserIds('a, b ,,c')).toEqual(['a', 'b', 'c'])
  })

  // 陰性対照: 変数未設定は「全員許可」ではなく「誰も許可しない」。
  it.each([undefined, '', ' , , '])('%o は空配列 (fail-closed)', (raw) => {
    expect(parseAllowedUserIds(raw)).toEqual([])
  })
})

describe('isAllowedUserId', () => {
  it('完全一致だけ通す', () => {
    expect(isAllowedUserId('alice,bob', 'alice')).toBe(true)
    expect(isAllowedUserId(' alice , bob ', 'bob')).toBe(true)
  })

  // 陰性対照: 前方一致・後方一致・部分一致はどれも通らない。
  it.each(['ali', 'alicex', 'xalice', 'ALICE', 'alice,bob', 'a*', ''])(
    '%o は通らない',
    (userId) => {
      expect(isAllowedUserId('alice,bob', userId)).toBe(false)
    },
  )

  it('未設定なら誰も通らない', () => {
    expect(isAllowedUserId(undefined, 'alice')).toBe(false)
  })
})
