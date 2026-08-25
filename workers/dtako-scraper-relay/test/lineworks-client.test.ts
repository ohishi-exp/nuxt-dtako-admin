import { beforeAll, describe, expect, it } from 'vitest'
import {
  JWT_LIFETIME_SECONDS,
  LINEWORKS_TOKEN_URL,
  LineworksBotClient,
  LineworksClientError,
  LineworksConfigError,
  TOKEN_REFRESH_RATIO,
  base64UrlEncode,
  buildJwtSigningInput,
  buildMessageUrl,
  buildTextMessageBody,
  buildTokenRequestBody,
  fetchLineworksAccessToken,
  parseLineworksBotConfig,
  parseTokenResponse,
  pemToPkcs8Bytes,
  signJwtRs256,
  tokenExpiresAtMs,
  type FetchLike,
  type LineworksBotConfig,
} from '../src/lineworks-client'

// ---- テスト用の実鍵 (WebCrypto で生成し PKCS#8 PEM 化)。署名経路を mock せず
// 実際に signJwtRs256 → verify で通すため。
let privateKeyPem = ''
let publicKey: CryptoKey

function toPem(pkcs8: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)))
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

beforeAll(async () => {
  // workers-types の generateKey / exportKey は union 型を返すため cast する
  // (RSA 指定なら CryptoKeyPair / pkcs8 指定なら ArrayBuffer で確定)
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  privateKeyPem = toPem((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
  publicKey = pair.publicKey
})

function validConfig(): LineworksBotConfig {
  return {
    client_id: 'cid-1',
    client_secret: 'csec-1',
    service_account: 'sa@example',
    private_key: privateKeyPem,
    bot_id: 'bot-9',
  }
}

function base64UrlDecodeToString(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  return atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
}

describe('parseLineworksBotConfig', () => {
  it('parses a full JSON secret', () => {
    const raw = JSON.stringify({
      client_id: 'a',
      client_secret: 'b',
      service_account: 'c',
      private_key: 'd',
      bot_id: 'e',
    })
    expect(parseLineworksBotConfig(raw)).toEqual({
      client_id: 'a',
      client_secret: 'b',
      service_account: 'c',
      private_key: 'd',
      bot_id: 'e',
    })
  })

  it('loud fails when unset (fail-closed、黙って skip しない)', () => {
    expect(() => parseLineworksBotConfig(undefined)).toThrow(LineworksConfigError)
    expect(() => parseLineworksBotConfig('')).toThrow('LINEWORKS_BOT が未設定です')
  })

  it('loud fails on invalid JSON', () => {
    expect(() => parseLineworksBotConfig('not json')).toThrow(
      'LINEWORKS_BOT が JSON としてパースできません',
    )
  })

  it('loud fails on non-object JSON (number / null / array)', () => {
    expect(() => parseLineworksBotConfig('42')).toThrow(
      'LINEWORKS_BOT は JSON オブジェクトである必要があります',
    )
    expect(() => parseLineworksBotConfig('null')).toThrow(LineworksConfigError)
    expect(() => parseLineworksBotConfig('[]')).toThrow(LineworksConfigError)
  })

  it('loud fails naming the missing / empty / non-string field', () => {
    const base = {
      client_id: 'a',
      client_secret: 'b',
      service_account: 'c',
      private_key: 'd',
      bot_id: 'e',
    }
    const { bot_id: _dropped, ...missing } = base
    expect(() => parseLineworksBotConfig(JSON.stringify(missing))).toThrow(
      'LINEWORKS_BOT.bot_id がありません',
    )
    expect(() =>
      parseLineworksBotConfig(JSON.stringify({ ...base, client_secret: '' })),
    ).toThrow('LINEWORKS_BOT.client_secret がありません')
    expect(() =>
      parseLineworksBotConfig(JSON.stringify({ ...base, private_key: 7 })),
    ).toThrow('LINEWORKS_BOT.private_key がありません')
  })
})

describe('base64UrlEncode', () => {
  it('encodes without padding and with url-safe alphabet', () => {
    // 0xfb 0xef → base64 "++8=" → base64url "--8"
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xef]))).toBe('--8')
    // 0xff 0xe0 → base64 "/+A=" → "_-A"
    expect(base64UrlEncode(new Uint8Array([0xff, 0xe0]))).toBe('_-A')
    expect(base64UrlEncode(new Uint8Array([]))).toBe('')
    expect(base64UrlEncode(new TextEncoder().encode('abc'))).toBe('YWJj')
  })
})

