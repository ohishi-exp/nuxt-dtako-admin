/**
 * `/y-time-export` の「R2 確認」が**非 2xx の理由を人に言うか** (Refs #890)。
 *
 * 直す前は `${res.status} ${res.statusText}` で、**本番 (HTTP/3) は reason phrase が
 * 存在しない**ため画面が `✗ 確認エラー: 503 ` と**status の後ろが空**になっていた。
 * 理由は捨てられていたのではなく**一度も読まれていなかった** (`res.text()` を呼んでいない)。
 *
 * **合成後の 1 文**で見る — ヘルパの戻り値だけ見ても、画面に何が出るかは決まらない。
 * `statusText: ''` は本番の形をそのまま使っている (dev の HTTP/1.1 とは別物)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('~/utils/api', () => ({
  getDrivers: vi.fn(async () => [{ id: 'd1', driver_cd: '0001', driver_name: '山田' }]),
  getYTimePreview: vi.fn(async () => ({ warnings: [] })),
}))
vi.mock('@ippoan/auth-client', () => ({
  useAuth: () => ({ token: { value: 'dummy-token' } }),
}))

import Page from '~/pages/y-time-export.vue'

const realFetch = globalThis.fetch

/** 本番と同じ形の応答 (reason phrase なし)。 */
function respond(status: number, body: string, contentType = 'application/json') {
  globalThis.fetch = (async () => new Response(body, {
    status,
    statusText: '', // HTTP/3 には reason phrase が無い
    headers: { 'content-type': contentType },
  })) as typeof fetch
}

async function clickCheck() {
  const w = mount(Page)
  await flushPromises()
  const btn = w.findAll('button').find(b => b.text() === 'R2 確認')
  expect(btn).toBeDefined()
  await btn!.trigger('click')
  await flushPromises()
  return w
}

describe('/y-time-export の「R2 確認」が出す理由', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { globalThis.fetch = realFetch })

  it('自前 route の本文 (error は真偽値) から日本語を拾って出す', async () => {
    respond(503, JSON.stringify({
      error: true,
      url: '/api/y-time-template',
      statusCode: 503,
      statusMessage: 'DTAKO_R2 binding が未設定です',
      message: 'DTAKO_R2 binding が未設定です',
    }))
    const w = await clickCheck()
    expect(w.text()).toContain('✗ 確認エラー: 503 DTAKO_R2 binding が未設定です')
    // 直す前の姿 (status の後ろが空) に戻っていないこと。
    expect(w.text()).not.toMatch(/確認エラー: 503\s*$/)
  })

  it('本文が空なら「空でした」と言う (理由が無いのと読めなかったのを混ぜない)', async () => {
    respond(502, '')
    const w = await clickCheck()
    expect(w.text()).toContain('✗ 確認エラー: 502 (応答本文が空でした)')
  })

  it('本文が JSON でなければ、そう言って生本文の先頭を添える', async () => {
    respond(502, '<html><body>Bad gateway</body></html>', 'text/html')
    const w = await clickCheck()
    expect(w.text()).toContain('502 (応答が JSON ではありません:')
    expect(w.text()).toContain('Bad gateway')
  })

  it('JSON だが理由の文字列が無ければ [object Object] を出さず、生本文を添える', async () => {
    respond(500, JSON.stringify({ error: true, statusCode: 500, detail: { code: 42 } }))
    const w = await clickCheck()
    expect(w.text()).toContain('500 (本文に理由の文字列がありません:')
    expect(w.text()).toContain('"code":42')
    expect(w.text()).not.toContain('[object Object]')
  })

  it('2xx のときは何も壊していない (あり / なし の表示はそのまま)', async () => {
    respond(200, JSON.stringify({ exists: false, key: 'templates/x.xlsx' }))
    const w = await clickCheck()
    expect(w.text()).toContain('✗ なし')
    expect(w.text()).not.toContain('確認エラー')
  })
})

/**
 * `:207` (テンプレ保存) と `:298` (xlsx ダウンロード) も同じ穴を持っていた —
 * `text || res.statusText` なので**本文が空のときだけ** `statusText` に落ち、
 * 本番 (HTTP/3) は `502: ` / `xlsx 生成失敗 (502): ` と**区切り文字の後ろが空**になる。
 * 発火条件は `:159` より狭いが**穴の形は同じ**なので、同じヘルパに揃えた (Refs #890)。
 */
describe('/y-time-export の残り 2 口 (テンプレ保存 / xlsx ダウンロード)', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { globalThis.fetch = realFetch })

  async function mountWithFile() {
    const w = mount(Page)
    await flushPromises()
    const input = w.find('input[type="file"]')
    const file = new File([new Uint8Array([1, 2, 3])], 'x.xlsx')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await flushPromises()
    return w
  }

  it('テンプレ保存: 本文が空でも「502: 」で終わらせない', async () => {
    respond(502, '')
    const w = await mountWithFile()
    await w.findAll('button').find(b => b.text() === 'R2 に保存')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('✗ 502 (応答本文が空でした)')
    expect(w.text()).not.toMatch(/✗ 502:\s*$/)
  })

  it('テンプレ保存: 本文があれば理由を出す (生 JSON をそのまま貼らない)', async () => {
    respond(503, JSON.stringify({
      error: true, statusCode: 503,
      statusMessage: 'DTAKO_R2 binding が未設定です',
      message: 'DTAKO_R2 binding が未設定です',
    }))
    const w = await mountWithFile()
    await w.findAll('button').find(b => b.text() === 'R2 に保存')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('✗ 503 DTAKO_R2 binding が未設定です')
    // 以前は本文 (JSON 文字列) を丸ごと貼っていた。
    expect(w.text()).not.toContain('"error":true')
  })

  it('xlsx ダウンロード: 本文が空でも「xlsx 生成失敗 (502): 」で終わらせない', async () => {
    respond(502, '')
    const w = mount(Page)
    await flushPromises()
    await w.find('select').setValue('0001')
    const dates = w.findAll('input[type="date"]')
    await dates[0]!.setValue('2026-07-01')
    await dates[1]!.setValue('2026-07-31')
    await flushPromises()
    await w.findAll('button').find(b => b.text() === 'ダウンロード')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('xlsx 生成失敗: 502 (応答本文が空でした)')
    expect(w.text()).not.toContain('xlsx 生成失敗 (502):')
  })
})
