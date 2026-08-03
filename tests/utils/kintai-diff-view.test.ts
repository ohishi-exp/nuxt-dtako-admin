import { describe, it, expect } from 'vitest'
import {
  buildKintaiDiffPrescriptions,
  fmtKintaiDiffCacheHeadline,
  fmtKintaiDiffCount,
  fmtKintaiDiffLastVerified,
  fmtKintaiRefreshMysqlGuarantee,
  foldProgressAppend,
  foldProgressInitial,
  kintaiDiffCacheStateFromLiveResult,
  kintaiDiffHasAnyDiff,
  parseKintaiDiffApiResponse,
  parseKintaiDiffCacheState,
  parseKintaiDiffComparedDays,
  parseKintaiDiffDayCoverageFromResponse,
  parseKintaiDiffObservations,
  parseKintaiDiffSummary,
  parseKintaiDiffValueDiffItems,
  parseKintaiDiffValueDiffItemsFromResponse,
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
      unko_diff_gcp_only_driver_split: {
        never_onprem_drivers: 41,
        never_onprem_ops: 399,
        also_in_month_drivers: 2,
        also_in_month_ops: 2,
        other_month_only_drivers: 3,
        other_month_only_ops: 16,
      },
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
      unkoDiffGcpOnlyDriverSplit: {
        neverOnpremDrivers: 41,
        neverOnpremOps: 399,
        alsoInMonthDrivers: 2,
        alsoInMonthOps: 2,
        otherMonthOnlyDrivers: 3,
        otherMonthOnlyOps: 16,
      },
    })
  })

  it('欠けたフィールドは null/[]/0 に倒す (3区分の和と合計 (unkoDiffGcpOnlyInMonth) との整合を壊さないよう split は 0)', () => {
    expect(parseKintaiDiffObservations({})).toEqual({
      staleDrivers: null,
      foldWouldWriteDrivers: null,
      warnings: [],
      unkoDiffGcpOnlyInMonth: null,
      unkoDiffGcpOnlyDriverSplit: {
        neverOnpremDrivers: 0,
        neverOnpremOps: 0,
        alsoInMonthDrivers: 0,
        alsoInMonthOps: 0,
        otherMonthOnlyDrivers: 0,
        otherMonthOnlyOps: 0,
      },
    })
  })

  it('unko_diff_gcp_only_driver_split の一部フィールドだけ欠けていたらそこだけ 0 に倒す', () => {
    const o = parseKintaiDiffObservations({
      unko_diff_gcp_only_driver_split: { also_in_month_drivers: 2, also_in_month_ops: 2 },
    })
    expect(o?.unkoDiffGcpOnlyDriverSplit).toEqual({
      neverOnpremDrivers: 0,
      neverOnpremOps: 0,
      alsoInMonthDrivers: 2,
      alsoInMonthOps: 2,
      otherMonthOnlyDrivers: 0,
      otherMonthOnlyOps: 0,
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

  it('fetched_at/last_verified_at を読む (Refs #620-3、突合結果のキャッシュ保存に伴い追加)', () => {
    const r = parseKintaiDiffApiResponse(diffBody({ fetched_at: '2026-08-01T00:00:00.000Z', last_verified_at: '2026-08-03T12:20:00.000Z' }))
    expect(r.fetchedAt).toBe('2026-08-01T00:00:00.000Z')
    expect(r.lastVerifiedAt).toBe('2026-08-03T12:20:00.000Z')
  })

  it('fetched_at/last_verified_at が無ければ null (保存に失敗した場合、best-effort)', () => {
    const r = parseKintaiDiffApiResponse(diffBody())
    expect(r.fetchedAt).toBeNull()
    expect(r.lastVerifiedAt).toBeNull()
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

  it('also_in_month_ops > 0 または other_month_only_ops > 0 または only_gcp > 0 で mysql が relevant になる (Refs #615-7)', () => {
    const ps1 = buildKintaiDiffPrescriptions(
      null,
      parseKintaiDiffObservations({ unko_diff_gcp_only_driver_split: { also_in_month_ops: 2 } }),
    )
    expect(ps1.find(p => p.key === 'mysql')?.relevant).toBe(true)

    const ps2 = buildKintaiDiffPrescriptions(
      null,
      parseKintaiDiffObservations({ unko_diff_gcp_only_driver_split: { other_month_only_ops: 16 } }),
    )
    expect(ps2.find(p => p.key === 'mysql')?.relevant).toBe(true)

    const summary = parseKintaiDiffSummary({ month: '2026-06', diff: { only_gcp: { total: 2, capped: false } } })
    const ps3 = buildKintaiDiffPrescriptions(summary, null)
    expect(ps3.find(p => p.key === 'mysql')?.relevant).toBe(true)
  })

  it('never_onprem_ops だけでは mysql は relevant にならない (オンプレに居ない乗務員の運行を取り込む導線ではないため)', () => {
    const ps = buildKintaiDiffPrescriptions(
      null,
      parseKintaiDiffObservations({
        unko_diff_gcp_only_in_month: 399,
        unko_diff_gcp_only_driver_split: { never_onprem_drivers: 41, never_onprem_ops: 399 },
      }),
    )
    expect(ps.find(p => p.key === 'mysql')?.relevant).toBe(false)
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

// ─────────────────────────────────────────────────────────────────────────
// 突合結果のキャッシュ (Refs #620-3)
// ─────────────────────────────────────────────────────────────────────────

function cacheBody(over: Record<string, unknown> = {}) {
  return {
    cached: true,
    unreadable: false,
    month: '2026-06',
    diff: diffBody().diff,
    observations: diffBody().observations,
    observations_error: null,
    fetched_at: '2026-08-01T00:00:00.000Z',
    last_verified_at: '2026-08-03T12:20:00.000Z',
    ...over,
  }
}

describe('parseKintaiDiffCacheState — 未確認/読めなかった/確認済みの3状態', () => {
  it('raw が null/オブジェクトでなければ「読めなかった」扱い', () => {
    expect(parseKintaiDiffCacheState(null)).toEqual({ status: 'unreadable' })
    expect(parseKintaiDiffCacheState(undefined)).toEqual({ status: 'unreadable' })
    expect(parseKintaiDiffCacheState('x')).toEqual({ status: 'unreadable' })
  })

  it('cached !== true は「未確認」(保存が一度も無い)', () => {
    expect(parseKintaiDiffCacheState({ cached: false })).toEqual({ status: 'none' })
    expect(parseKintaiDiffCacheState({})).toEqual({ status: 'none' })
    expect(parseKintaiDiffCacheState({ cached: 'true' })).toEqual({ status: 'none' })
  })

  it('cached: true, unreadable: true は「読めなかった」(保存はあるが壊れていた)', () => {
    expect(parseKintaiDiffCacheState({ cached: true, unreadable: true })).toEqual({ status: 'unreadable' })
  })

  it('cached: true で month/diff が読めなければ「読めなかった」扱いに倒す (黙って「未確認」にしない)', () => {
    expect(parseKintaiDiffCacheState({ cached: true, unreadable: false })).toEqual({ status: 'unreadable' })
    expect(parseKintaiDiffCacheState({ cached: true, unreadable: false, month: 'x' })).toEqual({ status: 'unreadable' })
  })

  it('保存済みスナップショットを読む (差0件のケースも status: ok に含まれる)', () => {
    const state = parseKintaiDiffCacheState(cacheBody())
    expect(state.status).toBe('ok')
    if (state.status !== 'ok') throw new Error('unreachable')
    expect(state.summary.month).toBe('2026-06')
    expect(state.observations?.unkoDiffGcpOnlyInMonth).toBe(417)
    expect(state.observationsError).toBeNull()
    expect(state.fetchedAt).toBe('2026-08-01T00:00:00.000Z')
    expect(state.lastVerifiedAt).toBe('2026-08-03T12:20:00.000Z')
  })

  it('observations_error 付き (観測値だけ取れなかった) も status: ok として読む', () => {
    const state = parseKintaiDiffCacheState(cacheBody({ observations: null, observations_error: 'timeout' }))
    expect(state.status).toBe('ok')
    if (state.status !== 'ok') throw new Error('unreachable')
    expect(state.observations).toBeNull()
    expect(state.observationsError).toBe('timeout')
  })

  it('fetched_at/last_verified_at が欠けていれば null', () => {
    const state = parseKintaiDiffCacheState(cacheBody({ fetched_at: undefined, last_verified_at: undefined }))
    if (state.status !== 'ok') throw new Error('unreachable')
    expect(state.fetchedAt).toBeNull()
    expect(state.lastVerifiedAt).toBeNull()
  })
})

describe('kintaiDiffCacheStateFromLiveResult — 「取り直す」直後にライブ応答から状態を組む', () => {
  it('summary が読めれば status: ok に変換する (二度目の read を要らなくする)', () => {
    const live = parseKintaiDiffApiResponse(diffBody({ fetched_at: '2026-08-03T12:20:00.000Z', last_verified_at: '2026-08-03T12:20:00.000Z' }))
    const state = kintaiDiffCacheStateFromLiveResult(live)
    expect(state).toEqual({
      status: 'ok',
      summary: live.summary,
      observations: live.observations,
      observationsError: live.observationsError,
      fetchedAt: '2026-08-03T12:20:00.000Z',
      lastVerifiedAt: '2026-08-03T12:20:00.000Z',
    })
  })

  it('summary が読めなければ unreadable (ライブの突合自体が読めなかった場合)', () => {
    const live = parseKintaiDiffApiResponse({})
    expect(kintaiDiffCacheStateFromLiveResult(live)).toEqual({ status: 'unreadable' })
  })
})

describe('kintaiDiffHasAnyDiff — only_onprem_driver0 は除外、運行NO単位の集計は見ない', () => {
  const zeroDiff = () => parseKintaiDiffSummary(diffBody({
    diff: {
      gcp_rows: 0,
      onprem_rows: 0,
      onprem_unreadable: false,
      only_gcp: { total: 0, capped: false },
      only_onprem_driver0: { total: 41, capped: false },
      only_onprem_other: { total: 0, capped: false },
      value_diff_restraint_match: { total: 0, capped: false },
      value_diff_restraint_mismatch: { total: 0, capped: false },
    },
  }))!

  it('only_onprem_driver0 だけが非0でも false (意図的な除外であって差ではない)', () => {
    expect(kintaiDiffHasAnyDiff(zeroDiff())).toBe(false)
  })

  it.each([
    ['onlyGcp', { only_gcp: { total: 1, capped: false } }],
    ['onlyOnpremOther', { only_onprem_other: { total: 1, capped: false } }],
    ['valueDiffRestraintMatch', { value_diff_restraint_match: { total: 1, capped: false } }],
    ['valueDiffRestraintMismatch', { value_diff_restraint_mismatch: { total: 1, capped: false } }],
  ] as const)('%s が非0なら true', (_label, patch) => {
    const summary = parseKintaiDiffSummary(diffBody({
      diff: {
        gcp_rows: 0,
        onprem_rows: 0,
        onprem_unreadable: false,
        only_gcp: { total: 0, capped: false },
        only_onprem_driver0: { total: 0, capped: false },
        only_onprem_other: { total: 0, capped: false },
        value_diff_restraint_match: { total: 0, capped: false },
        value_diff_restraint_mismatch: { total: 0, capped: false },
        ...patch,
      },
    }))!
    expect(kintaiDiffHasAnyDiff(summary)).toBe(true)
  })
})

describe('fmtKintaiDiffLastVerified — ISO(UTC) を JST の MM/DD HH:mm にする', () => {
  it('null は null', () => {
    expect(fmtKintaiDiffLastVerified(null)).toBeNull()
  })

  it('パースできない文字列は null', () => {
    expect(fmtKintaiDiffLastVerified('not-a-date')).toBeNull()
  })

  it('UTC → JST (+9h) に変換する', () => {
    // 2026-08-03T12:20:00Z → JST 2026-08-03 21:20
    expect(fmtKintaiDiffLastVerified('2026-08-03T12:20:00.000Z')).toBe('08/03 21:20')
  })

  it('JST変換で日付が繰り上がる場合も正しく出す (UTC 15:30 → JST 翌日0:30)', () => {
    expect(fmtKintaiDiffLastVerified('2026-08-03T15:30:00.000Z')).toBe('08/04 00:30')
  })
})

describe('fmtKintaiDiffCacheHeadline — 未確認/読めなかった/確認済みを混同しない見出し', () => {
  it('未確認', () => {
    expect(fmtKintaiDiffCacheHeadline({ status: 'none' })).toBe('未確認')
  })

  it('読めなかった', () => {
    expect(fmtKintaiDiffCacheHeadline({ status: 'unreadable' })).toBe('読めませんでした')
  })

  it('差0件なら「差はありません」+ 最終確認時刻', () => {
    const state = parseKintaiDiffCacheState(cacheBody({
      diff: {
        gcp_rows: 0,
        onprem_rows: 0,
        onprem_unreadable: false,
        only_gcp: { total: 0, capped: false },
        only_onprem_driver0: { total: 41, capped: false },
        only_onprem_other: { total: 0, capped: false },
        value_diff_restraint_match: { total: 0, capped: false },
        value_diff_restraint_mismatch: { total: 0, capped: false },
      },
    }))
    const headline = fmtKintaiDiffCacheHeadline(state)
    expect(headline).toContain('差はありません')
    expect(headline).toContain('最終確認: 08/03 21:20')
  })

  it('差ありなら「差があります」+ 最終確認時刻', () => {
    const state = parseKintaiDiffCacheState(cacheBody())
    const headline = fmtKintaiDiffCacheHeadline(state)
    expect(headline).toContain('差があります')
  })

  it('onprem_unreadable の突合結果は「差はありません」と断定しない', () => {
    const state = parseKintaiDiffCacheState(cacheBody({
      diff: {
        gcp_rows: 0,
        onprem_rows: 0,
        onprem_unreadable: true,
        only_gcp: { total: 0, capped: false },
        only_onprem_driver0: { total: 0, capped: false },
        only_onprem_other: { total: 0, capped: false },
        value_diff_restraint_match: { total: 0, capped: false },
        value_diff_restraint_mismatch: { total: 0, capped: false },
      },
    }))
    const headline = fmtKintaiDiffCacheHeadline(state)
    expect(headline).not.toContain('差はありません')
    expect(headline).toContain('判定できません')
  })

  it('確認時刻が無ければ「確認時刻不明」に倒す', () => {
    const state = parseKintaiDiffCacheState(cacheBody({ last_verified_at: undefined }))
    expect(fmtKintaiDiffCacheHeadline(state)).toContain('確認時刻不明')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// value_diff_restraint_match / value_diff_restraint_mismatch の items[]
// (Refs #633-1)。実応答形 (`KintaiDiffValueDiffRow` = `KintaiDiffRow` +
// `diff_fields`/`gcp`/`onprem`) を、issue #633 の実測 (1740/2026-06-06) に
// 寄せた fixture で確認する。★ driver_cd は文字列 (`keyToRow` が文字列キーの
// split から作るため、#630 と同じ理由で数値に決め打たない)。
// ─────────────────────────────────────────────────────────────────────────

/** 受け側 (`KintaiDiffValue`) の生の形 — `shift_source` (文字列) を含む。 */
function diffValue(over: Record<string, unknown> = {}) {
  return {
    shift_source: 'dtako',
    restraint_minutes: 593,
    working_minutes: 494,
    break_minutes: 100,
    rest_minus_minutes: 0,
    statutory_minutes: 480,
    within_statutory_overtime_minutes: 0,
    overtime_minutes: 14,
    legal_holiday_minutes: 0,
    night_minutes: 0,
    overtime_night_minutes: 0,
    legal_holiday_night_minutes: 0,
    ...over,
  }
}

/** `parseKintaiDiffValueDiffItem` が読んだ後の期待値 — `toMinuteRecord` は数値
 * フィールドだけを拾うので `shift_source` (文字列) は落ちる。この突き合わせ機能では
 * shift_source を使わないため、意図的に持たない。 */
function expectedMinutes(over: Record<string, number> = {}) {
  const { shift_source: _shiftSource, ...rest } = diffValue(over)
  return rest
}

describe('parseKintaiDiffValueDiffItems', () => {
  it('items が無いカテゴリは空配列', () => {
    expect(parseKintaiDiffValueDiffItems({})).toEqual([])
    expect(parseKintaiDiffValueDiffItems(null)).toEqual([])
    expect(parseKintaiDiffValueDiffItems({ total: 1, capped: false })).toEqual([])
  })

  it('driver_cd が文字列の行を読む (#630 と同型 — 数値に決め打たない)', () => {
    const items = parseKintaiDiffValueDiffItems({
      total: 1,
      capped: false,
      items: [
        {
          driver_cd: '1740',
          date: '2026-06-06',
          start: '2026-06-06T08:22:00',
          diff_fields: ['break_minutes', 'working_minutes', 'overtime_minutes'],
          gcp: diffValue(),
          onprem: diffValue({ working_minutes: 534, break_minutes: 60, overtime_minutes: 54 }),
        },
      ],
    })
    expect(items).toEqual([
      {
        driverCd: '1740',
        date: '2026-06-06',
        diffFields: ['break_minutes', 'working_minutes', 'overtime_minutes'],
        gcp: expectedMinutes(),
        onprem: expectedMinutes({ working_minutes: 534, break_minutes: 60, overtime_minutes: 54 }),
      },
    ])
  })

  it('driver_cd/date が欠けた壊れた行は無視する (読めた分だけ返す)', () => {
    const items = parseKintaiDiffValueDiffItems({
      items: [
        { date: '2026-06-06', gcp: diffValue(), onprem: diffValue() },
        { driver_cd: '1445', gcp: diffValue(), onprem: diffValue() },
        { driver_cd: '1740', date: '2026-06-06', diff_fields: [], gcp: diffValue(), onprem: diffValue() },
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0].driverCd).toBe('1740')
  })
})

describe('parseKintaiDiffValueDiffItemsFromResponse', () => {
  it('/kintai/diff の生応答から match/mismatch 2 カテゴリぶんの items を読む', () => {
    const raw = {
      month: '2026-06',
      diff: {
        gcp_rows: 1,
        onprem_rows: 1,
        onprem_unreadable: false,
        only_gcp: { total: 0, capped: false },
        only_onprem_driver0: { total: 0, capped: false },
        only_onprem_other: { total: 0, capped: false },
        value_diff_restraint_match: {
          total: 1,
          capped: false,
          items: [
            {
              driver_cd: '1740',
              date: '2026-06-06',
              start: '2026-06-06T08:22:00',
              diff_fields: ['break_minutes', 'working_minutes', 'overtime_minutes'],
              gcp: diffValue(),
              onprem: diffValue({ working_minutes: 534, break_minutes: 60, overtime_minutes: 54 }),
            },
          ],
        },
        value_diff_restraint_mismatch: { total: 0, capped: false, items: [] },
      },
    }
    const { match, mismatch } = parseKintaiDiffValueDiffItemsFromResponse(raw)
    expect(mismatch).toEqual([])
    expect(match).toHaveLength(1)
    expect(match[0]).toEqual({
      driverCd: '1740',
      date: '2026-06-06',
      diffFields: ['break_minutes', 'working_minutes', 'overtime_minutes'],
      gcp: expectedMinutes(),
      onprem: expectedMinutes({ working_minutes: 534, break_minutes: 60, overtime_minutes: 54 }),
    })
  })

  it('キャッシュ応答 (items を保存しない) を渡しても空配列になるだけで落ちない', () => {
    const cached = {
      month: '2026-06',
      diff: {
        gcp_rows: 1,
        onprem_rows: 1,
        onprem_unreadable: false,
        only_gcp: { total: 0, capped: false },
        only_onprem_driver0: { total: 0, capped: false },
        only_onprem_other: { total: 0, capped: false },
        value_diff_restraint_match: { total: 1, capped: false },
        value_diff_restraint_mismatch: { total: 0, capped: false },
      },
    }
    expect(parseKintaiDiffValueDiffItemsFromResponse(cached)).toEqual({ match: [], mismatch: [] })
  })

  it('壊れた応答 (diff 自体が無い) でも空配列に倒す', () => {
    expect(parseKintaiDiffValueDiffItemsFromResponse(null)).toEqual({ match: [], mismatch: [] })
    expect(parseKintaiDiffValueDiffItemsFromResponse({})).toEqual({ match: [], mismatch: [] })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// compared_days / only_gcp / only_onprem_* の「日」単位の材料 (Refs #633-3)。
// ★ #633-1 の no_diff (差分リストに無い=一致) が「突き合わせてすらいない日」を
// 「一致」と誤読していたバグの修正で追加。compared_days は「比較できた日」であって
// 「一致した日」ではない (kintai-diff-view.ts 冒頭・kintai-candidate-diff.ts の docs 参照)。
// ─────────────────────────────────────────────────────────────────────────

describe('parseKintaiDiffComparedDays', () => {
  it('items をそのまま読む (capped も)', () => {
    expect(parseKintaiDiffComparedDays({ total: 2, capped: false, items: ['1445|2026-06-24', '1740|2026-06-06'] }))
      .toEqual({ keys: ['1445|2026-06-24', '1740|2026-06-06'], capped: false })
    expect(parseKintaiDiffComparedDays({ total: 5000, capped: true, items: ['a'] }))
      .toEqual({ keys: ['a'], capped: true })
  })

  it('items が配列でない (compared_days フィールド自体が応答に無い、古いキャッシュ想定) は null', () => {
    expect(parseKintaiDiffComparedDays({})).toBeNull()
    expect(parseKintaiDiffComparedDays({ total: 0, capped: false })).toBeNull()
  })

  it('raw が null/オブジェクトでなければ null', () => {
    expect(parseKintaiDiffComparedDays(null)).toBeNull()
    expect(parseKintaiDiffComparedDays('x')).toBeNull()
  })

  it('items 内の非文字列は除く', () => {
    expect(parseKintaiDiffComparedDays({ items: ['1445|2026-06-24', 123, null] }).keys)
      .toEqual(['1445|2026-06-24'])
  })
})

describe('parseKintaiDiffDayCoverageFromResponse', () => {
  it('★ issue #633 実例をそのまま読む: 1445は06-24のみcompared_days、06-25はonly_*にも無い', () => {
    const raw = {
      month: '2026-06',
      diff: {
        gcp_rows: 27,
        onprem_rows: 27,
        onprem_unreadable: false,
        only_gcp: { total: 0, capped: false, items: [] },
        only_onprem_driver0: { total: 0, capped: false, items: [] },
        only_onprem_other: { total: 0, capped: false, items: [] },
        value_diff_restraint_match: { total: 0, capped: false, items: [] },
        value_diff_restraint_mismatch: { total: 0, capped: false, items: [] },
        compared_days: { total: 1, capped: false, items: ['1445|2026-06-24'] },
      },
    }
    const coverage = parseKintaiDiffDayCoverageFromResponse(raw)
    expect(coverage.comparedDays).toEqual({ keys: ['1445|2026-06-24'], capped: false })
    expect(coverage.onlyGcpDays).toEqual([])
    expect(coverage.onlyOnpremDays).toEqual([])
  })

  it('only_gcp / only_onprem_driver0 / only_onprem_other の items から driverCd+date を抜く (onprem系はまとめる)', () => {
    const raw = {
      diff: {
        only_gcp: { items: [{ driver_cd: '2001', date: '2026-06-01', start: '08:00', gcp: {} }] },
        only_onprem_driver0: { items: [{ driver_cd: '0', date: '2026-06-02', start: '09:00', onprem: {} }] },
        only_onprem_other: { items: [{ driver_cd: '2002', date: '2026-06-03', start: '09:00', onprem: {} }] },
        compared_days: { items: [] },
      },
    }
    const coverage = parseKintaiDiffDayCoverageFromResponse(raw)
    expect(coverage.onlyGcpDays).toEqual([{ driverCd: '2001', date: '2026-06-01' }])
    expect(coverage.onlyOnpremDays).toEqual([
      { driverCd: '0', date: '2026-06-02' },
      { driverCd: '2002', date: '2026-06-03' },
    ])
  })

  it('driver_cd が数値でも読む (#630 と同型 — 文字列に決め打たない)', () => {
    const raw = { diff: { only_gcp: { items: [{ driver_cd: 2001, date: '2026-06-01' }] }, compared_days: { items: [] } } }
    expect(parseKintaiDiffDayCoverageFromResponse(raw).onlyGcpDays).toEqual([{ driverCd: '2001', date: '2026-06-01' }])
  })

  it('driver_cd/date が欠けた壊れた行は無視する', () => {
    const raw = {
      diff: {
        only_gcp: { items: [{ date: '2026-06-01' }, { driver_cd: '1' }, null, 'x'] },
        compared_days: { items: [] },
      },
    }
    expect(parseKintaiDiffDayCoverageFromResponse(raw).onlyGcpDays).toEqual([])
  })

  it('compared_days が応答に無い (古いキャッシュ・壊れた応答) なら comparedDays: null (「未確認」に倒す合図)', () => {
    const raw = { diff: { only_gcp: { items: [] } } }
    expect(parseKintaiDiffDayCoverageFromResponse(raw).comparedDays).toBeNull()
  })

  it('壊れた応答 (diff 自体が無い) でも例外を投げず空扱いにする', () => {
    const coverage = parseKintaiDiffDayCoverageFromResponse(null)
    expect(coverage.comparedDays).toBeNull()
    expect(coverage.onlyGcpDays).toEqual([])
    expect(coverage.onlyOnpremDays).toEqual([])
  })
})