describe('buildJwtSigningInput', () => {
  it('builds header.claims with iss/sub/iat/exp per LINE WORKS Service Account auth', () => {
    const input = buildJwtSigningInput(
      { client_id: 'cid', service_account: 'sa@x' },
      1_756_000_000,
    )
    const [headerSeg, claimsSeg] = input.split('.')
    expect(JSON.parse(base64UrlDecodeToString(headerSeg))).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(base64UrlDecodeToString(claimsSeg))).toEqual({
      iss: 'cid',
      sub: 'sa@x',
      iat: 1_756_000_000,
      exp: 1_756_000_000 + JWT_LIFETIME_SECONDS,
    })
  })
})

describe('pemToPkcs8Bytes / signJwtRs256', () => {
  it('signs a JWT the public key can verify', async () => {
    const signingInput = buildJwtSigningInput(
      { client_id: 'cid', service_account: 'sa' },
      1_756_000_000,
    )
    const jwt = await signJwtRs256(signingInput, privateKeyPem)
    const [headerSeg, claimsSeg, signatureSeg] = jwt.split('.')
    expect(`${headerSeg}.${claimsSeg}`).toBe(signingInput)
    const base64 = signatureSeg.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    const signature = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      signature,
      new TextEncoder().encode(signingInput),
    )
    expect(ok).toBe(true)
  })

  it('loud fails on a non-PKCS#8 PEM (RSA PRIVATE KEY / 素の文字列)', () => {
    expect(() => pemToPkcs8Bytes('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----')).toThrow(
      'private_key が PKCS#8 PEM (-----BEGIN PRIVATE KEY-----) ではありません',
    )
    expect(() => pemToPkcs8Bytes('garbage')).toThrow(LineworksConfigError)
  })

  it('loud fails on undecodable base64 inside the PEM', () => {
    expect(() =>
      pemToPkcs8Bytes('-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----'),
    ).toThrow('private_key の base64 がデコードできません')
  })
})

describe('buildTokenRequestBody', () => {
  it('encodes the jwt-bearer grant with scope=bot', () => {
    const body = buildTokenRequestBody({ client_id: 'ci&d', client_secret: 's=1' }, 'a.b.c')
    const params = new URLSearchParams(body)
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(params.get('assertion')).toBe('a.b.c')
    expect(params.get('client_id')).toBe('ci&d')
    expect(params.get('client_secret')).toBe('s=1')
    expect(params.get('scope')).toBe('bot')
  })
})

describe('parseTokenResponse', () => {
  it('reads access_token and numeric expires_in', () => {
    expect(parseTokenResponse('{"access_token":"tok","expires_in":86400}')).toEqual({
      accessToken: 'tok',
      expiresInSeconds: 86400,
    })
  })

  it('normalizes string expires_in ("86400") to a number', () => {
    expect(parseTokenResponse('{"access_token":"tok","expires_in":"86400"}')).toEqual({
      accessToken: 'tok',
      expiresInSeconds: 86400,
    })
  })

  it('loud fails on non-JSON / non-object bodies', () => {
    expect(() => parseTokenResponse('<html>')).toThrow('token 応答が JSON ではありません')
    expect(() => parseTokenResponse('null')).toThrow(
      'token 応答が JSON オブジェクトではありません',
    )
    expect(() => parseTokenResponse('"tok"')).toThrow(LineworksClientError)
  })

  it('loud fails when access_token is missing or empty', () => {
    expect(() => parseTokenResponse('{"expires_in":3600}')).toThrow(
      'token 応答に access_token がありません',
    )
    expect(() => parseTokenResponse('{"access_token":"","expires_in":3600}')).toThrow(
      LineworksClientError,
    )
  })

  it('loud fails when expires_in is missing / NaN / non-positive', () => {
    expect(() => parseTokenResponse('{"access_token":"tok"}')).toThrow(
      'token 応答の expires_in が読めません',
    )
    expect(() => parseTokenResponse('{"access_token":"tok","expires_in":"abc"}')).toThrow(
      LineworksClientError,
    )
    expect(() => parseTokenResponse('{"access_token":"tok","expires_in":0}')).toThrow(
      LineworksClientError,
    )
    expect(() => parseTokenResponse('{"access_token":"tok","expires_in":1e999}')).toThrow(
      LineworksClientError,
    )
  })
})

describe('tokenExpiresAtMs', () => {
  it('expires at 90% of expires_in', () => {
    expect(tokenExpiresAtMs(1_000_000, 1000)).toBe(1_000_000 + 1000 * TOKEN_REFRESH_RATIO * 1000)
  })
})

describe('buildMessageUrl / buildTextMessageBody', () => {
  it('builds the bot message endpoint with encoded path segments', () => {
    expect(buildMessageUrl('bot-9', 'ch/1')).toBe(
      'https://www.worksapis.com/v1.0/bots/bot-9/channels/ch%2F1/messages',
    )
  })

  it('builds a text content body', () => {
    expect(JSON.parse(buildTextMessageBody('予約番号 J5JZPEQJ'))).toEqual({
      content: { type: 'text', text: '予約番号 J5JZPEQJ' },
    })
  })
})

