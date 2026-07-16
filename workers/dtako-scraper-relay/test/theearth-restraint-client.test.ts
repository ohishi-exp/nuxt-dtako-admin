import { describe, expect, it } from 'vitest'
import {
  downloadRestraintCsv,
  isNoDataResponse,
  parseHmmToMinutes,
  parseRestraintCsv,
  parseRestraintVersionTimestamp,
  pickSupersededVersionKeys,
  RESTRAINT_VERSION_RETENTION_MS,
  restraintDriverRangeLabel,
  restraintR2Paths,
  RestraintParamError,
  restraintVersionTimestamp,
  restraintYearCandidates,
  stableSummaryBody,
  summarizeRestraintDriver,
  validateRestraintParams,
  type RestraintCsvParams,
  type RestraintDriverBlock,
} from '../src/theearth-restraint-client'
import {
  createCookieJar,
  TheearthClientError,
  VenusSessionExpiredError,
  type FetchLike,
} from '../src/theearth-client'

// ---------------------------------------------------------------------------
// fetch モック (theearth-client.test.ts と同型)
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

/** 最後の POST body を捕捉する fetch モック。 */
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

// F-ERS2010 の GET ページ (実ページの必須要素を最小再現)。
const RESTRAINT_PAGE_HTML = `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS1" />
  <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="EV1" />
  <input type="radio" name="ctl00$RangeType" id="rdoGeneral2" value="rdoGeneral2" checked="checked" />
  <input type="text" name="ctl00$ucMonthDate$txtYear" id="ucMonthDate_txtYear" value="" />
  <input type="text" name="ctl00$ucMonthDate$txtMonth" id="ucMonthDate_txtMonth" value="" />
  <input type="text" name="ctl00$txtStartDriver" id="txtStartDriver" value="" />
  <input type="text" name="ctl00$txtEndDriver" id="txtEndDriver" value="" />
  <input type="submit" name="ctl00$btnOutputCsv" id="btnOutputCsv" value="CSV" />
</form></body></html>`

/** btnOutputCsv の value が空のページ (`|| "CSV"` フォールバック用)。 */
const RESTRAINT_PAGE_EMPTY_BTN_HTML = RESTRAINT_PAGE_HTML.replace(
  'name="ctl00$btnOutputCsv" id="btnOutputCsv" value="CSV"',
  'name="ctl00$btnOutputCsv" id="btnOutputCsv" value=""',
)

/** 和暦入力モード hint (`chkUseEra` checked) のページ。 */
const RESTRAINT_PAGE_ERA_HTML = RESTRAINT_PAGE_HTML.replace(
  '<input type="text" name="ctl00$ucMonthDate$txtYear"',
  '<input type="checkbox" name="ctl00$ucMonthDate$chkUseEra" id="ucMonthDate_chkUseEra" checked="checked" />\n  <input type="text" name="ctl00$ucMonthDate$txtYear"',
)

const LOGIN_FORM_HTML = `<html><body><form>
  <input name="txtPass" type="password" id="txtPass" />
</form></body></html>`

const NO_DATA_HTML = `<html><body><form></form>
  <script>DispMsg('該当データがありません。');</script>
</body></html>`

// "拘束時間管理表" の Shift_JIS バイト列 (CP932 実測)。Node の TextEncoder は
// Shift_JIS を encode できないため、CSV 応答のモックはこれで組み立てる。
const MAGIC_SJIS = new Uint8Array([
  0x8d, 0x53, 0x91, 0xa9, 0x8e, 0x9e, 0x8a, 0xd4, 0x8a, 0xc7, 0x97, 0x9d, 0x95, 0x5c,
])

function sjisCsvResponse(asciiTail: string, contentType = 'application/octet-stream'): Response {
  const tail = new TextEncoder().encode(asciiTail)
  const bytes = new Uint8Array(MAGIC_SJIS.length + tail.length)
  bytes.set(MAGIC_SJIS, 0)
  bytes.set(tail, MAGIC_SJIS.length)
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } })
}

const VALID_PARAMS: RestraintCsvParams = { year: 2025, month: 4, driverFrom: '9901', driverTo: '9901' }

// ---------------------------------------------------------------------------
// validateRestraintParams
// ---------------------------------------------------------------------------

