import { describe, expect, it } from 'vitest'
import {
  assertZipMagic,
  cookieHeader,
  createCookieJar,
  detectWareki,
  downloadCsvZip,
  EMPTY_ZIP_BYTE_LENGTH,
  EVIDENCE_BODY_PREFIX_MAX,
  extractHiddenFields,
  isEmptyZip,
  fetchWithJar,
  ingestSetCookie,
  login,
  scrapeViaHttp,
  serializeFormFields,
  splitJapaneseDate,
  TheearthClientError,
  TheearthNotZipError,
  TheearthPageMismatchError,
  VenusSessionExpiredError,
  type FetchLike,
} from '../src/theearth-client'
import { PhaseTimer } from '../src/phase-timing'

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04])

/** theearth が「その期間に運行が 1 件も無い」時に返す空 ZIP — EOCD (`PK\x05\x06`)
 * だけの 22 bytes (Refs #633-22)。 */
function emptyZipBytes(): Uint8Array {
  const bytes = new Uint8Array(EMPTY_ZIP_BYTE_LENGTH)
  bytes.set([0x50, 0x4b, 0x05, 0x06])
  return bytes
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/** Content-Type ヘッダを一切持たないレスポンス (自動付与を避けるため body は素の bytes)。 */
function htmlNoContentType(body: string): Response {
  return new Response(new TextEncoder().encode(body), { status: 200 })
}

function redirect(location: string | null): Response {
  const headers = new Headers()
  if (location) headers.set('location', location)
  return new Response(null, { status: 302, headers })
}

function zipResponse(bytes: Uint8Array = ZIP_BYTES): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
}

