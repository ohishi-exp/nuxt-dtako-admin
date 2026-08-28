/**
 * 期間集計タブが、月ごとに**拘束の元データ (`kosoku-daily`) を組めたか**を出すこと
 * (Refs #998 / #986 / #989)。
 *
 * #986 の目的は「**土台が違う 2 つを『同じ条件で計算した 2 つ』として比べてしまう**」
 * を止めること。単月 (#989) には注記が入ったが、**一番「後から比べる」場所である
 * 期間集計タブには何も出ていなかった** — 上流は `months[].timecard_kosoku` を
 * 返しているのに、front の `parseWageRange` がキーを明示列挙する実装で読み捨てていた。
 *
 * **合成後の 1 文で判断する** (memory `ui-text-judge-composed-string`)。文言そのものの
 * 検査は `tests/utils/wage-range-view.test.ts` の担当で、ここが見るのは
 * **画面に届いているか**と、**hover しなくても読めるか** (印が `title` だけに
 * 逃げていないか)。
 *
 * ここは表示のみのテスト。**金額は 1 円も動かさない**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS, UIconStub } from '../helpers/stubs'

const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})
mockNuxtImport('useRoute', () => () => ({ query: {}, params: {} }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn(), replace: vi.fn() }))

const Page = (await import('~/pages/restraint-wage.vue')).default

type Kosoku = 'yes' | 'no' | 'unreadable'

/**
 * `wage-range` 応答。**月ごとに違う状態**を入れる — 期間集計は月の配列を横に
 * 並べる画面なので、単月 (1 レポート = 1 状態) の注記はそのままでは使えない。
 * `undefined` の月は `timecard_kosoku` を**キーごと入れない** (上流の
 * `skip_serializing_if` と同じ形)。
 */
function rangeBody(states: (Kosoku | undefined)[], restraintSource: string) {
  return {
    from: '2026-01',
    to: `2026-0${states.length}`,
    restraint_source: restraintSource,
    months: states.map((st, i) => ({
      ym: `2026-0${i + 1}`,
      saved: true,
      drivers: 1,
      computed_at: '2026-08-05T01:20:00Z',
      stale: false,
      ...(st === undefined ? {} : { timecard_kosoku: st }),
    })),
    rows: [],
  }
}

async function mountRange(states: (Kosoku | undefined)[], restraintSource = 'current') {
  sessionStorage.setItem('restraint-wage:tab', 'range')
  sessionStorage.setItem('restraint-wage:month', '2026-07')
  localStorage.setItem('theearth-session', JSON.stringify({
    compId: '0001', userName: 'tester', token: 'tok',
  }))
  // 配列を返すべきキーは必ず配列で返す — `{}` を返すと無関係の描画が throw し、
  // Vue がその subtree の更新を止めて「印が無い」ように見える
  const EMPTY = {
    months: [], rows: [], items: [], entries: [], employees: [], warnings: [], data: null,
  }
  const reply = (url: unknown) => (typeof url === 'string' && url.includes('/wage-range')
    ? rangeBody(states, restraintSource)
    : EMPTY)
  const fetchFn = vi.fn(async (url: unknown) => reply(url)) as unknown as {
    (url: unknown, opts?: unknown): Promise<unknown>, raw: unknown
  }
  fetchFn.raw = vi.fn(async (url: unknown) => ({ _data: reply(url), headers: { get: () => null } }))
  vi.stubGlobal('$fetch', fetchFn)

  const w = mount(Page, {
    global: {
      stubs: {
        ...NUXT_UI_PAGE_STUBS,
        UCheckbox: { props: ['modelValue'], template: '<input type="checkbox" />' },
        UFormField: { template: '<div><slot /></div>' },
        UInput: { props: ['modelValue'], template: '<input :value="modelValue" />' },
        UModal: { template: '<div />' },
        USelectMenu: { props: ['modelValue'], template: '<select />' },
        UTextarea: { props: ['modelValue'], template: '<textarea />' },
        UIcon: UIconStub,
      },
    },
  })
  for (let i = 0; i < 8; i++) await flushPromises()
  return w
}

/** 描画された全文を人が読む 1 続きの文に正規化する (改行・連続空白を 1 つに畳む)。 */
function composed(w: { text: () => string }): string {
  return w.text().replace(/\s+/g, ' ')
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  nuxtState.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/restraint-wage 期間集計: 月ごとの拘束の元データの印 (Refs #998)', () => {
  it('月バーが描けている (前提。バーが無いと印の周りごと描かれない)', async () => {
    expect(composed(await mountRange(['yes']))).toContain('2026年1月 保存済')
  })

  it('★ 取れなかった月と読めなかった月が、月バーの上で見分けられる', async () => {
    const w = await mountRange(['yes', 'no', 'unreadable', undefined])
    const text = composed(w)
    // ★ 直す前はこの 3 つがどこにも無く、どの月も同じ「保存済」に見えていた
    expect(text).toContain('2026年1月 保存済 ✓ 拘束元 取得済')
    expect(text).toContain('2026年2月 保存済 ⚠ 拘束元 取れず')
    expect(text).toContain('2026年3月 保存済 ✕ 拘束元 読めず')
    // 判定が無い月には印を出さない (「取れた」とも「取れなかった」とも書かない)
    expect(text).toContain('2026年4月 保存済')
    expect(text).not.toContain('2026年4月 保存済 ✓')
  })

  /**
   * ★ #989 が潰した「hover しないと読めない」に戻していないこと。
   * `title` にも詳しい 1 文を足すが、**それは印の代わりではない**。
   */
  it('★ 印は hover しなくても読める (title だけに逃がしていない)', async () => {
    const w = await mountRange(['no'])
    expect(composed(w)).toContain('⚠ 拘束元 取れず')
    expect(w.html()).toContain('拘束の元データ (kosoku-daily) が取れていません')
  })

  it('★ 印の無い月があると、バーの下に注記が出る (gcp 以外)', async () => {
    const text = composed(await mountRange(['yes', undefined], 'current'))
    expect(text).toContain('1 ヶ月には拘束の元データ (kosoku-daily) の判定が付いていません')
    expect(text).toContain('印が無いことは「揃っていた」という意味ではありません')
  })

  it('★ gcp の範囲は「判定していない」と書く (「取れなかった」と読ませない)', async () => {
    const text = composed(await mountRange([undefined, undefined], 'gcp'))
    expect(text).toContain('拘束の元データ (オンプレ kosoku-daily) を組めたかどうかを判定していません (2 ヶ月)')
    expect(text).not.toContain('揃っていた')
  })

  it('★ 全ての月に印があれば注記は出さない (出しっぱなしなら誰も読まなくなる)', async () => {
    const text = composed(await mountRange(['yes', 'no'], 'current'))
    expect(text).toContain('⚠ 拘束元 取れず') // 陽性対照: 印は描けている
    expect(text).not.toContain('判定が付いていません')
    expect(text).not.toContain('判定していません')
  })
})
