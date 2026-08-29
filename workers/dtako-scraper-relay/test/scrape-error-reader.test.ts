import { describe, expect, it } from 'vitest'
import {
  buildScrapeErrorListing,
  buildScrapeErrorObjectPayload,
  compareScrapeErrorRows,
  decodeScrapeErrorBody,
  extractHtmlTitle,
  parseScrapeErrorJsonMeta,
  parseScrapeErrorKey,
  parseScrapeErrorListRequest,
  parseScrapeErrorObjectRequest,
  SCRAPE_ERROR_LIST_DEFAULT_LIMIT,
  SCRAPE_ERROR_LIST_MAX_LIMIT,
  SCRAPE_ERROR_TITLE_MAX,
  scrapeErrorListPrefix,
  scrapeErrorRootPrefix,
} from '../src/scrape-error-reader'
import { EVIDENCE_BODY_PREFIX_MAX } from '../src/theearth-client'
import { buildScrapeErrorArtifact, scrapeErrorR2Key } from '../src/scrape-error-artifact'
import { TheearthNotZipError, TheearthPageMismatchError } from '../src/theearth-client'

const PREFIX = 'dtako-scrape'
const COMP = '75700192'

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('key の組み立てと解釈', () => {
  it('root prefix は {prefix}-errors/', () => {
    expect(scrapeErrorRootPrefix(PREFIX)).toBe('dtako-scrape-errors/')
    // prefix は env から来る。staging を渡せば staging を見る (決め打ちしていない)
    expect(scrapeErrorRootPrefix('dtako-scrape-staging')).toBe('dtako-scrape-staging-errors/')
  })

  it('job_key を省くと comp 配下ぜんぶ、指定するとその読取日だけ', () => {
    expect(scrapeErrorListPrefix(PREFIX, COMP, null)).toBe('dtako-scrape-errors/75700192/')
    expect(scrapeErrorListPrefix(PREFIX, COMP, '2026-08-01')).toBe(
      'dtako-scrape-errors/75700192/2026-08-01/',
    )
  })

  /**
   * ★ 保存側と読み側で key の形が食い違っていないことを、**保存側の関数が実際に作った
   * key** で確かめる (文字列リテラルで書き写すと、保存側が変わっても気づけない)。
   */
  it('保存側 scrapeErrorR2Key が作った key をそのまま解ける', () => {
    const key = scrapeErrorR2Key(
      { prefix: PREFIX, compId: COMP, jobKey: '2026-08-01', nowMs: 1_754_000_000_000 },
      'bin',
    )
    expect(key).toBe('dtako-scrape-errors/75700192/2026-08-01/1754000000000.bin')
    expect(parseScrapeErrorKey(key, PREFIX)).toEqual({
      compId: COMP,
      jobKey: '2026-08-01',
      savedAtMs: 1_754_000_000_000,
      ext: 'bin',
    })
  })

  it('保存側が .json で作った key (期間 jobKey) も解ける', () => {
    const artifact = buildScrapeErrorArtifact(
      new TheearthPageMismatchError('ページ違い', {
        status: 200,
        contentType: 'text/html',
        bodyLength: 10,
        elapsedMs: 1,
        hasLoginForm: false,
        page: 'x',
      }, '<html>'),
      { prefix: PREFIX, compId: COMP, jobKey: '2026-08-01..2026-08-03', nowMs: 1_754_000_000_001 },
    )
    expect(artifact).not.toBeNull()
    expect(parseScrapeErrorKey(artifact!.key, PREFIX)).toEqual({
      compId: COMP,
      jobKey: '2026-08-01..2026-08-03',
      savedAtMs: 1_754_000_000_001,
      ext: 'json',
    })
  })

  it('別 prefix / 階層違い / ファイル名違い / 桁あふれは null', () => {
    // prefix 外 (staging の口で本番の key を渡した等)
    expect(parseScrapeErrorKey('etc-errors/1/2026-08-01/1.bin', PREFIX)).toBeNull()
    // 階層が 3 でない
    expect(parseScrapeErrorKey('dtako-scrape-errors/75700192/1754000000000.bin', PREFIX)).toBeNull()
    expect(parseScrapeErrorKey('dtako-scrape-errors/a/b/c/1.bin', PREFIX)).toBeNull()
    // 数字.拡張子 の形でない
    expect(parseScrapeErrorKey('dtako-scrape-errors/1/2026-08-01/x.bin', PREFIX)).toBeNull()
    expect(parseScrapeErrorKey('dtako-scrape-errors/1/2026-08-01/1754000000000', PREFIX)).toBeNull()
    // safe integer を超える
    expect(
      parseScrapeErrorKey('dtako-scrape-errors/1/2026-08-01/99999999999999999999.bin', PREFIX),
    ).toBeNull()
    // safe integer だが Date が表現できる範囲 (±8.64e15) の外
    expect(
      parseScrapeErrorKey('dtako-scrape-errors/1/2026-08-01/9000000000000000.bin', PREFIX),
    ).toBeNull()
  })
})

