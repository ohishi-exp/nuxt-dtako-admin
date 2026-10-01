/**
 * 訴訟準備の出力の版の pure ロジック (`app/utils/litigation-output-version.ts`、Refs #1133 c1133-34)。
 *
 * - 保存する結果 (`{v, chunks, results, changes}`) の組み立てと読み戻し。**形が 1 か所でも違えば
 *   全体を読めない扱い (null)** — 壊れた版の一部だけを「未実行」や 0 件に見せない
 * - 今の案件の区切りとの照合 (数・並び・乗務員・期間のどれが違っても不一致)
 * - 版の一覧の読み取り (読めない版は数える) と 1 行の整形
 *
 * 値はすべて架空。
 */
import { describe, it, expect } from 'vitest'
import {
  buildLitigationOutputSnapshot,
  fmtLitigationFileSize,
  LITIGATION_OUTPUT_CREATED_BY_UNKNOWN,
  LITIGATION_OUTPUT_RESULTS_MAX_CHARS,
  litigationOutputSnapshotChars,
  litigationOutputVersionRow,
  litigationSnapshotMatchesChunks,
  parseLitigationOutputSnapshot,
  parseLitigationOutputVersion,
  parseLitigationOutputVersions,
} from '~/utils/litigation-output-version'
import { buildLitigationOutputChunks, type LitigationOutputResult } from '~/utils/litigation-output'
import type { YKingakuMonth } from '~/utils/y-kingaku'

const CHUNKS = buildLitigationOutputChunks({ fromMonth: '2024-01', toMonth: '2025-01', driverCds: ['1001'] })

const KINGAKU: YKingakuMonth[] = [
  { from: '2024-01-01', to: '2024-01-31', statutoryIn: 60, statutoryOut: 120, over60: null, holiday: 0, night: 30, total: 9600 },
]

const OK: LitigationOutputResult = {
  driverCd: '1001',
  from: '2024-01-01',
  to: '2024-12-31',
  status: 'ok',
  rows: 12,
  missingDates: ['2024-02-03'],
  missingCount: 1,
  warnings: ['架空の警告'],
  warningsCount: 3,
  message: '12 行',
  kingaku: KINGAKU,
}

const FAILED: LitigationOutputResult = {
  driverCd: '1001',
  from: '2025-01-01',
  to: '2025-01-31',
  status: 'error',
  rows: null,
  missingDates: [],
  missingCount: 0,
  warnings: [],
  warningsCount: 0,
  message: '500 (架空の理由)',
  kingakuError: '集計できなかった',
}

/** relay を通った後の形 (JSON にして読み直す) */
function roundTrip(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v))
}

