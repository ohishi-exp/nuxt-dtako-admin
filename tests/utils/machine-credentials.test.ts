import { describe, it, expect, vi } from 'vitest'
import {
  LABEL_MAX,
  ONE_TIME_NOTICE,
  PURPOSE,
  createMachineCredentialApi,
  ISSUE_GUIDE,
  credentialErrorText,
  errorCodeText,
  issueErrorText,
  formatIssuedDate,
  labelError,
  listUrl,
  revokeUrl,
  rotateUrl,
  sortCredentials,
  toCredentialList,
  type Fetcher,
  type MachineCredential,
} from '~/utils/machine-credentials'

function fakeFetcher(result: unknown) {
  const calls: { url: string, options: unknown }[] = []
  const fetcher = vi.fn(async (url: string, options?: unknown) => {
    calls.push({ url, options })
    return result
  }) as unknown as Fetcher
  return { fetcher, calls }
}

const row = (o: Partial<MachineCredential>): MachineCredential => ({
  username: 'mc_0', purpose: 'fuel-utran', label: 'l', created_at: '2026-10-01T00:00:00Z', revoked: false, ...o,
})

/** $fetch (ofetch) の FetchError と同じく statusCode を持つ例外 */
function httpError(statusCode: number, data?: unknown) {
  return Object.assign(new Error(`[POST] x: ${statusCode}`), { statusCode, data })
}

describe('PURPOSE', () => {
  it('fuel-utran 固定 (leave-scan ではない)', () => {
    expect(PURPOSE).toBe('fuel-utran')
  })
  it('1 回だけの表示の文は Windows アプリの設定先を名指しする', () => {
    expect(ONE_TIME_NOTICE).toContain('二度と見られません')
    expect(ONE_TIME_NOTICE).toContain('『資格情報を設定』')
  })
})

describe('URL', () => {
  it('末尾の / を落として組み立て、username は encode する', () => {
    expect(listUrl('https://auth.ippoan.org/')).toBe('https://auth.ippoan.org/api/machine-credentials')
    expect(revokeUrl('https://auth.ippoan.org', 'mc_a/b')).toBe('https://auth.ippoan.org/api/machine-credentials/mc_a%2Fb/revoke')
    expect(rotateUrl('https://auth.ippoan.org//', 'mc_a/b')).toBe('https://auth.ippoan.org/api/machine-credentials/mc_a%2Fb/rotate')
  })
})

describe('toCredentialList', () => {
  it('配列も { credentials } も受け、username の無い行は落とす', () => {
    expect(toCredentialList([row({}), null, { label: 'x' }])).toEqual([row({})])
    expect(toCredentialList({ credentials: [row({ username: 'mc_1' })] })).toEqual([row({ username: 'mc_1' })])
  })
  it('読めない形は空', () => {
    expect(toCredentialList(null)).toEqual([])
    expect(toCredentialList({ data: [] })).toEqual([])
    expect(toCredentialList('x')).toEqual([])
  })
})

describe('createMachineCredentialApi', () => {
  const URL = 'https://auth-staging.ippoan.org'

  it('list は purpose=fuel-utran で GET', async () => {
    const { fetcher, calls } = fakeFetcher({ credentials: [row({})] })
    expect(await createMachineCredentialApi(fetcher, URL).list()).toEqual([row({})])
    expect(calls).toEqual([{ url: `${URL}/api/machine-credentials`, options: { query: { purpose: 'fuel-utran' } } }])
  })
  it('issue は PC 名を trim して purpose=fuel-utran で POST', async () => {
    const { fetcher, calls } = fakeFetcher({ username: 'mc_1', password: 'p' })
    expect(await createMachineCredentialApi(fetcher, URL).issue(' 本社 給油室 ')).toEqual({ username: 'mc_1', password: 'p' })
    expect(calls[0]).toEqual({
      url: `${URL}/api/machine-credentials`,
      options: { method: 'POST', body: { purpose: 'fuel-utran', label: '本社 給油室' } },
    })
  })
  it('revoke は POST', async () => {
    const { fetcher, calls } = fakeFetcher({ revoked: true })
    await createMachineCredentialApi(fetcher, URL).revoke('mc_1')
    expect(calls[0]).toEqual({ url: `${URL}/api/machine-credentials/mc_1/revoke`, options: { method: 'POST' } })
  })
  it('rotate は POST して新しい password を返す', async () => {
    const { fetcher, calls } = fakeFetcher({ username: 'mc_1', password: 'new' })
    expect(await createMachineCredentialApi(fetcher, URL).rotate('mc_1')).toEqual({ username: 'mc_1', password: 'new' })
    expect(calls[0]).toEqual({ url: `${URL}/api/machine-credentials/mc_1/rotate`, options: { method: 'POST' } })
  })
})

describe('labelError', () => {
  it('空・長すぎは文、それ以外は null', () => {
    expect(labelError('  ')).toBe('PC 名を入れてください')
    expect(labelError('a'.repeat(LABEL_MAX + 1))).toContain(`${LABEL_MAX}`)
    expect(labelError(` ${'a'.repeat(LABEL_MAX)} `)).toBeNull()
    expect(labelError('a')).toBeNull()
  })
})

