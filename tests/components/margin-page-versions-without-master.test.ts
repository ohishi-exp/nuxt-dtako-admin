/**
 * **手当マスタが `error` の回でも「R2 に残っている版」の一覧は読む** (Refs #1017)。
 *
 * #1016 (#805 PR-2) が「マスタの出どころが決まらないうちは**金額**を出さない」を入れた
 * とき、`onMounted` の `restoreFromCache()` ごと `if (masterOk)` の内側に入れた。
 * この関数の末尾には**版の一覧を読む 1 行が同居していた** (Refs #833) ので、
 * マスタが読めない回は**金額と関係の無い版の一覧まで画面から消える**副作用が出た。
 *
 * 版の一覧は R2 のオブジェクトを並べるだけで**手当マスタを 1 行も見ない**。むしろ
 * 金額を伏せている回こそ「いつ変わったかを追える記録」(R2 の版) が要る。
 *
 * **陰性対照**: 1 本目 (`マスタが error でも版の一覧を読む`) は基点 `d91888c` の
 * コードに当てると落ちる (`/api/profit/margin-snapshots` が 1 回も呼ばれない)。
 * **陽性対照**: 2 本目・3 本目で **#1016 の判断 (error なら金額を出さない) を固定**する
 * — この直しでそこを緩めていないことまで測る。4 本目は**この PR で変えていない**
 * 「月が違うキャッシュは使わない」を留める (`cache.ym !== ym.value` は #1016 以前からの挙動)。
 *
 * **キャッシュを読む位置が `if (masterOk)` の外へ出た副作用**も 2 本で固定する (末尾)。
 * `キャッシュを読めませんでした` の注記がマスタ error の回にも出るようになるが、
 * **金額を出していない理由はマスタ側の注記が言う**べきで、この 1 文が
 * 「だから金額を出していない」と読めてはいけない (memory `shared-notice-lies-on-second-screen`)。
 * **合成後の 1 文をまるごと固定**してそこを留める。
 *
 * **「集計」を押した回**も同じ話 (Refs #1017 の 2 本目)。`run()` は版の一覧を**空にしてから**
 * `ensureRateMaster()` の早期 return に入るので、マスタが error のまま押すと
 * **`onMounted` で出した版が消えて、ページを開き直すまで戻らない**。空にするのは正しい
 * (月を変えて押した回に前の月の版が残ると入力欄と一覧が食い違う) ので、
 * **早期 return の中で `ym.value` の版を読み直す**。末尾 3 本で留める。
 *
 * 画面のローカル関数なので、`margin.vue` を**実際に mount して文字を読む**以外に測る手が無い
 * (memory `mount-huge-page-via-storage-and-usestate` と同じ形)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { MARGIN_CACHE_KEY, serializeMarginCache, type MarginCache, type MarginOperationInput } from '~/utils/margin'
import { LAST_SEARCH_KEY, serializeLastSearch } from '~/utils/allowance-last-search'
import { ALLOWANCE_RATE_ENDPOINT } from '~/utils/allowance-rate-source'
import type { MarginVersionListResult } from '~/utils/margin-versions'

const { getDriversMock } = vi.hoisted(() => ({ getDriversMock: vi.fn() }))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDrivers: getDriversMock,
  // マスタも版の一覧も `Authorization: Bearer` を載せる経路。**空だと $fetch まで届かない**。
  currentAccessToken: () => 'test-token',
}))

// 画面は setup で `useRuntimeConfig().public.codeVersion` を読む (保存する版に添える値)。
mockNuxtImport('useRuntimeConfig', () => () => ({ public: { codeVersion: 'test' } }))

const MarginPage = (await import('~/pages/profit/margin.vue')).default

/** キャッシュの月。`LAST_SEARCH_KEY` で画面の月もここに揃える。 */
const CACHE_YM = '2026-07'
/** 版の一覧に出るラベル (JST 固定長)。**この月にしか無い文字列**にする。 */
const VERSION_LABEL = 'v-20260720T090000'
/** キャッシュの金額が画面に出たかどうかの目印。**マスタが error の回に出てはいけない。** */
const CACHED_DRIVER = '粗利キャッシュ 太郎'

/** マスタの応答。`null` なら `error` (`応答が JSON オブジェクトではありません`)。 */
let rateResponse: unknown = null
/** 版の一覧を引いたときの `ym` (呼ばれなければ空)。 */
let snapshotQueryYms: string[] = []

