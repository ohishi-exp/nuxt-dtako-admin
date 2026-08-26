/**
 * 運行詳細 (`/operations/[unko_no]`) の「一番星の伝票から区間を提案」ボタンが
 * **押しても何も起きない運行で黙らないこと** (Refs #822 ①)。
 *
 * `proposeFromSlips` は検索キー (`raw_data.車輌CD` / 運行日) が無いとき
 * **`proposeStatus` を `'loading'` にする前に `return`** していた。押した人から見ると
 * 表示が一切変わらず、エラーも出ない ⇒ **「ボタンが壊れている」としか読めない**
 * (`SKILL.md` (7)「黙って落とさず数えて画面に言わせる」)。
 *
 * 直しの要点は 2 つあって、どちらもここで固定する:
 *
 * - **無言で終わらせない** — 何が欠けているかを画面に出す
 * - **`'error'` に相乗りさせない** — 「呼んだが駄目だった」は押し直せば変わりうるが、
 *   材料が無い状態は**何度押しても永久に変わらない**。同じ見た目にすると
 *   「もう一度押せば直るかも」と読ませる。だから `'unavailable'` を別に立て、
 *   **車輌CD と運行日のどちらが欠けたかまで言い分ける** (両方あり得る)。
 *
 * **提案の中身 (どの区間を提案するか) は 1 つも変えていない。**陽性対照の
 * 「両方そろっている運行」が今までどおり `'loading'` に入って提案まで走ることを
 * 同じファイルで測り、退行が無いことを示す。
 *
 * ---
 *
 * 後半の describe は **#822 ②-1**: `'not-found'` (「一致する伝票が見つかりませんでした」)
 * に**原因の違う 2 つの状態が相乗り**していた件。伝票が 1 件も無い場合と、
 * **伝票はあるのに `proposeEventRowRange` が全件 null** の場合が同じ文言だったので、
 * 後者を踏んだ人は**ちゃんとある伝票を一番星に探しに行く** (探す先はイベント表)。
 * `'no-event-match'` を別に立て、`'not-found'`(灰)・`'unavailable'`(琥珀)・
 * `'error'`(赤) の**どれとも文言が混ざらない**ことをここで固定する。
 *
 * **同じ型の穴がもう 1 つ**あった: **イベント行が 1 行も無い**運行も
 * 「一致する伝票が見つかりませんでした」と言っていた — **伝票は見てすらいない**のに。
 * こちらは `'no-events'` に分け、探す先が一番星ではなく取込元 (デジタコ) だと読めるようにした。
 * **引けなかっただけ**なら押し直す意味があるので `'error'`(赤) に倒す (`csvError`)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { CsvJsonResponse, Operation } from '~/types'
import type { VehicleDailySlip } from '~/utils/ichiban'

const UNKO_NO = '2607010121120000001318'

const { getOperationMock, getOperationsMock, getOperationCsvMock, fetchVehicleDailySlipsMock } = vi.hoisted(() => ({
  getOperationMock: vi.fn(),
  getOperationsMock: vi.fn(),
  getOperationCsvMock: vi.fn(),
  fetchVehicleDailySlipsMock: vi.fn(),
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getOperation: getOperationMock,
  getOperations: getOperationsMock,
  getOperationCsv: getOperationCsvMock,
}))

vi.mock('~/utils/ichiban', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/ichiban')>()),
  fetchVehicleDailySlips: fetchVehicleDailySlipsMock,
}))

mockNuxtImport('useRoute', () => () => ({ params: { unko_no: UNKO_NO } }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn() }))

const HEADERS = [
  'イベント名', '開始日時', '終了日時', '開始市町村名', '終了市町村名',
  '開始GPS緯度', '開始GPS経度', '開始GPS有効', '終了GPS緯度', '終了GPS経度', '終了GPS有効', '区間距離',
]

function ev(name: string, startCity: string, endCity: string, from: string, to: string): string[] {
  return [name, from, to, startCity, endCity, '42590000', '144230000', '1', '42550000', '143120000', '1', '10']
}

/** 釧路市で積んで士幌町で降す 1 便。 */
const EVENTS_CSV: CsvJsonResponse = {
  headers: HEADERS,
  rows: [
    ev('運行開始', '帯広市', '', '2026/7/1 5:00:00', '2026/7/1 5:00:00'),
    ev('積み', '釧路市', '', '2026/7/1 8:00:00', '2026/7/1 8:30:00'),
    ev('降し', '', '士幌町', '2026/7/1 11:00:00', '2026/7/1 11:30:00'),
    ev('運行終了', '', '帯広市', '2026/7/1 20:00:00', '2026/7/1 20:00:00'),
  ],
}

