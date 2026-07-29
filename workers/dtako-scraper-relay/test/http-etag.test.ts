import { describe, expect, it } from 'vitest'
import { etagMatches, weakEtag } from '../src/http-etag'

describe('weakEtag', () => {
  it('sha256 hex を W/"..." 形式に組む', () => {
    expect(weakEtag('abc123')).toBe('W/"abc123"')
  })
})

describe('etagMatches', () => {
  const etag = weakEtag('abc123')

  it('ヘッダ無し・空文字は不一致', () => {
    expect(etagMatches(null, etag)).toBe(false)
    expect(etagMatches('', etag)).toBe(false)
  })

  it('同じ弱い ETag は一致 (弱い比較)', () => {
    expect(etagMatches('W/"abc123"', etag)).toBe(true)
  })

  it('強い形 ("...") とも W/ を外して一致する', () => {
    expect(etagMatches('"abc123"', etag)).toBe(true)
  })

  it('カンマ区切りの候補列から探す (空白許容)', () => {
    expect(etagMatches('W/"zzz", W/"abc123"', etag)).toBe(true)
    expect(etagMatches('W/"zzz", W/"yyy"', etag)).toBe(false)
  })

  it('* は常に一致', () => {
    expect(etagMatches('*', etag)).toBe(true)
    expect(etagMatches(' * ', etag)).toBe(true)
  })

  it('値が違えば不一致', () => {
    expect(etagMatches('W/"def456"', etag)).toBe(false)
  })
})