describe('parseScrapeErrorListRequest', () => {
  it('comp_id が無い / 数字でないと 400 の文言', () => {
    expect(parseScrapeErrorListRequest({})).toEqual({ error: 'comp_id が必要です (数字のみ)' })
    expect(parseScrapeErrorListRequest({ comp_id: 123 })).toEqual({
      error: 'comp_id が必要です (数字のみ)',
    })
    expect(parseScrapeErrorListRequest({ comp_id: '../' })).toEqual({
      error: 'comp_id が必要です (数字のみ)',
    })
  })

  it('job_key 省略 (undefined / null) は comp 配下ぜんぶ、既定 limit は 50', () => {
    expect(parseScrapeErrorListRequest({ comp_id: COMP })).toEqual({
      compId: COMP,
      jobKey: null,
      limit: SCRAPE_ERROR_LIST_DEFAULT_LIMIT,
    })
    expect(parseScrapeErrorListRequest({ comp_id: COMP, job_key: null, limit: null })).toEqual({
      compId: COMP,
      jobKey: null,
      limit: SCRAPE_ERROR_LIST_DEFAULT_LIMIT,
    })
    expect(SCRAPE_ERROR_LIST_DEFAULT_LIMIT).toBe(50)
  })

  it('job_key は YYYY-MM-DD / 期間形式のみ (それ以外は 400)', () => {
    expect(parseScrapeErrorListRequest({ comp_id: COMP, job_key: '2026-08-01' })).toMatchObject({
      jobKey: '2026-08-01',
    })
    expect(
      parseScrapeErrorListRequest({ comp_id: COMP, job_key: '2026-08-01..2026-08-03' }),
    ).toMatchObject({ jobKey: '2026-08-01..2026-08-03' })
    for (const bad of ['2026-8-1', '', '../..', 20260801]) {
      expect(parseScrapeErrorListRequest({ comp_id: COMP, job_key: bad })).toEqual({
        error: 'job_key は YYYY-MM-DD か YYYY-MM-DD..YYYY-MM-DD です',
      })
    }
  })

  it('limit は 1 以上の整数のみ。上限は黙って捨てず MAX へ丸めて返す', () => {
    expect(parseScrapeErrorListRequest({ comp_id: COMP, limit: 3 })).toMatchObject({ limit: 3 })
    expect(parseScrapeErrorListRequest({ comp_id: COMP, limit: 100_000 })).toMatchObject({
      limit: SCRAPE_ERROR_LIST_MAX_LIMIT,
    })
    for (const bad of [0, -1, 1.5, '10']) {
      expect(parseScrapeErrorListRequest({ comp_id: COMP, limit: bad })).toEqual({
        error: 'limit は 1 以上の整数です',
      })
    }
  })
})