/** 呼び出し順に Response を返す fetch モック。 */
function sequenceFetch(responses: Response[]): FetchLike {
  let i = 0
  return (async () => {
    const res = responses[i]
    i += 1
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`)
    return res
  }) as FetchLike
}

const LOGIN_PAGE_HTML = `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS123==" />
  <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="EV1" />
</form></body></html>`

const LOGIN_SUCCESS_HTML = `<html><body>ようこそ<span id="Button1st_2"></span></body></html>`

// 実ページ同様、__VIEWSTATEENCRYPTED (値は空) を含むログインページ (Refs #90)。
const LOGIN_PAGE_WITH_ENC_HTML = `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS123==" />
  <input type="hidden" name="__VIEWSTATEENCRYPTED" id="__VIEWSTATEENCRYPTED" value="" />
  <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="EV1" />
</form></body></html>`

// 認証失敗時はログインページ (txtPass 含む) が 200 で再表示される。実ページは
// txtOverlapSessionID / btnForced を value 無しの hidden で常時含む (Refs #90)。
const LOGIN_FAILURE_HTML = `<html><body><form>
  <input name="txtPass" type="password" id="txtPass" />
  <input name="txtOverlapSessionID" type="text" id="txtOverlapSessionID" class="hide" />
  <input type="submit" name="btnForced" value="hide" id="btnForced" class="hide" />
</form></body></html>`

const UNKNOWN_PAGE_HTML = `<html><head><title>お知らせ</title></head><body>本日のお知らせ</body></html>`

const VIEWSTATE_MAC_ERROR_HTML = `<html><head><title>ランタイム エラー</title></head><body>
  <script>var x = 1;</script>
  viewstate MAC の検証が失敗しました。
</body></html>`

// overlap プロンプト: サーバが txtOverlapSessionID に session ID を焼き込む
// (value 非空 = overlapSessionActive が発動)。実ページの btnForced value は "hide"。
const OVERLAP_SESSION_HTML = `<html><body>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS999" />
  <input type="text" name="txtOverlapSessionID" id="txtOverlapSessionID" value="SID-abc123" />
  <input type="submit" id="btnForced" name="ctl00$MainContent$btnForced" value="hide" />
</body></html>`

const OVERLAP_SESSION_NO_BUTTON_HTML = `<html><body>
  <input type="hidden" name="txtOverlapSessionID" id="txtOverlapSessionID" value="dummy" />
</body></html>`

const OVERLAP_SESSION_NO_VALUE_HTML = `<html><body>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS999" />
  <input type="hidden" name="txtOverlapSessionID" id="txtOverlapSessionID" value="dummy" />
  <input type="submit" id="btnForced" name="ctl00$MainContent$btnForced" />
</body></html>`

// 単純なセッション重複: サーバは startup script で OverlapDialog(...) を呼ぶだけで
// txtOverlapSessionID は空のまま (J-OES1010[Login].js 実機確認)。ログインフォーム
// (txtPass) の再表示 + btnForced を含む。
const OVERLAP_DIALOG_HTML = `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VSOVR" />
  <input name="txtPass" type="password" id="txtPass" />
  <input type="text" name="txtOverlapSessionID" id="txtOverlapSessionID" value="" />
  <input type="submit" id="btnForced" name="ctl00$MainContent$btnForced" value="hide" />
  <script>OverlapDialog('別のセッションでログイン中です。強制ログインしますか?');</script>
</form></body></html>`

// ライセンス数超過 (定数オーバー): LicenceOverDialog(message, info1, info2, btnName)
// が呼ばれる。info1 (session ID CSV) の先頭 = 最初にログインしたセッションを kick して
// 自動で強制ログインする (cdp-pair 実機トレースで positional pairing を確認済み)。
const LICENCE_OVER_HTML = `<html><body><form>
  <input name="txtPass" type="password" id="txtPass" />
  <input type="text" name="txtOverlapSessionID" id="txtOverlapSessionID" value="" />
  <input type="submit" id="btnForced" name="ctl00$MainContent$btnForced" value="hide" />
  <script>LicenceOverDialog('ライセンス数を超過しています', 'sid-first,sid-second', 'userA,userB', '接続ユーザー確認');</script>
</form></body></html>`

// LicenceOverDialog( の呼び出し自体は見つかるが、4 引数として厳密パースできない
// (サイト仕様変更等) 想定のフィクスチャ。自動 kick はできないため loud fail に倒す。
const LICENCE_OVER_UNPARSEABLE_HTML = `<html><body><form>
  <input name="txtPass" type="password" id="txtPass" />
  <input type="text" name="txtOverlapSessionID" id="txtOverlapSessionID" value="" />
  <input type="submit" id="btnForced" name="ctl00$MainContent$btnForced" value="hide" />
  <script>LicenceOverDialog('ライセンス数を超過しています', notAString);</script>
</form></body></html>`

function csvPageHtml(opts: { omit?: string; tableDate?: string } = {}): string {
  const tableDate = opts.tableDate ?? '26/07/01'
  const fields: Record<string, string> = {
    __VIEWSTATE: '<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="CSVVS" />',
    rdoSelect1: '<input type="radio" id="rdoSelect1" name="ctl00$MainContent$SelectM" value="rdoSelect1" />',
    rdoDate1: '<input type="radio" id="rdoDate1" name="ctl00$MainContent$SelectD" value="rdoDate1" />',
    MainContent_ucStartDate_txtYear:
      '<input type="text" id="MainContent_ucStartDate_txtYear" name="ctl00$MainContent$ucStartDate$txtYear" value="" />',
    MainContent_ucStartDate_txtMonth:
      '<input type="text" id="MainContent_ucStartDate_txtMonth" name="ctl00$MainContent$ucStartDate$txtMonth" value="" />',
    MainContent_ucStartDate_txtDay:
      '<input type="text" id="MainContent_ucStartDate_txtDay" name="ctl00$MainContent$ucStartDate$txtDay" value="" />',
    MainContent_ucEndDate_txtYear:
      '<input type="text" id="MainContent_ucEndDate_txtYear" name="ctl00$MainContent$ucEndDate$txtYear" value="" />',
    MainContent_ucEndDate_txtMonth:
      '<input type="text" id="MainContent_ucEndDate_txtMonth" name="ctl00$MainContent$ucEndDate$txtMonth" value="" />',
    MainContent_ucEndDate_txtDay:
      '<input type="text" id="MainContent_ucEndDate_txtDay" name="ctl00$MainContent$ucEndDate$txtDay" value="" />',
    btnCsvSvr: '<input type="submit" id="btnCsvSvr" name="ctl00$MainContent$btnCsvSvr" value="ダウンロード" />',
  }
  if (opts.omit) delete fields[opts.omit]
  return `<html><body><table><tr><td>${tableDate}</td></tr></table>${Object.values(fields).join('\n')}</body></html>`
}

const STAGE1_CONFIRM_HTML = `<html><body>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="STAGE2VS" />
  <input type="submit" id="btnCsvSvrOutput" name="ctl00$MainContent$btnCsvSvrOutput" value="ダウンロード" />
</body></html>`

const STAGE1_CONFIRM_NO_OUTPUT_HTML = `<html><body>この日付範囲にはデータがありません</body></html>`

const STAGE1_CONFIRM_NO_VALUE_HTML = `<html><body>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="STAGE2VS" />
  <input type="submit" id="btnCsvSvrOutput" name="ctl00$MainContent$btnCsvSvrOutput" />
</body></html>`

describe('cookie jar', () => {
  it('ingests Set-Cookie via getSetCookie() and builds the Cookie header', () => {
    const jar = createCookieJar()
    const headers = new Headers()
    headers.append('set-cookie', 'sid=abc; Path=/; HttpOnly')
    headers.append('set-cookie', 'lang=ja')
    ingestSetCookie(jar, headers)
    expect(cookieHeader(jar)).toBe('sid=abc; lang=ja')
  })

  it('falls back to a single set-cookie header when getSetCookie is unavailable', () => {
    const jar = createCookieJar()
    const fakeHeaders = { get: (name: string) => (name === 'set-cookie' ? 'sid=xyz' : null) } as unknown as Headers
    ingestSetCookie(jar, fakeHeaders)
    expect(cookieHeader(jar)).toBe('sid=xyz')
  })

  it('yields no cookies when there is nothing to fall back to', () => {
    const jar = createCookieJar()
    const fakeHeaders = { get: () => null } as unknown as Headers
    ingestSetCookie(jar, fakeHeaders)
    expect(cookieHeader(jar)).toBe('')
  })

  it('skips malformed cookie pairs (no "=") and empty names', () => {
    const jar = createCookieJar()
    const headers = new Headers()
    headers.append('set-cookie', 'noequalsign')
    headers.append('set-cookie', '=onlyvalue')
    headers.append('set-cookie', 'ok=1')
    ingestSetCookie(jar, headers)
    expect(cookieHeader(jar)).toBe('ok=1')
  })
})

describe('fetchWithJar timeout handling', () => {
  it('translates an aborted fetch into a TheearthClientError timeout message', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const fetchImpl = (async () => {
      throw new DOMException('The operation was aborted', 'AbortError')
    }) as unknown as FetchLike
    await expect(
      fetchWithJar(createCookieJar(), 'https://theearth-np.com/x', { method: 'GET', signal: ctrl.signal }, fetchImpl, 30000),
    ).rejects.toThrow('タイムアウト')
  })

  it('rethrows a non-abort fetch error unchanged', async () => {
    const fetchImpl = (async () => {
      throw new Error('network boom')
    }) as unknown as FetchLike
    await expect(
      fetchWithJar(createCookieJar(), 'https://theearth-np.com/x', { method: 'GET' }, fetchImpl),
    ).rejects.toThrow('network boom')
  })

  it('includes the stage label and timeout ms so request (30s) vs export (150s) timeouts are distinguishable (Refs #205-52)', async () => {
    // 「どちらの timeout に当たったか」を文言そのものから読めるようにする。
    const ctrl = new AbortController()
    ctrl.abort()
    const fetchImpl = (async () => {
      throw new DOMException('The operation was aborted', 'AbortError')
    }) as unknown as FetchLike
    await expect(
      fetchWithJar(
        createCookieJar(),
        'https://theearth-np.com/x',
        { method: 'GET', signal: ctrl.signal },
        fetchImpl,
        150000,
        'stage2',
      ),
    ).rejects.toThrow('stage2')
    await expect(
      fetchWithJar(
        createCookieJar(),
        'https://theearth-np.com/x',
        { method: 'GET', signal: ctrl.signal },
        fetchImpl,
        150000,
        'stage2',
      ),
    ).rejects.toThrow('150000ms')
  })
})

describe('fetchWithJar User-Agent (Refs ohishi-exp/nuxt-dtako-admin#224)', () => {
  it('sets a default User-Agent when the caller does not specify one', async () => {
    let sentHeaders: Headers | undefined
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sentHeaders = init?.headers as Headers
      return new Response('ok', { status: 200 })
    }) as unknown as FetchLike
    await fetchWithJar(createCookieJar(), 'https://theearth-np.com/x', { method: 'GET' }, fetchImpl)
    expect(sentHeaders?.get('user-agent')).toContain('Mozilla/5.0')
  })

  it('keeps the caller-specified User-Agent as-is', async () => {
    let sentHeaders: Headers | undefined
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sentHeaders = init?.headers as Headers
      return new Response('ok', { status: 200 })
    }) as unknown as FetchLike
    await fetchWithJar(
      createCookieJar(),
      'https://theearth-np.com/x',
      { method: 'GET', headers: { 'user-agent': 'custom-ua/1.0' } },
      fetchImpl,
    )
    expect(sentHeaders?.get('user-agent')).toBe('custom-ua/1.0')
  })
})

describe('extractHiddenFields', () => {
  it('extracts only the hidden fields present in the page and decodes entities', () => {
    const fields = extractHiddenFields(
      `<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="A&amp;B&lt;&gt;&quot;&#39;" />`,
    )
    expect(fields).toEqual({ __VIEWSTATE: `A&B<>"'` })
  })

  it('omits fields whose tag is absent from the page', () => {
    expect(extractHiddenFields('<html><body>no hidden fields here</body></html>')).toEqual({})
  })

  it('omits a field whose tag has no name attribute', () => {
    expect(extractHiddenFields('<input type="hidden" id="__VIEWSTATE" value="X" />')).toEqual({})
  })

  it('defaults to an empty string value when the value attribute is absent', () => {
    expect(extractHiddenFields('<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" />')).toEqual({
      __VIEWSTATE: '',
    })
  })
})

