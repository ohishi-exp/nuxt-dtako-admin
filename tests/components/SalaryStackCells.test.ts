import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SalaryAmountCell from '../../app/components/SalaryAmountCell.vue'
import SalaryOver37Cell from '../../app/components/SalaryOver37Cell.vue'
import SalaryHoursCell from '../../app/components/SalaryHoursCell.vue'

// 画面と印刷の紙面が共用する縦積みセル。紙面 (compact) は同じ行を詰めた余白で出す。
const amount = (over = {}) => ({ key: 'overtime' as const, csv: 30000, sys: 15000, diff: 15000, basis: '1,500 円/h × 10h00m', breakdown: null, minWage: null, ...over })
const lines = (w: ReturnType<typeof mount>) => w.findAll('[data-salary-line]').map(l => l.attributes('data-salary-line'))

describe('SalaryAmountCell', () => {
  it('明細 / 計算 / 根拠 / 差 の順に積む。根拠が無ければ 3 段', () => {
    expect(lines(mount(SalaryAmountCell, { props: { cell: amount() } }))).toEqual(['csv', 'sys', 'basis', 'diff'])
    expect(lines(mount(SalaryAmountCell, { props: { cell: amount({ key: 'total', basis: null }) } }))).toEqual(['csv', 'sys', 'diff'])
  })

  it('差の符号で色が変わる (正は青・負は赤・0 と計算できない月は色なし)', () => {
    const cls = (diff: number | null) => mount(SalaryAmountCell, { props: { cell: amount({ diff }) } }).find('[data-salary-line="diff"]').classes()
    expect(cls(1)).toContain('text-blue-600')
    expect(cls(-1)).toContain('text-red-600')
    expect(cls(0)).not.toContain('text-blue-600')
    expect(mount(SalaryAmountCell, { props: { cell: amount({ diff: null, sys: null }) } }).find('[data-salary-line="diff"]').text()).toBe('差-')
  })

  it('固定残業の注記は残業のセルだけに付く', () => {
    const note = (key: 'base' | 'overtime', overtimeFixed: boolean) =>
      mount(SalaryAmountCell, { props: { cell: amount({ key }), overtimeFixed } }).text().includes('固定残業')
    expect(note('overtime', true)).toBe(true)
    expect(note('overtime', false)).toBe(false)
    expect(note('base', true)).toBe(false)
  })

  it('compact は文字を小さくする class (text-xs) を付けない (紙面は親の 7.5px を使う)', () => {
    expect(mount(SalaryAmountCell, { props: { cell: amount() } }).html()).toContain('text-xs')
    expect(mount(SalaryAmountCell, { props: { cell: amount(), compact: true } }).html()).not.toContain('text-xs')
  })
})

describe('SalaryOver37Cell', () => {
  const over37 = {
    rate: 1333.3, minutes: 600, theory: 16667, paid: 30000, diff: -1, shortfall: true,
    rateBasis: '割増基礎 200,000 円 ÷ (明細 20 日 × 7h30m)', rateNotes: [] as string[], belowMinWage: false, minWageRate: 1000 as number | null,
  }

  it('基礎単価の次に根拠を積み、5 段。差が負のときだけ太字', () => {
    const w = mount(SalaryOver37Cell, { props: { over37, noneReason: '' } })
    expect(lines(w)).toEqual(['rate', 'rate-basis', 'minutes', 'theory', 'paid', 'diff37'])
    expect(w.find('[data-salary-line="rate-basis"]').text()).toBe('= 割増基礎 200,000 円 ÷ (明細 20 日 × 7h30m)')
    expect(w.find('[data-salary-line="diff37"]').classes()).toContain('font-bold')
    const ok = mount(SalaryOver37Cell, { props: { over37: { ...over37, diff: 5, shortfall: false }, noneReason: '', compact: true } })
    expect(ok.find('[data-salary-line="diff37"]').classes()).not.toContain('font-bold')
  })

  it('根拠の注記 (日数をデジタコ稼働に倒した / 所定を引けなかった) は、あるぶんだけ根拠の下に 1 行ずつ出る', () => {
    const notes = ['明細に出勤日数が無いためデジタコの稼働日数で計算', '所定未設定のため法定 8 時間で計算']
    const w = mount(SalaryOver37Cell, { props: { over37: { ...over37, rateNotes: notes }, noneReason: '' } })
    expect(lines(w)).toEqual(['rate', 'rate-basis', 'rate-note', 'rate-note', 'minutes', 'theory', 'paid', 'diff37'])
    expect(w.findAll('[data-salary-line="rate-note"]').map(n => n.text())).toEqual(notes)
  })

  it('★ 37条の基礎単価が最低賃金を下回る月: 基礎単価が赤太字で、最低賃金の額つきのエラー行が出る (画面も紙面も)', () => {
    for (const compact of [false, true]) {
      const w = mount(SalaryOver37Cell, { props: { over37: { ...over37, rate: 900, belowMinWage: true }, noneReason: '', compact } })
      expect(lines(w)).toEqual(['rate', 'below-minwage', 'rate-basis', 'minutes', 'theory', 'paid', 'diff37'])
      expect(w.find('[data-salary-line="rate"]').classes()).toEqual(expect.arrayContaining(['font-bold', 'text-red-600']))
      expect(w.find('[data-salary-line="below-minwage"]').text()).toBe('37条の基礎単価が最低賃金 1,000 円/h を下回る')
    }
    const ok = mount(SalaryOver37Cell, { props: { over37, noneReason: '' } })
    expect(ok.find('[data-salary-line="rate"]').classes()).not.toContain('font-bold')
    expect(ok.find('[data-salary-line="below-minwage"]').exists()).toBe(false)
  })

  it('出せないときは理由 1 行', () => {
    const w = mount(SalaryOver37Cell, { props: { over37: null, noneReason: '(給与区分が不明)' } })
    expect(lines(w)).toEqual(['none'])
    expect(w.text()).toBe('- (給与区分が不明)')
    expect(mount(SalaryOver37Cell, { props: { over37: null, noneReason: 'x', compact: true } }).html()).not.toContain('text-xs')
  })
})