describe('parseScrapeErrorObjectRequest', () => {
  it('key が無いと 400', () => {
    expect(parseScrapeErrorObjectRequest({}, PREFIX)).toEqual({ error: 'key が必要です' })
    expect(parseScrapeErrorObjectRequest({ key: 42 }, PREFIX)).toEqual({ error: 'key が必要です' })
  })

  /**
   * ★ この 1 本が「診断の口が bucket 全体の read 口にならない」担保。`DTAKO_R2` は
   * ETC 明細 CSV / 拘束サマリ / 賃金マスタ / NET780 と同じ bucket を共有している。
   */
  it('{prefix}-errors/ の外の key は拒否する', () => {
    for (const outside of [
      'etc/75700192/2026-08-01/120000.csv',
      'restraint/75700192/2026-08/summary.json',
      'dtako-scrape/75700192/x.zip',
      'dtako-scrape-staging-errors/1/2026-08-01/1.bin',
    ]) {
      expect(parseScrapeErrorObjectRequest({ key: outside }, PREFIX)).toEqual({
        error: 'key は dtako-scrape-errors/ 配下だけです',
      })
    }
  })

  it('full は明示の true のときだけ立つ', () => {
    const key = 'dtako-scrape-errors/75700192/2026-08-01/1754000000000.bin'
    expect(parseScrapeErrorObjectRequest({ key }, PREFIX)).toEqual({ key, full: false })
    expect(parseScrapeErrorObjectRequest({ key, full: 'true' }, PREFIX)).toEqual({ key, full: false })
    expect(parseScrapeErrorObjectRequest({ key, full: true }, PREFIX)).toEqual({ key, full: true })
  })
})

describe('compareScrapeErrorRows (新しい順)', () => {
  it('時刻が違えば新しい方が先', () => {
    expect(compareScrapeErrorRows({ sortMs: 1, key: 'a' }, { sortMs: 2, key: 'b' })).toBeGreaterThan(0)
    expect(compareScrapeErrorRows({ sortMs: 2, key: 'a' }, { sortMs: 1, key: 'b' })).toBeLessThan(0)
  })

  it('時刻が無い行は必ず後ろ', () => {
    expect(compareScrapeErrorRows({ sortMs: null, key: 'a' }, { sortMs: 1, key: 'b' })).toBe(1)
    expect(compareScrapeErrorRows({ sortMs: 1, key: 'a' }, { sortMs: null, key: 'b' })).toBe(-1)
  })

  /** 両引数順で呼んで、key 降順の**両側**を通す (sort に任せると引数順が実装依存)。 */
  it('時刻が同じなら key の降順 (両引数順)', () => {
    expect(compareScrapeErrorRows({ sortMs: 5, key: 'a' }, { sortMs: 5, key: 'b' })).toBe(1)
    expect(compareScrapeErrorRows({ sortMs: 5, key: 'b' }, { sortMs: 5, key: 'a' })).toBe(-1)
  })

  it('両方とも時刻が無ければ key の降順 (両引数順)', () => {
    expect(compareScrapeErrorRows({ sortMs: null, key: 'a' }, { sortMs: null, key: 'b' })).toBe(1)
    expect(compareScrapeErrorRows({ sortMs: null, key: 'b' }, { sortMs: null, key: 'a' })).toBe(-1)
  })
})

