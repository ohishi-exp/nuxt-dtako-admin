import { describe, expect, it } from 'vitest'
import { createCookieJar, type FetchLike } from '../src/theearth-client'
import {
  decodeHtml,
  detectAccountType,
  downloadMeisaiCsv,
  ETC_FUNC_CSV_OUTPUT,
  ETC_FUNC_LOGIN,
  ETC_FUNC_SEARCH,
  EtcMeisaiClientError,
  EtcMeisaiNoUsageError,
  EtcMeisaiNotCsvError,
  etcLogin,
  findFormWithField,
  navigateToSearchPage,
  parseCsvFilename,
  parseForms,
  parseJsSubmitArgs,
  parseLinks,
  pickMainForm,
  scrapeEtcCsv,
  scrapeEtcFromCookies,
  sniffCharset,
  submitSearch,
  withNextfunc,
  type EtcPage,
  type EtcSession,
} from '../src/etc-meisai-client'

// ---------------------------------------------------------------------------
// fetch モック (呼び出しを記録しつつ順に Response を返す)
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string
  init: RequestInit
}

function recordingFetch(responses: Response[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let i = 0
  const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const res = responses[i]
    i += 1
    if (!res) throw new Error(`unexpected extra fetch call (#${i}): ${String(url)}`)
    return res
  }) as FetchLike
  return { fetch, calls }
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function redirect(location: string | null): Response {
  const headers = new Headers()
  if (location) headers.set('location', location)
  return new Response(null, { status: 302, headers })
}

function csvResponse(body = 'date,ic,amount\r\n2026/07/01,foo,100\r\n', filename = 'meisai_202607.csv'): Response {
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  })
}

function bodyParams(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body))
}

// ---------------------------------------------------------------------------
// fixtures (issue ohishi-exp/browser-render-rust#14 の実機トレースを模す)
// ---------------------------------------------------------------------------

const TOP_HTML = `<html><body>
  <a href="/etc/R?funccode=${ETC_FUNC_LOGIN}&amp;nextfunc=${ETC_FUNC_LOGIN}">ログイン</a>
</body></html>`

const LOGIN_PAGE_HTML = `<html><body>
<form action="/etc/R?funccode=${ETC_FUNC_LOGIN}" method="post">
  <input type="hidden" name="p" value="abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL" />
  <input type="text" name="risLoginId" value="" />
  <input type="password" name="risPassword" value="" />
  <input type="button" name="loginBtn" value="ログイン" />
</form>
</body></html>`

const MENU_HTML = `<html><body>
<a href="javascript:submitPage('${ETC_FUNC_SEARCH}','${ETC_FUNC_SEARCH}');"><span>検索条件</span>の指定</a>
<form action="/etc/R" method="post">
  <input type="hidden" name="funccode" value="${ETC_FUNC_LOGIN}" />
  <input type="hidden" name="nextfunc" value="" />
  <input type="hidden" name="p" value="MENUHIDDEN" />
</form>
</body></html>`

const SEARCH_PAGE_HTML = `<html><body>
<form action="/etc/R" method="post">
  <input type="hidden" name="funccode" value="${ETC_FUNC_SEARCH}" />
  <input type="hidden" name="nextfunc" value="" />
  <input type="hidden" name="p" value="SEARCHHIDDEN" />
  <input type="radio" name="sokoKbn" value="1" checked />
  <input type="radio" name="sokoKbn" value="0" />
  <input type="checkbox" name="riyouMonth1" value="202606" />
  <input type="checkbox" name="riyouMonth2" value="202607" checked />
  <input type="checkbox" name="cardAll" />
  <select name="hyoujiKensu"><option value="20">20</option><option value="100" selected>100</option></select>
</form>
</body></html>`

const RESULT_PAGE_HTML = `<html><body>
<form action="/etc/R" method="post">
  <input type="hidden" name="funccode" value="${ETC_FUNC_SEARCH}" />
  <input type="hidden" name="nextfunc" value="" />
  <input type="hidden" name="p" value="RESULTHIDDEN" />
</form>
<table><tr><td>2026/07/01</td></tr></table>
</body></html>`

const NO_USAGE_HTML = `<html><body>
<form action="/etc/R"><input type="hidden" name="funccode" value="x" /></form>
<span class="meisaicaption">当該月のご利用はありません</span>
</body></html>`

