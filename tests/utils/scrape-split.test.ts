import { describe, expect, it } from 'vitest'
import {
  ETAGS_MAX_RANGE_DAYS,
  countMissingCsv,
  formatMissingCsv,
  formatSplitAllDone,
  formatUnsplitTotal,
  initialSplitStatus,
  parseSplitCsvResponse,
  splitLineClass,
  unsplitCheckRange,
} from '~/utils/scrape-split'

describe('initialSplitStatus', () => {
  it('marks a missing split_failed as unknown, not as success', () => {
    const s = initialSplitStatus({ upload_id: 'u-1' })
    expect(s?.state).toBe('unknown')
    expect(s?.message).toContain('不明')
  })

  it('says nothing when there is no upload to talk about (アップロード skip / 旧 relay)', () => {
    // 毎行に黄色い「不明」を出すと本物の失敗が埋もれるので、根拠が無い時は黙る
    expect(initialSplitStatus({})).toBeNull()
    expect(initialSplitStatus({ upload_id: '' })).toBeNull()
  })

  it('reports 0 failures plainly', () => {
    expect(initialSplitStatus({ upload_id: 'u-1', split_failed: 0 }))
      .toEqual({ state: 'ok', message: 'CSV分割: 失敗 0 件' })
  })

  it('says the split is unfinished and what to do next (自社の分・ほかの会社の分)', () => {
    const want = {
      state: 'failed',
      message: 'CSV分割が未完です (2 件。この運行は読み取り側から消えます)。自社の分は「未分割をまとめて分割」を、ほかの会社の分は、その会社の取り込みをもう一度実行してください',
    }
    // upload_id が分かっていても、いなくても同じ表示 (状態は 1 つ)
    expect(initialSplitStatus({ upload_id: 'u-1', split_failed: 2 })).toEqual(want)
    expect(initialSplitStatus({ split_failed: 2 })).toEqual(want)
  })
})

