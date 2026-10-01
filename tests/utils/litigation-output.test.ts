/**
 * 訴訟準備の「出力」タブの pure ロジック (`app/utils/litigation-output.ts`、Refs #1133 c1133-2)。
 *
 * - 案件 → 区切り (乗務員 1 名 × 最大 12 か月) の切り方と、ファイル名・ZIP 名
 * - 応答 → 結果の 4 分類。**「0 件」「未登録」「失敗」を同じ見た目にしない** (map skill
 *   「PR の基準」(7)) ことを、404 が 2 種類あるケースも含めて固定する
 */
import { describe, it, expect } from 'vitest'
import {
  buildLitigationHoursBooks,
  buildLitigationZipSummary,
  buildLitigationOutputChunks,
  countLitigationResults,
  litigationEmptyMessage,
  litigationOutputSourceLines,
  litigationResultFromFailure,
  litigationResultFromHeaders,
  litigationZipFilename,
  parseYTimeRowsPreview,
  yTimeSourceFromHeaders,
  yTimeSourceFromPreview,
  LITIGATION_EMPTY_ALC_MESSAGE,
  LITIGATION_EMPTY_KINTAI_MESSAGE,
  LITIGATION_HOURS_COLUMNS,
  LITIGATION_NOT_FOUND_MESSAGE,
  type LitigationOutputChunk,
  type LitigationOutputResult,
} from '~/utils/litigation-output'
import { Y_TIME_SOURCES, Y_TIME_SOURCE_REASONS, type LitigationFetched } from '~/utils/litigation-errors'
import { compareSalaryMonth } from '~/utils/salary-compare'
import type { WageReportResponse, WageReportRow, WageRow } from '~/utils/restraint-wage-view'

function headers(h: Record<string, string>) {
  return new Headers(h)
}

const CHUNK: LitigationOutputChunk = {
  driverCd: '1078',
  from: '2024-06-01',
  to: '2025-05-31',
  label: '2024-06〜2025-05',
  filename: '1078_2024-06-2025-05.xlsx',
}

describe('buildLitigationOutputChunks', () => {
  it('★ 開始月から 12 か月ごとに区切る (2024-06〜2026-01 → 2 冊)', () => {
    const chunks = buildLitigationOutputChunks({ fromMonth: '2024-06', toMonth: '2026-01', driverCds: ['1078'] })
    expect(chunks).toEqual([
      { driverCd: '1078', from: '2024-06-01', to: '2025-05-31', label: '2024-06〜2025-05', filename: '1078_2024-06-2025-05.xlsx' },
      { driverCd: '1078', from: '2025-06-01', to: '2026-01-31', label: '2025-06〜2026-01', filename: '1078_2025-06-2026-01.xlsx' },
    ])
  })

  it('乗務員ごと・期間の古い順に並ぶ', () => {
    const chunks = buildLitigationOutputChunks({ fromMonth: '2024-01', toMonth: '2025-12', driverCds: ['2', '1'] })
    expect(chunks.map(c => `${c.driverCd}:${c.label}`)).toEqual([
      '2:2024-01〜2024-12', '2:2025-01〜2025-12', '1:2024-01〜2024-12', '1:2025-01〜2025-12',
    ])
  })

  it('月末は月の日数どおり (閏年の 2 月・30 日の月)', () => {
    expect(buildLitigationOutputChunks({ fromMonth: '2024-02', toMonth: '2024-02', driverCds: ['1'] })[0]!.to).toBe('2024-02-29')
    expect(buildLitigationOutputChunks({ fromMonth: '2025-02', toMonth: '2025-02', driverCds: ['1'] })[0]!.to).toBe('2025-02-28')
    expect(buildLitigationOutputChunks({ fromMonth: '2025-04', toMonth: '2025-04', driverCds: ['1'] })[0]!.to).toBe('2025-04-30')
  })

  it('ちょうど 12 か月は 1 冊、13 か月は 2 冊 (2 冊目は 1 か月)', () => {
    expect(buildLitigationOutputChunks({ fromMonth: '2024-04', toMonth: '2025-03', driverCds: ['1'] })).toHaveLength(1)
    const two = buildLitigationOutputChunks({ fromMonth: '2024-04', toMonth: '2025-04', driverCds: ['1'] })
    expect(two.map(c => [c.from, c.to])).toEqual([['2024-04-01', '2025-03-31'], ['2025-04-01', '2025-04-30']])
  })

  it('案件の上限 60 か月は 5 冊になる (monthRange の既定上限 24 で切れない)', () => {
    const chunks = buildLitigationOutputChunks({ fromMonth: '2021-01', toMonth: '2025-12', driverCds: ['1'] })
    expect(chunks.map(c => c.label)).toEqual([
      '2021-01〜2021-12', '2022-01〜2022-12', '2023-01〜2023-12', '2024-01〜2024-12', '2025-01〜2025-12',
    ])
  })

  it('開始月と終了月が逆でも並べ直す / 形式違い・乗務員 0 名は空', () => {
    expect(buildLitigationOutputChunks({ fromMonth: '2025-03', toMonth: '2025-01', driverCds: ['1'] })[0]!.label)
      .toBe('2025-01〜2025-03')
    expect(buildLitigationOutputChunks({ fromMonth: '2025-13', toMonth: '2025-01', driverCds: ['1'] })).toEqual([])
    expect(buildLitigationOutputChunks({ fromMonth: '2025-01', toMonth: '2025-03', driverCds: [] })).toEqual([])
  })
})

