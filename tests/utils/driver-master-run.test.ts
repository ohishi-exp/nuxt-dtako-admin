import { describe, expect, it } from 'vitest'
import { buildDriverMasterRunOutcome, normalizeDriverMasterRunRows } from '~/utils/driver-master-run'

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