describe('buildScrapeErrorListing', () => {
  const k = (jobKey: string, ms: number, ext = 'bin') =>
    `dtako-scrape-errors/${COMP}/${jobKey}/${ms}.${ext}`

  it('新しい順に並べ、key から comp/読取日/保存時刻/拡張子を復元する', () => {
    const listing = buildScrapeErrorListing(
      [
        { key: k('2026-08-01', 1_754_000_000_000), size: 10_546 },
        { key: k('2026-08-03', 1_754_200_000_000, 'json'), size: 4_800 },
        { key: k('2026-08-02', 1_754_100_000_000), size: 10_291 },
      ],
      PREFIX,
      50,
    )
    expect(listing.items.map((i) => i.job_key)).toEqual(['2026-08-03', '2026-08-02', '2026-08-01'])
    expect(listing.items[0]).toEqual({
      key: k('2026-08-03', 1_754_200_000_000, 'json'),
      size: 4_800,
      comp_id: COMP,
      job_key: '2026-08-03',
      saved_at: '2025-08-03T05:46:40.000Z',
      saved_at_source: 'key',
      ext: 'json',
    })
    expect(listing.total).toBe(3)
    expect(listing.truncated).toBe(false)
    expect(listing.unparsed).toBe(0)
  })

  it('読取日ごとの件数は limit で切る前の全件から出す (分布が調査の入口)', () => {
    const objects = [
      { key: k('2026-08-01', 1), size: 1 },
      { key: k('2026-08-01', 2), size: 1 },
      { key: k('2026-08-02', 3), size: 1 },
    ]
    const listing = buildScrapeErrorListing(objects, PREFIX, 1)
    expect(listing.items).toHaveLength(1)
    expect(listing.total).toBe(3)
    expect(listing.truncated).toBe(true)
    expect(listing.limit).toBe(1)
    // ★ 切った後の 1 件ではなく、全 3 件の分布が出る
    expect(listing.counts_by_job_key).toEqual({ '2026-08-01': 2, '2026-08-02': 1 })
  })

  it('解けない key は捨てず unparsed に数え、uploaded を時刻の代わりに使う', () => {
    const listing = buildScrapeErrorListing(
      [
        { key: 'dtako-scrape-errors/75700192/2026-08-01/hand-written.bin', size: 5, uploaded: new Date(1_754_300_000_000) },
        { key: k('2026-08-01', 1_754_000_000_000), size: 10 },
      ],
      PREFIX,
      50,
    )
    expect(listing.unparsed).toBe(1)
    // uploaded (1754300000000) の方が新しいので先頭
    expect(listing.items[0]).toEqual({
      key: 'dtako-scrape-errors/75700192/2026-08-01/hand-written.bin',
      size: 5,
      comp_id: null,
      job_key: null,
      saved_at: '2025-08-04T09:33:20.000Z',
      saved_at_source: 'uploaded',
      ext: null,
    })
    // 解けなかった key は counts に載らない (載せると読取日を捏造することになる)
    expect(listing.counts_by_job_key).toEqual({ '2026-08-01': 1 })
  })

  it('key も uploaded も読めなければ saved_at_source は unknown で末尾に回る', () => {
    const listing = buildScrapeErrorListing(
      [
        { key: 'dtako-scrape-errors/x.bin', size: 1 },
        { key: 'dtako-scrape-errors/y.bin', size: 1, uploaded: null },
        { key: 'dtako-scrape-errors/z.bin', size: 1, uploaded: new Date('invalid') },
        { key: k('2026-08-01', 1_754_000_000_000), size: 1 },
      ],
      PREFIX,
      50,
    )
    expect(listing.items[0].saved_at_source).toBe('key')
    expect(listing.items.slice(1).map((i) => i.saved_at_source)).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ])
    expect(listing.items.slice(1).map((i) => i.saved_at)).toEqual([null, null, null])
    // 時刻が無い者どうしは key の降順で安定する
    expect(listing.items.slice(1).map((i) => i.key)).toEqual([
      'dtako-scrape-errors/z.bin',
      'dtako-scrape-errors/y.bin',
      'dtako-scrape-errors/x.bin',
    ])
  })

  it('空の list は 0 件 (truncated も false)', () => {
    expect(buildScrapeErrorListing([], PREFIX, 50)).toEqual({
      items: [],
      total: 0,
      limit: 50,
      truncated: false,
      counts_by_job_key: {},
      unparsed: 0,
    })
  })
})

