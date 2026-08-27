/**
 * 拘束×賃金 (`/restraint-wage`) が、**拘束の元データ (`kosoku-daily`) を取れないまま
 * 打刻だけで組んだ表**であることを画面に出すこと (Refs #980)。
 *
 * 本番で実際に起きた: 上流が 502 を返した回は 97 名ぶんが打刻だけで組まれ、6 分後の
 * 再読み込みでは取れていた。**どちらの画面にも警告は 1 つも無く**、違う根拠の数字を
 * 見た 2 人がどちらも「正常」と読んだ。合図は relay の `console.log` 1 行だけで、
 * Workers Logs にしか出ていなかった。
 *
 * `kosokuPartsFor` が無いと拘束・実働が打刻だけから組まれ、運行単位でしか打刻しない
 * 乗務員 (長距離) は休息で区切れないぶん時間が長く出る = 残業が過大に出る (#960)。
 *
 * **合成後の 1 文で判断する** (memory `ui-text-judge-composed-string`)。
 * 文言そのものの検査は `tests/utils/restraint-wage-view.test.ts` の担当で、
 * ここが見るのは**画面に届いているか**と**出てはいけない画面に出ていないか**。
 *
 * ここは表示のみのテスト。**金額は 1 円も動かさない**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS, UIconStub } from '../helpers/stubs'
import summaries from '../fixtures/restraint-wage/summaries.json'
import goldenRows from '../fixtures/restraint-wage/golden/wage-rows.json'

const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})
mockNuxtImport('useRoute', () => () => ({ query: {}, params: {} }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn(), replace: vi.fn() }))

const Page = (await import('~/pages/restraint-wage.vue')).default

const YM = '2026-07'

/** 共有 fixture を wage-report 応答の形に畳む。**行はすべてタイムカード由来**に
 * する — 注記が数えるのはこの行だけで、件数が文面に出る。 */
function wageReportBody(timecardKosoku: 'yes' | 'no' | 'unreadable' | null) {
  const wageByCd = new Map(goldenRows.map(g => [g.driverCd, g.wage]))
  return {
    month: YM,
    rows: summaries
      .filter(s => wageByCd.has(s.driverCd))
      .map(s => ({
        summary: s,
        fetched_at: null,
        last_verified_at: null,
        wage: wageByCd.get(s.driverCd),
        source: 'timecard',
      })),
    no_data_drivers: [],
    warnings: [],
    timecard_kosoku: timecardKosoku,
  }
}

const TIMECARD_ROWS = wageReportBody('no').rows.length

/**
 * 指定タブを開いた状態で描く。タブ・対象月は `sessionStorage`、theearth セッションは
 * `localStorage` から `onMounted` が復元する (画面の実際の経路をそのまま使う)。
 *
 * `current` と `gcp` で**別の応答**を返す — 最低賃金チェックの既定は `gcp` で、
 * そこでは `timecard_kosoku` が null (取りに行っていない) になるため。
 */
async function mountTab(
  tab: 'monthly' | 'minwage',
  states: { current: 'yes' | 'no' | 'unreadable' | null, gcp?: 'yes' | 'no' | 'unreadable' | null },
) {
  sessionStorage.setItem('restraint-wage:tab', tab)
  sessionStorage.setItem('restraint-wage:month', YM)
  localStorage.setItem('theearth-session', JSON.stringify({
    compId: '0001', userName: 'tester', token: 'tok',
  }))
  // 配列を返すべきキーは必ず配列で返す — `{}` を返すと無関係の描画が throw し、
  // Vue がその subtree の更新を止めて「注記が無い」ように見える
  const EMPTY = {
    months: [], rows: [], items: [], entries: [], employees: [], warnings: [], data: null,
  }
  const reply = (url: unknown, opts?: { query?: { source?: string } }) => {
    if (typeof url !== 'string' || !url.includes('/wage-report')) return EMPTY
    return opts?.query?.source === 'gcp'
      ? wageReportBody(states.gcp ?? null)
      : wageReportBody(states.current)
  }
  const fetchFn = vi.fn(async (url: unknown, opts?: unknown) =>
    reply(url, opts as { query?: { source?: string } })) as unknown as {
      (url: unknown, opts?: unknown): Promise<unknown>, raw: unknown
    }
  // 既定ソース (`current`) は `$fetch.raw` を通り、`x-upstream-cache` ヘッダを読む
  fetchFn.raw = vi.fn(async (url: unknown, opts?: unknown) => ({
    _data: reply(url, opts as { query?: { source?: string } }),
    headers: { get: () => null },
  }))
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
  // onMounted の復元 → watcher → 応答 → 表、と段が深い
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

describe('/restraint-wage: 拘束の元データが欠けたまま組んだ表であることを出す (Refs #980)', () => {
  it('表が描けている (前提。行が無いと注記の周りごと描かれない)', async () => {
    expect(composed(await mountTab('monthly', { current: 'no' }))).toContain('試験 太郎（正常）')
  })

  it('★ 当月の kosoku-daily が取れなかったら、月次集計に注記が出る', async () => {
    const text = composed(await mountTab('monthly', { current: 'no' }))
    // ★ 直す前はこの 1 文がどこにも無く、同じ表が「正常」として読まれていた
    expect(text).toContain('拘束の元データ (kosoku-daily) が取れていません')
    expect(text).toContain(`タイムカード由来の ${TIMECARD_ROWS} 行は、拘束・実働を打刻 (始業・終業) だけから組んでいます`)
    expect(text).toContain('そこから計算する残業・金額も過大側になります')
    expect(text).toContain('少し待ってから画面を読み直すと入ります')
  })

  it('★ 逆方向の誤読を潰す — 取れている時は注記を出さない (出しっぱなしなら誰も読まなくなる)', async () => {
    const text = composed(await mountTab('monthly', { current: 'yes' }))
    expect(text).toContain('試験 太郎（正常）') // 陽性対照: 表は描けている
    expect(text).not.toContain('拘束の元データ (kosoku-daily)')
  })

  it('★ 「読めなかった」は別の見た目で出る (読み直しでは直らないので処方が逆)', async () => {
    const text = composed(await mountTab('monthly', { current: 'unreadable' }))
    expect(text).toContain('拘束の元データ (kosoku-daily) の形が読めません')
    expect(text).toContain('読み直しても直りません')
    expect(text).not.toContain('拘束の元データ (kosoku-daily) が取れていません')
  })

  it('★ 最低賃金チェック (既定 = GCP) には出さない — 時間が GCP 由来に差し替わっていて kosoku-daily は関係ない', async () => {
    // 既定ソースの応答は "no" のまま。表示しているのは GCP の応答 (null) なので、
    // ここで注記を出すと「取れなかったので打刻由来です」という**別の嘘**になる
    const text = composed(await mountTab('minwage', { current: 'no', gcp: null }))
    expect(text).toContain('拘束時間ソース') // 陽性対照: 最低賃金チェックを描いている
    expect(text).not.toContain('拘束の元データ (kosoku-daily)')
  })
})