describe('litigationZipFilename', () => {
  it('訴訟準備_{案件名}_{JST の作成日}.zip (UTC 15:00 以降は JST で翌日)', () => {
    expect(litigationZipFilename('未払残業代請求事件', new Date('2026-09-25T14:59:59Z')))
      .toBe('訴訟準備_未払残業代請求事件_2026-09-25.zip')
    expect(litigationZipFilename('未払残業代請求事件', new Date('2026-09-25T15:00:00Z')))
      .toBe('訴訟準備_未払残業代請求事件_2026-09-26.zip')
  })

  it('ファイル名に使えない文字は _ に置き換え、空になったら「案件」', () => {
    expect(litigationZipFilename('A/B\\C:D*E?F"G<H>I|J\tK', new Date('2026-01-01T00:00:00Z')))
      .toBe('訴訟準備_A_B_C_D_E_F_G_H_I_J_K_2026-01-01.zip')
    expect(litigationZipFilename('   ', new Date('2026-01-01T00:00:00Z'))).toBe('訴訟準備_案件_2026-01-01.zip')
  })
})

describe('litigationResultFromHeaders', () => {
  it('★ rows > 0 は ok で行数を言う。件数ヘッダは切り詰め前の総数を採る', () => {
    const r = litigationResultFromHeaders(CHUNK, headers({
      'x-y-time-rows': '240',
      'x-y-time-missing-dates': '2025-06-01,2025-06-02',
      'x-y-time-missing-count': '31',
      'x-y-time-warnings': encodeURIComponent('運行 A の帰庫が無い / 運行 B の出庫が無い'),
      'x-y-time-warnings-count': '7',
    }))
    expect(r).toEqual({
      driverCd: '1078', from: '2024-06-01', to: '2025-05-31',
      status: 'ok', rows: 240,
      missingDates: ['2025-06-01', '2025-06-02'], missingCount: 31,
      warnings: ['運行 A の帰庫が無い', '運行 B の出庫が無い'], warningsCount: 7,
      message: '240 行',
    })
  })

  it('★ 元を返さない応答の rows 0 は empty で「運行 0 件 (alc に取り込まれていない可能性)」と言う', () => {
    const r = litigationResultFromHeaders(CHUNK, headers({ 'x-y-time-rows': '0', 'x-y-time-missing-count': '0', 'x-y-time-warnings-count': '0' }))
    expect(r.status).toBe('empty')
    expect(r.rows).toBe(0)
    expect(r.message).toBe(LITIGATION_EMPTY_ALC_MESSAGE)
    // 元のヘッダが無い応答は、元の欄を 1 つも持たない (旧い版と同じ形)
    for (const k of ['source', 'sourceReason', 'excludedReasons', 'excluded', 'missingMonths']) expect(r).not.toHaveProperty(k)
    expect(r.message).not.toBe(LITIGATION_NOT_FOUND_MESSAGE)
  })

  it('★ 行数ヘッダが無い/読めないときは 0 件扱いにせず「判定できない」と言う', () => {
    for (const h of [{}, { 'x-y-time-rows': 'abc' }, { 'x-y-time-rows': '' }]) {
      const r = litigationResultFromHeaders(CHUNK, headers(h))
      expect(r.status).toBe('ok')
      expect(r.rows).toBeNull()
      expect(r.message).toBe('行数が返らなかった (0 件かどうか判定できない)')
    }
  })

  it('件数ヘッダが無ければ、切り詰め済みの一覧の長さで代える', () => {
    const r = litigationResultFromHeaders(CHUNK, headers({
      'x-y-time-rows': '3',
      'x-y-time-missing-dates': '2025-06-01',
      'x-y-time-warnings': encodeURIComponent('w1 / w2'),
    }))
    expect(r.missingCount).toBe(1)
    expect(r.warningsCount).toBe(2)
    expect(litigationResultFromHeaders(CHUNK, headers({ 'x-y-time-rows': '3' }))).toMatchObject({
      missingDates: [], missingCount: 0, warnings: [], warningsCount: 0,
    })
  })
})

