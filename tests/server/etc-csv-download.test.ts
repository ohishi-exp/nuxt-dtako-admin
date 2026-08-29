/**
 * `GET /api/etc-csv/download` の route テスト (Refs #1053)。
 *
 * **A 段 route のうち、これだけが専用テスト 0 本だった。** 認可 (`requireAuth` +
 * role) は #1051 の配線テスト (`require-role-routes.test.ts`) が押さえているが、
 * **この route 自身の振る舞い** — key の検証 / R2 が無いとき / object が無いとき /
 * 返すバイト列とヘッダ — は誰も検査していなかった。
 *
 * 流儀は隣の A 段 route のテスト (`poi.test.ts` /
 * `vid-check-map-key-route.test.ts`) に合わせる: `defineEventHandler` は identity に
 * 差し替え、`requireAuth` は hoisted mock、`createError` の H3Error をそのまま assert。
 * **`getQuery` は mock しない** — `event.path` を実 URL の形で与え、h3 の実装
 * (`getQuery(event.path || '')`) にそのまま解かせる。key の型 (配列 / 欠落) は
 * クエリ文字列の書き方だけで作れるので、mock を挟むと検査が薄くなる。
 *
 * ## ★ 「CSV でない応答は loud fail して R2 `{prefix}-errors/` に原本保存」について
 *
 * `CLAUDE.md` のこの規範は **スクレイプ (書き込み) 側**のもので、実体は relay の
 * `workers/dtako-scraper-relay/src/dtako-scraper-relay-do.ts` の `performEtcScrape()`
 * (`EtcMeisaiNotCsvError` → `{prefix}-errors/{user_id}/{ms}.bin` へ put)。
 * **この download route は読み出し側**で、上流の応答を受け取る場面が無く、R2 に
 * 保存済みのバイト列をそのまま返す。**中身が CSV かどうかは検査していない**
 * (下の「現状の固定」を参照)。**保存された失敗原本がこの口から出ることは無い** —
 * key の許可形式が `etc(-staging|-preview)?/…` なので `etc-errors/…` は 400 で弾かれる。
 * これは構造的な担保なので、下で陰性対照として固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

import handler from '../../server/api/etc-csv/download.get'

interface TestEvent {
  context: Record<string, unknown>
  path?: string
  node: { res: { setHeader: (k: string, v: string) => void } }
}

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)

const VALID_KEY = 'etc/user1/2026-07-03/060005.csv'
const CSV_BYTES = new Uint8Array([0x93, 0xfa, 0x95, 0x74, 0x2c, 0x8b, 0xe0, 0x8a, 0x7a]) // Shift_JIS の「日付,金額」相当

/** `key` を素の文字列としてクエリに載せる (`?key=a&key=b` のような形も作れるようにする)。 */
function eventWith(env: Record<string, unknown>, rawQuery?: string): TestEvent {
  return {
    context: { cloudflare: { env: { INTERNAL_SHARED_SECRET: 'secret', ...env } } },
    path: rawQuery === undefined ? '/api/etc-csv/download' : `/api/etc-csv/download?${rawQuery}`,
    node: { res: { setHeader: vi.fn() } },
  }
}

const withKey = (env: Record<string, unknown>, key: string) =>
  eventWith(env, `key=${encodeURIComponent(key)}`)

function r2With(objects: Record<string, Uint8Array>) {
  return {
    get: vi.fn(async (key: string) =>
      key in objects
        ? {
            arrayBuffer: async () => {
              const bytes = objects[key]!
              return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            },
          }
        : null,
    ),
  }
}

const okR2 = () => r2With({ [VALID_KEY]: CSV_BYTES })

/** `setResponseHeader` が積んだヘッダを `{name: value}` で読む。 */
const headersOf = (event: TestEvent): Record<string, string> =>
  Object.fromEntries(
    (event.node.res.setHeader as unknown as { mock: { calls: [string, string][] } }).mock.calls,
  )

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'admin' })
})