const fetchMock = vi.fn(async (url: string, opts?: { query?: Record<string, unknown> }) => {
  if (url === ALLOWANCE_RATE_ENDPOINT) return rateResponse
  if (url === '/api/profit/margin-snapshots') {
    snapshotQueryYms.push(String(opts?.query?.ym))
    return versionList()
  }
  if (url === '/restraint-api/min-wage') return { exists: false, data: null }
  if (url === '/restraint-api/archive/summaries') return { summaries: [] }
  throw new Error(`想定していない呼び出し: ${url}`)
})

function versionList(): MarginVersionListResult {
  return {
    ym: CACHE_YM,
    items: [{
      key: `profit/margin/${CACHE_YM}/${VERSION_LABEL}.json`,
      label: VERSION_LABEL,
      totals: { operations: 3, salesYen: 300000, allowanceYen: 90000, marginYen: 120000 },
      totalsState: 'read',
    }],
    total: 1,
    bodyLimit: 20,
    omitted: 0,
    unreadable: 0,
  }
}

function operation(): MarginOperationInput {
  return {
    unkoNo: '26070104195900000011091',
    date: '2026-07-01',
    driverName: CACHED_DRIVER,
    vehicleCode: '1109',
    totalKm: 100,
    listedTotalKm: 100,
    kmBreakdown: { haulKm: 100, betweenLegsKm: 0, toFirstLoadKm: 0, fromLastUnloadKm: 0 },
    salesYen: 777777,
    allowanceYen: 9000,
    legs: [],
  }
}

function cache(ym: string): MarginCache {
  return {
    ym,
    savedAt: '2026-07-20T00:00:00.000Z',
    operations: [operation()],
    costs: [],
    uncovered: null,
    crossMonth: null,
  }
}

