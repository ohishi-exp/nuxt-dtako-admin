/**
 * `POST /api/vehicle-settings/extract` の**認可** (Refs #988)。
 *
 * この口は `docs/plan-922-single-signin.md` §1 の D 段 (認可が 1 つも無い) に居た —
 * 前段は Cloudflare Access だけで、それは edge の設定であって**この repo が意図して
 * 置いた防御ではない**。A 段の `requireAuth` を足したので、
 *
 * - **陰性対照**: 未ログインは 401 で、**zip を読む前に**落ちる
 *   (`readMultipartFormData` が 1 度も呼ばれないことまで見る。
 *   `requireAuth` を外すと 401 が出なくなってこの it が落ちる)
 * - **陽性対照**: 認証が通れば**従来どおり実機 dump zip を読んで JSON を返す**
 *   (塞いだだけで使えなくなっていないことの証明)
 *
 * 抽出そのものの検査は `tests/utils/vehicle-settings-cfg.test.ts` (pure) が持つ。
 * ここは route の外殻 (認可と 400/413) だけを見る。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock, readMultipartFormDataMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  readMultipartFormDataMock: vi.fn(),
}))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    readMultipartFormData: readMultipartFormDataMock,
  }
})

import handler from '../../server/api/vehicle-settings/extract.post'

/** 実機 NET780 dump (車輛 cd 4437)。`vehicle-settings-cfg.test.ts` と同じ fixture。 */
const ZIP = readFileSync(resolve(__dirname, '../fixtures/vehicle-dump-sample.zip'))

interface ExtractResult {
  vehicle_cd: string
  saved: { json_key: string, cfg_key: string } | null
  saved_warning: string | null
}

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<ExtractResult>)(event)

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })
const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
  readMultipartFormDataMock.mockReset()
  readMultipartFormDataMock.mockResolvedValue([{ name: 'file', filename: 'dump.zip', data: ZIP }])
})

describe('POST /api/vehicle-settings/extract — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、zip を 1 バイトも読まない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({ statusCode: 401 })
    expect(readMultipartFormDataMock).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({}))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {} })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' } }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined } })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123 })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith(okEnv({ NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('POST /api/vehicle-settings/extract — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('★ 認証が通れば実機 dump zip から vehicle_cd が取れる (R2 binding 無しは従来どおり成功扱い)', async () => {
    const res = await call(eventWith(okEnv()))
    expect(res.vehicle_cd).toBe('4437')
    expect(res.saved).toBeNull()
    expect(res.saved_warning).toContain('DTAKO_R2')
  })

  it('★ 認証が通れば R2 に保存され、D1 カタログにも 1 行入る (従来どおり)', async () => {
    const puts: string[] = []
    const bound: unknown[][] = []
    const env = okEnv({
      DTAKO_R2: { put: async (key: string) => { puts.push(key); return {} } },
      DTAKO_DB: {
        prepare: () => ({
          bind: (...values: unknown[]) => { bound.push(values); return { run: async () => ({}) } },
        }),
      },
    })
    const res = await call(eventWith(env))
    expect(res.saved).not.toBeNull()
    expect(puts.some(k => k.endsWith('.json'))).toBe(true)
    expect(puts.some(k => k.endsWith('.cfg'))).toBe(true)
    expect(bound[0]![0]).toBe('4437')
  })

  it('multipart body が無ければ従来どおり 400 (認証の後)', async () => {
    readMultipartFormDataMock.mockResolvedValue([])
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('file field が無ければ従来どおり 400', async () => {
    readMultipartFormDataMock.mockResolvedValue([{ name: 'other', data: Buffer.from('x') }])
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('5MB 超は従来どおり 413', async () => {
    readMultipartFormDataMock.mockResolvedValue([
      { name: 'file', filename: 'big.zip', data: Buffer.alloc(5 * 1024 * 1024 + 1) },
    ])
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({ statusCode: 413 })
  })
})
