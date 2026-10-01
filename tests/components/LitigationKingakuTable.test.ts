import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import LitigationKingakuTable from '../../app/components/LitigationKingakuTable.vue'
import type { LitigationKingakuBook } from '../../app/utils/litigation-output'

// 出力タブの画面と印刷の紙面が共用する「Y金額 (時間の行)」。値はどれも架空。
const table: LitigationKingakuBook = {
  driverCd: '9001',
  label: '2030-01〜2030-12',
  rows: [
    { period: '2029-12-21〜2030-01-20', cells: ['1:05', '62:05', '不適用', '8:00', '1:30', '205:45'], partial: true },
    { period: '2030-01-21〜2030-02-20', cells: ['0:00', '10:00', '不適用', '0:00', '0:30', '180:00'], partial: false },
  ],
  total: { period: '合計', cells: ['1:05', '72:05', '不適用', '8:00', '2:00', '385:45'], partial: false },
  note: null,
}
const noSummary: LitigationKingakuBook = {
  driverCd: '9002', label: '2030-01〜2030-12', rows: [], total: null, note: '集計なし: 要素!F5 (法定休日の曜日) が 日〜土 の 1 文字でない',
}
const driverLabel = (cd: string) => (cd === '9001' ? '架空 太郎' : cd)
const mountTable = (books: LitigationKingakuBook[], compact = false) =>
  mount(LitigationKingakuTable, { props: { books, driverLabel, compact } })

describe('LitigationKingakuTable', () => {
  it('★ 冊ごとに見出し (乗務員・期間) と、月度の行 + 合計行を出す', () => {
    const w = mountTable([table])
    const book = w.find('[data-kingaku-book="9001|2030-01〜2030-12"]')
    expect(book.find('[data-kingaku="heading"]').text()).toBe('架空 太郎 (9001) 2030-01〜2030-12')
    expect(book.findAll('th').map(th => th.text())).toEqual([
      '対象期間', '法内残業', '法外残業', '月60h超', '休日労働', '深夜労働', '総労働時間',
    ])
    const months = book.findAll('[data-kingaku="month"]').map(tr => tr.findAll('td').map(td => td.text()))
    expect(months).toEqual([
      ['2029-12-21〜2030-01-20 ※', '1:05', '62:05', '不適用', '8:00', '1:30', '205:45'],
      ['2030-01-21〜2030-02-20', '0:00', '10:00', '不適用', '0:00', '0:30', '180:00'],
    ])
    expect(book.find('[data-kingaku="total"]').findAll('td').map(td => td.text())).toEqual([
      '合計', '1:05', '72:05', '不適用', '8:00', '2:00', '385:45',
    ])
  })

  it('★ 説明文は「Excel の Y金額 シートの時間の行と同じ計算・金額の行は出さない」と言う', () => {
    const text = mountTable([table]).find('[data-kingaku="description"]').text().replace(/\s+/g, ' ')
    expect(text).toBe(
      'Excel の Y金額 シートの時間の行と同じ計算です (賃金月度ごとの合計、時間:分)。金額の行は出しません (賃金単価・既払額は Excel で手入力)。'
      + ' 1 冊は独立した Excel なので、週の累計は冊の初日から数え直します。',
    )
  })

  it('冊の期間からはみ出す月度があるときだけ、※ の注記を出す', () => {
    expect(mountTable([table]).find('[data-kingaku="partial-note"]').text())
      .toBe('※ 冊の期間からはみ出す月度です。はみ出した日はこの冊の Excel に無いので、合計に入っていません。')
    const whole = { ...table, rows: table.rows.map(r => ({ ...r, partial: false })) }
    const w = mountTable([whole])
    expect(w.find('[data-kingaku="partial-note"]').exists()).toBe(false)
    expect(w.text()).not.toContain('※')
  })

  it('★ 集計できなかった冊は表の代わりに理由を出す (乗務員名が引けなければ CD のまま)', () => {
    const w = mountTable([table, noSummary])
    const book = w.find('[data-kingaku-book="9002|2030-01〜2030-12"]')
    expect(book.find('[data-kingaku="heading"]').text()).toBe('9002 (9002) 2030-01〜2030-12')
    expect(book.find('[data-kingaku="note"]').text()).toBe('集計なし: 要素!F5 (法定休日の曜日) が 日〜土 の 1 文字でない')
    expect(book.find('table').exists()).toBe(false)
    expect(w.findAll('table')).toHaveLength(1)
  })

  it('紙面 (compact) は同じ中身を紙面用の表で出す (画面用の text-sm / text-xs を付けない)', () => {
    const screen = mountTable([table, noSummary])
    const print = mountTable([table, noSummary], true)
    expect(screen.attributes('data-testid')).toBe('litigation-kingaku')
    expect(print.attributes('data-testid')).toBe('litigation-print-kingaku')
    expect(print.text().replace(/\s+/g, ' ')).toBe(screen.text().replace(/\s+/g, ' '))
    expect(print.find('table').classes()).toEqual(['litigation-print-table', 'litigation-kingaku-table'])
    expect(print.html()).not.toMatch(/text-(sm|xs)/)
    expect(screen.html()).toMatch(/text-sm/)
    // 1 冊を 1 枚に収めるための枠 (break-inside: avoid) は冊ごと
    expect(print.findAll('.litigation-kingaku-book')).toHaveLength(2)
  })
})
