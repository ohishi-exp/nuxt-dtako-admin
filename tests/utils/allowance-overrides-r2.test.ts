import { describe, it, expect } from 'vitest'

import {
  ALLOWANCE_OVERRIDE_SCHEMA_VERSION,
  UNKNOWN_OVERRIDE_BY,
  allowanceOverrideHashInput,
  allowanceOverrideHistoryLine,
  allowanceOverrideMigrationNote,
  allowanceOverrideR2Paths,
  allowanceOverrideSaveNote,
  allowanceOverrideValue,
  applyAllowanceOverrideOperation,
  emptyAllowanceOverrideSnapshot,
  isProvisionalOverrideValue,
  liveAllowanceOverrideCount,
  parseAllowanceOverrideBody,
  parseAllowanceOverrideSnapshot,
  resolveOverrideBy,
  type AllowanceOverrideSaveResult,
  type ProvisionalOverrideSnapshot,
} from '../../app/utils/allowance-overrides-r2'
import { parseProvisional } from '../../app/utils/allowance-provisional'

/** 本番に実在する唯一の暫定手当 (「広尾→芽室 マスタ待ち」の実体)。 */
const HIROO_MEMURO = '広尾|芽室'

const parse = (raw: string | null | undefined): ProvisionalOverrideSnapshot =>
  parseAllowanceOverrideSnapshot<number>(raw, 'provisional', isProvisionalOverrideValue)

function snapshotOf(entries: ProvisionalOverrideSnapshot['entries'], savedAt = '2026-08-24T00:00:00.000Z'): ProvisionalOverrideSnapshot {
  return { schemaVersion: ALLOWANCE_OVERRIDE_SCHEMA_VERSION, kind: 'provisional', entries, savedAt }
}

const entry = (value: number | null, by = 'a@example.com', at = '2026-08-24T00:00:00.000Z') => ({ value, by, at })

describe('allowanceOverrideR2Paths', () => {
  it('種類ごとに 1 系列。月で割らない (経路キーに月が無いため)', () => {
    expect(allowanceOverrideR2Paths('provisional')).toEqual({
      dir: 'profit/allowance-overrides/provisional',
      latest: 'profit/allowance-overrides/provisional/latest.json',
      version: expect.any(Function),
      history: 'profit/allowance-overrides/provisional/history.jsonl',
    })
    expect(allowanceOverrideR2Paths('provisional').version('20260824T102030'))
      .toBe('profit/allowance-overrides/provisional/v-20260824T102030.json')
  })

  it('後続 (excluded / force-match) も同じ土台に載る。3 種は混ざらない', () => {
    expect(allowanceOverrideR2Paths('excluded').latest).toBe('profit/allowance-overrides/excluded/latest.json')
    expect(allowanceOverrideR2Paths('force-match').history).toBe('profit/allowance-overrides/force-match/history.jsonl')
    expect(allowanceOverrideR2Paths('excluded').dir).not.toBe(allowanceOverrideR2Paths('force-match').dir)
  })

  it('★ 既存 2 系統と構造的に衝突しない (次の階層が YYYY-MM の形をしていない)', () => {
    // `profit/{ym}/...` は 2 階層目が YYYY-MM。`allowance-overrides` はその形ではない。
    const second = allowanceOverrideR2Paths('provisional').dir.split('/')[1]
    expect(second).toBe('allowance-overrides')
    expect(/^\d{4}-\d{2}$/.test(second!)).toBe(false)
  })
})

