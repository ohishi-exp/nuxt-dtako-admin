import { describe, expect, it } from 'vitest'
import worker, { type Env } from '../src/index'
import { fakeBucket, obj } from './fake-bucket'

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