describe('SalaryAmountCell: 基本給の内訳と最低賃金ベースの比較の行', () => {
  const withExtra = (over = {}) => ({
    key: 'base' as const, csv: 200000, sys: 190000, diff: 10000, basis: '9,500 円 × 20 日',
    breakdown: 'うち基本給 190,000 / 手当 10,000', minWage: { text: '最低賃金 1,000 円/h × 法定時間内 150h00m = 150,000', diff: 50000, shortfall: false }, ...over,
  })

  it('明細の下に内訳、根拠の下に最低賃金ベースの行、最後に差 (画面も紙面も同じ順)', () => {
    for (const compact of [false, true]) {
      const w = mount(SalaryAmountCell, { props: { cell: withExtra(), compact } })
      expect(lines(w)).toEqual(['csv', 'breakdown', 'sys', 'basis', 'minwage', 'diff'])
      expect(w.find('[data-salary-line="breakdown"]').text()).toBe('うち基本給 190,000 / 手当 10,000')
      expect(w.find('[data-salary-line="minwage"]').text()).toBe('最低賃金 1,000 円/h × 法定時間内 150h00m = 150,000 (明細との差 +50,000)')
    }
  })

  it('★ 明細が下回る (shortfall) 月だけ赤太字。比べられない月は差を付けず理由だけ', () => {
    const red = mount(SalaryAmountCell, { props: { cell: withExtra({ minWage: { text: 'x', diff: -1, shortfall: true } }) } }).find('[data-salary-line="minwage"]')
    expect(red.classes()).toEqual(expect.arrayContaining(['font-bold', 'text-red-600']))
    expect(red.text()).toBe('x (明細との差 -1)')
    const none = mount(SalaryAmountCell, { props: { cell: withExtra({ minWage: { text: '比較なし', diff: null, shortfall: false } }), compact: true } }).find('[data-salary-line="minwage"]')
    expect(none.text()).toBe('比較なし')
    expect(none.classes()).not.toContain('text-red-600')
  })

  it('内訳も最低賃金の行も無ければ (総支給) 従来どおり 3 段', () => {
    expect(lines(mount(SalaryAmountCell, { props: { cell: withExtra({ key: 'total', basis: null, breakdown: null, minWage: null }) } }))).toEqual(['csv', 'sys', 'diff'])
  })
})

describe('SalaryHoursCell (計算で使った労働時間)', () => {
  const hours = (over = {}) => ({
    digitaco: [
      { key: 'work-days', label: '稼働日数', value: '20 日' }, { key: 'working', label: '実働', value: '160h00m' },
      { key: 'statutory', label: '法定時間内', value: '150h00m' },
    ],
    csv: [{ key: 'csv-work', label: '出勤日数', value: '19 日' }], csvNoDays: false,
    denominator: '所定 150.0h (= 明細 20 日 × 7h30m)', ...over,
  })

  it('デジタコ → 明細 → 37条の分母の順に、行ごとに data-salary-line を付けて積む (画面も紙面も同じ)', () => {
    for (const compact of [false, true]) {
      const w = mount(SalaryHoursCell, { props: { hours: hours(), compact } })
      expect(lines(w)).toEqual(['hours-digitaco-head', 'hours-work-days', 'hours-working', 'hours-statutory', 'hours-csv-head', 'hours-csv-work', 'hours-denominator'])
      expect(w.find('[data-salary-line="hours-working"]').text()).toBe('実働160h00m')
      expect(w.find('[data-salary-line="hours-denominator"]').text()).toBe('37条の分母: 所定 150.0h (= 明細 20 日 × 7h30m)')
    }
  })

  it('明細に日数が無ければ「明細に日数なし」、分母が出せなければ分母の行は無い', () => {
    const w = mount(SalaryHoursCell, { props: { hours: hours({ csv: [], csvNoDays: true, denominator: null }) } })
    expect(lines(w)).toEqual(['hours-digitaco-head', 'hours-work-days', 'hours-working', 'hours-statutory', 'hours-csv-head', 'hours-csv-no-days'])
    expect(w.find('[data-salary-line="hours-csv-no-days"]').text()).toBe('明細に日数なし')
  })

  it('紙面 (compact) は行を横に流して高さを詰める (flex-wrap)。画面は縦積みで text-xs', () => {
    const c = mount(SalaryHoursCell, { props: { hours: hours(), compact: true } }).html()
    expect(c).toContain('flex-wrap')
    expect(c).not.toContain('text-xs')
    const v = mount(SalaryHoursCell, { props: { hours: hours() } }).html()
    expect(v).not.toContain('flex-wrap')
    expect(v).toContain('text-xs')
  })
})
