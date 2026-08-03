import { describe, it, expect } from 'vitest'
import {
  buildKintaiDiffPrescriptions,
  fmtKintaiDiffCount,
  fmtKintaiRefreshMysqlGuarantee,
  foldProgressAppend,
  foldProgressInitial,
  parseKintaiDiffApiResponse,
  parseKintaiDiffObservations,
  parseKintaiDiffSummary,
  parseKintaiFoldPage,
  parseKintaiRefreshMysqlApplyResult,
  parseKintaiRefreshMysqlGuarantee,
  parseKintaiRefreshMysqlPreview,
  parseKintaiWindowReport,
} from '~/utils/kintai-diff-view'

function diffBody(over: Record<string, unknown> = {}) {
  return {
    month: '2026-06',
    diff: {
      gcp_rows: 100,
      onprem_rows: 98,
      onprem_unreadable: false,
      only_gcp: { total: 3, capped: false },
      only_onprem_driver0: { total: 5, capped: false },
      only_onprem_other: { total: 0, capped: false },
      value_diff_restraint_match: { total: 1, capped: false },
      value_diff_restraint_mismatch: { total: 0, capped: false },
    },
    observations: {
      stale_drivers: 0,
      fold_would_write_drivers: 0,
      warnings: ['dtako 入力欠け: 乗務員12名の末尾が16日超'],
      unko_diff_gcp_only_in_month: 417,
      next_after_driver_cd: null,
    },
    observations_error: null,
    ...over,
  }
}

describe('parseKintaiDiffSummary', () => {
  it('month が無い応答は null', () => {
    expect(parseKintaiDiffSummary({})).toBeNull()
    expect(parseKintaiDiffSummary(null)).toBeNull()
    expect(parseKintaiDiffSummary('x')).toBeNull()
  })

  it('5区分 + 行数を camelCase に読み替える', () => {
    const s = parseKintaiDiffSummary(diffBody())
    expect(s).toMatchObject({
      month: '2026-06',
      gcpRows: 100,
      onpremRows: 98,
      onpremUnreadable: false,
      onlyGcp: { total: 3, capped: false },
      onlyOnpremDriver0: { total: 5, capped: false },
      valueDiffRestraintMatch: { total: 1, capped: false },
    })
  })

  it('欠けたフィールドは 0/false に倒す (undefined 安全)', () => {
    const s = parseKintaiDiffSummary({ month: '2026-06', diff: {} })
    expect(s).toMatchObject({
      gcpRows: 0,
      onpremRows: 0,
      onpremUnreadable: false,
      onlyGcp: { total: 0, capped: false },
    })
  })

  it('capped を拾う', () => {
    const s = parseKintaiDiffSummary(diffBody({ diff: { ...diffBody().diff, only_gcp: { total: 600, capped: true } } }))
    expect(s?.onlyGcp).toEqual({ total: 600, capped: true })
  })
})

describe('fmtKintaiDiffCount', () => {
  it('capped でなければそのまま数字', () => {
    expect(fmtKintaiDiffCount({ total: 3, capped: false })).toBe('3')
  })
  it('capped なら上限表記を添える (黙って切らない)', () => {
    expect(fmtKintaiDiffCount({ total: 500, capped: true })).toBe('500+ (表示は500件まで)')
  })
})

describe('parseKintaiDiffObservations', () => {
  it('null/非object は null', () => {
    expect(parseKintaiDiffObservations(null)).toBeNull()
    expect(parseKintaiDiffObservations('x')).toBeNull()
  })

  it('観測値を読む。黙って空にしない (observations_error は呼び出し側が別に持つ)', () => {
    const o = parseKintaiDiffObservations(diffBody().observations)
    expect(o).toEqual({
      staleDrivers: 0,
      foldWouldWriteDrivers: 0,
      warnings: ['dtako 入力欠け: 乗務員12名の末尾が16日超'],
      unkoDiffGcpOnlyInMonth: 417,
    })
  })

  it('欠けたフィールドは null/[] に倒す', () => {
    expect(parseKintaiDiffObservations({})).toEqual({
      staleDrivers: null,
      foldWouldWriteDrivers: null,
      warnings: [],
      unkoDiffGcpOnlyInMonth: null,
    })
  })

  it('warnings の非文字列要素は落とす', () => {
    const o = parseKintaiDiffObservations({ warnings: ['a', 1, null, 'b'] })
    expect(o?.warnings).toEqual(['a', 'b'])
  })
})