describe('fetchLineworksAccessToken', () => {
  it('POSTs a signed jwt-bearer grant and returns the token', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImpl: FetchLike = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response('{"access_token":"tok-1","expires_in":86400}', { status: 200 })
    }) as FetchLike

    const token = await fetchLineworksAccessToken(validConfig(), fetchImpl, 1_756_000_000_000)
    expect(token).toEqual({ accessToken: 'tok-1', expiresInSeconds: 86400 })
    expect(capturedUrl).toBe(LINEWORKS_TOKEN_URL)
    expect(capturedInit?.method).toBe('POST')
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    const params = new URLSearchParams(String(capturedInit?.body))
    expect(params.get('client_id')).toBe('cid-1')
    expect(params.get('scope')).toBe('bot')
    const assertion = params.get('assertion') ?? ''
    const [, claimsSeg] = assertion.split('.')
    expect(JSON.parse(base64UrlDecodeToString(claimsSeg)).iat).toBe(1_756_000_000)
  })

  it('throws with the response body on non-2xx (黙って握らない)', async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response('{"error":"invalid_client"}', { status: 401 })) as FetchLike
    await expect(fetchLineworksAccessToken(validConfig(), fetchImpl, 0)).rejects.toThrow(
      'token 取得失敗 (HTTP 401): {"error":"invalid_client"}',
    )
  })

  it('uses global fetch / Date.now() when not injected (実 fetch は差し替えて検証)', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        new Response('{"access_token":"tok-g","expires_in":60}', { status: 200 })) as FetchLike
      const token = await fetchLineworksAccessToken(validConfig())
      expect(token.accessToken).toBe('tok-g')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('LineworksBotClient', () => {
  function tokenResponse(token: string, expiresIn = 86400): Response {
    return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
      status: 200,
    })
  }

  it('sends a text message with Bearer token and memoizes the token across sends', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl: FetchLike = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url) === LINEWORKS_TOKEN_URL) return tokenResponse('tok-1', 1000)
      return new Response('{}', { status: 201 })
    }) as FetchLike

    const client = new LineworksBotClient(validConfig(), fetchImpl)
    await client.sendText('ch-1', 'こんにちは', 0)
    // token はまだ 9 割 (900 秒) 以内 → 2 通目で token 取得は走らない
    await client.sendText('ch-2', '2通目', 899_999)

    const tokenCalls = calls.filter((c) => c.url === LINEWORKS_TOKEN_URL)
    expect(tokenCalls).toHaveLength(1)
    const messageCalls = calls.filter((c) => c.url !== LINEWORKS_TOKEN_URL)
    expect(messageCalls.map((c) => c.url)).toEqual([
      'https://www.worksapis.com/v1.0/bots/bot-9/channels/ch-1/messages',
      'https://www.worksapis.com/v1.0/bots/bot-9/channels/ch-2/messages',
    ])
    const headers = messageCalls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-1')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(messageCalls[0].init?.body))).toEqual({
      content: { type: 'text', text: 'こんにちは' },
    })
  })

  it('refreshes the token once 90% of expires_in has passed', async () => {
    let tokenCount = 0
    const fetchImpl: FetchLike = (async (url: RequestInfo | URL) => {
      if (String(url) === LINEWORKS_TOKEN_URL) {
        tokenCount += 1
        return tokenResponse(`tok-${tokenCount}`, 1000)
      }
      return new Response('{}', { status: 200 })
    }) as FetchLike

    const client = new LineworksBotClient(validConfig(), fetchImpl)
    expect(await client.getAccessToken(0)).toBe('tok-1')
    expect(await client.getAccessToken(900_000)).toBe('tok-2')
    expect(tokenCount).toBe(2)
  })

  it('throws with body / channel on non-2xx message send', async () => {
    const fetchImpl: FetchLike = (async (url: RequestInfo | URL) => {
      if (String(url) === LINEWORKS_TOKEN_URL) return tokenResponse('tok-1')
      return new Response('{"code":"FORBIDDEN"}', { status: 403 })
    }) as FetchLike
    const client = new LineworksBotClient(validConfig(), fetchImpl)
    await expect(client.sendText('ch-x', 'ng', 0)).rejects.toThrow(
      'メッセージ送信失敗 (HTTP 403, channel ch-x): {"code":"FORBIDDEN"}',
    )
  })

  it('falls back to global fetch and Date.now() defaults', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        if (String(url) === LINEWORKS_TOKEN_URL) return tokenResponse('tok-d')
        return new Response('{}', { status: 200 })
      }) as FetchLike
      const client = new LineworksBotClient(validConfig())
      expect(await client.getAccessToken()).toBe('tok-d')
      await client.sendText('ch-1', 'defaults')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