describe('serializeFormFields', () => {
  it('captures text/hidden input values as-is', () => {
    const html = `<input type="hidden" name="__VIEWSTATE" value="VS1" />
      <input type="text" name="txtSVehicle" value="100" />`
    expect(serializeFormFields(html)).toEqual({ __VIEWSTATE: 'VS1', txtSVehicle: '100' })
  })

  it('defaults an input with no explicit type attribute to text semantics', () => {
    expect(serializeFormFields('<input name="txtNoType" value="abc" />')).toEqual({ txtNoType: 'abc' })
  })

  it('defaults a text input with no value attribute to an empty string', () => {
    expect(serializeFormFields('<input type="text" name="txtEmpty" />')).toEqual({ txtEmpty: '' })
  })

  it('skips an input with no name attribute', () => {
    expect(serializeFormFields('<input type="text" value="noname" />')).toEqual({})
  })

  it('includes a checked checkbox with its value, and omits an unchecked one', () => {
    const html = `<input type="checkbox" name="chkOn" value="1" checked="checked" />
      <input type="checkbox" name="chkOff" value="1" />`
    expect(serializeFormFields(html)).toEqual({ chkOn: '1' })
  })

  it('defaults a checked checkbox/radio with no value attribute to "on"', () => {
    expect(serializeFormFields('<input type="checkbox" name="chkNoValue" checked />')).toEqual({ chkNoValue: 'on' })
  })

  it('includes only the checked radio from a same-name radio group', () => {
    const html = `<input type="radio" name="rdoGroup" value="a" />
      <input type="radio" name="rdoGroup" value="b" checked="checked" />`
    expect(serializeFormFields(html)).toEqual({ rdoGroup: 'b' })
  })

  it('excludes submit/button/image/reset/file inputs (pressed-submit only, added explicitly by callers)', () => {
    const html = `<input type="submit" name="btnGo" value="実行" />
      <input type="button" name="btnB" value="B" />
      <input type="image" name="btnI" value="I" />
      <input type="reset" name="btnR" value="R" />
      <input type="file" name="fileF" value="F" />`
    expect(serializeFormFields(html)).toEqual({})
  })

  it('captures the selected <option> value of a <select>', () => {
    const html = `<select name="ddlWithSelected">
      <option value="x">X</option>
      <option value="y" selected="selected">Y</option>
    </select>`
    expect(serializeFormFields(html)).toEqual({ ddlWithSelected: 'y' })
  })

  it('falls back to the first <option> when none is marked selected (HTML default)', () => {
    const html = `<select name="ddlNoSelected">
      <option value="first">First</option>
      <option value="second">Second</option>
    </select>`
    expect(serializeFormFields(html)).toEqual({ ddlNoSelected: 'first' })
  })

  it('yields an empty string for a <select> with no <option> elements', () => {
    expect(serializeFormFields('<select name="ddlEmpty"></select>')).toEqual({ ddlEmpty: '' })
  })

  it('skips a <select> with no name attribute', () => {
    expect(serializeFormFields('<select><option value="x">X</option></select>')).toEqual({})
  })

  it('defaults an <option> with no value attribute to an empty string', () => {
    expect(serializeFormFields('<select name="ddlNoValueAttr"><option selected="selected">No Value</option></select>')).toEqual({
      ddlNoValueAttr: '',
    })
  })

  it('decodes HTML entities in captured values', () => {
    const html = `<input type="text" name="txtAmp" value="A&amp;B" />
      <select name="ddlAmp"><option value="C&amp;D" selected="selected">CD</option></select>`
    expect(serializeFormFields(html)).toEqual({ txtAmp: 'A&B', ddlAmp: 'C&D' })
  })
})

