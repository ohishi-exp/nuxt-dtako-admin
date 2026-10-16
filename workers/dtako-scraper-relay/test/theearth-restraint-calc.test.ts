import { describe, expect, it } from 'vitest'
import {
  calculateRestraint,
  parseCalcBranches,
  parseCalcRows,
  RestraintParamError,
} from '../src/theearth-restraint-client'
import {
  createCookieJar,
  TheearthClientError,
  VenusSessionExpiredError,
  type FetchLike,
} from '../src/theearth-client'

// F-ERS2012[RestraintReportCalc] の実ページ (2026-10-16 北海大運) の必須要素を最小再現。
function calcPage(opts: { branches?: string; rows?: string; era?: boolean; done?: boolean } = {}): string {
  const branches = opts.branches ?? '<option selected="selected" value="00000001">本社</option>'
  return `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS1" />
  <input type="radio" name="KijyunType" id="rdoKijyunType_1" value="1" checked="checked" />
  ${opts.era ? '<input type="checkbox" name="ucMonthDate$chkUseEra" id="ucMonthDate_chkUseEra" checked="checked" />' : ''}
  <input name="ucMonthDate$txtYear" type="text" value="08" maxlength="2" id="ucMonthDate_txtYear" />
  <input name="ucMonthDate$txtMonth" type="text" value="10" id="ucMonthDate_txtMonth" />
  <select name="ddlBranch" id="ddlBranch">${branches}</select>
  <input type="submit" name="btnBranch" value="適用" id="btnBranch" />
  <table>${opts.rows ?? ''}</table>
  <input type="submit" name="btnOK" value="集計開始" id="btnOK" />
  ${opts.done ? '<script>DispMsg(\'完了しました。\');</script>' : ''}
</form></body></html>`
}