// アカウントによってはログイン直後/検索を経ずに既に利用明細の結果ページへ
// 着地し、CSV 出力ボタンが直接存在する (ohishi-exp/nuxt-dtako-admin#134 実機調査)。
const DIRECT_RESULT_HTML = `<html><body>
<h2>利用明細</h2>
<form action="/etc/R" method="post">
  <input type="hidden" name="p" value="DIRECTHIDDEN" />
</form>
<input type="submit" onclick="goOutput(false, 'hakkoMeisai', 'frm', '/etc/R?x=novalue', '_blank'); return false;" />
<input type="submit" value="CSVボタン（onclick無し）" />
<input type="submit" value="CSV (target無し)" onclick="somethingElse(); return false;" />
<input type="submit" value="証明書ＰＤＦ" onclick="goOutput(false, 'hakkoMeisai', 'frm', '/etc/R?funccode=1013000000&nextfunc=1013600000', '_blank'); return false;" />
<input type="submit" value="利用明細ＣＳＶ出力" onclick="goOutput(false, 'hakkoMeisai', 'frm', '/etc/R?funccode=1013000000&nextfunc=1013500000', '_blank'); return false;" />
</body></html>`

// 検索 POST 直後に挟まる「共通 -確認してください-」等の中間確認ページ
// (メイン form が hidden の p 1つだけ、onclick="submitPage('frm','<url>')" の
// 遷移ボタンを持つ)。
const CONFIRM_PAGE_HTML = `<html><body>
<h2>共通&nbsp;-確認してください-</h2>
<form action="/etc/R" method="post">
  <input type="hidden" name="p" value="CONFIRMHIDDEN" />
</form>
<input type="button" value="利用明細検索へ" onclick="submitPage('frm','/etc/R?funccode=1013000000&nextfunc=1032000000'); return false;" />
</body></html>`

const LOGIN_URL = `https://www.etc-meisai.jp/etc/R?funccode=${ETC_FUNC_LOGIN}&nextfunc=${ETC_FUNC_LOGIN}`

function page(url: string, htmlBody: string): EtcPage {
  return { url, html: htmlBody }
}

function session(url: string, htmlBody: string): EtcSession {
  return { page: page(url, htmlBody), accountType: 'personal' }
}

// ---------------------------------------------------------------------------
// charset sniff / デコード
// ---------------------------------------------------------------------------

