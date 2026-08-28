import { describe, it, expect } from 'vitest'

import {
  defaultRange,
  emptyRowsNote,
  filterNegativeDiffRows,
  monthBadgeLabel,
  monthCellState,
  monthDiff,
  monthKosokuMark,
  monthsNeedingRefresh,
  parseWageRange,
  rangeCoverageNote,
  rangeKosokuNote,
  rangeDiff,
  sumWageRangeRows,
  wageRangeCsv,
  type WageRangeMonth,
  type WageRangeRow,
} from '~/utils/wage-range-view'

function amounts(over: Record<string, number | null> = {}) {
  return {
    calc_base: 200_000,
    calc_overtime: 80_000,
    calc_total: 280_000,
    paid_base: 198_000,
    paid_overtime: 78_000,
    hourly_rate: 1420,
    working_minutes: 11_820,
    ...over,
  }
}

const BODY = {
  from: '2026-01',
  to: '2026-03',
  restraint_source: 'gcp',
  months: [
    { ym: '2026-01', saved: true, drivers: 2, computed_at: '2026-08-05T01:20:00Z', stale: false },
    { ym: '2026-02', saved: true, drivers: 0, computed_at: '2026-08-05T01:21:00Z', stale: true, stale_reason: ['salary_item'], excluded: 'payroll_missing' },
    { ym: '2026-03', saved: false },
  ],
  rows: [
    {
      driver_cd: 1035,
      driver_name: '山田 太郎',
      company: '0200',
      branch_name: '本社',
      branch_code: 210,
      job_name: '乗務員',
      months_counted: 1,
      months_missing: [],
      by_month: { '2026-01': amounts() },
      calc_base: 200_000,
      calc_overtime: 80_000,
      calc_total: 280_000,
      paid_base: 198_000,
      paid_overtime: 78_000,
      working_minutes: 11_820,
    },
  ],
}

function row(over: Partial<WageRangeRow> = {}): WageRangeRow {
  return {
    driverCd: '1035',
    driverName: '山田',
    attrs: { company: '0200', branchCode: 210, branchName: '本社', jobName: '乗務員' },
    monthsCounted: 1,
    monthsMissing: [],
    byMonth: {
      '2026-01': {
        calcBase: 200_000, calcOvertime: 80_000, calcTotal: 280_000,
        paidBase: 198_000, paidOvertime: 78_000, hourlyRate: 1420, workingMinutes: 11_820,
      },
    },
    calcBase: 200_000,
    calcOvertime: 80_000,
    calcTotal: 280_000,
    paidBase: 198_000,
    paidOvertime: 78_000,
    workingMinutes: 11_820,
    ...over,
  }
}

function month(over: Partial<WageRangeMonth> = {}): WageRangeMonth {
  return {
    ym: '2026-01',
    saved: true,
    drivers: 1,
    computedAt: '2026-08-05T01:20:00Z',
    stale: false,
    staleReason: [],
    excluded: null,
    timecardKosoku: null,
    ...over,
  }
}

