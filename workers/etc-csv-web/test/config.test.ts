import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ORIGIN_KV_KEY,
  ALLOWED_USER_IDS_KV_KEY,
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

describe('resolveAllowedOrigin / resolveAllowedUserIds', () => {
  it('KV に値があれば KV が勝つ (plain は使わない)', async () => {
    expect(await resolveAllowedOrigin(kvOf({ [ALLOWED_ORIGIN_KV_KEY]: 'kv' }), 'plain')).toBe('kv')
    expect(await resolveAllowedUserIds(kvOf({ [ALLOWED_USER_IDS_KV_KEY]: 'kv' }), 'plain')).toBe('kv')
  })

  it('KV に無ければ plain へ落ちる', async () => {
    expect(await resolveAllowedOrigin(kvOf({}), 'plain')).toBe('plain')
    expect(await resolveAllowedUserIds(kvOf({}), 'plain')).toBe('plain')
  })

  it('KV の値が空文字なら「無い」と同じ扱い', async () => {
    expect(await resolveAllowedOrigin(kvOf({ [ALLOWED_ORIGIN_KV_KEY]: '' }), 'plain')).toBe('plain')
  })

  it('binding が無くても plain で動く', async () => {
    expect(await resolveAllowedOrigin(undefined, 'plain')).toBe('plain')
    expect(await resolveAllowedUserIds({ notKv: true }, 'plain')).toBe('plain')
  })

  // 陰性対照: どちらにも無ければ undefined = 呼び出し側が fail-closed する材料。
  it('KV にも plain にも無ければ undefined', async () => {
    expect(await resolveAllowedOrigin(kvOf({}), undefined)).toBeUndefined()
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

describe('cache を置かない (kv key put が即効くことが要件)', () => {
  // `auth-worker` の `origins:wt` と同じ分類。cache を入れると、取り下げた値が
  // 最大 60 秒配られ続け、「投入したのに 404」の切り分けが KV の伝播と cache の
  // 二重になる (config.ts の doc 参照)。
  it('同じ値を 2 回解決したら KV を 2 回読む', async () => {
    const kv = kvOf({ [ALLOWED_ORIGIN_KV_KEY]: 'kv' })
    expect(await resolveAllowedOrigin(kv, undefined)).toBe('kv')
    expect(await resolveAllowedOrigin(kv, undefined)).toBe('kv')
    expect(kv.calls).toEqual([ALLOWED_ORIGIN_KV_KEY, ALLOWED_ORIGIN_KV_KEY])
  })

  it('KV の値が変わったら次の解決で即反映される (投入が効く)', async () => {
    expect(await resolveAllowedOrigin(kvOf({}), undefined)).toBeUndefined()
    expect(await resolveAllowedOrigin(kvOf({ [ALLOWED_ORIGIN_KV_KEY]: 'new' }), undefined)).toBe('new')
  })

  it('KV から値が消えたら次の解決で即消える (取り下げが効く)', async () => {
    expect(await resolveAllowedOrigin(kvOf({ [ALLOWED_ORIGIN_KV_KEY]: 'old' }), undefined)).toBe('old')
    expect(await resolveAllowedOrigin(kvOf({}), undefined)).toBeUndefined()
  })

  it('2 つのキーはそれぞれ 1 回ずつ読まれる', async () => {
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
