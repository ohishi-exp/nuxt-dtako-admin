/**
 * `/api-tokens` (APIトークン管理) の画面 (Refs #903 の 1 段目)。
 *
 * この画面で一番怖いのは **「出ている状態が別の意味に読める」** こと:
 *
 * 1. **平文トークンは作成直後の 1 回しか出せない** — 閉じたら二度と出ない、という
 *    注意書きと一緒でなければ「あとで見ればいい」と読まれる
 * 2. **失効済み / 期限切れ / 有効を同じ見た目にしない** — 「失効させたのに使える」
 *    「期限切れなのに有効に見える」はどちらも本物の事故になる
 * 3. **読み込み中と 0 件を同じ見た目にしない**
 * 4. **`Error` 以外が投げられても黙らない**
 *
 * テストの型は `members-page.test.ts` と同じ (`~/utils/api` を `vi.mock` +
 * `importOriginal`、Nuxt UI は `NUXT_UI_PAGE_STUBS`)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import type { ApiTokenListItem } from '~/types'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api } = vi.hoisted(() => ({
  api: {
    getApiTokens: vi.fn(),
    createApiToken: vi.fn(),
    revokeApiToken: vi.fn(),
  },
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getApiTokens: api.getApiTokens,
  createApiToken: api.createApiToken,
  revokeApiToken: api.revokeApiToken,
}))

import ApiTokensPage from '~/pages/api-tokens.vue'

const writeText = vi.fn()

function item(overrides: Partial<ApiTokenListItem> = {}): ApiTokenListItem {
  return {
    id: 'tok_1',
    name: '外部連携用',
    token_prefix: 'dtk_abcd',
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    created_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

function mountPage() {
  return mount(ApiTokensPage, { global: { stubs: NUXT_UI_PAGE_STUBS } })
}

/** ラベル完全一致で押す (部分一致だと「コピー」が「コピー済み」に当たる)。 */
function button(w: VueWrapper, label: string) {
  const found = w.findAll('button').filter((b) => b.text().trim() === label)
  expect(found, `「${label}」ボタンが 1 つでない`).toHaveLength(1)
  return found[0]!
}

function hasButton(w: VueWrapper, label: string) {
  return w.findAll('button').some((b) => b.text().trim() === label)
}

/** 作成フォームを開いて名前を入れ、「作成」を押すところまで。 */
async function create(w: VueWrapper, name: string, expiryDays?: string) {
  await button(w, '新規トークン').trigger('click')
  await w.find('input[type="text"]').setValue(name)
  if (expiryDays !== undefined) await w.find('input[type="number"]').setValue(expiryDays)
  await button(w, '作成').trigger('click')
  await flushPromises()
}

