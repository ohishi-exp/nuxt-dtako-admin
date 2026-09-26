/**
 * 訴訟準備の「エラー」タブの pure ロジック (`app/utils/litigation-errors.ts`、Refs #1133 c1133-5)。
 *
 * - 検知 4 列それぞれで **異常あり / 異常なし / 判定できない / 未実行** を出し分けること。
 *   特に「取れなかった」を「0 件 = 異常なし」と同じ見た目にしない (map skill「PR の基準」(7))
 * - 乗務員 × 月へ畳む・CSV (BOM・エスケープ)・取り込みの応答の分類
 */
import { describe, it, expect } from 'vitest'
import {
  alcOpsCell,
  buildLitigationErrorRows,
  classifyLitigationImport,
  countLitigationErrorCells,
  foldYTimeDaysByMonth,
  foldYTimeDroppedByMonth,
  invariantsCell,
  litigationAlcOpsFailure,
  litigationChunkMonths,
  litigationChunkWarnings,
  litigationDriverMonthKey,
  litigationErrorsCsv,
  litigationImportRanges,
  litigationMonthBounds,
  litigationRowNeedsAttention,
  unkoGapsCell,
  yTimeCell,
  type LitigationAlcOpsEntry,
  type LitigationErrorInput,
  type LitigationFetched,
} from '~/utils/litigation-errors'
import type { LitigationOutputChunk, LitigationOutputResult } from '~/utils/litigation-output'
import { parseKintaiUnkoGaps, type KintaiUnkoGaps } from '~/utils/kintai-unko-gaps'
import type { WageInvariantCheck, WageReportResponse, WageReportRow } from '~/utils/restraint-wage-view'

function result(over: Partial<LitigationOutputResult> = {}): LitigationOutputResult {
  return {
    driverCd: '1078',
    from: '2025-01-01',
    to: '2025-03-31',
    status: 'ok',
    rows: 40,
    missingDates: [],
    missingCount: 0,
    warnings: [],
    warningsCount: 0,
    message: '40 行',
    ...over,
  }
}

function gaps(raw: Record<string, unknown>): LitigationFetched<KintaiUnkoGaps> {
  return {
    ok: true,
    value: parseKintaiUnkoGaps({ gcp_etags_available: true, driver_cds_available: true, drivers: [], ...raw }),
  }
}

const OK_INV: WageInvariantCheck = {
  hourlyBasis: 'working',
  unaccounted: { diffMinutes: 0, kind: 'other' },
  workingWithinRestraint: true,
  noShiftOverlap: true,
  shiftOverlap: null,
}

function wageRow(driverCd: string, over: Partial<WageReportRow> = {}): WageReportRow {
  return {
    summary: { driverCd } as WageReportRow['summary'],
    fetched_at: null,
    last_verified_at: null,
    wage: {} as WageReportRow['wage'],
    invariants: OK_INV,
    ...over,
  }
}

function report(rows: WageReportRow[], over: Partial<WageReportResponse> = {}): LitigationFetched<WageReportResponse> {
  return {
    ok: true,
    value: { month: '2025-01', rows, no_data_drivers: [], warnings: [], restraint_source: 'gcp', ...over },
  }
}

