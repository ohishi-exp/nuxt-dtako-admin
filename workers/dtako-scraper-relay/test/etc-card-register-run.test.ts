import { describe, expect, it, vi } from 'vitest'
import {
  CARD_REGISTER_BATCH_LIMIT,
  MAX_OPERATION_PAGES,
  MAX_TOLL_FETCHES,
  runCardRegistrations,
  selectRegistrationsQuery,
  targetStatuses,
  type CardRegisterDb,
  type CardRegisterRunDeps,
} from '../src/etc-card-register-run'
import type { EtcCardRegisterOutcome } from '../src/etc-meisai-client'

// ★ 番号はすべて架空値 (public repo)。
const CARD = '0000111122223333'
const OBU = '9999988888888777777'
const NOW = new Date('2026-11-26T00:00:00Z') // 09:00 JST、範囲 2026-09-26〜2026-11-26

interface Row {
  id: number
  card_number: string | null
  plate4: string | null
  obu_number: string | null
  tenant_id: string | null
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 1,
  card_number: CARD,
  plate4: '1234',
  obu_number: OBU,
  tenant_id: 'tenant-a',
  ...over,
})

function fakeDb(rows: Row[] | undefined) {
  const selects: { sql: string; params: unknown[] }[] = []
  const updates: { sql: string; params: unknown[] }[] = []
  const db: CardRegisterDb = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all<T>() {
              selects.push({ sql, params })
              return { results: rows as unknown as T[] | undefined }
            },
            async run() {
              updates.push({ sql, params })
              return {}
            },
          }
        },
      }
    },
  }
  return { db, selects, updates }
}

const opsBody = (ops: { unko_no: string; vehicle_cd: string; reading_date: string }[], total = ops.length, page = 1) =>
  JSON.stringify({ operations: ops, total, page, per_page: 200 })

const tollsBody = (endDates: string[]) =>
  JSON.stringify({
    headers: ['運行NO', '終了日時', 'ETC利用'],
    rows: endDates.map((d) => ['U', `${d.replace(/-/g, '/')} 10:00:00`, '1']),
  })

function deps(over: Partial<CardRegisterRunDeps> & { rows?: Row[] } = {}) {
  const { db, selects, updates } = fakeDb(over.rows ?? [row()])
  const puts: { key: string; html: string }[] = []
  const d: CardRegisterRunDeps = {
    db,
    now: NOW,
    mode: 'dry_run',
    r2Prefix: 'etc',
    getOperations: vi.fn(async () =>
      opsBody([
        { unko_no: 'U1', vehicle_cd: '10001234', reading_date: '2026-11-01' },
        { unko_no: 'U2', vehicle_cd: '10001234', reading_date: '2026-11-20' },
        { unko_no: 'X1', vehicle_cd: '10009999', reading_date: '2026-11-20' },
      ]),
    ),
    getTolls: vi.fn(async (_t: string, u: string) => (u === 'U2' ? tollsBody(['2026-11-19']) : tollsBody(['2026-11-21']))),
    register: vi.fn(async (): Promise<EtcCardRegisterOutcome> => ({ kind: 'confirmed', html: '<p>確認</p>' })),
    putHtml: vi.fn(async (key: string, html: string) => {
      puts.push({ key, html })
    }),
    ...over,
  }
  return { d, selects, updates, puts }
}

describe('targetStatuses / selectRegistrationsQuery', () => {
  it('cron は dry-run なら waiting_run だけ、live なら dry_run_ok も。手動は failed まで', () => {
    expect(targetStatuses({ kind: 'cron' }, 'dry_run')).toEqual(['waiting_run'])
    expect(targetStatuses({ kind: 'cron' }, 'live')).toEqual(['waiting_run', 'dry_run_ok'])
    expect(targetStatuses({ kind: 'one', id: 3 }, 'dry_run')).toEqual(['waiting_run', 'dry_run_ok', 'failed'])
  })

  it('SQL は tenant を明細書 (etc_card_scans) から引き、手動は id で絞る', () => {
    const cron = selectRegistrationsQuery({ kind: 'cron' }, 'dry_run')
    expect(cron.sql).toContain('LEFT JOIN etc_card_scans s ON s.sha256 = r.scan_sha256')
    expect(cron.sql).toContain('r.status IN (?)')
    expect(cron.sql).not.toContain('r.id = ?')
    expect(cron.params).toEqual(['waiting_run', CARD_REGISTER_BATCH_LIMIT])
    const one = selectRegistrationsQuery({ kind: 'one', id: 9 }, 'live')
    expect(one.sql).toContain('r.status IN (?, ?, ?) AND r.id = ?')
    expect(one.params).toEqual(['waiting_run', 'dry_run_ok', 'failed', 9, CARD_REGISTER_BATCH_LIMIT])
  })
})