/** 同じ運行だが**降しイベントが 1 行も無い** (積みっぱなしで終わっている)。
 * `proposeEventRowRange` は `pairs.length === 0` で null を返すので候補が 0 件になる —
 * **伝票はあるのに**提案できない、#822 ②-1 の経路 (Refs `event-data-table.ts` の内側ループ)。 */
const EVENTS_CSV_NO_UNLOAD: CsvJsonResponse = {
  headers: HEADERS,
  rows: [
    ev('運行開始', '帯広市', '', '2026/7/1 5:00:00', '2026/7/1 5:00:00'),
    ev('積み', '釧路市', '', '2026/7/1 8:00:00', '2026/7/1 8:30:00'),
    ev('運行終了', '', '帯広市', '2026/7/1 20:00:00', '2026/7/1 20:00:00'),
  ],
}

const SLIP = {
  saleDate: '2026-07-01',
  vehicleNumber: '1318',
  customerCode: 'C1',
  customerName: '得意先A',
  originAreaName: '釧路市',
  destAreaName: '士幌町',
  origin: '釧路',
  dest: '士幌',
  isSubcontracted: false,
  amount: 100000,
  itemCode: 'I1',
  itemName: '品目A',
  quantity: 1,
  unitPrice: 100000,
  unit: '式',
  rowId: 'R1',
  requestKind: '0',
} satisfies VehicleDailySlip

/** `raw_data` と日付だけを差し替えて運行を作る (他は提案に効かない)。 */
function operation(raw: Record<string, unknown>, dates: { operation_date?: string, reading_date?: string }): Operation {
  return { unko_no: UNKO_NO, raw_data: raw, ...dates } as unknown as Operation
}

const passthroughStub = { template: '<div><slot /></div>' }

const OperationDetailPage = (await import('~/pages/operations/[unko_no].vue')).default

async function mountPage() {
  const w = mount(OperationDetailPage, {
    global: {
      stubs: {
        UButton: { props: ['label'], template: '<button><slot />{{ label }}</button>' },
        UIcon: { template: '<span />' },
        UModal: { template: '<div />' },
        NuxtLink: { template: '<a><slot /></a>' },
        EventDataTable: passthroughStub,
        CsvDataTable: passthroughStub,
        Net780OperationSummary: passthroughStub,
        EventSpeedMapPanel: passthroughStub,
        EventSelectionSummaryPanel: passthroughStub,
        ProfitPanel: passthroughStub,
        OperationRouteMap: { template: '<div />' },
      },
    },
  })
  await flushPromises()
  return w
}

const PROPOSE_LABEL = '一番星の伝票から区間を提案'

function proposeButton(w: VueWrapper) {
  return w.findAll('button').find(b => b.text() === PROPOSE_LABEL || b.text() === '提案中...')
}

/** 提案ボタンの隣に出る一言 (`.text-xs` の span 群) をまとめて拾う。
 * **区画の生死は文言ではなく要素で見る** ため、押す前/押した後の集合を比べる。 */
function noticeTexts(w: VueWrapper): string[] {
  return w.findAll('span.text-xs').map(s => s.text()).filter(t => t !== '')
}

