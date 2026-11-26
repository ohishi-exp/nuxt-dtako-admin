import { describe, expect, it, vi } from 'vitest'
import {
  CARD_REGISTER_BATCH_LIMIT,
  confirmRunsFromTollCsv,
  runCardRegistrations,
  SELECT_WAITING_FOR_TENANT_SQL,
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

function fakeDb(rows: unknown[] | undefined) {
  const selects: { sql: string; params: unknown[] }[] = []
  const updates: { sql: string; params: unknown[] }[] = []
  const db: CardRegisterDb = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all<T>() {
              selects.push({ sql, params })
              return { results: rows as T[] | undefined }
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

// ---------------------------------------------------------------------------
// 確認 (zip 登録時)
// ---------------------------------------------------------------------------

const CSV = [
  '運行NO,車輌CD,開始日時,終了日時,ETC利用',
  'U1,10001234,2026/11/19 23:00:00,2026/11/20 01:00:00,1',
  'U2,10001234,2026/11/18 10:00:00,2026/11/18 11:00:00,1',
  'U3,10005678,2026/11/18 10:00:00,2026/11/18 11:00:00,0',
  'U4,20000042,2026/11/18 10:00:00,2026/11/18 11:00:00,1',
  'U5,30000042,2026/11/18 10:00:00,2026/11/18 11:00:00,1',
].join('\r\n')

describe('confirmRunsFromTollCsv', () => {
  const wrow = (id: number, plate4: string, run_date: string | null = null) => ({ id, card_number: CARD, plate4, run_date })

  it('tenant の waiting_run の行ごとに: 書く / 古くない run_date は残す / 走行なし / 複数一致は failed', async () => {
    const { db, selects, updates } = fakeDb([
      wrow(1, '1234'), // 空 → 2026-11-20 を書く
      wrow(2, '1234', '2026-11-10'), // 古い → 上書き
      wrow(3, '1234', '2026-11-20'), // 同じ日 → 残す
      wrow(4, '5678'), // ETC でない走行だけ → none
      wrow(5, '42'), // 車輌CD が 2 種類
    ])
    const report = await confirmRunsFromTollCsv({ db, now: NOW }, 'tenant-a', CSV)

    expect(selects).toEqual([{ sql: SELECT_WAITING_FOR_TENANT_SQL, params: ['tenant-a'] }])
    expect(SELECT_WAITING_FOR_TENANT_SQL).toContain("r.status = 'waiting_run'")
    expect(SELECT_WAITING_FOR_TENANT_SQL).toContain('s.tenant_id = ?')
    expect(report.nonEtcRows).toBe(1)
    expect(report.results.map((r) => [r.id, r.kind, r.runDate ?? null])).toEqual([
      [1, 'found', '2026-11-20'],
      [2, 'found', '2026-11-20'],
      [3, 'kept', '2026-11-20'],
      [4, 'none', null],
      [5, 'multiple', null],
    ])
    const at = NOW.toISOString()
    expect(updates.map((u) => u.params)).toEqual([
      ['2026-11-20', 'U1', at, 1],
      ['2026-11-20', 'U1', at, 2],
      ['車両が複数一致 (車輌CD 20000042, 30000042)', at, 5],
    ])
    // run_date を書くときは status を変えない
    expect(updates[0].sql).not.toContain('status')
    expect(updates[2].sql).toContain("status = 'failed'")
  })

  it('対象の行が無ければ何も書かない (results が無い D1 応答も)', async () => {
    const { db, updates } = fakeDb(undefined)
    expect(await confirmRunsFromTollCsv({ db, now: NOW }, 't', CSV)).toEqual({ results: [], nonEtcRows: 1 })
    expect(updates).toEqual([])
  })

  it('CSV の列が足りなければ D1 を読む前に throw', async () => {
    const { db, selects } = fakeDb([])
    await expect(confirmRunsFromTollCsv({ db, now: NOW }, 't', '運行NO\n')).rejects.toThrow('車輌CD')
    expect(selects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 登録
// ---------------------------------------------------------------------------

interface Row {
  id: number
  card_number: string | null
  plate4: string | null
  obu_number: string | null
  run_date: string | null
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 1,
  card_number: CARD,
  plate4: '1234',
  obu_number: OBU,
  run_date: '2026-11-21',
  ...over,
})

function deps(over: Partial<CardRegisterRunDeps> & { rows?: Row[] } = {}) {
  const { db, selects, updates } = fakeDb(over.rows ?? [row()])
  const puts: { key: string; html: string }[] = []
  const d: CardRegisterRunDeps = {
    db,
    now: NOW,
    mode: 'dry_run',
    r2Prefix: 'etc',
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

  it('cron は run_date のある行だけ、手動は id で引く (run_date は呼び手が見る)', () => {
    const cron = selectRegistrationsQuery({ kind: 'cron' }, 'dry_run')
    expect(cron.sql).toContain('status IN (?) AND run_date IS NOT NULL')
    expect(cron.params).toEqual(['waiting_run', CARD_REGISTER_BATCH_LIMIT])
    const one = selectRegistrationsQuery({ kind: 'one', id: 9 }, 'live')
    expect(one.sql).toContain('status IN (?, ?, ?) AND id = ?')
    expect(one.sql).not.toContain('run_date IS NOT NULL')
    expect(one.params).toEqual(['waiting_run', 'dry_run_ok', 'failed', 9, CARD_REGISTER_BATCH_LIMIT])
  })
})

describe('runCardRegistrations', () => {
  it('dry-run: run_date で 9 欄を組み、確認画面を R2 に置いて dry_run_ok', async () => {
    const { d, updates, puts } = deps()
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report).toEqual({
      notFound: false,
      conflict: false,
      results: [{ id: 1, cardNumber: CARD, kind: 'dry_run_ok', runDate: '2026-11-21', detail: undefined }],
    })
    expect(d.register).toHaveBeenCalledWith(expect.objectContaining({ icCardID: CARD, riyonengappiDay: '21', sharyoNo: '1234' }))
    expect(puts).toEqual([{ key: 'etc-card-register/1/20261126090000-confirm.html', html: '<p>確認</p>' }])
    expect(updates[0].sql).toContain('SET status = ?')
    expect(updates[0].params).toEqual(['dry_run_ok', 1, null, NOW.toISOString(), 1])
  })

  it('live: 完了なら registered (R2 には置かない)', async () => {
    const { d, updates, puts } = deps({
      mode: 'live',
      register: vi.fn(async (): Promise<EtcCardRegisterOutcome> => ({ kind: 'registered', html: 'done' })),
    })
    expect((await runCardRegistrations(d, { kind: 'cron' })).results[0].kind).toBe('registered')
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
    expect(updates[0].params.slice(0, 2)).toEqual(['failed', 1])
  })

  it('登録中の例外 (Error でなくても) は error: status は変えず attempts+1 と last_error だけ', async () => {
    for (const thrown of [new Error('timeout'), 'timeout']) {
      const { d, updates } = deps({
        register: vi.fn(async () => {
          throw thrown
        }),
      })
      const report = await runCardRegistrations(d, { kind: 'cron' })
      expect(report.results[0]).toMatchObject({ kind: 'error', detail: 'etc-meisai.jp への登録で失敗: timeout' })
      expect(updates[0].sql).not.toContain('status')
      expect(updates[0].params).toEqual([1, 'etc-meisai.jp への登録で失敗: timeout', NOW.toISOString(), 1])
    }
  })

  it('登録の直前に走行日を確かめ直し、範囲外なら run_date を消して待ちに戻す (送らない)', async () => {
    const { d, updates } = deps({ rows: [row({ run_date: '2026-09-01' })] })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report.results[0]).toMatchObject({ kind: 'expired', runDate: '2026-09-01' })
    expect(d.register).not.toHaveBeenCalled()
    expect(updates[0].sql).toContain('run_date = NULL, unko_no = NULL')
    expect(updates[0].sql).not.toContain('status')
  })

  it('フォームの値が組めない (車載器番号の桁違い等) → failed、送らない', async () => {
    const { d, updates } = deps({ rows: [row({ obu_number: '123' })] })
    const report = await runCardRegistrations(d, { kind: 'cron' })
    expect(report.results[0]).toMatchObject({ kind: 'failed', detail: '車載器管理番号が数字 19 桁ではありません' })
    expect(d.register).not.toHaveBeenCalled()
    expect(updates[0].params.slice(0, 2)).toEqual(['failed', 0])
  })

  it('手動 1 件: 行が無ければ notFound、run_date が無ければ conflict (送らない)', async () => {
    const a = deps({ rows: [] })
    expect(await runCardRegistrations(a.d, { kind: 'one', id: 5 })).toEqual({ notFound: true, conflict: false, results: [] })
    const b = deps({ rows: [row({ run_date: null })] })
    expect(await runCardRegistrations(b.d, { kind: 'one', id: 1 })).toEqual({ notFound: false, conflict: true, results: [] })
    expect(b.d.register).not.toHaveBeenCalled()
    const c = deps()
    expect((await runCardRegistrations(c.d, { kind: 'one', id: 1 })).results[0].kind).toBe('dry_run_ok')
  })

  it('D1 が results を返さなくても 0 件として扱う (cron)', async () => {
    const { d } = deps()
    const { db } = fakeDb(undefined)
    expect(await runCardRegistrations({ ...d, db }, { kind: 'cron' })).toEqual({ notFound: false, conflict: false, results: [] })
  })
})
