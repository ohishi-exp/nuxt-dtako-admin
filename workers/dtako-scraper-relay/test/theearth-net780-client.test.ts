import { describe, expect, it } from 'vitest'
import {
  downloadNet780Zip,
  net780R2IndexBody,
  net780R2Paths,
  Net780ParamError,
  NET780_DOWNLOAD_MAX_ROWS,
  parseNet780Rows,
  searchNet780,
  validateNet780DownloadTargets,
  validateNet780SearchParams,
  type Net780SearchParams,
} from '../src/theearth-net780-client'
import { TheearthClientError, TheearthNotZipError, VenusSessionExpiredError, type FetchLike } from '../src/theearth-client'

// ---------------------------------------------------------------------------
// fetch モック (theearth-restraint-client.test.ts と同型)
// ---------------------------------------------------------------------------

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function sequenceFetch(responses: Response[]): FetchLike {
  let i = 0
  return (async () => {
    const res = responses[i]
    i += 1
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`)
    return res
  }) as FetchLike
}

function capturingFetch(responses: Response[], captured: { body: string[] }): FetchLike {
  let i = 0
  return (async (_url: unknown, init?: RequestInit) => {
    if (init?.body) captured.body.push(String(init.body))
    const res = responses[i]
    i += 1
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`)
    return res
  }) as FetchLike
}

const LOGIN_FORM_HTML = `<html><body><form>
  <input name="txtPass" type="password" id="txtPass" />
</form></body></html>`

// F-VOS3020 一覧ページ (実機の必須要素を最小再現、行 0 件)。
const LIST_HTML_EMPTY = `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS1" />
  <input type="submit" name="ctl00$MainContent$ucDataSelect$btnUpdate" id="btnUpdate" value="更新" />
  <input type="text" name="ctl00$MainContent$ucDataSelect$txtOperationNo" id="txtOperationNo" value="" />
  <input type="text" name="ctl00$MainContent$ucDataSelect$txtStartDateTime" id="txtStartDateTime" value="" />
  <input type="submit" name="ctl00$MainContent$btnPreview" id="MainContent_btnPreview" value="ダウンロード" />
  <select name="ctl00$MainContent$ucDataSelect$ddlRowCount" id="MainContent_ucDataSelect_ddlRowCount">
    <option value="10" selected="selected">10</option><option value="30">30</option>
  </select>
  <input type="submit" name="ctl00$MainContent$ucDataSelect$btnRowCount" id="MainContent_ucDataSelect_btnRowCount" value="表示" />
</form></body></html>`

// 行 1 件入りの一覧ページ。
const LIST_HTML_ONE_ROW = LIST_HTML_EMPTY.replace(
  '</form></body></html>',
  `<span id="MainContent_ucDataSelect_lstOperation_lblOperationNo_0">2607141234560000001726</span>
  <span id="MainContent_ucDataSelect_lstOperation_lblStartDateTime_0">2026/07/14 06:36:00</span>
  <span id="MainContent_ucDataSelect_lstOperation_lblOperationDate_0">26/07/14</span>
  <span id="MainContent_ucDataSelect_lstOperation_lblVehicleName_0">長崎100か3071</span>
  <span id="MainContent_ucDataSelect_lstOperation_lblDisplayName_0">本社営業所</span>
  <span id="MainContent_ucDataSelect_lstOperation_lblDriverCD1_0">1726</span>
  <span id="MainContent_ucDataSelect_lstOperation_lblDriverName1_0">井上 卓</span>
  <span id="MainContent_ucDataSelect_lstOperation_lblDriverName2_0"></span>
  <span id="MainContent_ucDataSelect_lstOperation_lblCityName_0">長野県松本市今井北耕地</span>
</form></body></html>`,
)

// btnUpdate の無い一覧ページ (フォーム要素欠落の検証用)。
const LIST_HTML_NO_UPDATE_BUTTON = LIST_HTML_EMPTY.replace(
  '<input type="submit" name="ctl00$MainContent$ucDataSelect$btnUpdate" id="btnUpdate" value="更新" />',
  '',
)