describe('validateRestraintParams', () => {
  it('正常系 (単一乗務員) は通る', () => {
    expect(() => validateRestraintParams(VALID_PARAMS)).not.toThrow()
  })

  it('正常系 (全乗務員 = 両方空) は通る', () => {
    expect(() => validateRestraintParams({ year: 2026, month: 12, driverFrom: '', driverTo: '' })).not.toThrow()
  })

  it('year が 4 桁西暦でないと RestraintParamError', () => {
    expect(() => validateRestraintParams({ ...VALID_PARAMS, year: 25 })).toThrow(RestraintParamError)
    expect(() => validateRestraintParams({ ...VALID_PARAMS, year: 2101 })).toThrow(RestraintParamError)
    expect(() => validateRestraintParams({ ...VALID_PARAMS, year: Number.NaN })).toThrow(RestraintParamError)
  })

  it('month が 1〜12 でないと RestraintParamError', () => {
    expect(() => validateRestraintParams({ ...VALID_PARAMS, month: 0 })).toThrow(RestraintParamError)
    expect(() => validateRestraintParams({ ...VALID_PARAMS, month: 13 })).toThrow(RestraintParamError)
  })

  it('driverFrom / driverTo の片方だけ指定は RestraintParamError', () => {
    expect(() => validateRestraintParams({ ...VALID_PARAMS, driverTo: '' })).toThrow(RestraintParamError)
  })

  it('乗務員CD が数値でないと RestraintParamError (from / to それぞれ)', () => {
    expect(() => validateRestraintParams({ ...VALID_PARAMS, driverFrom: 'abc' })).toThrow(/driverFrom/)
    expect(() => validateRestraintParams({ ...VALID_PARAMS, driverTo: '12x' })).toThrow(/driverTo/)
  })
})

// ---------------------------------------------------------------------------
// downloadRestraintCsv
// ---------------------------------------------------------------------------

