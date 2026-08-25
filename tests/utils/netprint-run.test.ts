import { describe, it, expect } from 'vitest'
import {
  NETPRINT_DATE_RE,
  normalizeNetprintRunOutcome,
  viewNetprintRunResult,
  yesterdayJstYmd,
} from '~/utils/netprint-run'

/** relay が返す 1 target ぶんの `detail` を実物と同じ形で組む
 * (`HTTP {status}: {DO の応答本文}`、`cron.ts` の `dispatchNetprintTargets`)。 */
function detail(status: number, body: unknown): string {
  return `HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`
}

const DO_OK = {
  ok: true,
  results: [{
    branch_cd: '1',
    channel_id: 'ch-1',
    ok: true,
    rows: 12,
    print_id: 'J5JZPEQJ',
    detail: '12 行 / 2 ページを登録し予約番号を通知',
  }],
  theearth_logins: 1,
}

describe('yesterdayJstYmd', () => {
  it('JST の前日を返す (UTC の日付ではない)', () => {
    // 2026-08-25 00:30 JST = 2026-08-24T15:30Z。JST の前日は 08-24。
    expect(yesterdayJstYmd(new Date('2026-08-24T15:30:00Z'))).toBe('2026-08-24')
    // 2026-08-24 23:30 JST = 2026-08-24T14:30Z。JST の前日は 08-23。
    expect(yesterdayJstYmd(new Date('2026-08-24T14:30:00Z'))).toBe('2026-08-23')
    // 月をまたぐ
    expect(yesterdayJstYmd(new Date('2026-08-01T00:00:00Z'))).toBe('2026-07-31')
  })

  it('NETPRINT_DATE_RE を満たす', () => {
    expect(NETPRINT_DATE_RE.test(yesterdayJstYmd(new Date('2026-08-24T15:30:00Z')))).toBe(true)
  })
})

describe('normalizeNetprintRunOutcome', () => {
  it('2xx は relay の {ok, date, results} をそのまま読む', () => {
    const body = {
      ok: true,
      date: '2026-08-24',
      results: [{ kind: 'netprint', target: '27324455|1', ok: true, detail: detail(200, DO_OK) }],
    }
    expect(normalizeNetprintRunOutcome(200, true, body)).toEqual({
      ok: true,
      status: 200,
      date: '2026-08-24',
      results: [{ target: '27324455|1', ok: true, detail: detail(200, DO_OK) }],
      error: null,
    })
  })

  it('2xx でも relay の ok が false なら失敗として扱う (status だけで判断しない)', () => {
    const out = normalizeNetprintRunOutcome(200, true, { ok: false, date: '2026-08-24', results: [] })
    expect(out.ok).toBe(false)
    expect(out.error).toBeNull()
  })

  it('2xx の body が JSON オブジェクトでなければ空の結果になる', () => {
    expect(normalizeNetprintRunOutcome(200, true, null)).toEqual({
      ok: false, status: 200, date: null, results: [], error: null,
    })
    expect(normalizeNetprintRunOutcome(200, true, 'not json')).toMatchObject({ results: [], date: null })
  })

  it('非 2xx は statusMessage → message → HTTP n の順でエラー文にする', () => {
    expect(normalizeNetprintRunOutcome(400, false, { statusMessage: 'date は YYYY-MM-DD', message: 'x' }).error)
      .toBe('date は YYYY-MM-DD')
    expect(normalizeNetprintRunOutcome(401, false, { message: 'Unauthorized' }).error).toBe('Unauthorized')
    expect(normalizeNetprintRunOutcome(401, false, {}).error).toBe('HTTP 401')
    expect(normalizeNetprintRunOutcome(502, false, null).error).toBe('HTTP 502')
  })

  // ★ 一部の営業所だけ失敗した 502 でも、営業所ごとの結果は data に載っている。
  it('非 2xx でも data の results / date を読む (失敗理由を画面に出すため)', () => {
    const out = normalizeNetprintRunOutcome(502, false, {
      statusMessage: 'relay: 2 件中 1 件の営業所が失敗しました (HTTP 502)',
      data: {
        ok: false,
        date: '2026-08-24',
        results: [
          { kind: 'netprint', target: '27324455|1', ok: true, detail: detail(200, DO_OK) },
          { kind: 'netprint', target: '27324455|8', ok: false, detail: detail(503, { error: 'LINEWORKS_BOT が未設定または不正です' }) },
        ],
      },
    })
    expect(out.ok).toBe(false)
    expect(out.date).toBe('2026-08-24')
    expect(out.results).toHaveLength(2)
    expect(out.results[1]!.ok).toBe(false)
  })

  it('results が配列でない / 要素がオブジェクトでない場合は落として空にする', () => {
    expect(normalizeNetprintRunOutcome(200, true, { results: 'x' }).results).toEqual([])
    expect(normalizeNetprintRunOutcome(200, true, { results: [null, 1, 'x'] }).results).toEqual([])
  })

  it('results の要素にキーが欠けていても既定値で 1 行にする (黙って消さない)', () => {
    expect(normalizeNetprintRunOutcome(200, true, { results: [{}] }).results)
      .toEqual([{ target: '', ok: false, detail: '' }])
  })

  it('date が文字列でなければ null', () => {
    expect(normalizeNetprintRunOutcome(200, true, { date: 20260824 }).date).toBeNull()
  })
})