describe('月の小道具', () => {
  it('litigationMonthBounds は初日と末日 (うるう年の 2 月も)', () => {
    expect(litigationMonthBounds('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(litigationMonthBounds('2025-12')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('litigationChunkMonths は区切りの月を古い順に並べる (年をまたぐ)', () => {
    expect(litigationChunkMonths({ from: '2024-11-01', to: '2025-02-28' })).toEqual(['2024-11', '2024-12', '2025-01', '2025-02'])
  })

  it('litigationDriverMonthKey', () => {
    expect(litigationDriverMonthKey('1078', '2025-01')).toBe('1078|2025-01')
  })

  it('foldYTimeDaysByMonth は月ごとの日数。0 日の月もキーを持ち、区切りの外の日は数えない', () => {
    const rows = [{ date: '2025-01-03' }, { date: '2025-01-04' }, { date: '2025-03-01' }, { date: '2024-12-31' }]
    expect(foldYTimeDaysByMonth(rows, ['2025-01', '2025-02', '2025-03'])).toEqual({ '2025-01': 2, '2025-02': 0, '2025-03': 1 })
  })
})

describe('alcOpsCell (alc の運行)', () => {
  it('★ 0 日は異常あり、1 日以上は異常なし', () => {
    expect(alcOpsCell({ ok: true, days: 0, dropped: [] }, null)).toEqual({ state: 'ng', message: 'alc に運行が 0 件 (Y時間の勤務日 0 日)' })
    expect(alcOpsCell({ ok: true, days: 12, dropped: [] }, null)).toEqual({ state: 'ok', message: '勤務日 12 日' })
  })

  it('★ 取れなかったときは 0 件と言わず判定できない (理由つき)', () => {
    expect(alcOpsCell(litigationAlcOpsFailure(500, '500 失敗しました'), null)).toEqual({ state: 'unknown', message: '500 失敗しました' })
    expect(alcOpsCell(litigationAlcOpsFailure(null, 'サーバに接続できませんでした'), null).state).toBe('unknown')
  })

  it('404 は乗務員CD が alc に未登録 — 数えられないので判定できない', () => {
    const entry = litigationAlcOpsFailure(404, '404 …')
    expect(entry).toEqual({ ok: false, notFound: true, reason: '404 …' })
    expect(alcOpsCell(entry, null)).toEqual({ state: 'unknown', message: '乗務員CD が alc に未登録 (404) — 運行を数えられない' })
  })

  it('月単位を読む前でも、出力タブで冊ごと 0 件なら異常あり', () => {
    expect(alcOpsCell(undefined, result({ status: 'empty', rows: 0 }))).toEqual({ state: 'ng', message: 'この冊の期間の運行が 0 件 (出力タブの結果)' })
  })

  it('何も読んでいなければ未実行 (出力タブが ok でも月単位は分からない)', () => {
    expect(alcOpsCell(undefined, null).state).toBe('pending')
    expect(alcOpsCell(undefined, result()).state).toBe('pending')
  })

  it('月単位の結果は出力タブの結果より優先する', () => {
    expect(alcOpsCell({ ok: true, days: 3, dropped: [] }, result({ status: 'empty', rows: 0 })).state).toBe('ok')
  })
})

describe('foldYTimeDroppedByMonth (プレビューの警告から Y時間に入らなかった運行を拾う)', () => {
  it('出庫/帰庫不足と KUDGIVT 取得失敗だけを、運行NO の年月で月に振り分ける', () => {
    const out = foldYTimeDroppedByMonth([
      '2501050000000000001234: departure_at/return_at が不足、skip',
      '25020600000000000012341: KUDGIVT 取得失敗 (Upload failed: R2 download status 404)',
      // 1 行にまとめただけ — 欠けではないので拾わない (陰性対照)
      '2025-01-07: 複数 segment 結合 (1 行に集約: 最早始業 / 最遅終業 / 休憩合計)',
      // 区切りの外の月は捨てる
      '2412310000000000001234: departure_at/return_at が不足、skip',
    ], ['2025-01', '2025-02'])
    expect(out).toEqual({
      '2025-01': [{ unkoNo: '2501050000000000001234', reason: '出庫/帰庫が無い' }],
      '2025-02': [{ unkoNo: '25020600000000000012341', reason: '運行の中身 (KUDGIVT) が取れない' }],
    })
  })
})

describe('yTimeCell (Y時間の欠け)', () => {
  it('検知も ZIP も未実行なら未実行', () => {
    expect(yTimeCell('2025-01', null)).toEqual({ state: 'pending', message: '未実行 — 「検知を実行」で調べます' })
  })

  it('★ ZIP を作らなくても、検知のプレビューから判定する (Y時間に入らなかった運行が無ければ異常なし)', () => {
    expect(yTimeCell('2025-01', null, { ok: true, days: 20, dropped: [] })).toEqual({ state: 'ok', message: '欠けなし' })
  })

  it('★ プレビューで Y時間に入らなかった運行があれば異常あり (3 件まで並べる)', () => {
    const dropped = [
      { unkoNo: '2501050000000000001234', reason: '出庫/帰庫が無い' },
      { unkoNo: '2501060000000000001234', reason: '運行の中身 (KUDGIVT) が取れない' },
      { unkoNo: '2501070000000000001234', reason: '出庫/帰庫が無い' },
      { unkoNo: '2501080000000000001234', reason: '出庫/帰庫が無い' },
    ]
    expect(yTimeCell('2025-01', null, { ok: true, days: 20, dropped })).toEqual({
      state: 'ng',
      message: 'Y時間に入らなかった運行 4 件: 2501050000000000001234 (出庫/帰庫が無い), 2501060000000000001234 (運行の中身 (KUDGIVT) が取れない), 2501070000000000001234 (出庫/帰庫が無い) ほか',
    })
  })

  it('プレビューが 404 (乗務員CD が alc に未登録) なら異常あり、他の失敗は判定できない', () => {
    expect(yTimeCell('2025-01', null, { ok: false, notFound: true, reason: '404' }).state).toBe('ng')
    expect(yTimeCell('2025-01', null, { ok: false, notFound: false, reason: '502 …' })).toEqual({ state: 'unknown', message: '502 …' })
  })

  it('★ ZIP 側の異常 (テンプレに書けなかった日) はプレビューが異常なしでも出す / 両方異常なしなら ZIP 側の文言', () => {
    const clean = { ok: true as const, days: 20, dropped: [] }
    expect(yTimeCell('2025-02', result({ missingDates: ['2025-02-03'], missingCount: 1 }), clean).state).toBe('ng')
    expect(yTimeCell('2025-01', result({}), clean)).toEqual({ state: 'ok', message: '書けなかった日なし' })
  })

  it('運行 0 件の月は、欠けなしだが alc の運行の列を見るよう添える', () => {
    expect(yTimeCell('2025-01', null, { ok: true, days: 0, dropped: [] }).message).toContain('「alc の運行」の列を見てください')
  })

  it('失敗は判定できない (出力タブの理由をそのまま)', () => {
    expect(yTimeCell('2025-01', result({ status: 'error', message: '500 …' }))).toEqual({ state: 'unknown', message: '500 …' })
  })

  it('alc に未登録 (404) は異常あり', () => {
    expect(yTimeCell('2025-01', result({ status: 'not_found' })).state).toBe('ng')
  })

  it('★ 書けなかった日はその月の行にだけ出す', () => {
    const r = result({ missingDates: ['2025-01-05', '2025-02-10'], missingCount: 2 })
    expect(yTimeCell('2025-01', r)).toEqual({ state: 'ng', message: 'テンプレに行が無く書けなかった日: 2025-01-05' })
    expect(yTimeCell('2025-03', r)).toEqual({ state: 'ok', message: '書けなかった日なし' })
  })

  it('★ 一覧が切り詰められていて、この月の日が入らなかったら「無い」と言わない', () => {
    const r = result({ missingDates: ['2025-01-05'], missingCount: 31 })
    expect(yTimeCell('2025-03', r)).toEqual({
      state: 'unknown',
      message: 'この冊で書けなかった日が 31 日あり、一覧 (先頭 1 日) にこの月の日が入らなかった',
    })
  })

  it('運行 0 件の冊は欠けなしだが、alc の運行の列を見るよう添える', () => {
    expect(yTimeCell('2025-01', result({ status: 'empty', rows: 0 })).message).toContain('「alc の運行」の列を見てください')
  })
})

describe('unkoGapsCell (alc にあって勤怠に無い運行)', () => {
  it('未実行 / 取れなかった', () => {
    expect(unkoGapsCell('1078', undefined).state).toBe('pending')
    expect(unkoGapsCell('1078', { ok: false, reason: '502 …' })).toEqual({ state: 'unknown', message: '502 …' })
  })

  it('★ gcp_etags_available / driver_cds_available が false なら 0 件と言わず判定できない', () => {
    expect(unkoGapsCell('1078', gaps({ gcp_etags_available: false })).message).toBe('GCP 側の運行一覧が引けていない — 0 件とは言えない')
    expect(unkoGapsCell('1078', gaps({ driver_cds_available: false })).message).toBe('alc が乗務員CD を返していない — 0 件とは言えない')
    expect(unkoGapsCell('1078', gaps({ driver_cds_available: false })).state).toBe('unknown')
  })

  it('その乗務員に勤怠に無い運行があれば異常あり (3 件まで並べる、切り詰めは「以上」)', () => {
    const g = gaps({ drivers: [{ driver_cd: '1078', unko_nos: ['a', 'b', 'c', 'd'], truncated: true }] })
    expect(unkoGapsCell('1078', g)).toEqual({ state: 'ng', message: '勤怠に無い運行 4 件以上: a, b, c ほか' })
    const g2 = gaps({ drivers: [{ driver_cd: 1078, unko_nos: ['a'] }] })
    expect(unkoGapsCell('1078', g2)).toEqual({ state: 'ng', message: '勤怠に無い運行 1 件: a' })
  })

  it('他の乗務員の分だけなら異常なし。乗務員不明の運行は判定に入らないと添える', () => {
    const g = gaps({ drivers: [{ driver_cd: '9999', unko_nos: ['x'] }, { driver_cd: '1078', unko_nos: [] }] })
    expect(unkoGapsCell('1078', g)).toEqual({ state: 'ok', message: '勤怠に無い運行なし' })
    const g2 = gaps({ unknown_driver_unko_nos: ['y', 'z'] })
    expect(unkoGapsCell('1078', g2)).toEqual({ state: 'ok', message: '勤怠に無い運行なし (乗務員が分からない運行 2 件はこの判定に入らない)' })
  })

  it('★ 勤怠側にこの乗務員の運行が 0 件の月は、alc の運行が全部並んでも異常ありにせず照合先なし', () => {
    const g = gaps({ driver_cd: 1590, onprem_operations_in_month: 0, drivers: [{ driver_cd: '1590', unko_nos: ['a', 'b'] }] })
    expect(unkoGapsCell('1590', g)).toEqual({
      state: 'noBaseline',
      message: 'この月は勤怠から運んだこの乗務員の運行が 0 件で、alc の運行と突き合わせる相手が無い',
    })
  })

  it('陰性対照: 勤怠側に 1 件以上あれば従来どおり異常あり / 件数が無い (旧 rust) も従来どおり', () => {
    const drivers = [{ driver_cd: '1078', unko_nos: ['a'] }]
    expect(unkoGapsCell('1078', gaps({ onprem_operations_in_month: 3, drivers })).state).toBe('ng')
    expect(unkoGapsCell('1078', gaps({ drivers })).state).toBe('ng')
  })

  it('★ 照合先なしでも、GCP 側の運行一覧が引けていなければ判定できないが優先', () => {
    expect(unkoGapsCell('1590', gaps({ onprem_operations_in_month: 0, gcp_etags_available: false })).state).toBe('unknown')
  })

  it('乗務員の一覧が切れていてこの乗務員が居なければ判定できない', () => {
    expect(unkoGapsCell('1078', gaps({ drivers_truncated: true })).state).toBe('unknown')
  })
})

describe('invariantsCell (最低賃金の不変条件)', () => {
  it('未実行 / 取れなかった', () => {
    expect(invariantsCell('1078', undefined).state).toBe('pending')
    expect(invariantsCell('1078', { ok: false, reason: '504 …' })).toEqual({ state: 'unknown', message: '504 …' })
  })

  it('GCP でない応答は判定できない (invariants は GCP のときだけ付く)', () => {
    expect(invariantsCell('1078', report([wageRow('1078')], { restraint_source: 'current' })).state).toBe('unknown')
  })

  it('行が無い: データ無しの乗務員 / そもそも行が無い を言い分ける', () => {
    expect(invariantsCell('1078', report([], { no_data_drivers: ['1078'] })).message).toBe('この月の賃金計算にデータが無い')
    expect(invariantsCell('1078', report([wageRow('2000')])).message).toBe('この月の賃金計算にこの乗務員の行が無い')
  })

  it('GCP の拘束が欠測なら判定できない', () => {
    expect(invariantsCell('1078', report([wageRow('1078', { restraint_missing: true })])).state).toBe('unknown')
  })

  it('★ 条件1〜3 を満たせば異常なし', () => {
    expect(invariantsCell('1078', report([wageRow('1078')]))).toEqual({ state: 'ok', message: '条件1〜3 すべて満たす' })
  })

  it('★ 崩れた条件を並べる (条件1 の符号、条件3 の時間帯)', () => {
    const inv: WageInvariantCheck = {
      ...OK_INV,
      unaccounted: { diffMinutes: 30, kind: 'clamp' },
      workingWithinRestraint: false,
      noShiftOverlap: false,
      shiftOverlap: { start: '2025-01-05 22:00', end: '2025-01-06 03:00', count: 1 },
    }
    expect(invariantsCell('1078', report([wageRow('1078', { invariants: inv })])).message)
      .toBe('条件1 実働−表区分合計 +30 分 / 条件2 実働が拘束を超える / 条件3 勤務の時間帯が重なる (1/5 22:00〜1/6 03:00)')
    const neg: WageInvariantCheck = { ...OK_INV, unaccounted: { diffMinutes: -5, kind: 'other' } }
    expect(invariantsCell('1078', report([wageRow('1078', { invariants: neg })])).message).toBe('条件1 実働−表区分合計 -5 分')
  })

  it('条件1 が判定不能でも条件3 が崩れていれば異常あり (重なりの時間帯が無くても文が崩れない)', () => {
    const inv: WageInvariantCheck = { ...OK_INV, unaccounted: null, noShiftOverlap: false, shiftOverlap: null }
    expect(invariantsCell('1078', report([wageRow('1078', { invariants: inv })]))).toEqual({ state: 'ng', message: '条件3 勤務の時間帯が重なる' })
  })

  it('どれかが判定不能 (invariants 自体が無い古い relay も) なら判定できない', () => {
    expect(invariantsCell('1078', report([wageRow('1078', { invariants: undefined })])).state).toBe('unknown')
    expect(invariantsCell('1078', report([wageRow('1078', { invariants: { ...OK_INV, noShiftOverlap: null } })])).state).toBe('unknown')
  })
})

describe('buildLitigationErrorRows / 件数 / CSV', () => {
  const chunks: LitigationOutputChunk[] = [
    { driverCd: '1078', from: '2025-01-01', to: '2025-02-28', label: '2025-01〜2025-02', filename: 'a.xlsx' },
    { driverCd: '2000', from: '2025-01-01', to: '2025-02-28', label: '2025-01〜2025-02', filename: 'b.xlsx' },
  ]

  function input(over: Partial<LitigationErrorInput> = {}): LitigationErrorInput {
    return {
      driverCds: ['1078', '2000'],
      months: ['2025-01', '2025-02'],
      chunks,
      results: [],
      alcOps: new Map(),
      unkoGaps: new Map(),
      wageReports: new Map(),
      ...over,
    }
  }

  it('★ 何も読んでいなければ全セル未実行 (0 件と同じ見た目にしない)', () => {
    const rows = buildLitigationErrorRows(input())
    expect(rows.map(r => `${r.driverCd}|${r.month}`)).toEqual(['1078|2025-01', '1078|2025-02', '2000|2025-01', '2000|2025-02'])
    const counts = countLitigationErrorCells(rows)
    expect(counts.alcOps).toEqual({ ng: 0, ok: 0, unknown: 0, pending: 4, noBaseline: 0 })
    expect(counts.invariants.pending).toBe(4)
    expect(rows.some(litigationRowNeedsAttention)).toBe(false)
    expect(rows.every(r => !r.canImport)).toBe(true)
  })

  it('★ 照合先なしは異常と数えない (印刷の「異常あり・判定できない行だけ」に入らない)', () => {
    const [row] = buildLitigationErrorRows(input())
    const cells = { ...row!.cells, unkoGaps: { state: 'noBaseline' as const, message: '' } }
    expect(litigationRowNeedsAttention({ ...row!, cells })).toBe(false)
    expect(litigationRowNeedsAttention({ ...row!, cells: { ...cells, yTime: { state: 'ng' as const, message: '' } } })).toBe(true)
  })

  it('乗務員 × 月の素材を正しい行に配り、alc 0 件の行だけ取り込みボタンを出す', () => {
    const alcOps = new Map<string, LitigationAlcOpsEntry>([
      ['1078|2025-01', { ok: true, days: 0, dropped: [] }],
      ['1078|2025-02', { ok: true, days: 20, dropped: [] }],
    ])
    const rows = buildLitigationErrorRows(input({
      results: [result({ missingDates: ['2025-02-03'], missingCount: 1 }), null],
      alcOps,
      unkoGaps: new Map([['2000|2025-02', gaps({ drivers: [{ driver_cd: '2000', unko_nos: ['u1'] }] })]]),
      wageReports: new Map([['2025-01', report([wageRow('1078'), wageRow('2000', { restraint_missing: true })])]]),
    }))
    const at = (d: string, m: string) => rows.find(r => r.driverCd === d && r.month === m)!
    expect(at('1078', '2025-01').canImport).toBe(true)
    expect(at('1078', '2025-01').cells.alcOps.state).toBe('ng')
    expect(at('1078', '2025-02').canImport).toBe(false)
    expect(at('1078', '2025-02').cells.yTime.state).toBe('ng')
    expect(at('1078', '2025-01').cells.yTime.state).toBe('ok')
    // 2000 の区切りは結果が null (未実行)
    expect(at('2000', '2025-01').cells.yTime.state).toBe('pending')
    expect(at('2000', '2025-02').cells.unkoGaps.state).toBe('ng')
    expect(at('1078', '2025-01').cells.invariants.state).toBe('ok')
    expect(at('2000', '2025-01').cells.invariants.state).toBe('unknown')
    expect(at('2000', '2025-02').cells.invariants.state).toBe('pending')
    expect(litigationRowNeedsAttention(at('1078', '2025-01'))).toBe(true)
    expect(litigationRowNeedsAttention(at('2000', '2025-01'))).toBe(true)
  })

  it('区切りに入らない月 (案件の外) は出力タブの結果を拾わない', () => {
    const rows = buildLitigationErrorRows(input({ months: ['2025-03'], results: [result({ status: 'empty', rows: 0 }), null] }))
    expect(rows[0]!.cells.alcOps.state).toBe('pending')
    expect(rows[0]!.cells.yTime.state).toBe('pending')
  })

  it('冊単位の警告は警告のある冊だけ拾う', () => {
    const w = litigationChunkWarnings(chunks, [result({ warnings: ['w1'], warningsCount: 7 }), result()])
    expect(w).toEqual([{ driverCd: '1078', label: '2025-01〜2025-02', warnings: ['w1'], warningsCount: 7 }])
    expect(litigationChunkWarnings(chunks, [])).toEqual([])
  })

  it('★ CSV は BOM 付き・判定と内容の 2 列ずつ・カンマや引用符をエスケープする', () => {
    const rows = buildLitigationErrorRows(input({
      driverCds: ['1078'],
      months: ['2025-01'],
      unkoGaps: new Map([['1078|2025-01', { ok: false, reason: '失敗, "理由"' }]]),
    }))
    const csv = litigationErrorsCsv(rows, cd => (cd === '1078' ? '山田 太郎' : cd), [])
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).trimEnd().split('\n')
    expect(lines[0]).toBe('乗務員CD,氏名,月,alc の運行 判定,alc の運行 内容,Y時間の欠け 判定,Y時間の欠け 内容,alc にあって勤怠に無い運行 判定,alc にあって勤怠に無い運行 内容,最低賃金の不変条件 判定,最低賃金の不変条件 内容')
    expect(lines[1]).toContain('1078,山田 太郎,2025-01,未実行,')
    expect(lines[1]).toContain(',判定できない,"失敗, ""理由""",')
    expect(lines).toHaveLength(2)
  })

  it('CSV の末尾に冊単位の警告を別の表として続ける (総数が多ければ添える)', () => {
    const csv = litigationErrorsCsv([], cd => cd, [
      { driverCd: '1078', label: '2025-01〜2025-02', warnings: ['a', 'b'], warningsCount: 9 },
      { driverCd: '2000', label: '2025-01〜2025-02', warnings: ['c'], warningsCount: 1 },
    ])
    const lines = csv.slice(1).trimEnd().split('\n')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('乗務員CD,氏名,期間,Y時間の警告 (冊単位・月に割り振れない)')
    expect(lines[3]).toBe('1078,1078,2025-01〜2025-02,a / b ほか (全 9 件)')
    expect(lines[4]).toBe('2000,2000,2025-01〜2025-02,c')
  })
})

describe('取り込みボタン', () => {
  it('★ 運行月とその翌月を 1 か月ずつ (読取日。年をまたぐ)', () => {
    expect(litigationImportRanges('2025-12')).toEqual([
      { from: '2025-12-01', to: '2025-12-31' },
      { from: '2026-01-01', to: '2026-01-31' },
    ])
  })

  it('2xx は取り込み件数。CSV 分割の失敗があれば直し方を添える', () => {
    expect(classifyLitigationImport(200, { ok: true, operations_count: 12, split_failed: 0 }, '')).toEqual({ kind: 'ok', message: '取り込み 12 件' })
    expect(classifyLitigationImport(200, { operations_count: 3, split_failed: 1 }, '').message).toContain('「未分割をまとめて分割」')
    expect(classifyLitigationImport(200, null, '')).toEqual({ kind: 'ok', message: '取り込み 件数不明' })
  })

  it('★ 502 の空 ZIP は失敗にせず「その期間に運行なし」', () => {
    const body = { error: '取得したデータが空の ZIP です (22 bytes) — その読取日に theearth 側のデータがありません (未来日・休業日など)' }
    expect(classifyLitigationImport(502, body, '502 …')).toEqual({ kind: 'empty', message: 'その期間に運行なし (theearth にも無い)' })
  })

  it('★ 空 ZIP 以外の 502 (ログイン切れ等) は失敗のまま', () => {
    const body = { error: '取得したデータが ZIP ではありません (1024 bytes) — ログイン切れ、または theearth-np のページ仕様変更の可能性があります' }
    expect(classifyLitigationImport(502, body, '502 理由')).toEqual({ kind: 'error', message: '502 理由' })
    expect(classifyLitigationImport(502, { error: 1 }, '502 理由').kind).toBe('error')
  })

  it('403 は権限が無い、通信失敗 (status 無し) は失敗', () => {
    expect(classifyLitigationImport(403, { error: 'forbidden' }, '')).toEqual({ kind: 'forbidden', message: '取り込みは admin / payroll のみ' })
    expect(classifyLitigationImport(null, null, '接続できませんでした')).toEqual({ kind: 'error', message: '接続できませんでした' })
    expect(classifyLitigationImport(400, {}, '400 …').kind).toBe('error')
  })
})