function row(i: number, cd: string, calc: string, checked = false): string {
  return `<tr id="lstData_row_${i}"><td><input id="lstData_chkCheck_${i}" type="checkbox" name="lstData$ctrl${i}$chkCheck"${checked ? ' checked="checked"' : ''}></td>
  <td><span id="lstData_lblDriverCD_${i}">${cd}</span></td><td><span id="lstData_lblDriverName_${i}">名前</span></td>
  <td><span id="lstData_lblIsCalc_${i}" style="color:Black;">${calc}</span></td></tr>`
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function recordingFetch(responses: Response[]): { fetchImpl: FetchLike; bodies: URLSearchParams[] } {
  const bodies: URLSearchParams[] = []
  let i = 0
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    if (init?.body) bodies.push(new URLSearchParams(String(init.body)))
    const res = responses[i]
    i += 1
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`)
    return res
  }) as FetchLike
  return { fetchImpl, bodies }
}

const LOGIN_HTML = '<html><body><form><input name="txtPass" type="password" id="txtPass" /></form></body></html>'
const PARAMS = { year: 2026, month: 7 }

describe('parseCalcBranches', () => {
  it('ddlBranch の option を出現順に {value, text} で返す (実体参照も戻す)', () => {
    const page = calcPage({
      branches: '<option value="00000001">大石運輸倉庫㈱　本社営業所</option><option selected="selected" value="00000002">A&amp;B</option>',
    })
    expect(parseCalcBranches(page)).toEqual([
      { value: '00000001', text: '大石運輸倉庫㈱　本社営業所' },
      { value: '00000002', text: 'A&B' },
    ])
  })

  it('select が無い・value が無い option', () => {
    expect(parseCalcBranches('<html></html>')).toEqual([])
    expect(parseCalcBranches(calcPage({ branches: '<option>x</option>' }))).toEqual([{ value: '', text: 'x' }])
  })
})

describe('parseCalcRows', () => {
  it('乗務員CD と済/未を読む。span が欠けた行は空', () => {
    const page = calcPage({
      rows:
        row(0, '2', '済') +
        row(1, '18', '未', true) +
        '<tr><td><input id="lstData_chkCheck_2" type="checkbox" name="lstData$ctrl2$chkCheck"></td></tr>',
    })
    expect(parseCalcRows(page)).toEqual([
      { checkName: 'lstData$ctrl0$chkCheck', driverCd: '2', calculatedBefore: true },
      { checkName: 'lstData$ctrl1$chkCheck', driverCd: '18', calculatedBefore: false },
      { checkName: 'lstData$ctrl2$chkCheck', driverCd: '', calculatedBefore: false },
    ])
  })
})

describe('calculateRestraint', () => {
  it('事業所ごとに「適用」→ 全行チェックで「集計開始」。乗務員の居ない事業所は押さない', async () => {
    const branches = '<option value="00000001">本社</option><option value="00000002">支店</option>'
    const { fetchImpl, bodies } = recordingFetch([
      html(calcPage({ branches })),
      html(calcPage({ branches, rows: row(0, '2', '済') + row(1, '18', '未', true) })),
      html(calcPage({ branches, rows: row(0, '2', '済') + row(1, '18', '済'), done: true })),
      html(calcPage({ branches })),
    ])
    const out = await calculateRestraint(createCookieJar(), PARAMS, fetchImpl, { requestTimeoutMs: 1000, exportTimeoutMs: 1000 })
    expect(out).toEqual([
      {
        branchCode: '00000001',
        branchName: '本社',
        drivers: [
          { driverCd: '2', calculatedBefore: true },
          { driverCd: '18', calculatedBefore: false },
        ],
      },
      { branchCode: '00000002', branchName: '支店', drivers: [] },
    ])
    // 適用: 4 桁西暦・0 埋めの月・事業所・btnBranch
    expect(bodies[0]!.get('ucMonthDate$txtYear')).toBe('2026')
    expect(bodies[0]!.get('ucMonthDate$txtMonth')).toBe('07')
    expect(bodies[0]!.get('ddlBranch')).toBe('00000001')
    expect(bodies[0]!.get('btnBranch')).toBe('適用')
    expect(bodies[0]!.has('btnOK')).toBe(false)
    // 集計開始: 全行 on・btnOK
    expect(bodies[1]!.get('lstData$ctrl0$chkCheck')).toBe('on')
    expect(bodies[1]!.get('lstData$ctrl1$chkCheck')).toBe('on')
    expect(bodies[1]!.get('btnOK')).toBe('集計開始')
    // 2 つ目の事業所は適用だけ
    expect(bodies[2]!.get('ddlBranch')).toBe('00000002')
    expect(bodies).toHaveLength(3)
  })

  it('和暦入力の企業は令和 2 桁で送る', async () => {
    const { fetchImpl, bodies } = recordingFetch([
      html(calcPage({ era: true })),
      html(calcPage({ era: true, rows: row(0, '2', '済') })),
      html(calcPage({ era: true, rows: row(0, '2', '済'), done: true })),
    ])
    await calculateRestraint(createCookieJar(), PARAMS, fetchImpl)
    expect(bodies[0]!.get('ucMonthDate$txtYear')).toBe('08')
  })

  it('「完了しました」が返らなければ throw', async () => {
    const { fetchImpl } = recordingFetch([
      html(calcPage()),
      html(calcPage({ rows: row(0, '2', '済') })),
      html(calcPage({ rows: row(0, '2', '済') })),
    ])
    await expect(calculateRestraint(createCookieJar(), PARAMS, fetchImpl)).rejects.toThrow(/完了しました/)
  })

  it('GET / postback がログイン画面ならセッション切れ', async () => {
    await expect(
      calculateRestraint(createCookieJar(), PARAMS, recordingFetch([html(LOGIN_HTML)]).fetchImpl),
    ).rejects.toBeInstanceOf(VenusSessionExpiredError)
    await expect(
      calculateRestraint(createCookieJar(), PARAMS, recordingFetch([html(calcPage()), html(LOGIN_HTML)]).fetchImpl),
    ).rejects.toBeInstanceOf(VenusSessionExpiredError)
  })

  it('postback が HTTP エラーなら throw', async () => {
    const { fetchImpl } = recordingFetch([html(calcPage()), html('<title>err</title>', 500)])
    await expect(calculateRestraint(createCookieJar(), PARAMS, fetchImpl)).rejects.toThrow(/HTTP 500/)
  })

  it('フォーム要素・事業所が無ければ throw (黙って成功にしない)', async () => {
    await expect(
      calculateRestraint(createCookieJar(), PARAMS, recordingFetch([html('<html><form></form></html>')]).fetchImpl),
    ).rejects.toThrow(/id=ucMonthDate_txtYear/)
    const noBranch = recordingFetch([html(calcPage({ branches: '' }))])
    await expect(calculateRestraint(createCookieJar(), PARAMS, noBranch.fetchImpl)).rejects.toBeInstanceOf(TheearthClientError)
  })

  it('年月の不正は送る前に弾く', async () => {
    await expect(
      calculateRestraint(createCookieJar(), { year: 2026, month: 13 }, recordingFetch([]).fetchImpl),
    ).rejects.toBeInstanceOf(RestraintParamError)
  })
})