describe('parseKintaiDiffApiResponse', () => {
  it('month/diff/observations/observations_error を一括で読む', () => {
    const r = parseKintaiDiffApiResponse(diffBody())
    expect(r.summary?.month).toBe('2026-06')
    expect(r.observations?.unkoDiffGcpOnlyInMonth).toBe(417)
    expect(r.observationsError).toBeNull()
  })

  it('observations が null のとき observations_error を拾う (黙って空にしない)', () => {
    const r = parseKintaiDiffApiResponse(diffBody({ observations: null, observations_error: 'GCP recalc dry-run 失敗: status 502' }))
    expect(r.observations).toBeNull()
    expect(r.observationsError).toBe('GCP recalc dry-run 失敗: status 502')
  })
})

describe('buildKintaiDiffPrescriptions', () => {
  it('観測値が全部 0 なら relevant は全部 false (原因を断定しない — 候補を列挙するだけ)', () => {
    const ps = buildKintaiDiffPrescriptions(
      parseKintaiDiffSummary({ month: '2026-06', diff: {} }),
      parseKintaiDiffObservations({}),
    )
    expect(ps.map(p => p.key)).toEqual(['fold', 'timecard', 'mysql'])
    expect(ps.every(p => !p.relevant)).toBe(true)
  })

  it('stale_drivers > 0 で fold が relevant になる', () => {
    const ps = buildKintaiDiffPrescriptions(null, parseKintaiDiffObservations({ stale_drivers: 2 }))
    expect(ps.find(p => p.key === 'fold')?.relevant).toBe(true)
  })

  it('fold_would_write_drivers > 0 でも fold が relevant になる', () => {
    const ps = buildKintaiDiffPrescriptions(null, parseKintaiDiffObservations({ fold_would_write_drivers: 5 }))
    expect(ps.find(p => p.key === 'fold')?.relevant).toBe(true)
  })

  it('only_onprem_other > 0 で timecard が relevant になる (driver0 は含めない)', () => {
    const summary = parseKintaiDiffSummary({
      month: '2026-06',
      diff: { only_onprem_other: { total: 4, capped: false }, only_onprem_driver0: { total: 99, capped: false } },
    })
    const ps = buildKintaiDiffPrescriptions(summary, null)
    expect(ps.find(p => p.key === 'timecard')?.relevant).toBe(true)
  })

  it('only_onprem_driver0 だけでは timecard は relevant にならない (意図的除外は欠けではない)', () => {
    const summary = parseKintaiDiffSummary({
      month: '2026-06',
      diff: { only_onprem_driver0: { total: 99, capped: false } },
    })
    const ps = buildKintaiDiffPrescriptions(summary, null)
    expect(ps.find(p => p.key === 'timecard')?.relevant).toBe(false)
  })

  it('unko_diff_gcp_only_in_month > 0 または only_gcp > 0 で mysql が relevant になる', () => {
    const ps1 = buildKintaiDiffPrescriptions(null, parseKintaiDiffObservations({ unko_diff_gcp_only_in_month: 10 }))
    expect(ps1.find(p => p.key === 'mysql')?.relevant).toBe(true)

    const summary = parseKintaiDiffSummary({ month: '2026-06', diff: { only_gcp: { total: 2, capped: false } } })
    const ps2 = buildKintaiDiffPrescriptions(summary, null)
    expect(ps2.find(p => p.key === 'mysql')?.relevant).toBe(true)
  })

  it('mysql の候補文言に「保証はありません」が入っている (押せば直ると誤読させない)', () => {
    const ps = buildKintaiDiffPrescriptions(null, null)
    expect(ps.find(p => p.key === 'mysql')?.action).toContain('保証はありません')
  })
})