describe('/api-tokens APIトークン管理', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    api.getApiTokens.mockResolvedValue([])
    api.createApiToken.mockResolvedValue({ token: 'dtk_secret_value' })
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('読み込みの状態', () => {
    it('読み込み中は「0 件」と別の見た目にする', async () => {
      let resolve!: (v: ApiTokenListItem[]) => void
      api.getApiTokens.mockReturnValue(new Promise<ApiTokenListItem[]>((r) => { resolve = r }))
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('読み込み中...')
      expect(w.text()).not.toContain('トークンがありません')

      resolve([])
      await flushPromises()
      expect(w.text()).not.toContain('読み込み中...')
      expect(w.text()).toContain('トークンがありません')
    })

    it('取得に失敗したら理由を出す', async () => {
      api.getApiTokens.mockRejectedValue(new Error('D1 に届きませんでした'))
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('D1 に届きませんでした')
    })

    it('Error 以外が投げられても黙らない', async () => {
      api.getApiTokens.mockRejectedValue('文字列で投げられた')
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('データの取得に失敗しました')
    })

    it('再読み込みでもう一度取りに行く', async () => {
      const w = mountPage()
      await flushPromises()
      await button(w, '再読み込み').trigger('click')
      await flushPromises()
      expect(api.getApiTokens).toHaveBeenCalledTimes(2)
    })
  })

  describe('一覧の状態表示 — 3 つを同じ見た目にしない', () => {
    it('失効済み / 期限切れ / 有効 を撃ち分ける', async () => {
      api.getApiTokens.mockResolvedValue([
        item({ id: 'a', name: '失効したもの', revoked_at: '2026-07-10T00:00:00Z' }),
        item({ id: 'b', name: '切れたもの', expires_at: '2020-01-01T00:00:00Z' }),
        item({ id: 'c', name: '期限つきで生きているもの', expires_at: '2999-01-01T00:00:00Z' }),
        item({ id: 'd', name: '無期限' }),
      ])
      const w = mountPage()
      await flushPromises()
      const rows = w.findAll('tbody tr')
      expect(rows).toHaveLength(4)
      expect(rows[0]!.text()).toContain('失効済み')
      expect(rows[1]!.text()).toContain('期限切れ')
      expect(rows[2]!.text()).toContain('有効')
      expect(rows[3]!.text()).toContain('有効')
    })

    it('失効済みの行だけ薄くし、失効ボタンを出さない', async () => {
      api.getApiTokens.mockResolvedValue([
        item({ id: 'a', revoked_at: '2026-07-10T00:00:00Z' }),
        item({ id: 'b' }),
      ])
      const w = mountPage()
      await flushPromises()
      const rows = w.findAll('tbody tr')
      expect(rows[0]!.classes()).toContain('opacity-50')
      expect(rows[1]!.classes()).not.toContain('opacity-50')
      expect(hasButton(w, '失効')).toBe(true)
      expect(w.findAll('button').filter((b) => b.text().trim() === '失効')).toHaveLength(1)
    })

    it('日時が無い列は「-」で埋める (空欄にして読めなかったと混ぜない)', async () => {
      api.getApiTokens.mockResolvedValue([item({ last_used_at: null, expires_at: null })])
      const w = mountPage()
      await flushPromises()
      const cells = w.findAll('tbody tr td')
      // 有効期限 / 最終利用 の 2 列が `-`、作成日は実日付
      expect(cells[3]!.text()).toBe('-')
      expect(cells[4]!.text()).toBe('-')
      expect(cells[5]!.text()).toMatch(/2026\/\d{2}\/\d{2}/)
    })
  })

  describe('作成', () => {
    it('名前が空のうちは押せない', async () => {
      const w = mountPage()
      await flushPromises()
      await button(w, '新規トークン').trigger('click')
      expect(button(w, '作成').attributes('disabled')).toBeDefined()
      await w.find('input[type="text"]').setValue('   ')
      expect(button(w, '作成').attributes('disabled')).toBeDefined()
    })

    it('Enter でも作成でき、名前は trim して渡す。期限未入力なら undefined', async () => {
      const w = mountPage()
      await flushPromises()
      await button(w, '新規トークン').trigger('click')
      await w.find('input[type="text"]').setValue('  外部連携用  ')
      await w.find('input[type="text"]').trigger('keyup.enter')
      await flushPromises()
      expect(api.createApiToken).toHaveBeenCalledWith('外部連携用', undefined)
    })

    it('空のまま Enter を押しても API を叩かない', async () => {
      const w = mountPage()
      await flushPromises()
      await button(w, '新規トークン').trigger('click')
      await w.find('input[type="text"]').trigger('keyup.enter')
      await flushPromises()
      expect(api.createApiToken).not.toHaveBeenCalled()
    })

    it('有効期限を入れたら日数を渡す', async () => {
      const w = mountPage()
      await flushPromises()
      await create(w, '期限つき', '30')
      expect(api.createApiToken).toHaveBeenCalledWith('期限つき', 30)
    })

    it('成功したらフォームを閉じ、平文トークンを「再表示できない」と一緒に出す', async () => {
      const w = mountPage()
      await flushPromises()
      await create(w, '外部連携用')
      expect(hasButton(w, '作成')).toBe(false)
      expect(w.text()).toContain('dtk_secret_value')
      expect(w.text()).toContain('このトークンは再表示できません')
      expect(api.getApiTokens).toHaveBeenCalledTimes(2)
    })

    it('失敗したらフォームを開いたまま理由を出し、平文トークンは出さない', async () => {
      api.createApiToken.mockRejectedValue(new Error('同じ名前があります'))
      const w = mountPage()
      await flushPromises()
      await create(w, '外部連携用')
      expect(w.text()).toContain('同じ名前があります')
      expect(hasButton(w, '作成')).toBe(true)
      expect(w.text()).not.toContain('このトークンは再表示できません')
    })

    it('Error 以外で失敗しても黙らない', async () => {
      api.createApiToken.mockRejectedValue({ status: 500 })
      const w = mountPage()
      await flushPromises()
      await create(w, '外部連携用')
      expect(w.text()).toContain('トークンの作成に失敗しました')
    })

    it('キャンセルでフォームを閉じる', async () => {
      const w = mountPage()
      await flushPromises()
      await button(w, '新規トークン').trigger('click')
      await button(w, 'キャンセル').trigger('click')
      expect(hasButton(w, '作成')).toBe(false)
    })
  })

  describe('作成直後のトークン', () => {
    it('コピーしたら「コピー済み」に変わる', async () => {
      const w = mountPage()
      await flushPromises()
      await create(w, '外部連携用')
      expect(hasButton(w, 'コピー')).toBe(true)
      await button(w, 'コピー').trigger('click')
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('dtk_secret_value')
      expect(hasButton(w, 'コピー済み')).toBe(true)
      expect(hasButton(w, 'コピー')).toBe(false)
    })

    it('もう 1 本作ったら「コピー済み」は前の本の話なので消す', async () => {
      const w = mountPage()
      await flushPromises()
      await create(w, '1 本目')
      await button(w, 'コピー').trigger('click')
      await flushPromises()
      expect(hasButton(w, 'コピー済み')).toBe(true)

      api.createApiToken.mockResolvedValue({ token: 'dtk_second_value' })
      await create(w, '2 本目')
      expect(w.text()).toContain('dtk_second_value')
      expect(hasButton(w, 'コピー済み')).toBe(false)
    })

    it('閉じたら平文トークンは画面から消える', async () => {
      const w = mountPage()
      await flushPromises()
      await create(w, '外部連携用')
      await button(w, '閉じる').trigger('click')
      expect(w.text()).not.toContain('dtk_secret_value')
    })
  })

  describe('失効', () => {
    beforeEach(() => {
      api.getApiTokens.mockResolvedValue([item()])
    })

    it('確認を断ったら API を叩かない', async () => {
      vi.stubGlobal('confirm', vi.fn(() => false))
      const w = mountPage()
      await flushPromises()
      await button(w, '失効').trigger('click')
      await flushPromises()
      expect(api.revokeApiToken).not.toHaveBeenCalled()
    })

    it('確認したら失効させて読み直す', async () => {
      vi.stubGlobal('confirm', vi.fn(() => true))
      const w = mountPage()
      await flushPromises()
      await button(w, '失効').trigger('click')
      await flushPromises()
      expect(api.revokeApiToken).toHaveBeenCalledWith('tok_1')
      expect(api.getApiTokens).toHaveBeenCalledTimes(2)
    })

    it('失敗したら理由を出す', async () => {
      vi.stubGlobal('confirm', vi.fn(() => true))
      api.revokeApiToken.mockRejectedValue(new Error('既に失効しています'))
      const w = mountPage()
      await flushPromises()
      await button(w, '失効').trigger('click')
      await flushPromises()
      expect(w.text()).toContain('既に失効しています')
    })

    it('Error 以外で失敗しても黙らない', async () => {
      vi.stubGlobal('confirm', vi.fn(() => true))
      api.revokeApiToken.mockRejectedValue(null)
      const w = mountPage()
      await flushPromises()
      await button(w, '失効').trigger('click')
      await flushPromises()
      expect(w.text()).toContain('トークンの失効に失敗しました')
    })
  })
})