describe('parseAllowanceOverrideSnapshot — 壊れていても投げない', () => {
  it('空 / null / undefined は空の全体像', () => {
    expect(parse(null)).toEqual(emptyAllowanceOverrideSnapshot<number>('provisional'))
    expect(parse(undefined).entries).toEqual({})
    expect(parse('').entries).toEqual({})
  })

  it('JSON として読めない本文は空', () => {
    expect(parse('{壊れて').entries).toEqual({})
  })

  it('object でない本文 (数値 / 配列 / null) は空', () => {
    expect(parse('1').entries).toEqual({})
    expect(parse('[]').entries).toEqual({})
    expect(parse('null').entries).toEqual({})
  })

  it('schemaVersion が違う本文は丸ごと捨てる (形が変わったものを今の意味で読まない)', () => {
    const blob = JSON.stringify({ schemaVersion: 2, kind: 'provisional', entries: { [HIROO_MEMURO]: entry(9000) }, savedAt: '' })
    expect(parse(blob).entries).toEqual({})
  })

  it('★ kind が違う本文も丸ごと捨てる (別の種類のファイルを取り違えたら読まない)', () => {
    const blob = JSON.stringify({ schemaVersion: 1, kind: 'excluded', entries: { [HIROO_MEMURO]: entry(9000) }, savedAt: '' })
    expect(parse(blob).entries).toEqual({})
  })

  it('entries が object でない (欠落 / 配列 / null) 本文は空', () => {
    expect(parse(JSON.stringify({ schemaVersion: 1, kind: 'provisional', savedAt: '' })).entries).toEqual({})
    expect(parse(JSON.stringify({ schemaVersion: 1, kind: 'provisional', entries: [], savedAt: '' })).entries).toEqual({})
    expect(parse(JSON.stringify({ schemaVersion: 1, kind: 'provisional', entries: null, savedAt: '' })).entries).toEqual({})
  })

  it('壊れた entry だけ落とす (1 行のために全部を失わない)', () => {
    const blob = JSON.stringify({
      schemaVersion: 1,
      kind: 'provisional',
      entries: {
        '': entry(1000), // 空キー
        'a|b': 5, // object でない
        'c|d': null, // null
        'e|f': [], // 配列
        'g|h': { value: 9000, by: 1, at: 'x' }, // by が文字列でない
        'i|j': { value: 9000, by: 'x', at: 2 }, // at が文字列でない
        'k|l': { value: 0, by: 'x', at: 'y' }, // 0 以下は暫定手当ではない
        'm|n': { value: '9000', by: 'x', at: 'y' }, // 文字列は捨てる
        [HIROO_MEMURO]: entry(9000),
      },
      savedAt: '2026-08-24T01:00:00.000Z',
    })
    const got = parse(blob)
    expect(Object.keys(got.entries)).toEqual([HIROO_MEMURO])
    expect(got.entries[HIROO_MEMURO]).toEqual(entry(9000))
    expect(got.savedAt).toBe('2026-08-24T01:00:00.000Z')
  })

  it('★ tombstone (value: null) は正しい値として残す — 捨てると「消した」が「まだ無い」に化ける', () => {
    const blob = JSON.stringify({
      schemaVersion: 1,
      kind: 'provisional',
      entries: { [HIROO_MEMURO]: entry(null, 'b@example.com', '2026-08-24T02:00:00.000Z') },
      savedAt: '',
    })
    const got = parse(blob)
    expect(HIROO_MEMURO in got.entries).toBe(true)
    expect(got.entries[HIROO_MEMURO]!.value).toBeNull()
  })

  it('savedAt が文字列でなければ空文字 (0 や undefined を混ぜない)', () => {
    const blob = JSON.stringify({ schemaVersion: 1, kind: 'provisional', entries: {}, savedAt: 7 })
    expect(parse(blob).savedAt).toBe('')
  })

  it('★ 値の物差しは parseProvisional (localStorage 側) と同じ — R2 化しても緩めない', () => {
    // NaN は JSON を通らない (`JSON.stringify` が null にする) ので、ここでは扱わない —
    // 値そのものの物差しは `isProvisionalOverrideValue` のテストで押さえてある。
    const values = [9000, 0, -1, 1.5]
    for (const v of values) {
      const local = parseProvisional(JSON.stringify({ [HIROO_MEMURO]: v }))
      const r2 = parse(JSON.stringify({
        schemaVersion: 1,
        kind: 'provisional',
        entries: { [HIROO_MEMURO]: entry(v) },
        savedAt: '',
      }))
      expect(HIROO_MEMURO in r2.entries).toBe(HIROO_MEMURO in local)
    }
  })
})

