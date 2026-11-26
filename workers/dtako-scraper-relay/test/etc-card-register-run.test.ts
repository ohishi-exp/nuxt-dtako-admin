import { describe, expect, it, vi } from 'vitest'
import {
  CARD_REGISTER_BATCH_LIMIT,
  confirmRunsFromTollCsv,
  findRescanTarget,
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
// 走行日を探し直す (手動)
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

  it('findRescanTarget: id 1 つ、waiting_run で plate4 ありの行を読む。無ければ null', async () => {
    const { db, calls } = routedDb([TARGET], [])
    expect(await findRescanTarget(db, 7)).toEqual(TARGET)
    expect(calls).toEqual([{ sql: SELECT_RESCAN_TARGET_SQL, params: [7] }])
    expect(SELECT_RESCAN_TARGET_SQL).toContain("r.status = 'waiting_run'")
    expect(SELECT_RESCAN_TARGET_SQL).toContain('r.plate4 IS NOT NULL')
    expect(await findRescanTarget(routedDb(undefined, []).db, 7)).toBeNull()
  })

  /** 運行の一覧の 1 件 (alc の `GET /api/internal/operations`)。 */
  const op = (unko_no: unknown, vehicle_cd: unknown) => ({ unko_no, vehicle_cd })
  /** その運行 1 件ぶんの KUDGSIR.csv (plate4 1234 の車、ETC 利用あり)。 */
  const tollCsv = (unko: string, date: string) =>
    ['運行NO,車輌CD,開始日時,終了日時,ETC利用', `${unko},10001234,${date} 10:00:00,${date} 11:00:00,1`].join('\r\n')
  /** ページ番号 → 一覧の応答。 */
  function alcList(pages: Record<string, { operations?: unknown[]; total?: unknown }>) {
    return vi.fn(async (_tenant: string, path: string) => {
      const page = new URL(`https://x${path}`).searchParams.get('page')!
      return { status: 200, text: JSON.stringify(pages[page] ?? { operations: [] }) }
    })
  }

  it('alc の一覧を全ページ引いて plate4 で絞り、新しい順に運行 1 件ぶんの zip の KUDGSIR を読む。見つかったら残りを取らない (alc へは上げない)', async () => {
    const { db, calls } = routedDb([{ ...TARGET, plate4: '1234' }], WAITING)
    const alcGet = alcList({
      '1': {
        total: 205,
        operations: [
          op('2611250900000010001234', '10001234'), // KUDGSIR 無し → skipped
          op('2611250900000010001234', '10001234'), // 2 マン運行の 2 行目 → 重複は 1 回
          op('2611240900000010005678', '10005678'), // 別の車 → 対象外
          op('abc', '10001234'), // 運行 NO の形が違う → skipped
          op('2611220800000010001234', '10001234'), // 取得失敗 → failed、次へ
        ],
      },
      '2': {
        total: 205,
        operations: [
          op('2611200534040000001234', null), // vehicle_cd 無し → 残す。ここで見つかる (時は 0 埋めなし)
          op('2610312350000010001234', '10001234'), // 見つかった後なので取らない
        ],
      },
    })
    const fetchTollCsv = vi.fn(async (o: { opeNo22: string; startOpe: string }) => {
      if (o.opeNo22.startsWith('26112509')) return null
      if (o.opeNo22.startsWith('26112208')) throw new Error('stage2 timeout')
      return tollCsv(o.opeNo22, '2026/11/20')
    })
    const deps = { db, now: NOW, alcGet, fetchTollCsv }
    const report = await rescanRunsForRow(deps, 'tenant-a', 7)
    // deps に upload は無い (alc へ上げる口を持たない)
    expect(Object.keys(deps).sort()).toEqual(['alcGet', 'db', 'fetchTollCsv', 'now'])
    expect(alcGet.mock.calls).toEqual([
      ['tenant-a', '/alc-internal-proxy/api/internal/operations?date_from=2026-11-10&date_to=2026-11-26&page=1&per_page=200'],
      ['tenant-a', '/alc-internal-proxy/api/internal/operations?date_from=2026-11-10&date_to=2026-11-26&page=2&per_page=200'],
    ])
    expect(fetchTollCsv.mock.calls.map((c) => c[0])).toEqual([
      { opeNo22: '2611250900000010001234', startOpe: '2026/11/25 9:00:00' },
      { opeNo22: '2611220800000010001234', startOpe: '2026/11/22 8:00:00' },
      { opeNo22: '2611200534040000001234', startOpe: '2026/11/20 5:34:04' },
    ])
    expect(report).toEqual({
      kind: 'done',
      id: 7,
      cardNumber: CARD,
      from: '2026-11-10',
      to: '2026-11-26',
      operations: 5,
      fetched: 1,
      skipped: 2,
      failed: 1,
      firstError: '2611220800000010001234: stage2 timeout',
      truncated: false,
      result: { id: 7, cardNumber: CARD, kind: 'found', runDate: '2026-11-20' },
    })
    // 確認段は行 id で絞った SQL (tenant, id) — 他の waiting_run の行は読まない
    expect(calls.filter((c) => c.sql === SELECT_WAITING_ONE_SQL)).toEqual([{ sql: SELECT_WAITING_ONE_SQL, params: ['tenant-a', 7] }])
    expect(SELECT_WAITING_ONE_SQL).toContain('AND r.id = ?')
    expect(calls.some((c) => c.sql === SELECT_WAITING_FOR_TENANT_SQL)).toBe(false)
    // D1 に書くのは run_date / unko_no だけ
    const writes = calls.filter((c) => c.sql.startsWith('UPDATE'))
    expect(writes.map((w) => w.sql)).toEqual(['UPDATE etc_card_registrations SET run_date = ?, unko_no = ?, updated_at = ? WHERE id = ?'])
    expect(writes[0]!.params).toEqual(['2026-11-20', '2611200534040000001234', NOW.toISOString(), 7])
  })

  it('見つからなければ全部の運行を取る (陽性対照)。月をまたぐ運行 NO・23 桁の運行 NO も導ける', async () => {
    const { db } = routedDb([{ ...TARGET, plate4: '1234' }], WAITING)
    const fetchTollCsv = vi.fn(async (o: { opeNo22: string }) => tollCsv(o.opeNo22, '2026/11/01')) // 登録日より前 → none
    const report = await rescanRunsForRow(
      {
        db,
        now: NOW,
        alcGet: alcList({ '1': { total: 2, operations: [op('2611200534040000001234', '10001234'), op('26103123500000100012341', '10001234')] } }),
        fetchTollCsv,
      },
      'tenant-a',
      7,
    )
    expect(fetchTollCsv.mock.calls.map((c) => c[0])).toEqual([
      { opeNo22: '2611200534040000001234', startOpe: '2026/11/20 5:34:04' },
      { opeNo22: '2610312350000010001234', startOpe: '2026/10/31 23:50:00' },
    ])
    expect(report).toMatchObject({ operations: 2, fetched: 2, skipped: 0, failed: 0, truncated: false, result: null })
  })

  it(`運行が ${RESCAN_MAX_OPERATIONS} 件を超えたら新しい方から ${RESCAN_MAX_OPERATIONS} 件だけ取り、truncated。一覧もそこで止める`, async () => {
    const { db } = routedDb([{ ...TARGET, plate4: '1234' }], WAITING)
    const ops = Array.from({ length: 25 }, (_, i) => op(`26112009${String(59 - i).padStart(2, '0')}000010001234`, '10001234'))
    const alcGet = alcList({ '1': { total: 400, operations: ops } })
    const fetchTollCsv = vi.fn(async () => null)
    const report = await rescanRunsForRow({ db, now: NOW, alcGet, fetchTollCsv }, 'tenant-a', 7)
    expect(alcGet).toHaveBeenCalledTimes(1)
    expect(fetchTollCsv).toHaveBeenCalledTimes(RESCAN_MAX_OPERATIONS)
    expect(fetchTollCsv.mock.calls.map((c) => (c as unknown as [{ opeNo22: string }])[0].opeNo22)).toEqual(
      ops.slice(0, RESCAN_MAX_OPERATIONS).map((o) => o.unko_no),
    )
    expect(report).toMatchObject({ operations: RESCAN_MAX_OPERATIONS + 1, skipped: RESCAN_MAX_OPERATIONS, truncated: true })
  })

  it('行が無い・tenant が違えば not_found で alc も theearth も叩かない。未来の登録日は 0 件で終わる', async () => {
    const alcGet = vi.fn()
    const fetchTollCsv = vi.fn()
    const base = { now: NOW, alcGet, fetchTollCsv }
    expect(await rescanRunsForRow({ ...base, db: routedDb([], []).db }, 'tenant-a', 7)).toEqual({ kind: 'not_found' })
    expect(await rescanRunsForRow({ ...base, db: routedDb([TARGET], []).db }, 'tenant-b', 7)).toEqual({ kind: 'not_found' })
    const future = await rescanRunsForRow({ ...base, db: routedDb([{ ...TARGET, registration_date: '2026-11-27' }], []).db }, 'tenant-a', 7)
    expect(future).toMatchObject({ kind: 'done', from: '2026-11-27', to: '2026-11-26', operations: 0, fetched: 0, result: null })
    expect(alcGet).not.toHaveBeenCalled()
    expect(fetchTollCsv).not.toHaveBeenCalled()
  })

  it('一覧が非 2xx なら RescanUpstreamError。total が無ければ 1 ページで止め、Error でない失敗も文字列にする', async () => {
    const base = { now: NOW, fetchTollCsv: vi.fn() }
    await expect(
      rescanRunsForRow({ ...base, db: routedDb([TARGET], []).db, alcGet: async () => ({ status: 503, text: 'down' }) }, 'tenant-a', 7),
    ).rejects.toThrow(new RescanUpstreamError('運行の一覧を読めません (503): down'))

    const alcGet = alcList({ '1': { operations: [op('2611200534040000001234', '10001234')] } })
    const report = await rescanRunsForRow(
      {
        db: routedDb([{ ...TARGET, plate4: '1234' }], WAITING).db,
        now: NOW,
        alcGet,
        fetchTollCsv: async () => {
          throw 'plain'
        },
      },
      'tenant-a',
      7,
    )
    expect(alcGet).toHaveBeenCalledTimes(1)
    expect(report).toMatchObject({ operations: 1, failed: 1, firstError: '2611200534040000001234: plain' })

    // 一覧が空 (operations 無し) なら何も取らない
    const empty = await rescanRunsForRow(
      { db: routedDb([TARGET], []).db, now: NOW, alcGet: alcList({ '1': {} }), fetchTollCsv: base.fetchTollCsv },
      'tenant-a',
      7,
    )
    expect(empty).toMatchObject({ operations: 0, fetched: 0 })
    // 運行 NO が文字列でない行は形が違うものとして飛ばす (取らない)
    const odd = await rescanRunsForRow(
      { db: routedDb([TARGET], []).db, now: NOW, alcGet: alcList({ '1': { total: 1, operations: [op(42, '10001234')] } }), fetchTollCsv: base.fetchTollCsv },
      'tenant-a',
      7,
    )
    expect(odd).toMatchObject({ operations: 1, skipped: 1, fetched: 0 })
    expect(base.fetchTollCsv).not.toHaveBeenCalled()
  })
})