function mountPage() {
  return mount(MarginPage, {
    global: {
      stubs: {
        NuxtLink: { template: '<a><slot /></a>' },
        UButton: { props: ['label'], template: '<button>{{ label }}<slot /></button>' },
        UIcon: { template: '<span />' },
        UModal: { template: '<div />' },
        DriverSearchSelect: { template: '<div />' },
        KushiroBranchPanel: { template: '<div />' },
        OperationRouteMap: { template: '<div />' },
      },
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  // 会社ID (`readViewerCompId`) が無いとマスタも最低賃金も $fetch まで行かない。
  localStorage.setItem('restraint-viewer-comp', '27324455')
  localStorage.setItem(LAST_SEARCH_KEY, serializeLastSearch({ ym: CACHE_YM, vehicle: '' }))
  localStorage.setItem(MARGIN_CACHE_KEY, serializeMarginCache(cache(CACHE_YM)))
  snapshotQueryYms = []
  rateResponse = null
  fetchMock.mockClear()
  getDriversMock.mockReset().mockResolvedValue([])
  vi.stubGlobal('$fetch', fetchMock)
})

describe('/profit/margin の「R2 に残っている版」と手当マスタ (Refs #1017)', () => {
  it('★ マスタが error でも、月の合うキャッシュがあれば版の一覧は読む', async () => {
    const w = mountPage()
    await flushPromises()
    // 読んだ先はキャッシュの月。
    expect(snapshotQueryYms).toEqual([CACHE_YM])
    // 画面にも出る (区画ごと消えていないこと)。
    expect(w.text()).toContain('R2 に残っている版')
    expect(w.text()).toContain(VERSION_LABEL)
  })

  it('★ そのとき金額は 1 つも出さない (#1016 の判断は変えていない)', async () => {
    const w = mountPage()
    await flushPromises()
    // 理由は出る。
    expect(w.text()).toContain('運行手当マスタを読めませんでした')
    expect(w.text()).toContain('手当・粗利は表示しません')
    // キャッシュの金額は出さない (`status === 'ready'` にしない)。
    expect(w.text()).not.toContain(CACHED_DRIVER)
    expect(w.text()).not.toContain('777,777')
    expect(w.text()).not.toContain('前回の集計')
  })

  it('マスタが読めた回は今までどおりキャッシュの金額を出し、版の一覧も読む', async () => {
    rateResponse = { exists: false }
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('前回の集計')
    expect(w.text()).toContain(CACHED_DRIVER)
    expect(snapshotQueryYms).toEqual([CACHE_YM])
  })

  /**
   * `localStorage.getItem` が投げる回 (SecurityError・quota 等)。**壊れた JSON では通らない** —
   * `parseMarginCache` は `JSON.parse` を自分で catch して `null` を返すので、
   * この経路に入るのは**読み出しそのものが失敗したとき**だけ (下の 1 本で対にして留める)。
   */
  it('キャッシュを読めなかった回は、その 1 文だけを出す (金額を出していない理由はマスタ側が言う)', async () => {
    const real = localStorage.getItem.bind(localStorage)
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation((key: string) => {
      if (key === MARGIN_CACHE_KEY) throw new Error('localStorage が読めません')
      return real(key)
    })
    const w = mountPage()
    await flushPromises()
    spy.mockRestore()
    // **合成後の 1 文をまるごと固定する。** 金額にも手当マスタにも触れていないこと。
    const note = w.findAll('p').map(p => p.text()).find(t => t.startsWith('キャッシュを読めませんでした'))
    expect(note).toBe('キャッシュを読めませんでした — localStorage が読めません')
    // 金額を出していない理由は**マスタ側の注記が言う** (2 本並ぶが、人が次にやることが違う)。
    expect(w.text()).toContain('手当・粗利は表示しません')
    // キャッシュが無いのだから月も分からない — 版の一覧は読まない。
    expect(snapshotQueryYms).toEqual([])
  })

  it('壊れた JSON では「読めませんでした」を出さない (`parseMarginCache` が null に倒す)', async () => {
    localStorage.setItem(MARGIN_CACHE_KEY, '{壊れた JSON')
    const w = mountPage()
    await flushPromises()
    expect(w.text()).not.toContain('キャッシュを読めませんでした')
    expect(snapshotQueryYms).toEqual([])
  })

  /** 「集計」ボタン。`status === 'loading'` のときだけ文言が変わるので、両方で拾う。 */
  function runButton(w: ReturnType<typeof mountPage>) {
    return w.findAll('button').find(b => b.text() === '集計' || b.text() === '集計中...')!
  }

  it('★ マスタが error のまま「集計」を押しても、版の一覧が消えない', async () => {
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain(VERSION_LABEL)

    await runButton(w).trigger('click')
    await flushPromises()

    // 空にした後に読み直しているので、`ym.value` (= 画面の月) でもう 1 回引く。
    expect(snapshotQueryYms).toEqual([CACHE_YM, CACHE_YM])
    expect(w.text()).toContain('R2 に残っている版')
    expect(w.text()).toContain(VERSION_LABEL)
    // 金額はやはり出さない (#1016 の判断)。
    expect(w.text()).toContain('手当・粗利は表示しません')
    expect(w.text()).not.toContain(CACHED_DRIVER)
  })

  it('月を空にして「集計」を押した回は読み口を叩かない (400 の注記を出さない)', async () => {
    const w = mountPage()
    await flushPromises()
    await w.find('input[type="month"]').setValue('')

    await runButton(w).trigger('click')
    await flushPromises()

    // mount 時の 1 回だけ。空の `ym` で引くと読み口が 400 を返す。
    expect(snapshotQueryYms).toEqual([CACHE_YM])
    expect(w.text()).not.toContain('R2 に残した版の一覧を読めませんでした')
  })

  it('マスタが正常なら「集計」の版の読み直しは今までどおり集計の最後だけ', async () => {
    rateResponse = { exists: false }
    const w = mountPage()
    await flushPromises()
    expect(snapshotQueryYms).toEqual([CACHE_YM])

    await runButton(w).trigger('click')
    await flushPromises()

    // **早期 return を通らないので、ここでは 1 回も増えない。** 版を読み直すのは
    // 集計しきった最後 (`loadMarginVersions(shownYm.value)`) だけで、この回は
    // 運行の検索が失敗して (テストでは `initApi` を通っていないので `API 未初期化`)
    // そこまで届かない。**足した読み直しが成功経路に漏れていない**ことの陽性対照。
    expect(snapshotQueryYms).toEqual([CACHE_YM])
    // 一覧は `run()` の頭で空にしたまま (この PR で変えていない挙動)。
    expect(w.text()).not.toContain(VERSION_LABEL)
  })

  it('月が違うキャッシュでは版の一覧を読まない (#1016 以前からの挙動、この PR で変えない)', async () => {
    localStorage.setItem(MARGIN_CACHE_KEY, serializeMarginCache(cache('2026-06')))
    const w = mountPage()
    await flushPromises()
    expect(snapshotQueryYms).toEqual([])
    expect(w.text()).not.toContain('R2 に残っている版')
  })
})