// 一部セルタグ自体が欠落している行 (lblOperationNo/lblStartDateTime が無い実運用は
// 想定しにくいが、パーサの null フォールバックを検証するためのケース)。
const LIST_HTML_ONE_ROW_MISSING_CELLS = LIST_HTML_EMPTY.replace(
  '</form></body></html>',
  `<span id="MainContent_ucDataSelect_lstOperation_lblOperationNo_0">2607141234560000001726</span>
</form></body></html>`,
)

// 表示件数変更ボタンの value が空 ("表示" フォールバックの検証用)。
const LIST_HTML_ONE_ROW_EMPTY_ROWCOUNT_BTN_VALUE = LIST_HTML_ONE_ROW.replace(
  'id="MainContent_ucDataSelect_btnRowCount" value="表示"',
  'id="MainContent_ucDataSelect_btnRowCount" value=""',
)

// ダウンロードボタンの value が空 ("ダウンロード" フォールバックの検証用)。
const LIST_HTML_EMPTY_PREVIEW_BTN_VALUE = LIST_HTML_EMPTY.replace(
  'id="MainContent_btnPreview" value="ダウンロード"',
  'id="MainContent_btnPreview" value=""',
)

// operationNo セル自体も欠落している行 (parseNet780Rows の operationNo フォールバックの検証用)。
const LIST_HTML_ONE_ROW_MISSING_OPERATION_NO = LIST_HTML_EMPTY.replace(
  '</form></body></html>',
  `<span id="MainContent_ucDataSelect_lstOperation_lblOperationNo_0"></span>
</form></body></html>`,
)

// 一覧更新ボタン (btnUpdate) の value が空 ("更新" フォールバックの検証用)。
const LIST_HTML_EMPTY_UPDATE_BTN_VALUE = LIST_HTML_EMPTY.replace(
  'id="btnUpdate" value="更新"',
  'id="btnUpdate" value=""',
)

// ddlRowCount の select に name 属性が無い一覧ページ (findSelectNameById の
// null フォールバックの検証用)。
const LIST_HTML_ROWCOUNT_SELECT_NO_NAME = LIST_HTML_ONE_ROW.replace(
  '<select name="ctl00$MainContent$ucDataSelect$ddlRowCount" id="MainContent_ucDataSelect_ddlRowCount">',
  '<select id="MainContent_ucDataSelect_ddlRowCount">',
)

// F-GOS0030 表示条件ページ (実機の必須要素を最小再現)。
function configHtml(overrides: Partial<Record<string, string>> = {}): string {
  const v = (id: string, fallback: string) => overrides[id] ?? fallback
  return `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS2" />
  <input type="text" name="ctl00$txtSDriver" id="txtSDriver" value="${v('txtSDriver', '')}" />
  <input type="text" name="ctl00$txtEDriver" id="txtEDriver" value="${v('txtEDriver', '')}" />
  <input type="text" name="ctl00$txtSVehicle" id="txtSVehicle" value="${v('txtSVehicle', '')}" />
  <input type="text" name="ctl00$txtEVehicle" id="txtEVehicle" value="${v('txtEVehicle', '')}" />
  <select name="ctl00$ddlSortDay1" id="ddlSortDay1">
    <option value="OperationDate"${v('ddlSortDay1', '') === '' ? ' selected' : ''}>運行日</option>
    <option value="ReadNo"${v('ddlSortDay1', '') === 'ReadNo' ? ' selected' : ''}>読取日</option>
    <option value="OperationStartDateTime">出庫日</option>
    <option value="OperationEndDateTime">帰庫日</option>
  </select>
  <input type="text" name="ctl00$ucStartDate1$txtYear" id="ucStartDate1_txtYear" value="${v('ucStartDate1_txtYear', '')}" />
  <input type="text" name="ctl00$ucStartDate1$txtMonth" id="ucStartDate1_txtMonth" value="${v('ucStartDate1_txtMonth', '')}" />
  <input type="text" name="ctl00$ucStartDate1$txtDay" id="ucStartDate1_txtDay" value="${v('ucStartDate1_txtDay', '')}" />
  <input type="text" name="ctl00$ucEndDate1$txtYear" id="ucEndDate1_txtYear" value="${v('ucEndDate1_txtYear', '')}" />
  <input type="text" name="ctl00$ucEndDate1$txtMonth" id="ucEndDate1_txtMonth" value="${v('ucEndDate1_txtMonth', '')}" />
  <input type="text" name="ctl00$ucEndDate1$txtDay" id="ucEndDate1_txtDay" value="${v('ucEndDate1_txtDay', '')}" />
  <input type="submit" name="ctl00$btnOK" id="btnOK" value="適用" />
</form></body></html>`
}