describe('sniffCharset / decodeHtml', () => {
  it('content-type ヘッダの charset を最優先する', () => {
    expect(sniffCharset('text/html; charset=UTF-8', new Uint8Array())).toBe('utf-8')
  })

  it('ヘッダに無ければ meta タグから拾う', () => {
    const bytes = new TextEncoder().encode('<html><head><meta charset="euc-jp"></head></html>')
    expect(sniffCharset('text/html', bytes)).toBe('euc-jp')
  })

  it('どちらにも無ければ shift_jis (etc-meisai の既定)', () => {
    expect(sniffCharset(null, new TextEncoder().encode('<html></html>'))).toBe('shift_jis')
  })

  it('Shift_JIS の実バイト列をデコードできる', () => {
    // "テスト" の Shift_JIS bytes
    const sjis = new Uint8Array([0x83, 0x65, 0x83, 0x58, 0x83, 0x67])
    expect(decodeHtml(sjis.buffer as ArrayBuffer, 'text/html; charset=Shift_JIS')).toBe('テスト')
  })

  it('未知の charset ラベルは UTF-8 フォールバックで読む', () => {
    const bytes = new TextEncoder().encode('hello')
    expect(decodeHtml(bytes.buffer as ArrayBuffer, 'text/html; charset=x-unknown-charset')).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// form / link パース
// ---------------------------------------------------------------------------

describe('parseForms', () => {
  it('hidden / text / checked radio / checked checkbox / select を fields に載せる', () => {
    const forms = parseForms(SEARCH_PAGE_HTML)
    expect(forms).toHaveLength(1)
    const f = forms[0]
    expect(f.action).toBe('/etc/R')
    expect(f.fields.get('p')).toBe('SEARCHHIDDEN')
    expect(f.fields.get('sokoKbn')).toBe('1') // checked radio (初期値 = ETC無線走行のみ)
    expect(f.fields.get('riyouMonth2')).toBe('202607') // checked checkbox
    expect(f.fields.has('riyouMonth1')).toBe(false) // unchecked checkbox は送らない
    expect(f.fields.get('hyoujiKensu')).toBe('100') // selected option
    // 全 checkbox は「全選択」用に収集される (value 無しは "on")
    expect(f.checkboxes).toEqual([
      { name: 'riyouMonth1', value: '202606' },
      { name: 'riyouMonth2', value: '202607' },
      { name: 'cardAll', value: 'on' },
    ])
  })

  it('action 無し form / name 無し input / submit 系 input / name 無し select を無視する', () => {
    const forms = parseForms(`<form>
      <input type="hidden" value="noname" />
      <input type="submit" name="btn" value="送信" />
      <input type="hidden" name="ok" value="a&amp;b&quot;&#39;&lt;&gt;" />
      <select><option value="x">x</option></select>
      <select name="empty"></select>
      <select name="noselect"><option value="first">1</option><option value="second">2</option></select>
    </form>`)
    expect(forms[0].action).toBe('')
    expect(forms[0].fields.get('ok')).toBe('a&b"\'<>')
    expect(forms[0].fields.has('btn')).toBe(false)
    expect(forms[0].fields.get('empty')).toBe('')
    expect(forms[0].fields.get('noselect')).toBe('first')
    expect(forms[0].fields.size).toBe(3)
  })

  it('value 属性の無い hidden は空文字になる', () => {
    const forms = parseForms('<form action="/a"><input type="hidden" name="novalue" /></form>')
    expect(forms[0].fields.get('novalue')).toBe('')
  })

  it('type 属性の無い input は text 扱い、value 無し option は空文字', () => {
    const forms = parseForms(`<form action="/a">
      <input name="plain" value="v" />
      <select name="sel"><option>ラベルのみ</option></select>
    </form>`)
    expect(forms[0].fields.get('plain')).toBe('v')
    expect(forms[0].fields.get('sel')).toBe('')
  })
})

describe('findFormWithField / pickMainForm', () => {
  it('指定 field を持つ form を返し、無ければ null', () => {
    const forms = parseForms(SEARCH_PAGE_HTML)
    expect(findFormWithField(forms, 'sokoKbn')).not.toBeNull()
    expect(findFormWithField(forms, 'missing')).toBeNull()
  })

  it('pickMainForm は nextfunc / funccode を持つ form を優先する', () => {
    const forms = parseForms(`
      <form action="/other"><input type="hidden" name="x" value="1" /></form>
      <form action="/router"><input type="hidden" name="funccode" value="123" /></form>
    `)
    expect(pickMainForm(forms)?.action).toBe('/router')
  })

  it('pickMainForm は該当が無ければ先頭 form、form 自体が無ければ null', () => {
    const forms = parseForms('<form action="/only"><input type="hidden" name="x" value="1" /></form>')
    expect(pickMainForm(forms)?.action).toBe('/only')
    expect(pickMainForm([])).toBeNull()
  })
})

describe('parseLinks / parseJsSubmitArgs', () => {
  it('リンクの href とタグ除去済みテキストを抽出する', () => {
    const links = parseLinks(MENU_HTML)
    expect(links[0].text).toBe('検索条件の指定')
    // 属性値内のシングルクォート (submitPage の引数) で切れないこと
    expect(links[0].href).toBe(`javascript:submitPage('${ETC_FUNC_SEARCH}','${ETC_FUNC_SEARCH}');`)
  })

  it("シングルクォート属性の href も読める", () => {
    const links = parseLinks(`<a href='javascript:submitPage("1")'>x</a>`)
    expect(links[0].href).toBe('javascript:submitPage("1")')
  })

  it('javascript: 以外の href は null', () => {
    expect(parseJsSubmitArgs('/etc/R?funccode=1')).toBeNull()
  })

  it("submitPage('a','b') の引数を抽出する (single / double quote)", () => {
    expect(parseJsSubmitArgs("javascript:submitPage('1032000000','1032500000');")).toEqual([
      '1032000000',
      '1032500000',
    ])
    expect(parseJsSubmitArgs('javascript:submitPage("only")')).toEqual(['only'])
    expect(parseJsSubmitArgs('javascript:submitPage()')).toEqual([])
  })
})

describe('withNextfunc / parseCsvFilename / detectAccountType', () => {
  it('action query の nextfunc を強制セットする', () => {
    expect(withNextfunc('https://x/etc/R?funccode=1&nextfunc=old', '9')).toBe(
      'https://x/etc/R?funccode=1&nextfunc=9',
    )
    expect(withNextfunc('https://x/etc/R', '9')).toBe('https://x/etc/R?nextfunc=9')
  })

  it('content-disposition から filename を抜く (無ければ meisai.csv)', () => {
    expect(parseCsvFilename('attachment; filename="meisai_202607.csv"')).toBe('meisai_202607.csv')
    expect(parseCsvFilename('attachment')).toBe('meisai.csv')
    expect(parseCsvFilename(null)).toBe('meisai.csv')
  })

  it('URL からアカウント種別を判定する (issue #14: user / corp path)', () => {
    expect(detectAccountType('https://www.etc-meisai.jp/etc_corp_meisai/top')).toBe('corporate')
    expect(detectAccountType('https://www.etc-meisai.jp/etc_user_meisai/top')).toBe('personal')
    expect(detectAccountType('https://www.etc-meisai.jp/somewhere')).toBe('personal')
  })
})

// ---------------------------------------------------------------------------
// ログイン
// ---------------------------------------------------------------------------

describe('etcLogin', () => {
  const params = { userId: 'user1', password: 'pass1' }

  it('トップ → ログインページ → POST → redirect 追跡でログインする', async () => {
    const { fetch, calls } = recordingFetch([
      html(TOP_HTML),
      html(LOGIN_PAGE_HTML),
      redirect('/etc_user_meisai/menu'),
      html(MENU_HTML),
    ])
    const jar = createCookieJar()
    const session = await etcLogin(jar, params, fetch, 1000)
    expect(session.accountType).toBe('personal')
    expect(session.page.url).toBe('https://www.etc-meisai.jp/etc_user_meisai/menu')

    // ログイン POST: action query に nextfunc、body に credential + hidden p
    const loginPost = calls[2]
    expect(loginPost.url).toBe(
      `https://www.etc-meisai.jp/etc/R?funccode=${ETC_FUNC_LOGIN}&nextfunc=${ETC_FUNC_LOGIN}`,
    )
    const body = bodyParams(loginPost.init)
    expect(body.get('risLoginId')).toBe('user1')
    expect(body.get('risPassword')).toBe('pass1')
    expect(body.get('p')).toBe('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL')
  })

  it('location 無し 3xx は追跡を打ち切り !ok で loud fail する', async () => {
    const { fetch } = recordingFetch([
      html(TOP_HTML),
      html(LOGIN_PAGE_HTML),
      redirect(null), // location 無し 3xx は追跡を打ち切り !ok で throw
    ])
    await expect(etcLogin(createCookieJar(), params, fetch, 1000)).rejects.toThrow('HTTP 302')
  })

  it('ログインリンクが無ければ loud fail する', async () => {
    const { fetch } = recordingFetch([html('<html><body>MAINTENANCE</body></html>')])
    await expect(etcLogin(createCookieJar(), params, fetch, 1000)).rejects.toThrow(
      'ログインリンク (funccode=1013000000) が見つかりません',
    )
  })

  it('ログインフォーム (risLoginId) が無ければ loud fail する', async () => {
    const { fetch } = recordingFetch([html(TOP_HTML), html('<html><body>no form</body></html>')])
    await expect(etcLogin(createCookieJar(), params, fetch, 1000)).rejects.toThrow(
      'ログインフォーム (risLoginId) が見つかりません',
    )
  })

  it('ログイン後もログインフォームが出る場合は認証失敗として loud fail する', async () => {
    const { fetch } = recordingFetch([
      html(TOP_HTML),
      html(LOGIN_PAGE_HTML),
      html(LOGIN_PAGE_HTML), // 200 でログインページ再表示 = 失敗
    ])
    await expect(etcLogin(createCookieJar(), params, fetch, 1000)).rejects.toThrow(
      'ログインに失敗しました',
    )
  })

  it('法人アカウント (/etc_corp_meisai/) を判定する', async () => {
    const { fetch } = recordingFetch([
      html(TOP_HTML),
      html(LOGIN_PAGE_HTML),
      redirect('/etc_corp_meisai/top'),
      html(MENU_HTML),
    ])
    const session = await etcLogin(createCookieJar(), params, fetch, 1000)
    expect(session.accountType).toBe('corporate')
  })

  it('redirect が REDIRECT_LIMIT を超えたら最後の 3xx で loud fail する', async () => {
    const { fetch } = recordingFetch([
      redirect('/1'),
      redirect('/2'),
      redirect('/3'),
      redirect('/4'),
      redirect('/5'),
      redirect('/6'),
    ])
    await expect(etcLogin(createCookieJar(), params, fetch, 1000)).rejects.toThrow('HTTP 302')
  })

  it('fetch が timeout で abort されたら分かるメッセージに翻訳する', async () => {
    const slowFetch = (async () => {
      await new Promise((r) => setTimeout(r, 50))
      throw new Error('aborted by signal')
    }) as FetchLike
    await expect(etcLogin(createCookieJar(), params, slowFetch, 1)).rejects.toThrow(
      'タイムアウトしました',
    )
  })

  it('timeout 以外の fetch エラーはそのまま伝播する (timeout 無効 = signal 無し)', async () => {
    const failFetch = (async () => {
      throw new Error('network down')
    }) as FetchLike
    await expect(etcLogin(createCookieJar(), params, failFetch, 0)).rejects.toThrow('network down')
  })

  it('timeout 有効でも abort 前の fetch エラーはそのまま伝播する', async () => {
    const failFetch = (async () => {
      throw new Error('connection refused')
    }) as FetchLike
    await expect(etcLogin(createCookieJar(), params, failFetch, 10_000)).rejects.toThrow(
      'connection refused',
    )
  })
})

// ---------------------------------------------------------------------------
// 検索条件ページ遷移
// ---------------------------------------------------------------------------

describe('navigateToSearchPage', () => {
  it('現在ページに sokoKbn form があればそのまま返す', async () => {
    const { fetch, calls } = recordingFetch([])
    const s = session('https://www.etc-meisai.jp/etc_user_meisai/top', SEARCH_PAGE_HTML)
    const result = await navigateToSearchPage(createCookieJar(), s, fetch, 1000)
    expect(result.html).toBe(SEARCH_PAGE_HTML)
    expect(calls).toHaveLength(0)
  })

  it('JS ラッパーリンク (submitPage) をメイン form の POST で再現する', async () => {
    const { fetch, calls } = recordingFetch([html(SEARCH_PAGE_HTML)])
    const s = session('https://www.etc-meisai.jp/etc_user_meisai/menu', MENU_HTML)
    const result = await navigateToSearchPage(createCookieJar(), s, fetch, 1000)
    expect(findFormWithField(parseForms(result.html), 'sokoKbn')).not.toBeNull()

    const post = calls[0]
    expect(post.url).toBe(`https://www.etc-meisai.jp/etc/R?nextfunc=${ETC_FUNC_SEARCH}`)
    const body = bodyParams(post.init)
    expect(body.get('funccode')).toBe(ETC_FUNC_SEARCH) // submitPage 第1引数で override
    expect(body.get('nextfunc')).toBe(ETC_FUNC_SEARCH)
    expect(body.get('p')).toBe('MENUHIDDEN')
  })

  it('プレーン href リンクは GET で辿る', async () => {
    const menu = `<html><body><a href="/etc/R?nextfunc=${ETC_FUNC_SEARCH}">利用明細検索</a></body></html>`
    const { fetch, calls } = recordingFetch([html(SEARCH_PAGE_HTML)])
    const s = session('https://www.etc-meisai.jp/etc_user_meisai/menu', menu)
    await navigateToSearchPage(createCookieJar(), s, fetch, 1000)
    expect(calls[0].url).toBe(`https://www.etc-meisai.jp/etc/R?nextfunc=${ETC_FUNC_SEARCH}`)
    expect(calls[0].init.method).toBe('GET')
  })

  it('検索条件リンクが無ければ loud fail する', async () => {
    const s = session('https://x/menu', '<html><body>リンクなし</body></html>')
    await expect(navigateToSearchPage(createCookieJar(), s, recordingFetch([]).fetch, 1000)).rejects.toThrow(
      '「検索条件の指定」リンクが見つかりません',
    )
  })

  it('JS リンクだが遷移用 form が無ければ loud fail する', async () => {
    const s = session('https://x/menu', `<html><body><a href="javascript:submitPage('1')">検索条件</a></body></html>`)
    await expect(navigateToSearchPage(createCookieJar(), s, recordingFetch([]).fetch, 1000)).rejects.toThrow(
      '遷移用 form が見つかりません',
    )
  })

  it('引数無し submitPage() は nextfunc 無しで form を素 POST する', async () => {
    const menu = `<html><body>
      <a href="javascript:submitPage()">検索条件</a>
      <form action="/etc/R"><input type="hidden" name="funccode" value="1" /></form>
    </body></html>`
    const { fetch, calls } = recordingFetch([html(SEARCH_PAGE_HTML)])
    const s = session('https://www.etc-meisai.jp/menu', menu)
    await navigateToSearchPage(createCookieJar(), s, fetch, 1000)
    expect(calls[0].url).toBe('https://www.etc-meisai.jp/etc/R')
  })

  it('遷移先に sokoKbn form が無ければ loud fail する', async () => {
    const { fetch } = recordingFetch([html('<html><body>検索条件フォームなし</body></html>')])
    const s = session('https://www.etc-meisai.jp/menu', MENU_HTML)
    await expect(navigateToSearchPage(createCookieJar(), s, fetch, 1000)).rejects.toThrow(
      '検索条件フォーム (sokoKbn) が見つかりません',
    )
  })

  it('sokoKbn が無くても既に CSV 出力可能な結果ページ (#134) ならそのまま返す', async () => {
    const { fetch, calls } = recordingFetch([])
    const s = session('https://www2.etc-meisai.jp/etc/R?funccode=1013000000&nextfunc=1013000000', DIRECT_RESULT_HTML)
    const result = await navigateToSearchPage(createCookieJar(), s, fetch, 1000)
    expect(result.html).toBe(DIRECT_RESULT_HTML)
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 検索 → CSV
// ---------------------------------------------------------------------------

describe('submitSearch', () => {
  const searchPage = page('https://www.etc-meisai.jp/etc/R', SEARCH_PAGE_HTML)

  it('sokoKbn=0 (全て) + 利用月以外の全 checkbox 選択で検索 POST する (issue #14 の最重要 gotcha)', async () => {
    const { fetch, calls } = recordingFetch([html(RESULT_PAGE_HTML)])
    const result = await submitSearch(createCookieJar(), searchPage, fetch, 1000)
    expect(result.html).toBe(RESULT_PAGE_HTML)

    const post = calls[0]
    expect(post.url).toBe(`https://www.etc-meisai.jp/etc/R?nextfunc=${ETC_FUNC_SEARCH}`)
    const body = bodyParams(post.init)
    expect(body.get('sokoKbn')).toBe('0') // 初期値 1 を明示 override
    // riyouMonth (利用月) はページ既定のチェック状態を維持する (全選択の対象外)。
    // riyouMonth1 はページ既定で未チェックなので送られない (= 全月選択の回帰防止)。
    expect(body.has('riyouMonth1')).toBe(false)
    expect(body.get('riyouMonth2')).toBe('202607') // ページ既定でチェック済みの月のみ
    expect(body.get('cardAll')).toBe('on') // カード選択等は従来通り全選択
    expect(body.get('nextfunc')).toBe(ETC_FUNC_SEARCH)
  })

  it('sokoKbn form が無ければ loud fail する', async () => {
    const p = page('https://x/', '<html><body></body></html>')
    await expect(submitSearch(createCookieJar(), p, recordingFetch([]).fetch, 1000)).rejects.toThrow(
      '検索条件フォーム (sokoKbn) が見つかりません',
    )
  })

  it('jar に溜まった cookie を後続 POST に載せる', async () => {
    const { fetch, calls } = recordingFetch([html(RESULT_PAGE_HTML)])
    const jar = createCookieJar()
    jar.cookies.set('JSESSIONID', 'abc123')
    await submitSearch(jar, searchPage, fetch, 1000)
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('cookie')).toBe('JSESSIONID=abc123')
  })

  it('action 属性の無い form は現在ページ URL に POST する', async () => {
    const noAction = `<html><body><form>
      <input type="radio" name="sokoKbn" value="1" checked />
    </form></body></html>`
    const { fetch, calls } = recordingFetch([html(RESULT_PAGE_HTML)])
    await submitSearch(createCookieJar(), page('https://www.etc-meisai.jp/etc/R?funccode=1', noAction), fetch, 1000)
    expect(calls[0].url).toBe(`https://www.etc-meisai.jp/etc/R?funccode=1&nextfunc=${ETC_FUNC_SEARCH}`)
  })

  it('「当該月のご利用はありません」は EtcMeisaiNoUsageError', async () => {
    const { fetch } = recordingFetch([html(NO_USAGE_HTML)])
    await expect(submitSearch(createCookieJar(), searchPage, fetch, 1000)).rejects.toBeInstanceOf(
      EtcMeisaiNoUsageError,
    )
  })

  it('sokoKbn が無くても既に CSV 出力可能な結果ページ (#134) ならそのまま返し POST しない', async () => {
    const { fetch, calls } = recordingFetch([])
    const p = page('https://www2.etc-meisai.jp/etc/R?funccode=1013000000&nextfunc=1013000000', DIRECT_RESULT_HTML)
    const result = await submitSearch(createCookieJar(), p, fetch, 1000)
    expect(result.html).toBe(DIRECT_RESULT_HTML)
    expect(calls).toHaveLength(0)
  })

  it('検索 POST 直後の「共通 -確認してください-」中間ページを自動で1段階 POST して進む (#134)', async () => {
    const { fetch, calls } = recordingFetch([html(CONFIRM_PAGE_HTML), html(RESULT_PAGE_HTML)])
    const result = await submitSearch(createCookieJar(), searchPage, fetch, 1000)
    expect(result.html).toBe(RESULT_PAGE_HTML)
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toBe('https://www.etc-meisai.jp/etc/R?funccode=1013000000&nextfunc=1032000000')
    expect(bodyParams(calls[1].init).get('p')).toBe('CONFIRMHIDDEN')
  })
})

describe('downloadMeisaiCsv', () => {
  const resultPage = page('https://www.etc-meisai.jp/etc/R', RESULT_PAGE_HTML)

  it('nextfunc=1032500000 で POST し CSV バイト列と filename を返す', async () => {
    const { fetch, calls } = recordingFetch([csvResponse()])
    const csv = await downloadMeisaiCsv(createCookieJar(), resultPage, fetch, 1000)
    expect(csv.filename).toBe('meisai_202607.csv')
    expect(new TextDecoder().decode(csv.bytes)).toContain('2026/07/01')

    const post = calls[0]
    expect(post.url).toBe(`https://www.etc-meisai.jp/etc/R?nextfunc=${ETC_FUNC_CSV_OUTPUT}`)
    const body = bodyParams(post.init)
    expect(body.get('nextfunc')).toBe(ETC_FUNC_CSV_OUTPUT)
    expect(body.get('p')).toBe('RESULTHIDDEN')
  })

  it('form が無いページでは loud fail する', async () => {
    const p = page('https://x/', '<html><body>no form</body></html>')
    await expect(downloadMeisaiCsv(createCookieJar(), p, recordingFetch([]).fetch, 1000)).rejects.toThrow(
      'CSV 出力用 form が見つかりません',
    )
  })

  it('nextfunc hidden の無い form は query だけで nextfunc を渡す (action 無し form は現在 URL)', async () => {
    const p = page(
      'https://www.etc-meisai.jp/etc/R',
      '<html><body><form><input type="hidden" name="funccode" value="1" /></form></body></html>',
    )
    const { fetch, calls } = recordingFetch([csvResponse()])
    await downloadMeisaiCsv(createCookieJar(), p, fetch, 1000)
    const body = bodyParams(calls[0].init)
    expect(body.has('nextfunc')).toBe(false)
    expect(calls[0].url).toContain(`nextfunc=${ETC_FUNC_CSV_OUTPUT}`)
  })

  it('HTML が返ったら EtcMeisaiNotCsvError (生バイト付き)', async () => {
    const { fetch } = recordingFetch([html('<html><body>error page</body></html>')])
    const err = await downloadMeisaiCsv(createCookieJar(), resultPage, fetch, 1000).catch((e) => e)
    expect(err).toBeInstanceOf(EtcMeisaiNotCsvError)
    expect((err as EtcMeisaiNotCsvError).contentType).toContain('text/html')
    expect((err as EtcMeisaiNotCsvError).responseBytes.byteLength).toBeGreaterThan(0)
  })

  it('octet-stream でも先頭が < (HTML) なら NotCsv とみなす', async () => {
    const bogus = new Response(new TextEncoder().encode('<html>fake</html>'), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })
    const { fetch } = recordingFetch([bogus])
    await expect(downloadMeisaiCsv(createCookieJar(), resultPage, fetch, 1000)).rejects.toBeInstanceOf(
      EtcMeisaiNotCsvError,
    )
  })

  it('空 body / content-type ヘッダ無しは NotCsv', async () => {
    const empty = new Response(new Uint8Array(), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })
    const { fetch } = recordingFetch([empty])
    const err = await downloadMeisaiCsv(createCookieJar(), resultPage, fetch, 1000).catch((e) => e)
    expect(err).toBeInstanceOf(EtcMeisaiNotCsvError)
    expect((err as EtcMeisaiNotCsvError).message).toContain('0 bytes')

    const noCt = new Response(new TextEncoder().encode('a,b\r\n'), { status: 200 })
    // Response が自動付与する content-type を消す
    noCt.headers.delete('content-type')
    const { fetch: fetch2 } = recordingFetch([noCt])
    const err2 = await downloadMeisaiCsv(createCookieJar(), resultPage, fetch2, 1000).catch((e) => e)
    expect(err2).toBeInstanceOf(EtcMeisaiNotCsvError)
    expect((err2 as EtcMeisaiNotCsvError).message).toContain('(none)')
  })

  it('text/csv content-type も CSV として受け付ける', async () => {
    const csv = new Response(new TextEncoder().encode('a,b\r\n1,2\r\n'), {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    })
    const { fetch } = recordingFetch([csv])
    const result = await downloadMeisaiCsv(createCookieJar(), resultPage, fetch, 1000)
    expect(result.filename).toBe('meisai.csv') // content-disposition 無し → fallback
  })

  it('HTTP エラー status は NotCsv として loud fail する', async () => {
    const errRes = new Response(new TextEncoder().encode('x'), {
      status: 500,
      headers: { 'content-type': 'application/octet-stream' },
    })
    const { fetch } = recordingFetch([errRes])
    const err = await downloadMeisaiCsv(createCookieJar(), resultPage, fetch, 1000).catch((e) => e)
    expect((err as EtcMeisaiNotCsvError).message).toContain('HTTP 500')
  })

  it('CSV 出力ボタンが直接あるページ (#134) は goOutput(...) の遷移先へ POST する', async () => {
    const p = page('https://www2.etc-meisai.jp/etc/R?funccode=1013000000&nextfunc=1013000000', DIRECT_RESULT_HTML)
    const { fetch, calls } = recordingFetch([csvResponse()])
    const csv = await downloadMeisaiCsv(createCookieJar(), p, fetch, 1000)
    expect(csv.filename).toBe('meisai_202607.csv')

    const post = calls[0]
    expect(post.url).toBe('https://www2.etc-meisai.jp/etc/R?funccode=1013000000&nextfunc=1013500000')
    const body = bodyParams(post.init)
    expect(body.get('p')).toBe('DIRECTHIDDEN')
    expect(body.has('nextfunc')).toBe(false) // goOutput の URL に既に埋め込まれているため override しない
  })
})

// ---------------------------------------------------------------------------
// 統合オーケストレーション
// ---------------------------------------------------------------------------

describe('scrapeEtcCsv', () => {
  it('login → 検索ページ遷移 → 検索 → CSV を一括実行し進捗を通知する', async () => {
    const { fetch } = recordingFetch([
      html(TOP_HTML),
      html(LOGIN_PAGE_HTML),
      redirect('/etc_user_meisai/menu'),
      html(MENU_HTML),
      html(SEARCH_PAGE_HTML),
      html(RESULT_PAGE_HTML),
      csvResponse(),
    ])
    const steps: string[] = []
    const result = await scrapeEtcCsv(
      { userId: 'u', password: 'p' },
      (step) => steps.push(step),
      fetch,
      { requestTimeoutMs: 1000, exportTimeoutMs: 1000 },
    )
    expect(steps).toEqual(['login', 'search', 'download', 'done'])
    expect(result.accountType).toBe('personal')
    expect(result.filename).toBe('meisai_202607.csv')
    expect(result.bytes.byteLength).toBeGreaterThan(0)
  })

  it('timeouts 未指定は既定値で動く', async () => {
    const { fetch } = recordingFetch([html('<html><body>MAINTENANCE</body></html>')])
    await expect(scrapeEtcCsv({ userId: 'u', password: 'p' }, () => {}, fetch)).rejects.toBeInstanceOf(
      EtcMeisaiClientError,
    )
  })
})

describe('scrapeEtcFromCookies (cookie 委譲)', () => {
  const cookies = [
    { name: 'JSESSIONID', value: 'ABC123' },
    { name: 'csrf', value: 'xyz' },
  ]
  const startUrl = 'https://www.etc-meisai.jp/etc_user_meisai/menu'

  it('cookie を jar に注入し login をスキップして検索→CSV を回す', async () => {
    // startUrl GET (menu) → 検索ページ遷移 POST → 検索 POST → CSV POST
    const { fetch, calls } = recordingFetch([
      html(MENU_HTML),
      html(SEARCH_PAGE_HTML),
      html(RESULT_PAGE_HTML),
      csvResponse(),
    ])
    const steps: string[] = []
    const result = await scrapeEtcFromCookies(cookies, startUrl, (s) => steps.push(s), fetch, {
      requestTimeoutMs: 1000,
      exportTimeoutMs: 1000,
    })
    expect(steps).toEqual(['login', 'search', 'download', 'done'])
    expect(result.accountType).toBe('personal') // startUrl が etc_user_meisai
    expect(result.filename).toBe('meisai_202607.csv')

    // 最初の GET は startUrl、cookie が載る (login POST は無い = risLoginId を送らない)
    expect(calls[0].url).toBe(startUrl)
    expect(new Headers(calls[0].init.headers).get('cookie')).toBe('JSESSIONID=ABC123; csrf=xyz')
    expect(JSON.stringify(calls)).not.toContain('risLoginId')
  })

  it('法人 startUrl は corporate 判定', async () => {
    const { fetch } = recordingFetch([
      html(MENU_HTML),
      html(SEARCH_PAGE_HTML),
      html(RESULT_PAGE_HTML),
      csvResponse(),
    ])
    const result = await scrapeEtcFromCookies(
      cookies,
      'https://www.etc-meisai.jp/etc_corp_meisai/top',
      () => {},
      fetch,
    )
    expect(result.accountType).toBe('corporate')
  })

  it('空 cookies / 不正 startUrl / 不正 cookie エントリを弾く', async () => {
    await expect(scrapeEtcFromCookies([], startUrl, () => {}, recordingFetch([]).fetch)).rejects.toThrow(
      'cookies が空です',
    )
    await expect(
      scrapeEtcFromCookies(cookies, 'ftp://nope', () => {}, recordingFetch([]).fetch),
    ).rejects.toThrow('startUrl は http(s)')

    // name/value が不正なエントリは無視されるが、有効なものが1つでもあれば進む
    const { fetch } = recordingFetch([html(MENU_HTML), html(SEARCH_PAGE_HTML), html(RESULT_PAGE_HTML), csvResponse()])
    const mixed = [
      { name: '', value: 'x' } as never,
      { name: 'valid', value: 'v' },
      { foo: 'bar' } as never,
    ]
    const result = await scrapeEtcFromCookies(mixed, startUrl, () => {}, fetch)
    expect(result.filename).toBe('meisai_202607.csv')
  })
})
