import { describe, expect, it } from 'vitest'

import {
  ALLOWED_ROLES,
  assertAllowedRole,
  roleIsIn,
} from '../../server/utils/require-role'

/** `assertAllowedRole` が投げた `H3Error` を取り出す (通ってしまったら失敗させる)。 */
function thrownBy(role: unknown): { statusCode?: number, statusMessage?: string, message?: string } {
  try {
    assertAllowedRole({ role })
  }
  catch (e) {
    return e as { statusCode?: number, statusMessage?: string, message?: string }
  }
  throw new Error(`403 を投げなかった: role=${JSON.stringify(role)}`)
}

describe('ALLOWED_ROLES — 許可 role の一覧', () => {
  // ★ この 1 本が「ベタ書きしていない」の陰性対照。`role === 'admin'` を route に
  //   直接書いてしまうと、一覧を増やしても効かないので下の拡張テストが落ちる。
  it('いまの中身は admin 1 つだけ (3 値目は別 issue)', () => {
    expect([...ALLOWED_ROLES]).toEqual(['admin'])
  })
})

describe('roleIsIn — 一覧に含まれるか (分岐の両側)', () => {
  it('許可 role は true', () => {
    expect(roleIsIn(ALLOWED_ROLES, 'admin')).toBe(true)
  })

  it('非許可 role は false', () => {
    expect(roleIsIn(ALLOWED_ROLES, 'viewer')).toBe(false)
  })

  it('空文字は false (claim 欠落時の `payload.role || ""` が来る形)', () => {
    expect(roleIsIn(ALLOWED_ROLES, '')).toBe(false)
  })

  it('undefined は false (typeof で落ちる)', () => {
    expect(roleIsIn(ALLOWED_ROLES, undefined)).toBe(false)
  })

  it('文字列でない値 (null / 数値 / オブジェクト) は false', () => {
    expect(roleIsIn(ALLOWED_ROLES, null)).toBe(false)
    expect(roleIsIn(ALLOWED_ROLES, 1)).toBe(false)
    expect(roleIsIn(ALLOWED_ROLES, { role: 'admin' })).toBe(false)
  })

  // ★ 受け入れ条件「将来の拡張が 1 行で済むこと」。
  //   **実装本体 (`require-role.ts`) を 1 文字も触らずに**、一覧に 2 つ目を足した
  //   世界を再現する。判定が一覧を引くだけなので、これが通る = 3 値目の追加は
  //   `ALLOWED_ROLES` の 1 行で済む。
  it('一覧に架空の 2 つ目を足すと、その role も通る (実装は無変更)', () => {
    const future = ['admin', 'salary_viewer'] as const
    expect(roleIsIn(future, 'salary_viewer')).toBe(true)
    expect(roleIsIn(future, 'admin')).toBe(true)
    // 足していない role は相変わらず落ちる (一覧が効いていることの陰性対照)。
    expect(roleIsIn(future, 'viewer')).toBe(false)
    // 本物の一覧は増えていない。
    expect(roleIsIn(ALLOWED_ROLES, 'salary_viewer')).toBe(false)
  })
})

describe('assertAllowedRole — 403 を投げるか', () => {
  it('許可 role なら何も投げない', () => {
    expect(() => assertAllowedRole({ role: 'admin' })).not.toThrow()
  })

  it('非許可 role は 403', () => {
    expect(thrownBy('viewer').statusCode).toBe(403)
  })

  it('空文字は 403 (fail-closed)', () => {
    expect(thrownBy('').statusCode).toBe(403)
  })

  it('undefined は 403 (fail-closed)', () => {
    expect(thrownBy(undefined).statusCode).toBe(403)
  })

  it('role キーそのものが無くても 403 (fail-closed)', () => {
    let caught: { statusCode?: number } | null = null
    try {
      assertAllowedRole({})
    }
    catch (e) {
      caught = e as { statusCode?: number }
    }
    expect(caught?.statusCode).toBe(403)
  })

  // ★ `statusMessage` に日本語を入れると本番 (workerd) で reason phrase が壊れる
  //   (Refs #1032/#886)。ASCII であることを**文字コードで**確かめる — 目視だと
  //   全角が混ざっても気づけない。
  it('statusMessage は ASCII のみ、日本語は message 側に載る', () => {
    const err = thrownBy('viewer')
    expect(err.statusMessage).toBe('administrator role is required')
    expect(/^[\x20-\x7E]+$/.test(err.statusMessage!)).toBe(true)
    expect(err.message).toBe('この操作には管理者権限が必要です')
    // h3 の createError は message 未指定だと statusMessage を写す。
    // **写っていない** (= 両方明示できている) ことを確かめる。
    expect(err.message).not.toBe(err.statusMessage)
  })
})
