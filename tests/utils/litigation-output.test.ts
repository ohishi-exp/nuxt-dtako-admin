/**
 * 訴訟準備の「出力」タブの pure ロジック (`app/utils/litigation-output.ts`、Refs #1133 c1133-2)。
 *
 * - 案件 → 区切り (乗務員 1 名 × 最大 12 か月) の切り方と、ファイル名・ZIP 名
 * - 応答 → 結果の 4 分類。**「0 件」「未登録」「失敗」を同じ見た目にしない** (map skill
 *   「PR の基準」(7)) ことを、404 が 2 種類あるケースも含めて固定する
 */
import { describe, it, expect } from 'vitest'
import {
  buildLitigationOutputChunks,
  countLitigationResults,
  litigationResultFromFailure,
  litigationResultFromHeaders,
  litigationZipFilename,
  LITIGATION_EMPTY_MESSAGE,
  LITIGATION_NOT_FOUND_MESSAGE,
  type LitigationOutputChunk,
} from '~/utils/litigation-output'

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

  it('★ rows 0 は empty で「運行 0 件 (alc に取り込まれていない可能性)」と言う', () => {
    const r = litigationResultFromHeaders(CHUNK, headers({ 'x-y-time-rows': '0', 'x-y-time-missing-count': '0', 'x-y-time-warnings-count': '0' }))
    expect(r.status).toBe('empty')
    expect(r.rows).toBe(0)
    expect(r.message).toBe(LITIGATION_EMPTY_MESSAGE)
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
