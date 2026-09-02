import { describe, expect, it } from 'vitest'
import {
  DRIVER_MASTER_ROW_COUNT,
  fetchDriverMaster,
  isRetiredDriver,
  MAX_DRIVER_MASTER_PAGES,
  parseDriverMasterPage,
  parseDriverMasterUpsertResult,
  pickNextPagerLink,
  toIsoDate,
  toUpsertItems,
  type DriverMasterRow,
} from '../src/theearth-driver-master-client'
import {
  createCookieJar,
  TheearthClientError,
  VenusSessionExpiredError,
  type FetchLike,
} from '../src/theearth-client'
import type { PagerLink } from '../src/theearth-report-client'

// ---------------------------------------------------------------------------
// fixture (F-MMS0320 の実機構造を最小再現。氏名・CD・免許日付はすべて架空)
//
// 実機は 77 列だが、この module は **header 行の列名**で引くので、必要な 6 列 +
// 「読んではいけない列」(免許証番号) + 先頭の操作列だけを持つ表で十分に検証できる。
// 列位置をわざと実機と変えてあるのは、固定 idx へ戻る改変が起きたら落ちるようにするため。
// ---------------------------------------------------------------------------

const LOGIN_FORM_HTML = `<html><body><form>
  <input name="txtPass" type="password" id="txtPass" />
</form></body></html>`

interface FixtureRow {
  cd: string
  name: string
  retiredOn?: string
  classification4?: string
  issuedOn?: string
  expiresOn?: string
}

/** データ行 1 本。セルは実機と同じ `<span id="lstMain_LabelValue{col}_{row}">値</span>`。 */
function dataRow(row: FixtureRow, index: number): string {
  const cell = (col: number, value: string) =>
    `<td><span id="lstMain_LabelValue${col}_${index}">${value}</span></td>`
  return (
    '<tr>' +
    '<td><a href="#">編集</a></td>' +
    cell(1, row.cd) +
    cell(2, row.name) +
    cell(3, '第一種大型') +
    cell(4, row.retiredOn ?? '') +
    cell(5, row.classification4 ?? '001:正社員') +
    cell(6, row.issuedOn ?? '') +
    cell(7, row.expiresOn ?? '') +
    '</tr>'
  )
}

const HEADER_ROW =
  '<tr>' +
  '<th>&nbsp;</th>' +
  '<th>乗務員CD</th><th>乗務員名</th><th>免許証番号</th>' +
  '<th>退職年月日</th><th>乗務員分類4</th><th>交付年月日</th><th>有効期限</th>' +
  '</tr>'

/** 最終行の「新規追加用」行 (span を持たないので data 行として拾われてはいけない)。 */
const NEW_ENTRY_ROW =
  '<tr>' +
  '<td>&nbsp;</td>' +
  '<td><input type="text" name="ctl00$txtNewCd" /></td>' +
  '<td><input type="text" name="ctl00$txtNewName" /></td>' +
  '<td><input type="text" name="ctl00$txtNewLicenseNo" /></td>' +
  '<td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>' +
  '</tr>'

/** ページャ。`currentPage` は `<span class="gCurrentPage">`、他ページは postback リンク。 */
function pager(currentPage: number | null, pageLinks: string[]): string {
  if (currentPage === null) return ''
  const links = pageLinks
    .map(
      (text, i) =>
        `<a href="javascript:__doPostBack(&#39;ctl00$dpMainPager$ctl01$ctl0${i}&#39;,&#39;&#39;)">${text}</a>`,
    )
    .join('')
  return (
    '<span id="dpMainPager">' +
    '<input type="submit" name="ctl00$dpMainPager$ctl00$ctl00" value="最初" disabled="disabled" />' +
    links +
    `<span class="gCurrentPage">${currentPage}</span>` +
    '<input type="submit" name="ctl00$dpMainPager$ctl02$ctl00" value="最後" />' +
    '</span>'
  )
}

