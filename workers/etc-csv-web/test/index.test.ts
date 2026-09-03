import { beforeEach, describe, expect, it } from 'vitest'
import { _clearConfigCacheForTest } from '../src/config'
import worker, { type Env } from '../src/index'
import { fakeBucket, obj } from './fake-bucket'

// config の cache は module スコープ。テスト間で allowlist が漏れないよう毎回消す。
beforeEach(() => {
  _clearConfigCacheForTest()
})

const ORIGIN = 'https://example.invalid'
const KEY = 'etc/alice/2026-09-01/060005.csv'

function env(overrides: Partial<Env> = {}): Env {
  return {
    DTAKO_R2: fakeBucket(
      [
        {
          objects: [obj(KEY, 42)],
          truncated: false,
          delimitedPrefixes: ['etc/alice/2026-09-01/'],
        },
      ],
      { [KEY]: 'header\r\n1,2,3\r\n' },
    ),
    ETC_R2_PREFIX: 'etc',
    ETC_CSV_ALLOWED_ORIGIN: ORIGIN,
    ETC_CSV_ALLOWED_USER_IDS: 'alice,bob',
    ...overrides,
  }
}

function get(path: string, origin: string | null = ORIGIN, method = 'GET'): Request {
  return new Request(`https://etc-csv.invalid${path}`, {
    method,
    headers: origin === null ? {} : { Origin: origin },
  })
}