describe('detectWareki', () => {
  it('defaults to wareki when no date pattern is found', () => {
    expect(detectWareki('<html><body>no dates</body></html>')).toBe(true)
  })

  it('detects western era dates', () => {
    expect(detectWareki(csvPageHtml({ tableDate: '26/07/01' }), new Date('2026-07-03T00:00:00Z'))).toBe(false)
  })

  it('detects wareki (reiwa) dates', () => {
    expect(detectWareki(csvPageHtml({ tableDate: '08/07/01' }), new Date('2026-07-03T00:00:00Z'))).toBe(true)
  })

  it('reads <span>-wrapped date cells (real theearth markup) and ignores stray earlier dates', () => {
    // 実データ (27324455) の日付セルは <td><span id="...">26/06/30</span></td>。表より前に
    // 別の日付 (15/11/15 — 旧 broad regex が誤検出して令和判定していたもの) があっても、
    // td の中身をタグ除去して最初の日付セルを見るので西暦(26)判定 (false) になる。
    const html =
      `<html><body><span>15/11/15</span><table><tr>` +
      `<td>車輌名</td>` + // 日付でない td を跨いで探す
      `<td><span id="lbl0" style="display:inline-block;width:80px;">26/06/30</span></td>` +
      `</tr></table></body></html>`
    expect(detectWareki(html, new Date('2026-07-03T00:00:00Z'))).toBe(false)
  })

  it('strips &nbsp; and inner tags inside a <td> before matching', () => {
    const html = `<html><body><table><tr><td>&nbsp;<b>08/07/01</b>&nbsp;</td></tr></table></body></html>`
    expect(detectWareki(html, new Date('2026-07-03T00:00:00Z'))).toBe(true) // 令和8年
  })

  it('defaults to wareki when a date appears only outside <td> cells', () => {
    // td セルに日付が無ければ (script 内だけ) デフォルトの和暦にフォールバックする。
    const html = `<html><head><script>var v='26/01/01';</script></head><body>no cell</body></html>`
    expect(detectWareki(html, new Date('2026-07-03T00:00:00Z'))).toBe(true)
  })
})

describe('splitJapaneseDate', () => {
  it('splits a western-era iso date', () => {
    expect(splitJapaneseDate('2026-07-03', false)).toEqual({ y: '26', m: '07', d: '03' })
  })

  it('splits a wareki iso date', () => {
    expect(splitJapaneseDate('2026-07-03', true)).toEqual({ y: '08', m: '07', d: '03' })
  })

  it('rejects a date with the wrong number of segments', () => {
    expect(() => splitJapaneseDate('2026/07/03', false)).toThrow(TheearthClientError)
  })

  it('rejects a date with a non-numeric year', () => {
    expect(() => splitJapaneseDate('abcd-07-03', false)).toThrow(TheearthClientError)
  })

  it('rejects a date with an empty month/day segment', () => {
    expect(() => splitJapaneseDate('2026--03', false)).toThrow(TheearthClientError)
  })
})

describe('assertZipMagic', () => {
  it('accepts a buffer starting with the ZIP magic bytes', () => {
    expect(() => assertZipMagic(ZIP_BYTES.buffer as ArrayBuffer)).not.toThrow()
  })

  it('rejects a too-short buffer', () => {
    expect(() => assertZipMagic(new Uint8Array([0x50, 0x4b]).buffer as ArrayBuffer)).toThrow(TheearthClientError)
  })

  it('rejects a buffer with the wrong magic bytes', () => {
    expect(() =>
      assertZipMagic(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]).buffer as ArrayBuffer),
    ).toThrow(TheearthClientError)
  })
})

describe('isEmptyZip / 空 ZIP の文言分離 (Refs #633-22)', () => {
  it('EOCD だけの 22 bytes を空 ZIP と判定する', () => {
    expect(isEmptyZip(emptyZipBytes().buffer as ArrayBuffer)).toBe(true)
  })

  it('実データ入り ZIP (PK\\x03\\x04) は空 ZIP ではない', () => {
    expect(isEmptyZip(ZIP_BYTES.buffer as ArrayBuffer)).toBe(false)
  })

  it('**22 bytes でも EOCD で始まらなければ空 ZIP ではない** (長さだけで決めない)', () => {
    const notEocd = new Uint8Array(EMPTY_ZIP_BYTE_LENGTH)
    notEocd.set([0x3c, 0x68, 0x74, 0x6d]) // "<htm"
    expect(isEmptyZip(notEocd.buffer as ArrayBuffer)).toBe(false)
  })

  it('**EOCD で始まっても 22 bytes でなければ空 ZIP ではない** (中身のある ZIP を握り潰さない)', () => {
    const longer = new Uint8Array(EMPTY_ZIP_BYTE_LENGTH + 1)
    longer.set([0x50, 0x4b, 0x05, 0x06])
    expect(isEmptyZip(longer.buffer as ArrayBuffer)).toBe(false)
  })

  it('空 ZIP は「データがありません」と言い、**確かめていない原因 (ログイン切れ / ページ仕様変更) を並べない**', () => {
    const err = (() => {
      try {
        assertZipMagic(emptyZipBytes().buffer as ArrayBuffer)
        return null
      } catch (e) {
        return e as Error
      }
    })()
    expect(err).toBeInstanceOf(TheearthClientError)
    expect(err!.message).toContain('空の ZIP')
    expect(err!.message).toContain('データがありません')
    expect(err!.message).toContain('22 bytes')
    // ここが本件の主題 — この 2 語が出ていたせいで無害な未来日プローブ 3 件が
    // 3 日間「原因不明の cron 故障」として引き継がれた。
    expect(err!.message).not.toContain('ログイン切れ')
    expect(err!.message).not.toContain('ページ仕様変更')
  })

  it('空 ZIP **以外**の非 ZIP は従来どおり候補を挙げる文言のまま (回帰させない)', () => {
    const err = (() => {
      try {
        assertZipMagic(new TextEncoder().encode('<html>error page</html>').buffer as ArrayBuffer)
        return null
      } catch (e) {
        return e as Error
      }
    })()
    expect(err!.message).toContain('ZIP ではありません')
    expect(err!.message).toContain('ログイン切れ')
    expect(err!.message).not.toContain('空の ZIP')
  })
})

