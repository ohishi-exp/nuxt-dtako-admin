import { describe, expect, it } from 'vitest'
import { listDateDirs, listEtcCsvObjects } from '../src/r2'
import { fakeBucket, obj } from './fake-bucket'

describe('listDateDirs', () => {
  it('delimitedPrefixes を cursor で全ページ回収し、日付だけを昇順で返す', async () => {
    const bucket = fakeBucket([
      { objects: [], truncated: true, cursor: 'c1', delimitedPrefixes: ['etc/u1/2026-09-02/', 'etc/u1/2026-09-01/'] },
      // 2 ページ目は delimitedPrefixes を返さない (`?? []` の分岐)
      { objects: [], truncated: true, cursor: 'c2' },
      { objects: [], truncated: false, delimitedPrefixes: ['etc/u1/2026-08-31/', 'etc/u1/errors/'] },
    ])
    expect(await listDateDirs(bucket, 'etc/u1/')).toEqual(['2026-08-31', '2026-09-01', '2026-09-02'])
    expect(bucket.calls).toEqual([
      { prefix: 'etc/u1/', delimiter: '/', cursor: undefined, limit: 1000 },
      { prefix: 'etc/u1/', delimiter: '/', cursor: 'c1', limit: 1000 },
      { prefix: 'etc/u1/', delimiter: '/', cursor: 'c2', limit: 1000 },
    ])
  })

  it('truncated でも cursor が無ければ打ち切る', async () => {
    const bucket = fakeBucket([{ objects: [], truncated: true, delimitedPrefixes: ['etc/u1/2026-09-01/'] }])
    expect(await listDateDirs(bucket, 'etc/u1/')).toEqual(['2026-09-01'])
    expect(bucket.calls).toHaveLength(1)
  })

  // 陰性対照: 日付の形をしていないディレクトリは返さない。
  it('日付でないディレクトリは捨てる', async () => {
    const bucket = fakeBucket([
      { objects: [], truncated: false, delimitedPrefixes: ['etc/u1/errors/', 'etc/u1/2026-9-1/'] },
    ])
    expect(await listDateDirs(bucket, 'etc/u1/')).toEqual([])
  })
})

describe('listEtcCsvObjects', () => {
  it('cursor で全件回収し、key 昇順で返す (uploaded は Date/文字列どちらも ISO 文字列に揃える)', async () => {
    const bucket = fakeBucket([
      {
        objects: [obj('etc/u1/2026-09-01/090000.csv', 20), obj('etc/u1/2026-09-01/060005.csv', 10)],
        truncated: true,
        cursor: 'c1',
      },
      {
        objects: [obj('etc/u1/2026-09-01/070000.csv', 30, '2026-09-01T07:00:00.000Z')],
        truncated: false,
      },
    ])
    expect(await listEtcCsvObjects(bucket, 'etc/u1/2026-09-01/')).toEqual([
      { key: 'etc/u1/2026-09-01/060005.csv', size: 10, uploaded: '2026-09-01T00:00:00.000Z' },
      { key: 'etc/u1/2026-09-01/070000.csv', size: 30, uploaded: '2026-09-01T07:00:00.000Z' },
      { key: 'etc/u1/2026-09-01/090000.csv', size: 20, uploaded: '2026-09-01T00:00:00.000Z' },
    ])
    expect(bucket.calls).toEqual([
      { prefix: 'etc/u1/2026-09-01/', cursor: undefined, limit: 1000 },
      { prefix: 'etc/u1/2026-09-01/', cursor: 'c1', limit: 1000 },
    ])
  })

  // 陰性対照: 一覧に出た鍵は必ず /download でも通る、という不変条件。
  it('ETC_CSV_KEY_PATTERN に合わない鍵は返さない', async () => {
    const bucket = fakeBucket([
      {
        objects: [obj('etc/u1/2026-09-01/note.txt'), obj('etc/u1/2026-09-01/060005.csv')],
        truncated: false,
      },
    ])
    const got = await listEtcCsvObjects(bucket, 'etc/u1/2026-09-01/')
    expect(got.map((o) => o.key)).toEqual(['etc/u1/2026-09-01/060005.csv'])
  })
})
