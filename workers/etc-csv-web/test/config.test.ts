import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_ORIGIN_KV_KEY,
  ALLOWED_USER_IDS_KV_KEY,
  _clearConfigCacheForTest,
  resolveAllowedOrigin,
  resolveAllowedUserIds,
} from '../src/config'

function kvOf(entries: Record<string, string>) {
  const calls: string[] = []
  return {
    calls,
    async get(key: string) {
      calls.push(key)
      return entries[key] ?? null
    },
  }
}

// cache は module スコープなので、テスト間で値が漏れないよう毎回消す。
beforeEach(() => {
  _clearConfigCacheForTest()
  vi.useRealTimers()
})

describe('resolveAllowedOrigin / resolveAllowedUserIds', () => {
  it('KV に値があれば KV が勝つ (plain は使わない)', async () => {
    expect(await resolveAllowedOrigin(kvOf({ [ALLOWED_ORIGIN_KV_KEY]: 'kv' }), 'plain')).toBe('kv')
    _clearConfigCacheForTest()
    expect(await resolveAllowedUserIds(kvOf({ [ALLOWED_USER_IDS_KV_KEY]: 'kv' }), 'plain')).toBe('kv')
  })

  it('KV に無ければ plain へ落ちる', async () => {
    expect(await resolveAllowedOrigin(kvOf({}), 'plain')).toBe('plain')
    _clearConfigCacheForTest()
    expect(await resolveAllowedUserIds(kvOf({}), 'plain')).toBe('plain')
  })

  it('KV の値が空文字なら「無い」と同じ扱い', async () => {
    expect(await resolveAllowedOrigin(kvOf({ [ALLOWED_ORIGIN_KV_KEY]: '' }), 'plain')).toBe('plain')
  })

  it('binding が無くても plain で動く', async () => {
    expect(await resolveAllowedOrigin(undefined, 'plain')).toBe('plain')
    _clearConfigCacheForTest()
    expect(await resolveAllowedUserIds({ notKv: true }, 'plain')).toBe('plain')
  })

  // 陰性対照: どちらにも無ければ undefined = 呼び出し側が fail-closed する材料。
  it('KV にも plain にも無ければ undefined', async () => {
    expect(await resolveAllowedOrigin(kvOf({}), undefined)).toBeUndefined()
    _clearConfigCacheForTest()
    expect(await resolveAllowedUserIds(undefined, undefined)).toBeUndefined()
  })

  // ★ auth-worker の readKey は失敗を "" に畳むが、ここは意図的に違える。
  // 畳むと plain へ落ちてしまい、取り下げたはずの値で配り続ける (config.ts 参照)。
  it('KV の読み取りが失敗したら plain に落とさず throw する', async () => {
    const broken = {
      async get() {
        throw new Error('kv unavailable')
      },
    }
    await expect(resolveAllowedOrigin(broken, 'plain')).rejects.toThrow('kv unavailable')
  })
})

describe('in-memory cache (auth-worker の CACHE_TTL_MS = 60s と同じ)', () => {
  it('2 回目は KV を叩かない', async () => {
    const kv = kvOf({ [ALLOWED_ORIGIN_KV_KEY]: 'kv' })
    expect(await resolveAllowedOrigin(kv, undefined)).toBe('kv')
    expect(await resolveAllowedOrigin(kv, undefined)).toBe('kv')
    expect(kv.calls).toHaveLength(1)
  })

  it('60 秒を過ぎたら読み直す (値の取り下げが反映される)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'))
    const first = kvOf({ [ALLOWED_ORIGIN_KV_KEY]: 'old' })
    expect(await resolveAllowedOrigin(first, undefined)).toBe('old')

    vi.setSystemTime(new Date('2026-09-03T00:00:59Z')) // まだ TTL 内
    expect(await resolveAllowedOrigin(kvOf({}), undefined)).toBe('old')

    vi.setSystemTime(new Date('2026-09-03T00:01:01Z')) // TTL 超過
    const after = kvOf({})
    expect(await resolveAllowedOrigin(after, undefined)).toBeUndefined()
    expect(after.calls).toEqual([ALLOWED_ORIGIN_KV_KEY])
  })

  it('2 つのキーは別々にキャッシュされる', async () => {
    const kv = kvOf({ [ALLOWED_ORIGIN_KV_KEY]: 'o', [ALLOWED_USER_IDS_KV_KEY]: 'u' })
    expect(await resolveAllowedOrigin(kv, undefined)).toBe('o')
    expect(await resolveAllowedUserIds(kv, undefined)).toBe('u')
    expect(kv.calls).toEqual([ALLOWED_ORIGIN_KV_KEY, ALLOWED_USER_IDS_KV_KEY])
  })
})

/**
 * 投入手順は README にしか書けない (人がやる作業なので)。**キー名が食い違うと、
 * 手順どおり投入したのに fail-closed で全部 404 のまま**という、いちばん気づきにくい
 * 壊れ方をする。目視に頼らず literal で照合する。
 */
describe('KV のキー名が README / wrangler.toml と一致する', () => {
  const readme = readFileSync(join(import.meta.dirname, '../README.md'), 'utf8')
  const toml = readFileSync(join(import.meta.dirname, '../wrangler.toml'), 'utf8')

  it('陽性対照: 読み込んだのが本物のファイルである', () => {
    expect(readme).toContain('wrangler kv key put')
    expect(toml).toContain('[[kv_namespaces]]')
  })

  it('キー名は auth-worker と同じ `<scope>:<name>` 形式', () => {
    expect(ALLOWED_ORIGIN_KV_KEY).toBe('etc-csv:allowed-origin')
    expect(ALLOWED_USER_IDS_KV_KEY).toBe('etc-csv:allowed-user-ids')
  })

  it.each([
    ['origin', ALLOWED_ORIGIN_KV_KEY],
    ['user_ids', ALLOWED_USER_IDS_KV_KEY],
  ])('%s のキー名が README と wrangler.toml の両方に現れる', (_label, key) => {
    expect(readme).toContain(key)
    expect(toml).toContain(key)
  })

  it('binding 名も一致する', () => {
    expect(toml).toContain('binding = "AUTH_CONFIG"')
    expect(readme).toContain('AUTH_CONFIG')
  })
})
