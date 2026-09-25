/**
 * 訴訟準備の「変更記録」タブの pure ロジック (`app/utils/litigation-changes.ts`、
 * Refs #1133 c1133-6)。
 *
 * - 打刻 (`GET /restraint-api/kintai/change-log`) / 運行 (`GET
 *   /api/proxy/api/dtako/operation-changes`) 両方の応答を防御的に読む
 * - 要約は「変わったものだけ」— 始業の変更・日ごと消えた・休憩変化・乗務員付け替え・
 *   手動削除・before_kudgivt unavailable の型を個別に確認する
 * - 記録開始日の文言は「変更なし」「記録が無い」「読めなかった」を混同しない
 */
import { describe, it, expect } from 'vitest'
import {
  ALC_REASON_LABEL,
  alcChangeSummary,
  alcRecordingSinceNotice,
  buildAlcChangeRows,
  buildKintaiChangeRows,
  kintaiChangeSummary,
  kintaiRecordingSinceNotice,
  litigationCaseDateBounds,
  litigationChangesCsv,
  mergeLitigationChangeRows,
  parseAlcOperationChanges,
  parseKintaiChangeLog,
  splitDateRangeByMaxDays,
  type AlcOperationChangeEntry,
  type AlcOperationSnapshot,
  type KintaiChangeLogEntry,
  type LitigationChangeRow,
} from '~/utils/litigation-changes'