describe('login', () => {
  const params = { compId: '27324455', userName: 'user1', userPass: 'pass1' }

  it('succeeds when the login POST redirects and the location is followed', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), redirect('/F-VOS0010.aspx'), html('<html>ok</html>')])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).resolves.toEqual({ kicked: false })
  })

  it('succeeds when the login POST redirects with no Location header', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), redirect(null)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).resolves.toEqual({ kicked: false })
  })

  it('succeeds when the login POST returns the logged-in page directly (no redirect)', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(LOGIN_SUCCESS_HTML)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).resolves.toEqual({ kicked: false })
  })

  it('throws a credential-failure message when the login page is re-rendered (200)', async () => {
    // 実ページはログインフォームに txtOverlapSessionID / btnForced を **value 無しの
    // hidden で常時** 含む — これを overlap プロンプトと誤認して強制ログインフローに
    // 入らないこと (value 非空の時だけ overlap 扱い) も同時に検証する (Refs #90)。
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(LOGIN_FAILURE_HTML)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).rejects.toThrow('ログイン画面に戻されました')
  })

  it('posts __VIEWSTATEENCRYPTED when the login page has it (viewstate MAC failure guard)', async () => {
    const bodies: string[] = []
    let call = 0
    const fetchImpl = (async (_url, init) => {
      call += 1
      if (call === 1) return html(LOGIN_PAGE_WITH_ENC_HTML)
      bodies.push(String(init?.body ?? ''))
      return redirect('/F-VOS0010.aspx')
    }) as FetchLike
    await login(createCookieJar(), params, fetchImpl)
    expect(bodies[0]).toContain('__VIEWSTATEENCRYPTED=')
    expect(bodies[0]).toContain('__EVENTVALIDATION=EV1')
  })

  it('throws with page diagnostics when the login POST returns a non-2xx status', async () => {
    const fetchImpl = sequenceFetch([
      html(LOGIN_PAGE_HTML),
      new Response(VIEWSTATE_MAC_ERROR_HTML, { status: 500, headers: { 'content-type': 'text/html' } }),
    ])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).rejects.toThrow(/HTTP 500.*ランタイム エラー.*viewstate MAC/s)
  })

  it('treats an unknown 200 page without the login form as success (restricted-account landing)', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(UNKNOWN_PAGE_HTML)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).resolves.toEqual({ kicked: false })
  })

  it('follows the forced-login flow on overlap session and succeeds via redirect', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(OVERLAP_SESSION_HTML), redirect('/F-VOS0010.aspx')])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).resolves.toEqual({ kicked: true })
  })

  it('includes credential + the server-issued txtOverlapSessionID value in the forced-login POST', async () => {
    // 実ブラウザのフォーム送信同様、強制ログイン POST は credential と overlap ID を
    // 全部含む必要がある (これを落とすとサーバに拒否される、Refs #90 実ページ検証済み)。
    const bodies: string[] = []
    let call = 0
    const fetchImpl = (async (_url, init) => {
      call += 1
      if (call === 1) return html(LOGIN_PAGE_HTML)
      if (call === 2) return html(OVERLAP_SESSION_HTML)
      bodies.push(String(init?.body ?? ''))
      return redirect('/F-VOS0010.aspx')
    }) as FetchLike
    await login(createCookieJar(), params, fetchImpl)
    const forced = new URLSearchParams(bodies[0])
    expect(forced.get('txtID2')).toBe(params.compId)
    expect(forced.get('txtID1')).toBe(params.userName)
    expect(forced.get('txtPass')).toBe(params.userPass)
    expect(forced.get('txtOverlapSessionID')).toBe('SID-abc123')
    // btnForced は含む / btnLogin・btnCancel は含まない (押下 submit のみ送る)
    expect(forced.has('ctl00$MainContent$btnForced')).toBe(true)
    expect(forced.has('btnLogin')).toBe(false)
    expect(forced.has('btnCancel')).toBe(false)
  })

  it('follows the forced-login flow on overlap session and succeeds via logged-in marker', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(OVERLAP_SESSION_HTML), html(LOGIN_SUCCESS_HTML)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).resolves.toEqual({ kicked: true })
  })

  it('forced-logs-in on an OverlapDialog() prompt even when txtOverlapSessionID is empty', async () => {
    // 単純重複 (OverlapDialog → 即 btnForced、txtOverlapSessionID は空) を強制ログインで
    // 処理できること。旧実装はこれを「ログイン失敗」と誤判定していた (dtako-scraper#22)。
    const bodies: string[] = []
    let call = 0
    const fetchImpl = (async (_url, init) => {
      call += 1
      if (call === 1) return html(LOGIN_PAGE_HTML)
      if (call === 2) return html(OVERLAP_DIALOG_HTML)
      bodies.push(String(init?.body ?? ''))
      return redirect('/F-VOS0010.aspx')
    }) as FetchLike
    await expect(login(createCookieJar(), params, fetchImpl)).resolves.toEqual({ kicked: true })
    const forced = new URLSearchParams(bodies[0])
    expect(forced.get('txtID2')).toBe(params.compId)
    expect(forced.get('txtPass')).toBe(params.userPass)
    expect(forced.has('ctl00$MainContent$btnForced')).toBe(true)
    expect(forced.get('txtOverlapSessionID')).toBe('') // 空でも送る
  })

  it('automatically kicks the first (oldest) session and forced-logs-in on a LicenceOverDialog() (定数オーバー) prompt', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(LICENCE_OVER_HTML), redirect('/F-VOS0010.aspx')])
    const jar = createCookieJar()
    // info2 の先頭 (= 最初にログインしたセッションのユーザー名) が kickedUserName に載る。
    await expect(login(jar, params, fetchImpl)).resolves.toEqual({ kicked: true, kickedUserName: 'userA' })
  })

  it('sends the first LicenceOverDialog() session ID (not the second) as txtOverlapSessionID', async () => {
    // info1 (session ID CSV) の先頭 = 最初にログインしたセッションを kick する
    // (cdp-pair 実機トレースで positional pairing を確認済み、2026-07-08)。
    const bodies: string[] = []
    let call = 0
    const fetchImpl = (async (_url, init) => {
      call += 1
      if (call === 1) return html(LOGIN_PAGE_HTML)
      if (call === 2) return html(LICENCE_OVER_HTML)
      bodies.push(String(init?.body ?? ''))
      return redirect('/F-VOS0010.aspx')
    }) as FetchLike
    await login(createCookieJar(), params, fetchImpl)
    const forced = new URLSearchParams(bodies[0])
    expect(forced.get('txtID2')).toBe(params.compId)
    expect(forced.get('txtPass')).toBe(params.userPass)
    expect(forced.get('txtOverlapSessionID')).toBe('sid-first')
    expect(forced.has('ctl00$MainContent$btnForced')).toBe(true)
  })

  it('throws a licence-over-specific message when the auto-kick forced login fails', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(LICENCE_OVER_HTML), html(LOGIN_FAILURE_HTML)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).rejects.toThrow('ライセンス数超過の強制ログインに失敗しました')
  })

  it('loud-fails with an actionable message when a LicenceOverDialog() prompt cannot be parsed', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(LICENCE_OVER_UNPARSEABLE_HTML)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).rejects.toThrow(/ライセンス数超過.*解析できず/s)
  })

  it('throws when the forced-login flow lands back on the login form', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(OVERLAP_SESSION_HTML), html(LOGIN_FAILURE_HTML)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).rejects.toThrow('強制ログインに失敗しました')
  })

  it('throws with page diagnostics when the forced-login POST returns a non-2xx status', async () => {
    const fetchImpl = sequenceFetch([
      html(LOGIN_PAGE_HTML),
      html(OVERLAP_SESSION_HTML),
      new Response('server exploded', { status: 500, headers: { 'content-type': 'text/html' } }),
    ])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).rejects.toThrow(/強制ログイン POST が HTTP 500.*no title/s)
  })

  it('treats an unknown 200 page after forced login as success', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(OVERLAP_SESSION_HTML), html(UNKNOWN_PAGE_HTML)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).resolves.toEqual({ kicked: true })
  })

  it('throws when an overlap session form is detected but btnForced is missing', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(OVERLAP_SESSION_NO_BUTTON_HTML)])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).rejects.toThrow('btnForced')
  })

  it('falls back to a default caption when btnForced has no value attribute', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_PAGE_HTML), html(OVERLAP_SESSION_NO_VALUE_HTML), redirect('/ok')])
    const jar = createCookieJar()
    await expect(login(jar, params, fetchImpl)).resolves.toEqual({ kicked: true })
  })

  it('sends the accumulated cookie jar on subsequent requests', async () => {
    // Response の Set-Cookie round-trip はテスト環境 (happy-dom 等) 依存の実装差が
    // あるため、jar を直接シードして Cookie ヘッダ送信側 (fetchWithJar) だけを
    // 検証する (Set-Cookie 受信側は ingestSetCookie の直接テストで別途カバー済み)。
    const jar = createCookieJar()
    jar.cookies.set('ASP.NET_SessionId', 'abc123')
    const seenCookieHeaders: Array<string | null> = []
    const fetchImpl = (async (_url, init) => {
      seenCookieHeaders.push(new Headers(init?.headers).get('cookie'))
      return seenCookieHeaders.length === 1 ? html(LOGIN_PAGE_HTML) : html(LOGIN_SUCCESS_HTML)
    }) as FetchLike
    await login(jar, params, fetchImpl)
    expect(seenCookieHeaders).toEqual(['ASP.NET_SessionId=abc123', 'ASP.NET_SessionId=abc123'])
  })
})

