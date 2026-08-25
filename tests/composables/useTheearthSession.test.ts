import { describe, it, expect, afterEach, vi } from 'vitest'
import { ofetch } from 'ofetch'

import { theearthSessionErrorMessage, theearthSessionErrorStatus } from '~/composables/useTheearthSession'

/**
 * ★ **フィクスチャを手で書かない** (Refs #890)。
 *
 * #898 で「本文の形を手で書いた unit テストが、無益な実装を通してしまった」実害が
 * ある (`{ error: true, … }` の `error` が真偽値であることを写し損ねた)。ここでは
 * **本物の `ofetch` に本物の `Response` を食わせて、出てきた `FetchError` をそのまま
 * 渡す**。`e.data` が何になるか (JSON / Blob) を ofetch 自身に決めさせるのが要点。
 */
async function fetchErrorFrom(
  body: unknown,
  init: { status: number, contentType?: string },
  options: Record<string, unknown> = {},
): Promise<unknown> {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status: init.status, headers: { 'content-type': init.contentType ?? 'application/json' } },
  )))
  try {
    await ofetch('https://example.invalid/probe', options)
  }
  catch (e) {
    return e
  }
  throw new Error('エラーにならなかった (テストの前提が壊れている)')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theearthSessionErrorMessage — relay 経路 (既存の出力は変えない)', () => {
  /**
   * relay (`/dvr-api` `/net780-api` `/daily-report-api` `/restraint-api`) の本文は
   * `dtako-scraper-relay-do.ts` の `dvrJsonError` = `Response.json({ error: message })`。
   * `error` が**文字列**なので `find` の先頭で当たる ⇒ **後退しない**。
   */
  it('本文の error (文字列) をそのまま返す', async () => {
    const e = await fetchErrorFrom({ error: 'この運行はアーカイブにありません' }, { status: 404 })
    expect(theearthSessionErrorMessage(e)).toBe('この運行はアーカイブにありません')
  })

  it('error が message/statusMessage より先に当たる (順序を変えていない)', async () => {
    const e = await fetchErrorFrom(
      { error: 'セッションが失効しました', message: 'Unauthorized', statusMessage: 'Unauthorized' },
      { status: 401 },
    )
    expect(theearthSessionErrorMessage(e)).toBe('セッションが失効しました')
  })
})

describe('theearthSessionErrorMessage — 自前 server/api 経路 (ここが直った、Refs #890)', () => {
  /**
   * Nitro の既定のエラー本文は **`error` が真偽値**
   * (`nitropack/dist/runtime/internal/error/prod.mjs` の `defaultHandler`)。
   * 以前は `typeof data.error === 'string'` に外れて `e.message` へ落ちていたので、
   * **日本語が丸ごと消えていた**。
   */
  const nitroBody = (statusMessage: string) => ({
    error: true,
    url: 'https://example.invalid/api/kyuyo/payroll',
    statusCode: 503,
    statusMessage,
    message: statusMessage,
  })

  it('error が真偽値でも message の日本語を拾う', async () => {
    const e = await fetchErrorFrom(nitroBody('kyuyo 認可が未設定です'), { status: 503 })
    // 直す前はここが `[GET] "https://example.invalid/probe": 503 …` になっていた
    expect(theearthSessionErrorMessage(e)).toBe('kyuyo 認可が未設定です')
  })

  it('message が無ければ statusMessage に落ちる', async () => {
    const e = await fetchErrorFrom(
      { error: true, statusCode: 400, statusMessage: 'month は YYYY-MM が必要です' },
      { status: 400 },
    )
    expect(theearthSessionErrorMessage(e)).toBe('month は YYYY-MM が必要です')
  })

  /**
   * ★ `describeApiError` と違い **`statusCode` を前置しない**。この関数の契約は
   * 「理由の文字列だけ」で、呼び出し側が説明文へ埋める。揃えてはいけない。
   */
  it('status を前置しない', async () => {
    const e = await fetchErrorFrom(nitroBody('PROFIT_R2 binding が未設定です'), { status: 503 })
    expect(theearthSessionErrorMessage(e)).toBe('PROFIT_R2 binding が未設定です')
    expect(theearthSessionErrorMessage(e)).not.toMatch(/^503/)
  })
})

describe('theearthSessionErrorMessage — 効かない相手 (後退していないことの確認)', () => {
  /**
   * ★ `responseType: 'blob'` だと ofetch は**エラー応答の本文も Blob として読む**ので
   * `e.data` が Blob になり、JSON のキーに 1 つも届かない (`net780/index.vue` の
   * `$fetch<Blob>('/net780-api/…')` がこれ)。**直す前と同じ `e.message` に落ちる** —
   * 直っても後退もしない、というのがここで固定したいこと。
   */
  it('responseType:blob では本文を読めず e.message に落ちる', async () => {
    const e = await fetchErrorFrom(
      { error: 'この運行はアーカイブにありません' },
      { status: 404 },
      { responseType: 'blob' },
    )
    expect((e as { data?: unknown }).data).toBeInstanceOf(Blob)
    expect(theearthSessionErrorMessage(e)).toBe((e as Error).message)
    expect(theearthSessionErrorMessage(e)).not.toContain('アーカイブ')
  })

  it('本文が JSON でなければ e.message に落ちる', async () => {
    const e = await fetchErrorFrom('<html>502 Bad Gateway</html>', { status: 502, contentType: 'text/html' })
    expect(theearthSessionErrorMessage(e)).toBe((e as Error).message)
  })

  it('生 fetch 側で本文を読んで投げた plain Error はそのまま', () => {
    expect(theearthSessionErrorMessage(new Error('csvdata.zip の取得に失敗しました (HTTP 500)')))
      .toBe('csvdata.zip の取得に失敗しました (HTTP 500)')
  })

  it('Error ですらなければ String(e)', () => {
    expect(theearthSessionErrorMessage('切断されました')).toBe('切断されました')
    expect(theearthSessionErrorMessage(null)).toBe('null')
    expect(theearthSessionErrorMessage(undefined)).toBe('undefined')
  })

  /** `data` が null の中継が実在する (`typeof null === 'object'` の穴を踏まない)。 */
  it('data が null でも落ちない', () => {
    expect(theearthSessionErrorMessage(Object.assign(new Error('Bad Gateway'), { data: null })))
      .toBe('Bad Gateway')
  })

  /** 本文が文字列そのものの場合は拾わない (この関数は元からオブジェクトしか見ない)。 */
  it('data が文字列でも e.message に落ちる (契約を広げていない)', () => {
    expect(theearthSessionErrorMessage(Object.assign(new Error('boom'), { data: 'upstream down' })))
      .toBe('boom')
  })
})

describe('theearthSessionErrorStatus (触っていない — 回帰確認)', () => {
  it('status が数値なら返す', async () => {
    const e = await fetchErrorFrom({ error: '失効しました' }, { status: 401 })
    expect(theearthSessionErrorStatus(e)).toBe(401)
  })

  it('数値でなければ null', () => {
    expect(theearthSessionErrorStatus(new Error('boom'))).toBeNull()
    expect(theearthSessionErrorStatus(null)).toBeNull()
  })
})
