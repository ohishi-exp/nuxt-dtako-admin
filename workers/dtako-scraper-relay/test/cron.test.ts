import { describe, expect, it } from 'vitest'
import {
  CronConfigError,
  DTAKO_CRON,
  ETC_CRON,
  etcCsvKey,
  parseDtakoAccounts,
  parseEtcAccounts,
  resolveSecretBinding,
  runScheduledCron,
  yesterdayJst,
  type CronDoCall,
} from '../src/cron'

const DTAKO_ACCOUNTS_JSON = JSON.stringify([
  { comp_id: '27324455', user_name: 'u1', user_pass: 'p1', tenant_id: 't1' },
  { comp_id: '99999999', user_name: 'u2', user_pass: 'p2', tenant_id: 't2' },
])

const ETC_ACCOUNTS_JSON = JSON.stringify([
  { user_id: 'etc1', password: 'p1' },
  { user_id: 'etc2', password: 'p2' },
])

function okDoCall(calls: Array<{ doKey: string; path: string; body: Record<string, string> }>): CronDoCall {
  return async (doKey, path, body) => {
    calls.push({ doKey, path, body })
    return { ok: true, status: 202, text: '{"accepted":true}' }
  }
}

describe('parseDtakoAccounts / parseEtcAccounts', () => {
  it('未設定 (undefined / 空文字) は空配列', () => {
    expect(parseDtakoAccounts(undefined)).toEqual([])
    expect(parseEtcAccounts('')).toEqual([])
  })

  it('JSON 配列をパースする', () => {
    expect(parseDtakoAccounts(DTAKO_ACCOUNTS_JSON)).toHaveLength(2)
    expect(parseEtcAccounts(ETC_ACCOUNTS_JSON)[0].user_id).toBe('etc1')
  })

  it('JSON 不正 / 非配列は CronConfigError で loud fail する', () => {
    expect(() => parseDtakoAccounts('not json')).toThrow(CronConfigError)
    expect(() => parseDtakoAccounts('{"a":1}')).toThrow('JSON 配列')
    expect(() => parseEtcAccounts('broken')).toThrow(CronConfigError)
    expect(() => parseEtcAccounts('"str"')).toThrow('JSON 配列')
  })
})

describe('yesterdayJst', () => {
  it('JST で昨日の日付を返す (dtako-scraper の default range と同じ)', () => {
    // 2026-07-03 00:30 JST = 2026-07-02 15:30 UTC → 昨日(JST) = 2026-07-02
    expect(yesterdayJst(new Date('2026-07-02T15:30:00Z'))).toBe('2026-07-02')
    // 2026-07-02 23:30 JST = 2026-07-02 14:30 UTC → 昨日(JST) = 2026-07-01
    expect(yesterdayJst(new Date('2026-07-02T14:30:00Z'))).toBe('2026-07-01')
  })
})

describe('etcCsvKey', () => {
  it('JST タイムスタンプで key を組み立てる', () => {
    // 2026-07-03 06:00:05 JST = 2026-07-02 21:00:05 UTC
    expect(etcCsvKey('etc', 'user1', new Date('2026-07-02T21:00:05Z'))).toBe(
      'etc/user1/2026-07-03/060005.csv',
    )
    expect(etcCsvKey('etc-staging', 'u', new Date('2026-07-02T21:00:05Z'))).toBe(
      'etc-staging/u/2026-07-03/060005.csv',
    )
  })
})

describe('resolveSecretBinding', () => {
  it('文字列 binding はそのまま返す', async () => {
    expect(await resolveSecretBinding('plain')).toBe('plain')
  })

  it('SecretsStoreSecret (.get()) は値を取り出す (null は空文字)', async () => {
    expect(await resolveSecretBinding({ get: async () => 'from-store' })).toBe('from-store')
    expect(await resolveSecretBinding({ get: async () => null })).toBe('')
  })

  it('どちらでもない binding は空文字', async () => {
    expect(await resolveSecretBinding(undefined)).toBe('')
    expect(await resolveSecretBinding(123)).toBe('')
  })
})