describe('downloadCsvZip', () => {
  const range = { startDate: '2026-07-01', endDate: '2026-07-02' }

  it('downloads via the 2-stage POST flow', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml()), html(STAGE1_CONFIRM_HTML), zipResponse()])
    const jar = createCookieJar()
    const buf = await downloadCsvZip(jar, range, fetchImpl)
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
  })

  it('re-sends the date range in the stage-2 (btnCsvSvrOutput) POST body', async () => {
    // 真因の回帰テスト: 2段階目に日付範囲を落とすと空 ZIP が返る。stage2 の body に
    // rdoSelect1/rdoDate1 + 開始/終了 年月日 が含まれることを固定する (ohishi-exp/dtako-scraper#22)。
    const bodies: string[] = []
    let call = 0
    const fetchImpl = (async (_url, init) => {
      call += 1
      if (call === 1) return html(csvPageHtml()) // GET
      bodies.push(String(init?.body ?? ''))
      if (call === 2) return html(STAGE1_CONFIRM_HTML) // stage1 POST
      return zipResponse() // stage2 POST
    }) as FetchLike
    await downloadCsvZip(createCookieJar(), range, fetchImpl)
    const stage2 = new URLSearchParams(bodies[1])
    expect(stage2.get('ctl00$MainContent$SelectM')).toBe('rdoSelect1')
    expect(stage2.get('ctl00$MainContent$SelectD')).toBe('rdoDate1')
    expect(stage2.get('ctl00$MainContent$ucStartDate$txtYear')).toBe('26')
    expect(stage2.get('ctl00$MainContent$ucStartDate$txtMonth')).toBe('07')
    expect(stage2.get('ctl00$MainContent$ucStartDate$txtDay')).toBe('01')
    expect(stage2.get('ctl00$MainContent$ucEndDate$txtDay')).toBe('02')
    expect(stage2.get('ctl00$MainContent$btnCsvSvrOutput')).toBe('ダウンロード')
  })

  it('downloads directly when stage 1 already returns the ZIP', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml()), zipResponse()])
    const jar = createCookieJar()
    const buf = await downloadCsvZip(jar, range, fetchImpl)
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
  })

  it('throws loudly when a required CSV form field is missing (page structure changed)', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml({ omit: 'btnCsvSvr' }))])
    const jar = createCookieJar()
    await expect(downloadCsvZip(jar, range, fetchImpl)).rejects.toThrow('btnCsvSvr')
  })

  it('does not claim the page structure changed, and attaches evidence, when a required CSV form field is missing (Refs #205-52)', async () => {
    // 確かめていない原因 (「ページ仕様が変更された」) を断定しない。代わりに
    // status/content-type/本文長/経過ms/ログインフォーム検出/本文抜粋を残す。
    const fetchImpl = sequenceFetch([html(csvPageHtml({ omit: 'btnCsvSvr' }))])
    const jar = createCookieJar()
    const err = await downloadCsvZip(jar, range, fetchImpl).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TheearthPageMismatchError)
    const mismatch = err as TheearthPageMismatchError
    expect(mismatch.message).not.toContain('ページ仕様が変更された')
    expect(mismatch.evidence.status).toBe(200)
    expect(mismatch.evidence.contentType).toContain('text/html')
    expect(mismatch.evidence.bodyLength).toBeGreaterThan(0)
    expect(mismatch.evidence.hasLoginForm).toBe(false)
    expect(mismatch.evidence.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('**原本の先頭を bodyPrefix に載せる** — evidence.page の 160 字要約では「どの既知パターンからどう外れたか」が読めない (Refs #633-22)', async () => {
    const page = csvPageHtml({ omit: 'btnCsvSvr' })
    const fetchImpl = sequenceFetch([html(page)])
    const jar = createCookieJar()
    const err = (await downloadCsvZip(jar, range, fetchImpl).catch((e: unknown) => e)) as TheearthPageMismatchError
    expect(err.bodyPrefix).toBe(page)
    // 要約 (evidence.page) とは別物。要約はタグ除去済み 160 字、こちらは生の HTML。
    expect(err.bodyPrefix).not.toBe(err.evidence.page)
  })

  it('bodyPrefix は EVIDENCE_BODY_PREFIX_MAX で切る (R2 に置くのは取っ掛かりで全文ではない)', async () => {
    const padded = csvPageHtml({ omit: 'btnCsvSvr' }) + '<!--' + 'x'.repeat(EVIDENCE_BODY_PREFIX_MAX) + '-->'
    const fetchImpl = sequenceFetch([html(padded)])
    const jar = createCookieJar()
    const err = (await downloadCsvZip(jar, range, fetchImpl).catch((e: unknown) => e)) as TheearthPageMismatchError
    expect(err.bodyPrefix.length).toBe(EVIDENCE_BODY_PREFIX_MAX)
    expect(err.bodyPrefix).toBe(padded.slice(0, EVIDENCE_BODY_PREFIX_MAX))
  })

  it('stage-2 ボタン欠落でも bodyPrefix に stage1 の原本が載る', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml()), html(STAGE1_CONFIRM_NO_OUTPUT_HTML)])
    const jar = createCookieJar()
    const err = (await downloadCsvZip(jar, range, fetchImpl).catch((e: unknown) => e)) as TheearthPageMismatchError
    expect(err.bodyPrefix).toBe(STAGE1_CONFIRM_NO_OUTPUT_HTML)
  })

  it('defaults evidence.contentType to empty when the GET response has no Content-Type header', async () => {
    const fetchImpl = sequenceFetch([htmlNoContentType(csvPageHtml({ omit: 'btnCsvSvr' }))])
    const jar = createCookieJar()
    const err = (await downloadCsvZip(jar, range, fetchImpl).catch((e: unknown) => e)) as TheearthPageMismatchError
    expect(err).toBeInstanceOf(TheearthPageMismatchError)
    expect(err.evidence.contentType).toBe('')
  })

  it('maps a login page on the initial GET to VenusSessionExpiredError (Refs #169)', async () => {
    // 真因の回帰テスト: セッション切れの GET 応答を「フォーム要素が見つからない」
    // generic error に潰さず、401 で再ログインを促せる形にする。
    const fetchImpl = sequenceFetch([html('<input id="txtPass" />')])
    const jar = createCookieJar()
    await expect(downloadCsvZip(jar, range, fetchImpl)).rejects.toThrow(VenusSessionExpiredError)
  })

  it('maps a login page on the stage-1 confirmation response to VenusSessionExpiredError (Refs #169)', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml()), html('<input id="txtPass" />')])
    const jar = createCookieJar()
    await expect(downloadCsvZip(jar, range, fetchImpl)).rejects.toThrow(VenusSessionExpiredError)
  })

  it('throws loudly when the stage-2 output button is missing', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml()), html(STAGE1_CONFIRM_NO_OUTPUT_HTML)])
    const jar = createCookieJar()
    await expect(downloadCsvZip(jar, range, fetchImpl)).rejects.toThrow(TheearthClientError)
  })

  it('does not claim the page structure changed, and attaches evidence, when the stage-2 output button is missing (Refs #205-52)', async () => {
    // これが本件の主題の文言 (「2段階目ボタンが見つかりません」)。ここに来るには
    // stage1Html を最後まで読めていて (timeout でも abort でもない) ログイン
    // フォームでもない — evidence がそれを裏付ける。
    const fetchImpl = sequenceFetch([html(csvPageHtml()), html(STAGE1_CONFIRM_NO_OUTPUT_HTML)])
    const jar = createCookieJar()
    const err = await downloadCsvZip(jar, range, fetchImpl).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TheearthPageMismatchError)
    const mismatch = err as TheearthPageMismatchError
    expect(mismatch.message).not.toContain('ページ仕様が変更された')
    expect(mismatch.message).toContain('2段階目ボタン')
    expect(mismatch.evidence.status).toBe(200)
    expect(mismatch.evidence.hasLoginForm).toBe(false)
    expect(mismatch.evidence.bodyLength).toBe(STAGE1_CONFIRM_NO_OUTPUT_HTML.length)
  })

  it('throws a TheearthNotZipError carrying the raw response bytes when stage-2 is not a ZIP', async () => {
    // 「でもダウンロードさせろ」対応: ZIP でなくても生バイト + content-type を error に載せ、
    // DO 側で保存 → ダウンロードできるようにする。
    const bodyBytes = new TextEncoder().encode('<html>not a zip</html>')
    const fetchImpl = sequenceFetch([
      html(csvPageHtml()),
      html(STAGE1_CONFIRM_HTML),
      new Response(bodyBytes, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    ])
    const jar = createCookieJar()
    const err = await downloadCsvZip(jar, range, fetchImpl).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TheearthNotZipError)
    const notZip = err as TheearthNotZipError
    expect(notZip).toBeInstanceOf(TheearthClientError) // サブクラスなので従来の catch でも捕まる
    expect(notZip.contentType).toBe('text/html; charset=utf-8')
    expect(new Uint8Array(notZip.responseBytes)).toEqual(new Uint8Array(bodyBytes))
    expect(notZip.message).toContain('ZIP ではありません')
  })

  it('throws TheearthNotZipError when stage-1 directly returns non-ZIP octet-stream', async () => {
    const fetchImpl = sequenceFetch([
      html(csvPageHtml()),
      new Response(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ])
    const jar = createCookieJar()
    await expect(downloadCsvZip(jar, range, fetchImpl)).rejects.toThrow(TheearthNotZipError)
  })

  it('defaults contentType to empty when the stage-2 response has no Content-Type header', async () => {
    const fetchImpl = sequenceFetch([
      html(csvPageHtml()),
      html(STAGE1_CONFIRM_HTML),
      new Response(new TextEncoder().encode('<html>x</html>'), { status: 200 }), // no content-type
    ])
    const jar = createCookieJar()
    const err = (await downloadCsvZip(jar, range, fetchImpl).catch((e: unknown) => e)) as TheearthNotZipError
    expect(err).toBeInstanceOf(TheearthNotZipError)
    expect(err.contentType).toBe('')
  })

  it('treats a stage-1 response with no Content-Type header as an HTML confirmation page', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml()), htmlNoContentType(STAGE1_CONFIRM_HTML), zipResponse()])
    const jar = createCookieJar()
    const buf = await downloadCsvZip(jar, range, fetchImpl)
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
  })

  it('falls back to a default caption when the stage-2 output button has no value attribute', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml()), html(STAGE1_CONFIRM_NO_VALUE_HTML), zipResponse()])
    const jar = createCookieJar()
    const buf = await downloadCsvZip(jar, range, fetchImpl)
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
  })
})