describe('行の元 (Refs #1133 c1133-46)', () => {
  const KINTAI_CHUNK: LitigationOutputChunk = { driverCd: '9001', from: '2025-01-01', to: '2025-12-31', label: '2025-01〜2025-12', filename: '9001_2025-01-2025-12.xlsx' }
  const base = (over: Partial<LitigationOutputResult> = {}): LitigationOutputResult => ({
    driverCd: '9001', from: '2025-01-01', to: '2025-12-31', status: 'ok', rows: 10,
    missingDates: [], missingCount: 0, warnings: [], warningsCount: 0, message: '10 行', ...over,
  })

  describe('yTimeSourceFromHeaders', () => {
    it('★ 勤怠の元: 理由ごとの件数 (全件)・先頭の始業の日付・記録の無い月を読む', () => {
      expect(yTimeSourceFromHeaders(headers({
        'x-y-time-source': 'kintai',
        'x-y-time-excluded-reasons': 'no_non_working=22,three_days=1',
        'x-y-time-excluded': '2025-01-02:no_non_working,2025-01-03:three_days',
        'x-y-time-missing-months': '2025-03,2025-04',
      }))).toEqual({
        source: 'kintai',
        excludedReasons: { no_non_working: 22, three_days: 1 },
        excluded: [{ date: '2025-01-02', reason: 'no_non_working' }, { date: '2025-01-03', reason: 'three_days' }],
        missingMonths: ['2025-03', '2025-04'],
      })
    })

    it('運行の元へ倒した応答は理由を持ち、件数の欄は空で持つ', () => {
      expect(yTimeSourceFromHeaders(headers({ 'x-y-time-source': 'alc', 'x-y-time-source-reason': 'out_of_scope' })))
        .toEqual({ source: 'alc', sourceReason: 'out_of_scope', excludedReasons: {}, excluded: [], missingMonths: [] })
      expect(yTimeSourceFromHeaders(headers({ 'x-y-time-source': 'alc', 'x-y-time-source-reason': 'not_configured' })).sourceReason).toBe('not_configured')
    })

    it('★ 元のヘッダが無い・知らない値なら何も返さない (勤怠の元に見せない)', () => {
      expect(yTimeSourceFromHeaders(headers({}))).toEqual({})
      expect(yTimeSourceFromHeaders(headers({ 'x-y-time-source': 'other', 'x-y-time-excluded-reasons': 'overlap=1' }))).toEqual({})
    })

    it('知らない倒した理由・形の合わない件数と一覧の要素は読まない', () => {
      expect(yTimeSourceFromHeaders(headers({
        'x-y-time-source': 'alc',
        'x-y-time-source-reason': 'whatever',
        'x-y-time-excluded-reasons': 'overlap=2,broken,=3,night_bands=x',
        'x-y-time-excluded': '2025-01-02:overlap,nocolon,:overlap',
      }))).toEqual({ source: 'alc', excludedReasons: { overlap: 2 }, excluded: [{ date: '2025-01-02', reason: 'overlap' }], missingMonths: [] })
    })
  })

  describe('litigationEmptyMessage (rows 0 の文を元で言い分ける)', () => {
    it('★ 勤怠の元: 勤務が無いのか、行を作れなかったのかを言い分ける', () => {
      expect(litigationEmptyMessage({ source: 'kintai', excludedReasons: {} })).toBe('この期間に勤務が 0 件')
      expect(litigationEmptyMessage({ source: 'kintai' })).toBe(LITIGATION_EMPTY_KINTAI_MESSAGE)
      expect(litigationEmptyMessage({ source: 'kintai', excludedReasons: { no_non_working: 3, overlap: 1 } }))
        .toBe('行を作れた勤務が 0 件 (行を作れなかった勤務 4 件)')
    })

    it('★ 運行の元 (倒した 2 通り) と、元の無い結果 (旧い版) は今までの運行の文', () => {
      expect(litigationEmptyMessage({ source: 'alc', sourceReason: 'out_of_scope' } as never)).toBe(LITIGATION_EMPTY_ALC_MESSAGE)
      expect(litigationEmptyMessage({ source: 'alc', excludedReasons: {} })).toBe(LITIGATION_EMPTY_ALC_MESSAGE)
      expect(litigationEmptyMessage({})).toBe('この期間に運行が 0 件 (alc に取り込まれていない可能性)')
    })

    it('★ 勤怠の元の rows 0 は、結果の文が「運行」と言わない', () => {
      const r = litigationResultFromHeaders(KINTAI_CHUNK, headers({ 'x-y-time-rows': '0', 'x-y-time-source': 'kintai', 'x-y-time-missing-months': '2025-01' }))
      expect(r).toMatchObject({ status: 'empty', source: 'kintai', message: 'この期間に勤務が 0 件', missingMonths: ['2025-01'] })
      const excluded = litigationResultFromHeaders(KINTAI_CHUNK, headers({ 'x-y-time-rows': '0', 'x-y-time-source': 'kintai', 'x-y-time-excluded-reasons': 'no_non_working=5' }))
      expect(excluded.message).toBe('行を作れた勤務が 0 件 (行を作れなかった勤務 5 件)')
      const alc = litigationResultFromHeaders(KINTAI_CHUNK, headers({ 'x-y-time-rows': '0', 'x-y-time-source': 'alc', 'x-y-time-source-reason': 'not_configured' }))
      expect(alc).toMatchObject({ status: 'empty', source: 'alc', sourceReason: 'not_configured', message: LITIGATION_EMPTY_ALC_MESSAGE })
    })
  })

  describe('litigationOutputSourceLines (冊ごとの表示)', () => {
    const texts = (r: LitigationOutputResult) => litigationOutputSourceLines(r).map(l => `${l.kind}: ${l.text}`)

    it('★ 元の 3 通りの文', () => {
      expect(texts(base({ source: 'kintai', excludedReasons: {}, excluded: [], missingMonths: [] }))).toEqual(['source: 勤怠の記録から作成'])
      expect(texts(base({ source: 'alc', sourceReason: 'out_of_scope' }))).toEqual(['source: 運行から作成 (この会社は勤怠の記録が無い)'])
      expect(texts(base({ source: 'alc', sourceReason: 'not_configured' }))).toEqual(['source: 運行から作成 (この環境は勤怠の設定が無い)'])
    })

    it('★ 元の欄の無い結果 (旧い版) と、倒した理由の無い運行の元は「運行から作成」', () => {
      expect(texts(base())).toEqual(['source: 運行から作成'])
      expect(texts(base({ source: 'alc' }))).toEqual(['source: 運行から作成'])
    })

    it('★ 行を作れなかった勤務は合計・理由ごとの件数・先頭の始業の日付を言い、畳み直しが要るものは別の行で目立たせる', () => {
      expect(texts(base({
        source: 'kintai',
        excludedReasons: { no_non_working: 3, three_days: 1, overlap: 1, night_bands: 1, brand_new: 1 },
        excluded: [{ date: '2025-01-02', reason: 'no_non_working' }, { date: '2025-01-03', reason: 'three_days' }],
        missingMonths: ['2025-03', '2025-04'],
      }))).toEqual([
        'source: 勤怠の記録から作成',
        'excluded: 行を作れなかった勤務 7 件 (まだ畳み直していない 3 件・3 暦日以上にまたがる 1 件・別の勤務と時間が重なる 1 件・深夜の時間帯に載らない 1 件・理由 brand_new 1 件)'
        + ' — 始業の日付: 2025-01-02 (まだ畳み直していない), 2025-01-03 (3 暦日以上にまたがる) ほか',
        'refold: 勤怠の畳み直しが要ります (まだ畳み直していない勤務 3 件)',
        'missingMonths: 勤務の記録が無い月: 2025-03, 2025-04',
      ])
    })

    it('一覧が全件のときは「ほか」を付けない。畳み直しの要らない理由だけなら畳み直しの行は出さない', () => {
      expect(texts(base({ source: 'kintai', excludedReasons: { overlap: 1 }, excluded: [{ date: '2025-02-01', reason: 'overlap' }], missingMonths: [] }))).toEqual([
        'source: 勤怠の記録から作成',
        'excluded: 行を作れなかった勤務 1 件 (別の勤務と時間が重なる 1 件) — 始業の日付: 2025-02-01 (別の勤務と時間が重なる)',
      ])
      // 件数だけ在って一覧の欄が無い結果でも落ちない
      expect(texts(base({ source: 'kintai', excludedReasons: { overlap: 2 } }))[1]).toBe('excluded: 行を作れなかった勤務 2 件 (別の勤務と時間が重なる 2 件) — 始業の日付:  ほか')
    })

    it('行が 0 件の冊も元と除外を言う。失敗・未登録の冊は何も作っていないので空', () => {
      expect(texts(base({ status: 'empty', rows: 0, source: 'kintai', excludedReasons: { no_non_working: 1 }, excluded: [{ date: '2025-01-02', reason: 'no_non_working' }] }))).toHaveLength(3)
      expect(texts(base({ status: 'error', rows: null }))).toEqual([])
      expect(texts(base({ status: 'not_found', rows: null }))).toEqual([])
    })
  })
})

