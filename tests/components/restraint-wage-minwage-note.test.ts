/**
 * 拘束時間・賃金 (`/restraint-wage`) 「最低賃金チェック」タブが、
 * **なぜ最低賃金との差分を出さないのか**と**代わりに何を見ればよいのか**を
 * 画面に書いていること (Refs #282)。
 *
 * #285 で最低賃金換算・差の表示を全廃したとき、その理由は
 * `docs/wage-calculation-spec.md` §7 と `restraint-wage.vue` のコードコメント 3 か所
 * にしか残らず、**画面には 1 文字も無かった**。しかも
 *
 * - **タブ名が「最低賃金チェック」**なのに最低賃金との比較が 1 つも出ていない
 * - **最低賃金の設定カードが同じタブに同居**していて、そこに入れた額が
 *   上の表の判定に使われないことがどこにも書いていない
 *
 * ので、**「そこに入れた下限でチェックされた結果を見ている」と読めてしまう**
 * (map skill 8節(7)「出ているものが別の意味に読める」の型)。
 *
 * **合成後の 1 文で判断する** — ヘルパ 1 本や `<b>` の中身だけを見て
 * 「書いてある」と決めない (memory `ui-text-judge-composed-string`)。
 * `w.text()` は `<b>` を落として地の文と連結するので、**人が読む 1 文がそのまま出る**。
 *
 * ここは**表示のみ**のテスト。金額は 1 円も動かさないので、
 * 金額そのものの検証は golden (`restraint-wage-golden.test.ts`) の担当。
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

/** 共有 fixture (`tests/fixtures/restraint-wage/`) の summary と golden の wage を
 * 乗務員CD で突き合わせて wage-report 応答の形に畳む。**表に行が出れば足りる** —
 * この注記は `rows.length` があるときだけ描かれるため。 */
function wageReportBody() {
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
      })),
    no_data_drivers: [],
    warnings: [],
    restraint_source: 'gcp',
  }
}

/** 最低賃金チェックタブを開いた状態で描く。タブ・対象月は `sessionStorage`、
 * theearth セッションは `localStorage` から `onMounted` が復元する
 * (画面の実際の経路をそのまま使う)。 */