const CONFIG_HTML = configHtml()
const CONFIG_HTML_NO_DRIVER_FIELD = CONFIG_HTML.replace(
  '<input type="text" name="ctl00$txtSDriver" id="txtSDriver" value="" />',
  '',
)

// btnOK (適用) の value が空 ("適用" フォールバックの検証用)。
const CONFIG_HTML_EMPTY_BTN_VALUE = CONFIG_HTML.replace('id="btnOK" value="適用"', 'id="btnOK" value=""')

// txtSDriver が type="submit" (serializeFormFields が除外する type) になっている
// ページ。findFormFieldById (id ベース、type を見ない) では見つかるが
// serializeFormFields (name→value 直列化) には乗らないため、baseline から
// この name を引くと undefined になる — originalValues の `?? ""` フォールバック
// (searchNet780 の絞込復元ロジック) の検証用。
const CONFIG_HTML_DRIVER_NOT_SERIALIZABLE = CONFIG_HTML.replace(
  '<input type="text" name="ctl00$txtSDriver" id="txtSDriver" value="" />',
  '<input type="submit" name="ctl00$txtSDriver" id="txtSDriver" value="" />',
)

const VALID_PARAMS: Net780SearchParams = { driverCdFrom: '1726', driverCdTo: '1726' }

// ---------------------------------------------------------------------------
// validateNet780SearchParams
// ---------------------------------------------------------------------------