describe('GET /api/etc-csv/download — 認可 (Refs #988 / #1004)', () => {
  it('★ 未ログインは 401 で、R2 を 1 度も触らない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const r2 = okR2()
    await expect(call(withKey({ DTAKO_R2: r2 }, VALID_KEY))).rejects.toMatchObject({ statusCode: 401 })
    expect(r2.get).not.toHaveBeenCalled()
  })

  it('★ role が admin でなければ 403 で、R2 を 1 度も触らない', async () => {
    const r2 = okR2()
    for (const role of ['viewer', '', undefined]) {
      requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role })
      await expect(call(withKey({ DTAKO_R2: r2 }, VALID_KEY))).rejects.toMatchObject({
        statusCode: 403,
        statusMessage: 'administrator role is required',
      })
    }
    expect(r2.get).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    const event = {
      context: { cloudflare: { env: { DTAKO_R2: okR2() } } },
      path: `/api/etc-csv/download?key=${encodeURIComponent(VALID_KEY)}`,
      node: { res: { setHeader: vi.fn() } },
    }
    await expect(call(event)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {}, path: '/api/etc-csv/download', node: { res: { setHeader: vi.fn() } } }))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(withKey({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, DTAKO_R2: okR2() }, VALID_KEY))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(withKey({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_R2: okR2() }, VALID_KEY)))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(withKey({ INTERNAL_SHARED_SECRET: 123, DTAKO_R2: okR2() }, VALID_KEY)))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(withKey({ DTAKO_R2: okR2(), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' }, VALID_KEY))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(withKey({ DTAKO_R2: okR2(), NUXT_PUBLIC_AUTH_WORKER_URL: '' }, VALID_KEY))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(withKey({ DTAKO_R2: okR2(), NUXT_PUBLIC_AUTH_WORKER_URL: 7 }, VALID_KEY))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('GET /api/etc-csv/download — key の検証', () => {
  it('key 欠落 / 空文字 / 配列 (?key=a&key=b) は 400 で、R2 を触らない', async () => {
    const r2 = okR2()
    // 欠落 (undefined) → `typeof key !== 'string'`
    await expect(call(eventWith({ DTAKO_R2: r2 }))).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'key (string) is required',
    })
    // 空文字 → typeof は通るが falsy
    await expect(call(eventWith({ DTAKO_R2: r2 }, 'key='))).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'key (string) is required',
    })
    // 配列 → `typeof key !== 'string'` (string[] になる)
    await expect(call(eventWith({ DTAKO_R2: r2 }, 'key=a&key=b'))).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'key (string) is required',
    })
    expect(r2.get).not.toHaveBeenCalled()
  })

  it('★ 許可形式に合わない key は 400 で、R2 を 1 度も触らない (任意 R2 path を読ませない)', async () => {
    const r2 = okR2()
    const rejected = [
      '../secret',
      'etc/../poi/kyushu.geojson',
      'poi/kyushu.geojson', // 別 prefix
      'dtako/user1/2026-07-03/060005.csv',
      'etc-errors/user1/1751500000000.bin', // ★ 失敗原本の置き場 (下の describe を参照)
      'etc/user1/2026-07-03/060005.CSV', // 拡張子は小文字のみ
      'etc/user1/2026-7-3/060005.csv', // 日付は 0 埋め固定長
      'etc/user1/2026-07-03/60005.csv', // 時刻は 6 桁固定
      'etc/user1/2026-07-03/060005.csv/../../x.csv',
      'etc/us er1/2026-07-03/060005.csv', // セグメント文字種
      'etc/user1/2026-07-03/060005.csv"; x="', // Content-Disposition header injection
      'etc/user1/2026-07-03/060005.csv\r\nX-Injected: 1',
      'etc/user1/2026-07-03/060005.csv\n',
      'etc-prod/user1/2026-07-03/060005.csv', // 許可 prefix は etc / etc-staging / etc-preview だけ
      'etc//2026-07-03/060005.csv', // user_id 空
      'etc/user1/2026-07-03/060005.csv.bak',
    ]
    for (const bad of rejected) {
      await expect(call(withKey({ DTAKO_R2: r2 }, bad))).rejects.toMatchObject({
        statusCode: 400,
        statusMessage: 'invalid ETC CSV key',
      })
    }
    expect(r2.get).not.toHaveBeenCalled()
  })

  it('★ 陽性対照 — etc / etc-staging / etc-preview の 3 prefix は通る', async () => {
    // 弾く側だけを並べると、パターンを `/^$/` にしても緑になる。3 つとも通ることを固定する。
    for (const prefix of ['etc', 'etc-staging', 'etc-preview']) {
      const key = `${prefix}/user_1-A/2026-07-03/060005.csv`
      const r2 = r2With({ [key]: CSV_BYTES })
      await call(withKey({ DTAKO_R2: r2 }, key))
      expect(r2.get).toHaveBeenCalledWith(key)
    }
  })
})