describe('downloadCsvZip phase timing (Refs #205-52)', () => {
  const range = { startDate: '2026-07-01', endDate: '2026-07-02' }

  it('records ms for csv_get and stage1 and stage2 on success', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml()), html(STAGE1_CONFIRM_HTML), zipResponse()])
    const timer = new PhaseTimer()
    await downloadCsvZip(createCookieJar(), range, fetchImpl, {}, timer)
    const names = timer.report().phases.map((p) => p.name)
    expect(names).toEqual(['csv_get', 'stage1', 'stage2'])
    for (const p of timer.report().phases) expect(p.ms).toBeGreaterThanOrEqual(0)
  })

  it('still records the failing stage ms when the stage-2 button is missing (timeout-or-not is readable from the failure log alone)', async () => {
    const fetchImpl = sequenceFetch([html(csvPageHtml()), html(STAGE1_CONFIRM_NO_OUTPUT_HTML)])
    const timer = new PhaseTimer()
    await downloadCsvZip(createCookieJar(), range, fetchImpl, {}, timer).catch(() => {})
    // stage2 には到達していないので csv_get/stage1 の 2 段だけ載る。timeout なら
    // 該当段の ms が DEFAULT_REQUEST_TIMEOUT_MS 近辺に張り付くはずだが、ここは
    // フェイクの即時応答なので timeout ではないことが ms からも読める。
    const names = timer.report().phases.map((p) => p.name)
    expect(names).toEqual(['csv_get', 'stage1'])
  })
})

