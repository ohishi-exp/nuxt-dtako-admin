/**
 * `server/utils/browser-jwt.ts` — cookie → `Authorization: Bearer` 解決 (Refs #375)。
 *
 * **h3 を mock しない** — 実際の `getCookie` / `getHeader` に食わせられる最小の
 * event (`node.req.headers`) を組んで通す。cookie 名の綴りや `Bearer ` の前置の
 * ような「型では守れない」部分を、本物のパーサ越しに固定するのが目的。
 */
import { describe, it, expect } from 'vitest'
import type { H3Event } from 'h3'

import {
  resolveBrowserAuthorization,
  AUTH_COOKIE_NAME,
  DEV_AUTH_COOKIE_NAME,
} from '../../server/utils/browser-jwt'

function eventWith(headers: Record<string, string>): H3Event {
  return { node: { req: { headers } } } as unknown as H3Event
}

describe('resolveBrowserAuthorization (Refs #375)', () => {
  it('cookie (logi_auth_token) から Bearer を組む', () => {
    const event = eventWith({ cookie: `${AUTH_COOKIE_NAME}=jwt-cookie` })
    expect(resolveBrowserAuthorization(event, {})).toBe('Bearer jwt-cookie')
  })

  it('他の cookie が混ざっていても目的の 1 つだけを読む', () => {
    const event = eventWith({ cookie: `foo=1; ${AUTH_COOKIE_NAME}=jwt-cookie; bar=2` })
    expect(resolveBrowserAuthorization(event, {})).toBe('Bearer jwt-cookie')
  })

  /** cookie が最優先 — ヘッダは後方互換の最後の 1 段でしかない。 */
  it('cookie とヘッダが両方あれば cookie を優先する', () => {
    const event = eventWith({
      cookie: `${AUTH_COOKIE_NAME}=jwt-cookie`,
      authorization: 'Bearer jwt-header',
    })
    expect(resolveBrowserAuthorization(event, {})).toBe('Bearer jwt-cookie')
  })

  it('cookie が無ければ受領した Authorization をそのまま返す (デプロイ skew 用)', () => {
    const event = eventWith({ authorization: 'Bearer jwt-header' })
    expect(resolveBrowserAuthorization(event, {})).toBe('Bearer jwt-header')
  })

  it('cookie もヘッダも無ければ null', () => {
    expect(resolveBrowserAuthorization(eventWith({}), {})).toBeNull()
  })

  it('空文字 cookie は「無い」扱いにしてヘッダへ落ちる', () => {
    const event = eventWith({
      cookie: `${AUTH_COOKIE_NAME}=`,
      authorization: 'Bearer jwt-header',
    })
    expect(resolveBrowserAuthorization(event, {})).toBe('Bearer jwt-header')
  })

  describe('dev cookie (logi_auth_token_dev)', () => {
    it('DEV_LOGIN=true なら通常 cookie が無い時に dev cookie を拾う', () => {
      const event = eventWith({ cookie: `${DEV_AUTH_COOKIE_NAME}=jwt-dev` })
      expect(resolveBrowserAuthorization(event, { DEV_LOGIN: 'true' })).toBe('Bearer jwt-dev')
    })

    /** dev cookie は本番 cookie の代わりであって、優先はしない。 */
    it('通常 cookie があれば DEV_LOGIN=true でもそちらを使う', () => {
      const event = eventWith({
        cookie: `${AUTH_COOKIE_NAME}=jwt-cookie; ${DEV_AUTH_COOKIE_NAME}=jwt-dev`,
      })
      expect(resolveBrowserAuthorization(event, { DEV_LOGIN: 'true' })).toBe('Bearer jwt-cookie')
    })

    it('DEV_LOGIN が未設定なら dev cookie を見ない (本番・staging・preview)', () => {
      const event = eventWith({ cookie: `${DEV_AUTH_COOKIE_NAME}=jwt-dev` })
      expect(resolveBrowserAuthorization(event, {})).toBeNull()
    })

    it("DEV_LOGIN が 'true' 以外の文字列でも dev cookie を見ない", () => {
      const event = eventWith({ cookie: `${DEV_AUTH_COOKIE_NAME}=jwt-dev` })
      expect(resolveBrowserAuthorization(event, { DEV_LOGIN: 'false' })).toBeNull()
    })

    it('DEV_LOGIN=true でも dev cookie が無ければヘッダへ落ちる', () => {
      const event = eventWith({ authorization: 'Bearer jwt-header' })
      expect(resolveBrowserAuthorization(event, { DEV_LOGIN: 'true' })).toBe('Bearer jwt-header')
    })
  })
})
