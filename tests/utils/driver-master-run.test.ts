import { describe, expect, it } from 'vitest'
import {
  buildDriverMasterRunOutcome,
  driverMasterStatusLines,
  normalizeDriverMasterRunRows,
  normalizeDriverMasterStatus,
  type DriverMasterStatusItem,
} from '~/utils/driver-master-run'

describe('normalizeDriverMasterRunRows', () => {
  it('単体形 (relay PR #1078 の現行応答) を 1 行にする', () => {
    const body = {
      ok: true,
      comp_id: '27324455',
      created: 3,
      updated: 40,
      skipped: [{ code: 'no_license', reason: '免許番号が読めません' }],
    }
    expect(normalizeDriverMasterRunRows(body, '27324455')).toEqual([
      { compId: '27324455', ok: true, created: 3, updated: 40, skipped: [{ code: 'no_license', reason: '免許番号が読めません' }], error: null },
    ])
  })

  it('単体形に comp_id が無ければ呼び出し側の fallbackCompId を使う', () => {
    const body = { ok: false, error: 'theearth ログインに失敗しました' }
    expect(normalizeDriverMasterRunRows(body, '27324455')).toEqual([
      { compId: '27324455', ok: false, created: 0, updated: 0, skipped: [], error: 'theearth ログインに失敗しました' },
    ])
  })

  it('{results:[...]} 形 (将来形、c125-4) は各要素を 1 行にする', () => {
    const body = {
      results: [
        { comp_id: '27324455', status: 'ok', created: 1, updated: 2, skipped: [] },
        { comp_id: '27324456', status: 'error', created: 0, updated: 0, skipped: [], error: 'comp_id が DTAKO_ACCOUNTS に見つかりません' },
      ],
    }
    expect(normalizeDriverMasterRunRows(body, '')).toEqual([
      { compId: '27324455', ok: true, created: 1, updated: 2, skipped: [], error: null },
      { compId: '27324456', ok: false, created: 0, updated: 0, skipped: [], error: 'comp_id が DTAKO_ACCOUNTS に見つかりません' },
    ])
  })

  it('results の status が ok/error のどちらでもなければ失敗扱い (fail-closed)', () => {
    const body = { results: [{ comp_id: '1', status: 'pending' }] }
    expect(normalizeDriverMasterRunRows(body, '')[0]).toMatchObject({ ok: false })
  })

  it('results の要素がオブジェクトでなければ落とす', () => {
    const body = { results: ['not an object', null, { comp_id: '1', status: 'ok' }] }
    expect(normalizeDriverMasterRunRows(body, '')).toEqual([
      { compId: '1', ok: true, created: 0, updated: 0, skipped: [], error: null },
    ])
  })

  it('skipped の要素がオブジェクトでなければ落とし、code/reason が無ければ既定値で受ける', () => {
    const body = { comp_id: '1', skipped: ['not an object', { code: 'x' }] }
    expect(normalizeDriverMasterRunRows(body, '')[0]!.skipped).toEqual([
      { code: 'x', reason: '' },
    ])
  })

  it('どちらの形も読めなければ空配列', () => {
    expect(normalizeDriverMasterRunRows(null, '27324455')).toEqual([])
    expect(normalizeDriverMasterRunRows('text', '27324455')).toEqual([])
  })

  it('created/updated が数値でなければ 0 に倒す', () => {
    const body = { comp_id: '1', created: 'x', updated: null }
    expect(normalizeDriverMasterRunRows(body, '')[0]).toMatchObject({ created: 0, updated: 0 })
  })
})

describe('buildDriverMasterRunOutcome', () => {
  it('2xx: ok:true で応答本文を行にする', () => {
    const outcome = buildDriverMasterRunOutcome(200, true, { comp_id: '1', created: 1, updated: 0, skipped: [] }, '1')
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe(200)
    expect(outcome.error).toBeNull()
    expect(outcome.rows).toEqual([{ compId: '1', ok: false, created: 1, updated: 0, skipped: [], error: null }])
  })

  it('非 2xx: createError の data から行を拾い、理由を pickBodyReason で拾う', () => {
    const body = {
      statusMessage: 'relay: theearth ログインに失敗しました',
      message: 'relay: theearth ログインに失敗しました',
      data: { ok: false, comp_id: '1', error: 'theearth ログインに失敗しました' },
    }
    const outcome = buildDriverMasterRunOutcome(502, false, body, '1')
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe(502)
    expect(outcome.error).toBe('relay: theearth ログインに失敗しました')
    expect(outcome.rows).toEqual([{ compId: '1', ok: false, created: 0, updated: 0, skipped: [], error: 'theearth ログインに失敗しました' }])
  })

  it('非 2xx で data が無ければ行は空配列、理由は HTTP {status}', () => {
    const outcome = buildDriverMasterRunOutcome(503, false, null, '1')
    expect(outcome.rows).toEqual([])
    expect(outcome.error).toBe('HTTP 503')
  })
})

