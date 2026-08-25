import { describe, expect, it } from 'vitest'
import {
  buildLineworksSendBody,
  LINEWORKS_SEND_PATH,
  LineworksNotifyError,
  sendLineworksTextViaAlcInternalProxy,
  type FetchLike,
  type LineworksDestination,
} from '../src/lineworks-notify'

const CHANNEL = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
/** 実運用の通知先 (recipient「本多 優鷹」、Refs #874 の 10)。 */
const RECIPIENT = 'e553efc9-4dff-4171-a06d-d3c127b14b94'
const TO_CHANNEL: LineworksDestination = { kind: 'channel', id: CHANNEL }
const TO_RECIPIENT: LineworksDestination = { kind: 'recipient', id: RECIPIENT }

describe('buildLineworksSendBody', () => {
  it('channel 宛は rust 側 (#874-6) が読む {channel_id, text} を組む', () => {
    expect(JSON.parse(buildLineworksSendBody(TO_CHANNEL, 'こんにちは'))).toEqual({
      channel_id: CHANNEL,
      text: 'こんにちは',
    })
  })

  it('recipient 宛は {recipient_id, text} — channel_id キー自体を出さない', () => {
    const body = JSON.parse(buildLineworksSendBody(TO_RECIPIENT, 'こんにちは'))
    expect(body).toEqual({ recipient_id: RECIPIENT, text: 'こんにちは' })
    // rust (#874-9) は「両方あり」を 400 にする。null を載せて片方を明示的に空に
    // する形は取らない — キーの有無で一方だけを表す。
    expect('channel_id' in body).toBe(false)
  })

  it('改行を含む通知文をそのまま運ぶ (JSON エスケープ任せ)', () => {
    const text = '【運転日報】本社営業所 2026/08/24分\nプリント予約番号: J5JZPEQJ'
    expect(JSON.parse(buildLineworksSendBody(TO_CHANNEL, text)).text).toBe(text)
    expect(JSON.parse(buildLineworksSendBody(TO_RECIPIENT, text)).text).toBe(text)
  })
})

describe('sendLineworksTextViaAlcInternalProxy', () => {
  it('X-Alc-Proxy-Secret だけを付けて /alc-internal-proxy/api/internal/lineworks/send を POST する', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImpl: FetchLike = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response('{"ok":true}', { status: 200 })
    }) as FetchLike

    await sendLineworksTextViaAlcInternalProxy(
      { sharedSecret: 'shared-1', destination: TO_CHANNEL, text: 'hello' },
      fetchImpl,
    )

    expect(capturedUrl).toBe(`https://auth-worker.internal${LINEWORKS_SEND_PATH}`)
    expect(capturedInit?.method).toBe('POST')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['X-Alc-Proxy-Secret']).toBe('shared-1')
    expect(headers['Content-Type']).toBe('application/json')
    // auth-worker (internal-jwt クラス) が付ける/落とすもの — relay は触らない。
    expect(headers['X-Tenant-ID']).toBeUndefined()
    expect(headers['X-Internal-Shared-Secret']).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ channel_id: CHANNEL, text: 'hello' })
  })

  it('2xx なら応答本文を読まずに解決する (message id 等に依存しない)', async () => {
    let bodyRead = false
    const fake = {
      ok: true,
      status: 201,
      async text() {
        bodyRead = true
        return '{"message_id":"m1"}'
      },
    } as unknown as Response
    const fetchImpl: FetchLike = (async () => fake) as FetchLike
    await expect(
      sendLineworksTextViaAlcInternalProxy(
        { sharedSecret: 's', destination: TO_CHANNEL, text: 't' },
        fetchImpl,
      ),
    ).resolves.toBeUndefined()
    expect(bodyRead).toBe(false)
  })

  it('recipient 宛は同じ path / ヘッダで body だけ recipient_id になる', async () => {
    let capturedUrl = ''
    let capturedBody = ''
    const fetchImpl: FetchLike = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = String(init?.body)
      return new Response('{"ok":true}', { status: 200 })
    }) as FetchLike

    await sendLineworksTextViaAlcInternalProxy(
      { sharedSecret: 'shared-1', destination: TO_RECIPIENT, text: 'hello' },
      fetchImpl,
    )

    // **パスは変わらない** ので auth-worker の allowlist は無変更 (#874-10)。
    expect(capturedUrl).toBe(`https://auth-worker.internal${LINEWORKS_SEND_PATH}`)
    expect(JSON.parse(capturedBody)).toEqual({ recipient_id: RECIPIENT, text: 'hello' })
  })

  it('非 2xx は本文と channel を載せて LineworksNotifyError で loud fail する', async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response('channel not found', { status: 404 })) as FetchLike
    await expect(
      sendLineworksTextViaAlcInternalProxy(
        { sharedSecret: 's', destination: TO_CHANNEL, text: 't' },
        fetchImpl,
      ),
    ).rejects.toThrow(LineworksNotifyError)

    const fetchImpl2: FetchLike = (async () =>
      new Response('channel not found', { status: 404 })) as FetchLike
    await expect(
      sendLineworksTextViaAlcInternalProxy(
        { sharedSecret: 's', destination: TO_CHANNEL, text: 't' },
        fetchImpl2,
      ),
    ).rejects.toThrow(`LINE WORKS 送信失敗 (HTTP 404, channel ${CHANNEL}): channel not found`)
  })

  it('失敗の message には宛先種別が入る (同じ Uuid 形式なので id だけでは取り違えを読めない)', async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response('recipient not found', { status: 404 })) as FetchLike
    await expect(
      sendLineworksTextViaAlcInternalProxy(
        { sharedSecret: 's', destination: TO_RECIPIENT, text: 't' },
        fetchImpl,
      ),
    ).rejects.toThrow(`LINE WORKS 送信失敗 (HTTP 404, recipient ${RECIPIENT}): recipient not found`)
  })

  it('長い失敗本文は 300 文字で切る (ログを溢れさせない)', async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response('x'.repeat(500), { status: 502 })) as FetchLike
    await expect(
      sendLineworksTextViaAlcInternalProxy(
        { sharedSecret: 's', destination: TO_CHANNEL, text: 't' },
        fetchImpl,
      ),
    ).rejects.toThrow(`(HTTP 502, channel ${CHANNEL}): ${'x'.repeat(300)}`)
  })
})