describe('downloadRestraintCsv', () => {
  it('GET → btnOutputCsv postback で CSV bytes + テキストを返す (フォーム値も送る)', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [html(RESTRAINT_PAGE_HTML), sjisCsvResponse(' (2025 4)\r\nrest')],
      captured,
    )
    const result = await downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)
    expect(result).not.toBeNull()
    expect(result!.text.startsWith('拘束時間管理表')).toBe(true)
    expect(result!.bytes.byteLength).toBeGreaterThan(MAGIC_SJIS.length)
    const body = new URLSearchParams(captured.body[0]!)
    // 4 桁西暦 (2 桁は企業の和暦/西暦設定で解釈がぶれる — 実機確定) + 乗務員 range
    expect(body.get('ctl00$ucMonthDate$txtYear')).toBe('2025')
    expect(body.get('ctl00$ucMonthDate$txtMonth')).toBe('4')
    expect(body.get('ctl00$txtStartDriver')).toBe('9901')
    expect(body.get('ctl00$txtEndDriver')).toBe('9901')
    expect(body.get('ctl00$btnOutputCsv')).toBe('CSV')
    // full-form 直列化: 出力基準 radio は既定値のまま維持される
    expect(body.get('ctl00$RangeType')).toBe('rdoGeneral2')
    expect(body.get('__VIEWSTATE')).toBe('VS1')
  })

  it('btnOutputCsv の value が空なら "CSV" をフォールバック送信する', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [html(RESTRAINT_PAGE_EMPTY_BTN_HTML), sjisCsvResponse(' tail')],
      captured,
    )
    await downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl, { exportTimeoutMs: 1000, requestTimeoutMs: 1000 })
    const body = new URLSearchParams(captured.body[0]!)
    expect(body.get('ctl00$btnOutputCsv')).toBe('CSV')
  })

  it('パラメータ不正は fetch せずに RestraintParamError', async () => {
    const fetchImpl = sequenceFetch([])
    await expect(
      downloadRestraintCsv(createCookieJar(), { ...VALID_PARAMS, month: 0 }, fetchImpl),
    ).rejects.toThrow(RestraintParamError)
  })

  it('GET がログイン画面なら VenusSessionExpiredError', async () => {
    const fetchImpl = sequenceFetch([html(LOGIN_FORM_HTML)])
    await expect(downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('必須フォーム要素が無いと loud fail する', async () => {
    const broken = RESTRAINT_PAGE_HTML.replace('id="txtStartDriver"', 'id="txtStartDriverX"')
    const fetchImpl = sequenceFetch([html(broken)])
    await expect(downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)).rejects.toThrow(
      /txtStartDriver/,
    )
  })

  it('postback が HTTP 500 なら診断付きで loud fail する', async () => {
    const fetchImpl = sequenceFetch([
      html(RESTRAINT_PAGE_HTML),
      new Response('<html><head><title>ランタイム エラー</title></head><body>err</body></html>', { status: 500 }),
    ])
    await expect(downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)).rejects.toThrow(
      /HTTP 500.*ランタイム エラー/,
    )
  })

  it('全候補 (4桁西暦 → 令和2桁) が「該当データがありません」なら null (エラーではない)', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [html(RESTRAINT_PAGE_HTML), html(NO_DATA_HTML), html(RESTRAINT_PAGE_HTML), html(NO_DATA_HTML)],
      captured,
    )
    await expect(downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)).resolves.toBeNull()
    // 4桁西暦 → 令和2桁ゼロ埋めの順に試す (企業の和暦/西暦設定に依存しないため)
    expect(new URLSearchParams(captured.body[0]!).get('ctl00$ucMonthDate$txtYear')).toBe('2025')
    expect(new URLSearchParams(captured.body[1]!).get('ctl00$ucMonthDate$txtYear')).toBe('07')
  })

  it('4桁西暦が該当なしでも令和2桁のリトライで取れれば成功', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch(
      [html(RESTRAINT_PAGE_HTML), html(NO_DATA_HTML), html(RESTRAINT_PAGE_HTML), sjisCsvResponse(' tail')],
      captured,
    )
    const result = await downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)
    expect(result).not.toBeNull()
    expect(new URLSearchParams(captured.body[1]!).get('ctl00$ucMonthDate$txtYear')).toBe('07')
  })

  it('chkUseEra が checked のページでは令和2桁を先に試す', async () => {
    const captured = { body: [] as string[] }
    const fetchImpl = capturingFetch([html(RESTRAINT_PAGE_ERA_HTML), sjisCsvResponse(' tail')], captured)
    await downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)
    expect(new URLSearchParams(captured.body[0]!).get('ctl00$ucMonthDate$txtYear')).toBe('07')
  })

  it('令和にならない年 (2018 以前) は 4 桁西暦しか試さない', async () => {
    const fetchImpl = sequenceFetch([html(RESTRAINT_PAGE_HTML), html(NO_DATA_HTML)])
    await expect(
      downloadRestraintCsv(createCookieJar(), { ...VALID_PARAMS, year: 2018 }, fetchImpl),
    ).resolves.toBeNull()
  })

  it('リトライの再 GET がログイン画面なら VenusSessionExpiredError', async () => {
    const fetchImpl = sequenceFetch([html(RESTRAINT_PAGE_HTML), html(NO_DATA_HTML), html(LOGIN_FORM_HTML)])
    await expect(downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('postback がログイン画面 (HTML) なら VenusSessionExpiredError', async () => {
    const fetchImpl = sequenceFetch([html(RESTRAINT_PAGE_HTML), html(LOGIN_FORM_HTML)])
    await expect(downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    )
  })

  it('想定外の HTML (no-data でもログインでもない) は loud fail する', async () => {
    const fetchImpl = sequenceFetch([
      html(RESTRAINT_PAGE_HTML),
      html('<html><body>unexpected</body></html>'),
    ])
    await expect(downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)).rejects.toThrow(
      /想定外の HTML.*no title/,
    )
  })

  it('CSV マジック (1 行目) が一致しない非 HTML 応答は loud fail する', async () => {
    const fetchImpl = sequenceFetch([
      html(RESTRAINT_PAGE_HTML),
      new Response(new TextEncoder().encode('not a csv'), { status: 200 }),
    ])
    await expect(downloadRestraintCsv(createCookieJar(), VALID_PARAMS, fetchImpl)).rejects.toThrow(
      /拘束時間管理表 CSV ではありません.*\(none\)/,
    )
  })
})

// ---------------------------------------------------------------------------
// restraintYearCandidates
// ---------------------------------------------------------------------------