describe('parseWageRange', () => {
  it('応答を画面の形に写す', () => {
    const parsed = parseWageRange(BODY)
    expect(parsed.from).toBe('2026-01')
    expect(parsed.restraintSource).toBe('gcp')
    expect(parsed.months).toHaveLength(3)
    expect(parsed.months[1]!.excluded).toBe('payroll_missing')
    expect(parsed.months[1]!.staleReason).toEqual(['salary_item'])
    expect(parsed.months[2]!.saved).toBe(false)
    expect(parsed.rows[0]!.driverCd).toBe('1035')
    expect(parsed.rows[0]!.attrs.branchCode).toBe(210)
    expect(parsed.rows[0]!.byMonth['2026-01']!.calcTotal).toBe(280_000)
    // 月セルの内訳モーダルが出す実働 (月ごと)。古い応答には無いので null もある
    expect(parsed.rows[0]!.byMonth['2026-01']!.workingMinutes).toBe(11_820)
  })

  /**
   * `timecard_kosoku` (Refs #998 / #986)。**知っている 3 値だけ**受け、無い月は
   * `null` にする。上流は `None` を**キーごと省略**するので、`null` には
   * 「上流が判定していない」と「記録していなかった頃の保存」が畳まれて届く。
   */
  it('timecard_kosoku を読む (知らない値とキー無しは null)', () => {
    const parsed = parseWageRange({
      months: [
        { ym: '2026-01', timecard_kosoku: 'yes' },
        { ym: '2026-02', timecard_kosoku: 'no' },
        { ym: '2026-03', timecard_kosoku: 'unreadable' },
        { ym: '2026-04' }, // キーごと省略 (上流の skip_serializing_if)
        { ym: '2026-05', timecard_kosoku: null },
        { ym: '2026-06', timecard_kosoku: 'maybe' }, // 上流が値を増やしても印にしない
        { ym: '2026-07', timecard_kosoku: 1 },
      ],
    })
    expect(parsed.months.map(m => m.timecardKosoku))
      .toEqual(['yes', 'no', 'unreadable', null, null, null, null])
  })

  /** 壊れた応答で画面を落とさない (期間集計が出ないだけにする)。 */
  it('壊れていても落ちない', () => {
    expect(parseWageRange(null).rows).toEqual([])
    expect(parseWageRange({}).months).toEqual([])
    expect(parseWageRange({ months: 'x', rows: 3 }).rows).toEqual([])
    const junk = parseWageRange({ rows: [{ driver_cd: null, by_month: null, months_missing: 'x' }] })
    expect(junk.rows[0]!.driverCd).toBe('')
    expect(junk.rows[0]!.byMonth).toEqual({})
    expect(junk.rows[0]!.monthsMissing).toEqual([])
    expect(junk.rows[0]!.calcTotal).toBe(0)
  })

  /** 欠測月リストは文字列だけ拾う (数値や null が混ざっても月キーとして扱わない)。 */
  it('months_missing の非文字列要素を捨てる', () => {
    const parsed = parseWageRange({
      rows: [{ driver_cd: 1035, months_missing: ['2026-02', 202_603, null, '2026-04'] }],
    })
    expect(parsed.rows[0]!.monthsMissing).toEqual(['2026-02', '2026-04'])
  })

  /** 配列の中身が null でも落ちない (`row ?? {}` / `v ?? {}` の枝)。 */
  it('rows / by_month の要素が null でも落ちない', () => {
    const parsed = parseWageRange({
      months: [null],
      rows: [null, { driver_cd: 1, by_month: { '2026-01': null } }],
    })
    expect(parsed.months[0]!.ym).toBe('')
    expect(parsed.rows[0]!.driverCd).toBe('')
    expect(parsed.rows[1]!.byMonth['2026-01']).toEqual({
      calcBase: null, calcOvertime: null, calcTotal: null,
      paidBase: null, paidOvertime: null, hourlyRate: null, workingMinutes: null,
    })
  })

  it('restraint_source が無ければ gcp とみなす', () => {
    expect(parseWageRange({}).restraintSource).toBe('gcp')
  })

  it('stale を渡していない月は null (判定していない)', () => {
    const parsed = parseWageRange({ months: [{ ym: '2026-01', saved: true }] })
    expect(parsed.months[0]!.stale).toBeNull()
    expect(parsed.months[0]!.computedAt).toBeNull()
  })
})

describe('monthDiff', () => {
  it('給与 − 計算 を 3 段で出す', () => {
    const d = monthDiff(row().byMonth['2026-01'])
    expect(d).toEqual({ base: -2_000, overtime: -2_000, total: -4_000 })
  })

  /** 集計に入っていない月は 0 ではなく null (「-」)。 */
  it('月が無ければ全 null', () => {
    expect(monthDiff(undefined)).toEqual({ base: null, overtime: null, total: null })
  })

  it('片側が無ければその段は null', () => {
    const d = monthDiff({
      calcBase: 100, calcOvertime: 50, calcTotal: 150,
      paidBase: null, paidOvertime: 40, hourlyRate: null, workingMinutes: null,
    })
    expect(d.base).toBeNull()
    expect(d.overtime).toBe(-10)
    expect(d.total).toBeNull() // paid 合計が出せない
  })
})

describe('rangeDiff', () => {
  it('期間合計の差を出す', () => {
    expect(rangeDiff(row())).toEqual({ base: -2_000, overtime: -2_000, total: -4_000 })
  })

  /** 合計 0 と「1 か月も集計できていない」を混同しない。 */
  it('集計月数 0 なら全 null', () => {
    expect(rangeDiff(row({ monthsCounted: 0 }))).toEqual({ base: null, overtime: null, total: null })
  })

  /** **月ごとの差の合計 == 期間合計の差** (横に並べた値と右端が合う)。 */
  it('月ごとの差の合計と一致する', () => {
    const r = row({
      monthsCounted: 2,
      byMonth: {
        '2026-01': { calcBase: 100, calcOvertime: 50, calcTotal: 150, paidBase: 90, paidOvertime: 60, hourlyRate: null, workingMinutes: null },
        '2026-02': { calcBase: 200, calcOvertime: 80, calcTotal: 280, paidBase: 210, paidOvertime: 70, hourlyRate: null, workingMinutes: null },
      },
      calcBase: 300, calcOvertime: 130, calcTotal: 430, paidBase: 300, paidOvertime: 130,
    })
    const monthly = ['2026-01', '2026-02']
      .map(m => monthDiff(r.byMonth[m]).total ?? 0)
      .reduce((a, b) => a + b, 0)
    expect(monthly).toBe(rangeDiff(r).total)
  })
})

