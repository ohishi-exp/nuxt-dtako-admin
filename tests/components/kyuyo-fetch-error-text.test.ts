/**
 * `/kyuyo-fetch` が**画面に出す 1 文** (Refs #1050)。
 *
 * この画面には非 2xx の理由を読む口が **2 つ**ある。どちらも直す前は
 * **`statusMessage` を先に読んでいた**ので、server route が
 * `createError({ statusMessage: <ASCII>, message: <日本語> })` を投げると
 * **画面に ASCII だけが出ていた**:
 *
 * | 口 | 押すもの | 出る場所 |
 * | --- | --- | --- |
 * | `refreshList` (`app/pages/kyuyo-fetch.vue:150`) | 「リスト更新 (差分)」/「フル更新」 | `pageError` (赤い 1 行) |
 * | `fetchRange` (`app/pages/kyuyo-fetch.vue:214`) | 「一括で引き直す」 | `fetchErrors` (赤い箇条書き) |
 *
 * **server 側では直せない** — `statusMessage` に日本語を入れると本番 (workerd) で
 * reason phrase が壊れ、画面の注記に穴が出る (#1032 / #886 で 2 度踏んでいる)。
 *
 * ## ここで固定するもの
 *
 * - **日本語が出る** / **ASCII が出ない** (陰性対照)
 * - **`statusMessage` しか無い応答では今までどおり `statusMessage` が出る** (陽性対照)。
 *   「日本語を出す」直しで**英文しか無いときに理由がゼロになる**と、直す前より悪い
 * - **ヘルパの戻り値ではなく合成後の 1 文**を見る (`リスト更新に失敗 (HTTP 403): …` の
 *   接頭辞まで込み)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

vi.mock('~/utils/api', () => ({
  currentAccessToken: vi.fn(() => 'dummy-token'),
}))

import KyuyoFetchPage from '~/pages/kyuyo-fetch.vue'

const realFetch = globalThis.fetch

/** `requireRole` 系の 403 の実物の形 — **ASCII が `statusMessage`、日本語が `message`**。 */
const FORBIDDEN_BODY = {
  error: true,
  url: '/api/kyuyo-master/refresh',
  statusCode: 403,
  statusMessage: 'requires one of roles: kyuyo, admin',
  message: 'この操作には kyuyo または admin の権限が必要です',
}
const FORBIDDEN_JA = 'この操作には kyuyo または admin の権限が必要です'
const FORBIDDEN_ASCII = 'requires one of roles: kyuyo, admin'

/** 会社リスト (`fetchRange` を押すために 1 社だけ選ばれている状態を作る)。 */
const COMPANIES = { companies: [{ company: 'ohishi', name: '大石', years: [2026], updated_at: '2026-08-01' }] }

/**
 * path ごとに応答を決める `fetch`。**`statusText: ''` は本番の形** (h3 は reason
 * phrase を持たない) — `res.statusText` に落ちる実装ならここで露見する。
 */