describe('parseSplitCsvResponse', () => {
  it('reads split_failed out of the response', () => {
    expect(parseSplitCsvResponse({ status: 'ok', split_failed: 2 })).toBe(2)
    expect(parseSplitCsvResponse({ status: 'ok', split_failed: 0 })).toBe(0)
  })

  it('returns null when absent / not a number / not an object', () => {
    expect(parseSplitCsvResponse({ status: 'ok' })).toBeNull()
    expect(parseSplitCsvResponse({ split_failed: '2' })).toBeNull()
    expect(parseSplitCsvResponse({ split_failed: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseSplitCsvResponse(null)).toBeNull()
    expect(parseSplitCsvResponse(undefined)).toBeNull()
  })
})

describe('formatSplitAllDone', () => {
  it('shows candidates / processed / success / failed', () => {
    expect(formatSplitAllDone({ candidates: 3, total: 3, success: 3, failed: 0, skipped: 0 }))
      .toBe('候補 3 件 / 処理 3 件 (成功 3 / 失敗 0)')
  })

  it('never hides the 50-item cap — skipped が出たら再実行を促す', () => {
    const msg = formatSplitAllDone({ candidates: 120, total: 50, success: 48, failed: 2, skipped: 70 })
    expect(msg).toContain('候補 120 件')
    expect(msg).toContain('残り 70 件')
    expect(msg).toContain('上限 (50 件)')
  })

  it('falls back to success + failed when total is absent', () => {
    expect(formatSplitAllDone({ candidates: 2, success: 1, failed: 1 }))
      .toBe('候補 2 件 / 処理 2 件 (成功 1 / 失敗 1)')
    expect(formatSplitAllDone({})).toBe('候補 0 件 / 処理 0 件 (成功 0 / 失敗 0)')
  })
})

describe('unsplitCheckRange', () => {
  it('spans the earliest to the latest scraped date', () => {
    expect(unsplitCheckRange(['2026-07-03', '2026-07-01', '2026-07-02']))
      .toEqual({ from: '2026-07-01', to: '2026-07-03' })
  })

  it('handles a single day', () => {
    expect(unsplitCheckRange(['2026-07-01'])).toEqual({ from: '2026-07-01', to: '2026-07-01' })
  })

  it('returns null for no dates', () => {
    expect(unsplitCheckRange([])).toBeNull()
    expect(unsplitCheckRange([''])).toBeNull()
  })

  it('accepts exactly the alc limit and rejects one more (40 日)', () => {
    expect(ETAGS_MAX_RANGE_DAYS).toBe(40)
    // 2026-07-01 〜 2026-08-09 = 40 日ちょうど
    expect(unsplitCheckRange(['2026-07-01', '2026-08-09']))
      .toEqual({ from: '2026-07-01', to: '2026-08-09' })
    // 41 日は alc が 400 を返すので問い合わせない
    expect(unsplitCheckRange(['2026-07-01', '2026-08-10'])).toBeNull()
  })

  it('returns null for unparseable dates instead of sending a bad range', () => {
    expect(unsplitCheckRange(['not-a-date', 'also-bad'])).toBeNull()
  })
})

describe('formatUnsplitTotal', () => {
  it('shouts when unsplit operations remain', () => {
    const line = formatUnsplitTotal({ from: '2026-07-01', to: '2026-07-01' }, 1)
    expect(line.level).toBe('error')
    expect(line.text).toContain('1 件残っています')
    expect(line.text).toContain('2026-07-01')
    expect(line.text).toContain('まとめて分割')
  })

  it('always says the count is tenant-scoped (0 件でも「全部大丈夫」と読ませない)', () => {
    const ok = formatUnsplitTotal({ from: '2026-07-01', to: '2026-07-03' }, 0)
    expect(ok.level).toBe('info')
    expect(ok.text).toContain('2026-07-01〜2026-07-03')
    expect(ok.text).toContain('ログイン中のテナント')
    expect(formatUnsplitTotal({ from: '2026-07-01', to: '2026-07-01' }, 2).text)
      .toContain('ログイン中のテナント')
  })
})

describe('splitLineClass', () => {
  it('keeps failures visually loud and successes quiet', () => {
    expect(splitLineClass('ok')).toContain('text-gray-500')
    expect(splitLineClass('unknown')).toContain('text-amber-600')
    expect(splitLineClass('failed')).toContain('font-bold')
    expect(splitLineClass('failed')).toContain('text-red-600')
  })
})

describe('countMissingCsv', () => {
  it('counts items whose etag is null (= R2 に CSV が無い)', () => {
    expect(countMissingCsv([
      { unko_no: 'a', etag: '"abc"' },
      { unko_no: 'b', etag: null },
      { unko_no: 'c', etag: '"def"' },
      { unko_no: 'd', etag: null },
    ])).toEqual({ missing: 2, total: 4 })
  })

  it('未分割 (unsplit_total) とは母集団が違う — items は has_kudgivt = TRUE だけ', () => {
    // #621 の 2026-03 と同型: 未分割 0 件でも etag無 は 0 にならない。
    expect(countMissingCsv([{ etag: null }])).toEqual({ missing: 1, total: 1 })
  })

  it('returns 0/0 for an empty array (母集団ゼロ — 「見ていない」とは区別する)', () => {
    expect(countMissingCsv([])).toEqual({ missing: 0, total: 0 })
  })

  it('returns null when items is not an array (見ていない を 0 件に倒さない)', () => {
    expect(countMissingCsv(undefined)).toBeNull()
    expect(countMissingCsv(null)).toBeNull()
    expect(countMissingCsv({ items: [] })).toBeNull()
  })

  it('counts an item that is not an object as missing (安全側に倒す)', () => {
    expect(countMissingCsv([null, undefined, { etag: '"abc"' }, {}]))
      .toEqual({ missing: 3, total: 4 })
  })
})

describe('formatMissingCsv', () => {
  const range = { from: '2026-03-01', to: '2026-03-31' }

  it('shouts when operations have no CSV in R2', () => {
    const line = formatMissingCsv(range, { missing: 31, total: 1130 })
    expect(line.level).toBe('error')
    expect(line.text).toContain('31 件')
    expect(line.text).toContain('1130 件中')
    expect(line.text).toContain('2026-03-01〜2026-03-31')
    expect(line.text).toContain('ログイン中のテナント')
  })

  it('says 「0 件」 and the population when there is no gap (空欄・「なし」で済ませない)', () => {
    const line = formatMissingCsv(range, { missing: 0, total: 1130 })
    expect(line.level).toBe('info')
    expect(line.text).toContain('無い運行 0 件')
    expect(line.text).toContain('1130 件を確認')
    expect(line.text).toContain('ログイン中のテナント')
  })

  it('does not claim "穴なし" when the population is empty', () => {
    const line = formatMissingCsv(range, { missing: 0, total: 0 })
    expect(line.level).toBe('info')
    expect(line.text).toContain('確認する対象がありません')
    expect(line.text).not.toContain('無い運行 0 件')
  })

  it('says 見ていない (not 0 件) when items was missing', () => {
    const line = formatMissingCsv(range, null)
    expect(line.level).toBe('info')
    expect(line.text).toContain('確認できませんでした')
    expect(line.text).toContain('items')
    expect(line.text).not.toContain('0 件')
  })

  it('collapses the period to a single date for a 1 日 range', () => {
    expect(formatMissingCsv({ from: '2026-03-01', to: '2026-03-01' }, { missing: 0, total: 3 }).text)
      .toContain('(2026-03-01、')
  })

  it('未分割の行と同じ文言にしない (別勘定だと読めること)', () => {
    const missing = formatMissingCsv(range, { missing: 1, total: 10 }).text
    const unsplit = formatUnsplitTotal(range, 1).text
    expect(missing).not.toBe(unsplit)
    expect(missing).not.toContain('未分割')
    expect(unsplit).not.toContain('R2 に CSV')
  })
})
