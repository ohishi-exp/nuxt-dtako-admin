import { describe, expect, it, vi } from 'vitest'
import {
  CARD_REGISTER_BATCH_LIMIT,
  confirmRunsFromTollCsv,
  findRescanTarget,
  RESCAN_LIST_PER_PAGE,
  RESCAN_MAX_OPERATIONS,
  RescanUpstreamError,
  rescanRunsForRow,
  runCardRegistrations,
  SELECT_RESCAN_TARGET_SQL,
  SELECT_WAITING_FOR_TENANT_SQL,
  SELECT_WAITING_ONE_SQL,
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
  // 登録日は窓に効かない古い日 (受信日も同じ)。登録日の効き目は下の it で個別に見る
  const wrow = (id: number, plate4: string, run_date: string | null = null) => ({
    id,
    card_number: CARD,
    plate4,
    run_date,
    registration_date: null,
    received_at: '2025-01-01T00:00:00.000Z',
  })

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

  it('行ごとの実効の登録日より前の走行は拾わない (登録日 / 空なら受信日の JST 日付)。走行待ちのまま', async () => {
    const { db, updates } = fakeDb([
      { ...wrow(1, '1234'), registration_date: '2026-11-21' }, // 11-20 の走行は登録日より前 → none
      { ...wrow(2, '1234'), registration_date: '2026-11-20' }, // 当日は拾う
      { ...wrow(3, '1234'), received_at: '2026-11-20T15:00:00.000Z' }, // JST 11-21 受信 → none
      { ...wrow(4, '1234'), received_at: '2026-11-20T14:59:59.999Z' }, // JST 11-20 受信 → 拾う
    ])
    const report = await confirmRunsFromTollCsv({ db, now: NOW }, 'tenant-a', CSV)
    expect(report.results.map((r) => [r.id, r.kind, r.runDate ?? null])).toEqual([
      [1, 'none', null],
      [2, 'found', '2026-11-20'],
      [3, 'none', null],
      [4, 'found', '2026-11-20'],
    ])
    expect(updates.map((u) => u.params[3])).toEqual([2, 4])
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
  registration_date: string | null
  received_at: string
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 1,
  card_number: CARD,
  plate4: '1234',
  obu_number: OBU,
  run_date: '2026-11-21',
  registration_date: null,
  received_at: '2026-11-01T00:00:00.000Z',
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
    expect(cron.sql).toContain('r.status IN (?) AND r.run_date IS NOT NULL')
    expect(cron.params).toEqual(['waiting_run', CARD_REGISTER_BATCH_LIMIT])
    const one = selectRegistrationsQuery({ kind: 'one', id: 9 }, 'live')
    expect(one.sql).toContain('r.status IN (?, ?, ?) AND r.id = ?')
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

  it('登録の直前の再確認も実効の登録日を下限にする: 登録日 / 受信日より前の run_date は expired (送らない)', async () => {
    for (const over of [
      { registration_date: '2026-11-22' },
      { received_at: '2026-11-21T15:00:00.000Z' }, // JST 11-22 受信
    ]) {
      const { d, updates } = deps({ rows: [row(over)] })
      const report = await runCardRegistrations(d, { kind: 'cron' })
      expect(report.results[0]).toMatchObject({ kind: 'expired', runDate: '2026-11-21' })
      expect(d.register).not.toHaveBeenCalled()
      expect(updates[0].sql).toContain('run_date = NULL, unko_no = NULL')
    }
    // 登録日の当日の run_date は通る
    const ok = deps({ rows: [row({ registration_date: '2026-11-21' })] })
    expect((await runCardRegistrations(ok.d, { kind: 'cron' })).results[0].kind).toBe('dry_run_ok')
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

// ---------------------------------------------------------------------------
// 2 本の SELECT を実物の SQLite (migrations 0021 + 0022) で流す
// ---------------------------------------------------------------------------

/**
 * 上の fake D1 は SQL を文字列でしか見ないので、列名の誤り (0022 の `registration_date` / scan の
 * `received_at` の JOIN) はここで実物に当てて確かめる。
 */
describe('SELECT は migrations 0021 + 0022 の表で通り、登録日の材料を返す', () => {
  async function openDb(): Promise<{ db: CardRegisterDb; exec: (sql: string, ...p: unknown[]) => void }> {
    interface Stmt {
      all(...p: unknown[]): unknown[]
      run(...p: unknown[]): unknown
    }
    const { DatabaseSync } = (await import(/* @vite-ignore */ 'node' + ':sqlite')) as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): Stmt }
    }
    const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as { readFileSync: (p: string, enc: string) => string }
    const raw = new DatabaseSync(':memory:')
    for (const name of ['0021_create_etc_card_registrations.sql', '0022_etc_card_registration_date.sql']) {
      raw.exec(fs.readFileSync(`../../migrations/${name}`, 'utf8'))
    }
    const db: CardRegisterDb = {
      prepare: (sql) => ({
        bind: (...p) => ({
          all: async <T>() => ({ results: raw.prepare(sql).all(...p).map((r) => ({ ...(r as object) })) as T[] }),
          run: async () => raw.prepare(sql).run(...p),
        }),
      }),
    }
    return { db, exec: (sql, ...p) => void raw.prepare(sql).run(...p) }
  }

  it('確認段・登録段とも registration_date (既存行は NULL) と scan の received_at を読む', async () => {
    const { db, exec } = await openDb()
    exec(
      "INSERT INTO etc_card_scans (sha256, pdf, bytes, tenant_id, received_at, ocr_status) VALUES ('s1', x'00', 1, 'tenant-a', '2026-11-20T15:00:00.000Z', 'ok')",
    )
    const ins =
      'INSERT INTO etc_card_registrations (scan_sha256, kubun, card_number, plate4, obu_number, status, run_date, created_at, updated_at) ' +
      "VALUES ('s1', '新規', ?, '1234', ?, 'waiting_run', ?, 't', 't')"
    exec(ins, CARD, OBU, null)
    exec(ins, '0000111122224444', OBU, '2026-11-21')
    exec("UPDATE etc_card_registrations SET registration_date = '2026-11-22' WHERE id = 2")

    const waiting = (await db.prepare(SELECT_WAITING_FOR_TENANT_SQL).bind('tenant-a').all<Record<string, unknown>>()).results
    expect(waiting?.map((r) => [r.id, r.registration_date, r.received_at])).toEqual([
      [1, null, '2026-11-20T15:00:00.000Z'],
      [2, '2026-11-22', '2026-11-20T15:00:00.000Z'],
    ])

    const q = selectRegistrationsQuery({ kind: 'cron' }, 'dry_run')
    const regs = (await db.prepare(q.sql).bind(...q.params).all<Record<string, unknown>>()).results
    expect(regs?.map((r) => [r.id, r.run_date, r.registration_date, r.received_at])).toEqual([
      [2, '2026-11-21', '2026-11-22', '2026-11-20T15:00:00.000Z'],
    ])

    // 通しで: 行 2 は run_date (11-21) が登録日 (11-22) より前なので expired → run_date を消す
    const report = await runCardRegistrations(
      { db, now: NOW, mode: 'dry_run', r2Prefix: 'etc', register: vi.fn(), putHtml: vi.fn() },
      { kind: 'cron' },
    )
    expect(report.results.map((r) => [r.id, r.kind])).toEqual([[2, 'expired']])
    const after = (await db.prepare('SELECT run_date, unko_no FROM etc_card_registrations WHERE id = 2').bind().all<Record<string, unknown>>()).results
    expect(after).toEqual([{ run_date: null, unko_no: null }])
  })
})

// ---------------------------------------------------------------------------
// 走行日を探し直す (手動。alc の運行の KUDGSIR を読み直す)
// ---------------------------------------------------------------------------

describe('rescanRunsForRow', () => {
  /** SQL ごとに返す行を変える D1。 */
  function routedDb(target: unknown[] | undefined, waiting: unknown[]) {
    const calls: { sql: string; params: unknown[] }[] = []
    const db: CardRegisterDb = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async all<T>() {
                calls.push({ sql, params })
                return { results: (sql === SELECT_RESCAN_TARGET_SQL ? target : waiting) as T[] | undefined }
              },
              async run() {
                calls.push({ sql, params })
                return {}
              },
            }
          },
        }
      },
    }
    return { db, calls }
  }
  const TARGET = { id: 7, card_number: CARD, plate4: '1234', registration_date: '2026-11-10', received_at: '2026-11-01T00:00:00.000Z', tenant_id: 'tenant-a' }
  const WAITING = [{ id: 7, card_number: CARD, plate4: '1234', run_date: null, registration_date: '2026-11-10', received_at: '2026-11-01T00:00:00.000Z' }]
  const HEADERS = ['運行NO', '車輌CD', '開始日時', '終了日時', 'ETC利用']
  const tollJson = (rows: string[][]) => ({ status: 200, text: JSON.stringify({ headers: HEADERS, rows }) })
  const list = (ops: { unko_no?: unknown, vehicle_cd?: unknown }[], total = ops.length) => ({ status: 200, text: JSON.stringify({ operations: ops, total, page: 1, per_page: 200 }) })

  /** path → 応答。呼ばれた path と tenant を記録する。 */
  function fakeAlc(routes: Record<string, { status: number, text: string }>) {
    const calls: { tenant: string, path: string }[] = []
    const alcGet = vi.fn(async (tenant: string, path: string) => {
      calls.push({ tenant, path })
      const key = path.startsWith('/alc-internal-proxy/api/internal/operations?') ? `list:${new URLSearchParams(path.split('?')[1]).get('page')}` : path
      const r = routes[key]
      if (!r) throw new Error(`unexpected ${path}`)
      return r
    })
    return { alcGet, calls }
  }
  const csvPath = (u: string) => `/alc-internal-proxy/api/internal/operations/${u}/csv/kudgsir`

  it('findRescanTarget: id 1 つ、waiting_run で plate4 ありの行を読む。無ければ null', async () => {
    const { db, calls } = routedDb([TARGET], [])
    expect(await findRescanTarget(db, 7)).toEqual(TARGET)
    expect(calls).toEqual([{ sql: SELECT_RESCAN_TARGET_SQL, params: [7] }])
    expect(SELECT_RESCAN_TARGET_SQL).toContain("r.status = 'waiting_run'")
    expect(SELECT_RESCAN_TARGET_SQL).toContain('r.plate4 IS NOT NULL')
    expect(await findRescanTarget(routedDb(undefined, []).db, 7)).toBeNull()
  })

  it('登録日〜今日の読取日の運行を行の tenant で引き、下 4 桁の合う車両の KUDGSIR だけ読んで、行 id で絞って確認する', async () => {
    const { db, calls } = routedDb([TARGET], WAITING)
    const { alcGet, calls: alc } = fakeAlc({
      'list:1': list([
        { unko_no: '111', vehicle_cd: '10001234' }, // 下 4 桁が合う
        { unko_no: '111', vehicle_cd: '10001234' }, // 2 マンのもう 1 行 (読むのは 1 回)
        { unko_no: '222', vehicle_cd: '10005678' }, // 合わない → 読まない
        { unko_no: '333', vehicle_cd: null }, // 車両不明 → 読む
        { unko_no: '444', vehicle_cd: '20001234' }, // 合う、CSV が無い (404)
        { unko_no: 'X-1', vehicle_cd: '10001234' }, // 数字でない運行 NO → 飛ばす
      ]),
      [csvPath('111')]: tollJson([
        ['111', '10001234', '2026/11/19 23:00:00', '2026/11/20 01:00:00', '1'],
        ['111', '10001234', '2026/11/19 23:00:00', '2026/11/21 01:00:00', '0'], // ETC でない
      ]),
      [csvPath('333')]: tollJson([['333', '10001234', '2026/11/17 10:00:00', '2026/11/17 11:00:00', '1']]),
      [csvPath('444')]: { status: 404, text: 'Not Found' },
    })
    const report = await rescanRunsForRow({ db, now: NOW, alcGet }, 7)
    expect(report).toEqual({
      kind: 'done',
      id: 7,
      cardNumber: CARD,
      from: '2026-11-10',
      to: '2026-11-26',
      operations: 2,
      skipped: 2,
      truncated: false,
      result: { id: 7, cardNumber: CARD, kind: 'found', runDate: '2026-11-20' },
    })
    expect(alc.map((c) => c.tenant)).toEqual(['tenant-a', 'tenant-a', 'tenant-a', 'tenant-a'])
    const q = new URLSearchParams(alc[0]!.path.split('?')[1])
    expect(alc[0]!.path.startsWith('/alc-internal-proxy/api/internal/operations?')).toBe(true)
    expect(Object.fromEntries(q)).toEqual({ date_from: '2026-11-10', date_to: '2026-11-26', page: '1', per_page: String(RESCAN_LIST_PER_PAGE) })
    expect(alc.slice(1).map((c) => c.path)).toEqual([csvPath('111'), csvPath('333'), csvPath('444')])
    // 確認段は行 id で絞った SQL (tenant, id) — 他の waiting_run の行は読まない
    expect(calls.filter((c) => c.sql === SELECT_WAITING_ONE_SQL)).toEqual([{ sql: SELECT_WAITING_ONE_SQL, params: ['tenant-a', 7] }])
    expect(SELECT_WAITING_ONE_SQL).toContain('AND r.id = ?')
    expect(calls.some((c) => c.sql === SELECT_WAITING_FOR_TENANT_SQL)).toBe(false)
    // D1 に書くのは run_date / unko_no だけ
    const writes = calls.filter((c) => c.sql.startsWith('UPDATE'))
    expect(writes.map((w) => w.sql)).toEqual(['UPDATE etc_card_registrations SET run_date = ?, unko_no = ?, updated_at = ? WHERE id = ?'])
    expect(writes[0]!.params).toEqual(['2026-11-20', '111', NOW.toISOString(), 7])
  })

  it('一覧は total に届くまで全ページ引く。空のページが来たらそこで止める', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ unko_no: String(9000 + i), vehicle_cd: '10005678' }))
    const two = fakeAlc({ 'list:1': list(page(RESCAN_LIST_PER_PAGE), 250), 'list:2': list(page(50), 250) })
    const r = await rescanRunsForRow({ db: routedDb([TARGET], WAITING).db, now: NOW, alcGet: two.alcGet }, 7)
    expect(two.calls.map((c) => new URLSearchParams(c.path.split('?')[1]).get('page'))).toEqual(['1', '2'])
    expect(r).toMatchObject({ operations: 0, skipped: 0, truncated: false, result: null })

    const empty = fakeAlc({ 'list:1': list([], 999) })
    await rescanRunsForRow({ db: routedDb([TARGET], WAITING).db, now: NOW, alcGet: empty.alcGet }, 7)
    expect(empty.calls).toHaveLength(1)
    // 応答に operations / total が無くても 1 ページで終わる
    const bare = fakeAlc({ 'list:1': { status: 200, text: '{}' } })
    await rescanRunsForRow({ db: routedDb([TARGET], WAITING).db, now: NOW, alcGet: bare.alcGet }, 7)
    expect(bare.calls).toHaveLength(1)
  })

  it(`対象の運行が ${RESCAN_MAX_OPERATIONS} 件を超えたら新しい方から上限まで読み、truncated を立てる (次のページは引かない)`, async () => {
    const ops = Array.from({ length: RESCAN_MAX_OPERATIONS + 1 }, (_, i) => ({ unko_no: String(1000 + i), vehicle_cd: '10001234' }))
    const routes: Record<string, { status: number, text: string }> = { 'list:1': list(ops, 999) }
    for (const o of ops) routes[csvPath(o.unko_no)] = tollJson([])
    const { alcGet, calls } = fakeAlc(routes)
    const r = await rescanRunsForRow({ db: routedDb([TARGET], WAITING).db, now: NOW, alcGet }, 7)
    expect(r).toMatchObject({ operations: RESCAN_MAX_OPERATIONS, truncated: true, result: null })
    expect(calls.filter((c) => c.path.includes('?'))).toHaveLength(1)
    expect(calls.some((c) => c.path === csvPath(String(1000 + RESCAN_MAX_OPERATIONS)))).toBe(false)
  })

  it('複数一致は確認段どおり failed にして結果を返す', async () => {
    const { db, calls } = routedDb([TARGET], WAITING)
    const { alcGet } = fakeAlc({
      'list:1': list([{ unko_no: '1', vehicle_cd: '10001234' }, { unko_no: '2', vehicle_cd: '20001234' }]),
      [csvPath('1')]: tollJson([['1', '10001234', '', '2026/11/20 01:00:00', '1']]),
      [csvPath('2')]: tollJson([['2', '20001234', '', '2026/11/21 01:00:00', '1']]),
    })
    const r = await rescanRunsForRow({ db, now: NOW, alcGet }, 7)
    expect(r.kind === 'done' && r.result).toMatchObject({ kind: 'multiple' })
    expect(calls.find((c) => c.sql.startsWith('UPDATE'))!.sql).toContain("status = 'failed'")
  })

  it('運行 NO が文字列でない運行は飛ばす。読む間に行が走行待ちでなくなっていたら result は null', async () => {
    const { alcGet } = fakeAlc({
      'list:1': list([{ unko_no: 42, vehicle_cd: '10001234' }, { unko_no: '1', vehicle_cd: '10001234' }]),
      [csvPath('1')]: tollJson([['1', '10001234', '', '2026/11/20 01:00:00', '1']]),
    })
    const { db, calls } = routedDb([TARGET], []) // 確認段の SELECT は 0 行
    const r = await rescanRunsForRow({ db, now: NOW, alcGet }, 7)
    expect(r).toMatchObject({ operations: 1, skipped: 1, result: null })
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
  })

  it('行が無ければ not_found で alc を叩かない。未来の登録日は運行を引かずに 0 件で終わる', async () => {
    const alcGet = vi.fn()
    expect(await rescanRunsForRow({ db: routedDb([], []).db, now: NOW, alcGet }, 7)).toEqual({ kind: 'not_found' })
    const future = await rescanRunsForRow({ db: routedDb([{ ...TARGET, registration_date: '2026-11-27' }], []).db, now: NOW, alcGet }, 7)
    expect(future).toEqual({ kind: 'done', id: 7, cardNumber: CARD, from: '2026-11-27', to: '2026-11-26', operations: 0, skipped: 0, truncated: false, result: null })
    expect(alcGet).not.toHaveBeenCalled()
  })

  it('一覧・CSV の 404 以外の非 2xx は RescanUpstreamError (D1 に書かない)。CSV の欄が欠けていれば列不足で落ちる', async () => {
    const listFail = fakeAlc({ 'list:1': { status: 503, text: 'down' } })
    await expect(rescanRunsForRow({ db: routedDb([TARGET], WAITING).db, now: NOW, alcGet: listFail.alcGet }, 7)).rejects.toThrow(RescanUpstreamError)
    const listRedirect = fakeAlc({ 'list:1': { status: 302, text: '' } })
    await expect(rescanRunsForRow({ db: routedDb([TARGET], WAITING).db, now: NOW, alcGet: listRedirect.alcGet }, 7)).rejects.toThrow('運行の一覧を読めません (302)')

    const { db, calls } = routedDb([TARGET], WAITING)
    const csvFail = fakeAlc({ 'list:1': list([{ unko_no: '1', vehicle_cd: '10001234' }]), [csvPath('1')]: { status: 500, text: 'x' } })
    await expect(rescanRunsForRow({ db, now: NOW, alcGet: csvFail.alcGet }, 7)).rejects.toThrow('運行 1 の KUDGSIR を読めません (500)')
    const csvRedirect = fakeAlc({ 'list:1': list([{ unko_no: '1', vehicle_cd: '10001234' }]), [csvPath('1')]: { status: 199, text: '' } })
    await expect(rescanRunsForRow({ db, now: NOW, alcGet: csvRedirect.alcGet }, 7)).rejects.toThrow(RescanUpstreamError)
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)

    const noCols = fakeAlc({ 'list:1': list([{ unko_no: '1', vehicle_cd: '10001234' }]), [csvPath('1')]: { status: 200, text: '{}' } })
    await expect(rescanRunsForRow({ db: routedDb([TARGET], WAITING).db, now: NOW, alcGet: noCols.alcGet }, 7)).rejects.toThrow('運行NO')
  })
})