describe('applyAllowanceOverrideOperation — サーバー側で 1 件だけ畳み込む', () => {
  it('新しい鍵を入れる。by / at はサーバーが埋める', () => {
    const after = applyAllowanceOverrideOperation(
      emptyAllowanceOverrideSnapshot<number>('provisional'),
      { key: HIROO_MEMURO, value: 9000 },
      'me@example.com',
      '2026-08-24T03:00:00.000Z',
    )
    expect(after.entries[HIROO_MEMURO]).toEqual({ value: 9000, by: 'me@example.com', at: '2026-08-24T03:00:00.000Z' })
    expect(after.savedAt).toBe('2026-08-24T03:00:00.000Z')
    expect(after.kind).toBe('provisional')
  })

  it('★ 他の鍵に触らない — 2 台目が押しても相手の確定が消えない', () => {
    const before = snapshotOf({ 'a|b': entry(1000), 'c|d': entry(2000) })
    const after = applyAllowanceOverrideOperation(before, { key: 'c|d', value: 3000 }, 'you@example.com', 't')
    expect(after.entries['a|b']).toEqual(entry(1000))
    expect(after.entries['c|d']).toEqual({ value: 3000, by: 'you@example.com', at: 't' })
    // 元の全体像は書き換えない (identity を無闇に共有しない)。
    expect(before.entries['c|d']).toEqual(entry(2000))
  })

  it('★ 消す操作でも鍵を delete しない — tombstone を書く (union で復活しないための根治)', () => {
    const before = snapshotOf({ [HIROO_MEMURO]: entry(9000) })
    const after = applyAllowanceOverrideOperation(before, { key: HIROO_MEMURO, value: null }, 'me@example.com', 't2')
    expect(HIROO_MEMURO in after.entries).toBe(true)
    expect(after.entries[HIROO_MEMURO]).toEqual({ value: null, by: 'me@example.com', at: 't2' })
  })

  it('★ 同じ鍵は後勝ち (衝突解決の UI は作らない。追えるのは history)', () => {
    const first = applyAllowanceOverrideOperation(emptyAllowanceOverrideSnapshot<number>('provisional'), { key: 'k', value: 1 }, 'a@x', 't1')
    const second = applyAllowanceOverrideOperation(first, { key: 'k', value: 2 }, 'b@x', 't2')
    expect(second.entries.k).toEqual({ value: 2, by: 'b@x', at: 't2' })
  })
})

describe('allowanceOverrideValue / liveAllowanceOverrideCount', () => {
  it('鍵が無い / tombstone はどちらも null (どちらも「値が無い」)', () => {
    const snapshot = snapshotOf({ dead: entry(null), live: entry(9000) })
    expect(allowanceOverrideValue(snapshot, 'missing')).toBeNull()
    expect(allowanceOverrideValue(snapshot, 'dead')).toBeNull()
    expect(allowanceOverrideValue(snapshot, 'live')).toBe(9000)
  })

  it('生きている鍵だけ数える (画面の「R2 にはいま N 件」)', () => {
    expect(liveAllowanceOverrideCount(snapshotOf({ a: entry(1), b: entry(null), c: entry(2) }))).toBe(2)
    expect(liveAllowanceOverrideCount(emptyAllowanceOverrideSnapshot<number>('provisional'))).toBe(0)
  })
})

describe('allowanceOverrideHashInput — 版が増えるのは値が動いたときだけ', () => {
  it('savedAt と entry ごとの by / at は差分に効かない (押した回数で版が増えない)', () => {
    const a = snapshotOf({ [HIROO_MEMURO]: entry(9000, 'a@x', 't1') }, '2026-08-24T00:00:00.000Z')
    const b = snapshotOf({ [HIROO_MEMURO]: entry(9000, 'b@x', 't2') }, '2026-08-25T00:00:00.000Z')
    expect(allowanceOverrideHashInput(a)).toBe(allowanceOverrideHashInput(b))
  })

  it('★ 鍵の順が違うだけでは差分にしない (2 台が別の順で触っただけで版が増えないように)', () => {
    const a = snapshotOf({ 'a|b': entry(1), 'c|d': entry(2) })
    const b = snapshotOf({ 'c|d': entry(2), 'a|b': entry(1) })
    expect(allowanceOverrideHashInput(a)).toBe(allowanceOverrideHashInput(b))
  })

  it('値が動けば差分になる。tombstone と「鍵が無い」も別物として差分になる', () => {
    const live = snapshotOf({ [HIROO_MEMURO]: entry(9000) })
    const other = snapshotOf({ [HIROO_MEMURO]: entry(8000) })
    const dead = snapshotOf({ [HIROO_MEMURO]: entry(null) })
    const none = snapshotOf({})
    expect(allowanceOverrideHashInput(live)).not.toBe(allowanceOverrideHashInput(other))
    expect(allowanceOverrideHashInput(live)).not.toBe(allowanceOverrideHashInput(dead))
    expect(allowanceOverrideHashInput(dead)).not.toBe(allowanceOverrideHashInput(none))
  })

  it('kind も差分に入る (同じ鍵・同じ値でも種類が違えば別物)', () => {
    const provisional = snapshotOf({ k: entry(1) })
    const excluded = { ...provisional, kind: 'excluded' as const }
    expect(allowanceOverrideHashInput(provisional)).not.toBe(allowanceOverrideHashInput(excluded))
  })
})