describe('validateNet780SearchParams', () => {
  it('乗務員CD range のみ指定は通る', () => {
    expect(() => validateNet780SearchParams(VALID_PARAMS)).not.toThrow()
  })

  it('車輌CD range のみ指定は通る', () => {
    expect(() => validateNet780SearchParams({ vehicleCdFrom: '3071', vehicleCdTo: '3071' })).not.toThrow()
  })

  it('運行日 range のみ指定は通る', () => {
    expect(() =>
      validateNet780SearchParams({ operationDateFrom: '2026-07-01', operationDateTo: '2026-07-18' }),
    ).not.toThrow()
  })

  it('全条件未指定は Net780ParamError', () => {
    expect(() => validateNet780SearchParams({})).toThrow(Net780ParamError)
    expect(() => validateNet780SearchParams({})).toThrow(/いずれか1つ以上/)
  })

  it('driverCdFrom のみ (driverCdTo 省略) は通る (from のみの絞込)', () => {
    expect(() => validateNet780SearchParams({ driverCdFrom: '1726' })).not.toThrow()
  })

  it('driverCdTo のみ (driverCdFrom 省略) は Net780ParamError', () => {
    expect(() => validateNet780SearchParams({ driverCdTo: '1726' })).toThrow(Net780ParamError)
    expect(() => validateNet780SearchParams({ driverCdTo: '1726' })).toThrow(/from を指定/)
  })

  it('乗務員CD が数値でないと Net780ParamError', () => {
    expect(() => validateNet780SearchParams({ driverCdFrom: 'abc', driverCdTo: 'abc' })).toThrow(/driverCd/)
  })

  it('車輌CD が数値でないと Net780ParamError', () => {
    expect(() => validateNet780SearchParams({ vehicleCdFrom: 'abc', vehicleCdTo: 'abc' })).toThrow(/vehicleCd/)
  })

  it('運行日が YYYY-MM-DD 形式でないと Net780ParamError', () => {
    expect(() =>
      validateNet780SearchParams({ operationDateFrom: '2026/07/01', operationDateTo: '2026/07/18' }),
    ).toThrow(/operationDate/)
  })

  it('operationDateFrom のみ (operationDateTo 省略) は通る (from のみの絞込)', () => {
    expect(() => validateNet780SearchParams({ operationDateFrom: '2026-07-01' })).not.toThrow()
  })

  it('operationDateTo のみ (operationDateFrom 省略) は Net780ParamError', () => {
    expect(() => validateNet780SearchParams({ operationDateTo: '2026-07-18' })).toThrow(Net780ParamError)
    expect(() => validateNet780SearchParams({ operationDateTo: '2026-07-18' })).toThrow(/from を指定/)
  })

  it('vehicleCdFrom のみ (vehicleCdTo 省略) は通る (from のみの絞込)', () => {
    expect(() => validateNet780SearchParams({ vehicleCdFrom: '3071' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// parseNet780Rows
// ---------------------------------------------------------------------------

describe('parseNet780Rows', () => {
  it('行が無ければ空配列', () => {
    expect(parseNet780Rows(LIST_HTML_EMPTY)).toEqual([])
  })

  it('1行分のセルを正しく抽出する', () => {
    const rows = parseNet780Rows(LIST_HTML_ONE_ROW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      operationNo: '2607141234560000001726',
      startDateTime: '2026/07/14 06:36:00',
      operationDate: '26/07/14',
      vehicleName: '長崎100か3071',
      branchName: '本社営業所',
      driverCd1: '1726',
      driverName1: '井上 卓',
      driverName2: null,
      cityName: '長野県松本市今井北耕地',
    })
  })

  it('セルタグ自体が無いフィールドは operationNo/startDateTime も含め null 相当にフォールバックする', () => {
    const rows = parseNet780Rows(LIST_HTML_ONE_ROW_MISSING_CELLS)
    expect(rows).toHaveLength(1)
    expect(rows[0].operationNo).toBe('2607141234560000001726')
    expect(rows[0].startDateTime).toBe('')
    expect(rows[0].vehicleName).toBeNull()
  })

  it('operationNo セルが空タグの行は operationNo が空文字にフォールバックする', () => {
    const rows = parseNet780Rows(LIST_HTML_ONE_ROW_MISSING_OPERATION_NO)
    expect(rows).toHaveLength(1)
    expect(rows[0].operationNo).toBe('')
  })
})

// ---------------------------------------------------------------------------
// searchNet780
// ---------------------------------------------------------------------------

describe('searchNet780', () => {
  it('正常系: 絞込適用 → 一覧更新 → 表示件数変更 → パース → 絞込復元', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY), // GET list
        html(CONFIG_HTML), // GET config
        html(CONFIG_HTML), // POST config apply
        html(LIST_HTML_ONE_ROW), // POST list update
        html(LIST_HTML_ONE_ROW), // POST rowcount
        html(CONFIG_HTML), // GET config (restore)
        html(CONFIG_HTML), // POST config apply (restore)
      ],
      captured,
    )
    const rows = await searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)
    expect(rows).toHaveLength(1)
    expect(rows[0].operationNo).toBe('2607141234560000001726')
    // 絞込適用 (最初の POST) に driverFrom/driverTo が乗っている
    // (captured.body は GET を含まない POST のみの並び)。
    expect(captured.body[0]).toContain('txtSDriver=1726')
    expect(captured.body[0]).toContain('txtEDriver=1726')
    // 復元 (最後の呼び出し) は元の空値に戻す。
    expect(captured.body[captured.body.length - 1]).toMatch(/txtSDriver=(&|$)/)
  })

  it('運行日 range を年月日フィールドへ分解して送る', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY),
        html(CONFIG_HTML),
        html(CONFIG_HTML),
        html(LIST_HTML_EMPTY),
        html(LIST_HTML_EMPTY),
        html(CONFIG_HTML),
        html(CONFIG_HTML),
      ],
      captured,
    )
    await searchNet780(
      { cookies: new Map() },
      { operationDateFrom: '2026-07-01', operationDateTo: '2026-07-18' },
      fetchImpl,
    )
    const applyBody = decodeURIComponent(captured.body[0])
    expect(applyBody).toContain('ucStartDate1$txtYear=26')
    expect(applyBody).toContain('ucStartDate1$txtMonth=07')
    expect(applyBody).toContain('ucStartDate1$txtDay=01')
    expect(applyBody).toContain('ucEndDate1$txtDay=18')
  })

  it('日付種別 select (ddlSortDay1) を読取日 (ReadNo) に固定して送る (運行日ではなく読取日で絞り込む、Refs #299)', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY),
        html(CONFIG_HTML), // GET config (既定は OperationDate=運行日)
        html(CONFIG_HTML), // POST config apply
        html(LIST_HTML_EMPTY),
        html(LIST_HTML_EMPTY),
        html(CONFIG_HTML), // GET config (restore)
        html(CONFIG_HTML), // POST config apply (restore)
      ],
      captured,
    )
    await searchNet780(
      { cookies: new Map() },
      { operationDateFrom: '2026-07-01' },
      fetchImpl,
    )
    const applyBody = decodeURIComponent(captured.body[0])
    expect(applyBody).toContain('ddlSortDay1=ReadNo')
    // 復元 (最後の呼び出し) は元の選択 (OperationDate=運行日) に戻す。
    const restoreBody = decodeURIComponent(captured.body[captured.body.length - 1])
    expect(restoreBody).toContain('ddlSortDay1=OperationDate')
  })

  it('一覧ページに btnUpdate が無ければ TheearthClientError (絞込を触る前に loud fail)', async () => {
    const fetchImpl = sequenceFetch([html(LIST_HTML_NO_UPDATE_BUTTON)])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('表示条件ページに乗務員フィールドが無ければ TheearthClientError', async () => {
    const fetchImpl = sequenceFetch([html(LIST_HTML_EMPTY), html(CONFIG_HTML_NO_DRIVER_FIELD)])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('一覧 GET がログイン画面なら VenusSessionExpiredError', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_FORM_HTML)])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('一覧更新後にログイン画面が返ると、絞込は復元してから VenusSessionExpiredError を投げる', async () => {
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY), // GET list
      html(CONFIG_HTML), // GET config
      html(CONFIG_HTML), // POST config apply
      html(LOGIN_FORM_HTML), // POST list update → ログイン切れ
      html(CONFIG_HTML), // GET config (restore)
      html(CONFIG_HTML), // POST config apply (restore)
    ])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('復元の適用が失敗すると、検索が成功していても TheearthClientError (要手動確認の文言つき)', async () => {
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY),
      html(CONFIG_HTML),
      html(CONFIG_HTML),
      html(LIST_HTML_ONE_ROW),
      html(LIST_HTML_ONE_ROW),
      html(CONFIG_HTML),
      new Response('', { status: 500 }), // POST config apply (restore) が失敗
    ])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(/手動で確認/)
  })

  it('表示件数変更フィールドが無くても緩やかに続行する (loud fail にしない)', async () => {
    const listNoRowCount = LIST_HTML_ONE_ROW.replace(
      /<select name="ctl00\$MainContent\$ucDataSelect\$ddlRowCount"[\s\S]*?<\/select>\s*<input type="submit" name="ctl00\$MainContent\$ucDataSelect\$btnRowCount"[^>]*\/>\n/,
      '',
    )
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY),
      html(CONFIG_HTML),
      html(CONFIG_HTML),
      html(listNoRowCount),
      html(CONFIG_HTML),
      html(CONFIG_HTML),
    ])
    const rows = await searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)
    expect(rows).toHaveLength(1)
  })

  it('表示件数変更ボタンの value が空でも "表示" にフォールバックする', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY),
        html(CONFIG_HTML),
        html(CONFIG_HTML),
        html(LIST_HTML_ONE_ROW_EMPTY_ROWCOUNT_BTN_VALUE),
        html(LIST_HTML_ONE_ROW_EMPTY_ROWCOUNT_BTN_VALUE),
        html(CONFIG_HTML),
        html(CONFIG_HTML),
      ],
      captured,
    )
    await searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)
    expect(decodeURIComponent(captured.body[2])).toContain('btnRowCount=表示')
  })

  it('一覧一覧ページの GET が HTTP エラーなら TheearthClientError', async () => {
    const fetchImpl = sequenceFetch([new Response('', { status: 500 })])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('表示条件ページの GET が HTTP エラーなら TheearthClientError', async () => {
    const fetchImpl = sequenceFetch([html(LIST_HTML_EMPTY), new Response('', { status: 500 })])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('表示条件ページの GET がログイン画面なら VenusSessionExpiredError', async () => {
    const fetchImpl = sequenceFetch([html(LIST_HTML_EMPTY), html(LOGIN_FORM_HTML)])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('絞込適用の postback 後にログイン画面が返ると、復元を試みてから VenusSessionExpiredError', async () => {
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY), // GET list
      html(CONFIG_HTML), // GET config
      html(LOGIN_FORM_HTML), // POST config apply → ログイン切れ
      html(CONFIG_HTML), // GET config (restore)
      html(CONFIG_HTML), // POST config apply (restore)
    ])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('一覧更新の postback が HTTP エラーなら、絞込を復元してから TheearthClientError', async () => {
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY),
      html(CONFIG_HTML),
      html(CONFIG_HTML),
      new Response('', { status: 503 }), // POST list update が失敗
      html(CONFIG_HTML),
      html(CONFIG_HTML),
    ])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('表示件数変更の postback が HTTP エラーなら、絞込を復元してから TheearthClientError', async () => {
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY),
      html(CONFIG_HTML),
      html(CONFIG_HTML),
      html(LIST_HTML_ONE_ROW),
      new Response('', { status: 503 }), // POST rowcount が失敗
      html(CONFIG_HTML),
      html(CONFIG_HTML),
    ])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('表示件数変更の postback 後にログイン画面が返ると、絞込を復元してから VenusSessionExpiredError', async () => {
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY),
      html(CONFIG_HTML),
      html(CONFIG_HTML),
      html(LIST_HTML_ONE_ROW),
      html(LOGIN_FORM_HTML), // POST rowcount → ログイン切れ
      html(CONFIG_HTML),
      html(CONFIG_HTML),
    ])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('検索処理と復元処理の両方が失敗すると、両方のメッセージを含む TheearthClientError', async () => {
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY),
      html(CONFIG_HTML),
      html(CONFIG_HTML),
      new Response('', { status: 503 }), // POST list update が失敗 (検索失敗)
      html(CONFIG_HTML),
      new Response('', { status: 500 }), // POST config apply (restore) も失敗
    ])
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(
      /検索処理も失敗していました/,
    )
  })

  it('検索処理・復元処理の両方が非 Error 値を throw しても String() でメッセージ化する', async () => {
    // 4回目 (POST list update) と 6回目 (POST config apply restore) の呼び出しで
    // 非 Error 値 (文字列) を投げる。`restoreErr`/`searchError` それぞれの
    // `instanceof Error` false 側 (String() フォールバック) を両方踏む。
    const responses = [html(LIST_HTML_EMPTY), html(CONFIG_HTML), html(CONFIG_HTML)]
    let call = 0
    const fetchImpl = (async () => {
      const idx = call
      call += 1
      if (idx === 3) throw 'search-boom' // eslint-disable-line no-throw-literal
      if (idx === 4) throw 'restore-boom' // eslint-disable-line no-throw-literal
      const res = responses[idx]
      if (!res) throw new Error(`unexpected extra fetch call (#${idx})`)
      return res
    }) as FetchLike
    await expect(searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)).rejects.toThrow(
      /search-boom.*restore-boom|restore-boom.*search-boom/s,
    )
  })

  it('btnUpdate の value が空でも "更新" にフォールバックする', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY_UPDATE_BTN_VALUE),
        html(CONFIG_HTML),
        html(CONFIG_HTML),
        html(LIST_HTML_EMPTY_UPDATE_BTN_VALUE), // POST list update
        html(LIST_HTML_EMPTY_UPDATE_BTN_VALUE), // POST rowcount (ddlRowCount あり)
        html(CONFIG_HTML),
        html(CONFIG_HTML),
      ],
      captured,
    )
    await searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)
    expect(decodeURIComponent(captured.body[1])).toContain('btnUpdate=更新')
  })

  it('btnOK の value が空でも "適用" にフォールバックする', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY),
        html(CONFIG_HTML_EMPTY_BTN_VALUE),
        html(CONFIG_HTML_EMPTY_BTN_VALUE),
        html(LIST_HTML_EMPTY), // POST list update
        html(LIST_HTML_EMPTY), // POST rowcount (ddlRowCount あり)
        html(CONFIG_HTML_EMPTY_BTN_VALUE),
        html(CONFIG_HTML_EMPTY_BTN_VALUE),
      ],
      captured,
    )
    await searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)
    expect(decodeURIComponent(captured.body[0])).toContain('btnOK=適用')
  })

  it('ddlRowCount の select に name 属性が無ければ、表示件数変更をスキップして続行する', async () => {
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY),
      html(CONFIG_HTML),
      html(CONFIG_HTML),
      html(LIST_HTML_ROWCOUNT_SELECT_NO_NAME),
      html(CONFIG_HTML),
      html(CONFIG_HTML),
    ])
    const rows = await searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)
    expect(rows).toHaveLength(1)
  })

  it('表示条件ページのフィールドが serializeFormFields で拾えなくても originalValues は空文字にフォールバックする', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY),
        html(CONFIG_HTML_DRIVER_NOT_SERIALIZABLE),
        html(CONFIG_HTML_DRIVER_NOT_SERIALIZABLE),
        html(LIST_HTML_EMPTY), // POST list update
        html(LIST_HTML_EMPTY), // POST rowcount (ddlRowCount あり)
        html(CONFIG_HTML_DRIVER_NOT_SERIALIZABLE),
        html(CONFIG_HTML_DRIVER_NOT_SERIALIZABLE),
      ],
      captured,
    )
    await searchNet780({ cookies: new Map() }, VALID_PARAMS, fetchImpl)
    // 復元 (最後の呼び出し) で txtSDriver が空文字に戻っている (undefined ではない)。
    expect(decodeURIComponent(captured.body[captured.body.length - 1])).toMatch(/txtSDriver=(&|$)/)
  })
})