describe('filterNegativeDiffRows', () => {
  /** 差 = 給与 − 計算。マイナス = 計算額より支払いが少ない (見に来るのはこれ)。 */
  it('差合計がマイナスの行だけ残す', () => {
    const under = row({ driverCd: '1', paidBase: 198_000, paidOvertime: 78_000 }) // -4,000
    const over = row({ driverCd: '2', paidBase: 210_000, paidOvertime: 90_000 }) // +20,000
    expect(filterNegativeDiffRows([under, over]).map(r => r.driverCd)).toEqual(['1'])
  })

  /** ちょうど 0 は「合っている」ので残さない。 */
  it('差 0 の行は残さない', () => {
    const even = row({ paidBase: 200_000, paidOvertime: 80_000 })
    expect(filterNegativeDiffRows([even])).toEqual([])
  })

  /** 1 か月も集計できていない行は差が出せない (0 円未払いとは違う)。 */
  it('集計月数 0 の行は残さない', () => {
    expect(filterNegativeDiffRows([row({ monthsCounted: 0, paidBase: 0, paidOvertime: 0 })])).toEqual([])
  })

  it('空なら空', () => {
    expect(filterNegativeDiffRows([])).toEqual([])
  })
})

describe('sumWageRangeRows', () => {
  it('行を合算し、月ごとの差も合計する', () => {
    const rows = [row(), row({ driverCd: '2042' })]
    const t = sumWageRangeRows(rows, ['2026-01', '2026-02'])
    expect(t.drivers).toBe(2)
    expect(t.calcTotal).toBe(560_000)
    expect(t.paidBase).toBe(396_000)
    expect(t.diffByMonth['2026-01']).toBe(-8_000)
    expect(t.diff.total).toBe(-8_000)
  })

  /** 集計に入った行が 1 つも無い月は 0 ではなく null (「その月は出せない」)。 */
  it('誰も集計できていない月は null', () => {
    const t = sumWageRangeRows([row()], ['2026-01', '2026-09'])
    expect(t.diffByMonth['2026-09']).toBeNull()
  })

  it('行が 0 件なら合計も 0 で差は null', () => {
    const t = sumWageRangeRows([], ['2026-01'])
    expect(t.drivers).toBe(0)
    expect(t.calcTotal).toBe(0)
    expect(t.diff.total).toBeNull()
    expect(t.diffByMonth['2026-01']).toBeNull()
  })
})

describe('monthCellState', () => {
  it('集計に入った月は counted', () => {
    expect(monthCellState(row(), month())).toBe('counted')
  })

  it('未保存の月は unsaved', () => {
    expect(monthCellState(row(), month({ saved: false }))).toBe('unsaved')
    expect(monthCellState(row(), undefined)).toBe('unsaved')
  })

  /** 月ごと外れたのは**行の責任ではない**ので missing と区別する。 */
  it('月ごと外れていれば excluded', () => {
    expect(monthCellState(row(), month({ excluded: 'payroll_missing' }))).toBe('excluded')
  })

  it('月は対象だがその人だけ欠けていれば missing', () => {
    expect(monthCellState(row(), month({ ym: '2026-05' }))).toBe('missing')
  })
})

describe('monthBadgeLabel', () => {
  it('状態ごとのラベル', () => {
    expect(monthBadgeLabel(month())).toBe('保存済')
    expect(monthBadgeLabel(month({ saved: false }))).toBe('未保存')
    expect(monthBadgeLabel(month({ excluded: 'payroll_missing' }))).toBe('給与未取込')
    expect(monthBadgeLabel(month({ excluded: 'other' }))).toBe('集計外')
    expect(monthBadgeLabel(month({ stale: true }))).toBe('要再計算')
  })
})

/**
 * 拘束の元データ (`kosoku-daily`) を組めたかの印 (Refs #998)。
 *
 * **画面に出る文字列をそのまま固定する** — ここを緩めると「印は出ているが
 * 何の印か読めない」に戻る。`'no'` と `'unreadable'` は**記号も語も別**である
 * ことまで見る (処方が逆なので、畳むとこの issue が塞ぐ穴と同じ形になる)。
 */