describe('runCardRegistrations', () => {
  it('dry-run: 一致した車両の運行から最新の走行日 (終了日) を選び、確認画面を R2 に置いて dry_run_ok', async () => {
    const { d, updates, puts } = deps()
    const report = await runCardRegistrations(d, { kind: 'cron' })

    expect(report).toEqual({
      notFound: false,
      results: [{ id: 1, cardNumber: CARD, kind: 'dry_run_ok', runDate: '2026-11-21', detail: undefined }],
    })
    // 運行一覧は探す範囲で読む
    expect(d.getOperations).toHaveBeenCalledWith('tenant-a', '?date_from=2026-09-26&date_to=2026-11-26&page=1&per_page=200')
    // 一致しない車両 (X1) の CSV は読まない。読取日の新しい順
    expect(vi.mocked(d.getTolls).mock.calls.map((c) => c[1])).toEqual(['U2', 'U1'])
    expect(d.register).toHaveBeenCalledWith(expect.objectContaining({ icCardID: CARD, riyonengappiDay: '21', sharyoNo: '1234' }))
    expect(puts).toEqual([{ key: 'etc-card-register/1/20261126090000-confirm.html', html: '<p>確認</p>' }])
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toContain('SET status = ?')
    expect(updates[0].params).toEqual(['dry_run_ok', '2026-11-21', 'U1', 1, null, NOW.toISOString(), 1])
  })

  it('live: 完了なら registered (R2 には置かない)', async () => {
    const { d, updates, puts } = deps({
      mode: 'live',
      register: vi.fn(async (): Promise<EtcCardRegisterOutcome> => ({ kind: 'registered', html: 'done' })),
    })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report.results[0].kind).toBe('registered')
    expect(puts).toEqual([])
    expect(updates[0].params[0]).toBe('registered')
  })

  it('弾かれた画面は原本を errors/ に置いて failed', async () => {
    const { d, updates, puts } = deps({
      register: vi.fn(async (): Promise<EtcCardRegisterOutcome> => ({ kind: 'rejected', html: 'ng', reason: '入力画面に戻されました' })),
    })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    const key = 'etc-errors/card-register/1/20261126090000.html'
    expect(puts).toEqual([{ key, html: 'ng' }])
    expect(report.results[0]).toMatchObject({ kind: 'failed', detail: `入力画面に戻されました (原本 ${key})` })
    expect(updates[0].params.slice(0, 4)).toEqual(['failed', '2026-11-21', 'U1', 1])
  })

  it('登録中の例外は error: status は変えず attempts+1 と last_error だけ', async () => {
    const { d, updates } = deps({
      register: vi.fn(async () => {
        throw new Error('timeout')
      }),
    })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report.results[0]).toMatchObject({ kind: 'error', detail: 'etc-meisai.jp への登録で失敗: timeout' })
    expect(updates[0].sql).not.toContain('status')
    expect(updates[0].params).toEqual([1, 'etc-meisai.jp への登録で失敗: timeout', NOW.toISOString(), 1])
  })

  it('走行が見つからない → no_run、D1 も etc-meisai.jp も触らない', async () => {
    for (const getTolls of [
      vi.fn(async () => null), // CSV が無い運行
      vi.fn(async () => tollsBody([])),
      vi.fn(async () => tollsBody(['2026-09-01'])), // 範囲外
    ]) {
      const { d, updates } = deps({ getTolls })
      const report = await runCardRegistrations(d, { kind: 'cron' })
      expect(report.results[0]).toMatchObject({ kind: 'no_run' })
      expect(d.register).not.toHaveBeenCalled()
      expect(updates).toEqual([])
    }
  })

  it('一致する車両が無い → no_run', async () => {
    const { d, updates } = deps({ rows: [row({ plate4: '5678' })] })
    expect((await runCardRegistrations(d, { kind: 'cron' })).results[0].kind).toBe('no_run')
    expect(d.getTolls).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('車両が複数一致 → failed (登録しない)', async () => {
    const { d, updates } = deps({
      getOperations: vi.fn(async () =>
        opsBody([
          { unko_no: 'U1', vehicle_cd: '10001234', reading_date: '2026-11-01' },
          { unko_no: 'U2', vehicle_cd: '20001234', reading_date: '2026-11-02' },
        ]),
      ),
    })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report.results[0]).toMatchObject({ kind: 'failed', detail: '車両が複数一致 (車輌CD 10001234, 20001234)' })
    expect(d.register).not.toHaveBeenCalled()
    expect(updates[0].params).toEqual(['failed', null, null, 0, '車両が複数一致 (車輌CD 10001234, 20001234)', NOW.toISOString(), 1])
  })

  it('tenant / plate4 が無い行は failed', async () => {
    const { d } = deps({ rows: [row({ id: 1, tenant_id: null }), row({ id: 2, plate4: null })] })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report.results.map((r) => [r.kind, r.detail])).toEqual([
      ['failed', '明細書の会社 (tenant) が分かりません'],
      ['failed', 'ナンバー下 4 桁がありません'],
    ])
    expect(d.getOperations).not.toHaveBeenCalled()
  })

  it('フォームの値が組めない (車載器番号の桁違い等) → failed、送らない', async () => {
    const { d, updates } = deps({ rows: [row({ obu_number: '123' })] })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report.results[0]).toMatchObject({ kind: 'failed', runDate: '2026-11-21' })
    expect(d.register).not.toHaveBeenCalled()
    expect(updates[0].params.slice(0, 4)).toEqual(['failed', '2026-11-21', 'U1', 0])
  })

  it('照合の失敗 (alc の 403 等) は error、status は変えない', async () => {
    const { d, updates } = deps({
      getTolls: vi.fn(async () => {
        throw new Error('alc-internal-proxy failed (403)')
      }),
    })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report.results[0]).toMatchObject({ kind: 'error', detail: '走行の照合に失敗: alc-internal-proxy failed (403)' })
    expect(updates[0].params).toEqual([0, '走行の照合に失敗: alc-internal-proxy failed (403)', NOW.toISOString(), 1])
  })

  it('非 Error の throw も文にする', async () => {
    const { d } = deps({
      getOperations: vi.fn(async () => {
        throw 'boom'
      }),
    })
    expect((await runCardRegistrations(d, { kind: 'cron' })).results[0].detail).toBe('走行の照合に失敗: boom')
  })

  it('運行一覧は全ページ読み、tenant ごとに 1 回だけ読む', async () => {
    const getOperations = vi.fn(async (_t: string, search: string) =>
      search.includes('page=1&')
        ? opsBody([{ unko_no: 'U1', vehicle_cd: '10001234', reading_date: '2026-11-01' }], 2, 1)
        : JSON.stringify({ operations: [{ unko_no: 'U2', vehicle_cd: '10001234', reading_date: '2026-11-02' }], total: 2, page: 2, per_page: 1 }),
    )
    const pageOne = vi.fn(async () => JSON.stringify({ operations: [{ unko_no: 'U1', vehicle_cd: '10001234', reading_date: '2026-11-01' }], total: 2, page: 1, per_page: 1 }))
    const { d } = deps({ rows: [row({ id: 1 }), row({ id: 2 })], getOperations: vi.fn(async (t: string, s: string) => (s.includes('page=1&') ? pageOne() : getOperations(t, s))) })
    await runCardRegistrations(d, { kind: 'cron' })
    expect(vi.mocked(d.getOperations).mock.calls.map((c) => c[1].match(/page=(\d+)/)![1])).toEqual(['1', '2'])
    expect(vi.mocked(d.getTolls).mock.calls.map((c) => c[1])).toEqual(['U2', 'U1', 'U2', 'U1'])
  })

  it('運行一覧が上限ページを超えたら止める (error)', async () => {
    const { d } = deps({
      getOperations: vi.fn(async (_t: string, s: string) =>
        JSON.stringify({
          operations: [{ unko_no: 'U', vehicle_cd: '10001234', reading_date: '2026-11-01' }],
          total: 1_000_000,
          page: Number(s.match(/page=(\d+)/)![1]),
          per_page: 1,
        }),
      ),
    })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report.results[0].detail).toContain(`${MAX_OPERATION_PAGES} ページを超えました`)
    expect(d.getOperations).toHaveBeenCalledTimes(MAX_OPERATION_PAGES)
  })

  it('料金所 CSV は 1 車両あたり上限件数まで', async () => {
    const ops = Array.from({ length: MAX_TOLL_FETCHES + 5 }, (_, i) => ({
      unko_no: `U${i}`,
      vehicle_cd: '10001234',
      reading_date: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`,
    }))
    const { d } = deps({ getOperations: vi.fn(async () => opsBody(ops)), getTolls: vi.fn(async () => null) })
    await runCardRegistrations(d, { kind: 'cron' })
    expect(d.getTolls).toHaveBeenCalledTimes(MAX_TOLL_FETCHES)
  })

  it('手動 1 件: 行が無ければ notFound', async () => {
    const { d } = deps({ rows: [] })
    expect(await runCardRegistrations(d, { kind: 'one', id: 5 })).toEqual({ notFound: true, results: [] })
  })

  it('D1 が results を返さなくても 0 件として扱う (cron)', async () => {
    const { d } = deps()
    const { db } = fakeDb(undefined)
    expect(await runCardRegistrations({ ...d, db }, { kind: 'cron' })).toEqual({ notFound: false, results: [] })
  })
})