// ---------------------------------------------------------------------------
// validateNet780DownloadTargets
// ---------------------------------------------------------------------------

describe('validateNet780DownloadTargets', () => {
  it('1件以上・運行No 22桁なら通る', () => {
    expect(() =>
      validateNet780DownloadTargets([{ operationNo: '2607141234560000001726', startDateTime: '2026/07/14 06:36:00' }]),
    ).not.toThrow()
  })

  it('0件は Net780ParamError', () => {
    expect(() => validateNet780DownloadTargets([])).toThrow(Net780ParamError)
  })

  it('上限件数超過は Net780ParamError', () => {
    const targets = Array.from({ length: NET780_DOWNLOAD_MAX_ROWS + 1 }, () => ({
      operationNo: '2607141234560000001726',
      startDateTime: '2026/07/14 06:36:00',
    }))
    expect(() => validateNet780DownloadTargets(targets)).toThrow(/最大/)
  })

  it('運行No が22桁の数値でないと Net780ParamError', () => {
    expect(() => validateNet780DownloadTargets([{ operationNo: '123', startDateTime: 'x' }])).toThrow(/運行No/)
  })
})

// ---------------------------------------------------------------------------
// downloadNet780Zip
// ---------------------------------------------------------------------------

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
const TARGETS = [{ operationNo: '2607141234560000001726', startDateTime: '2026/07/14 06:36:00' }]