describe('JSON の応答 (`POST /api/y-time-rows`) の形の検査と、行の元 (Refs #1133 c1133-47。値はすべて架空)', () => {
  const PREVIEW = {
    source: 'kintai',
    source_reason: null,
    rows: [{ date: '2025-01-06', start_minutes_of_day: 480 }],
    warnings: ['w1'],
    excluded: [
      { start: '2025-01-08 08:00:00', end: '2025-01-08 17:00:00', reason: 'no_non_working' },
      { start: '2025-01-09T22:00:00', end: '2025-01-10T07:00:00', reason: 'overlap' },
      { start: '2025-01-15 08:00:00', end: '2025-01-15 17:00:00', reason: 'no_non_working' },
    ],
    missing_months: ['2025-02'],
  }

  it('★ 形の合う応答は、検査した欄だけを返す (driver / period・知らない欄は持ち出さない)', () => {
    expect(parseYTimeRowsPreview({ ...PREVIEW, driver: { cd: '9001', name: '架空 太郎' }, period: { from: 'a', to: 'b' }, extra: 1 }))
      .toStrictEqual(PREVIEW)
    const alc = { ...PREVIEW, source: 'alc', source_reason: 'not_configured', excluded: [], missing_months: [] }
    expect(parseYTimeRowsPreview(alc)).toStrictEqual(alc)
  })

  it.each([
    ['object でない', null],
    ['配列', [PREVIEW]],
    ['source が知らない語', { ...PREVIEW, source: 'other' }],
    ['source が無い', { ...PREVIEW, source: undefined }],
    ['source_reason が知らない語', { ...PREVIEW, source_reason: 'other' }],
    ['source_reason が無い', { ...PREVIEW, source_reason: undefined }],
    ['rows が配列でない', { ...PREVIEW, rows: {} }],
    ['rows の要素が object でない', { ...PREVIEW, rows: ['2025-01-06'] }],
    ['rows の date が文字列でない', { ...PREVIEW, rows: [{ date: 20250106 }] }],
    ['warnings が文字列の配列でない', { ...PREVIEW, warnings: [1] }],
    ['missing_months が無い', { ...PREVIEW, missing_months: undefined }],
    ['excluded が無い', { ...PREVIEW, excluded: undefined }],
    ['excluded の要素が object でない', { ...PREVIEW, excluded: [null] }],
    ['excluded の start が無い', { ...PREVIEW, excluded: [{ end: 'e', reason: 'overlap' }] }],
    ['excluded の end が無い', { ...PREVIEW, excluded: [{ start: 's', reason: 'overlap' }] }],
    ['excluded の reason が無い', { ...PREVIEW, excluded: [{ start: 's', end: 'e' }] }],
  ])('★ %s 応答は null (欠けた欄を 0 件として読まない)', (_name, raw) => {
    expect(parseYTimeRowsPreview(raw)).toBeNull()
  })

  it('★ 語の一覧は 1 か所の定義で、型の語と一致する', () => {
    expect(Y_TIME_SOURCES).toEqual(['kintai', 'alc'])
    expect(Y_TIME_SOURCE_REASONS).toEqual(['out_of_scope', 'not_configured'])
  })

  it('★ JSON の応答から行の元の 5 欄を作る: 理由ごとの件数は全件・一覧は始業の日付 (区切りが空白でも T でも)', () => {
    const info = yTimeSourceFromPreview(parseYTimeRowsPreview(PREVIEW)!)
    expect(info).toStrictEqual({
      source: 'kintai',
      excludedReasons: { no_non_working: 2, overlap: 1 },
      excluded: [
        { date: '2025-01-08', reason: 'no_non_working' },
        { date: '2025-01-09', reason: 'overlap' },
        { date: '2025-01-15', reason: 'no_non_working' },
      ],
      missingMonths: ['2025-02'],
    })
  })

  it('★ 同じ内容なら、JSON の応答からでも応答ヘッダからでも、画面に出る行は同じ (プレビューとダウンロードで食い違わない)', () => {
    const fromPreview = litigationOutputSourceLines({ ...yTimeSourceFromPreview(parseYTimeRowsPreview(PREVIEW)!), status: 'ok' })
    const fromHeaders = litigationOutputSourceLines({
      ...yTimeSourceFromHeaders(headers({
        'x-y-time-source': 'kintai',
        'x-y-time-excluded-reasons': 'no_non_working=2,overlap=1',
        'x-y-time-excluded': '2025-01-08:no_non_working,2025-01-09:overlap,2025-01-15:no_non_working',
        'x-y-time-missing-months': '2025-02',
      })),
      status: 'ok',
    })
    expect(fromPreview).toEqual(fromHeaders)
    expect(fromPreview.map(l => l.kind)).toEqual(['source', 'excluded', 'refold', 'missingMonths'])
    expect(fromPreview[0]!.text).toBe('勤怠の記録から作成')
    expect(fromPreview[1]!.text).toContain('行を作れなかった勤務 3 件 (まだ畳み直していない 2 件・別の勤務と時間が重なる 1 件)')
  })

  it('運行の元へ倒した応答は、倒した理由を持つ (除外と記録の無い月は空)', () => {
    const info = yTimeSourceFromPreview(parseYTimeRowsPreview({ ...PREVIEW, source: 'alc', source_reason: 'out_of_scope', excluded: [], missing_months: [] })!)
    expect(info).toStrictEqual({ source: 'alc', sourceReason: 'out_of_scope', excludedReasons: {}, excluded: [], missingMonths: [] })
    expect(litigationOutputSourceLines({ ...info, status: 'ok' })).toEqual([{ kind: 'source', text: '運行から作成 (この会社は勤怠の記録が無い)' }])
    expect(litigationEmptyMessage(info)).toBe(LITIGATION_EMPTY_ALC_MESSAGE)
  })

  it('★ 行が 0 件のとき: 除外が在れば「勤務が 0 件」と言わない (プレビューも出力タブと同じ文)', () => {
    const info = yTimeSourceFromPreview(parseYTimeRowsPreview({ ...PREVIEW, rows: [] })!)
    expect(litigationEmptyMessage(info)).toBe('行を作れた勤務が 0 件 (行を作れなかった勤務 3 件)')
    expect(litigationEmptyMessage(yTimeSourceFromPreview(parseYTimeRowsPreview({ ...PREVIEW, rows: [], excluded: [] })!)))
      .toBe(LITIGATION_EMPTY_KINTAI_MESSAGE)
  })
})