describe('decodeScrapeErrorBody', () => {
  it('charset が無ければ utf-8 (fallback ではない)', () => {
    const decoded = decodeScrapeErrorBody(utf8('<html>あ</html>'), 'application/octet-stream')
    expect(decoded).toEqual({ text: '<html>あ</html>', charset: 'utf-8', charsetFallback: false })
  })

  it('contentType の charset を使う', () => {
    const decoded = decodeScrapeErrorBody(utf8('あ'), 'text/html; charset="UTF-8"')
    expect(decoded.charset).toBe('utf-8')
    expect(decoded.charsetFallback).toBe(false)
    expect(decoded.text).toBe('あ')
  })

  it('contentType に無ければ <meta charset> を見る', () => {
    const decoded = decodeScrapeErrorBody(
      utf8('<html><head><meta charset="utf-8"><title>x</title></head></html>'),
      'text/html',
    )
    expect(decoded.charset).toBe('utf-8')
    expect(decoded.charsetFallback).toBe(false)
  })

  /**
   * ランタイムが知らない charset を宣言されても落とさず utf-8 で読む。**「読めた」と
   * 「読めたつもり」を分ける**ため、落ちたことは charsetFallback に出す。
   */
  it('知らない charset は utf-8 に落として charsetFallback を立てる', () => {
    const decoded = decodeScrapeErrorBody(utf8('hello'), 'text/html; charset=x-nonexistent-999')
    expect(decoded).toEqual({ text: 'hello', charset: 'utf-8', charsetFallback: true })
  })
})

describe('extractHtmlTitle', () => {
  it('<title> を抜き、空白を畳む', () => {
    expect(extractHtmlTitle('<html><head><title>\n  システム\tエラー </title></head>')).toBe(
      'システム エラー',
    )
    expect(extractHtmlTitle('<TITLE lang="ja">x</TITLE>')).toBe('x')
  })

  it('無い / 空なら null', () => {
    expect(extractHtmlTitle('PKbinary')).toBeNull()
    expect(extractHtmlTitle('<title>   </title>')).toBeNull()
  })

  /** ★ 本文全体から探す。4KB で切ってから探すと「title が後ろに在っただけ」を
   * 「title が無い」と報告してしまう。 */
  it('4KB より後ろにある <title> も拾える', () => {
    const text = `<!--${'x'.repeat(EVIDENCE_BODY_PREFIX_MAX + 100)}--><title>遅れて来たタイトル</title>`
    expect(extractHtmlTitle(text)).toBe('遅れて来たタイトル')
  })

  it('壊れた HTML で </title> が遥か後ろでも上限で切る', () => {
    const title = extractHtmlTitle(`<title>${'あ'.repeat(5000)}</title>`)
    expect(title).toHaveLength(SCRAPE_ERROR_TITLE_MAX)
  })
})

describe('parseScrapeErrorJsonMeta', () => {
  it('.json 原本から kind/message/comp_id/job_key/evidence を取り出す', () => {
    const artifact = buildScrapeErrorArtifact(
      new TheearthPageMismatchError(
        'CSV フォームの要素 (id=rdoSelect1) が見つかりません',
        {
          status: 200,
          contentType: 'text/html; charset=Shift_JIS',
          bodyLength: 10_546,
          elapsedMs: 1_200,
          hasLoginForm: false,
          page: 'システムエラー',
        },
        '<html><title>システムエラー</title>秘密っぽい本文</html>',
      ),
      { prefix: PREFIX, compId: COMP, jobKey: '2026-08-01', nowMs: 1 },
    )
    const meta = parseScrapeErrorJsonMeta(artifact!.body as string)
    expect(meta).toMatchObject({
      kind: 'page_mismatch',
      message: 'CSV フォームの要素 (id=rdoSelect1) が見つかりません',
      comp_id: COMP,
      job_key: '2026-08-01',
    })
    expect(meta!.evidence.page).toBe('システムエラー')
    // ★ 生ページ (body_prefix) は meta に載せない — 切り詰め / full の規則に従わせる
    expect(Object.keys(meta!)).not.toContain('body_prefix')
    expect(JSON.stringify(meta)).not.toContain('秘密っぽい本文')
  })

  it('JSON でない / object でない / kind・message が無いものは null', () => {
    expect(parseScrapeErrorJsonMeta('<html>')).toBeNull()
    expect(parseScrapeErrorJsonMeta('123')).toBeNull()
    expect(parseScrapeErrorJsonMeta('null')).toBeNull()
    expect(parseScrapeErrorJsonMeta('{"message":"x"}')).toBeNull()
    expect(parseScrapeErrorJsonMeta('{"kind":"page_mismatch"}')).toBeNull()
  })

  it('comp_id / job_key / evidence が欠けていても kind・message があれば読む', () => {
    expect(parseScrapeErrorJsonMeta('{"kind":"k","message":"m"}')).toEqual({
      kind: 'k',
      message: 'm',
      comp_id: '',
      job_key: '',
      evidence: null,
    })
  })
})

