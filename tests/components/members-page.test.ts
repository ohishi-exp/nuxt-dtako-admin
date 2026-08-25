/**
 * `/members` (メンバー管理) の画面 (Refs #903 の 1 段目)。
 *
 * この画面は **JWT の `role` だけで見た目が変わる**ので、踏みやすい欠陥はどれも
 * 「出ているものが別の意味に読める」型になる:
 *
 * 1. **読み込み中と 0 件を同じ見た目にしない** — 「まだ読んでいない」を
 *    「メンバーがいない」と読ませない
 * 2. **自分自身のロール変更・削除の口を出さない** — 出したうえで失敗させると
 *    「権限が壊れている」に読める (自分を admin から降ろせてしまう事故も防ぐ)
 * 3. **`Error` 以外が投げられても黙らない** — `catch` が文字列を作れずに空になると
 *    「取得に成功して 0 件」と同じ見た目になる
 *
 * ## テストの型 (以降のページテストもこれをなぞる)
 *
 * - **API は `~/utils/api` を `vi.mock` + `importOriginal`** で必要な関数だけ差し替える
 *   ($fetch を直接持たない画面なので `vi.stubGlobal('$fetch')` は効かない)
 * - **`@ippoan/auth-client` は丸ごと差し替える** (`useAuth` は Nuxt の実 app が要る)
 * - **Nuxt UI は `NUXT_UI_PAGE_STUBS` で全部 stub** (実物は mount できない)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import type { TenantMember } from '~/types'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { tokenRef, decodeMock, api } = vi.hoisted(() => ({
  tokenRef: { value: null as string | null },
  decodeMock: vi.fn(),
  api: {
    getMembers: vi.fn(),
    inviteMember: vi.fn(),
    updateMemberRole: vi.fn(),
    deleteMember: vi.fn(),
  },
}))

vi.mock('@ippoan/auth-client', () => ({
  useAuth: () => ({ token: tokenRef }),
  decodeJwtPayloadFromToken: decodeMock,
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getMembers: api.getMembers,
  inviteMember: api.inviteMember,
  updateMemberRole: api.updateMemberRole,
  deleteMember: api.deleteMember,
}))

import MembersPage from '~/pages/members.vue'

const ME = 'me@example.com'
const OTHER = 'other@example.com'

function member(overrides: Partial<TenantMember> = {}): TenantMember {
  return { email: OTHER, role: 'member', created_at: '2026-07-01T00:00:00Z', ...overrides }
}

/** ログイン中の利用者を決める。`null` = トークンが無い (= 未ログイン相当)。 */
function signIn(payload: { email?: string, role?: string } | null) {
  tokenRef.value = payload === null ? null : 'jwt.token.here'
  decodeMock.mockReturnValue(payload ?? {})
}

function mountPage() {
  return mount(MembersPage, { global: { stubs: NUXT_UI_PAGE_STUBS } })
}

/**
 * ラベル**完全一致**で押す。index で押すと行が増減したときに黙って別のボタンを押し、
 * 部分一致だと「メンバー招待」が「招待」に当たって別の口を押す。
 */
function button(w: VueWrapper, label: string) {
  const found = w.findAll('button').filter((b) => b.text().trim() === label)
  expect(found, `「${label}」ボタンが 1 つでない`).toHaveLength(1)
  return found[0]!
}

function hasButton(w: VueWrapper, label: string) {
  return w.findAll('button').some((b) => b.text().trim() === label)
}