describe('litigationResultFromFailure', () => {
  it('★ 404 + data.upstream=alc だけが not_found (「alc に登録が無い」)', () => {
    const r = litigationResultFromFailure(CHUNK, 404, { error: true, data: { upstream: 'alc' } }, '404 backend error: driver_cd not found — …')
    expect(r).toEqual({
      driverCd: '1078', from: '2024-06-01', to: '2025-05-31',
      status: 'not_found', rows: null,
      missingDates: [], missingCount: 0, warnings: [], warningsCount: 0,
      message: LITIGATION_NOT_FOUND_MESSAGE,
    })
  })

  it('★ テンプレ不在の 404 (upstream 印なし) は not_found にせず、理由をそのまま出す', () => {
    const reason = '404 template not found in R2: templates/kyoto-soft/base.xlsx — …'
    for (const body of [{ error: true, statusCode: 404 }, null, 'not json', { data: { upstream: 'r2' } }]) {
      const r = litigationResultFromFailure(CHUNK, 404, body, reason)
      expect(r.status).toBe('error')
      expect(r.message).toBe(reason)
    }
  })

  it('上流印つきでも 404 以外 (502 等) と通信失敗 (status null) は error', () => {
    expect(litigationResultFromFailure(CHUNK, 502, { data: { upstream: 'alc' } }, '502 …').status).toBe('error')
    const r = litigationResultFromFailure(CHUNK, null, null, 'サーバに届きませんでした')
    expect(r.status).toBe('error')
    expect(r.message).toBe('サーバに届きませんでした')
  })
})