describe('normalizeDriverMasterStatus', () => {
  it('server route の応答を会社ごとの配列にする', () => {
    const body = {
      results: [
        { comp_id: '27324455', last: { trigger: 'cron', finished_at: '2026-03-02T03:00:40.000Z', ok: true, error: null }, error: false },
        { comp_id: '27324456', last: null, error: true },
      ],
    }
    expect(normalizeDriverMasterStatus(body)).toEqual(body.results)
  })

  it('読めない要素は捨て、読めない欄は安全側に倒す', () => {
    const body = {
      results: [
        { comp_id: '27324455', last: { trigger: 'other', finished_at: 1, ok: 1, error: '' }, error: 'yes' },
        { comp_id: '27324456', last: 'x' },
        { comp_id: '' },
        { last: null },
        null,
      ],
    }
    expect(normalizeDriverMasterStatus(body)).toEqual([
      { comp_id: '27324455', last: { trigger: null, finished_at: '', ok: false, error: null }, error: false },
      { comp_id: '27324456', last: null, error: false },
    ])
  })

  it('results が配列でなければ空', () => {
    expect(normalizeDriverMasterStatus(null)).toEqual([])
    expect(normalizeDriverMasterStatus({})).toEqual([])
    expect(normalizeDriverMasterStatus({ results: 'x' })).toEqual([])
  })
})

describe('driverMasterStatusLines', () => {
  const LABELS = { 27324455: 'テスト運輸A', 27324456: 'テスト運輸B' }
  const okCron: DriverMasterStatusItem = {
    comp_id: '27324455',
    // 03:00 UTC = 日本時間 12:00
    last: { trigger: 'cron', finished_at: '2026-03-02T03:00:40.000Z', ok: true, error: null },
    error: false,
  }
  const failedManual: DriverMasterStatusItem = {
    comp_id: '27324456',
    // 15:30 UTC = 日本時間で翌日の 00:30
    last: { trigger: 'manual', finished_at: '2026-03-02T15:30:00.000Z', ok: false, error: 'theearth ログインに失敗しました' },
    error: false,
  }

  it('会社を選んでいるとき: その会社の 1 行 (頭は「最終同期: 」。日時は日本時間)', () => {
    expect(driverMasterStatusLines([okCron, failedManual], '27324455', LABELS)).toEqual([
      { compId: '27324455', level: 'ok', text: '最終同期: 2026-03-02 12:00 成功 (定時)', detail: null },
    ])
    expect(driverMasterStatusLines([okCron, failedManual], '27324456', LABELS)).toEqual([
      { compId: '27324456', level: 'error', text: '最終同期: 2026-03-03 00:30 失敗 (手動)', detail: 'theearth ログインに失敗しました' },
    ])
  })

  it('選んだ会社が応答に無ければ「記録なし」', () => {
    expect(driverMasterStatusLines([okCron], '27324457', LABELS)).toEqual([
      { compId: '27324457', level: 'muted', text: '最終同期: 記録なし', detail: null },
    ])
  })

  it('「全企業」のとき: 会社ごとに 1 行ずつ (頭は社名。無ければ comp_id)', () => {
    const none: DriverMasterStatusItem = { comp_id: '27324457', last: null, error: false }
    const unreadable: DriverMasterStatusItem = { comp_id: '27324458', last: null, error: true }
    expect(driverMasterStatusLines([okCron, failedManual, none, unreadable], '', LABELS)).toEqual([
      { compId: '27324455', level: 'ok', text: 'テスト運輸A: 2026-03-02 12:00 成功 (定時)', detail: null },
      { compId: '27324456', level: 'error', text: 'テスト運輸B: 2026-03-03 00:30 失敗 (手動)', detail: 'theearth ログインに失敗しました' },
      { compId: '27324457', level: 'muted', text: '27324457: 記録なし', detail: null },
      { compId: '27324458', level: 'error', text: '27324458: 取得できませんでした', detail: null },
    ])
    expect(driverMasterStatusLines([], '', LABELS)).toEqual([])
  })

  it('失敗の理由は 1 行にして、長ければ切る。理由が無い失敗は理由なし。きっかけが読めなければ「不明」', () => {
    const long: DriverMasterStatusItem = {
      comp_id: '27324455',
      last: { trigger: null, finished_at: '2026-03-02T03:00:40.000Z', ok: false, error: `line1\n  line2 ${'x'.repeat(200)}` },
      error: false,
    }
    const [line] = driverMasterStatusLines([long], '27324455', LABELS)
    expect(line!.text).toBe('最終同期: 2026-03-02 12:00 失敗 (不明)')
    expect(line!.detail).toBe(`line1 line2 ${'x'.repeat(108)}…`)
    expect(line!.detail).toHaveLength(121)

    const noReason: DriverMasterStatusItem = { ...long, last: { ...long.last!, error: null } }
    expect(driverMasterStatusLines([noReason], '27324455', LABELS)[0]).toEqual({
      compId: '27324455', level: 'error', text: '最終同期: 2026-03-02 12:00 失敗 (不明)', detail: null,
    })
  })

  it('終了時刻が日時として読めなければ、元の文字列のまま出す', () => {
    const odd: DriverMasterStatusItem = { ...okCron, last: { ...okCron.last!, finished_at: '' } }
    expect(driverMasterStatusLines([odd], '27324455', LABELS)[0]!.text).toBe('最終同期:  成功 (定時)')
  })
})
