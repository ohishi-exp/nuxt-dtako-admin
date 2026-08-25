import { describe, it, expect } from 'vitest'
import {
  describeNetprintRunFailure,
  isValidNetprintDate,
  parseNetprintRunBody,
} from '../../server/utils/netprint-run'

/** 成功したときの `{ ok: true, body }` を取り出す (失敗なら落とす)。 */
function parsed(body: unknown) {
  const result = parseNetprintRunBody(body)
  if (!result.ok) throw new Error(`想定外の 400: ${result.error}`)
  return result.body
}

describe('isValidNetprintDate', () => {
  it('YYYY-MM-DD で実在する日付だけ true', () => {
    expect(isValidNetprintDate('2026-08-24')).toBe(true)
    expect(isValidNetprintDate('2024-02-29')).toBe(true) // 閏年
  })

  it('形式違いは false', () => {
    expect(isValidNetprintDate('2026/08/24')).toBe(false)
    expect(isValidNetprintDate('26-08-24')).toBe(false)
    expect(isValidNetprintDate('')).toBe(false)
  })

  it('形式は合っていても実在しない日付は false', () => {
    expect(isValidNetprintDate('2026-02-31')).toBe(false)
    expect(isValidNetprintDate('2026-13-01')).toBe(false)
    expect(isValidNetprintDate('2026-01-00')).toBe(false)
    expect(isValidNetprintDate('2026-01-32')).toBe(false)
    expect(isValidNetprintDate('2026-02-29')).toBe(false) // 平年
  })
})