describe('countLitigationResults', () => {
  it('状態ごとに数える (0 の状態も 0 で出る)', () => {
    const ok = litigationResultFromHeaders(CHUNK, headers({ 'x-y-time-rows': '5' }))
    const empty = litigationResultFromHeaders(CHUNK, headers({ 'x-y-time-rows': '0' }))
    const err = litigationResultFromFailure(CHUNK, 500, null, 'x')
    expect(countLitigationResults([ok, ok, empty, err])).toEqual({ ok: 2, empty: 1, not_found: 0, error: 1 })
    expect(countLitigationResults([])).toEqual({ ok: 0, empty: 0, not_found: 0, error: 0 })
  })
})

describe('buildLitigationZipSummary (ZIP の中身の概要)', () => {
  const chunks = [
    { driverCd: '9101', from: '2022-12-01', to: '2023-11-30', label: '2022-12〜2023-11', filename: '9101_2022-12-2023-11.xlsx' },
    { driverCd: '9101', from: '2023-12-01', to: '2024-11-30', label: '2023-12〜2024-11', filename: '9101_2023-12-2024-11.xlsx' },
    { driverCd: '9101', from: '2024-12-01', to: '2025-11-30', label: '2024-12〜2025-11', filename: '9101_2024-12-2025-11.xlsx' },
  ]
  const base = {
    changesCsv: { filename: '変更記録.csv', finished: false, rows: 0 },
  }
  const res = (over: Record<string, unknown>) => ({
    driverCd: '9101', from: '', to: '', status: 'ok', rows: 250, missingDates: [], missingCount: 0, warnings: [], warningsCount: 0, message: '', ...over,
  }) as never

  it('★ 作る前は Excel を「まだ」、変更記録.csv は中身の要点つきで並べる', () => {
    const s = buildLitigationZipSummary({ chunks, results: [null, null, null], ...base })
    expect(s.map(i => `${i.state} ${i.filename}`)).toEqual([
      'pending 9101_2022-12-2023-11.xlsx', 'pending 9101_2023-12-2024-11.xlsx', 'pending 9101_2024-12-2025-11.xlsx',
      'included 変更記録.csv',
    ])
    expect(s).toHaveLength(4)
    expect(s[3]!.detail).toContain('空の表')
  })

  it('★ 作った後は、入った冊の行数・書けなかった日・警告と、入らなかった冊の理由を出す', () => {
    const s = buildLitigationZipSummary({
      chunks,
      results: [res({}), res({ missingCount: 2, warningsCount: 3, rows: null }), res({ status: 'empty', message: 'この期間に運行が 0 件' })],
      ...base,
      changesCsv: { filename: '変更記録.csv', finished: true, rows: 5 },
    })
    expect(s[0]).toEqual({ filename: '9101_2022-12-2023-11.xlsx', state: 'included', detail: '2022-12〜2023-11 (乗務員 9101) — 250 行' })
    expect(s[1]!.detail).toBe('2023-12〜2024-11 (乗務員 9101) — テンプレに書けなかった日 2 日 / 警告 3 件')
    expect(s[2]).toMatchObject({ state: 'excluded', detail: '2024-12〜2025-11 (乗務員 9101) — 入らない: この期間に運行が 0 件' })
    expect(s[3]!.detail).toBe('変更 5 件')
  })
})

