/**
 * `/litigation` (訴訟準備) の会社ID選択 — 会社IDを毎回手入力させない (ユーザー要望)。
 *
 * ## 何を固定するか
 *
 * 1. ★ 同じブラウザで restraint-wage.vue (`restraint-viewer-comp`) を既に使っていれば、
 *    litigation 側の入力を経ずにその値を自動で引き継ぎ、選択フォームを出さない
 * 2. ★ どちらも無ければ theearth ログイン履歴 (`theearth-last-account`、lastAccount()) を
 *    フォールバックに使う
 * 3. ★ どちらも無ければ従来どおり入力フォームを出す (陰性対照 — 常に自動化されるわけではない)
 * 4. ★ 「変更」ボタンで選択フォームに戻れる (誤選択の訂正手段)
 *
 * 型は `litigation-errors-tab.test.ts` をなぞる (`mockNuxtImport('useState', ...)` で
 * `useRestraintSession` の `lastAccount` を素通しする)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api } = vi.hoisted(() => ({
  api: { getDrivers: vi.fn(), getYTimePreview: vi.fn() },
}))

vi.mock('~/utils/download-blob', () => ({ downloadBlob: vi.fn() }))
vi.mock('@ippoan/auth-client', () => ({ useAuth: () => ({ token: { value: 'jwt-token' } }) }))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDrivers: api.getDrivers,
  getYTimePreview: api.getYTimePreview,
}))

const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})

const Page = (await import('~/pages/litigation.vue')).default

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 0))
    await flushPromises()
  }
}

function mountPage(): VueWrapper {
  return mount(Page, {
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true } },
  })
}

/** 会社ID指定フォームが出ているか (UCard スタブは `#header` を描画しないので、
 * フォーム内にしか無い「開始」ボタンの有無で判定する)。 */
function hasViewerForm(w: VueWrapper): boolean {
  return w.findAll('button').some(b => b.text().trim() === '開始')
}

beforeEach(() => {
  localStorage.clear()
  nuxtState.clear()
  api.getDrivers.mockResolvedValue([])
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url === '/restraint-api/litigation-cases') return { cases: [] }
    throw new Error(`unexpected $fetch ${url}`)
  }))
})

describe('/litigation 会社IDの自動引き継ぎ', () => {
  it('★ litigation 自身の保存値があればそれを使い、選択フォームを出さない', async () => {
    localStorage.setItem('litigation-viewer-comp', '1000')
    const w = mountPage()
    await settle()
    expect(hasViewerForm(w)).toBe(false)
    expect(w.text()).toContain('会社ID: 1000')
  })

  it('★ litigation 自身の保存値が無ければ restraint-wage.vue の保存値 (restraint-viewer-comp) を引き継ぐ', async () => {
    localStorage.setItem('restraint-viewer-comp', '2000')
    const w = mountPage()
    await settle()
    expect(hasViewerForm(w)).toBe(false)
    expect(w.text()).toContain('会社ID: 2000')
    // 次回のために litigation 自身のキーにも書いておく
    expect(localStorage.getItem('litigation-viewer-comp')).toBe('2000')
  })

  it('★ restraint-viewer-comp も無ければ theearth ログイン履歴 (lastAccount) を引き継ぐ', async () => {
    localStorage.setItem('theearth-last-account', JSON.stringify({ compId: '3000', userName: 'someone' }))
    const w = mountPage()
    await settle()
    expect(hasViewerForm(w)).toBe(false)
    expect(w.text()).toContain('会社ID: 3000')
  })

  it('陰性対照: どちらの保存値も無ければ従来どおり選択フォームを出す', async () => {
    const w = mountPage()
    await settle()
    expect(hasViewerForm(w)).toBe(true)
    expect(w.text()).not.toContain('会社ID:')
  })

  it('★ 「変更」ボタンで選択フォームに戻れる (誤選択の訂正手段)', async () => {
    localStorage.setItem('litigation-viewer-comp', '4000')
    const w = mountPage()
    await settle()
    expect(w.text()).toContain('会社ID: 4000')
    expect(hasViewerForm(w)).toBe(false)

    const changeBtn = w.findAll('button').find(b => b.text().trim() === '変更')
    expect(changeBtn, '「変更」ボタンが無い').toBeTruthy()
    await changeBtn!.trigger('click')
    await settle()

    expect(hasViewerForm(w)).toBe(true)
  })
})
