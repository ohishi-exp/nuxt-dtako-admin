import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SalaryAmountCell from '../../app/components/SalaryAmountCell.vue'
import SalaryOver37Cell from '../../app/components/SalaryOver37Cell.vue'

// 画面と印刷の紙面が共用する縦積みセル。紙面 (compact) は同じ行を詰めた余白で出す。
const amount = (over = {}) => ({ key: 'overtime' as const, csv: 30000, sys: 15000, diff: 15000, basis: '1,500 円/h × 10h00m', ...over })
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