describe('fetch handler', () => {
  it('OPTIONS は 204 + CORS ヘッダ', async () => {
    const res = await worker.fetch(get('/list', ORIGIN, 'OPTIONS'), env())
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  // 陰性対照: 書き込みの口は無い。GET / OPTIONS 以外は全部 405。
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])('%s は 405', async (method) => {
    const res = await worker.fetch(get('/download?key=' + KEY, ORIGIN, method), env())
    expect(res.status).toBe(405)
  })

  it('GET /list は日付一覧', async () => {
    const res = await worker.fetch(get('/list?user_id=alice'), env())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user_id: 'alice', dates: ['2026-09-01'] })
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('GET /list?date= はその日のオブジェクト', async () => {
    const res = await worker.fetch(get('/list?user_id=alice&date=2026-09-01'), env())
    expect(await res.json()).toEqual({
      user_id: 'alice',
      date: '2026-09-01',
      objects: [{ key: KEY, size: 42, uploaded: '2026-09-01T00:00:00.000Z' }],
    })
  })

  it('GET /download は Shift_JIS の CSV として本体を返す', async () => {
    const res = await worker.fetch(get(`/download?key=${KEY}`), env())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=shift_jis')
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="alice_2026-09-01_060005.csv"',
    )
    expect(await res.text()).toBe('header\r\n1,2,3\r\n')
  })

  it('GET /download の失敗は JSON', async () => {
    const res = await worker.fetch(get('/download?key=restraint/a/2026-09-01/060005.csv'), env())
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid ETC CSV key' })
  })

  it('未知の path は 404', async () => {
    const res = await worker.fetch(get('/'), env())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  // 陰性対照: 許可外オリジンには CORS ヘッダを付けない (= ブラウザから読めない)。
  it('許可外オリジンには Access-Control-Allow-Origin を付けない', async () => {
    const res = await worker.fetch(get('/list?user_id=alice', 'https://evil-example.invalid'), env())
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('vary')).toBe('Origin')
  })

  // 陰性対照: 変数未設定なら誰にも CORS を返さない。
  it('ETC_CSV_ALLOWED_ORIGIN 未設定なら許可ヘッダ無し', async () => {
    const res = await worker.fetch(
      get('/list?user_id=alice'),
      env({ ETC_CSV_ALLOWED_ORIGIN: undefined }),
    )
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  // 陰性対照: allowlist 外の user_id は 404。
  it('allowlist 外の user_id は 404', async () => {
    const res = await worker.fetch(get('/list?user_id=carol'), env())
    expect(res.status).toBe(404)
  })

  it('ETC_CSV_ALLOWED_USER_IDS 未設定なら全部 404', async () => {
    const res = await worker.fetch(
      get('/list?user_id=alice'),
      env({ ETC_CSV_ALLOWED_USER_IDS: undefined }),
    )
    expect(res.status).toBe(404)
  })

  it('R2 binding が無ければ 503', async () => {
    const res = await worker.fetch(get('/list?user_id=alice'), env({ DTAKO_R2: undefined }))
    expect(res.status).toBe(503)
  })
})

/**
 * allowlist 2 つの出どころ (KV 正 / plain fallback) を **口から** 検査する。
 * `resolveKvConfig` 単体 (`config.test.ts`) だけだと「KV が勝つ」が worker の応答に
 * 効いているかは分からないので、ここでは 4 通りを 200/404 と CORS ヘッダの有無で見る。
 */
function kv(entries: Record<string, string>) {
  const calls: string[] = []
  return {
    calls,
    async get(key: string) {
      calls.push(key)
      return entries[key] ?? null
    },
  }
}
const KV_USERS = 'etc-csv:allowed-user-ids'
const KV_ORIGIN = 'etc-csv:allowed-origin'
const KV_ONLY_USER = 'kvuser'
const PLAIN_ONLY_USER = 'plainuser'
const KV_ONLY_ORIGIN = 'https://kv-origin.invalid'
const PLAIN_ONLY_ORIGIN = 'https://plain-origin.invalid'

/** allowlist だけを差し替えた env (R2 には両方の user のオブジェクトを置く)。 */
function envWith(overrides: Partial<Env>): Env {
  return env({
    ETC_CSV_ALLOWED_ORIGIN: undefined,
    ETC_CSV_ALLOWED_USER_IDS: undefined,
    ...overrides,
  })
}

describe('allowlist の出どころ (KV 正 / plain fallback)', () => {
  // (1) KV も plain も未設定 → fail-closed
  it('どちらも未設定なら 404 で CORS ヘッダも付かない', async () => {
    const res = await worker.fetch(get(`/list?user_id=${KV_ONLY_USER}`, KV_ONLY_ORIGIN), envWith({}))
    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  // (2) KV だけ設定 → 通る
  it('KV だけ設定なら通る', async () => {
    const e = envWith({
      AUTH_CONFIG: kv({ [KV_USERS]: KV_ONLY_USER, [KV_ORIGIN]: KV_ONLY_ORIGIN }),
    })
    const res = await worker.fetch(get(`/list?user_id=${KV_ONLY_USER}`, KV_ONLY_ORIGIN), e)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(KV_ONLY_ORIGIN)
  })

  // (3) plain だけ設定 → fallback で通る
  it('plain だけ設定なら fallback で通る', async () => {
    const e = envWith({
      ETC_CSV_ALLOWED_USER_IDS: PLAIN_ONLY_USER,
      ETC_CSV_ALLOWED_ORIGIN: PLAIN_ONLY_ORIGIN,
    })
    const res = await worker.fetch(get(`/list?user_id=${PLAIN_ONLY_USER}`, PLAIN_ONLY_ORIGIN), e)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(PLAIN_ONLY_ORIGIN)
  })

  // (4) 両方設定 (別の値) → ★ KV が勝ち、plain 側の値は通らない
  describe('両方設定なら KV が勝つ', () => {
    const both = () =>
      envWith({
        AUTH_CONFIG: kv({ [KV_USERS]: KV_ONLY_USER, [KV_ORIGIN]: KV_ONLY_ORIGIN }),
        ETC_CSV_ALLOWED_USER_IDS: PLAIN_ONLY_USER,
        ETC_CSV_ALLOWED_ORIGIN: PLAIN_ONLY_ORIGIN,
      })

    it('KV 側の user_id は通る', async () => {
      expect((await worker.fetch(get(`/list?user_id=${KV_ONLY_USER}`), both())).status).toBe(200)
    })

    it('plain 側にしか無い user_id は 404 (KV に負ける)', async () => {
      expect((await worker.fetch(get(`/list?user_id=${PLAIN_ONLY_USER}`), both())).status).toBe(404)
    })

    it('KV 側のオリジンには CORS ヘッダが付く', async () => {
      const res = await worker.fetch(get(`/list?user_id=${KV_ONLY_USER}`, KV_ONLY_ORIGIN), both())
      expect(res.headers.get('access-control-allow-origin')).toBe(KV_ONLY_ORIGIN)
    })

    it('plain 側にしか無いオリジンには CORS ヘッダが付かない (KV に負ける)', async () => {
      const res = await worker.fetch(get(`/list?user_id=${KV_ONLY_USER}`, PLAIN_ONLY_ORIGIN), both())
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  })
})

/**
 * ★★ この worker が借りている `AUTH_CONFIG` には **OAuth の refresh token / DCR /
 * device 系が同居**している。allowlist を読むためだけに bind しているので、
 * **「バグ 1 つで任意のキーが読める」形になっていないこと**を口から固定する。
 *
 * 検査するのは「リクエストを何に変えても、KV に渡るキーが定数 2 つのままであること」。
 * `user_id` / `date` / `key` / `Origin` / path / method のどれを動かしても、
 * `.get()` の引数が 1 つも増えない・変わらないことを呼び出し記録で見る。
 */
describe('KV のキーはコンパイル時定数 2 つだけ (リクエストが到達しない)', () => {
  const KEYS = [KV_ORIGIN, KV_USERS]

  /** KV への問い合わせを全部記録する env。 */
  function spyEnv() {
    const spy = kv({ [KV_USERS]: KV_ONLY_USER, [KV_ORIGIN]: KV_ONLY_ORIGIN })
    return { spy, e: envWith({ AUTH_CONFIG: spy }) }
  }

  it('陽性対照: 正常系では定数 2 つがちゃんと読まれている', async () => {
    const { spy, e } = spyEnv()
    await worker.fetch(get(`/list?user_id=${KV_ONLY_USER}`, KV_ONLY_ORIGIN), e)
    expect(new Set(spy.calls)).toEqual(new Set(KEYS))
  })

  it.each([
    ['user_id に KV のキーらしい値', '/list?user_id=etc-csv%3Aallowed-user-ids'],
    ['user_id に他人のキー', '/list?user_id=refresh%3Asomeone'],
    ['date に細工', '/list?user_id=x&date=device%3Apair'],
    ['download の key に細工', '/download?key=dcr%3Aclient'],
    ['path traversal 風', '/list?user_id=../../origins:prod'],
    ['未知の path', '/origins:prod'],
    ['空クエリ', '/list'],
  ])('%s でも KV に渡るキーは定数 2 つのまま', async (_label, path) => {
    const { spy, e } = spyEnv()
    await worker.fetch(get(path, 'https://attacker.invalid'), e)
    // 定数以外が 1 つでも混ざったら落ちる
    expect(spy.calls.filter((k) => !KEYS.includes(k))).toEqual([])
    expect(new Set(spy.calls).size).toBeLessThanOrEqual(KEYS.length)
  })

  it('Origin ヘッダを KV のキーに使っていない', async () => {
    const { spy, e } = spyEnv()
    await worker.fetch(get('/list?user_id=x', 'https://origins:prod'), e)
    expect(spy.calls.filter((k) => !KEYS.includes(k))).toEqual([])
  })

  it('OPTIONS / 405 でも余計なキーを読まない', async () => {
    for (const method of ['OPTIONS', 'POST']) {
      const { spy, e } = spyEnv()
      await worker.fetch(get('/list?user_id=refresh%3Ax', 'https://x.invalid', method), e)
      expect(spy.calls.filter((k) => !KEYS.includes(k))).toEqual([])
    }
  })
})