describe('restraintYearCandidates', () => {
  it('既定 (chkUseEra なし/unchecked) は 4桁西暦 → 令和2桁ゼロ埋め', () => {
    expect(restraintYearCandidates(2025, RESTRAINT_PAGE_HTML)).toEqual(['2025', '07'])
    expect(restraintYearCandidates(2026, '<html></html>')).toEqual(['2026', '08'])
  })

  it('chkUseEra checked のページは令和2桁を先に', () => {
    expect(restraintYearCandidates(2026, RESTRAINT_PAGE_ERA_HTML)).toEqual(['08', '2026'])
  })

  it('令和にならない年は 4 桁西暦のみ', () => {
    expect(restraintYearCandidates(2018, RESTRAINT_PAGE_HTML)).toEqual(['2018'])
  })
})

// ---------------------------------------------------------------------------
// R2 アーカイブ key / バージョン管理ヘルパ
// ---------------------------------------------------------------------------

describe('restraintR2Paths / restraintDriverRangeLabel', () => {
  const paths = restraintR2Paths('restraint', 'COMP1', 2025, 4, '9901-9901')

  it('CSV / サマリの key を組み立てる', () => {
    expect(paths.csvDir).toBe('restraint/COMP1/2025-04/csv/9901-9901')
    expect(paths.csvLatest).toBe('restraint/COMP1/2025-04/csv/9901-9901/latest.csv')
    expect(paths.csvVersion('20260716T183000')).toBe(
      'restraint/COMP1/2025-04/csv/9901-9901/v-20260716T183000.csv',
    )
    expect(paths.summaryDir('9901')).toBe('restraint/COMP1/2025-04/summary/9901')
    expect(paths.summaryLatest('9901')).toBe('restraint/COMP1/2025-04/summary/9901/latest.json')
    expect(paths.summaryVersion('9901', '20260716T183000')).toBe(
      'restraint/COMP1/2025-04/summary/9901/v-20260716T183000.json',
    )
  })

  it('乗務員CD 空はサマリ key を unknown に落とす', () => {
    expect(paths.summaryLatest('')).toBe('restraint/COMP1/2025-04/summary/unknown/latest.json')
    expect(paths.summaryVersion('', 'T')).toBe('restraint/COMP1/2025-04/summary/unknown/v-T.json')
  })

  it('range ラベル: 指定あり / 全乗務員', () => {
    expect(restraintDriverRangeLabel({ year: 2025, month: 4, driverFrom: '1', driverTo: '2' })).toBe('1-2')
    expect(restraintDriverRangeLabel({ year: 2025, month: 4, driverFrom: '', driverTo: '' })).toBe('all')
  })
})

describe('restraintVersionTimestamp / parseRestraintVersionTimestamp', () => {
  it('JST の YYYYMMDDTHHmmss を生成し、round-trip できる', () => {
    const now = new Date('2026-07-16T09:30:15Z') // JST 18:30:15
    const ts = restraintVersionTimestamp(now)
    expect(ts).toBe('20260716T183015')
    expect(parseRestraintVersionTimestamp(ts)).toBe(now.getTime())
  })

  it('形式不一致は null', () => {
    expect(parseRestraintVersionTimestamp('latest')).toBeNull()
    expect(parseRestraintVersionTimestamp('2026-07-16T18:30:15')).toBeNull()
  })
})