describe('提案ボタン: 検索キーが無い運行で黙らない (Refs #822 ①)', () => {
  beforeEach(() => {
    getOperationCsvMock.mockReset().mockResolvedValue(EVENTS_CSV)
    fetchVehicleDailySlipsMock.mockReset().mockResolvedValue([SLIP])
    getOperationsMock.mockReset().mockResolvedValue({ operations: [], total: 0, page: 1, per_page: 50 })
    // 計上額パネル (R2) と NET780 はこの検証では引けない扱い (404)。
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 404 }))
    localStorage.clear()
  })

  it('車輌CD が無い運行: 押すと表示が変わり、車輌CD が無いことが読める', async () => {
    getOperationMock.mockReset().mockResolvedValue([
      operation({ 乗務員CD1: '1412' }, { operation_date: '2026-07-01', reading_date: '2026-07-01' }),
    ])
    const w = await mountPage()
    const before = noticeTexts(w)

    const btn = proposeButton(w)
    expect(btn).toBeDefined()
    await btn!.trigger('click')
    await flushPromises()

    // **無言で終わらない** — 押す前には無かった一言が増えている。
    const after = noticeTexts(w)
    expect(after).not.toEqual(before)
    expect(w.text()).toContain('この運行は車輌CDが無いため提案できません')
    // 材料が無いのだから**一番星は呼んでいない**。
    expect(fetchVehicleDailySlipsMock).not.toHaveBeenCalled()
    // **「提案に失敗しました」(押し直せば変わりうる) には倒さない。**
    expect(w.text()).not.toContain('提案に失敗しました')
    expect(w.text()).not.toContain('一致する伝票が見つかりませんでした')
  })

  it('日付が無い運行: ① と区別できる文が出る', async () => {
    getOperationMock.mockReset().mockResolvedValue([
      operation({ 車輌CD: '1318' }, {}),
    ])
    const w = await mountPage()
    await proposeButton(w)!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('この運行は運行日が無いため提案できません')
    // **①と同じ文にしない** — 原因が分からないと直しようがない。
    expect(w.text()).not.toContain('車輌CD')
    expect(fetchVehicleDailySlipsMock).not.toHaveBeenCalled()
  })

  it('両方無い運行: どちらも欠けていることが分かる (片方だけの文に丸めない)', async () => {
    getOperationMock.mockReset().mockResolvedValue([operation({}, {})])
    const w = await mountPage()
    await proposeButton(w)!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('この運行は車輌CDと運行日が無いため提案できません')
  })

  it('operation_date が無くても reading_date があれば提案は走る (日付欠けと混同しない)', async () => {
    getOperationMock.mockReset().mockResolvedValue([
      operation({ 車輌CD: '1318' }, { reading_date: '2026-07-01' }),
    ])
    const w = await mountPage()
    await proposeButton(w)!.trigger('click')
    await flushPromises()

    expect(w.text()).not.toContain('提案できません')
    expect(fetchVehicleDailySlipsMock).toHaveBeenCalledTimes(1)
  })

  // ★ 陽性対照: 直した経路が**提案そのものを止めていない**こと。
  it('車輌CD も日付もある運行: 今までどおり loading に入り、提案が走る', async () => {
    getOperationMock.mockReset().mockResolvedValue([
      operation({ 車輌CD: '1318' }, { operation_date: '2026-07-01', reading_date: '2026-07-01' }),
    ])
    // 伝票取得を宙吊りにして「提案中...」を観測する。
    let release: (v: VehicleDailySlip[]) => void = () => {}
    fetchVehicleDailySlipsMock.mockReset().mockImplementation(
      () => new Promise<VehicleDailySlip[]>((resolve) => { release = resolve }),
    )
    const w = await mountPage()

    await proposeButton(w)!.trigger('click')
    await flushPromises()
    // `'loading'` に入っている = ボタンの文字が変わり、押せなくなる。
    expect(proposeButton(w)!.text()).toBe('提案中...')
    expect(proposeButton(w)!.attributes('disabled')).toBeDefined()
    // 検索キーは運行から取った車輌CD、日付は前後に広げた範囲 (提案の中身は不変)。
    expect(fetchVehicleDailySlipsMock).toHaveBeenCalledWith('1318', '2026-06-30', '2026-07-03')

    release([SLIP])
    await flushPromises()

    // 伝票の積地・卸地に対応する区間が見つかって提案が確定する。
    expect(proposeButton(w)!.text()).toBe(PROPOSE_LABEL)
    expect(w.text()).not.toContain('提案できません')
    expect(w.text()).not.toContain('一致する伝票が見つかりませんでした')
    expect(w.text()).not.toContain('提案に失敗しました')
  })
})