describe('parseKintaiWindowReport (打刻の運び直し)', () => {
  it('camelCase の応答をそのまま読む', () => {
    const r = parseKintaiWindowReport({
      months: ['2026-05', '2026-06'],
      drivers: 40,
      events: 12000,
      driversWritten: 0,
      daysWritten: 0,
      daysDeleted: 0,
      misplaced: 0,
      unknownStates: [],
      dryRun: true,
    })
    expect(r).toMatchObject({ months: ['2026-05', '2026-06'], driversWritten: 0, dryRun: true })
  })

  it('null/非object は null', () => {
    expect(parseKintaiWindowReport(null)).toBeNull()
    expect(parseKintaiWindowReport('x')).toBeNull()
  })

  it('欠けたフィールドは 0/[]/false に倒す', () => {
    expect(parseKintaiWindowReport({})).toEqual({
      months: [],
      drivers: 0,
      events: 0,
      driversWritten: 0,
      daysWritten: 0,
      daysDeleted: 0,
      misplaced: 0,
      unknownStates: [],
      dryRun: false,
    })
  })
})

describe('parseKintaiFoldPage (畳み直し 1ページぶん)', () => {
  it('fold.drivers_written / stale.drivers / next_after_driver_cd を読む', () => {
    const p = parseKintaiFoldPage({
      stale: { drivers: 3 },
      fold: { drivers_written: 12, warnings: ['w1'] },
      next_after_driver_cd: 1078,
    })
    expect(p).toEqual({ driversWritten: 12, staleDrivers: 3, warnings: ['w1'], nextAfterDriverCd: 1078 })
  })

  it('next_after_driver_cd が無ければ null = 回りきった', () => {
    const p = parseKintaiFoldPage({ fold: { drivers_written: 0 } })
    expect(p.nextAfterDriverCd).toBeNull()
  })

  it('drivers_written はトップレベルにも fallback する', () => {
    const p = parseKintaiFoldPage({ drivers_written: 7 })
    expect(p.driversWritten).toBe(7)
  })

  it('warnings はトップレベル優先、無ければ fold 配下', () => {
    expect(parseKintaiFoldPage({ warnings: ['top'], fold: { warnings: ['nested'] } }).warnings).toEqual(['top'])
    expect(parseKintaiFoldPage({ fold: { warnings: ['nested'] } }).warnings).toEqual(['nested'])
  })
})

describe('foldProgressInitial / foldProgressAppend', () => {
  it('初期値は 0 ページ・未完了', () => {
    expect(foldProgressInitial()).toEqual({ pages: 0, driversWrittenTotal: 0, warnings: [], done: false })
  })

  it('ページを積むと合計が進む。next が null で done になる', () => {
    let progress = foldProgressInitial()
    progress = foldProgressAppend(progress, { driversWritten: 10, staleDrivers: 2, warnings: ['a'], nextAfterDriverCd: 5 })
    expect(progress).toMatchObject({ pages: 1, driversWrittenTotal: 10, done: false })
    progress = foldProgressAppend(progress, { driversWritten: 3, staleDrivers: 0, warnings: ['a', 'b'], nextAfterDriverCd: null })
    expect(progress).toEqual({ pages: 2, driversWrittenTotal: 13, warnings: ['a', 'b'], done: true })
  })

  it('warnings は重複を積まない', () => {
    let progress = foldProgressInitial()
    progress = foldProgressAppend(progress, { driversWritten: 1, staleDrivers: null, warnings: ['dup'], nextAfterDriverCd: 1 })
    progress = foldProgressAppend(progress, { driversWritten: 1, staleDrivers: null, warnings: ['dup'], nextAfterDriverCd: null })
    expect(progress.warnings).toEqual(['dup'])
  })
})

