import { describe, expect, it } from 'vitest'
import { downloadResult, listResult, type DownloadResult, type EtcCsvConfig } from '../src/handlers'
import { fakeBucket, obj } from './fake-bucket'

const CONFIG: EtcCsvConfig = { r2Prefix: 'etc', allowedUserIds: 'alice,bob' }
const EMPTY = () => fakeBucket([{ objects: [], truncated: false }])

function jsonStatus(result: DownloadResult): number {
  if (result.kind !== 'json') throw new Error('expected a json result')
  return result.status
}

describe('listResult', () => {
  it('date 省略なら日付一覧', async () => {
    const bucket = fakeBucket([
      { objects: [], truncated: false, delimitedPrefixes: ['etc/alice/2026-09-01/'] },
    ])
    expect(await listResult(bucket, CONFIG, 'alice', null)).toEqual({
      status: 200,
      body: { user_id: 'alice', dates: ['2026-09-01'] },
    })
    expect(bucket.calls[0]?.prefix).toBe('etc/alice/')
  })

  it('date 指定ならその日のオブジェクト', async () => {
    const bucket = fakeBucket([
      { objects: [obj('etc/alice/2026-09-01/060005.csv', 42)], truncated: false },
    ])
    expect(await listResult(bucket, CONFIG, 'alice', '2026-09-01')).toEqual({
      status: 200,
      body: {
        user_id: 'alice',
        date: '2026-09-01',
        objects: [
          { key: 'etc/alice/2026-09-01/060005.csv', size: 42, uploaded: '2026-09-01T00:00:00.000Z' },
        ],
      },
    })
    expect(bucket.calls[0]?.prefix).toBe('etc/alice/2026-09-01/')
  })

  it('user_id 未指定は 400', async () => {
    expect((await listResult(EMPTY(), CONFIG, null, null)).status).toBe(400)
  })

  it('date の形が違えば 400', async () => {
    expect((await listResult(EMPTY(), CONFIG, 'alice', '2026-9-1')).status).toBe(400)
  })

  // 陰性対照: allowlist 外の user_id は総当たりしても存在すら分からない。
  it('allowlist 外の user_id は 404 で、R2 を 1 度も叩かない', async () => {
    const bucket = EMPTY()
    expect(await listResult(bucket, CONFIG, 'carol', null)).toEqual({
      status: 404,
      body: { error: 'not found' },
    })
    expect(bucket.calls).toHaveLength(0)
  })

  // 陰性対照: 変数未設定なら誰も通らない。
  it('ETC_CSV_ALLOWED_USER_IDS 未設定なら allowlist 済みの id でも 404', async () => {
    const bucket = EMPTY()
    const result = await listResult(bucket, { r2Prefix: 'etc', allowedUserIds: undefined }, 'alice', null)
    expect(result.status).toBe(404)
    expect(bucket.calls).toHaveLength(0)
  })

  it('R2 binding が無ければ 503', async () => {
    expect((await listResult(undefined, CONFIG, 'alice', null)).status).toBe(503)
  })

  // 陰性対照: 未知の ETC_R2_PREFIX を入れても任意 prefix を list できない。
  it('ETC_R2_PREFIX が未知なら 503 で、R2 を叩かない', async () => {
    const bucket = EMPTY()
    const result = await listResult(bucket, { r2Prefix: 'restraint', allowedUserIds: 'alice' }, 'alice', null)
    expect(result.status).toBe(503)
    expect(bucket.calls).toHaveLength(0)
  })
})

describe('downloadResult', () => {
  const KEY = 'etc/alice/2026-09-01/060005.csv'
  const withBody = () => fakeBucket([], { [KEY]: 'header\r\n1,2,3\r\n' })

  it('本体を返す', async () => {
    const result = await downloadResult(withBody(), CONFIG, KEY)
    expect(result).toMatchObject({ kind: 'csv', filename: 'alice_2026-09-01_060005.csv' })
    if (result.kind !== 'csv') throw new Error('unreachable')
    expect(new TextDecoder().decode(result.bytes)).toBe('header\r\n1,2,3\r\n')
  })

  it('R2 に無ければ 404', async () => {
    expect(await downloadResult(withBody(), CONFIG, 'etc/alice/2026-09-01/070000.csv')).toEqual({
      kind: 'json',
      status: 404,
      body: { error: 'not found' },
    })
  })

  it('key 未指定は 400', async () => {
    expect(jsonStatus(await downloadResult(withBody(), CONFIG, null))).toBe(400)
  })

  // 陰性対照: 不正な鍵は R2 に到達しない。
  it.each([
    ['他 prefix', 'restraint/alice/2026-09-01/060005.csv'],
    ['path traversal', 'etc/../restraint/alice/2026-09-01/060005.csv'],
    ['header injection', 'etc/alice/2026-09-01/060005.csv"\r\nX: y'],
  ])('%s は 400', async (_label, key) => {
    const bucket = withBody()
    expect(await downloadResult(bucket, CONFIG, key)).toEqual({
      kind: 'json',
      status: 400,
      body: { error: 'invalid ETC CSV key' },
    })
  })

  // 陰性対照: 鍵の形としては通る別環境の prefix も、この worker からは配らない。
  it('env の prefix と違う環境の鍵は 404', async () => {
    expect(
      await downloadResult(withBody(), CONFIG, 'etc-staging/alice/2026-09-01/060005.csv'),
    ).toEqual({ kind: 'json', status: 404, body: { error: 'not found' } })
  })

  // 陰性対照: /list を通さず鍵を直接推測しても allowlist 外は読めない。
  it('allowlist 外の user_id の鍵は 404', async () => {
    expect(await downloadResult(withBody(), CONFIG, 'etc/carol/2026-09-01/060005.csv')).toEqual({
      kind: 'json',
      status: 404,
      body: { error: 'not found' },
    })
  })

  it('R2 binding が無ければ 503', async () => {
    expect(jsonStatus(await downloadResult(undefined, CONFIG, KEY))).toBe(503)
  })

  it('ETC_R2_PREFIX が未知なら 503', async () => {
    expect(jsonStatus(await downloadResult(withBody(), { r2Prefix: 'x', allowedUserIds: 'alice' }, KEY))).toBe(503)
  })
})