/**
 * #822 ②-1: 「伝票が無い」と「伝票はあるが対応する積み降しがイベント行に無い」を
 * **同じ文言に丸めない**。原因が違えば**探しに行く場所が違う** (前者は一番星、
 * 後者はこの運行のイベント表) ので、丸めると読んだ人を間違った場所へ送る。
 */
describe('提案ボタン: 伝票が無いのか、伝票はあるが区間が取れないのか (Refs #822 ②-1)', () => {
  const NOT_FOUND_TEXT = '一致する伝票が見つかりませんでした'
  const UNAVAILABLE_TEXT = 'この運行は車輌CDが無いため提案できません'
  const noMatchText = (n: number) => `伝票${n}件に対応する積み降しが無く提案できません`
  const NO_EVENTS_TEXT = 'この運行にはイベントの記録が無いため提案できません'

  const WITH_KEYS = { operation_date: '2026-07-01', reading_date: '2026-07-01' }

  beforeEach(() => {
    getOperationCsvMock.mockReset().mockResolvedValue(EVENTS_CSV)
    fetchVehicleDailySlipsMock.mockReset().mockResolvedValue([SLIP])
    getOperationMock.mockReset().mockResolvedValue([operation({ 車輌CD: '1318' }, WITH_KEYS)])
    getOperationsMock.mockReset().mockResolvedValue({ operations: [], total: 0, page: 1, per_page: 50 })
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 404 }))
    localStorage.clear()
  })

  async function press() {
    const w = await mountPage()
    await proposeButton(w)!.trigger('click')
    await flushPromises()
    return w
  }

  // ① 退行なし: 伝票が 1 件も無い経路は**今までどおりの文言**。
  it('伝票が 0 件: 従来どおり「一致する伝票が見つかりませんでした」', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([])
    const w = await press()

    expect(w.text()).toContain(NOT_FOUND_TEXT)
    // 伝票が無いのだから件数を出す新しい文には倒さない。
    expect(w.text()).not.toContain('に対応する積み降しが無く')
    expect(w.text()).not.toContain('提案に失敗しました')
  })

  // ② ★ 本題: 伝票はあるのに降しイベントが無い。
  it('伝票はあるが降しイベントが無い: 「伝票が見つかりません」ではない別の文が出る', async () => {
    getOperationCsvMock.mockResolvedValue(EVENTS_CSV_NO_UNLOAD)
    const w = await press()

    // 伝票は**ちゃんと引けている** (呼んで 1 件返っている)。
    expect(fetchVehicleDailySlipsMock).toHaveBeenCalledTimes(1)
    // **件数を数えて画面に言わせる** — 「伝票はある」ことが読める。
    expect(w.text()).toContain(noMatchText(1))
    // ★ **一番星を探しに行かせない。**
    expect(w.text()).not.toContain(NOT_FOUND_TEXT)
    // 押し直しても変わらないので `'error'` の赤にも相乗りさせない。
    expect(w.text()).not.toContain('提案に失敗しました')
    // ① の `'unavailable'` とも混ざらない (材料はそろっている)。
    expect(w.text()).not.toContain(UNAVAILABLE_TEXT)
  })

  it('伝票が複数あって全件区間が取れない: 件数がそのまま出る (1 件に丸めない)', async () => {
    getOperationCsvMock.mockResolvedValue(EVENTS_CSV_NO_UNLOAD)
    fetchVehicleDailySlipsMock.mockResolvedValue([
      SLIP,
      { ...SLIP, originAreaName: '帯広市', destAreaName: '音更町', rowId: 'R2' },
    ])
    const w = await press()

    expect(w.text()).toContain(noMatchText(2))
    expect(w.text()).not.toContain(NOT_FOUND_TEXT)
  })

  // ③ 3 つが互いに混ざらないこと (① の `'unavailable'` はそのまま)。
  it('車輌CD が無い運行: ① の unavailable のままで、②-1 の文は出ない', async () => {
    getOperationMock.mockResolvedValue([operation({ 乗務員CD1: '1412' }, WITH_KEYS)])
    const w = await press()

    expect(w.text()).toContain(UNAVAILABLE_TEXT)
    expect(w.text()).not.toContain('に対応する積み降しが無く')
    expect(w.text()).not.toContain(NOT_FOUND_TEXT)
    // 材料が無いので一番星は呼んですらいない (②-1 とはここが違う)。
    expect(fetchVehicleDailySlipsMock).not.toHaveBeenCalled()
  })

  // ★ 伝票を**見てすらいない**のに「伝票が見つかりません」と言っていた経路。
  it('イベント行が 1 行も無い運行: 伝票の話にしない (一番星を呼んですらいない)', async () => {
    getOperationCsvMock.mockResolvedValue({ headers: [], rows: [] })
    const w = await press()

    expect(w.text()).toContain(NO_EVENTS_TEXT)
    // ★ 伝票は 1 件も見ていないのだから、一番星へ探しに行かせない。
    expect(w.text()).not.toContain(NOT_FOUND_TEXT)
    expect(fetchVehicleDailySlipsMock).not.toHaveBeenCalled()
    // 他の 3 つとも混ざらない。
    expect(w.text()).not.toContain('に対応する積み降しが無く')
    expect(w.text()).not.toContain(UNAVAILABLE_TEXT)
    expect(w.text()).not.toContain('提案に失敗しました')
  })

  it('イベント行が「無い」のではなく「引けなかった」場合: 赤に倒す (押し直す意味がある)', async () => {
    getOperationCsvMock.mockRejectedValue(new Error('boom'))
    const w = await press()

    // 押し直せば変わりうるので `'error'` (赤)。琥珀にすると「押しても無駄」と読ませる。
    expect(w.text()).toContain('提案に失敗しました')
    expect(w.text()).not.toContain(NO_EVENTS_TEXT)
    expect(w.text()).not.toContain(NOT_FOUND_TEXT)
  })

  it('②-1 と ① は別の文である (同じ文字列に寄せていない)', () => {
    expect(noMatchText(1)).not.toBe(UNAVAILABLE_TEXT)
    expect(noMatchText(1)).not.toBe(NOT_FOUND_TEXT)
    expect(NO_EVENTS_TEXT).not.toBe(noMatchText(1))
    expect(NO_EVENTS_TEXT).not.toBe(NOT_FOUND_TEXT)
    expect(NO_EVENTS_TEXT).not.toBe(UNAVAILABLE_TEXT)
    // セルに収まる長さ (既存の一言は 17〜26 字)。
    expect(noMatchText(1).length).toBeLessThanOrEqual(26)
    expect(NO_EVENTS_TEXT.length).toBeLessThanOrEqual(26)
  })

  it('イベント行が無いときの一言も琥珀 (押し直しても変わらない側)', async () => {
    getOperationCsvMock.mockResolvedValue({ headers: [], rows: [] })
    const w = await press()

    const span = w.findAll('span.text-xs').find(s => s.text() === NO_EVENTS_TEXT)
    expect(span).toBeDefined()
    expect(span!.classes().join(' ')).toContain('text-amber-600')
    expect(span!.classes()).not.toContain('text-red-500')
    expect(span!.classes()).not.toContain('text-gray-400')
  })

  it('②-1 の一言は琥珀 (押し直しても変わらない) で、赤とも灰とも別の色', async () => {
    getOperationCsvMock.mockResolvedValue(EVENTS_CSV_NO_UNLOAD)
    const w = await press()

    const span = w.findAll('span.text-xs').find(s => s.text().includes('に対応する積み降しが無く'))
    expect(span).toBeDefined()
    expect(span!.classes().join(' ')).toContain('text-amber-600')
    expect(span!.classes()).not.toContain('text-red-500')
    expect(span!.classes()).not.toContain('text-gray-400')
  })

  // ★ 陽性対照: 伝票があり降しもある運行は**今までどおり提案が走る** (何も止めていない)。
  it('伝票があり降しもある: 提案が走り、どの「できません」も出ない', async () => {
    const w = await press()

    expect(fetchVehicleDailySlipsMock).toHaveBeenCalledWith('1318', '2026-06-30', '2026-07-03')
    expect(w.text()).not.toContain('提案できません')
    expect(w.text()).not.toContain('に対応する積み降しが無く')
    expect(w.text()).not.toContain(NOT_FOUND_TEXT)
    expect(w.text()).not.toContain('提案に失敗しました')
    expect(proposeButton(w)!.text()).toBe(PROPOSE_LABEL)
  })
})