describe('/members メンバー管理', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    decodeMock.mockReset()
    api.getMembers.mockResolvedValue([])
    signIn({ email: ME, role: 'admin' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('読み込みの状態', () => {
    it('読み込み中は「0 件」と別の見た目にする', async () => {
      let resolve!: (v: TenantMember[]) => void
      api.getMembers.mockReturnValue(new Promise<TenantMember[]>((r) => { resolve = r }))
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('読み込み中...')
      expect(w.text()).not.toContain('メンバーがいません')

      resolve([])
      await flushPromises()
      expect(w.text()).not.toContain('読み込み中...')
      expect(w.text()).toContain('メンバーがいません')
    })

    it('取得に失敗したら理由を出す (空の一覧だけにしない)', async () => {
      api.getMembers.mockRejectedValue(new Error('組織が見つかりません'))
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('組織が見つかりません')
    })

    it('Error 以外が投げられても黙らない', async () => {
      api.getMembers.mockRejectedValue('文字列で投げられた')
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('データの取得に失敗しました')
    })

    it('再読み込みでもう一度取りに行く', async () => {
      const w = mountPage()
      await flushPromises()
      expect(api.getMembers).toHaveBeenCalledTimes(1)
      await button(w, '再読み込み').trigger('click')
      await flushPromises()
      expect(api.getMembers).toHaveBeenCalledTimes(2)
    })
  })

  describe('admin かどうかで出す口を変える', () => {
    it('admin には招待・ロール変更・削除の口を出す', async () => {
      api.getMembers.mockResolvedValue([member()])
      const w = mountPage()
      await flushPromises()
      expect(hasButton(w, 'メンバー招待')).toBe(true)
      expect(hasButton(w, '削除')).toBe(true)
      expect(w.findAll('select')).toHaveLength(1)
    })

    it('member には 1 つも出さない (押せない口を出して権限が壊れて見えるのを防ぐ)', async () => {
      signIn({ email: ME, role: 'member' })
      api.getMembers.mockResolvedValue([member()])
      const w = mountPage()
      await flushPromises()
      expect(hasButton(w, 'メンバー招待')).toBe(false)
      expect(hasButton(w, '削除')).toBe(false)
      expect(w.findAll('select')).toHaveLength(0)
      // ロールは読めること (口が無いだけで、値は見える)
      expect(w.text()).toContain('member')
    })

    it('トークンが無ければ admin 扱いしない', async () => {
      signIn(null)
      api.getMembers.mockResolvedValue([member()])
      const w = mountPage()
      await flushPromises()
      expect(hasButton(w, 'メンバー招待')).toBe(false)
      expect(decodeMock).not.toHaveBeenCalled()
    })

    // `!payload.email && !payload.role` は**両方欠けているときだけ**未ログイン扱いにする
    // (片方だけでも利用者として扱う) という書き方。**role だけのトークン**はその右辺の
    // false 側で、これが通らないと「片方だけ」の意図が死んだままになる。
    it('email が無く role だけのトークンでも利用者として扱う', async () => {
      signIn({ role: 'admin' })
      api.getMembers.mockResolvedValue([member()])
      const w = mountPage()
      await flushPromises()
      expect(hasButton(w, 'メンバー招待')).toBe(true)
      // email が無いので「自分の行」は 1 つも当たらない — 全員が削除できる相手になる
      expect(w.text()).not.toContain('(自分)')
      expect(hasButton(w, '削除')).toBe(true)
    })

    it('トークンは読めたが email も role も無ければ admin 扱いしない', async () => {
      signIn({})
      api.getMembers.mockResolvedValue([member()])
      const w = mountPage()
      await flushPromises()
      expect(hasButton(w, 'メンバー招待')).toBe(false)
      expect(w.text()).not.toContain('(自分)')
    })
  })

  describe('自分の行', () => {
    it('自分には (自分) を付け、ロール変更と削除の口を出さない', async () => {
      api.getMembers.mockResolvedValue([member({ email: ME, role: 'admin' }), member()])
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('(自分)')
      // 自分の行はロールが素の文字、相手の行だけ select
      expect(w.findAll('select')).toHaveLength(1)
      expect(w.findAll('button').filter((b) => b.text().includes('削除'))).toHaveLength(1)
    })
  })

  describe('招待', () => {
    it('メールアドレスが空のうちは押せない', async () => {
      const w = mountPage()
      await flushPromises()
      await button(w, 'メンバー招待').trigger('click')
      expect(button(w, '招待').attributes('disabled')).toBeDefined()
      await w.find('input[type="email"]').setValue('   ')
      expect(button(w, '招待').attributes('disabled')).toBeDefined()
    })

    it('Enter でも招待でき、成功したらフォームを閉じて一覧を読み直す', async () => {
      const w = mountPage()
      await flushPromises()
      await button(w, 'メンバー招待').trigger('click')
      await w.find('input[type="email"]').setValue('  new@example.com  ')
      await w.findAll('select')[0]!.setValue('admin')
      await w.find('input[type="email"]').trigger('keyup.enter')
      await flushPromises()

      expect(api.inviteMember).toHaveBeenCalledWith('new@example.com', 'admin')
      expect(api.getMembers).toHaveBeenCalledTimes(2)
      expect(hasButton(w, '招待')).toBe(false)
    })

    it('空のまま Enter を押しても API を叩かない', async () => {
      const w = mountPage()
      await flushPromises()
      await button(w, 'メンバー招待').trigger('click')
      await w.find('input[type="email"]').trigger('keyup.enter')
      await flushPromises()
      expect(api.inviteMember).not.toHaveBeenCalled()
    })

    it('失敗したらフォームを開いたまま理由を出す (入力を捨てない)', async () => {
      api.inviteMember.mockRejectedValue(new Error('既に参加しています'))
      const w = mountPage()
      await flushPromises()
      await button(w, 'メンバー招待').trigger('click')
      await w.find('input[type="email"]').setValue('new@example.com')
      await button(w, '招待').trigger('click')
      await flushPromises()
      expect(w.text()).toContain('既に参加しています')
      expect(hasButton(w, '招待')).toBe(true)
      expect((w.find('input[type="email"]').element as HTMLInputElement).value).toBe('new@example.com')
    })

    it('Error 以外で失敗しても黙らない', async () => {
      api.inviteMember.mockRejectedValue({ code: 409 })
      const w = mountPage()
      await flushPromises()
      await button(w, 'メンバー招待').trigger('click')
      await w.find('input[type="email"]').setValue('new@example.com')
      await button(w, '招待').trigger('click')
      await flushPromises()
      expect(w.text()).toContain('メンバーの招待に失敗しました')
    })

    it('キャンセルでフォームを閉じる', async () => {
      const w = mountPage()
      await flushPromises()
      await button(w, 'メンバー招待').trigger('click')
      expect(hasButton(w, '招待')).toBe(true)
      await button(w, 'キャンセル').trigger('click')
      expect(hasButton(w, '招待')).toBe(false)
    })
  })

  describe('ロール変更', () => {
    it('select を変えたらその相手のロールだけを変えて読み直す', async () => {
      api.getMembers.mockResolvedValue([member()])
      const w = mountPage()
      await flushPromises()
      await w.findAll('select')[0]!.setValue('admin')
      await flushPromises()
      expect(api.updateMemberRole).toHaveBeenCalledWith(OTHER, 'admin')
      expect(api.getMembers).toHaveBeenCalledTimes(2)
    })

    it('失敗したら理由を出す', async () => {
      api.getMembers.mockResolvedValue([member()])
      api.updateMemberRole.mockRejectedValue(new Error('最後の admin は降ろせません'))
      const w = mountPage()
      await flushPromises()
      await w.findAll('select')[0]!.setValue('member')
      await flushPromises()
      expect(w.text()).toContain('最後の admin は降ろせません')
    })

    it('Error 以外で失敗しても黙らない', async () => {
      api.getMembers.mockResolvedValue([member()])
      api.updateMemberRole.mockRejectedValue(null)
      const w = mountPage()
      await flushPromises()
      await w.findAll('select')[0]!.setValue('member')
      await flushPromises()
      expect(w.text()).toContain('ロールの変更に失敗しました')
    })
  })

  describe('削除', () => {
    it('確認を断ったら API を叩かない', async () => {
      vi.stubGlobal('confirm', vi.fn(() => false))
      api.getMembers.mockResolvedValue([member()])
      const w = mountPage()
      await flushPromises()
      await button(w, '削除').trigger('click')
      await flushPromises()
      expect(api.deleteMember).not.toHaveBeenCalled()
    })

    it('確認したら削除して読み直す', async () => {
      vi.stubGlobal('confirm', vi.fn(() => true))
      api.getMembers.mockResolvedValue([member()])
      const w = mountPage()
      await flushPromises()
      await button(w, '削除').trigger('click')
      await flushPromises()
      expect(api.deleteMember).toHaveBeenCalledWith(OTHER)
      expect(api.getMembers).toHaveBeenCalledTimes(2)
    })

    it('失敗したら理由を出す', async () => {
      vi.stubGlobal('confirm', vi.fn(() => true))
      api.getMembers.mockResolvedValue([member()])
      api.deleteMember.mockRejectedValue(new Error('権限がありません'))
      const w = mountPage()
      await flushPromises()
      await button(w, '削除').trigger('click')
      await flushPromises()
      expect(w.text()).toContain('権限がありません')
    })

    it('Error 以外で失敗しても黙らない', async () => {
      vi.stubGlobal('confirm', vi.fn(() => true))
      api.getMembers.mockResolvedValue([member()])
      api.deleteMember.mockRejectedValue(undefined)
      const w = mountPage()
      await flushPromises()
      await button(w, '削除').trigger('click')
      await flushPromises()
      expect(w.text()).toContain('メンバーの削除に失敗しました')
    })
  })

  it('追加日は日付として読める形で出す', async () => {
    api.getMembers.mockResolvedValue([member()])
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toMatch(/2026\/\d{2}\/\d{2}/)
  })
})
