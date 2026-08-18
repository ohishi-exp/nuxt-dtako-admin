import { describe, it, expect, vi } from 'vitest'
import { saveBrowserCredential, type CredentialScope } from '~/utils/browser-credentials'

/** Credential Management API を持つブラウザの写し。 */
function scopeWith(store = vi.fn(async () => undefined)) {
  const seen: Array<{ id: string, password: string }> = []
  const scope: CredentialScope = {
    PasswordCredential: class {
      constructor(init: { id: string, password: string }) { seen.push(init) }
    },
    navigator: { credentials: { store } },
  }
  return { scope, store, seen }
}

describe('saveBrowserCredential', () => {
  it('資格情報を組み立てて store に渡す', async () => {
    const { scope, store, seen } = scopeWith()
    await expect(saveBrowserCredential('yhonda', 'pw', scope)).resolves.toBe(true)
    expect(seen).toEqual([{ id: 'yhonda', password: 'pw' }])
    expect(store).toHaveBeenCalledTimes(1)
  })

  it('API の無いブラウザでは何もしない', async () => {
    await expect(saveBrowserCredential('yhonda', 'pw', {})).resolves.toBe(false)
    const { scope } = scopeWith()
    await expect(saveBrowserCredential('yhonda', 'pw', { PasswordCredential: scope.PasswordCredential }))
      .resolves.toBe(false)
  })

  it('空の資格情報は預けない (Chrome が空のまま提案してくるため)', async () => {
    const { scope, store } = scopeWith()
    await expect(saveBrowserCredential('', 'pw', scope)).resolves.toBe(false)
    await expect(saveBrowserCredential('yhonda', '', scope)).resolves.toBe(false)
    expect(store).not.toHaveBeenCalled()
  })

  it('断られても接続を止めない', async () => {
    const { scope } = scopeWith(vi.fn(async () => { throw new Error('NotAllowedError') }))
    await expect(saveBrowserCredential('yhonda', 'pw', scope)).resolves.toBe(false)
  })

  it('scope 省略時は global を見る', async () => {
    // happy-dom には Credential Management API が無いので false になる。
    await expect(saveBrowserCredential('yhonda', 'pw')).resolves.toBe(false)
  })
})