describe('allowanceOverrideHistoryLine — 誰が・いつ・何から何に', () => {
  it('前の値と後の値を両方残す', () => {
    const after = snapshotOf({ [HIROO_MEMURO]: entry(9000, 'me@x', 't') }, 't')
    expect(allowanceOverrideHistoryLine({ snapshot: after, key: HIROO_MEMURO, by: 'me@x', before: 8000, changed: true })).toEqual({
      ts: 't',
      changed: true,
      kind: 'provisional',
      key: HIROO_MEMURO,
      by: 'me@x',
      before: 8000,
      after: 9000,
      entries: 1,
    })
  })

  it('消した回は after が null。生存件数も減る', () => {
    const after = snapshotOf({ [HIROO_MEMURO]: entry(null, 'me@x', 't'), other: entry(1) }, 't')
    const line = allowanceOverrideHistoryLine({ snapshot: after, key: HIROO_MEMURO, by: 'me@x', before: 9000, changed: true })
    expect(line.after).toBeNull()
    expect(line.entries).toBe(1)
  })

  it('値が動かなかった回も 1 行残す (誰がいつ触ったかは版ではなく履歴の持ち物)', () => {
    const after = snapshotOf({ k: entry(9000) }, 't')
    expect(allowanceOverrideHistoryLine({ snapshot: after, key: 'k', by: 'me@x', before: 9000, changed: false }).changed).toBe(false)
  })
})

describe('resolveOverrideBy', () => {
  it('email が取れれば そのまま', () => {
    expect(resolveOverrideBy('me@example.com')).toBe('me@example.com')
  })

  it('★ 空文字に倒さない — 空だとレンダリングの不具合に見える', () => {
    expect(resolveOverrideBy('')).toBe(UNKNOWN_OVERRIDE_BY)
    expect(resolveOverrideBy(undefined)).toBe(UNKNOWN_OVERRIDE_BY)
    expect(resolveOverrideBy(123)).toBe(UNKNOWN_OVERRIDE_BY)
    expect(UNKNOWN_OVERRIDE_BY).not.toBe('')
  })
})

describe('isProvisionalOverrideValue', () => {
  it('1 以上の整数だけ受ける (給与に混ざる数字なので緩めない)', () => {
    expect(isProvisionalOverrideValue(9000)).toBe(true)
    expect(isProvisionalOverrideValue(1)).toBe(true)
    expect(isProvisionalOverrideValue(0)).toBe(false)
    expect(isProvisionalOverrideValue(-9000)).toBe(false)
    expect(isProvisionalOverrideValue(9000.5)).toBe(false)
    expect(isProvisionalOverrideValue('9000')).toBe(false)
    expect(isProvisionalOverrideValue(null)).toBe(false)
  })
})

describe('parseAllowanceOverrideBody — 受けるのは 1 件だけ', () => {
  const body = (o: Record<string, unknown> = {}) => ({ schemaVersion: 1, kind: 'provisional', key: HIROO_MEMURO, value: 9000, ...o })

  it('正しい body', () => {
    expect(parseAllowanceOverrideBody(body())).toEqual({ ok: true, kind: 'provisional', key: HIROO_MEMURO, value: 9000 })
  })

  it('消す操作 (value: null) も正しい body', () => {
    expect(parseAllowanceOverrideBody(body({ value: null }))).toEqual({ ok: true, kind: 'provisional', key: HIROO_MEMURO, value: null })
  })

  it('object でない body は 400 の理由付きで落とす', () => {
    for (const bad of [null, 'x', 1, []]) {
      const got = parseAllowanceOverrideBody(bad)
      expect(got.ok).toBe(false)
      expect(got.ok === false && got.error).toContain('object')
    }
  })

  it('schemaVersion が違えば落とす', () => {
    const got = parseAllowanceOverrideBody(body({ schemaVersion: 2 }))
    expect(got.ok === false && got.error).toContain('schemaVersion')
  })

  it('★ この PR は provisional だけ — excluded / force-match は値の検査を持たないので受けない', () => {
    for (const kind of ['excluded', 'force-match', '', undefined]) {
      const got = parseAllowanceOverrideBody(body({ kind }))
      expect(got.ok).toBe(false)
      expect(got.ok === false && got.error).toContain('provisional')
    }
  })

  it('key が無い / 空文字は落とす (経路キーが空の便には暫定を当てられない)', () => {
    expect(parseAllowanceOverrideBody(body({ key: '' })).ok).toBe(false)
    expect(parseAllowanceOverrideBody(body({ key: 1 })).ok).toBe(false)
    expect(parseAllowanceOverrideBody(body({ key: undefined })).ok).toBe(false)
  })

  it('value が 1 以上の整数でも null でもなければ落とす', () => {
    for (const value of [0, -1, 1.5, '9000', undefined]) {
      const got = parseAllowanceOverrideBody(body({ value }))
      expect(got.ok).toBe(false)
      expect(got.ok === false && got.error).toContain('value')
    }
  })

  it('★ 全体マップを受ける形は無い (map を送っても key/value として落ちる)', () => {
    const got = parseAllowanceOverrideBody({ schemaVersion: 1, kind: 'provisional', map: { [HIROO_MEMURO]: 9000 } })
    expect(got.ok).toBe(false)
  })
})