/**
 * **#926: 降しイベントが無い最終便を「次の運行の先頭の降し」で代用する。**
 *
 * ①(粗利タブ・運行手当タブ) は `carryOverDest` で同じ代用を入れているのに、
 * ②(区間提案) には無かったので、**積んだまま帰庫して翌朝降ろす便では
 * 押しても永久に提案が出ない**。
 *
 * ★ ここで固定するのは「提案が出ること」だけではない。**代用したことが画面で
 * 読めること**が本体で、そちらが無いなら代用は入れない方がまし — 代用した卸地が
 * 誤っていた場合、**根拠が実測に見えるせいで人が誤った明細を結んでしまう**。
 *
 * - **文言のラベルで区別する** (色だけにしない — 色は「良し悪し」に読まれる)
 * - **代用の候補は 1 件でも自動適用しない** — 人のクリックを 1 回必ず挟む。
 *   「外れた提案を人がそのまま確定してしまう」害を、範囲を狭めずに直接潰す
 * - **代用できなかった便を数えて出す。0 件でも「0 件」と出す** (空欄は「該当なし」と
 *   「そもそも見ていない」を区別できない)
 * - **暦月では切らない。またいだ事実は注記に出す** — 月をまたぐと確度が落ちる機序は
 *   無く、切ると #926 の代表例 (07-31 開始 → 降しは 08-01) が構造的に外れる
 * - **お金は動かない** — 動くのは提案 (候補出し) だけ
 */