describe('litigationCaseDateBounds', () => {
  it('開始月の1日〜終了月の末日', () => {
    expect(litigationCaseDateBounds('2026-01', '2026-06')).toEqual({ from: '2026-01-01', to: '2026-06-30' })
  })

  it('単月・2月 (うるう年) の末日', () => {
    expect(litigationCaseDateBounds('2028-02', '2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })
})

describe('splitDateRangeByMaxDays', () => {
  it('上限以内ならチャンク1本', () => {
    expect(splitDateRangeByMaxDays('2026-01-01', '2026-01-31', 400)).toEqual([{ from: '2026-01-01', to: '2026-01-31' }])
  })

  it('上限を超えたら分ける (400日ずつ)', () => {
    // 2025-01-01〜2026-06-30 は 546 日 → 400 + 146
    const chunks = splitDateRangeByMaxDays('2025-01-01', '2026-06-30', 400)
    expect(chunks).toEqual([
      { from: '2025-01-01', to: '2026-02-04' },
      { from: '2026-02-05', to: '2026-06-30' },
    ])
  })

  it('from > to は空配列', () => {
    expect(splitDateRangeByMaxDays('2026-06-30', '2026-01-01', 400)).toEqual([])
  })
})

// ---- parseKintaiChangeLog ----

describe('parseKintaiChangeLog', () => {
  it('確定済みの形をそのまま camelCase に読み替える', () => {
    const raw = {
      driver: '1078',
      from: '2026-06-01',
      to: '2026-06-30',
      recording_since: '2026-09-25',
      changes: [
        {
          driver_cd: 1078,
          date: '2026-06-05',
          recorded_at: '2026-06-06T01:00:00Z',
          before: [{ occurred_at: '2026-06-05T08:00:00Z', state: '始業', source: 'timecard', unko_no: null }],
          after: [{ occurred_at: '2026-06-05T07:30:00Z', state: '始業', source: 'timecard', unko_no: '260605...' }],
        },
      ],
    }
    const r = parseKintaiChangeLog(raw)
    expect(r.driver).toBe('1078')
    expect(r.from).toBe('2026-06-01')
    expect(r.to).toBe('2026-06-30')
    expect(r.recordingSince).toBe('2026-09-25')
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0]).toEqual({
      driverCd: '1078',
      date: '2026-06-05',
      recordedAt: '2026-06-06T01:00:00Z',
      before: [{ occurredAt: '2026-06-05T08:00:00Z', state: '始業', source: 'timecard', unkoNo: null }],
      after: [{ occurredAt: '2026-06-05T07:30:00Z', state: '始業', source: 'timecard', unkoNo: '260605...' }],
    })
  })

  it('日ごと消えた (`after: null`) はそのまま `null` で持つ', () => {
    const raw = {
      recording_since: '2026-09-25',
      changes: [
        {
          driver_cd: '1078',
          date: '2026-06-06',
          recorded_at: '2026-06-07T01:00:00Z',
          before: [{ occurred_at: '2026-06-06T18:10:00Z', state: '運行終了', source: 'dtako', unko_no: 'x' }],
          after: null,
        },
      ],
    }
    expect(parseKintaiChangeLog(raw).changes[0]!.after).toBeNull()
  })

  it('★ recording_since が `null` (まだ1件も記録されていない)', () => {
    expect(parseKintaiChangeLog({ recording_since: null, changes: [] }).recordingSince).toBeNull()
  })

  it('壊れた形は空に倒す (null/undefined/型崩れ)', () => {
    expect(parseKintaiChangeLog(null)).toEqual({ driver: null, from: null, to: null, recordingSince: null, changes: [] })
    expect(parseKintaiChangeLog({ changes: 'not-array' })).toEqual({
      driver: null, from: null, to: null, recordingSince: null, changes: [],
    })
    // 壊れた change エントリ (date が無い / before が無い) は捨てる
    expect(parseKintaiChangeLog({ changes: [{ recorded_at: 'x' }, 'not-object', null] }).changes).toEqual([])
    // 壊れた event (occurred_at が無い) は捨てる
    const withBadEvent = parseKintaiChangeLog({
      changes: [{ date: '2026-06-01', recorded_at: 'x', before: [{ state: '始業' }, null, 'x'], after: [] }],
    })
    expect(withBadEvent.changes[0]!.before).toEqual([])
  })

  it('driver は数値でも文字列化する', () => {
    expect(parseKintaiChangeLog({ driver: 1078, changes: [] }).driver).toBe('1078')
  })

  it('before/after が配列でなければ空配列に倒す (欠落・型崩れ)', () => {
    const r = parseKintaiChangeLog({
      changes: [{ date: '2026-06-01', recorded_at: 'x' /* before/after 無し */ }],
    })
    expect(r.changes[0]).toEqual({ driverCd: null, date: '2026-06-01', recordedAt: 'x', before: [], after: [] })
  })

  it('event の source が無ければ空文字、unko_no は数値も文字列化しない (数値は toStringOrNull に無いので null)', () => {
    const r = parseKintaiChangeLog({
      changes: [{
        date: '2026-06-01',
        recorded_at: 'x',
        before: [{ occurred_at: 'a', state: '始業' }],
        after: [],
      }],
    })
    expect(r.changes[0]!.before[0]).toEqual({ occurredAt: 'a', state: '始業', source: '', unkoNo: null })
  })
})

// ---- parseAlcOperationChanges ----

describe('parseAlcOperationChanges', () => {
  const FULL_BEFORE = {
    driver_cd: '1194', departure_at: 'd1', return_at: 'r1',
    drive_minutes: 100, cargo_minutes: 50, break_minutes: 0, rest_minutes: 200,
  }
  const FULL_AFTER = {
    driver_cd: '1500', departure_at: 'd2', return_at: 'r2',
    drive_minutes: 90, cargo_minutes: 50, break_minutes: 178, rest_minutes: 200,
  }

  it('確定済みの形をそのまま camelCase に読み替える (reupload)', () => {
    const raw = {
      driver_cd: '1194',
      from: '2026-06-01',
      to: '2026-06-30',
      recording_since: '2026-09-25',
      changes: [
        {
          unko_no: '2606230341010000004219',
          crew_role: 1,
          recorded_at: '2026-06-24T01:00:00Z',
          reason: 'reupload',
          before: FULL_BEFORE,
          after: FULL_AFTER,
        },
      ],
    }
    const r = parseAlcOperationChanges(raw)
    expect(r.driverCd).toBe('1194')
    expect(r.recordingSince).toBe('2026-09-25')
    expect(r.changes).toHaveLength(1)
    const c = r.changes[0]!
    expect(c.unkoNo).toBe('2606230341010000004219')
    expect(c.crewRole).toBe(1)
    expect(c.reason).toBe('reupload')
    expect(c.before).toEqual({
      driverCd: '1194', departureAt: 'd1', returnAt: 'r1',
      driveMinutes: 100, cargoMinutes: 50, breakMinutes: 0, restMinutes: 200, kudgivtUnavailable: false,
    })
    expect(c.after).toEqual({
      driverCd: '1500', departureAt: 'd2', returnAt: 'r2',
      driveMinutes: 90, cargoMinutes: 50, breakMinutes: 178, restMinutes: 200, kudgivtUnavailable: false,
    })
  })

  it('手動削除は `after: null`', () => {
    const raw = {
      changes: [{ unko_no: 'x'.padEnd(22, '0'), crew_role: 2, recorded_at: 't', reason: 'manual_delete', before: FULL_BEFORE, after: null }],
    }
    const r = parseAlcOperationChanges(raw)
    expect(r.changes[0]!.reason).toBe('manual_delete')
    expect(r.changes[0]!.after).toBeNull()
  })

  it('`before_kudgivt: "unavailable"` は分数キーを null にし、フラグを立てる', () => {
    const raw = {
      changes: [{
        unko_no: 'x'.padEnd(22, '0'),
        crew_role: 1,
        recorded_at: 't',
        reason: 'reupload',
        before: { before_kudgivt: 'unavailable', driver_cd: '1697' },
        after: FULL_AFTER,
      }],
    }
    const before = parseAlcOperationChanges(raw).changes[0]!.before!
    expect(before.kudgivtUnavailable).toBe(true)
    expect(before.driveMinutes).toBeNull()
    expect(before.cargoMinutes).toBeNull()
    expect(before.breakMinutes).toBeNull()
    expect(before.restMinutes).toBeNull()
    expect(before.driverCd).toBe('1697')
  })

  it('壊れた reason は null に倒す', () => {
    const raw = { changes: [{ unko_no: 'x'.padEnd(22, '0'), recorded_at: 't', reason: 'something-else', before: null, after: null }] }
    expect(parseAlcOperationChanges(raw).changes[0]!.reason).toBeNull()
  })

  it('壊れた形は空に倒す', () => {
    expect(parseAlcOperationChanges(null)).toEqual({ driverCd: null, from: null, to: null, recordingSince: null, changes: [] })
    expect(parseAlcOperationChanges({ changes: [{ unko_no: 1 }, null, 'x'] }).changes).toEqual([])
    expect(parseAlcOperationChanges({ driver_cd: 1194, changes: [] }).driverCd).toBe('1194')
  })

  it('snapshot の driver_cd が数値でも文字列化する', () => {
    const raw = { changes: [{ unko_no: 'x'.padEnd(22, '0'), recorded_at: 't', before: { driver_cd: 1194 }, after: null }] }
    expect(parseAlcOperationChanges(raw).changes[0]!.before!.driverCd).toBe('1194')
  })

  it('snapshot に driver_cd が無ければ null', () => {
    const raw = { changes: [{ unko_no: 'x'.padEnd(22, '0'), recorded_at: 't', before: { drive_minutes: 5 }, after: null }] }
    expect(parseAlcOperationChanges(raw).changes[0]!.before!.driverCd).toBeNull()
  })

  it('crew_role が壊れていれば null、before/after が非オブジェクトなら null', () => {
    const raw = { changes: [{ unko_no: 'x'.padEnd(22, '0'), crew_role: 'bad', recorded_at: 't', before: 'x', after: 1 }] }
    const c = parseAlcOperationChanges(raw).changes[0]!
    expect(c.crewRole).toBeNull()
    expect(c.before).toBeNull()
    expect(c.after).toBeNull()
  })
})

// ---- kintaiChangeSummary ----

function kintaiEntry(over: Partial<Pick<KintaiChangeLogEntry, 'before' | 'after'>>): Pick<KintaiChangeLogEntry, 'before' | 'after'> {
  return { before: [], after: [], ...over }
}

describe('kintaiChangeSummary — 打刻の要約は「変わったものだけ」', () => {
  it('★ 始業の変更', () => {
    const s = kintaiChangeSummary(kintaiEntry({
      before: [{ occurredAt: '2026-06-05T23:00:00Z', state: '始業', source: 'timecard', unkoNo: null }], // JST 08:00
      after: [{ occurredAt: '2026-06-05T22:30:00Z', state: '始業', source: 'timecard', unkoNo: null }], // JST 07:30
    }))
    expect(s).toBe('始業 08:00 → 07:30')
  })

  it('変わらなかった state は列に出ない', () => {
    const s = kintaiChangeSummary(kintaiEntry({
      before: [
        { occurredAt: '2026-06-05T23:00:00Z', state: '始業', source: 't', unkoNo: null },
        { occurredAt: '2026-06-05T09:10:00Z', state: '運行終了', source: 'd', unkoNo: 'x' }, // JST 18:10
      ],
      after: [
        { occurredAt: '2026-06-05T22:30:00Z', state: '始業', source: 't', unkoNo: null },
        { occurredAt: '2026-06-05T09:10:00Z', state: '運行終了', source: 'd', unkoNo: 'x' },
      ],
    }))
    expect(s).toBe('始業 08:00 → 07:30')
  })

  it('★ 日ごと消えた (after が丸ごと null) — before の全 state が「→ (消えた)」', () => {
    const s = kintaiChangeSummary(kintaiEntry({
      before: [{ occurredAt: '2026-06-05T09:10:00Z', state: '運行終了', source: 'd', unkoNo: 'x' }],
      after: null,
    }))
    expect(s).toBe('運行終了 18:10 → (消えた)')
  })

  it('新しく増えた state は「(無かった) → 時刻」', () => {
    const s = kintaiChangeSummary(kintaiEntry({
      before: [],
      after: [{ occurredAt: '2026-06-05T22:30:00Z', state: '始業', source: 't', unkoNo: null }],
    }))
    expect(s).toBe('始業 (無かった) → 07:30')
  })

  it('何も無ければ「変化なし」、after null で before も空なら「日ごと消えた (記録なし)」', () => {
    expect(kintaiChangeSummary(kintaiEntry({}))).toBe('変化なし')
    expect(kintaiChangeSummary(kintaiEntry({ before: [], after: null }))).toBe('日ごと消えた (記録なし)')
  })

  it('occurredAt が壊れていれば時刻は「不明」', () => {
    const s = kintaiChangeSummary(kintaiEntry({
      before: [{ occurredAt: 'not-a-date', state: '始業', source: 't', unkoNo: null }],
      after: [{ occurredAt: '2026-06-05T22:30:00Z', state: '始業', source: 't', unkoNo: null }],
    }))
    expect(s).toBe('始業 不明 → 07:30')
  })

  it('同じ state が複数あれば時刻を `/` で並べて比較する', () => {
    const s = kintaiChangeSummary(kintaiEntry({
      before: [
        { occurredAt: '2026-06-05T03:00:00Z', state: '休息', source: 'd', unkoNo: 'x' }, // 12:00
        { occurredAt: '2026-06-05T05:00:00Z', state: '休息', source: 'd', unkoNo: 'x' }, // 14:00
      ],
      after: [
        { occurredAt: '2026-06-05T05:00:00Z', state: '休息', source: 'd', unkoNo: 'x' }, // 14:00
      ],
    }))
    expect(s).toBe('休息 12:00/14:00 → 14:00')
  })
})

// ---- alcChangeSummary ----

function alcSnapshot(over: Partial<AlcOperationSnapshot> = {}): AlcOperationSnapshot {
  return {
    driverCd: '1194', departureAt: 'd', returnAt: 'r',
    driveMinutes: 100, cargoMinutes: 50, breakMinutes: 0, restMinutes: 200,
    kudgivtUnavailable: false,
    ...over,
  }
}

function alcEntry(over: Partial<Pick<AlcOperationChangeEntry, 'reason' | 'before' | 'after'>>): Pick<AlcOperationChangeEntry, 'reason' | 'before' | 'after'> {
  return { reason: 'reupload', before: alcSnapshot(), after: alcSnapshot(), ...over }
}

describe('alcChangeSummary — 運行の要約は「変わったものだけ」', () => {
  it('★ 休憩変化', () => {
    const s = alcChangeSummary(alcEntry({
      before: alcSnapshot({ breakMinutes: 0 }),
      after: alcSnapshot({ breakMinutes: 178 }),
    }))
    expect(s).toBe('休憩 0 → 178 分')
  })

  it('★ 乗務員付け替え', () => {
    const s = alcChangeSummary(alcEntry({
      before: alcSnapshot({ driverCd: '1194' }),
      after: alcSnapshot({ driverCd: '1500' }),
    }))
    expect(s).toBe('乗務員 1194 → 1500')
  })

  it('乗務員CDが片側だけ不明 (null) でも「不明」と出す (before/after それぞれ)', () => {
    expect(alcChangeSummary(alcEntry({
      before: alcSnapshot({ driverCd: null }),
      after: alcSnapshot({ driverCd: '1500' }),
    }))).toBe('乗務員 不明 → 1500')
    expect(alcChangeSummary(alcEntry({
      before: alcSnapshot({ driverCd: '1194' }),
      after: alcSnapshot({ driverCd: null }),
    }))).toBe('乗務員 1194 → 不明')
  })

  it('★ 手動削除 (reason=manual_delete)', () => {
    expect(alcChangeSummary(alcEntry({ reason: 'manual_delete', after: null }))).toBe('手動削除')
  })

  it('★ after が null なら reason が manual_delete でなくても手動削除扱い', () => {
    expect(alcChangeSummary(alcEntry({ reason: null, after: null }))).toBe('手動削除')
  })

  it('★ before_kudgivt unavailable のときは分数を比較せず明示する', () => {
    const s = alcChangeSummary(alcEntry({
      before: alcSnapshot({ kudgivtUnavailable: true, breakMinutes: null, restMinutes: null, driveMinutes: null, cargoMinutes: null }),
      after: alcSnapshot({ breakMinutes: 178 }),
    }))
    expect(s).toBe('前回の休憩・休息は記録なし')
  })

  it('unavailable でも乗務員の付け替えは比較できる (分数だけ止める)', () => {
    const s = alcChangeSummary(alcEntry({
      before: alcSnapshot({ kudgivtUnavailable: true, driverCd: '1194', breakMinutes: null, restMinutes: null, driveMinutes: null, cargoMinutes: null }),
      after: alcSnapshot({ driverCd: '1500' }),
    }))
    expect(s).toBe('前回の休憩・休息は記録なし / 乗務員 1194 → 1500')
  })

  it('複数の分数が同時に変われば `/` で並ぶ (運転・荷役・休息も対象)', () => {
    const s = alcChangeSummary(alcEntry({
      before: alcSnapshot({ driveMinutes: 100, cargoMinutes: 50, restMinutes: 200 }),
      after: alcSnapshot({ driveMinutes: 90, cargoMinutes: 40, restMinutes: 210 }),
    }))
    expect(s).toBe('休息 200 → 210 分 / 運転 100 → 90 分 / 荷役 50 → 40 分')
  })

  it('値が不明 (null) なら「不明」と出す', () => {
    const s = alcChangeSummary(alcEntry({
      before: alcSnapshot({ breakMinutes: null }),
      after: alcSnapshot({ breakMinutes: 178 }),
    }))
    expect(s).toBe('休憩 不明 → 178 分')
  })

  it('before/after のどちらかが無ければ (壊れた応答) 比較せず「変化なし」', () => {
    expect(alcChangeSummary(alcEntry({ before: null, after: alcSnapshot() }))).toBe('変化なし')
    expect(alcChangeSummary(alcEntry({ before: alcSnapshot(), after: null, reason: 'reupload' }))).toBe('手動削除')
  })

  it('何も変わっていなければ「変化なし」', () => {
    expect(alcChangeSummary(alcEntry({}))).toBe('変化なし')
  })
})

// ---- rows / merge / csv ----

describe('buildKintaiChangeRows / buildAlcChangeRows / mergeLitigationChangeRows', () => {
  it('打刻の行 (target=日付、reason=空)', () => {
    const rows = buildKintaiChangeRows([{
      driverCd: '1078',
      date: '2026-06-05',
      recordedAt: '2026-06-06T01:00:00Z', // JST 10:00
      before: [{ occurredAt: '2026-06-05T23:00:00Z', state: '始業', source: 't', unkoNo: null }],
      after: [{ occurredAt: '2026-06-05T22:30:00Z', state: '始業', source: 't', unkoNo: null }],
    }])
    expect(rows).toEqual([{
      recordedAt: '2026-06-06 10:00',
      recordedAtSort: '2026-06-06T01:00:00Z',
      kind: '打刻',
      target: '2026-06-05',
      summary: '始業 08:00 → 07:30',
      reason: '',
    }])
  })

  it('運行の行 (target=運行NO+乗務区分、reason=ラベル)', () => {
    const rows = buildAlcChangeRows([{
      unkoNo: '2606230341010000004219',
      crewRole: 2,
      recordedAt: '2026-06-24T01:00:00Z', // JST 10:00
      reason: 'reupload',
      before: alcSnapshot({ breakMinutes: 0 }),
      after: alcSnapshot({ breakMinutes: 178 }),
    }])
    expect(rows).toEqual([{
      recordedAt: '2026-06-24 10:00',
      recordedAtSort: '2026-06-24T01:00:00Z',
      kind: '運行',
      target: '2606230341010000004219 (助手)',
      summary: '休憩 0 → 178 分',
      reason: '上げ直し',
    }])
  })

  it('crewRole 1=主、null/その他は不明・区分N', () => {
    const row = (crewRole: number | null) => buildAlcChangeRows([{
      unkoNo: 'x'.padEnd(22, '0'), crewRole, recordedAt: 't', reason: null,
      before: null, after: null,
    }])[0]!.target
    expect(row(1)).toBe('x'.padEnd(22, '0') + ' (主)')
    expect(row(null)).toBe('x'.padEnd(22, '0') + ' (不明)')
    expect(row(3)).toBe('x'.padEnd(22, '0') + ' (区分3)')
  })

  it('reason が null なら行の reason は空文字', () => {
    const rows = buildAlcChangeRows([{
      unkoNo: 'x'.padEnd(22, '0'), crewRole: 1, recordedAt: 't', reason: null, before: null, after: null,
    }])
    expect(rows[0]!.reason).toBe('')
  })

  it('recordedAt が壊れていれば表示もそのまま (fmtJstDateTime のフォールバック)', () => {
    const rows = buildKintaiChangeRows([{
      driverCd: null, date: '2026-06-05', recordedAt: 'not-a-date', before: [], after: [],
    }])
    expect(rows[0]!.recordedAt).toBe('not-a-date')
  })

  it('mergeLitigationChangeRows は記録時刻の新しい順', () => {
    const older: LitigationChangeRow = { recordedAt: 'a', recordedAtSort: '2026-06-01T00:00:00Z', kind: '打刻', target: 't1', summary: 's1', reason: '' }
    const newer: LitigationChangeRow = { recordedAt: 'b', recordedAtSort: '2026-06-10T00:00:00Z', kind: '運行', target: 't2', summary: 's2', reason: '上げ直し' }
    expect(mergeLitigationChangeRows([older], [newer])).toEqual([newer, older])
  })
})

// ---- 記録開始日の文言 ----

describe('kintaiRecordingSinceNotice / alcRecordingSinceNotice', () => {
  it('recordingSince があれば日付を含む文言', () => {
    expect(kintaiRecordingSinceNotice('2026-09-25')).toContain('2026-09-25 から')
    expect(alcRecordingSinceNotice('2026-10-01')).toContain('2026-10-01 から')
  })

  it('★ recordingSince が null なら「まだ1件も記録されていない」', () => {
    expect(kintaiRecordingSinceNotice(null)).toContain('まだ')
    expect(kintaiRecordingSinceNotice(null)).toContain('2026-09-25')
    expect(alcRecordingSinceNotice(null)).toContain('まだ')
  })
})

// ---- CSV ----

describe('litigationChangesCsv', () => {
  it('BOM 付き・ヘッダ・エスケープ', () => {
    const rows: LitigationChangeRow[] = [
      { recordedAt: '2026-06-06 10:00', recordedAtSort: '', kind: '打刻', target: '2026-06-05', summary: '始業 08:00 → 07:30', reason: '' },
      { recordedAt: '2026-06-24 10:00', recordedAtSort: '', kind: '運行', target: 'x, y', summary: '手動削除', reason: ALC_REASON_LABEL.manual_delete },
    ]
    const csv = litigationChangesCsv(rows)
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.replace(/^﻿/, '').trim().split('\n')
    expect(lines[0]).toBe('記録日時,種別,対象,内容,理由')
    expect(lines[1]).toBe('2026-06-06 10:00,打刻,2026-06-05,始業 08:00 → 07:30,')
    expect(lines[2]).toBe('2026-06-24 10:00,運行,"x, y",手動削除,手動削除')
  })

  it('★ 両方空 (行が無い) は空表として通る (「異常」ではない)', () => {
    const csv = litigationChangesCsv([])
    expect(csv).toBe('﻿記録日時,種別,対象,内容,理由\n')
  })

  it('notices は空行のあとに別の表として続く', () => {
    const csv = litigationChangesCsv([], ['打刻の変更記録は 2026-09-25 から。', 'この会社の打刻の変更記録は読めません。'])
    expect(csv).toBe(
      '﻿記録日時,種別,対象,内容,理由\n\n備考\n打刻の変更記録は 2026-09-25 から。\nこの会社の打刻の変更記録は読めません。\n',
    )
  })
})