async function mountMinWageTab() {
  sessionStorage.setItem('restraint-wage:tab', 'minwage')
  sessionStorage.setItem('restraint-wage:month', YM)
  localStorage.setItem('theearth-session', JSON.stringify({
    compId: '0001', userName: 'tester', token: 'tok',
  }))
  const body = wageReportBody()
  // 既定ソースは `gcp` (plain `$fetch`)。`current` は `$fetch.raw` (`res._data`) を通る。
  // **どちらが選ばれても行が出る**ようにしておく (既定が変わってもこのテストは意味を保つ)。
  // wage-report 以外の口は**空だが型の合う形**で返す。素の `{}` を返すと
  // `archiveMonths.value = res.months` のような代入で `undefined` が入り、
  // 月セレクタの `.includes` が落ちる (このタブとは無関係の描画で試験が死ぬ)。
  // ★ 配列を返すべきキーは**必ず配列で**返す (`employees` を落として `{}` にすると
  //    `employeeOrderAttrsByDriver` が `entries is not iterable` で throw し、
  //    **Vue がその subtree の更新を止める** — state は正しいのに DOM だけ
  //    「集計を読み込んでいます…」のまま固まり、注記が無いように見える。
  const EMPTY = {
    months: [], rows: [], items: [], entries: [], employees: [], warnings: [], data: null,
  }
  const reply = (url: unknown) =>
    (typeof url === 'string' && url.includes('/wage-report') ? body : EMPTY)
  const fetchFn = vi.fn(async (url: unknown) => reply(url)) as unknown as {
    (url: unknown): Promise<unknown>, raw: unknown
  }
  fetchFn.raw = vi.fn(async (url: unknown) => ({ _data: reply(url) }))
  vi.stubGlobal('$fetch', fetchFn)

  const w = mount(Page, {
    global: {
      stubs: {
        ...NUXT_UI_PAGE_STUBS,
        // 共有スタブの `UCard` は**既定スロットしか描かない**。最低賃金カードの
        // 説明文は `#header` にあるので、**本物のテンプレートに近づける方向**で
        // ここだけ上書きする (描く量を減らす上書きではない)。
        UCard: { name: 'UCard', template: '<div><slot name="header" /><slot /><slot name="footer" /></div>' },
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
  // `onMounted` が session/tab/month を復元 → watcher が GCP wage-report を撃つ →
  // 応答で表が描かれる、と**段が深い**。1〜2 回の flush では
  // 「集計を読み込んでいます…」のままになる。
  for (let i = 0; i < 8; i++) await flushPromises()
  return w
}

/** 描画された全文を**人が読む 1 続きの文**に正規化する (改行・連続空白を 1 つに畳む)。
 * テンプレートの折り返しで語の途中に改行が入るため、素の `text()` では
 * 部分一致が取れない。 */
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

describe('/restraint-wage 最低賃金チェック: 最低賃金との差分が無い理由を画面に書く (Refs #282)', () => {
  it('表が描けている (前提。行が無いと注記ごと描かれない)', async () => {
    const w = await mountMinWageTab()
    expect(w.findAll('table.minwage-table').length).toBe(1)
    // `composed()` の `\s+` は全角スペース (U+3000) も畳むので、期待側も半角で書く
    expect(composed(w)).toContain('試験 太郎（正常）')
  })

  it('「最低賃金との差分を出さない」ことを名言している', async () => {
    expect(composed(await mountMinWageTab()))
      .toContain('「最低賃金チェック」という名前ですが、この表は最低賃金との差分を出しません')
  })

  it('★ 逆方向の誤読を潰している — 「比較が無い = チェックしていない」と読ませない', async () => {
    const text = composed(await mountMinWageTab())
    // 理由 (等号が自明) と、省略ではないことの明示が **両方** 要る。
    expect(text).toContain('単価マスタの基礎単価 = 最低賃金')
    expect(text).toContain('比較しても常に等号が成立して読む意味がないためです')
    expect(text).toContain('チェックを省いているのではありません')
  })

  it('★ 代わりに何を見ればよいかを書いている (法的な比較は「基礎単価 ≥ 最低賃金」)', async () => {
    const text = composed(await mountMinWageTab())
    expect(text).toContain('法的な最低賃金比較は「基礎単価 ≥ 最低賃金」の判定なので、見るのは基本給(法定内) の @単価')
  })

  it('★ 最低賃金カードの額の行き先を、表のフッタと カードの説明の 両方に書いている', async () => {
    const text = composed(await mountMinWageTab())
    // フッタ側 (表を読んでいる人が読む)
    expect(text).toContain('下の「最低賃金」カードの額は、この表では最低賃金割れの判定には使いません')
    expect(text).toContain('使うのは「給与比較」タブの 残業(最低賃金) 列')
    // カード側 (額を入力する当人が読む)。**ここが誤読の発生源**なので、
    // フッタまでスクロールしなくても分かる位置にも要る。
    expect(text).toContain('上の表の最低賃金割れ判定には使いません — 使うのは「給与比較」タブの 残業(最低賃金) 列と、上の表の月給者「みなし時間数」(@n.nh) です')
  })

  it('★ この表でも最低賃金を使っている 1 か所 (月給者のみなし時間数) を隠していない', async () => {
    // `row.wage.minWage.rate` は最低賃金カードと同じ R2 マスタ由来で、この表の
    // **給与 列 (月給者・固定残業)** で `@n.nh` として使われている
    // (`fmtOvertimeMinWageHours`)。**「この表では一切使いません」は嘘になる** ので、
    // 注記は「最低賃金割れの**判定**には使わない」と限定し、使っている先を名指しする。
    const text = composed(await mountMinWageTab())
    expect(text).toContain('給与 列に出る月給者の「みなし時間数」(@n.nh = 残業代(定額) ÷ 最低賃金)')
    // 「使いません」を無条件に言い切っていないこと (言い切ると 5892 行の表示が嘘になる)
    expect(text).not.toContain('この表の判定には使いません')
  })

  it('★ 対照: 表に時給列 (総支給時給 / 最低賃金 / 差、および旧名の換算時給) が復活していない — 復活したら上の注記が嘘になる', async () => {
    const w = await mountMinWageTab()
    const headers = w.findAll('table.minwage-table thead th').map(th => th.text().replace(/\s+/g, ' '))
    // **新名で塞ぐ** (Refs #938)。月次集計タブの同じ列は `換算時給` → `総支給時給` に
    // 改称したので、**旧名だけ見ていると新名の列を足されて素通りする** — 旧名を製品から
    // 消した以上、このガードが実際に守れるのは新名の側。
    // `総支給時給−最低賃金` も `総支給時給` を含むので、この 1 行で差の列も塞がる。
    expect(headers.some(h => h.includes('総支給時給'))).toBe(false)
    // 旧名も残す — 復活の仕方が 2 通りある (改称前のコードを戻す / 新しく足す)。
    expect(headers.some(h => h.includes('換算時給'))).toBe(false)
    // 「最低賃金」を名乗る列が無いこと (設定カードの見出しは表の外なので拾わない)
    expect(headers.some(h => h.includes('最低賃金'))).toBe(false)
    // 残っているべき列は残っている (列を消していないことの陽性対照)
    expect(headers.some(h => h.includes('基本給(法定内)'))).toBe(true)
    expect(headers.some(h => h.includes('深夜(通常)'))).toBe(true)
  })
})
