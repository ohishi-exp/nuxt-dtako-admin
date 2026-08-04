import { describe, expect, it } from 'vitest'
import {
  buildScrapeErrorArtifact,
  scrapeErrorR2Key,
  type PageMismatchArtifactBody,
} from '../src/scrape-error-artifact'
import {
  EMPTY_ZIP_BYTE_LENGTH,
  TheearthClientError,
  TheearthNotZipError,
  TheearthPageMismatchError,
  VenusSessionExpiredError,
  type TheearthEvidence,
} from '../src/theearth-client'

const INPUT = {
  prefix: 'dtako-scrape',
  compId: '75700192',
  jobKey: '2026-08-01',
  nowMs: 1_754_000_000_000,
}

const EVIDENCE: TheearthEvidence = {
  status: 200,
  contentType: 'text/html; charset=utf-8',
  bodyLength: 10546,
  elapsedMs: 1234,
  hasLoginForm: false,
  page: 'システムエラー | ただいま混み合っています',
}

function emptyZip(): ArrayBuffer {
  const bytes = new Uint8Array(EMPTY_ZIP_BYTE_LENGTH)
  bytes.set([0x50, 0x4b, 0x05, 0x06])
  return bytes.buffer as ArrayBuffer
}

describe('scrapeErrorR2Key', () => {
  it('ETC の {prefix}-errors/ と同じ規範に揃える (新しい規範を作らない)', () => {
    expect(scrapeErrorR2Key(INPUT, 'bin')).toBe('dtako-scrape-errors/75700192/2026-08-01/1754000000000.bin')
  })

  it('範囲指定 (jobKey が YYYY-MM-DD..YYYY-MM-DD) でも階層が壊れない', () => {
    const key = scrapeErrorR2Key({ ...INPUT, jobKey: '2026-08-01..2026-08-03' }, 'json')
    expect(key).toBe('dtako-scrape-errors/75700192/2026-08-01..2026-08-03/1754000000000.json')
  })

  it('env ごとの prefix がそのまま効く (本番と staging は同じ bucket を見るため)', () => {
    expect(scrapeErrorR2Key({ ...INPUT, prefix: 'dtako-scrape-staging' }, 'bin')).toContain(
      'dtako-scrape-staging-errors/',
    )
  })
})

describe('buildScrapeErrorArtifact — ZIP でない応答 (TheearthNotZipError)', () => {
  it('**生バイトをそのまま残す** — HTML のエラーページ等は中身を見ないと分からない', () => {
    const body = new TextEncoder().encode('<html>error</html>').buffer as ArrayBuffer
    const err = new TheearthNotZipError('取得したデータが ZIP ではありません (18 bytes)', body, 'text/html')
    const artifact = buildScrapeErrorArtifact(err, INPUT)
    expect(artifact).not.toBeNull()
    expect(artifact!.key).toBe('dtako-scrape-errors/75700192/2026-08-01/1754000000000.bin')
    expect(artifact!.body).toBe(body)
    expect(artifact!.contentType).toBe('text/html')
  })

  it('content-type が空なら application/octet-stream に倒す (ETC の保存と同じ)', () => {
    const err = new TheearthNotZipError('x', new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, '')
    expect(buildScrapeErrorArtifact(err, INPUT)!.contentType).toBe('application/octet-stream')
  })

  it('**空 ZIP は保存しない** — EOCD 22 bytes に情報が無く、未来日プローブのたびにゴミが溜まる', () => {
    const err = new TheearthNotZipError('取得したデータが空の ZIP です (22 bytes)', emptyZip(), 'application/zip')
    expect(buildScrapeErrorArtifact(err, INPUT)).toBeNull()
  })
})

describe('buildScrapeErrorArtifact — 想定と違うページ (TheearthPageMismatchError)', () => {
  it('evidence と本文先頭を JSON で残す (console は数日で消えるため)', () => {
    const err = new TheearthPageMismatchError(
      'CSV フォームの要素 (id=rdoSelect1) が見つかりません',
      EVIDENCE,
      '<html><body>ただいま混み合っています</body></html>',
    )
    const artifact = buildScrapeErrorArtifact(err, INPUT)
    expect(artifact!.key).toBe('dtako-scrape-errors/75700192/2026-08-01/1754000000000.json')
    expect(artifact!.contentType).toBe('application/json; charset=utf-8')

    const parsed = JSON.parse(artifact!.body as string) as PageMismatchArtifactBody
    expect(parsed.kind).toBe('page_mismatch')
    expect(parsed.message).toContain('rdoSelect1')
    expect(parsed.comp_id).toBe('75700192')
    expect(parsed.job_key).toBe('2026-08-01')
    expect(parsed.evidence).toEqual(EVIDENCE)
    expect(parsed.body_prefix).toContain('ただいま混み合っています')
  })
})

describe('buildScrapeErrorArtifact — 残す原本が無い error', () => {
  it('セッション切れは null (応答本体を持っていない。message で足りる)', () => {
    expect(buildScrapeErrorArtifact(new VenusSessionExpiredError('切れました'), INPUT)).toBeNull()
  })

  it('その他の TheearthClientError も null', () => {
    expect(buildScrapeErrorArtifact(new TheearthClientError('ログインに失敗しました'), INPUT)).toBeNull()
  })

  it('Error ですらない値 (想定外) でも落ちずに null', () => {
    expect(buildScrapeErrorArtifact('boom', INPUT)).toBeNull()
    expect(buildScrapeErrorArtifact(undefined, INPUT)).toBeNull()
  })
})
