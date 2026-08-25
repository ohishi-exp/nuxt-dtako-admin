import { describe, expect, it } from 'vitest'
import {
  buildLineworksSendBody,
  LINEWORKS_SEND_PATH,
  LineworksNotifyError,
  sendLineworksTextViaAlcInternalProxy,
  type FetchLike,
} from '../src/lineworks-notify'

const CHANNEL = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

describe('buildLineworksSendBody', () => {
  it('rust 側 (#874-6) が読む {channel_id, text} を組む', () => {
    expect(JSON.parse(buildLineworksSendBody(CHANNEL, 'こんにちは'))).toEqual({
      channel_id: CHANNEL,
      text: 'こんにちは',
    })
  })

  it('改行を含む通知文をそのまま運ぶ (JSON エスケープ任せ)', () => {
    const text = '【運転日報】本社営業所 2026/08/24分\nプリント予約番号: J5JZPEQJ'
    expect(JSON.parse(buildLineworksSendBody(CHANNEL, text)).text).toBe(text)
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
      { sharedSecret: 'shared-1', channelId: CHANNEL, text: 'hello' },
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
        { sharedSecret: 's', channelId: CHANNEL, text: 't' },
        fetchImpl,
      ),
    ).resolves.toBeUndefined()
    expect(bodyRead).toBe(false)
  })

  it('非 2xx は本文と channel を載せて LineworksNotifyError で loud fail する', async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response('channel not found', { status: 404 })) as FetchLike
    await expect(
      sendLineworksTextViaAlcInternalProxy(
        { sharedSecret: 's', channelId: CHANNEL, text: 't' },
        fetchImpl,
      ),
    ).rejects.toThrow(LineworksNotifyError)

    const fetchImpl2: FetchLike = (async () =>
      new Response('channel not found', { status: 404 })) as FetchLike
    await expect(
      sendLineworksTextViaAlcInternalProxy(
        { sharedSecret: 's', channelId: CHANNEL, text: 't' },
        fetchImpl2,
      ),
    ).rejects.toThrow(`LINE WORKS 送信失敗 (HTTP 404, channel ${CHANNEL}): channel not found`)
  })

  it('長い失敗本文は 300 文字で切る (ログを溢れさせない)', async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response('x'.repeat(500), { status: 502 })) as FetchLike
    await expect(
      sendLineworksTextViaAlcInternalProxy(
        { sharedSecret: 's', channelId: CHANNEL, text: 't' },
        fetchImpl,
      ),
    ).rejects.toThrow(`(HTTP 502, channel ${CHANNEL}): ${'x'.repeat(300)}`)
  })
})