describe('credentialErrorText', () => {
  const RETRY = 'もう一度「発行」を押してください'

  it('403 は管理者だけ (notFound の指定に依らない)', () => {
    expect(credentialErrorText(httpError(403), RETRY)).toBe('管理者だけが使えます')
    expect(credentialErrorText(httpError(403), RETRY, true)).toBe('管理者だけが使えます')
  })
  it('404 は rotate・revoke (notFoundIsMissing) のときだけ「失効しているか見つかりません」', () => {
    expect(credentialErrorText(httpError(404), RETRY, true)).toBe('この資格情報は失効しているか見つかりません')
    expect(credentialErrorText(httpError(404), RETRY)).not.toContain('失効しているか')
  })
  it('それ以外は共通の文 (status の次の一手つき)', () => {
    const text = credentialErrorText(httpError(500), RETRY)
    expect(text).not.toBe('管理者だけが使えます')
    expect(text.length).toBeGreaterThan(0)
  })
  it('通信そのものの失敗 (CORS で弾かれた等) も共通の文', () => {
    const text = credentialErrorText(new TypeError('Failed to fetch'), RETRY)
    expect(text).not.toBe('管理者だけが使えます')
    expect(text.length).toBeGreaterThan(0)
  })
})

describe('errorCodeText', () => {
  it('既知のコードは日本語の文 (コードそのものは出さない)', () => {
    expect(errorCodeText(httpError(400, { error: 'invalid_label' }))).toBe(`PC 名を 1〜${LABEL_MAX} 文字で入れてください`)
    expect(errorCodeText(httpError(502, { error: 'store_failed' })))
      .toBe('資格情報を保存できませんでした。時間をおいてもう一度試し、続くときは管理者に連絡してください')
    expect(errorCodeText(httpError(400, { error: 'invalid_purpose' })))
      .toBe('この種類の資格情報は発行できません (設定の不足)。管理者に連絡してください')
  })
  it('知らないコード・文字列でないコード・本文なし・prototype の名前は null', () => {
    expect(errorCodeText(httpError(400, { error: 'other' }))).toBeNull()
    expect(errorCodeText(httpError(400, { error: true }))).toBeNull()
    expect(errorCodeText(httpError(400, { error: 'toString' }))).toBeNull()
    expect(errorCodeText(httpError(400))).toBeNull()
    expect(errorCodeText(null)).toBeNull()
  })
})

describe('credentialErrorText と既知のコード', () => {
  it('rotate の store_failed もコードの文 (英語のコードを出さない)', () => {
    const text = credentialErrorText(httpError(502, { error: 'store_failed' }), 'x', true)
    expect(text).toContain('資格情報を保存できませんでした')
    expect(text).not.toContain('store_failed')
  })
  it('403・404 はコードより先', () => {
    expect(credentialErrorText(httpError(403, { error: 'invalid_label' }), 'x')).toBe('管理者だけが使えます')
    expect(credentialErrorText(httpError(404, { error: 'store_failed' }), 'x', true)).toBe('この資格情報は失効しているか見つかりません')
  })
})

describe('issueErrorText', () => {
  it('400 invalid_label は PC 名の文だけ (「上の理由のとおりに」を出さない)', () => {
    const text = issueErrorText(httpError(400, { error: 'invalid_label' }))
    expect(text).toBe(`PC 名を 1〜${LABEL_MAX} 文字で入れてください`)
    expect(text).not.toContain('上の理由')
    expect(text).not.toContain('invalid_label')
  })
  it('502 store_failed・400 invalid_purpose はそれぞれの文', () => {
    expect(issueErrorText(httpError(502, { error: 'store_failed' }))).toContain('時間をおいてもう一度試し')
    expect(issueErrorText(httpError(400, { error: 'invalid_purpose' }))).toContain('設定の不足')
  })
  it('403 は管理者だけ、401 はログインし直し (共通の文)', () => {
    expect(issueErrorText(httpError(403))).toBe('管理者だけが使えます')
    expect(issueErrorText(httpError(401))).toContain('再ログイン')
  })
  it('知らない失敗は「発行できませんでした (HTTP <status>)」', () => {
    expect(issueErrorText(httpError(500, { error: 'boom' }))).toBe('発行できませんでした (HTTP 500)')
    expect(issueErrorText(httpError(400))).toBe('発行できませんでした (HTTP 400)')
  })
  it('通信そのものの失敗は共通の文 (「発行」のやり直しつき)', () => {
    expect(issueErrorText(new TypeError('Failed to fetch'))).toContain('もう一度「発行」を押してください')
  })
})

describe('ISSUE_GUIDE', () => {
  it('1 回だけ表示されることと、トレイの右クリックからの入れ先を言う', () => {
    expect(ISSUE_GUIDE).toContain('1 回だけ表示されます')
    expect(ISSUE_GUIDE).toContain('トレイのアイコンを右クリック')
    expect(ISSUE_GUIDE).toContain('『資格情報を設定』')
  })
})

describe('formatIssuedDate', () => {
  it('日本時間の日付', () => {
    expect(formatIssuedDate('2026-10-12T15:30:00Z')).toBe('2026-10-13')
    expect(formatIssuedDate('2026-10-12T14:59:59Z')).toBe('2026-10-12')
  })
  it('読めなければそのまま', () => {
    expect(formatIssuedDate('?')).toBe('?')
  })
})

describe('sortCredentials', () => {
  it('有効なものを先に、それぞれ新しい順。元の配列は変えない', () => {
    const a = row({ username: 'a', created_at: '2026-01-01', revoked: true })
    const b = row({ username: 'b', created_at: '2026-02-01' })
    const c = row({ username: 'c', created_at: '2026-03-01' })
    const d = row({ username: 'd', created_at: '2026-04-01', revoked: true })
    const input = [a, b, c, d]
    expect(sortCredentials(input).map(r => r.username)).toEqual(['c', 'b', 'd', 'a'])
    expect(input.map(r => r.username)).toEqual(['a', 'b', 'c', 'd'])
  })
})