describe('提案ボタン: 降しが無い最終便を次の運行の先頭の降しで代用する (Refs #926)', () => {
  const WITH_KEYS = { operation_date: '2026-07-01', reading_date: '2026-07-01' }
  /** 同じ車輌の**同月**の次の運行 (07-02 04:12 開始)。 */
  const NEXT_SAME_MONTH = '2607020412000000001318'
  /** 同じ車輌の**翌月**の次の運行 (08-01 04:12 開始)。 */
  const NEXT_CROSS_MONTH = '2608010412000000001318'

  /** 次の運行: **先頭 (最初の積みより前) に士幌町の降し**がある = 前の運行の積み残し。 */
  const NEXT_EVENTS_CSV: CsvJsonResponse = {
    headers: HEADERS,
    rows: [
      ev('運行開始', '帯広市', '', '2026/7/2 5:00:00', '2026/7/2 5:00:00'),
      ev('降し', '', '士幌町', '2026/7/2 6:00:00', '2026/7/2 6:30:00'),
      ev('積み', '釧路市', '', '2026/7/2 9:00:00', '2026/7/2 9:30:00'),
      ev('降し', '', '上士幌町', '2026/7/2 12:00:00', '2026/7/2 12:30:00'),
    ],
  }
  /** 次の運行だが**先頭に降しが無い** (いきなり積みから始まる)。 */
  const NEXT_EVENTS_NO_HEAD_UNLOAD: CsvJsonResponse = {
    headers: HEADERS,
    rows: [
      ev('運行開始', '帯広市', '', '2026/7/2 5:00:00', '2026/7/2 5:00:00'),
      ev('積み', '釧路市', '', '2026/7/2 9:00:00', '2026/7/2 9:30:00'),
    ],
  }
  /** 次の運行の先頭の降しが**別の町** (伝票の卸地 士幌町 と一致しない)。 */
  const NEXT_EVENTS_OTHER_CITY: CsvJsonResponse = {
    headers: HEADERS,
    rows: [
      ev('運行開始', '帯広市', '', '2026/7/2 5:00:00', '2026/7/2 5:00:00'),
      ev('降し', '', '標茶町', '2026/7/2 6:00:00', '2026/7/2 6:30:00'),
      ev('積み', '釧路市', '', '2026/7/2 9:00:00', '2026/7/2 9:30:00'),
    ],
  }

  const CARRIED_BADGE = '降し無し・代用 (推定)'

  /** この運行 = 降し無し / 次の運行 = 引数の CSV。 */
  function withNextOperation(nextUnkoNo: string, nextCsv: CsvJsonResponse) {
    getOperationsMock.mockResolvedValue({ operations: [{ unko_no: nextUnkoNo }], total: 1, page: 1, per_page: 50 })
    getOperationCsvMock.mockImplementation(async (no: string) =>
      (no === UNKO_NO ? EVENTS_CSV_NO_UNLOAD : nextCsv))
  }

  beforeEach(() => {
    getOperationCsvMock.mockReset().mockResolvedValue(EVENTS_CSV_NO_UNLOAD)
    fetchVehicleDailySlipsMock.mockReset().mockResolvedValue([SLIP])
    getOperationMock.mockReset().mockResolvedValue([operation({ 車輌CD: '1318', 対象乗務員CD: '1412' }, WITH_KEYS)])
    getOperationsMock.mockReset().mockResolvedValue({ operations: [], total: 0, page: 1, per_page: 50 })
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 404 }))
    localStorage.clear()
  })

  async function press() {
    const w = await mountPage()
    await proposeButton(w)!.trigger('click')
    await flushPromises()
    return w
  }

  /** 代用の候補チップ (`'carried-choice'` の中の button)。 */
  function carriedChip(w: VueWrapper) {
    return w.findAll('button').find(b => b.text().includes('代用元'))
  }

  it('次の運行の先頭に卸地の降しがあれば候補が出る (今までは永久に出なかった)', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_CSV)
    const w = await press()

    // #822 ②-1 の「提案できません」に落ちない = 代用が当たっている。
    expect(w.text()).not.toContain('に対応する積み降しが無く提案できません')
    expect(w.text()).toContain(CARRIED_BADGE)
    expect(carriedChip(w)).toBeDefined()
  })

  // ★ C: 代用は 1 件でも自動適用しない。
  it('★ 代用の候補は 1 件でも自動では反映しない — 押して初めて反映される', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_CSV)
    const w = await press()

    // 押す前: 「自動では反映しません」と言い、適用後の注記はまだ出ていない。
    expect(w.text()).toContain('自動では反映しません')
    expect(w.text()).not.toContain('この提案は代用です')
    // 「複数の配送先候補」とは言わない (1 件しか無いので嘘になる)。
    expect(w.text()).not.toContain('複数の配送先候補が見つかりました')

    await carriedChip(w)!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('この提案は代用です')
    expect(w.text()).not.toContain('自動では反映しません')
  })

  it('★ 押す前の候補チップにも代用元が読める (押す判断の材料を先に出す)', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_CSV)
    const w = await press()

    const chip = carriedChip(w)!
    expect(chip.text()).toContain('釧路市 → 士幌町')
    expect(chip.text()).toContain(NEXT_SAME_MONTH)
    expect(chip.text()).toContain('07-02 04:12 開始')
  })

  it('★ 代用したことが**文言で**読める — 代用元の運行NO と町名まで出す', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_CSV)
    const w = await press()
    await carriedChip(w)!.trigger('click')
    await flushPromises()

    const text = w.text()
    expect(text).toContain('この提案は代用です')
    expect(text).toContain('実測ではありません')
    expect(text).toContain(NEXT_SAME_MONTH)
    expect(text).toContain('士幌町')
    // 区間の終わりが卸地ではなく帰庫であることも言う (別の意味に読ませない)。
    expect(text).toContain('提案した区間の終わりはこの運行の帰庫まで')
  })

  it('★ 色だけで区別していない — バッジを白黒にしても「代用」と読める', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_CSV)
    const w = await press()

    const badge = w.findAll('span').find(sp => sp.text() === CARRIED_BADGE)
    expect(badge).toBeDefined()
    // 文言そのものが「代用」「推定」と言っている (class を剥がしても意味が残る)。
    expect(CARRIED_BADGE).toContain('代用')
    expect(CARRIED_BADGE).toContain('推定')
  })

  it('★ 代用できた件数と、できなかった件数を出す (0 件でも「0件」と出す)', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_CSV)
    const w = await press()

    expect(w.text()).toContain('伝票1件のうち1件を「次の運行の先頭の降し」で代用しました')
    expect(w.text()).toContain('代用もできなかった便 0件')
  })

  // ★ A: 暦月では切らない。#926 の代表例 (07-31 開始 → 降しは 08-01) がこの形。
  it('★ 暦月をまたぐ次の運行でも代用する — ただし「翌月」であることを注記に出す', async () => {
    withNextOperation(NEXT_CROSS_MONTH, NEXT_EVENTS_CSV)
    const w = await press()

    expect(w.text()).toContain(CARRIED_BADGE)
    expect(w.text()).not.toContain('に対応する積み降しが無く提案できません')

    await carriedChip(w)!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('代用元は翌月の運行です')
    expect(w.text()).toContain('08-01 04:12 開始')
  })

  it('同月の代用では「翌月」と言わない (またいでいない事実も正しく出す)', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_CSV)
    const w = await press()
    await carriedChip(w)!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('この提案は代用です')
    expect(w.text()).not.toContain('代用元は翌月の運行です')
  })

  it('次の運行の先頭に降しが無い: その理由を名指しする', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_NO_HEAD_UNLOAD)
    const w = await press()

    expect(w.text()).toContain(`次の運行 ${NEXT_SAME_MONTH} の先頭にも降しがありません 1件`)
    expect(w.text()).not.toContain('この提案は代用です')
  })

  it('次の運行の先頭の降しが伝票の卸地と違う: **代用元の町名**が読める', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_OTHER_CITY)
    const w = await press()

    // 代用元の町名 (標茶町) を出す。伝票の卸地 (士幌町) は伝票側で分かる。
    expect(w.text()).toContain('次の運行の先頭の降し (標茶町) が伝票の卸地と一致しません 1件')
    expect(w.text()).not.toContain('この提案は代用です')
  })

  it('同じ乗務員・車輌の次の運行が窓の中に無い: その理由を出す', async () => {
    const w = await press()

    expect(w.text()).toContain('同じ乗務員・車輌の次の運行が運行日から3日以内に見つかりません 1件')
    expect(w.text()).toContain('代用もできなかった便 1件')
  })

  it('次の運行の一覧が引けなくても全体を「提案に失敗しました」に倒さない', async () => {
    getOperationsMock.mockRejectedValue(new Error('boom'))
    const w = await press()

    expect(w.text()).toContain('次の運行の一覧を引けませんでした')
    expect(w.text()).not.toContain('提案に失敗しました')
  })

  it('次の運行は見つかるがイベントを引けない: そこだけを言う', async () => {
    getOperationsMock.mockResolvedValue({ operations: [{ unko_no: NEXT_SAME_MONTH }], total: 1, page: 1, per_page: 50 })
    getOperationCsvMock.mockImplementation(async (no: string) => {
      if (no === UNKO_NO) return EVENTS_CSV_NO_UNLOAD
      throw new Error('boom')
    })
    const w = await press()

    expect(w.text()).toContain(`次の運行 ${NEXT_SAME_MONTH} のイベントを引けませんでした`)
    expect(w.text()).not.toContain('提案に失敗しました')
  })

  it('次の運行は 同じ乗務員 + 同じ車輌 で、運行日から 3 日ぶんだけ引く', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_CSV)
    await press()

    expect(getOperationsMock).toHaveBeenCalledWith({
      vehicle_cd: '1318',
      driver_cd: '1412',
      date_from: '2026-07-01',
      date_to: '2026-07-04',
    })
  })

  // ★ 陽性対照 1: 降しがある普通の運行では**代用を試さない** = 余計な通信をしない。
  it('降しがある運行では次の運行を引かない (押した瞬間の待ち時間が増えない)', async () => {
    getOperationCsvMock.mockResolvedValue(EVENTS_CSV)
    const w = await press()

    expect(getOperationsMock).not.toHaveBeenCalled()
    expect(w.text()).not.toContain(CARRIED_BADGE)
    expect(w.text()).not.toContain('代用もできなかった便')
  })

  // ★ 陽性対照 2: **押していないうちは何も出さない。**「代用 0 件」と「そもそも
  //    見ていない」を同じ見た目にしない (0 件を出すのは代用を試したときだけ)。
  it('押す前は代用の区画そのものが無い', async () => {
    withNextOperation(NEXT_SAME_MONTH, NEXT_EVENTS_CSV)
    const w = await mountPage()

    expect(w.text()).not.toContain(CARRIED_BADGE)
    expect(w.text()).not.toContain('代用もできなかった便')
  })
})