function listPage(options: {
  rows?: FixtureRow[]
  currentPage?: number | null
  pageLinks?: string[]
  headerRow?: string
  extraRows?: string
  rowCountSelected?: string
  /** 実機の初回 GET は一覧が空で、行数 select もページャ横の表示ボタンも描かれない */
  withoutRowCount?: boolean
  /** 一覧が出た後のページにだけ在る、行数を適用する表示ボタン (`ctl00$btnRowCount`) */
  withRowCountButton?: boolean
}): string {
  const rows = options.rows ?? []
  const selected = options.rowCountSelected ?? '20'
  const rowCountControls = options.withoutRowCount
    ? ''
    : `<select name="ctl00$ddlRowCount">
    <option value="20"${selected === '20' ? ' selected="selected"' : ''}>20</option>
    <option value="30"${selected === '30' ? ' selected="selected"' : ''}>30</option>
  </select>
  ${options.withRowCountButton ? '<input type="submit" name="ctl00$btnRowCount" value="表示" />' : ''}`
  return `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" value="VS1" />
  <input type="hidden" name="__EVENTTARGET" value="" />
  <input type="hidden" name="__EVENTARGUMENT" value="" />
  <select name="ctl00$ddlSort"><option value="0" selected="selected">全事業所</option><option value="1">本社</option></select>
  ${rowCountControls}
  <input type="submit" name="ctl00$btnChange" value="表示" />
  ${pager(options.currentPage === undefined ? 1 : options.currentPage, options.pageLinks ?? [])}
  <table id="lstMain_itemPlaceholderContainer">
    ${options.headerRow ?? HEADER_ROW}
    ${rows.map(dataRow).join('')}
    ${options.extraRows ?? ''}
    ${NEW_ENTRY_ROW}
  </table>
</form></body></html>`
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function sequenceFetch(responses: Response[], captured?: { body: string[] }): FetchLike {
  let i = 0
  return (async (_url: unknown, init?: RequestInit) => {
    if (captured && init?.body) captured.body.push(String(init.body))
    const res = responses[i]
    i += 1
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`)
    return res
  }) as FetchLike
}

const link = (text: string, target = `t-${text}`): PagerLink => ({ text, target, argument: '' })

// ---------------------------------------------------------------------------
// parseDriverMasterPage
// ---------------------------------------------------------------------------

describe('parseDriverMasterPage', () => {
  it('header 行の列名で引き、新規追加行を除いた行だけを返す', () => {
    const page = parseDriverMasterPage(
      listPage({
        rows: [
          { cd: '1009', name: '大石 一郎', issuedOn: '2021/04/01', expiresOn: '2026/05/20' },
          { cd: '1078', name: '大石 二郎', retiredOn: '2025/03/31', classification4: '999:退職' },
        ],
      }),
    )
    expect(page.rows).toEqual([
      {
        driverCd: '1009',
        name: '大石 一郎',
        retiredOn: '',
        classification4: '001:正社員',
        licenseIssuedOn: '2021/04/01',
        licenseExpiresOn: '2026/05/20',
      },
      {
        driverCd: '1078',
        name: '大石 二郎',
        retiredOn: '2025/03/31',
        classification4: '999:退職',
        licenseIssuedOn: '',
        licenseExpiresOn: '',
      },
    ])
    expect(page.currentPage).toBe(1)
  })

  it('列を足されても位置ではなく列名で引く (先頭に列が 2 本増えても値が同じ)', () => {
    const shifted =
      '<tr><th>&nbsp;</th><th>新列A</th><th>新列B</th>' +
      '<th>乗務員CD</th><th>乗務員名</th><th>免許証番号</th>' +
      '<th>退職年月日</th><th>乗務員分類4</th><th>交付年月日</th><th>有効期限</th></tr>'
    const shiftedData =
      '<tr><td>&nbsp;</td><td><span id="lstMain_LabelValue90_0">a</span></td>' +
      '<td><span id="lstMain_LabelValue91_0">b</span></td>' +
      '<td><span id="lstMain_LabelValue1_0">1009</span></td>' +
      '<td><span id="lstMain_LabelValue2_0">大石 一郎</span></td>' +
      '<td><span id="lstMain_LabelValue21_0">第一種大型</span></td>' +
      '<td><span id="lstMain_LabelValue12_0"></span></td>' +
      '<td><span id="lstMain_LabelValue13_0">001:正社員</span></td>' +
      '<td><span id="lstMain_LabelValue22_0">2021/04/01</span></td>' +
      '<td><span id="lstMain_LabelValue23_0">2026/05/20</span></td></tr>'
    const page = parseDriverMasterPage(
      listPage({ headerRow: shifted, extraRows: shiftedData }),
    )
    expect(page.rows).toEqual([
      {
        driverCd: '1009',
        name: '大石 一郎',
        retiredOn: '',
        classification4: '001:正社員',
        licenseIssuedOn: '2021/04/01',
        licenseExpiresOn: '2026/05/20',
      },
    ])
  })

  it('タグと HTML entity (&nbsp; / &amp; / &#39;) を剥がす', () => {
    const page = parseDriverMasterPage(
      listPage({
        extraRows:
          '<tr><td>&nbsp;</td>' +
          '<td><span id="lstMain_LabelValue1_0"><b>1009</b></span></td>' +
          '<td><span id="lstMain_LabelValue2_0">&nbsp;大石&amp;三郎&#39;s&nbsp;</span></td>' +
          '<td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>',
      }),
    )
    expect(page.rows[0].driverCd).toBe('1009')
    expect(page.rows[0].name).toBe("大石&三郎's")
  })

  it('header に無い列は空文字になる', () => {
    const page = parseDriverMasterPage(
      listPage({
        headerRow: '<tr><th>&nbsp;</th><th>乗務員CD</th><th>乗務員名</th></tr>',
        extraRows:
          '<tr><td>&nbsp;</td><td><span id="lstMain_LabelValue1_0">1009</span></td>' +
          '<td><span id="lstMain_LabelValue2_0">大石 一郎</span></td></tr>',
      }),
    )
    expect(page.rows[0]).toEqual({
      driverCd: '1009',
      name: '大石 一郎',
      retiredOn: '',
      classification4: '',
      licenseIssuedOn: '',
      licenseExpiresOn: '',
    })
  })

  it('header より短いデータ行のはみ出した列は空文字になる', () => {
    const page = parseDriverMasterPage(
      listPage({
        extraRows:
          '<tr><td>&nbsp;</td><td><span id="lstMain_LabelValue1_0">1009</span></td>' +
          '<td><span id="lstMain_LabelValue2_0">大石 一郎</span></td></tr>',
      }),
    )
    expect(page.rows[0].licenseExpiresOn).toBe('')
  })

  it('header 行が見つからなければ 0 行 (乗務員名だけの表は header ではない)', () => {
    const page = parseDriverMasterPage(
      listPage({
        headerRow: '<tr><th>乗務員名</th><th>備考</th></tr>',
        rows: [{ cd: '1009', name: '大石 一郎' }],
      }),
    )
    expect(page.rows).toEqual([])
  })

  it('同名の列が 2 度出ても最初の位置を使い、空セルは列名にしない', () => {
    const page = parseDriverMasterPage(
      listPage({
        headerRow:
          '<tr><th>&nbsp;</th><th>乗務員CD</th><th>乗務員名</th><th>&nbsp;</th><th>乗務員CD</th></tr>',
        extraRows:
          '<tr><td>&nbsp;</td><td><span id="lstMain_LabelValue1_0">1009</span></td>' +
          '<td><span id="lstMain_LabelValue2_0">大石 一郎</span></td>' +
          '<td>&nbsp;</td><td><span id="lstMain_LabelValue99_0">9999</span></td></tr>',
      }),
    )
    expect(page.rows[0].driverCd).toBe('1009')
  })

  it('ページャが無ければ currentPage は 1、次ページも無い', () => {
    const page = parseDriverMasterPage(listPage({ currentPage: null }))
    expect(page.currentPage).toBe(1)
    expect(page.nextTarget).toBeNull()
  })

  it('gCurrentPage と次ページリンクを読む', () => {
    const page = parseDriverMasterPage(listPage({ currentPage: 2, pageLinks: ['1', '3'] }))
    expect(page.currentPage).toBe(2)
    expect(page.nextTarget?.text).toBe('3')
  })
})

// ---------------------------------------------------------------------------
// pickNextPagerLink — 3 分岐
// ---------------------------------------------------------------------------

describe('pickNextPagerLink', () => {
  it('currentPage+1 の数字リンクを最優先する', () => {
    const next = pickNextPagerLink([link('1'), link('2'), link('...')], 1)
    expect(next?.text).toBe('2')
  })

  it('数字リンクが無ければ「数字より後ろ」の ... を採る (戻る側は踏まない)', () => {
    const links = [link('...', 'back'), link('4'), link('5'), link('...', 'forward')]
    expect(pickNextPagerLink(links, 6)?.target).toBe('forward')
  })

  it('三点リーダ (…) も窓送りとして扱う', () => {
    expect(pickNextPagerLink([link('4'), link('…', 'forward')], 6)?.target).toBe('forward')
  })

  it('数字リンクが 1 本も無い窓では先頭の ... を採る', () => {
    expect(pickNextPagerLink([link('...', 'only')], 1)?.target).toBe('only')
  })

  it('戻る側の ... しか無ければ null (最終ページ)', () => {
    expect(pickNextPagerLink([link('...', 'back'), link('4'), link('5')], 6)).toBeNull()
  })

  it('リンクが 1 本も無ければ null', () => {
    expect(pickNextPagerLink([], 1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// toIsoDate / isRetiredDriver / toUpsertItems
// ---------------------------------------------------------------------------

describe('toIsoDate', () => {
  it('YYYY/MM/DD を YYYY-MM-DD にする', () => {
    expect(toIsoDate(' 2026/05/20 ')).toBe('2026-05-20')
  })

  it('空欄や読めない形は null', () => {
    expect(toIsoDate('')).toBeNull()
    expect(toIsoDate('R08/05/20')).toBeNull()
    expect(toIsoDate('2026/5/20')).toBeNull()
  })
})

function row(overrides: Partial<DriverMasterRow> = {}): DriverMasterRow {
  return {
    driverCd: '1009',
    name: '大石 一郎',
    retiredOn: '',
    classification4: '001:正社員',
    licenseIssuedOn: '2021/04/01',
    licenseExpiresOn: '2026/05/20',
    ...overrides,
  }
}

describe('isRetiredDriver', () => {
  it('退職年月日が入っていれば退職', () => {
    expect(isRetiredDriver(row({ retiredOn: '2025/03/31' }))).toBe(true)
  })

  it('乗務員分類4 が 999: で始まれば退職', () => {
    expect(isRetiredDriver(row({ classification4: '999:退職' }))).toBe(true)
  })

  it('どちらでもなければ在籍', () => {
    expect(isRetiredDriver(row())).toBe(false)
  })
})

describe('toUpsertItems', () => {
  it('交付日と期限が揃えば nfc_id を 16 桁で組む', () => {
    expect(toUpsertItems([row()])).toEqual([
      {
        code: '1009',
        name: '大石 一郎',
        nfc_id: '2021040120260520',
        license_issue_date: '2021-04-01',
        license_expiry_date: '2026-05-20',
      },
    ])
  })

  it('片方だけの免許日付は入れるが nfc_id は null', () => {
    expect(toUpsertItems([row({ licenseIssuedOn: '' })])[0]).toMatchObject({
      nfc_id: null,
      license_issue_date: null,
      license_expiry_date: '2026-05-20',
    })
    expect(toUpsertItems([row({ licenseExpiresOn: '' })])[0]).toMatchObject({
      nfc_id: null,
      license_issue_date: '2021-04-01',
      license_expiry_date: null,
    })
  })

  it('退職者と乗務員CD が空の行は送らない', () => {
    const items = toUpsertItems([
      row({ driverCd: '1001', retiredOn: '2025/03/31' }),
      row({ driverCd: '1002', classification4: '999:退職' }),
      row({ driverCd: '  ' }),
      row({ driverCd: '1004' }),
    ])
    expect(items.map((i) => i.code)).toEqual(['1004'])
  })

  it('同じ乗務員CD が複数出たら後勝ち', () => {
    const items = toUpsertItems([
      row({ name: '旧姓', licenseExpiresOn: '2026/05/20' }),
      row({ name: '新姓', licenseExpiresOn: '2031/05/20' }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ name: '新姓', nfc_id: '2021040120310520' })
  })

  it('免許証番号は items に 1 度も現れない (読まない列)', () => {
    const page = parseDriverMasterPage(
      listPage({ rows: [{ cd: '1009', name: '大石 一郎', issuedOn: '2021/04/01', expiresOn: '2026/05/20' }] }),
    )
    expect(JSON.stringify(toUpsertItems(page.rows))).not.toContain('第一種大型')
  })
})

// ---------------------------------------------------------------------------
// parseDriverMasterUpsertResult
// ---------------------------------------------------------------------------

describe('parseDriverMasterUpsertResult', () => {
  // 上流 (ippoan/rust-alc-api#603 の `EmployeeUpsertSummary`) の実形状。
  // skipped は **オブジェクト配列** で、reason の実値は nfc_id_conflict / unique_violation。
  it('created / updated / skipped を読む (skipped は {code, reason} の配列)', () => {
    expect(
      parseDriverMasterUpsertResult(
        '{"created":2,"updated":8,"skipped":[{"code":"1009","reason":"nfc_id_conflict"},{"code":"1078","reason":"unique_violation"}]}',
      ),
    ).toEqual({
      created: 2,
      updated: 8,
      skipped: [
        { code: '1009', reason: 'nfc_id_conflict' },
        { code: '1078', reason: 'unique_violation' },
      ],
      unreadable: null,
    })
  })

  // ★ 陰性対照。`skipped.map((v) => String(v))` に戻すとここが通ってしまい、
  // warn ログが "[object Object]" だけになって「誰がなぜ弾かれたか」が消える。
  it('skipped が {code, reason} の配列でなければ unreadable に落とす', () => {
    for (const body of [
      '{"skipped":["1009"]}',
      '{"skipped":[{"code":"1009"}]}',
      '{"skipped":[{"reason":"nfc_id_conflict"}]}',
      '{"skipped":[null]}',
    ]) {
      const result = parseDriverMasterUpsertResult(body)
      expect(result.unreadable).toContain('skipped が {code, reason} の配列ではありません')
      expect(result.skipped).toEqual([])
    }
  })

  it('warn ログに載る形 (JSON) に code と reason が両方残る', () => {
    const result = parseDriverMasterUpsertResult('{"skipped":[{"code":"1009","reason":"nfc_id_conflict"}]}')
    const logged = JSON.stringify({ skipped: result.skipped })
    expect(logged).toContain('1009')
    expect(logged).toContain('nfc_id_conflict')
    expect(logged).not.toContain('[object Object]')
  })

  it('欠けたフィールドは null / 空配列にする', () => {
    expect(parseDriverMasterUpsertResult('{"created":"2"}')).toEqual({
      created: null,
      updated: null,
      skipped: [],
      unreadable: null,
    })
  })

  it('JSON でない応答は unreadable に名指しする', () => {
    const result = parseDriverMasterUpsertResult('<html>502</html>')
    expect(result.unreadable).toContain('応答が JSON として読めません')
    expect(result.unreadable).toContain('<html>502</html>')
  })

  it('JSON オブジェクトでない応答も unreadable', () => {
    expect(parseDriverMasterUpsertResult('5').unreadable).toContain('JSON オブジェクトではありません')
    expect(parseDriverMasterUpsertResult('null').unreadable).toContain('JSON オブジェクトではありません')
  })
})

// ---------------------------------------------------------------------------
// fetchDriverMaster
// ---------------------------------------------------------------------------

describe('fetchDriverMaster', () => {
  it('GET → 表示ボタンの full form POST で 1 ページ目を取る', async () => {
    const captured = { body: [] as string[] }
    const rows = await fetchDriverMaster(
      createCookieJar(),
      sequenceFetch(
        [
          html(listPage({})),
          html(listPage({ rows: [{ cd: '1009', name: '大石 一郎' }], rowCountSelected: '30' })),
        ],
        captured,
      ),
    )
    expect(rows.map((r) => r.driverCd)).toEqual(['1009'])
    const body = new URLSearchParams(captured.body[0])
    // full form 直列化 (hidden だけの部分 POST にしない) — ddlRowCount がアカウント
    // 設定として既定へ落ちる罠を踏まないため
    expect(body.get('__VIEWSTATE')).toBe('VS1')
    expect(body.get('ctl00$ddlSort')).toBe('0')
    // ★ 初回の表示 postback に行数は載せない — 実機の初回ページに無い項目を送ると
    // EventValidation が 500 を返す (2026-09-02 本番初回実行で実害)。fixture の
    // 初回ページに select が在っても落とす
    expect(body.has('ctl00$ddlRowCount')).toBe(false)
    expect(body.get('ctl00$btnChange')).toBe('表示')
    expect(body.get('__EVENTTARGET')).toBe('')
    // 2 ページ目の応答に btnRowCount が無いので行数の postback は起きない (fetch 2 回)
    expect(captured.body).toHaveLength(1)
  })

  it('一覧が出た後に btnRowCount があれば ddlRowCount=30 で 2 回目の postback をして行数を上げる', async () => {
    const captured = { body: [] as string[] }
    const rows = await fetchDriverMaster(
      createCookieJar(),
      sequenceFetch(
        [
          // 実機どおり: 初回 GET は行数 select 無し
          html(listPage({ withoutRowCount: true })),
          // 表示後: 20 行設定で select + btnRowCount が現れる
          html(listPage({ rows: [{ cd: '1009', name: 'A' }], withRowCountButton: true })),
          // 行数適用後: 30 行設定
          html(listPage({ rows: [{ cd: '1009', name: 'A' }, { cd: '1018', name: 'B' }], rowCountSelected: '30', withRowCountButton: true })),
        ],
        captured,
      ),
    )
    expect(rows.map((r) => r.driverCd)).toEqual(['1009', '1018'])
    expect(captured.body).toHaveLength(2)
    const first = new URLSearchParams(captured.body[0])
    expect(first.has('ctl00$ddlRowCount')).toBe(false)
    expect(first.get('ctl00$btnChange')).toBe('表示')
    const second = new URLSearchParams(captured.body[1])
    expect(second.get('ctl00$ddlRowCount')).toBe(DRIVER_MASTER_ROW_COUNT)
    expect(second.get('ctl00$btnRowCount')).toBe('表示')
    expect(second.has('ctl00$btnChange')).toBe(false)
    // full form (viewstate は表示後のページのもの) を引き継ぐ
    expect(second.get('__VIEWSTATE')).toBe('VS1')
  })

  it('既に 30 行設定なら行数の postback はしない', async () => {
    const captured = { body: [] as string[] }
    await fetchDriverMaster(
      createCookieJar(),
      sequenceFetch(
        [
          html(listPage({ withoutRowCount: true })),
          html(listPage({ rows: [{ cd: '1009', name: 'A' }], rowCountSelected: '30', withRowCountButton: true })),
        ],
        captured,
      ),
    )
    expect(captured.body).toHaveLength(1)
  })

  it('数字リンクで次ページへ進み、全ページの行を集める', async () => {
    const rows = await fetchDriverMaster(
      createCookieJar(),
      sequenceFetch([
        html(listPage({})),
        html(listPage({ rows: [{ cd: '1001', name: 'A' }], currentPage: 1, pageLinks: ['2'] })),
        html(listPage({ rows: [{ cd: '1002', name: 'B' }], currentPage: 2, pageLinks: ['1'] })),
      ]),
    )
    expect(rows.map((r) => r.driverCd)).toEqual(['1001', '1002'])
  })

  it('同じページを読み直したら (新しい CD が 0 件) 止まる', async () => {
    const page = listPage({ rows: [{ cd: '1001', name: 'A' }], currentPage: 1, pageLinks: ['2'] })
    const rows = await fetchDriverMaster(
      createCookieJar(),
      sequenceFetch([
        html(listPage({})),
        html(page),
        html(listPage({ rows: [{ cd: '1001', name: 'A' }], currentPage: 2, pageLinks: ['1'] })),
      ]),
    )
    expect(rows.map((r) => r.driverCd)).toEqual(['1001'])
  })

  it('gCurrentPage が前進しなければ loud fail する (件数を静かに欠けさせない)', async () => {
    await expect(
      fetchDriverMaster(
        createCookieJar(),
        sequenceFetch([
          html(listPage({})),
          html(listPage({ rows: [{ cd: '1001', name: 'A' }], currentPage: 2, pageLinks: ['3'] })),
          html(listPage({ rows: [{ cd: '1002', name: 'B' }], currentPage: 2, pageLinks: ['3'] })),
        ]),
      ),
    ).rejects.toThrow(/gCurrentPage が前進しませんでした \(2 → 2\)/)
  })

  it(`上限 ${MAX_DRIVER_MASTER_PAGES} ページを超えたら loud fail する`, async () => {
    const responses = [html(listPage({}))]
    for (let page = 1; page <= MAX_DRIVER_MASTER_PAGES; page++) {
      responses.push(
        html(
          listPage({
            rows: [{ cd: `p${page}`, name: `driver ${page}` }],
            currentPage: page,
            pageLinks: [String(page + 1)],
          }),
        ),
      )
    }
    await expect(
      fetchDriverMaster(createCookieJar(), sequenceFetch(responses)),
    ).rejects.toThrow(new RegExp(`上限 ${MAX_DRIVER_MASTER_PAGES} ページを超えました`))
  })

  it('GET が 200 以外なら loud fail する', async () => {
    await expect(
      fetchDriverMaster(
        createCookieJar(),
        sequenceFetch([new Response('boom', { status: 503 })]),
      ),
    ).rejects.toThrow(TheearthClientError)
  })

  it('表示 POST が 200 以外なら本文の title を添えて loud fail する', async () => {
    await expect(
      fetchDriverMaster(
        createCookieJar(),
        sequenceFetch([
          html(listPage({})),
          new Response('<html><head><title>無効なポストバックまたはコールバック引数です。</title></head><body>boom</body></html>', { status: 500 }),
        ]),
      ),
    ).rejects.toThrow(/乗務員マスタ一覧の表示が HTTP 500 を返しました \(title="無効なポストバックまたはコールバック引数です。"/)
  })

  it('GET でログイン画面が返ればセッション切れとして loud fail する', async () => {
    await expect(
      fetchDriverMaster(createCookieJar(), sequenceFetch([html(LOGIN_FORM_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError)
  })

  it('表示 POST でログイン画面が返ればセッション切れとして loud fail する', async () => {
    await expect(
      fetchDriverMaster(
        createCookieJar(),
        sequenceFetch([html(listPage({})), html(LOGIN_FORM_HTML)]),
      ),
    ).rejects.toThrow(/乗務員マスタ一覧の表示でログイン画面が返されました/)
  })

  it('ページ送り中にログイン画面が返ればセッション切れとして loud fail する', async () => {
    await expect(
      fetchDriverMaster(
        createCookieJar(),
        sequenceFetch([
          html(listPage({})),
          html(listPage({ rows: [{ cd: '1001', name: 'A' }], currentPage: 1, pageLinks: ['2'] })),
          html(LOGIN_FORM_HTML),
        ]),
      ),
    ).rejects.toThrow(VenusSessionExpiredError)
  })
})
