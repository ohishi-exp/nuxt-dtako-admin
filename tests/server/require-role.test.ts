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
  // ★ `payroll` は #1048 で足した 2 値目 (綴りはオーナー決定。`kyuyo` / `wage` ではない)。
  //   **順序も含めて固定する** — 「増やす」以外の書き換え (全部通す等) をここで捕まえる。
  it('いまの中身は admin と payroll の 2 つ (#1048)', () => {
    expect([...ALLOWED_ROLES]).toEqual(['admin', 'payroll'])
  })
})

describe('roleIsIn — 一覧に含まれるか (分岐の両側)', () => {
  it('許可 role は true', () => {
    expect(roleIsIn(ALLOWED_ROLES, 'admin')).toBe(true)
  })

  // ★ #1048 の本題。**上の admin と対で見ること** — payroll だけを見ると
  //   「一覧が全部通す形に退化した」場合も緑になる (それは次の it が落とす)。
  it('payroll も true (#1048 で足した 2 値目)', () => {
    expect(roleIsIn(ALLOWED_ROLES, 'payroll')).toBe(true)
  })

  it('非許可 role は false', () => {
    expect(roleIsIn(ALLOWED_ROLES, 'viewer')).toBe(false)
  })

  // ★ 「payroll を足したついでに全部通す」への陰性対照。viewer 以外の綴りも落ちる
  //   (`kyuyo` / `wage` は**採らなかった綴り**。混ざっても通らないことを固定する)。
  it('採らなかった綴り (kyuyo / wage) や未知の role は false', () => {
    expect(roleIsIn(ALLOWED_ROLES, 'kyuyo')).toBe(false)
    expect(roleIsIn(ALLOWED_ROLES, 'wage')).toBe(false)
    expect(roleIsIn(ALLOWED_ROLES, 'salary_viewer')).toBe(false)
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
  //   **実装本体 (`require-role.ts`) を 1 文字も触らずに**、一覧にもう 1 つ足した
  //   世界を再現する。判定が一覧を引くだけなので、これが通る = 次の値の追加も
  //   `ALLOWED_ROLES` の 1 行で済む (#1048 の `payroll` が実際にそうだった)。
  it('一覧に架空の 3 つ目を足すと、その role も通る (実装は無変更)', () => {
    const future = ['admin', 'payroll', 'salary_viewer'] as const
    expect(roleIsIn(future, 'salary_viewer')).toBe(true)
    expect(roleIsIn(future, 'admin')).toBe(true)
    expect(roleIsIn(future, 'payroll')).toBe(true)
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

  // ★ #1048。helper 単体でも payroll が**通る側**であることを固定する
  //   (route まで繋がっているかは `require-role-routes.test.ts` が 25 route で測る)。
  it('payroll も何も投げない (#1048)', () => {
    expect(() => assertAllowedRole({ role: 'payroll' })).not.toThrow()
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
  // ★ #1048 で `payroll` を足した後も**文言は据え置き**。**見直しの引き金は
  //   「`payroll` role を持つ利用者が 1 人でも実在したら」**で、上流の `CHECK` が
  //   広がっただけではまだ真 (正本は `ALLOWED_ROLES` の docstring)。
  //   ここが落ちたら「文言を変えた」ので、据え置きの判断ごと見直すこと。
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