describe('buildScrapeErrorObjectPayload', () => {
  const KEY = `dtako-scrape-errors/${COMP}/2026-08-01/1754000000000.bin`

  it('既定は先頭 4096 文字だけを返し、<title> は別に返す', () => {
    const html = `<html><head><title>システムエラー</title></head><body>${'あ'.repeat(20_000)}</body></html>`
    const payload = buildScrapeErrorObjectPayload({
      key: KEY,
      prefix: PREFIX,
      bytes: utf8(html),
      contentType: 'text/html; charset=utf-8',
      full: false,
    })
    expect(payload.title).toBe('システムエラー')
    expect(payload.body_prefix).toHaveLength(EVIDENCE_BODY_PREFIX_MAX)
    expect(payload.body_truncated).toBe(true)
    expect(payload.body_chars).toBe(html.length)
    expect(payload.full).toBe(false)
    // bytes は生バイト数 (切る前)。UTF-8 の日本語は 3 バイトなので文字数とは違う
    expect(payload.bytes).toBe(utf8(html).byteLength)
    expect(payload.bytes).toBeGreaterThan(payload.body_prefix.length)
    expect(payload).toMatchObject({
      key: KEY,
      content_type: 'text/html; charset=utf-8',
      comp_id: COMP,
      job_key: '2026-08-01',
      saved_at: '2025-07-31T22:13:20.000Z',
      saved_at_source: 'key',
      ext: 'bin',
      charset: 'utf-8',
      charset_fallback: false,
      json_meta: null,
    })
  })

  /**
   * ★ 陰性対照。`buildScrapeErrorObjectPayload` から `.slice(0, EVIDENCE_BODY_PREFIX_MAX)`
   * を外すと、この it は `body_prefix` に 20000 文字が入って落ちる (実測で確認、
   * 詳細は PR 本文)。**「通っているテストが何も検査していない」を防ぐための 1 本。**
   */
  it('切り詰めを外すと落ちる: 20000 文字の本文でも返るのは 4096 文字だけ', () => {
    const payload = buildScrapeErrorObjectPayload({
      key: KEY,
      prefix: PREFIX,
      bytes: utf8('x'.repeat(20_000)),
      contentType: 'text/html',
      full: false,
    })
    expect(payload.body_prefix.length).toBeLessThanOrEqual(EVIDENCE_BODY_PREFIX_MAX)
    expect(payload.body_prefix.length).toBe(4096)
    expect(payload.body_chars).toBe(20_000)
    expect(payload.body_truncated).toBe(true)
  })

  it('full: true なら全文。切っていないので body_truncated は false', () => {
    const html = `<html>${'あ'.repeat(20_000)}</html>`
    const payload = buildScrapeErrorObjectPayload({
      key: KEY,
      prefix: PREFIX,
      bytes: utf8(html),
      contentType: 'text/html',
      full: true,
    })
    expect(payload.body_prefix).toBe(html)
    expect(payload.body_truncated).toBe(false)
    expect(payload.full).toBe(true)
  })

  it('4096 文字ちょうどなら切っていない (境界で truncated を立てない)', () => {
    const text = 'x'.repeat(EVIDENCE_BODY_PREFIX_MAX)
    const payload = buildScrapeErrorObjectPayload({
      key: KEY,
      prefix: PREFIX,
      bytes: utf8(text),
      contentType: 'text/plain',
      full: false,
    })
    expect(payload.body_truncated).toBe(false)
    expect(payload.body_prefix).toHaveLength(EVIDENCE_BODY_PREFIX_MAX)
  })

  it('contentType が無ければ content_type は null で utf-8 として読む', () => {
    const payload = buildScrapeErrorObjectPayload({
      key: KEY,
      prefix: PREFIX,
      bytes: utf8('plain'),
      contentType: undefined,
      full: false,
    })
    expect(payload.content_type).toBeNull()
    expect(payload.charset).toBe('utf-8')
    expect(payload.title).toBeNull()
  })

  it('key が解けなければ uploaded を保存時刻に使い、出どころを明示する', () => {
    const payload = buildScrapeErrorObjectPayload({
      key: 'dtako-scrape-errors/hand-written.bin',
      prefix: PREFIX,
      bytes: utf8('x'),
      contentType: null,
      full: false,
      uploaded: new Date(1_754_300_000_000),
    })
    expect(payload).toMatchObject({
      comp_id: null,
      job_key: null,
      ext: null,
      saved_at: '2025-08-04T09:33:20.000Z',
      saved_at_source: 'uploaded',
    })
  })

  it('key も uploaded も無ければ saved_at は null / unknown', () => {
    const payload = buildScrapeErrorObjectPayload({
      key: 'dtako-scrape-errors/hand-written.bin',
      prefix: PREFIX,
      bytes: utf8('x'),
      contentType: null,
      full: false,
    })
    expect(payload.saved_at).toBeNull()
    expect(payload.saved_at_source).toBe('unknown')
  })

  it('.json 原本は json_meta に構造化されたメタが載る (生ページは載らない)', () => {
    const artifact = buildScrapeErrorArtifact(
      new TheearthPageMismatchError(
        'ページ違い',
        {
          status: 200,
          contentType: 'text/html',
          bodyLength: 3,
          elapsedMs: 1,
          hasLoginForm: true,
          page: 'ログイン',
        },
        '<html>セッションIDらしき文字列</html>',
      ),
      { prefix: PREFIX, compId: COMP, jobKey: '2026-08-01', nowMs: 1_754_000_000_000 },
    )
    const payload = buildScrapeErrorObjectPayload({
      key: artifact!.key,
      prefix: PREFIX,
      bytes: utf8(artifact!.body as string),
      contentType: artifact!.contentType,
      full: false,
    })
    expect(payload.ext).toBe('json')
    expect(payload.json_meta).toMatchObject({ kind: 'page_mismatch', message: 'ページ違い' })
    expect(JSON.stringify(payload.json_meta)).not.toContain('セッションIDらしき文字列')
  })

  /** `.bin` 原本 (ZIP でない応答) を、保存側が作ったバイト列そのままで読む。 */
  it('.bin 原本 (TheearthNotZipError の生バイト) を読める', () => {
    const html = '<html><head><title>ただいま混み合っています</title></head></html>'
    const artifact = buildScrapeErrorArtifact(
      new TheearthNotZipError(
        '取得したデータが ZIP ではありません',
        utf8(html).buffer as ArrayBuffer,
        'text/html; charset=utf-8',
      ),
      { prefix: PREFIX, compId: COMP, jobKey: '2026-08-01', nowMs: 1_754_000_000_000 },
    )
    const payload = buildScrapeErrorObjectPayload({
      key: artifact!.key,
      prefix: PREFIX,
      bytes: new Uint8Array(artifact!.body as ArrayBuffer),
      contentType: artifact!.contentType,
      full: false,
    })
    expect(payload.ext).toBe('bin')
    expect(payload.title).toBe('ただいま混み合っています')
    expect(payload.json_meta).toBeNull()
    expect(payload.body_truncated).toBe(false)
  })
})