describe('GET /api/etc-csv/download — R2', () => {
  // 503 が 2 種類ある (secret 未設定 / R2 binding 未設定) ので、`statusCode` だけを
  // 見ると**別の理由で緑になる**。文言で分ける (`poi.test.ts` と同じ注意)。
  it('R2 binding 未設定は 503 (認証は通った後)', async () => {
    await expect(call(withKey({}, VALID_KEY))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_R2'),
    })
    expect(requireAuthMock).toHaveBeenCalled()
  })

  it('R2 に object が無ければ 404 (key を添えた loud fail)', async () => {
    const r2 = r2With({})
    await expect(call(withKey({ DTAKO_R2: r2 }, VALID_KEY))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: `not found in R2: ${VALID_KEY}`,
    })
    expect(r2.get).toHaveBeenCalledWith(VALID_KEY)
  })
})

describe('GET /api/etc-csv/download — 応答', () => {
  it('★ R2 のバイト列を Uint8Array で返す (素の ArrayBuffer だと `{}` になる)', async () => {
    const event = withKey({ DTAKO_R2: r2With({ [VALID_KEY]: CSV_BYTES }) }, VALID_KEY)
    const res = await call(event)
    // **`toEqual` だけだと ArrayBuffer との差が出ない。** 実装コメントにある実害
    // (「ダウンロードした CSV の中身が literal `{}` になっていた」) を型で固定する。
    expect(res).toBeInstanceOf(Uint8Array)
    expect(Array.from(res as Uint8Array)).toEqual(Array.from(CSV_BYTES))
    expect(JSON.stringify(res)).not.toBe('{}')
  })

  it('★ Shift_JIS の content-type と、key 由来の filename を付ける', async () => {
    const event = withKey({ DTAKO_R2: r2With({ [VALID_KEY]: CSV_BYTES }) }, VALID_KEY)
    await call(event)
    expect(headersOf(event)).toEqual({
      'content-type': 'text/csv; charset=shift_jis',
      // prefix (先頭セグメント) を落として `_` で繋ぐ
      'content-disposition': 'attachment; filename="user1_2026-07-03_060005.csv"',
    })
  })

  it('filename は prefix ごとに変わらない (etc-staging でも同じ 3 セグメント)', async () => {
    const key = 'etc-staging/user1/2026-07-03/060005.csv'
    const event = withKey({ DTAKO_R2: r2With({ [key]: CSV_BYTES }) }, key)
    await call(event)
    expect(headersOf(event)['content-disposition'])
      .toBe('attachment; filename="user1_2026-07-03_060005.csv"')
  })

  it('空の object でも 404 にはせず 0 バイトを返す', async () => {
    const key = VALID_KEY
    const event = withKey({ DTAKO_R2: r2With({ [key]: new Uint8Array(0) }) }, key)
    const res = await call(event)
    expect(res).toBeInstanceOf(Uint8Array)
    expect((res as Uint8Array).byteLength).toBe(0)
  })
})

describe('GET /api/etc-csv/download — 「CSV でない応答」の扱い (Refs #1053)', () => {
  /**
   * **現状の固定であって、正しさの主張ではない。**
   * `CLAUDE.md` の「CSV でない応答は loud fail して R2 `{prefix}-errors/` に原本保存」は
   * **スクレイプ (書き込み) 側の規範**で、実体は relay の `performEtcScrape()`。
   * この route は読み出し側なので上流の応答を受け取る場面が無く、**保存済みの
   * バイト列の中身は検査しない**。下の 2 本はその現状と、構造的な担保
   * (失敗原本の置き場である `{prefix}-errors/` はこの口から出ない) を固定する。
   */
  it('中身が CSV でなくても素通しする (この route に loud fail は無い)', async () => {
    const html = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]) // "<html>"
    const event = withKey({ DTAKO_R2: r2With({ [VALID_KEY]: html }) }, VALID_KEY)
    const res = await call(event)
    expect(Array.from(res as Uint8Array)).toEqual(Array.from(html))
    // それでも content-type は CSV を名乗る (中身を見ていない証拠)
    expect(headersOf(event)['content-type']).toBe('text/csv; charset=shift_jis')
  })

  it('★ 失敗原本 (`{prefix}-errors/`) はこの口から出ない — key 検証で 400', async () => {
    // relay は `${prefix}-errors/${user_id}/${Date.now()}.bin` へ put する
    // (`dtako-scraper-relay-do.ts` の `performEtcScrape()`)。その形は
    // `ETC_CSV_KEY_PATTERN` に合わないので、R2 に触る前に落ちる。
    const r2 = r2With({ 'etc-errors/user1/1751500000000.bin': CSV_BYTES })
    await expect(call(withKey({ DTAKO_R2: r2 }, 'etc-errors/user1/1751500000000.bin')))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'invalid ETC CSV key' })
    expect(r2.get).not.toHaveBeenCalled()
  })
})