describe('parseKintaiRefreshMysqlGuarantee / parseKintaiRefreshMysqlPreview', () => {
  it('kind: mismatch のときだけ guaranteed', () => {
    expect(parseKintaiRefreshMysqlGuarantee({ found: true, kind: 'mismatch', guaranteed: true })).toEqual({
      found: true,
      kind: 'mismatch',
      guaranteed: true,
    })
  })

  it('dtako_missing は guaranteed: false', () => {
    expect(parseKintaiRefreshMysqlGuarantee({ found: true, kind: 'dtako_missing', guaranteed: false })?.guaranteed).toBe(false)
  })

  it('null/非object は null', () => {
    expect(parseKintaiRefreshMysqlGuarantee(null)).toBeNull()
  })

  it('preview 全体 (dry-run 応答) を読む', () => {
    const p = parseKintaiRefreshMysqlPreview({
      dry_run: true,
      ope_no: '1234567890123456789012',
      start_ope: '2026/06/01 9:00:00',
      unko_no: '12345678901234567890123',
      guarantee: { found: true, kind: 'mismatch', guaranteed: true },
      guarantee_error: null,
    })
    expect(p).toEqual({
      opeNo: '1234567890123456789012',
      startOpe: '2026/06/01 9:00:00',
      unkoNo: '12345678901234567890123',
      guarantee: { found: true, kind: 'mismatch', guaranteed: true },
      guaranteeError: null,
    })
  })

  it('guarantee_error があれば拾う', () => {
    const p = parseKintaiRefreshMysqlPreview({ guarantee_error: 'オンプレの取得先が未設定です' })
    expect(p.guaranteeError).toBe('オンプレの取得先が未設定です')
    expect(p.guarantee).toBeNull()
  })
})

describe('parseKintaiRefreshMysqlApplyResult (実行成功応答)', () => {
  it('bytes/entries/http_status を読む', () => {
    const r = parseKintaiRefreshMysqlApplyResult({
      bytes: 12345,
      entries: ['a.csv', 'b.csv'],
      http_status: 200,
      autoload: { http_status: 200, reset_http_status: 302 },
    })
    expect(r).toEqual({ bytes: 12345, entriesCount: 2, httpStatus: 200, autoloadHttpStatus: 200, resetHttpStatus: 302 })
  })

  it('欠けたフィールドは null に倒す', () => {
    expect(parseKintaiRefreshMysqlApplyResult({})).toEqual({
      bytes: null,
      entriesCount: null,
      httpStatus: null,
      autoloadHttpStatus: null,
      resetHttpStatus: null,
    })
  })

  it('null/非object でも落ちない', () => {
    expect(parseKintaiRefreshMysqlApplyResult(null)).toEqual({
      bytes: null,
      entriesCount: null,
      httpStatus: null,
      autoloadHttpStatus: null,
      resetHttpStatus: null,
    })
  })
})

describe('fmtKintaiRefreshMysqlGuarantee — 「押せば直る」と誤読させない文言', () => {
  it('preview 無し', () => {
    expect(fmtKintaiRefreshMysqlGuarantee(null)).toContain('確認')
  })

  it('guarantee_error があればそれを出す', () => {
    const msg = fmtKintaiRefreshMysqlGuarantee({
      opeNo: null,
      startOpe: null,
      unkoNo: null,
      guarantee: null,
      guaranteeError: 'timeout',
    })
    expect(msg).toContain('timeout')
  })

  it('guarantee が null (driver_cd/month 未指定) なら不明と明言', () => {
    const msg = fmtKintaiRefreshMysqlGuarantee({ opeNo: null, startOpe: null, unkoNo: null, guarantee: null, guaranteeError: null })
    expect(msg).toContain('不明')
  })

  it('found: false は「保証あり」と誤読させない', () => {
    const msg = fmtKintaiRefreshMysqlGuarantee({
      opeNo: null,
      startOpe: null,
      unkoNo: null,
      guarantee: { found: false, kind: null, guaranteed: false },
      guaranteeError: null,
    })
    expect(msg).toContain('判定不能')
    expect(msg).not.toContain('保証あり')
  })

  it('kind: mismatch は保証ありと明言', () => {
    const msg = fmtKintaiRefreshMysqlGuarantee({
      opeNo: null,
      startOpe: null,
      unkoNo: null,
      guarantee: { found: true, kind: 'mismatch', guaranteed: true },
      guaranteeError: null,
    })
    expect(msg).toContain('保証あり')
  })

  it('kind: dtako_missing は保証なしと明言し「押せば直る」と書かない', () => {
    const msg = fmtKintaiRefreshMysqlGuarantee({
      opeNo: null,
      startOpe: null,
      unkoNo: null,
      guarantee: { found: true, kind: 'dtako_missing', guaranteed: false },
      guaranteeError: null,
    })
    expect(msg).toContain('保証なし')
    expect(msg).not.toContain('押せば直る')
  })
})
