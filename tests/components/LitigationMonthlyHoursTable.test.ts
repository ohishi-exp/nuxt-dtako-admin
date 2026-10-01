import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import LitigationMonthlyHoursTable from '../../app/components/LitigationMonthlyHoursTable.vue'
import type { LitigationHoursBook } from '../../app/utils/litigation-output'

// 出力タブの画面と印刷の紙面が共用する「月ごとの時間 (wage report)」。値はどれも架空。
const table: LitigationHoursBook = {
  driverCd: '9001',
  label: '2030-01〜2030-12',
  rows: [
    { month: '2030-01', cells: ['150:00', '0:30', '65:30', '5:30', '6:00', '8:30', '12:30', '230:00'], note: null },
    { month: '2030-02', cells: [], note: '未取得' },
    { month: '2030-03', cells: ['100:00', '—', '10:00', '0:00', '0:00', '0:00', '0:30', '110:00'], note: null },
  ],
  total: { month: '合計 (2 か月ぶん)', cells: ['250:00', '0:30 (一部の月は不明)', '75:30', '5:30', '6:00', '8:30', '13:00', '340:00'], note: null },
  valueMonths: 2,
  needsFetch: true,
  checkedAtText: '2030-04-01 09:30',
}
// 取り直しても同じ月 (記録なし・欠測) だけの冊
const settled: LitigationHoursBook = {
  driverCd: '9002',
  label: '2030-01〜2030-02',
  rows: [{ month: '2030-01', cells: [], note: '拘束の記録なし' }, { month: '2030-02', cells: [], note: '欠測' }],
  total: null,
  valueMonths: 0,
  needsFetch: false,
  checkedAtText: null,
}
const driverLabel = (cd: string) => (cd === '9001' ? '架空 太郎' : cd)
const mountTable = (books: LitigationHoursBook[], props: { compact?: boolean, notice?: string } = {}) =>
  mount(LitigationMonthlyHoursTable, { props: { books, driverLabel, ...props } })

describe('LitigationMonthlyHoursTable', () => {
  it('★ 冊ごとに見出し (乗務員・期間)・最終取得と、月の行 + 合計行を出す。値の無い月は状態を 1 セルで出す', () => {
    const w = mountTable([table])
    expect(w.find('h2').text()).toBe('月ごとの時間 (wage report)')
    const book = w.find('[data-hours-book="9001|2030-01〜2030-12"]')
    expect(book.find('[data-hours="heading"]').text()).toBe('架空 太郎 (9001) 2030-01〜2030-12')
    expect(book.find('[data-hours="checked-at"]').text()).toBe('最終取得 2030-04-01 09:30')
    expect(book.findAll('th').map(th => th.text())).toEqual([
      '対象月', '法定時間内', 'うち法内残業', '法外残業', 'うち月60h超', '法定外休日', '法定休日', '深夜 (内数)', '総労働時間',
    ])
    const months = book.findAll('[data-hours="month"]').map(tr => tr.findAll('td').map(td => td.text()))
    expect(months).toEqual([
      ['2030-01', '150:00', '0:30', '65:30', '5:30', '6:00', '8:30', '12:30', '230:00'],
      ['2030-02', '未取得'],
      ['2030-03', '100:00', '—', '10:00', '0:00', '0:00', '0:00', '0:30', '110:00'],
    ])
    expect(book.find('[data-hours="month-note"]').attributes('colspan')).toBe('8')
    expect(book.find('[data-hours="total"]').findAll('td').map(td => td.text())).toEqual([
      '合計 (2 か月ぶん)', '250:00', '0:30 (一部の月は不明)', '75:30', '5:30', '6:00', '8:30', '13:00', '340:00',
    ])
  })

  it('★ 説明文は「給与比較と同じ wage report・暦月・保存した版とは連動しない・Excel の式の結果とは一致しないことが在る」と言う', () => {
    const text = mountTable([table]).find('[data-hours="description"]').text().replace(/\s+/g, ' ')
    expect(text).toBe(
      '給与比較と同じ wage report の値です (暦月、時間:分)。保存した版の表示とは連動しません。'
      + ' Excel の中の式の結果とは一致しないことが在ります (Excel は入力の作り方が別で、統一は作業中です)。',
    )
  })

  it('★ 「拘束の材料を取ると出ます」は、未取得か取得に失敗の月が在る冊が 1 つでも在るときだけ出す (記録なし・欠測だけなら出さない)', () => {
    expect(mountTable([settled, table]).find('[data-hours="needs-fetch"]').text()).toBe('エラータブ (または給与比較) で拘束の材料を取ると出ます')
    const w = mountTable([settled])
    expect(w.find('[data-hours="needs-fetch"]').exists()).toBe(false)
    expect(w.text()).not.toContain('取ると出ます')
    // 値の在る月が無い冊は合計行も最終取得も出さない (月の状態の行は出す)
    const book = w.find('[data-hours-book="9002|2030-01〜2030-02"]')
    expect(book.find('[data-hours="heading"]').text()).toBe('9002 (9002) 2030-01〜2030-02')
    expect(book.findAll('[data-hours="month-note"]').map(td => td.text())).toEqual(['拘束の記録なし', '欠測'])
    expect(book.find('[data-hours="total"]').exists()).toBe(false)
    expect(book.find('[data-hours="checked-at"]').exists()).toBe(false)
  })

  it('★ 表を出せない状態 (notice) のときは、冊の表を出さずにその状態を言う (全月を「未取得」に見せない)', () => {
    const w = mountTable([table], { notice: '保存済みの結果を読み込み中…' })
    expect(w.find('[data-hours="notice"]').text()).toBe('保存済みの結果を読み込み中…')
    expect(w.find('table').exists()).toBe(false)
    expect(w.text()).not.toContain('未取得')
    expect(w.find('[data-hours="needs-fetch"]').exists()).toBe(false)
    // 陽性対照: notice が無ければ表が出る
    expect(mountTable([table]).find('[data-hours="notice"]').exists()).toBe(false)
    expect(mountTable([table]).findAll('table')).toHaveLength(1)
  })

  it('紙面 (compact) は同じ中身を紙面用の表で出す (画面用の text-sm / text-xs を付けない)', () => {
    const screen = mountTable([table, settled])
    const print = mountTable([table, settled], { compact: true })
    expect(screen.attributes('data-testid')).toBe('litigation-hours')
    expect(print.attributes('data-testid')).toBe('litigation-print-hours')
    expect(print.text().replace(/\s+/g, ' ')).toBe(screen.text().replace(/\s+/g, ' '))
    expect(print.find('table').classes()).toEqual(['litigation-print-table', 'litigation-hours-table'])
    expect(print.html()).not.toMatch(/text-(sm|xs)/)
    expect(screen.html()).toMatch(/text-sm/)
    // 1 冊を 1 枚に収めるための枠 (break-inside: avoid) は冊ごと
    expect(print.findAll('.litigation-hours-book')).toHaveLength(2)
    // notice も紙面用の見た目で出る
    expect(mountTable([table], { compact: true, notice: '読み込み中' }).find('[data-hours="notice"]').classes()).toEqual(['litigation-print-meta'])
  })
})