describe('monthKosokuMark', () => {
  it('取得済 — 記号 + 語で出す (色を消しても読める)', () => {
    const mark = monthKosokuMark(month({ timecardKosoku: 'yes' }))
    expect(mark).toEqual({
      text: '✓ 拘束元 取得済',
      tone: 'ok',
      title: 'この月の拘束は オンプレの kosoku-daily から組めています',
    })
  })

  it('取れず — 単月側 (#989) と同じ語彙。処方は「待って取り直す」', () => {
    const mark = monthKosokuMark(month({ timecardKosoku: 'no' }))
    expect(mark!.text).toBe('⚠ 拘束元 取れず')
    expect(mark!.tone).toBe('warn')
    expect(mark!.title).toBe(
      '拘束の元データ (kosoku-daily) が取れていません — '
      + 'この月の拘束をオンプレの kosoku-daily から取得できませんでした。'
      + '上流の一過性の不調なので、少し待ってからこの月を取り直すと入ります。')
  })

  it('読めず — 「取れず」と記号も語も別。処方も逆 (読み直しでは直らない)', () => {
    const mark = monthKosokuMark(month({ timecardKosoku: 'unreadable' }))
    expect(mark!.text).toBe('✕ 拘束元 読めず')
    expect(mark!.tone).toBe('error')
    expect(mark!.title).toBe(
      '拘束の元データ (kosoku-daily) の形が読めません — '
      + 'オンプレの kosoku-daily は応答しましたが、こちらが知っている形ではなく '
      + '1 件も読み取れませんでした。読み直しても直りません — '
      + '上流の応答の形を確認してください。')
    // ★ 畳んでいないことを陰性対照で示す (記号・語・色のどれも共有しない)
    const no = monthKosokuMark(month({ timecardKosoku: 'no' }))!
    expect(mark!.text).not.toBe(no.text)
    expect(mark!.tone).not.toBe(no.tone)
    expect(mark!.title).not.toBe(no.title)
  })

  /**
   * 上流は `None` を**キーごと省略**して返すので、front には
   * 「上流が判定していない」と「この項目を記録していなかった頃の保存」が
   * どちらも `null` で届く。**区別できないことを画面に書かない** = 印を出さない。
   */
  it('判定が無い月は印なし (「取れた」とも「取れなかった」とも書かない)', () => {
    expect(monthKosokuMark(month())).toBeNull()
  })
})

/**
 * 印の無い月があることの注記 (Refs #998)。**1 本で 2 つの状況を説明しない** —
 * 「そもそも判定していない (gcp)」と「判定が応答に無い」は結果が違う。
 */
describe('rangeKosokuNote', () => {
  const data = (months: WageRangeMonth[], restraintSource: string) => ({
    from: '2026-01', to: '2026-03', restraintSource, months, rows: [],
  })

  it('印の無い月が 1 つも無ければ出さない (出しっぱなしなら誰も読まなくなる)', () => {
    expect(rangeKosokuNote(data([
      month({ ym: '2026-01', timecardKosoku: 'yes' }),
      month({ ym: '2026-02', timecardKosoku: 'no' }),
      month({ ym: '2026-03', timecardKosoku: 'unreadable' }),
    ], 'current'))).toBe('')
  })

  it('応答が無ければ出さない', () => {
    expect(rangeKosokuNote(null)).toBe('')
    expect(rangeKosokuNote(undefined)).toBe('')
  })

  it('★ gcp の範囲は「判定していない」— 「取れなかった」と読ませない', () => {
    expect(rangeKosokuNote(data([month({ ym: '2026-01' }), month({ ym: '2026-02' })], 'gcp')))
      .toBe('この期間は拘束時間ソースが GCP (day_summaries) なので、'
        + '拘束の元データ (オンプレ kosoku-daily) を組めたかどうかを判定していません (2 ヶ月)。'
        + '印が無いのは「取れなかった」ではなく「判定していない」という意味です。')
  })

  it('★ gcp 以外は「印が無い = 揃っていた、ではない」— 印のある月は数に入れない', () => {
    expect(rangeKosokuNote(data([
      month({ ym: '2026-01', timecardKosoku: 'yes' }),
      month({ ym: '2026-02' }),
      month({ ym: '2026-03', timecardKosoku: 'no' }),
    ], 'current')))
      .toBe('1 ヶ月には拘束の元データ (kosoku-daily) の判定が付いていません。'
        + '印が無いことは「揃っていた」という意味ではありません — '
        + 'この応答に判定が入っていないだけなので、その月の拘束が何から組まれたかはこの画面では分かりません。')
  })

  /** ★ 2 つの状況を同じ文で説明していないこと (過去に 1 本化して片方で嘘になった)。 */
  it('★ gcp と gcp 以外で別の文になる', () => {
    const months = [month({ ym: '2026-01' })]
    expect(rangeKosokuNote(data(months, 'gcp')))
      .not.toBe(rangeKosokuNote(data(months, 'current')))
    expect(rangeKosokuNote(data(months, 'gcp'))).not.toContain('揃っていた')
    expect(rangeKosokuNote(data(months, 'current'))).not.toContain('判定していません')
  })
})