describe('downloadNet780Zip', () => {
  it('正常系: 単一 postback で zip bytes を返す (カンマ連結は単一件なら素通し)', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY),
        new Response(ZIP_BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      ],
      captured,
    )
    const buf = await downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(ZIP_BYTES.slice(0, 4))
    expect(decodeURIComponent(captured.body[0])).toContain('txtOperationNo=2607141234560000001726')
  })

  it('複数選択はカンマ連結で送る', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY),
        new Response(ZIP_BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      ],
      captured,
    )
    await downloadNet780Zip(
      { cookies: new Map() },
      [
        { operationNo: '2607141234560000001726', startDateTime: '2026/07/14 06:36:00' },
        { operationNo: '2607181234560000001732', startDateTime: '2026/07/18 04:07:00' },
      ],
      fetchImpl,
    )
    const body = decodeURIComponent(captured.body[0]).replace(/\+/g, ' ')
    expect(body).toContain('txtOperationNo=2607141234560000001726,2607181234560000001732')
    expect(body).toContain('txtStartDateTime=2026/07/14 06:36:00,2026/07/18 04:07:00')
  })

  it('一覧ページにフォーム要素が無ければ TheearthClientError', async () => {
    const listWithoutOperationNoField = LIST_HTML_EMPTY.replace(
      '<input type="text" name="ctl00$MainContent$ucDataSelect$txtOperationNo" id="txtOperationNo" value="" />',
      '',
    )
    const fetchImpl = sequenceFetch([html(listWithoutOperationNoField)])
    await expect(downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('ダウンロードボタンの value が空でも "ダウンロード" にフォールバックする', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [
        html(LIST_HTML_EMPTY_PREVIEW_BTN_VALUE),
        new Response(ZIP_BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      ],
      captured,
    )
    await downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)
    expect(decodeURIComponent(captured.body[0])).toContain('btnPreview=ダウンロード')
  })

  it('一覧ページの GET が HTTP エラーなら TheearthClientError', async () => {
    const fetchImpl = sequenceFetch([new Response('', { status: 500 })])
    await expect(downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('一覧 GET がログイン画面なら VenusSessionExpiredError', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_FORM_HTML)])
    await expect(downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('ダウンロード postback が HTTP エラーなら TheearthClientError', async () => {
    const fetchImpl = sequenceFetch([html(LIST_HTML_EMPTY), new Response('', { status: 503 })])
    await expect(downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('ダウンロード postback がログイン画面 (HTML) を返すと VenusSessionExpiredError', async () => {
    const fetchImpl = sequenceFetch([html(LIST_HTML_EMPTY), html(LOGIN_FORM_HTML)])
    await expect(downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('ダウンロード postback が想定外の HTML を返すと TheearthClientError', async () => {
    const fetchImpl = sequenceFetch([html(LIST_HTML_EMPTY), html('<html><body>謎のエラー画面</body></html>')])
    await expect(downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('zip でない応答 (application/octet-stream だがマジック不一致) は TheearthNotZipError', async () => {
    const fetchImpl = sequenceFetch([
      html(LIST_HTML_EMPTY),
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ])
    await expect(downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)).rejects.toThrow(TheearthNotZipError)
  })

  it('content-type ヘッダーが無い zip 応答でも正常にダウンロードできる', async () => {
    const fetchImpl = sequenceFetch([html(LIST_HTML_EMPTY), new Response(ZIP_BYTES, { status: 200 })])
    const buf = await downloadNet780Zip({ cookies: new Map() }, TARGETS, fetchImpl)
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(ZIP_BYTES.slice(0, 4))
  })

  it('選択件数バリデーションを通ってから fetch する (0件は fetch を1回も呼ばない)', async () => {
    const fetchImpl = sequenceFetch([])
    await expect(downloadNet780Zip({ cookies: new Map() }, [], fetchImpl)).rejects.toThrow(Net780ParamError)
  })
})

describe('net780R2Paths / net780R2IndexBody', () => {
  it('prefix/compId 配下に zipObject (ハッシュ dedup) と indexObject (operationNo ごと) の key を組み立てる', () => {
    const paths = net780R2Paths('net780', 'comp1')
    expect(paths.zipObject('abcd1234')).toBe('net780/comp1/zips/abcd1234.zip')
    expect(paths.indexObject('2607041256390000006572')).toBe('net780/comp1/by-operation/2607041256390000006572.json')
  })

  it('net780R2IndexBody は決定論 JSON を返す', () => {
    const body = net780R2IndexBody({
      zipKey: 'net780/comp1/zips/abcd1234.zip',
      startDateTime: '2026-07-04 12:56:39',
      fetchedAt: '2026-07-18T00:00:00.000Z',
      operationCount: 1,
    })
    expect(JSON.parse(body)).toEqual({
      zipKey: 'net780/comp1/zips/abcd1234.zip',
      startDateTime: '2026-07-04 12:56:39',
      fetchedAt: '2026-07-18T00:00:00.000Z',
      operationCount: 1,
    })
  })
})