describe('viewNetprintRunResult', () => {
  it('成功: 営業所コードと予約番号と DO の detail を取り出す', () => {
    const view = viewNetprintRunResult({ target: '27324455|1', ok: true, detail: detail(200, DO_OK) })
    expect(view).toEqual({
      branchCd: '1',
      ok: true,
      printIds: ['J5JZPEQJ'],
      message: '12 行 / 2 ページを登録し予約番号を通知',
    })
  })

  it('DO が {error} を返した場合はその理由を出す', () => {
    const view = viewNetprintRunResult({
      target: '27324455|1',
      ok: false,
      detail: detail(503, { error: 'LINEWORKS_BOT が未設定または不正です' }),
    })
    expect(view.ok).toBe(false)
    expect(view.printIds).toEqual([])
    expect(view.message).toBe('LINEWORKS_BOT が未設定または不正です')
  })

  // relay は DO の応答本文を 200 字で切るので、JSON として壊れて届くことがある。
  it('200 字打ち切りで JSON が壊れていても予約番号を拾い、原文を残す', () => {
    const truncated = detail(200, JSON.stringify(DO_OK).slice(0, 120))
    const view = viewNetprintRunResult({ target: '27324455|1', ok: true, detail: truncated })
    expect(view.printIds).toEqual(['J5JZPEQJ'])
    expect(view.message).toContain('"print_id":"J5JZPEQJ"')
  })

  // 1 運行 = 1 予約番号 (Refs #874 の 13) だと `operations[].print_id` は 200 字の
  // 打ち切りより後ろへ落ちる。DO は target の detail の先頭付近にも番号を並べるので、
  // そちらから拾えることを固定する (片方だけだと日によって画面から番号が消える)。
  it('operations が打ち切られていても detail の「予約番号 A / B / C」から拾う', () => {
    const body = JSON.stringify({
      ok: true,
      results: [{
        detail: '成功 3 / 失敗 0 (全 3 運行) 予約番号 MTDDF7SN / N4KR8X9S / MPQDFL8G',
        branch_cd: '1',
        operations: [{ print_id: 'MTDDF7SN' }],
      }],
    })
    const view = viewNetprintRunResult({ target: '27324455|1', ok: true, detail: detail(200, body.slice(0, 140)) })
    expect(view.printIds).toEqual(['MTDDF7SN', 'N4KR8X9S', 'MPQDFL8G'])
  })

  it('JSON と本文テキストの両方に出ている番号は重複させない', () => {
    const view = viewNetprintRunResult({
      target: '27324455|1',
      ok: true,
      detail: detail(200, {
        ok: true,
        results: [{
          detail: '成功 2 / 失敗 0 (全 2 運行) 予約番号 AAAA1111 / BBBB2222',
          operations: [{ print_id: 'AAAA1111' }, { print_id: 'BBBB2222' }],
        }],
      }),
    })
    expect(view.printIds).toEqual(['AAAA1111', 'BBBB2222'])
  })

  it('打ち切りで途中まで残った番号は出さない (入力しても通らない番号を人に試させない)', () => {
    const view = viewNetprintRunResult({
      target: '27324455|1',
      ok: true,
      detail: detail(200, '{"ok":true,"results":[{"detail":"成功 2 / 失敗 0 (全 2 運行) 予約番号 AAAA1111 / BBBB'),
    })
    expect(view.printIds).toEqual(['AAAA1111'])
  })

  it('失敗のまとめだけで番号が無ければ printIds は空', () => {
    const view = viewNetprintRunResult({
      target: '27324455|1',
      ok: false,
      detail: detail(502, {
        ok: false,
        results: [{ detail: '成功 0 / 失敗 1 (全 1 運行) 失敗 林田 隆則: Error: boom' }],
      }),
    })
    expect(view.printIds).toEqual([])
    expect(view.message).toContain('失敗 林田 隆則')
  })

  it('複数営業所ぶんの結果が 1 つの detail に入っていれば全部の予約番号を出す', () => {
    const view = viewNetprintRunResult({
      target: '27324455|1',
      ok: true,
      detail: detail(200, {
        ok: true,
        results: [
          { print_id: 'AAAA1111', detail: '10 行を登録' },
          { print_id: 'BBBB2222', detail: '3 行を登録' },
        ],
      }),
    })
    expect(view.printIds).toEqual(['AAAA1111', 'BBBB2222'])
    expect(view.message).toBe('10 行を登録 / 3 行を登録')
  })

  it('results の要素が detail を持たなければ本文をそのまま出す', () => {
    const body = { ok: true, results: [{ print_id: 'CCCC3333' }, null] }
    const view = viewNetprintRunResult({ target: '27324455|1', ok: true, detail: detail(200, body) })
    expect(view.message).toBe(JSON.stringify(body))
  })

  it('results が配列でない JSON はそのまま原文を出す', () => {
    const view = viewNetprintRunResult({ target: '27324455|1', ok: true, detail: detail(200, { ok: true }) })
    expect(view.message).toBe('{"ok":true}')
  })

  // relay は DO を呼ぶ前に throw した場合、HTTP 前置きなしで例外の message を入れる。
  it('HTTP 前置きが無い detail (relay 側の例外) はそのまま出す', () => {
    const view = viewNetprintRunResult({ target: '27324455|1', ok: false, detail: 'Error: network error' })
    expect(view.message).toBe('Error: network error')
    expect(view.printIds).toEqual([])
  })

  it('target に | が無ければ全体を営業所コードとして扱う', () => {
    expect(viewNetprintRunResult({ target: '*', ok: false, detail: '' }).branchCd).toBe('*')
  })
})