describe('pickSupersededVersionKeys', () => {
  const base = 'restraint/COMP1/2025-04/csv/all'
  const now = new Date('2026-07-16T09:00:00Z')
  const key = (ts: string) => `${base}/v-${ts}.csv`

  it('最新版は常に残し、後継版の出現から 7 日過ぎた旧版だけ選ぶ', () => {
    const oldV = key('20260601T000000') // 後継 (07-01) の出現から 7 日超 → 削除
    const midV = key('20260701T000000') // 後継 (07-15) の出現から 7 日未満 → 残す
    const newV = key('20260715T000000') // 最新 → 残す
    expect(pickSupersededVersionKeys([newV, oldV, midV], now)).toEqual([oldV])
  })

  it('retention を明示指定できる (0 なら旧版すべて)', () => {
    const keys = [key('20260101T000000'), key('20260201T000000')]
    expect(pickSupersededVersionKeys(keys, now, 0)).toEqual([key('20260101T000000')])
  })

  it('タイムスタンプを読めない key は安全側で残す・空/1件は何も選ばない', () => {
    expect(pickSupersededVersionKeys([`${base}/latest.csv`, key('20260101T000000')], now)).toEqual([])
    expect(pickSupersededVersionKeys([], now)).toEqual([])
    expect(pickSupersededVersionKeys([key('20260101T000000')], now)).toEqual([])
  })

  it('既定 retention は 7 日', () => {
    expect(RESTRAINT_VERSION_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('stableSummaryBody', () => {
  it('同じ内容なら常に同一バイト列 (SHA-256 変化検知の前提)', () => {
    const report = parseRestraintCsv(SAMPLE_CSV)
    const s = summarizeRestraintDriver(report.drivers[0]!)
    const a = stableSummaryBody('COMP1', 2025, 4, s)
    const b = stableSummaryBody('COMP1', 2025, 4, summarizeRestraintDriver(report.drivers[0]!))
    expect(a).toBe(b)
    expect(JSON.parse(a)).toMatchObject({ compId: 'COMP1', year: 2025, month: 4, driverCd: '9901' })
  })
})

// ---------------------------------------------------------------------------
// isNoDataResponse / parseHmmToMinutes
// ---------------------------------------------------------------------------

describe('isNoDataResponse', () => {
  it('該当データがありません を含む HTML で true', () => {
    expect(isNoDataResponse(NO_DATA_HTML)).toBe(true)
    expect(isNoDataResponse('<html></html>')).toBe(false)
  })
})

describe('parseHmmToMinutes', () => {
  it('"H:mm" を分に変換する (H は 3 桁以上も可)', () => {
    expect(parseHmmToMinutes('0:53')).toBe(53)
    expect(parseHmmToMinutes('16:11')).toBe(971)
    expect(parseHmmToMinutes('345:50')).toBe(20750)
  })

  it('空・undefined・非該当は null', () => {
    expect(parseHmmToMinutes('')).toBeNull()
    expect(parseHmmToMinutes(undefined)).toBeNull()
    expect(parseHmmToMinutes('休')).toBeNull()
    expect(parseHmmToMinutes('1:2')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseRestraintCsv
// ---------------------------------------------------------------------------

const HEADER_LINE
  = '日付,始業時刻,終業時刻,運転時間,重複運転時間,荷役時間,重複荷役時間,休憩時間,重複休憩時間,時間,重複時間,拘束時間小計,重複拘束時間小計,拘束時間合計,拘束時間累計,前運転平均,後運転平均,休息時間,実働時間,時間外時間,深夜時間,時間外深夜時間,摘要1,摘要2'

// 実 CSV の構造 (行種別・列並び・「休」短縮形・合計/年度累計行) を、架空の
// 乗務員・事業所・時間値で最小再現した fixture。
const SAMPLE_CSV = [
  '拘束時間管理表 (2025年 4月分)',
  '※当月の最大拘束時間 : 275 時間（労使協定により時間を記入する）',
  '',
  '事業所,テスト運輸　第一営業所,乗務員分類1,テスト1班,乗務員分類2,2,乗務員分類3,テスト課,乗務員分類4,未設定,乗務員分類5,',
  '氏名,試験　太郎,乗務員コード,9901',
  HEADER_LINE,
  '4月1日,8:00,21:30,5:00,1:00,3:00,0:30,1:00,,,,12:30,1:00,13:30,13:30,,4:00,10:30,9:00,,,,4/1帰着:テスト積地,',
  '4月2日,5:00,20:00,10:00,,4:00,,,,,,15:00,,15:00,28:30,,9:00,9:00,15:00,7:00,,,4/2出発,',
  '4月6日,休,',
  '合計,,,15:00,,7:00,,1:00,,,,28:30,,,,,,19:30,24:00,7:00,1:00,0:30,,',
  '4月～ 月 累計拘束時間, 時間   分,',
  '2025年度　拘束時間,3300時間',
  'D2 : 2分割休息  D3 : 3分割休息  W16 : 拘束時間延長  R8 : 住所外地休息  R12 : 住所地休息  * : 2マン運行',
  '',
  '事業所,テスト運輸　第二営業所,乗務員分類1,テスト2班',
  '氏名,試験　次郎,乗務員コード,9902',
  HEADER_LINE,
  '4月3日,9:00,17:00,4:00,,2:00,,1:00,,,,8:00,,8:00,8:00,,4:00,16:00,7:00,,,,,',
  '合計,,,4:00,,2:00,,1:00,,,,8:00,,,,,,16:00,7:00,,,,,',
  '4月～5月 累計拘束時間,100時間 30分,',
  '2026年度　拘束時間,時間',
  '',
].join('\r\n')

describe('parseRestraintCsv', () => {
  const report = parseRestraintCsv(SAMPLE_CSV)

  it('タイトルから年月を読む', () => {
    expect(report.year).toBe(2025)
    expect(report.month).toBe(4)
    expect(report.title).toContain('2025年 4月分')
    expect(report.maxRestraintNote).toContain('275 時間')
  })

  it('乗務員ブロックを複数パースする (事業所・分類・氏名・CD)', () => {
    expect(report.drivers).toHaveLength(2)
    const [d1, d2] = report.drivers
    expect(d1!.branchName).toBe('テスト運輸　第一営業所')
    expect(d1!.driverName).toBe('試験　太郎')
    expect(d1!.driverCd).toBe('9901')
    expect(d1!.categories['乗務員分類1']).toBe('テスト1班')
    // 値が空の分類ラベルも維持する
    expect(d1!.categories['乗務員分類5']).toBe('')
    expect(d2!.driverCd).toBe('9902')
  })

  it('日別行をパースする (勤務日)', () => {
    const day1 = report.drivers[0]!.days[0]!
    expect(day1.date).toBe('4月1日')
    expect(day1.day).toBe(1)
    expect(day1.isRestDay).toBe(false)
    expect(day1.startTime).toBe('8:00')
    expect(day1.endTime).toBe('21:30')
    expect(day1.drivingMinutes).toBe(300)
    expect(day1.restraintMinutes).toBe(13 * 60 + 30)
    expect(day1.restraintCumulativeMinutes).toBe(13 * 60 + 30)
    expect(day1.restMinutes).toBe(10 * 60 + 30)
    expect(day1.workingMinutes).toBe(540)
    expect(day1.overtimeMinutes).toBeNull()
    expect(day1.notes).toEqual(['4/1帰着:テスト積地'])
  })

  it('休日行をパースする', () => {
    const rest = report.drivers[0]!.days[2]!
    expect(rest.isRestDay).toBe(true)
    expect(rest.startTime).toBe('')
    expect(rest.endTime).toBe('')
    expect(rest.restraintMinutes).toBeNull()
  })

  it('合計行は「拘束時間小計」列を月間拘束時間として読む (実 CSV 確定)', () => {
    const totals = report.drivers[0]!.totals!
    expect(totals.restraintMinutes).toBe(28 * 60 + 30)
    expect(totals.drivingMinutes).toBe(15 * 60)
    expect(totals.workingMinutes).toBe(24 * 60)
    expect(totals.overtimeMinutes).toBe(7 * 60)
  })

  it('年度累計 (空欄 = null / 値あり = 分)・年度拘束時間をパースする', () => {
    expect(report.drivers[0]!.fiscalCumulativeMinutes).toBeNull()
    expect(report.drivers[0]!.fiscalLimitHours).toBe(3300)
    expect(report.drivers[1]!.fiscalCumulativeMinutes).toBe(100 * 60 + 30)
    expect(report.drivers[1]!.fiscalLimitHours).toBeNull()
  })

  it('「N時間」だけ (分なし) の年度累計もパースする', () => {
    const csv = SAMPLE_CSV.replace('4月～5月 累計拘束時間,100時間 30分,', '4月～5月 累計拘束時間,10時間,')
    const r = parseRestraintCsv(csv)
    expect(r.drivers[1]!.fiscalCumulativeMinutes).toBe(600)
  })

  it('1 行目が拘束時間管理表でないと throw', () => {
    expect(() => parseRestraintCsv('こんにちは')).toThrow(TheearthClientError)
  })

  it('タイトルから年月を読めないと throw', () => {
    expect(() => parseRestraintCsv('拘束時間管理表 (全期間)')).toThrow(/年月を読めません/)
  })

  it('乗務員ブロックが 1 つも無いと throw (ブロック外の行は無視される)', () => {
    expect(() => parseRestraintCsv('拘束時間管理表 (2025年 4月分)\r\n注記\r\n迷い込んだ行')).toThrow(
      /乗務員ブロックが見つかりません/,
    )
  })

  it('ヘッダ行より前の日別行・合計行・氏名行 (乗務員コード欠落) も落ちない (防御的パース)', () => {
    const csv = [
      '拘束時間管理表 (2025年 4月分)',
      '注記',
      '事業所,X営業所,,ラベル空は無視,乗務員分類2,2班',
      '氏名,テスト,乗務員コード', // CD 列自体が末尾で値なし
      '4月1日,8:00,17:00,1:00',
      '合計,,,1:00',
      '事業所だけで氏名の無い行,無視',
      HEADER_LINE.replace(',摘要1,摘要2', ',備考A,備考B'), // 摘要1 列が無いヘッダ
      '4月2日,9:00,18:00,2:00',
    ].join('\n')
    const r = parseRestraintCsv(csv)
    const d = r.drivers[0]!
    expect(d.driverName).toBe('テスト')
    expect(d.driverCd).toBe('')
    expect(d.categories).toEqual({ 乗務員分類2: '2班' })
    // ヘッダ前の日別行は headerIdx 無しでも位置列の分だけ null で読める
    expect(d.days[0]!.drivingMinutes).toBeNull()
    expect(d.days[0]!.notes).toEqual([])
    expect(d.totals!.restraintMinutes).toBeNull()
    // 摘要1 列が無いヘッダでは notes は空
    expect(d.days[1]!.notes).toEqual([])
  })

  it('カラム欠落した縮退行 (単独ラベルのみ等) でも落ちない (防御的パース)', () => {
    const csv = [
      '拘束時間管理表 (2025年 4月分)',
      '注記',
      '事業所', // 事業所名なし
      '氏名', // 氏名なし
      '4月5日', // 始業・終業なし (休でもない)
      '4月～5月 累計拘束時間', // 値カラムなし
      '2025年度　拘束時間', // 値カラムなし
    ].join('\n')
    const r = parseRestraintCsv(csv)
    const d = r.drivers[0]!
    expect(d.branchName).toBe('')
    expect(d.driverName).toBe('')
    expect(d.days[0]!.isRestDay).toBe(false)
    expect(d.days[0]!.startTime).toBe('')
    expect(d.days[0]!.endTime).toBe('')
    expect(d.fiscalCumulativeMinutes).toBeNull()
    expect(d.fiscalLimitHours).toBeNull()
  })

  it('タイトル行しか無い CSV は注記なし扱いでブロック無し throw', () => {
    expect(() => parseRestraintCsv('拘束時間管理表 (2025年 4月分)')).toThrow(/乗務員ブロックが見つかりません/)
  })
})

// ---------------------------------------------------------------------------
// summarizeRestraintDriver
// ---------------------------------------------------------------------------

describe('summarizeRestraintDriver', () => {
  const report = parseRestraintCsv(SAMPLE_CSV)

  it('合計行がある時はそれを使う', () => {
    const s = summarizeRestraintDriver(report.drivers[0]!)
    expect(s.driverCd).toBe('9901')
    expect(s.driverName).toBe('試験　太郎')
    expect(s.workDays).toBe(2)
    expect(s.restDays).toBe(1)
    expect(s.restraintMinutes).toBe(28 * 60 + 30)
    expect(s.maxDailyRestraintMinutes).toBe(15 * 60)
    expect(s.fiscalCumulativeMinutes).toBeNull()
  })

  it('合計行が無い時は日別行の和にフォールバックする', () => {
    const block: RestraintDriverBlock = {
      ...report.drivers[0]!,
      totals: null,
    }
    const s = summarizeRestraintDriver(block)
    expect(s.restraintMinutes).toBe((13 * 60 + 30) + (15 * 60))
    expect(s.drivingMinutes).toBe(300 + 600)
  })

  it('日別行が全て null の指標は null (0 にしない)', () => {
    const block: RestraintDriverBlock = {
      branchName: 'X',
      categories: {},
      driverName: 'Y',
      driverCd: '1',
      header: [],
      days: [
        {
          date: '4月1日',
          day: 1,
          isRestDay: true,
          startTime: '',
          endTime: '',
          drivingMinutes: null,
          loadingMinutes: null,
          breakMinutes: null,
          restraintMinutes: null,
          restraintCumulativeMinutes: null,
          restMinutes: null,
          workingMinutes: null,
          overtimeMinutes: null,
          notes: [],
          columns: [],
        },
      ],
      totals: null,
      fiscalCumulativeMinutes: 120,
      fiscalLimitHours: 3300,
    }
    const s = summarizeRestraintDriver(block)
    expect(s.restraintMinutes).toBeNull()
    expect(s.maxDailyRestraintMinutes).toBeNull()
    expect(s.workDays).toBe(0)
    expect(s.restDays).toBe(1)
    expect(s.fiscalCumulativeMinutes).toBe(120)
  })
})
