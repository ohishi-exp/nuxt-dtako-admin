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
  litigationImportRanges,
  litigationMonthBounds,
  litigationAlcReadingRange,
  opeNosStartedInMonth,
  litigationNeedsFetch,
  litigationRowCheckedAt,
  litigationRowNeedsAttention,
  reduceWageReportForDriver,
  restoreLitigationChecks,
  unkoGapsCell,
  yTimeCell,
  type LitigationAlcOpsEntry,
  type LitigationErrorInput,
  type LitigationDtakoOps,
  type LitigationFetched,
} from '~/utils/litigation-errors'
import type { LitigationOutputChunk, LitigationOutputResult } from '~/utils/litigation-output'
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

function dtako(alc: string[], onprem: string[], onpremTruncated = false): LitigationFetched<LitigationDtakoOps> {
  return { ok: true, value: { alc, onprem, onpremTruncated } }
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
    summary: { driverCd, workDays: 20, days: [{ date: '2025-01-10' }] } as unknown as WageReportRow['summary'],
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

  it('月単位を読む前でも、運行から作った出力タブの結果が冊ごと 0 件なら異常あり (元の欄の無い旧い結果も運行の元)', () => {
    const ng = { state: 'ng', message: 'この冊の期間の運行が 0 件 (出力タブの結果)' }
    expect(alcOpsCell(undefined, result({ status: 'empty', rows: 0 }))).toEqual(ng)
    expect(alcOpsCell(undefined, result({ status: 'empty', rows: 0, source: 'alc', sourceReason: 'out_of_scope' }))).toEqual(ng)
    expect(alcOpsCell(undefined, result({ status: 'empty', rows: 0, source: 'alc', sourceReason: 'not_configured' }))).toEqual(ng)
  })

  it('★ 勤怠の元の 0 件 (勤務が無い・全部の勤務で行を作れなかった) は運行が無いことを意味しない — 未実行のまま', () => {
    const pending = { state: 'pending', message: '未実行 — 「検知を実行」で調べます' }
    expect(alcOpsCell(undefined, result({ status: 'empty', rows: 0, source: 'kintai', excludedReasons: {} }))).toEqual(pending)
    expect(alcOpsCell(undefined, result({ status: 'empty', rows: 0, source: 'kintai', excludedReasons: { no_non_working: 4 } }))).toEqual(pending)
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

  it('3 件以下なら「ほか」を付けない', () => {
    const dropped = [{ unkoNo: '2501050000000000001234', reason: '出庫/帰庫が無い' }]
    expect(yTimeCell('2025-01', null, { ok: true, days: 20, dropped }).message).toBe('Y時間に入らなかった運行 1 件: 2501050000000000001234 (出庫/帰庫が無い)')
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

  it('運行から作った 0 件の冊は欠けなしだが、alc の運行の列を見るよう添える', () => {
    expect(yTimeCell('2025-01', result({ status: 'empty', rows: 0 })).message).toContain('「alc の運行」の列を見てください')
    expect(yTimeCell('2025-01', result({ status: 'empty', rows: 0, source: 'alc', sourceReason: 'out_of_scope' })))
      .toEqual({ state: 'ok', message: '書けなかった日なし (この冊は運行 0 件 — 「alc の運行」の列を見てください)' })
  })

  it('★ 勤怠の元で除外が 0 の 0 件の冊は「勤務 0 件」と言い、alc の運行の列へ案内しない', () => {
    expect(yTimeCell('2025-01', result({ status: 'empty', rows: 0, source: 'kintai', excludedReasons: {} })))
      .toEqual({ state: 'ok', message: '書けなかった日なし (この冊は勤務 0 件)' })
  })

  it('★ 行を作れなかった勤務が 1 件でも在れば異常あり (件数は冊単位・理由ごと)。まだ畳み直していない勤務が在れば畳み直しを案内する', () => {
    expect(yTimeCell('2025-01', result({ source: 'kintai', excludedReasons: { no_non_working: 2, overlap: 1 } }))).toEqual({
      state: 'ng',
      message: 'この冊で行を作れなかった勤務 3 件 (出力タブの結果): まだ畳み直していない 2 件・別の勤務と時間が重なる 1 件 — 勤怠の畳み直しが要ります',
    })
    expect(yTimeCell('2025-01', result({ source: 'kintai', excludedReasons: { three_days: 1 } }))).toEqual({
      state: 'ng',
      message: 'この冊で行を作れなかった勤務 1 件 (出力タブの結果): 3 暦日以上にまたがる 1 件',
    })
    // 行が 0 件の冊でも同じ (「書けなかった日なし」にしない)
    expect(yTimeCell('2025-01', result({ status: 'empty', rows: 0, source: 'kintai', excludedReasons: { no_non_working: 1 } })).state).toBe('ng')
    // プレビューが異常なしでも、出力タブ側の異常を出す
    expect(yTimeCell('2025-01', result({ source: 'kintai', excludedReasons: { overlap: 1 } }), { ok: true, days: 20, dropped: [] }).state).toBe('ng')
  })

  it('判定の順は今までどおり: 失敗 → 未登録 → 書けなかった日 → 判定できない、のあとに行を作れなかった勤務', () => {
    const excluded = { source: 'kintai' as const, excludedReasons: { overlap: 1 } }
    expect(yTimeCell('2025-01', result({ ...excluded, status: 'error', message: '500 …' }))).toEqual({ state: 'unknown', message: '500 …' })
    expect(yTimeCell('2025-01', result({ ...excluded, missingDates: ['2025-01-05'], missingCount: 1 })).message).toBe('テンプレに行が無く書けなかった日: 2025-01-05')
    expect(yTimeCell('2025-03', result({ ...excluded, missingDates: ['2025-01-05'], missingCount: 31 })).state).toBe('unknown')
  })
})

describe('unkoGapsCell (alc にあってオンプレのデジタコに無い運行)', () => {
  it('未実行・取れなかったは異常なしにしない', () => {
    expect(unkoGapsCell(undefined).state).toBe('pending')
    expect(unkoGapsCell({ ok: false, reason: '502 …' })).toEqual({ state: 'unknown', message: '502 …' })
  })

  it('★ alc にあってオンプレに無い運行を異常ありにする (3 件まで並べる)', () => {
    const alc = ['a', 'b', 'c', 'd', 'e']
    expect(unkoGapsCell(dtako(alc, ['e']))).toEqual({ state: 'ng', message: 'オンプレのデジタコに無い運行 4 件: a, b, c ほか' })
    expect(unkoGapsCell(dtako(['a', 'b'], ['b']))).toEqual({ state: 'ng', message: 'オンプレのデジタコに無い運行 1 件: a' })
  })

  it('★ 全部揃っていれば異常なし (オンプレにだけある運行は数えない)。タイムカードの有無は関係ない', () => {
    // ある乗務員の 2023-06 の形: alc 7 件がオンプレに全部あり、オンプレには 5/29 出発の運行も (月で絞る前の話なのでここでは 8 件)
    expect(unkoGapsCell(dtako(['a', 'b'], ['a', 'b', 'x']))).toEqual({ state: 'ok', message: 'オンプレのデジタコに無い運行なし (alc 2 件・オンプレ 3 件)' })
    expect(unkoGapsCell(dtako([], []))).toEqual({ state: 'ok', message: 'オンプレのデジタコに無い運行なし (alc 0 件・オンプレ 0 件)' })
  })

  it('オンプレの一覧が切れていて全部見つかったとは言えないなら判定できない (見つからない分は異常ありが優先)', () => {
    expect(unkoGapsCell(dtako(['a'], ['a'], true)).state).toBe('unknown')
    expect(unkoGapsCell(dtako(['a', 'z'], ['a'], true)).state).toBe('ng')
  })
})

describe('opeNosStartedInMonth / litigationAlcReadingRange', () => {
  it('運行を始めた月のものだけを 22 桁にし、2 名乗務の相方は 1 つにまとめる', () => {
    expect(opeNosStartedInMonth([
      '2306130752470000003834', '23061307524700000038342', '2305291229130000004010', '2307010000000000004010', 'x', '2306060955130000004010',
    ], '2023-06')).toEqual(['2306060955130000004010', '2306130752470000003834'])
  })

  it('alc は読取日で「始めた月の初日〜翌月末」を引く (月末の運行は翌月に読み取られる)', () => {
    expect(litigationAlcReadingRange('2023-06')).toEqual({ from: '2023-06-01', to: '2023-07-31' })
    expect(litigationAlcReadingRange('2023-12')).toEqual({ from: '2023-12-01', to: '2024-01-31' })
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
    expect(counts.alcOps).toEqual({ ng: 0, ok: 0, unknown: 0, pending: 4 })
    expect(counts.invariants.pending).toBe(4)
    expect(rows.some(litigationRowNeedsAttention)).toBe(false)
    expect(rows.every(r => !r.canImport)).toBe(true)
  })

  it('★ 検知の前: 勤怠の元の出力が 0 件の冊では運行の取り込みのボタンを出さない。運行の元 (と元の欄の無い旧い結果) は今までどおり出す', () => {
    const empty = { status: 'empty' as const, rows: 0 }
    const rows = buildLitigationErrorRows(input({
      results: [
        result({ ...empty, source: 'kintai', excludedReasons: { no_non_working: 2 }, message: '行を作れた勤務が 0 件 (行を作れなかった勤務 2 件)' }),
        result({ ...empty, driverCd: '2000' }),
      ],
    }))
    const at = (d: string, m: string) => rows.find(r => r.driverCd === d && r.month === m)!
    for (const m of ['2025-01', '2025-02']) {
      expect(at('1078', m).cells.alcOps.state).toBe('pending')
      expect(at('1078', m).canImport).toBe(false)
      // 行を作れなかった勤務は「Y時間の欠け」の列に異常ありで出る
      expect(at('1078', m).cells.yTime.state).toBe('ng')
      expect(at('2000', m).cells.alcOps).toEqual({ state: 'ng', message: 'この冊の期間の運行が 0 件 (出力タブの結果)' })
      expect(at('2000', m).canImport).toBe(true)
    }
    const alc = buildLitigationErrorRows(input({ results: [result({ ...empty, source: 'alc', sourceReason: 'not_configured' }), null] }))
    expect(alc.find(r => r.driverCd === '1078')!.canImport).toBe(true)
  })

  it('乗務員 × 月の素材を正しい行に配り、alc 0 件の行だけ取り込みボタンを出す', () => {
    const alcOps = new Map<string, LitigationAlcOpsEntry>([
      ['1078|2025-01', { ok: true, days: 0, dropped: [] }],
      ['1078|2025-02', { ok: true, days: 20, dropped: [] }],
    ])
    const rows = buildLitigationErrorRows(input({
      results: [result({ missingDates: ['2025-02-03'], missingCount: 1 }), null],
      alcOps,
      unkoGaps: new Map([['2000|2025-02', dtako(['u1'], [])]]),
      // 会社全体の応答を乗務員ごとに切り出して置く (画面と同じ)
      wageReports: new Map(['1078', '2000'].map(cd => [`${cd}|2025-01`, reduceWageReportForDriver(report([wageRow('1078'), wageRow('2000', { restraint_missing: true })]), cd)])),
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

describe('検知結果の保存 (切り出し・読み戻し・続きから)', () => {
  it('★ wage-report は 1 乗務員ぶんだけ残し、切り出しても判定は変わらない', () => {
    const inv = { ...OK_INV, unaccounted: { diffMinutes: 3, kind: 'other' as const } }
    const full = report([wageRow('1078', { invariants: inv }), wageRow('2000')], { no_data_drivers: ['1078', '3000'] })
    const cut = reduceWageReportForDriver(full, '1078')
    expect(cut.ok && cut.value.rows.length).toBe(1)
    // 日別だけ落とし、給与比較が読む月の集計・wage は残す
    expect(cut.ok && cut.value.rows[0]!.summary.days).toEqual([])
    expect(cut.ok && cut.value.rows[0]!.summary.workDays).toBe(20)
    expect(cut.ok && cut.value.no_data_drivers).toEqual(['1078'])
    expect(invariantsCell('1078', cut)).toEqual(invariantsCell('1078', full))
    // 行の無い乗務員も「データが無い / 行が無い」の言い分けが残る
    expect(invariantsCell('3000', reduceWageReportForDriver(full, '3000'))).toEqual(invariantsCell('3000', full))
    expect(invariantsCell('4000', reduceWageReportForDriver(full, '4000'))).toEqual(invariantsCell('4000', full))
    const failed = { ok: false as const, reason: '502' }
    expect(reduceWageReportForDriver(failed, '1078')).toBe(failed)
  })

  it('保存した 3 種を Map に戻し、行ごとにいちばん古い保存時刻を持つ', () => {
    const r = restoreLitigationChecks({
      items: [
        { kind: 'alcOps', key: '9101|2023-06', payload: { ok: true, days: 20, dropped: [] }, checkedAt: '2026-09-29T02:00:00Z' },
        { kind: 'alcOps', key: '9101|2023-07', payload: { ok: false, notFound: true, reason: '404' }, checkedAt: '2026-09-29T02:00:00Z' },
        { kind: 'unkoGaps', key: '9101|2023-06', payload: { ok: true, value: { alc: ['a'], onprem: ['a', 'b'] } }, checkedAt: '2026-09-29T01:00:00Z' },
        { kind: 'unkoGaps', key: '9101|2023-07', payload: { ok: false, reason: '502' }, checkedAt: '2026-09-29T03:00:00Z' },
        { kind: 'wageReport', key: '9101|2023-06', payload: report([wageRow('9101')]), checkedAt: '2026-09-29T04:00:00Z' },
        { kind: 'wageReport', key: '9101|2023-07', payload: { ok: false, reason: 'x' }, checkedAt: '2026-09-29T04:00:00Z' },
      ],
    })
    expect(r.alcOps.get('9101|2023-06')).toEqual({ ok: true, days: 20, dropped: [] })
    expect(r.alcOps.get('9101|2023-07')).toEqual({ ok: false, notFound: true, reason: '404' })
    expect(r.unkoGaps.get('9101|2023-06')).toEqual({ ok: true, value: { alc: ['a'], onprem: ['a', 'b'], onpremTruncated: false } })
    expect(r.unkoGaps.get('9101|2023-07')).toEqual({ ok: false, reason: '502' })
    expect(invariantsCell('9101', r.wageReports.get('9101|2023-06')).state).toBe('ok')
    expect(r.wageReports.get('9101|2023-07')).toEqual({ ok: false, reason: 'x' })
    expect(r.checkedAt.get('unkoGaps|9101|2023-06')).toBe('2026-09-29T01:00:00Z')
    // 行の時刻は 3 種のうちいちばん古いもの
    expect(litigationRowCheckedAt(r.checkedAt, '9101|2023-06')).toBe('2026-09-29T01:00:00Z')
    expect(litigationRowCheckedAt(r.checkedAt, '9101|2023-07')).toBe('2026-09-29T02:00:00Z')
    expect(litigationRowCheckedAt(r.checkedAt, '9101|2023-08')).toBeNull()
  })

  it('★ 形の崩れた 1 件は捨てる (その行は未実行に戻るだけ。時刻も付けない)', () => {
    const at = '2026-09-29T00:00:00Z'
    const r = restoreLitigationChecks({
      items: [
        null,
        { kind: 'alcOps', key: 1, payload: {}, checkedAt: at },
        { kind: 'alcOps', key: 'a', payload: [], checkedAt: at },
        { kind: 'alcOps', key: 'a', payload: {}, checkedAt: 1 },
        { kind: 'alcOps', key: 'b', payload: { ok: true, days: '3', dropped: [] }, checkedAt: at },
        { kind: 'alcOps', key: 'c', payload: { ok: false }, checkedAt: at },
        { kind: 'unkoGaps', key: 'd', payload: { ok: false }, checkedAt: at },
        // 勤怠 (time_card_dtako) と突き合わせていた頃の保存は形が違うので捨てる → 続きからで取り直される
        { kind: 'unkoGaps', key: 'd2', payload: { ok: true, raw: { onprem_operations_in_month: 0 } }, checkedAt: at },
        { kind: 'unkoGaps', key: 'd3', payload: { ok: true, value: { alc: ['a'], onprem: [1] } }, checkedAt: at },
        { kind: 'wageReport', key: 'e', payload: { ok: true, value: { rows: [] } }, checkedAt: at },
        { kind: 'wageReport', key: 'f', payload: { ok: true, value: null }, checkedAt: at },
        { kind: 'wageReport', key: 'g', payload: { ok: false }, checkedAt: at },
        // 不変条件だけを残していた頃の保存 (summary が乗務員CD だけ) は捨てて取り直させる
        { kind: 'wageReport', key: 'g2', payload: { ok: true, value: { rows: [{ summary: { driverCd: '9101' }, invariants: {} }], no_data_drivers: [] } }, checkedAt: at },
        { kind: 'yTime', key: 'h', payload: { ok: true }, checkedAt: at },
      ],
    })
    expect([r.alcOps.size, r.unkoGaps.size, r.wageReports.size, r.checkedAt.size]).toEqual([0, 0, 0, 0])
    expect(restoreLitigationChecks(null).alcOps.size).toBe(0)
    expect(restoreLitigationChecks({ items: 'x' }).alcOps.size).toBe(0)
  })

  it('続きからは「まだ取っていない / 取れなかった」だけ取り直す', () => {
    expect(litigationNeedsFetch(undefined)).toBe(true)
    expect(litigationNeedsFetch({ ok: false })).toBe(true)
    expect(litigationNeedsFetch({ ok: true })).toBe(false)
  })
})
