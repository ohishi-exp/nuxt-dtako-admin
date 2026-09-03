import { describe, expect, it } from 'vitest'
import { corsHeaders } from '../src/cors'

const ALLOWED = 'https://example.invalid'

describe('corsHeaders', () => {
  it('完全一致したときだけ許可ヘッダを付ける', () => {
    expect(corsHeaders(ALLOWED, ALLOWED)).toEqual({
      Vary: 'Origin',
      'Access-Control-Allow-Origin': ALLOWED,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    })
  })

  it('env の前後空白は落とす', () => {
    expect(corsHeaders(ALLOWED, `  ${ALLOWED}  `)['Access-Control-Allow-Origin']).toBe(ALLOWED)
  })

  it('Vary: Origin は常に付く', () => {
    expect(corsHeaders(null, undefined)).toEqual({ Vary: 'Origin' })
  })

  // 陰性対照: 「似ているだけ」のオリジンは 1 つも通らない。
  it.each([
    ['後方一致を狙う', 'https://evil-example.invalid'],
    ['サブドメイン', 'https://x.example.invalid'],
    ['scheme 違い', 'http://example.invalid'],
    ['port 付き', 'https://example.invalid:8443'],
    ['末尾 /', 'https://example.invalid/'],
    ['Origin 無し (curl)', null],
  ])('%s は許可ヘッダを得ない', (_label, origin) => {
    expect(corsHeaders(origin, ALLOWED)).toEqual({ Vary: 'Origin' })
  })

  // 陰性対照: 変数未設定なら誰にも CORS を返さない。
  it.each([undefined, '', '   '])('allowedOrigin=%o なら許可ヘッダ無し', (allowed) => {
    expect(corsHeaders(ALLOWED, allowed)).toEqual({ Vary: 'Origin' })
  })
})