describe('monthsNeedingRefresh', () => {
  it('未保存と要再計算の月を挙げる', () => {
    const months = [
      month({ ym: '2026-01' }),
      month({ ym: '2026-02', stale: true }),
      month({ ym: '2026-03', saved: false }),
      month({ ym: '2026-04', stale: null }),
    ]
    expect(monthsNeedingRefresh(months)).toEqual(['2026-02', '2026-03'])
  })
})

describe('rangeCoverageNote', () => {
  it('月が無ければ何も言わない', () => {
    expect(rangeCoverageNote([])).toBe('')
  })

  it('全て集計に入っていれば「全て保存済み」', () => {
    expect(rangeCoverageNote([month({ ym: '2026-01' }), month({ ym: '2026-02' })]))
      .toBe('この期間は全て保存済みです')
  })

  /** 下の「集計がありません」と矛盾して読めないよう対象外の月数を出す。 */
  it('一部が集計対象外なら月数を添える', () => {
    const months = [month({ ym: '2026-01' }), month({ ym: '2026-02', excluded: 'payroll_missing' })]
    expect(rangeCoverageNote(months)).toBe('この期間は全て保存済みです (うち 1 ヶ月は集計対象外)')
  })

  it('全月が集計対象外ならそう言い切る', () => {
    const months = [
      month({ ym: '2026-01', excluded: 'payroll_missing' }),
      month({ ym: '2026-02', excluded: 'payroll_missing' }),
    ]
    expect(rangeCoverageNote(months)).toBe('この期間は全ての月が集計対象外です (2 ヶ月)')
  })
})

describe('emptyRowsNote', () => {
  it('月が無い / 全月未保存なら保存を促す', () => {
    expect(emptyRowsNote([])).toContain('保存済みの集計がありません')
    expect(emptyRowsNote([month({ saved: false })])).toContain('保存済みの集計がありません')
  })

  /** 保存済みなのに 0 件 = 保存し直しても直らない。理由を出し分ける。 */
  it('保存済みだが全月が集計対象外ならそう言う', () => {
    const months = [
      month({ ym: '2026-01', excluded: 'payroll_missing' }),
      month({ ym: '2026-02', saved: false }),
    ]
    expect(emptyRowsNote(months)).toContain('全ての月が集計対象外')
  })

  it('集計対象の月があるのに 0 件なら行側の理由を出す', () => {
    expect(emptyRowsNote([month({ ym: '2026-01' })])).toContain('合算できる乗務員がいません')
  })
})

describe('wageRangeCsv', () => {
  it('月ごとの差と期間合計を出す', () => {
    const csv = wageRangeCsv([row()], ['2026-01', '2026-02'])
    const [head, line] = csv.split('\n')
    expect(head).toContain('2026-01 差')
    expect(head).toContain('差 合計')
    expect(line).toContain('1035')
    // 集計に入っていない 2026-02 は空欄 (0 と区別する)
    expect(line!.split(',')[7]).toBe('')
  })

  /** 社員マスタで引けない人 (属性が全部 null) も落とさず空欄で出す。 */
  it('属性が null の行も空欄で出す', () => {
    const csv = wageRangeCsv([row({
      attrs: { company: null, branchCode: null, branchName: null, jobName: null },
    })], [])
    const cells = csv.split('\n')[1]!.split(',')
    expect(cells[2]).toBe('')
    expect(cells[3]).toBe('')
    expect(cells[4]).toBe('')
  })

  it('カンマや引用符を含む氏名を壊さない', () => {
    const csv = wageRangeCsv([row({ driverName: '山田, "太郎"' })], [])
    expect(csv).toContain('"山田, ""太郎"""')
  })
})

describe('defaultRange', () => {
  /** ユーザー決定 2026-08-05: その年の 1 月 〜 選択中の月。 */
  it('その年の 1 月から選択中の月まで', () => {
    expect(defaultRange('2026-06')).toEqual({ from: '2026-01', to: '2026-06' })
    expect(defaultRange('2026-01')).toEqual({ from: '2026-01', to: '2026-01' })
    expect(defaultRange('2025-12')).toEqual({ from: '2025-01', to: '2025-12' })
  })
})