describe('scrapeViaHttp', () => {
  it('runs login then download and reports progress in order', async () => {
    const fetchImpl = sequenceFetch([
      html(LOGIN_PAGE_HTML),
      html(LOGIN_SUCCESS_HTML),
      html(csvPageHtml()),
      html(STAGE1_CONFIRM_HTML),
      zipResponse(),
    ])
    const steps: string[] = []
    const buf = await scrapeViaHttp(
      {
        compId: '27324455',
        userName: 'user1',
        userPass: 'pass1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
      },
      (step) => steps.push(step),
      fetchImpl,
    )
    expect(steps).toEqual(['login', 'download', 'done'])
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
  })

  it('records login/csv_get/stage1/stage2 phase timing when a timer is passed (Refs #205-52)', async () => {
    const fetchImpl = sequenceFetch([
      html(LOGIN_PAGE_HTML),
      html(LOGIN_SUCCESS_HTML),
      html(csvPageHtml()),
      html(STAGE1_CONFIRM_HTML),
      zipResponse(),
    ])
    const timer = new PhaseTimer()
    await scrapeViaHttp(
      {
        compId: '27324455',
        userName: 'user1',
        userPass: 'pass1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
      },
      () => {},
      fetchImpl,
      {},
      timer,
    )
    const names = timer.report().phases.map((p) => p.name)
    expect(names).toEqual(['login', 'csv_get', 'stage1', 'stage2'])
  })
})
