/**
 * ETC カード (Refs #1287) のテスト用 D1。**実物の SQLite (`node:sqlite`) に migration 0021 を当てたもの**に、
 * `server/utils/etc-scan.ts` が使う D1 の面 (`prepare().bind().first/all/run`、run の `meta.changes`) だけ被せる。
 * 部分 UNIQUE index と `INSERT OR IGNORE` の効き方は実物で走らせないと分からないため、文字列照合の fake にしない
 * (`workers/dtako-scraper-relay/test/helpers/litigation-d1.ts` と同じ考え方)。
 *
 * D1 は BLOB の bind に ArrayBuffer を受けるが node:sqlite は受けないので、ここで Uint8Array に直す。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface SqliteStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number | bigint }
}
interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

const plain = (row: unknown): Record<string, unknown> => ({ ...(row as Record<string, unknown>) })
const toSqlite = (v: unknown): unknown => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)

export class EtcScanD1 {
  /** 真を返した文を D1 の失敗として throw させる (失敗経路のテスト用) */
  failWhen: ((sql: string) => boolean) | null = null

  constructor(readonly raw: SqliteDatabase) {}

  prepare(sql: string) {
    const check = () => {
      if (this.failWhen?.(sql)) throw new Error('D1_ERROR: injected failure')
    }
    const stmt = (params: unknown[]) => ({
      bind: (...p: unknown[]) => stmt(p.map(toSqlite)),
      first: async <T>(): Promise<T | null> => {
        check()
        const row = this.raw.prepare(sql).get(...params)
        return row === undefined ? null : plain(row) as T
      },
      all: async <T>(): Promise<{ results: T[] }> => {
        check()
        return { results: this.raw.prepare(sql).all(...params).map(plain) as T[] }
      },
      run: async () => {
        check()
        const r = this.raw.prepare(sql).run(...params)
        return { success: true, meta: { changes: Number(r.changes) } }
      },
    })
    return stmt([])
  }

  rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.raw.prepare(sql).all(...params).map(plain)
  }

  exec(sql: string, ...params: unknown[]): void {
    this.raw.prepare(sql).run(...params)
  }
}

export async function openEtcScanD1(): Promise<EtcScanD1> {
  const { DatabaseSync } = await import(/* @vite-ignore */ 'node' + ':sqlite') as { DatabaseSync: new (p: string) => SqliteDatabase }
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(resolve(import.meta.dirname!, '../../migrations/0021_create_etc_card_registrations.sql'), 'utf8'))
  return new EtcScanD1(db)
}

/** extractEtcCard の応答 (body は JSON) */
export function redactResult(body: unknown, status = 200) {
  return { status, body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer as ArrayBuffer, contentType: 'application/json' }
}

/** 架空の明細書の行 (public repo。実在の番号を使わない) */
export const ROW_OK = { kubun: '新規発行', card_number: '0000000000000010', vehicle_number: 'テスト100あ1234', obu_number: '0000000000000000019' }
export const ROW_PARTIAL = { kubun: '追加', card_number: null, vehicle_number: 'テスト100あ56', obu_number: '0000000000000000029' }

/** `%PDF-` で始まる架空の PDF */
export function fakePdf(tail = 'x'): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`%PDF-1.4\n${tail}`) as Uint8Array<ArrayBuffer>
}