function stubFetch(routes: Record<string, { status: number, body: unknown }>) {
  globalThis.fetch = (async (input: string) => {
    const path = String(input).split('?')[0]!
    const hit = routes[path] ?? { status: 200, body: {} }
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      statusText: '',
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

async function mountPage() {
  const w = mount(KyuyoFetchPage, {
    global: {
      stubs: {
        ...NUXT_UI_PAGE_STUBS,
        UInput: { props: ['modelValue'], template: '<input :value="modelValue" />' },
      },
    },
  })
  await flushPromises()
  return w
}

function button(w: VueWrapper, label: string) {
  const found = w.findAll('button').filter(b => b.text().trim() === label)
  expect(found, `「${label}」ボタンが 1 つでない`).toHaveLength(1)
  return found[0]!
}

/** `pageError` の赤い 1 行 (`text-red-600` の `<p>`)。 */
function pageErrorText(w: VueWrapper): string {
  const p = w.findAll('p').find(x => x.classes().includes('text-red-600'))
  expect(p, 'pageError の枠 (text-red-600 の p) が出ていない').toBeDefined()
  return p!.text()
}

/** `fetchErrors` の箇条書き (`<ul class="text-red-600">` の `<li>`)。 */
function fetchErrorTexts(w: VueWrapper): string[] {
  const ul = w.findAll('ul').find(x => x.classes().includes('text-red-600'))
  expect(ul, 'fetchErrors の枠 (text-red-600 の ul) が出ていない').toBeDefined()
  return ul!.findAll('li').map(li => li.text())
}

describe('/kyuyo-fetch の「リスト更新」失敗の 1 文 (Refs #1050)', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  async function refreshWith(status: number, body: unknown) {
    // mount 直後の 2 本 (`loadCompanies` / `loadSynced`) も塞ぐ — 塞がないと
    // 素の `fetch` が走って `pageError` が別の理由で埋まる。
    stubFetch({
      '/api/kyuyo-master/companies': { status: 200, body: COMPANIES },
      '/api/kyuyo/synced-months': { status: 200, body: { entries: [] } },
    })
    const w = await mountPage()
    stubFetch({ '/api/kyuyo-master/refresh': { status, body } })
    await button(w, 'リスト更新 (差分)').trigger('click')
    await flushPromises()
    return w
  }

  it('403 — 日本語の message を出す', async () => {
    expect(pageErrorText(await refreshWith(403, FORBIDDEN_BODY)))
      .toBe(`リスト更新に失敗 (HTTP 403): ${FORBIDDEN_JA}`)
  })

  /** **陰性対照** — 直す前に出ていた ASCII が 1 文字も残らない。 */
  it('403 — ASCII の statusMessage は出ない (陰性対照)', async () => {
    expect(pageErrorText(await refreshWith(403, FORBIDDEN_BODY))).not.toContain(FORBIDDEN_ASCII)
  })

  /**
   * ★★ **陽性対照** — `statusMessage` しか無い応答は**これまでどおり**それを出す。
   * `requireAuth` の 401 は `statusMessage: 'Unauthorized'` 固定で、
   * **日本語の理由が最初から存在しない**ので、この道は実際に通る。
   */
  it('401 (statusMessage しか無い) — 今までどおり statusMessage を出す (陽性対照)', async () => {
    expect(pageErrorText(await refreshWith(401, { error: true, statusCode: 401, statusMessage: 'Unauthorized' })))
      .toBe('リスト更新に失敗 (HTTP 401): Unauthorized')
  })

  /** 理由が 1 つも無いときに「(HTTP 500): 」で終わるのは直す前と同じ (この PR の担当外)。 */
  it('理由が 1 つも無ければ status だけ (振る舞いを変えていない)', async () => {
    expect(pageErrorText(await refreshWith(500, { error: true, statusCode: 500 })))
      .toBe('リスト更新に失敗 (HTTP 500):')
  })

  /**
   * ★ **この 2 route は role gate の下に居ない** ので、403 の ASCII では差が出ない。
   * **差が出るのは「握られなかった例外」**: Nitro (`internal/error/prod.mjs`) は
   * `statusMessage` を `"Server Error"` に潰し、本当の理由を `message` にだけ残す。
   * 旧式 (`statusMessage` 先) は `… (HTTP 500): Server Error` と出していて、
   * **理由が出ていないのに「サーバのエラー」と読めた**。
   *
   * 本文は nuxt dev の実機で採った本物 (`/api/netprint/targets` を binding 無しで叩くと
   * Secrets Store が投げてこの形になる)。
   */
  it('握られなかった例外は Server Error ではなく本当の理由を出す', async () => {
    const t = pageErrorText(await refreshWith(500, {
      error: true,
      url: 'http://127.0.0.1:3211/api/kyuyo-master/refresh',
      statusCode: 500,
      statusMessage: 'Server Error',
      message: 'Secret "INTERNAL_SHARED_SECRET" not found',
    }))
    expect(t).toBe('リスト更新に失敗 (HTTP 500): Secret "INTERNAL_SHARED_SECRET" not found')
    expect(t).not.toContain('Server Error')
  })
})

describe('/kyuyo-fetch の「一括で引き直す」失敗の 1 文 (Refs #1050)', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  async function fetchRangeWith(status: number, body: unknown) {
    stubFetch({
      '/api/kyuyo-master/companies': { status: 200, body: COMPANIES },
      '/api/kyuyo/synced-months': { status: 200, body: { entries: [] } },
    })
    const w = await mountPage()
    stubFetch({ '/api/kyuyo/sync': { status, body } })
    await button(w, '一括で引き直す').trigger('click')
    await flushPromises()
    return w
  }

  it('403 — 日本語の message を出す', async () => {
    const [line] = fetchErrorTexts(await fetchRangeWith(403, FORBIDDEN_BODY))
    expect(line).toContain(FORBIDDEN_JA)
    expect(line).toContain('引き直しに失敗')
  })

  /** **陰性対照** — 直す前に出ていた ASCII が 1 文字も残らない。 */
  it('403 — ASCII の statusMessage は出ない (陰性対照)', async () => {
    expect(fetchErrorTexts(await fetchRangeWith(403, FORBIDDEN_BODY))[0]).not.toContain(FORBIDDEN_ASCII)
  })

  /** ★★ **陽性対照** — `statusMessage` しか無い応答はこれまでどおりそれを出す。 */
  it('401 (statusMessage しか無い) — 今までどおり statusMessage を出す (陽性対照)', async () => {
    expect(fetchErrorTexts(await fetchRangeWith(401, { error: true, statusCode: 401, statusMessage: 'Unauthorized' }))[0])
      .toContain('(Unauthorized)')
  })

  /** 理由が 1 つも無ければ `HTTP n` に落ちる (直す前と同じ)。 */
  it('理由が 1 つも無ければ HTTP n に落ちる (振る舞いを変えていない)', async () => {
    expect(fetchErrorTexts(await fetchRangeWith(500, { error: true, statusCode: 500 }))[0])
      .toContain('(HTTP 500)')
  })
})