describe('runScheduledCron: dtako', () => {
  const now = new Date('2026-07-02T16:00:00Z') // 01:00 JST (7/3) → 昨日 = 2026-07-02

  it('SCRAPER_MODE が http 以外なら skip する (vpc-relay 中は VPS cron が担当)', async () => {
    const results = await runScheduledCron(DTAKO_CRON, { scraperMode: 'vpc-relay' }, okDoCall([]), now)
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
    expect(results[0].detail).toContain('SCRAPER_MODE=vpc-relay')

    const unset = await runScheduledCron(DTAKO_CRON, {}, okDoCall([]), now)
    expect(unset[0].detail).toContain('(unset)')
  })

  it('DTAKO_ACCOUNTS 未設定は skip する', async () => {
    const results = await runScheduledCron(DTAKO_CRON, { scraperMode: 'http' }, okDoCall([]), now)
    expect(results[0].detail).toContain('DTAKO_ACCOUNTS 未設定')
  })

  it('各社の comp_id 単位 DO に昨日 (JST) 1 日分の /cron/dtako を投げる', async () => {
    const calls: Array<{ doKey: string; path: string; body: Record<string, string> }> = []
    const results = await runScheduledCron(
      DTAKO_CRON,
      { scraperMode: 'http', dtakoAccountsRaw: DTAKO_ACCOUNTS_JSON },
      okDoCall(calls),
      now,
    )
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(calls[0]).toEqual({
      doKey: 'scraper-comp-27324455',
      path: '/cron/dtako',
      body: { comp_id: '27324455', start_date: '2026-07-02', end_date: '2026-07-02' },
    })
    expect(calls[1].doKey).toBe('scraper-comp-99999999')
  })

  it('DO 呼び出しの失敗 (throw) は per-account の error result になる', async () => {
    const failCall: CronDoCall = async (doKey) => {
      if (doKey.includes('27324455')) throw new Error('do down')
      throw 'string error'
    }
    const results = await runScheduledCron(
      DTAKO_CRON,
      { scraperMode: 'http', dtakoAccountsRaw: DTAKO_ACCOUNTS_JSON },
      failCall,
      now,
    )
    expect(results[0]).toMatchObject({ ok: false, detail: 'do down' })
    expect(results[1]).toMatchObject({ ok: false, detail: 'string error' })
  })

  it('DO が non-2xx を返したら ok=false で status を detail に載せる', async () => {
    const call: CronDoCall = async () => ({ ok: false, status: 500, text: 'account not found' })
    const results = await runScheduledCron(
      DTAKO_CRON,
      { scraperMode: 'http', dtakoAccountsRaw: DTAKO_ACCOUNTS_JSON },
      call,
      now,
    )
    expect(results[0].ok).toBe(false)
    expect(results[0].detail).toContain('HTTP 500')
  })
})

describe('runScheduledCron: etc', () => {
  const now = new Date('2026-07-02T21:00:00Z')

  it('ETC_ACCOUNTS 未設定は skip する', async () => {
    const results = await runScheduledCron(ETC_CRON, {}, okDoCall([]), now)
    expect(results[0].detail).toContain('ETC_ACCOUNTS 未設定')
  })

  it('アカウントごとに etc-{user_id} DO の /cron/etc を叩く (password は運ばない)', async () => {
    const calls: Array<{ doKey: string; path: string; body: Record<string, string> }> = []
    const results = await runScheduledCron(
      ETC_CRON,
      { etcAccountsRaw: ETC_ACCOUNTS_JSON },
      okDoCall(calls),
      now,
    )
    expect(results).toHaveLength(2)
    expect(calls[0]).toEqual({ doKey: 'etc-etc1', path: '/cron/etc', body: { user_id: 'etc1' } })
    expect(JSON.stringify(calls)).not.toContain('p1') // credential は DO 側で解決する
  })

  it('DO 呼び出しの失敗は per-account の error result になる', async () => {
    const failCall: CronDoCall = async (doKey) => {
      if (doKey === 'etc-etc1') throw new Error('boom')
      throw 42
    }
    const results = await runScheduledCron(ETC_CRON, { etcAccountsRaw: ETC_ACCOUNTS_JSON }, failCall, now)
    expect(results[0]).toMatchObject({ ok: false, detail: 'boom' })
    expect(results[1]).toMatchObject({ ok: false, detail: '42' })
  })
})

describe('runScheduledCron: 未知の cron 式', () => {
  it('wrangler.toml と cron.ts の定数ズレを loud に報告する', async () => {
    const results = await runScheduledCron('*/5 * * * *', {}, okDoCall([]), new Date())
    expect(results[0].kind).toBe('none')
    expect(results[0].ok).toBe(false)
    expect(results[0].detail).toContain('未知の cron 式')
  })
})