describe('月ごとの時間の表 — 給与比較と同じ wage report の月の区分から作る (Refs #1133 c1133-36)', () => {
  // 値はすべて架空。night は statutory の内数 (総労働時間には足さない)
  const MINUTES: WageRow['minutes'] = {
    statutory: 9000, overtime: 3000, night: 240, overtimeNight: 420,
    nonLegalHoliday: 300, nonLegalHolidayNight: 60, legalHoliday: 480, legalHolidayNight: 30, weekly40Excess: 510,
  }
  function wageRow(driverCd: string, over: { minutes?: unknown, wage?: Record<string, unknown>, row?: Partial<WageReportRow> } = {}): WageReportRow {
    const minutes = (over.minutes === undefined ? MINUTES : over.minutes) as WageRow['minutes']
    return {
      summary: { driverCd, driverName: '架空 太郎', workDays: 22, workingMinutes: 13800, days: [] },
      pay_kubun: 2,
      wage: {
        minutes,
        amounts: { statutory: 180000 },
        // overtimeMinutes = 時間外 + 週40超過、nightOvertimeMinutes = 時間外深夜 (relay が付ける)
        overtimeMinutes: 3510,
        nightOvertimeMinutes: 420,
        minWageOvertimePay: 14000,
        minWageNightOvertimePay: 1000,
        ...over.wage,
      },
      ...over.row,
    } as unknown as WageReportRow
  }
  const got = (month: string, rows: WageReportRow[]): LitigationFetched<WageReportResponse> =>
    ({ ok: true, value: { month, rows, no_data_drivers: [], warnings: [], restraint_source: 'gcp' } })
  const chunksOf = (fromMonth: string, toMonth: string, driverCd = '9101') =>
    buildLitigationOutputChunks({ fromMonth, toMonth, driverCds: [driverCd] })
  const NONE = new Map<string, string>()

  it('列は wage report の区分の並び (「法内残業」は出さない)', () => {
    expect(LITIGATION_HOURS_COLUMNS).toEqual(['法定時間内', '法外残業', 'うち月60h超', '法定外休日', '法定休日', '深夜 (内数)', '総労働時間'])
  })

  it('★ 区分 → 列: 法外残業 = 時間外 + 時間外深夜 + 週40超過、深夜は 4 区分の内数、総労働時間は night を除く 8 区分の和', () => {
    const [book] = buildLitigationHoursBooks(chunksOf('2024-06', '2024-06'), new Map([['9101|2024-06', got('2024-06', [wageRow('9101')])]]), NONE)
    expect(book!.rows).toEqual([{
      month: '2024-06',
      // 150:00 / 3000+420+510 / 3930−3600 / 300+60 / 480+30 / 240+420+60+30 / 9000+3000+420+510+300+60+480+30
      cells: ['150:00', '65:30', '5:30', '6:00', '8:30', '12:30', '230:00'],
      note: null,
    }])
    expect(book!.total).toEqual({ month: '合計 (1 か月ぶん)', cells: ['150:00', '65:30', '5:30', '6:00', '8:30', '12:30', '230:00'], note: null })
    expect(book).toMatchObject({ driverCd: '9101', label: '2024-06〜2024-06', valueMonths: 1, needsFetch: false, checkedAtText: null })
  })

  it('★ 「法定時間内」「法外残業」は、同じ wage report の行を給与比較 (compareSalaryMonth) に通した 法定時間内・残業時間 と同じ分数', () => {
    const report = wageRow('9101')
    const [book] = buildLitigationHoursBooks(chunksOf('2024-06', '2024-06'), new Map([['9101|2024-06', got('2024-06', [report])]]), NONE)
    const compared = compareSalaryMonth(
      [{ driverCd: '9101', cdKey: '9101', company: '0200', driverName: '架空 太郎', month: '2024-07', amounts: { 基本給: 200000 }, reportedTotal: 200000, rates: { base: 10000, overtime: 1500 } }] as unknown as Parameters<typeof compareSalaryMonth>[0],
      [report],
      { items: { 基本給: 'base' } } as unknown as Parameters<typeof compareSalaryMonth>[2],
      '2024-06',
    ).rows[0]!
    expect([compared.statutoryMinutes, compared.overtimeMinutes]).toEqual([9000, 3930])
    const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`
    expect(book!.rows[0]!.cells.slice(0, 2)).toEqual([hm(compared.statutoryMinutes), hm(compared.overtimeMinutes)])
  })

  it('★ 月 60h 超: 適用前の月 (〜2023-03) は「不適用」、適用後は超えたぶんだけ (超えていなければ 0:00)。合計は適用される月の超過ぶんだけ', () => {
    const under = wageRow('9101', { wage: { overtimeMinutes: 3000, nightOvertimeMinutes: 0 } })
    const books = buildLitigationHoursBooks(chunksOf('2023-03', '2023-05'), new Map([
      ['9101|2023-03', got('2023-03', [wageRow('9101')])],
      ['9101|2023-04', got('2023-04', [wageRow('9101')])],
      ['9101|2023-05', got('2023-05', [under])],
    ]), NONE)
    expect(books[0]!.rows.map(r => [r.month, r.cells[1], r.cells[2]])).toEqual([
      ['2023-03', '65:30', '不適用'],
      ['2023-04', '65:30', '5:30'],
      ['2023-05', '50:00', '0:00'],
    ])
    // 法外残業 65:30 + 65:30 + 50:00 / 60h 超は 2023-04 の 5:30 だけ
    expect(books[0]!.total!.cells.slice(1, 3)).toEqual(['181:00', '5:30'])
  })

  it('適用される月が 1 つも無い冊の合計は「不適用」', () => {
    const [book] = buildLitigationHoursBooks(chunksOf('2023-02', '2023-03'), new Map([
      ['9101|2023-02', got('2023-02', [wageRow('9101')])],
      ['9101|2023-03', got('2023-03', [wageRow('9101')])],
    ]), NONE)
    expect(book!.total!.cells[2]).toBe('不適用')
    expect(book!.total!.month).toBe('合計 (2 か月ぶん)')
  })

  it('★ 月の状態は 4 つ — 未取得 / 取得に失敗 / 拘束の記録なし / 欠測。値の在る月だけを合計し、合計行に月数を出す', () => {
    const [book] = buildLitigationHoursBooks(chunksOf('2024-06', '2024-11'), new Map<string, LitigationFetched<WageReportResponse>>([
      ['9101|2024-06', got('2024-06', [wageRow('9101')])],
      // 2024-07 はキーなし (未取得)
      ['9101|2024-08', { ok: false, reason: '504 (架空の理由)' }],
      ['9101|2024-09', got('2024-09', [])],
      ['9101|2024-10', got('2024-10', [wageRow('9101', { row: { restraint_missing: true } })])],
      ['9101|2024-11', got('2024-11', [wageRow('9101')])],
    ]), NONE)
    expect(book!.rows.map(r => [r.month, r.note, r.cells.length])).toEqual([
      ['2024-06', null, 7],
      ['2024-07', '未取得', 0],
      ['2024-08', '取得に失敗: 504 (架空の理由)', 0],
      ['2024-09', '拘束の記録なし', 0],
      ['2024-10', '欠測', 0],
      ['2024-11', null, 7],
    ])
    // 欠測の月 (区分は入っている) も 0 時間としても実値としても足さない: 2 か月ぶん = 230:00 × 2
    expect(book!.total).toEqual({ month: '合計 (2 か月ぶん)', cells: ['300:00', '131:00', '11:00', '12:00', '17:00', '25:00', '460:00'], note: null })
    expect(book).toMatchObject({ valueMonths: 2, needsFetch: true })
  })

  it('★ 「拘束の記録なし」「欠測」だけの冊は needsFetch が false (取り直しても同じなので「取ると出ます」を出さない)。値の在る月が無ければ合計行も無い', () => {
    const [book] = buildLitigationHoursBooks(chunksOf('2024-09', '2024-10'), new Map([
      ['9101|2024-09', got('2024-09', [])],
      ['9101|2024-10', got('2024-10', [wageRow('9101', { row: { restraint_missing: true } })])],
    ]), NONE)
    expect(book).toMatchObject({ needsFetch: false, valueMonths: 0, total: null })
    // 陽性対照: 未取得の月だけの冊は true
    expect(buildLitigationHoursBooks(chunksOf('2024-09', '2024-09'), new Map(), NONE)[0]).toMatchObject({ needsFetch: true, valueMonths: 0, total: null })
  })

  it.each<[string, Parameters<typeof wageRow>[1]]>([
    ['区分そのものが無い', { minutes: null }],
    ['区分が欠けている (法定時間内だけの古い形)', { minutes: { statutory: 9000 } }],
    ['区分が数でない', { minutes: { ...MINUTES, night: '240' } }],
    ['区分が NaN', { minutes: { ...MINUTES, legalHoliday: Number.NaN } }],
    ['残業時間 (時間外 + 週40超過) が無い', { wage: { overtimeMinutes: undefined } }],
    ['時間外深夜の時間が数でない', { wage: { nightOvertimeMinutes: null } }],
  ])('区分が読めない形の行は落ちずに「取得に失敗」と同じ扱い (合計に入れない・取り直しの対象): %s', (_name, over) => {
    const [book] = buildLitigationHoursBooks(chunksOf('2024-06', '2024-07'), new Map([
      ['9101|2024-06', got('2024-06', [wageRow('9101', over)])],
      ['9101|2024-07', got('2024-07', [wageRow('9101')])],
    ]), NONE)
    expect(book!.rows[0]).toEqual({ month: '2024-06', cells: [], note: '取得に失敗: 保存された区分が読めない形' })
    expect(book).toMatchObject({ valueMonths: 1, needsFetch: true })
    expect(book!.total!.cells[6]).toBe('230:00')
  })

  it('★ 冊ごとに、その冊の月・その乗務員の wage report だけを引く (「ZIP を作る」の結果には依らず、全部の冊を出す)', () => {
    const chunks = chunksOf('2024-01', '2025-01')
    const books = buildLitigationHoursBooks(chunks, new Map([
      ['9101|2024-12', got('2024-12', [wageRow('9101')])],
      ['9101|2025-01', got('2025-01', [wageRow('9101', { minutes: { ...MINUTES, statutory: 6000 } })])],
      // 別の乗務員のキーと、応答に混ざった別の乗務員の行は引かない
      ['9102|2024-01', got('2024-01', [wageRow('9102')])],
      ['9101|2024-02', got('2024-02', [wageRow('9102')])],
    ]), NONE)
    expect(books.map(b => [b.label, b.rows.length, b.valueMonths])).toEqual([['2024-01〜2024-12', 12, 1], ['2025-01〜2025-01', 1, 1]])
    expect(books[0]!.rows.map(r => r.note ?? r.cells[0])).toEqual([
      '未取得', '拘束の記録なし', '未取得', '未取得', '未取得', '未取得', '未取得', '未取得', '未取得', '未取得', '未取得', '150:00',
    ])
    expect(books[1]!.rows).toEqual([{ month: '2025-01', cells: ['100:00', '65:30', '5:30', '6:00', '8:30', '12:30', '180:00'], note: null }])
    expect(buildLitigationHoursBooks([], new Map(), NONE)).toEqual([])
  })

  it('★ 乗務員CD は給与比較と同じ比べ方 (数にして比べる): 応答の行の CD に先頭の 0 が付いていても値として出る (「拘束の記録なし」にしない)', () => {
    const [book] = buildLitigationHoursBooks(chunksOf('2024-06', '2024-07'), new Map([
      ['9101|2024-06', got('2024-06', [wageRow('09101')])],
      // 陽性対照: 別の乗務員の行は引かない
      ['9101|2024-07', got('2024-07', [wageRow('19101')])],
    ]), NONE)
    expect(book!.rows.map(r => r.note ?? r.cells[6])).toEqual(['230:00', '拘束の記録なし'])
    expect(book!.valueMonths).toBe(1)
  })

  it('最終取得は、その冊の月の wage report を取った時刻のうちいちばん新しいもの (JST)。ほかの検知の時刻・ほかの冊の月は見ない', () => {
    const chunks = chunksOf('2024-01', '2025-01')
    const checkedAt = new Map([
      ['wageReport|9101|2024-03', '2026-09-30T15:10:00.000Z'],
      ['wageReport|9101|2024-05', '2026-10-01T01:02:00.000Z'],
      ['wageReport|9101|2024-04', '2026-09-29T00:00:00.000Z'],
      ['alcOps|9101|2024-06', '2026-10-02T00:00:00.000Z'],
      ['wageReport|9102|2024-06', '2026-10-03T00:00:00.000Z'],
    ])
    const books = buildLitigationHoursBooks(chunks, new Map(), checkedAt)
    expect(books.map(b => b.checkedAtText)).toEqual(['2026-10-01 10:02', null])
  })
})