describe('parseNetprintRunBody', () => {
  it('空オブジェクトは全部 relay の既定に任せる (キーを 1 つも送らない)', () => {
    expect(parsed({})).toEqual({})
  })

  it('body がオブジェクトでなければ 400', () => {
    for (const body of [null, undefined, 'x', 1, [], [{ date: '2026-08-24' }]]) {
      const result = parseNetprintRunBody(body)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toContain('JSON オブジェクト')
    }
  })

  it('date だけの指定を素通しする', () => {
    expect(parsed({ date: '2026-08-24' })).toEqual({ date: '2026-08-24' })
  })

  it('date が YYYY-MM-DD でなければ 400 (実在しない日付も)', () => {
    for (const date of ['2026/08/24', '2026-02-31', 'yesterday']) {
      const result = parseNetprintRunBody({ date })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toContain('YYYY-MM-DD')
    }
  })

  it('前後の空白は落とし、空文字はキーごと送らない', () => {
    expect(parsed({ date: '  2026-08-24  ', comp_id: '   ' })).toEqual({ date: '2026-08-24' })
  })

  it('null / undefined のキーは未指定として扱う', () => {
    expect(parsed({ date: null, branch_cd: undefined })).toEqual({})
  })

  it('文字列でない値は 400 (relay に黙って落とさせない)', () => {
    for (const key of ['date', 'branch_cd', 'channel_id', 'recipient_id', 'branch_name', 'comp_id']) {
      const result = parseNetprintRunBody({ [key]: 123 })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toBe(`${key} は文字列で指定してください`)
    }
  })

  // ★ 誤配先への送信を防ぐガード (relay の planNetprintRun と同じものを front にも持つ)。
  it('branch_cd と channel_id は両方揃っていれば通る', () => {
    expect(parsed({ branch_cd: '1', channel_id: 'ch-1', branch_name: '本社営業所' })).toEqual({
      branch_cd: '1', channel_id: 'ch-1', branch_name: '本社営業所',
    })
  })

  it('branch_cd と宛先の片方だけは 400', () => {
    for (const body of [
      { branch_cd: '1' },
      { channel_id: 'ch-1' },
      { recipient_id: 'rcp-1' },
      { branch_cd: '1', channel_id: '  ' },
      { branch_cd: '1', recipient_id: '  ' },
    ]) {
      const result = parseNetprintRunBody(body)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toContain('両方まとめて')
    }
  })

  // ★ 宛先はトークルーム (channel_id) か個人 (recipient_id) のどちらか一方
  // (Refs #874 の 10)。relay も rust も両方指定を 400 にするので front でも弾く。
  it('branch_cd と recipient_id は両方揃っていれば通る (個人宛)', () => {
    expect(parsed({ branch_cd: '1', recipient_id: 'rcp-1', branch_name: '本社営業所' })).toEqual({
      branch_cd: '1', recipient_id: 'rcp-1', branch_name: '本社営業所',
    })
  })

  it('channel_id と recipient_id の両方指定は 400', () => {
    const result = parseNetprintRunBody({ branch_cd: '1', channel_id: 'ch-1', recipient_id: 'rcp-1' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe('channel_id と recipient_id はどちらか一方だけ指定してください')
  })

  it('branch_name だけの指定は 400 (どこへ送るか決まらない)', () => {
    const result = parseNetprintRunBody({ branch_name: '本社営業所' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('branch_name だけ')
  })

  it('operation_no は単独で指定できる (通知先は relay の NETPRINT_TARGETS 任せ、Refs #913)', () => {
    expect(parsed({ date: '2026-08-24', operation_no: ' 2608240638160000003821 ' })).toEqual({
      date: '2026-08-24',
      operation_no: '2608240638160000003821',
    })
  })

  it('operation_no が 22 桁の数字でなければ 400 (theearth ログイン前に返す)', () => {
    for (const operation_no of ['3821', '26082406381600000038210', '260824063816000000382X']) {
      const result = parseNetprintRunBody({ operation_no })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toBe(
        'operation_no は 22 桁の数字 (theearth の運行No) で指定してください',
      )
    }
  })

  it('operation_no の空文字はキーごと送らない (= 従来どおり全運行)', () => {
    expect(parsed({ date: '2026-08-24', operation_no: '  ' })).toEqual({ date: '2026-08-24' })
  })

  it('comp_id は単独で指定できる', () => {
    expect(parsed({ comp_id: '27324455' })).toEqual({ comp_id: '27324455' })
  })
})

describe('describeNetprintRunFailure', () => {
  it('relay の {error} をそのまま使う', () => {
    expect(describeNetprintRunFailure({ error: 'Unauthorized' }, 401)).toBe('Unauthorized')
  })

  it('error が空文字なら既定文に落とす', () => {
    expect(describeNetprintRunFailure({ error: '' }, 500)).toContain('HTTP 500')
  })

  // 一部の営業所だけ失敗した 502 は {error} ではなく results を持って返る。
  it('results があれば失敗件数を数える', () => {
    const data = {
      ok: false,
      results: [{ ok: true }, { ok: false }, null],
    }
    expect(describeNetprintRunFailure(data, 502)).toBe('3 件中 2 件の営業所が失敗しました (HTTP 502)')
  })

  it('全 target が skipped の 400 は「営業所が失敗」と書かず、探した営業所の数を出す (Refs #913)', () => {
    // 「N 件中 N 件の営業所が失敗」だと theearth や netprint を疑わせる。実際は
    // 指定された運行NO がどこにも無かっただけで、直すのは呼んだ人の入力。
    expect(describeNetprintRunFailure(
      { ok: false, results: [{ ok: false, skipped: true }, { ok: false, skipped: true }] },
      400,
    )).toBe('指定された運行NO はどの営業所にも見つかりませんでした (2 営業所を探しました。HTTP 400)')
  })

  it('skipped が混ざっていても全部でなければ従来どおり失敗件数を数える', () => {
    expect(describeNetprintRunFailure(
      { ok: false, results: [{ ok: false, skipped: true }, { ok: false }] },
      502,
    )).toBe('2 件中 2 件の営業所が失敗しました (HTTP 502)')
  })

  it('results が空配列 / 配列でない / body が JSON でない場合は既定文', () => {
    expect(describeNetprintRunFailure({ results: [] }, 502)).toBe('日報 netprint の実行に失敗しました (HTTP 502)')
    expect(describeNetprintRunFailure({ results: 'x' }, 502)).toContain('HTTP 502')
    expect(describeNetprintRunFailure(null, 502)).toContain('HTTP 502')
    expect(describeNetprintRunFailure('plain text', 502)).toContain('HTTP 502')
  })

  it('error が文字列でなければ results / 既定文にフォールバックする', () => {
    expect(describeNetprintRunFailure({ error: { code: 1 }, results: [{ ok: false }] }, 502))
      .toBe('1 件中 1 件の営業所が失敗しました (HTTP 502)')
  })
})