describe('buildLitigationOutputSnapshot / parseLitigationOutputSnapshot', () => {
  it('★ 組み立てた結果は JSON を通しても同じ値で読み戻る (null の冊は null のまま、区切りは乗務員と期間だけ)', () => {
    const snapshot = buildLitigationOutputSnapshot(CHUNKS, [OK, null], { finished: true, rows: 4 })
    expect(snapshot).toEqual({
      v: 1,
      chunks: [
        { driverCd: '1001', from: '2024-01-01', to: '2024-12-31' },
        { driverCd: '1001', from: '2025-01-01', to: '2025-01-31' },
      ],
      results: [OK, null],
      changes: { finished: true, rows: 4 },
    })
    expect(parseLitigationOutputSnapshot(roundTrip(snapshot))).toEqual(snapshot)
  })

  it('失敗の結果 (rows が null・集計できなかった理由つき) と、集計が空の結果も読み戻る', () => {
    const snapshot = buildLitigationOutputSnapshot(CHUNKS, [{ ...OK, kingaku: [] }, FAILED], { finished: false, rows: 0 })
    expect(parseLitigationOutputSnapshot(roundTrip(snapshot))).toEqual(snapshot)
  })

  it('組み立ては渡した配列を写す (後から元の配列を書き換えても保存する値は変わらない)', () => {
    const results: (LitigationOutputResult | null)[] = [OK, null]
    const snapshot = buildLitigationOutputSnapshot(CHUNKS, results, { finished: true, rows: 1 })
    results[1] = FAILED
    expect(snapshot.results).toEqual([OK, null])
  })

  const good = () => roundTrip(buildLitigationOutputSnapshot(CHUNKS, [OK, FAILED], { finished: true, rows: 4 })) as Record<string, any>

  it.each<[string, (s: Record<string, any>) => unknown]>([
    ['relay が読めなかった行 (null)', () => null],
    ['オブジェクトでない', () => 'x'],
    ['配列', () => []],
    ['形の版が違う', s => ({ ...s, v: 2 })],
    ['chunks が配列でない', s => ({ ...s, chunks: {} })],
    ['results が配列でない', s => ({ ...s, results: {} })],
    ['区切りと結果の数が合わない', s => ({ ...s, results: [s.results[0]] })],
    ['区切りがオブジェクトでない', s => ({ ...s, chunks: ['x', s.chunks[1]] })],
    ['区切りの乗務員が文字列でない', s => ({ ...s, chunks: [{ ...s.chunks[0], driverCd: 1001 }, s.chunks[1]] })],
    ['区切りの開始が無い', s => ({ ...s, chunks: [{ driverCd: '1001', to: '2024-12-31' }, s.chunks[1]] })],
    ['区切りの終了が無い', s => ({ ...s, chunks: [{ driverCd: '1001', from: '2024-01-01' }, s.chunks[1]] })],
    ['結果がオブジェクトでない', s => ({ ...s, results: ['x', s.results[1]] })],
    ['結果の乗務員が無い', s => ({ ...s, results: [{ ...s.results[0], driverCd: undefined }, s.results[1]] })],
    ['結果の開始が無い', s => ({ ...s, results: [{ ...s.results[0], from: 1 }, s.results[1]] })],
    ['結果の終了が無い', s => ({ ...s, results: [{ ...s.results[0], to: null }, s.results[1]] })],
    ['結果の文が無い', s => ({ ...s, results: [{ ...s.results[0], message: undefined }, s.results[1]] })],
    ['知らない状態', s => ({ ...s, results: [{ ...s.results[0], status: 'done' }, s.results[1]] })],
    ['行数が負', s => ({ ...s, results: [{ ...s.results[0], rows: -1 }, s.results[1]] })],
    ['行数が文字列', s => ({ ...s, results: [{ ...s.results[0], rows: '12' }, s.results[1]] })],
    ['書けなかった日が配列でない', s => ({ ...s, results: [{ ...s.results[0], missingDates: '2024-02-03' }, s.results[1]] })],
    ['書けなかった日に文字列でないもの', s => ({ ...s, results: [{ ...s.results[0], missingDates: [20240203] }, s.results[1]] })],
    ['書けなかった日の数が小数', s => ({ ...s, results: [{ ...s.results[0], missingCount: 1.5 }, s.results[1]] })],
    ['警告が配列でない', s => ({ ...s, results: [{ ...s.results[0], warnings: null }, s.results[1]] })],
    ['警告の数が無い', s => ({ ...s, results: [{ ...s.results[0], warningsCount: undefined }, s.results[1]] })],
    ['集計できなかった理由が文字列でない', s => ({ ...s, results: [s.results[0], { ...s.results[1], kingakuError: 1 }] })],
    ['集計が配列でない', s => ({ ...s, results: [{ ...s.results[0], kingaku: {} }, s.results[1]] })],
    ['集計の行がオブジェクトでない', s => ({ ...s, results: [{ ...s.results[0], kingaku: ['x'] }, s.results[1]] })],
    ['集計の行の欄が欠けている', s => ({ ...s, results: [{ ...s.results[0], kingaku: [{ ...KINGAKU[0], total: undefined }] }, s.results[1]] })],
    ['changes が無い', s => ({ ...s, changes: undefined })],
    ['changes.finished が真偽値でない', s => ({ ...s, changes: { finished: 'yes', rows: 1 } })],
    ['changes.rows が数でない', s => ({ ...s, changes: { finished: true, rows: '1' } })],
  ])('★ 読めない形は全体を null にする: %s', (_name, breakIt) => {
    // 陽性対照: 壊す前は読める
    expect(parseLitigationOutputSnapshot(good())).not.toBeNull()
    expect(parseLitigationOutputSnapshot(breakIt(good()))).toBeNull()
  })

  it('文字数は relay と同じ数え方 (JSON.stringify の長さ) で、上限は 500,000', () => {
    const snapshot = buildLitigationOutputSnapshot(CHUNKS, [OK, null], { finished: true, rows: 4 })
    expect(litigationOutputSnapshotChars(snapshot)).toBe(JSON.stringify(snapshot).length)
    expect(LITIGATION_OUTPUT_RESULTS_MAX_CHARS).toBe(500_000)
  })
})

describe('litigationSnapshotMatchesChunks', () => {
  const snapshot = buildLitigationOutputSnapshot(CHUNKS, [OK, null], { finished: false, rows: 0 })

  it('★ 同じ案件の区切りなら一致', () => {
    expect(litigationSnapshotMatchesChunks(snapshot, CHUNKS)).toBe(true)
  })

  it.each([
    ['期間を縮めた (区切りの数が違う)', { fromMonth: '2024-01', toMonth: '2024-12', driverCds: ['1001'] }],
    ['乗務員を変えた', { fromMonth: '2024-01', toMonth: '2025-01', driverCds: ['1002'] }],
    ['開始月をずらした (開始が違う)', { fromMonth: '2024-02', toMonth: '2025-02', driverCds: ['1001'] }],
    ['終了月を延ばした (最後の冊の終了だけ違う)', { fromMonth: '2024-01', toMonth: '2025-02', driverCds: ['1001'] }],
  ])('★ %s → 不一致', (_name, edited) => {
    expect(litigationSnapshotMatchesChunks(snapshot, buildLitigationOutputChunks(edited))).toBe(false)
  })
})

