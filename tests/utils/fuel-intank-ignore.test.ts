import { describe, it, expect } from 'vitest'
import { ignoreKey, parseIgnoreBody } from '~/utils/fuel-intank-ignore'

describe('ignoreKey', () => {
  it('fuel_intank の id_st と同じ `{datetime};{fuel_card_id}`', () => {
    expect(ignoreKey({ datetime: '2026-11-22 10:29:00', fuel_card_id: 15 })).toBe('2026-11-22 10:29:00;15')
  })
})

describe('parseIgnoreBody', () => {
  it('正しい本文を読む (ignored の true / false とも)', () => {
    expect(parseIgnoreBody({ datetime: '2026-11-22 10:29:00', fuel_card_id: 15, ignored: true }))
      .toEqual({ ok: true, key: { datetime: '2026-11-22 10:29:00', fuel_card_id: 15 }, ignored: true })
    expect(parseIgnoreBody({ datetime: '2026-11-22 10:29:00', fuel_card_id: 0, ignored: false }))
      .toEqual({ ok: true, key: { datetime: '2026-11-22 10:29:00', fuel_card_id: 0 }, ignored: false })
  })
  it('オブジェクトでなければ弾く', () => {
    for (const raw of [null, undefined, 'x', 1, []]) {
      expect(parseIgnoreBody(raw)).toEqual({ ok: false, error: 'body がオブジェクトではありません' })
    }
  })
  it('datetime の形が違えば弾く', () => {
    for (const datetime of [undefined, 1, '2026-11-22', '2026-11-22T10:29:00', '2026-11-22 10:29']) {
      expect(parseIgnoreBody({ datetime, fuel_card_id: 1, ignored: true }).ok).toBe(false)
    }
  })
  it('fuel_card_id が 0 以上の整数でなければ弾く', () => {
    for (const fuel_card_id of [undefined, '15', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseIgnoreBody({ datetime: '2026-11-22 10:29:00', fuel_card_id, ignored: true }))
        .toEqual({ ok: false, error: 'fuel_card_id は 0 以上の整数で指定してください' })
    }
  })
  it('ignored が真偽値でなければ弾く', () => {
    for (const ignored of [undefined, 1, 'true', null]) {
      expect(parseIgnoreBody({ datetime: '2026-11-22 10:29:00', fuel_card_id: 1, ignored }))
        .toEqual({ ok: false, error: 'ignored は true か false で指定してください' })
    }
  })
})
