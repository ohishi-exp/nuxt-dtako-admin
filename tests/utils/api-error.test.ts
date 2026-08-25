import { describe, it, expect } from 'vitest'

import { describeApiError } from '~/utils/api-error'
import { marginSummarySaveNote } from '~/utils/margin-r2'

describe('describeApiError', () => {
  /** 既定の message は status しか持たない。**理由は upstream の本文にある。** */
  it('本文の error を拾って status と並べる', () => {
    expect(describeApiError({
      statusCode: 503,
      data: { error: '[kintai_push] が無効です (書き先がありません)' },
      message: '[GET] "/api/kyuyo/wage-range": 503',
    })).toBe('503 [kintai_push] が無効です (書き先がありません)')
  })

  it('本文の error が文字列なら message より先に拾う (順序は変えていない)', () => {
    expect(describeApiError({
      statusCode: 503,
      data: { error: 'upstream が落ちています', message: 'Service Unavailable' },
    })).toBe('503 upstream が落ちています')
  })

  it('本文が文字列でも拾う', () => {
    expect(describeApiError({ statusCode: 502, data: 'upstream down' })).toBe('502 upstream down')
  })

  it('data.message / statusMessage にも落ちる', () => {
    expect(describeApiError({ statusCode: 400, data: { message: 'month は YYYY-MM' } }))
      .toBe('400 month は YYYY-MM')
    expect(describeApiError({ statusCode: 401, statusMessage: 'Unauthorized' }))
      .toBe('401 Unauthorized')
  })

  it('status が無ければ理由だけ', () => {
    expect(describeApiError(new Error('Failed to fetch'))).toBe('Failed to fetch')
  })

  it('何も無くても文字列を返す', () => {
    expect(describeApiError(null)).toBe('null')
    // 拾える文言が無ければ String(e) に落ちる (黙って空文字にしない)
    expect(describeApiError({ statusCode: 500, data: {} })).toBe('500 [object Object]')
  })

  /**
   * **`data: null` でも落ちない** (`typeof null === 'object'` なので `!== null` の側で外す)。
   * 本文が空の 502 を返す中継が実在するので、`err.data` が null で来る形は起こりうる。
   */
  it('本文が null でも status に落ちる', () => {
    expect(describeApiError({ statusCode: 502, data: null, message: 'Bad Gateway' }))
      .toBe('502 Bad Gateway')
  })
})

describe('describeApiError — 自前の server/api の日本語 (Refs #890)', () => {
  /**
   * ofetch の `FetchError.message` は HTTP の reason phrase から組まれるので
   * **日本語だけが抜ける**。本文には無傷で残っているので、そちらを読めば元の 1 文になる。
   */
  const message = 'schemaVersion(=2)/ym/totals/cache (ym 一致)/fuelRateOverrides/runCostShareMode が必要です'
  const fetchError = {
    statusCode: 400,
    // reason phrase 由来 — **日本語が消えた**姿 (`一致` と `が必要です` が無い)
    statusMessage: 'schemaVersion(=2)/ym/totals/cache (ym )/fuelRateOverrides/runCostShareMode ',
    message: '[POST] "/api/profit/margin-summary": 400 schemaVersion(=2)/ym/totals/cache (ym )/fuelRateOverrides/runCostShareMode ',
    // JSON 本文 — 日本語が残っている側。**dev の実機 400 から写した形**
    // (`npx wrangler dev` + `POST /api/profit/margin-summary` に形式 1 の body)。
    // ★ `error` は**真偽値**。ここが `??` を使えない理由 (Refs #890)。
    data: { error: true, url: 'http://dtako.ippoan.org/api/profit/margin-summary', statusCode: 400, statusMessage: message, message },
  }

  it('★ 本文の `error` が真偽値でも、`message` の日本語に落ちる', () => {
    // `d.error ?? d.message` だと `true` で止まり、reason phrase 由来の
    // 「日本語が抜けた文」に落ちてしまう。**文字列である最初の 1 つ**を選ぶ。
    expect(fetchError.data.error).toBe(true)
    expect(describeApiError(fetchError)).toContain('が必要です')
  })

  it('画面に出ていた「日本語が抜けた文」が、本文の 1 文に戻る', () => {
    // 直す前 (`e instanceof Error ? e.message : String(e)`) が拾っていたもの
    expect(fetchError.message).not.toContain('一致')
    expect(fetchError.message).not.toContain('が必要です')
    // 直した後
    expect(describeApiError(fetchError)).toBe(`400 ${message}`)
  })

  /**
   * ★ `data.message` を `data.statusMessage` より先に見る順序が効いていること。
   * `H3Error.toJSON()` の経路は **`statusMessage` だけを sanitize** して `message` を
   * 素通しするので、その日が来ても `message` 側から日本語を拾える。
   */
  it('本文の statusMessage が sanitize 済みでも、message から日本語を拾う', () => {
    expect(describeApiError({
      statusCode: 400,
      data: { error: true, statusMessage: 'schemaVersion(=2)/ym/totals/cache (ym )/', message },
    })).toBe(`400 ${message}`)
  })

  /** 合成後の 1 文で読む — 注記に埋め込まれたときに日本語が出ること。 */
  it('保存失敗の注記に、日本語のまま埋め込まれる', () => {
    const note = marginSummarySaveNote(null, describeApiError(fetchError))
    expect(note).toContain(`(400 ${message})`)
    expect(note).toContain('cache (ym 一致)')
    expect(note).toContain('が必要です')
  })
})