describe('版の一覧', () => {
  const VERSION = {
    versionId: '20260930T030000Z-abcdef',
    createdAt: '2026-09-30T03:00:00.000Z',
    createdBy: 'someone@example.com',
    files: [
      { name: '1001_2024-01-2024-12.xlsx', label: '1001_2024-01-2024-12.xlsx', size: 4 * 1024 * 1024, sha256: 'x', uploadedAt: '2026-09-30T03:00:01.000Z' },
      { name: 'changes.csv', label: '変更記録.csv', size: 300, sha256: 'y', uploadedAt: '2026-09-30T03:00:02.000Z' },
    ],
  }

  it('★ 版を読む (画面が使う欄だけを写す。出力した人が null の版も読める)', () => {
    expect(parseLitigationOutputVersion(VERSION)).toEqual({
      versionId: VERSION.versionId,
      createdAt: VERSION.createdAt,
      createdBy: 'someone@example.com',
      files: [
        { name: '1001_2024-01-2024-12.xlsx', label: '1001_2024-01-2024-12.xlsx', size: 4 * 1024 * 1024 },
        { name: 'changes.csv', label: '変更記録.csv', size: 300 },
      ],
    })
    expect(parseLitigationOutputVersion({ ...VERSION, createdBy: null, files: [] })).toEqual({
      versionId: VERSION.versionId, createdAt: VERSION.createdAt, createdBy: null, files: [],
    })
  })

  it.each<[string, unknown]>([
    ['オブジェクトでない', null],
    ['versionId が無い', { ...VERSION, versionId: undefined }],
    ['createdAt が文字列でない', { ...VERSION, createdAt: 1 }],
    ['出力した人が数', { ...VERSION, createdBy: 1 }],
    ['files が配列でない', { ...VERSION, files: null }],
    ['ファイルがオブジェクトでない', { ...VERSION, files: ['x'] }],
    ['ファイルの名前が無い', { ...VERSION, files: [{ label: 'a', size: 1 }] }],
    ['ファイルの label が無い', { ...VERSION, files: [{ name: 'a.xlsx', size: 1 }] }],
    ['ファイルの大きさが負', { ...VERSION, files: [{ name: 'a.xlsx', label: 'a.xlsx', size: -1 }] }],
  ])('読めない版は null: %s', (_name, raw) => {
    expect(parseLitigationOutputVersion(raw)).toBeNull()
  })

  it('★ 一覧は relay の並びのまま。読めない版は落とさず数える', () => {
    const older = { ...VERSION, versionId: 'older', createdAt: '2026-09-29T03:00:00.000Z' }
    expect(parseLitigationOutputVersions({ versions: [VERSION, { versionId: 1 }, older] })).toEqual({
      versions: [parseLitigationOutputVersion(VERSION), parseLitigationOutputVersion(older)],
      unreadable: 1,
    })
    expect(parseLitigationOutputVersions({ versions: [] })).toEqual({ versions: [], unreadable: 0 })
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['versions が無い', {}],
    ['versions が配列でない', { versions: 'x' }],
  ])('一覧の応答そのものの形が違えば null: %s', (_name, raw) => {
    expect(parseLitigationOutputVersions(raw)).toBeNull()
  })

  it('★ 1 行の整形: 日時は JST、Excel の冊数は .xlsx の数、大きさは合計', () => {
    expect(litigationOutputVersionRow(parseLitigationOutputVersion(VERSION)!)).toEqual({
      createdAtText: '2026-09-30 12:00',
      createdBy: 'someone@example.com',
      excelCount: 1,
      fileCount: 2,
      sizeText: '4.0 MB',
    })
  })

  it('出力した人が無い版は「不明」、ファイルが無い版は 0 冊・0 個・0 B', () => {
    expect(litigationOutputVersionRow({ versionId: 'v', createdAt: '2026-09-30T03:00:00.000Z', createdBy: null, files: [] })).toEqual({
      createdAtText: '2026-09-30 12:00',
      createdBy: LITIGATION_OUTPUT_CREATED_BY_UNKNOWN,
      excelCount: 0,
      fileCount: 0,
      sizeText: '0 B',
    })
  })

  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1024 * 1024 - 1, '1024.0 KB'],
    [1024 * 1024, '1.0 MB'],
    [4.5 * 1024 * 1024, '4.5 MB'],
  ])('大きさ %d バイト → %s', (bytes, text) => {
    expect(fmtLitigationFileSize(bytes)).toBe(text)
  })
})