describe('allowanceOverrideSaveNote — 失敗を黙らせない', () => {
  const result = (o: Partial<AllowanceOverrideSaveResult> = {}): AllowanceOverrideSaveResult => ({
    saved: true,
    changed: true,
    savedAt: '2026-08-24T04:00:00.000Z',
    by: 'me@example.com',
    key: HIROO_MEMURO,
    entries: 1,
    versionKey: 'profit/allowance-overrides/provisional/v-20260824T130000.json',
    ...o,
  })

  it('失敗は理由と「端末の記録は残っている」を出す', () => {
    const note = allowanceOverrideSaveNote(null, 'HTTP 503')
    expect(note).toContain('HTTP 503')
    expect(note).toContain('この端末の記録は残っている')
  })

  it('結果が無ければ何も言わない (押していない状態で注記を出さない)', () => {
    expect(allowanceOverrideSaveNote(null, null)).toBe('')
  })

  it('★ 成功しても「集計はこの端末の記録から出している」と断る (自動 fetch を入れていないため)', () => {
    const note = allowanceOverrideSaveNote(result(), null)
    expect(note).toContain('送りました')
    expect(note).toContain('me@example.com')
    expect(note).toContain('1 件')
    expect(note).toContain('この端末の記録から出しています')
  })

  it('値が同じだった回は「版は増やしていません」', () => {
    const note = allowanceOverrideSaveNote(result({ changed: false, entries: 3 }), null)
    expect(note).toContain('版は増やしていません')
    expect(note).toContain('3 件')
  })

  it('注記に markdown の強調記号を混ぜない (そのまま画面に出るため)', () => {
    expect(allowanceOverrideSaveNote(result(), null)).not.toContain('**')
    expect(allowanceOverrideSaveNote(null, 'x')).not.toContain('**')
  })
})

describe('allowanceOverrideMigrationNote — この端末のぶんを送る', () => {
  it('全部送れたら件数と R2 の件数を出し、端末の記録を消していないと言う', () => {
    const note = allowanceOverrideMigrationNote({ sent: 1, failed: 0, entries: 1, firstError: '' })
    expect(note).toContain('1 件を R2')
    expect(note).toContain('この端末の記録は消していません')
  })

  it('★ 失敗した回は「もう一度押せば送れなかったぶんだけ送り直せる」— 1 件ずつにした利点', () => {
    const note = allowanceOverrideMigrationNote({ sent: 2, failed: 1, entries: 2, firstError: 'HTTP 401' })
    expect(note).toContain('3 件のうち 1 件')
    expect(note).toContain('HTTP 401')
    expect(note).toContain('送り直せます')
  })

  it('注記に markdown の強調記号を混ぜない', () => {
    expect(allowanceOverrideMigrationNote({ sent: 1, failed: 0, entries: 1, firstError: '' })).not.toContain('**')
    expect(allowanceOverrideMigrationNote({ sent: 0, failed: 1, entries: 0, firstError: 'x' })).not.toContain('**')
  })
})

describe('★ 本番の実データ (広尾|芽室 → 9000) が 1 往復して同じ値で戻る', () => {
  it('localStorage → 1 件の操作 → R2 の全体像 → 読み直し', () => {
    const local = parseProvisional(JSON.stringify({ [HIROO_MEMURO]: 9000 }))
    expect(local).toEqual({ [HIROO_MEMURO]: 9000 })

    let snapshot = emptyAllowanceOverrideSnapshot<number>('provisional')
    for (const [key, yen] of Object.entries(local)) {
      snapshot = applyAllowanceOverrideOperation(snapshot, { key, value: yen }, 'me@example.com', '2026-08-24T05:00:00.000Z')
    }
    const roundTripped = parse(JSON.stringify(snapshot))
    expect(allowanceOverrideValue(roundTripped, HIROO_MEMURO)).toBe(9000)
    expect(liveAllowanceOverrideCount(roundTripped)).toBe(1)
  })
})
