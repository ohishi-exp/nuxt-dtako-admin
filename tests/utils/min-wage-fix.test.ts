import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRateMasterApplyBody,
  describeMinWageImport,
  describeRateMasterApply,
  fmtMinWageFixGroup,
  hasMinWageFixes,
  importMinWageFromMhlw,
  minWageFixes,
  rateMasterApplyLines,
  type MinWageFixInput,
  type RateMasterApplyResponse,
} from '~/utils/min-wage-fix'

// 値は全部架空 (public repo)
const row = (month: string, over: Partial<MinWageFixInput> = {}): MinWageFixInput => ({
  driverCd: '9001', month, hourlyRate: 1000, minWageRate: 1000, minWagePrefecture: '架空県', ...over,
})

describe('minWageFixes (判定できない月の直し方の集計)', () => {
  it('判定できない月が無ければ全部 null で、パネルを出さない', () => {
    const f = minWageFixes([row('2025-01'), row('2025-02', { hourlyRate: 1100 })])
    expect(f).toEqual({ minWageMissing: null, prefectureMissing: null, rateMissing: null })
    expect(hasMinWageFixes(f)).toBe(false)
    expect(hasMinWageFixes(minWageFixes([]))).toBe(false)
  })

  it('★ 最低賃金が引けない月は、県が引けている (mapped:false の既定の県も含む) なら取り込み対象。件数・月範囲 (順不同でも最小〜最大)・乗務員 (重複なし)', () => {
    const f = minWageFixes([
      row('2025-03', { minWageRate: null }),
      row('2025-01', { minWageRate: null }),
      row('2025-02'),
      row('2025-01', { minWageRate: null, driverCd: '9002' }),
    ])
    expect(f.minWageMissing).toEqual({ count: 3, from: '2025-01', to: '2025-03', driverCds: ['9001', '9002'] })
    expect(f.prefectureMissing).toBeNull()
    expect(hasMinWageFixes(f)).toBe(true)
  })

  it('★ 県も null の月は「県を設定する」側に分ける (取り込み対象にしない)', () => {
    const f = minWageFixes([row('2025-01', { minWageRate: null, minWagePrefecture: null }), row('2025-02', { minWageRate: null })])
    expect(f.prefectureMissing).toEqual({ count: 1, from: '2025-01', to: '2025-01', driverCds: ['9001'] })
    expect(f.minWageMissing).toMatchObject({ count: 1, from: '2025-02' })
    expect(hasMinWageFixes({ minWageMissing: null, prefectureMissing: f.prefectureMissing, rateMissing: null })).toBe(true)
  })

  it('★ 単価マスタに単価が無い月は別に数える。最低賃金も引けない月は両方に入る', () => {
    const f = minWageFixes([row('2025-01', { hourlyRate: null }), row('2025-02', { hourlyRate: null, minWageRate: null })])
    expect(f.rateMissing).toEqual({ count: 2, from: '2025-01', to: '2025-02', driverCds: ['9001'] })
    expect(f.minWageMissing).toMatchObject({ count: 1 })
    expect(hasMinWageFixes({ minWageMissing: null, prefectureMissing: null, rateMissing: f.rateMissing })).toBe(true)
  })

  it('件数と月範囲の表示 (1 か月なら範囲にしない)', () => {
    expect(fmtMinWageFixGroup({ count: 3, from: '2025-01', to: '2025-03', driverCds: [] })).toBe('3 件 (2025-01〜2025-03)')
    expect(fmtMinWageFixGroup({ count: 1, from: '2025-01', to: '2025-01', driverCds: [] })).toBe('1 件 (2025-01)')
  })
})

describe('過去の最低賃金の取り込み', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('結果の 1 文: 履歴は件数と年度範囲、全国一覧は都道府県。変化なしは「改定なし」', () => {
    expect(describeMinWageImport({ changed: true, prefectures: 1234, added: 10, updated: 2, years: { from: '平成14年度', to: '令和8年度' } }))
      .toBe('厚労省から 1234 件を取り込みました (平成14年度〜令和8年度) (新規 10 / 更新 2)')
    expect(describeMinWageImport({ changed: false, prefectures: 47, added: 0, updated: 0 }))
      .toBe('厚労省から 47 都道府県を確認しました (改定なし)')
  })

  it('★ relay の口に POST する。history は JSON {source:"history"}、既定 (最新) は body なし', async () => {
    const fetchMock = vi.fn(async () => ({ changed: false, prefectures: 0, added: 0, updated: 0 }))
    vi.stubGlobal('$fetch', fetchMock)
    const h = { 'X-Theearth-Comp-Id': '10000001' }
    await importMinWageFromMhlw(h, 'history')
    await importMinWageFromMhlw(h)
    expect(fetchMock.mock.calls).toEqual([
      ['/restraint-api/min-wage/import-mhlw', { method: 'POST', headers: h, body: { source: 'history' } }],
      ['/restraint-api/min-wage/import-mhlw', { method: 'POST', headers: h }],
    ])
  })
})

describe('単価マスタを最低賃金で作る', () => {
  it('★ body: asOf は開始月の 1 日、until は終了月の末日 (閏年・12 月も)、overwrite は送らない。dryRun は指定時だけ', () => {
    expect(buildRateMasterApplyBody({ driverCds: ['9001'], from: '2024-01', to: '2024-02', dryRun: true }))
      .toEqual({ asOf: '2024-01-01', until: '2024-02-29', driverCds: ['9001'], dryRun: true })
    expect(buildRateMasterApplyBody({ driverCds: ['9001', '9002'], from: '2025-01', to: '2025-12', dryRun: false }))
      .toEqual({ asOf: '2025-01-01', until: '2025-12-31', driverCds: ['9001', '9002'] })
  })

  const res = (items: RateMasterApplyResponse['items'], over: Partial<RateMasterApplyResponse> = {}): RateMasterApplyResponse =>
    ({ added: 0, kept: 0, unresolved: 0, saved: false, items, ...over })

  it('★ 行: 入る行は 県・円/h・発効日 (既定の県ならその旨)、入らない人は理由', () => {
    const lines = rateMasterApplyLines(res([
      { driverCd: '9001', branch: '甲', prefecture: '架空県', rate: 1000, rateEffectiveFrom: '2024-10-05', status: 'add' },
      { driverCd: '9001', branch: '甲', prefecture: '既定県', rate: 950, rateEffectiveFrom: '2023-10-01', status: 'overwrite', prefectureDefaulted: true },
      { driverCd: '9001', branch: '乙', prefecture: '別県', rate: 970, rateEffectiveFrom: '2024-09-01', appliedFrom: '2025-01-01', status: 'add' },
      { driverCd: '9002', branch: '甲', prefecture: '架空県', rate: 1000, rateEffectiveFrom: '2024-10-05', status: 'keep' },
      { driverCd: '9003', branch: '乙', prefecture: null, rate: null, rateEffectiveFrom: null, status: 'unmapped' },
      { driverCd: '9004', branch: '甲', prefecture: '架空県', rate: null, rateEffectiveFrom: null, status: 'no-rate' },
      { driverCd: '9005', branch: '', prefecture: null, rate: null, rateEffectiveFrom: null, status: 'no-branch' },
    ]))
    expect(lines).toEqual([
      { driverCd: '9001', text: '架空県 1,000円/h (2024-10-05 発効)', willAdd: true },
      { driverCd: '9001', text: '既定県 (所属に県が無く既定の県) 950円/h (2023-10-01 発効)', willAdd: true },
      { driverCd: '9001', text: '別県 970円/h (2024-09-01 発効、所属の異動で 2025-01-01 から)', willAdd: true },
      { driverCd: '9002', text: '既に単価がある — 触りません (単価マスタタブで確認)', willAdd: false },
      { driverCd: '9003', text: '所属から県が引けない — 拘束×賃金 → 最低賃金チェック → ▸ 最低賃金 で拠点の県を設定', willAdd: false },
      { driverCd: '9004', text: 'その県の最低賃金が期間中に無い — 過去の最低賃金を取り込んでからやり直す', willAdd: false },
      { driverCd: '9005', text: '社員マスタに所属が無い — 拘束×賃金の社員マスタタブで所属を入れる', willAdd: false },
    ])
  })

  it('確定後の 1 文: 入った行数、据え置き・入れられない人がいればその数。0 行なら取り直しを促さない', () => {
    expect(describeRateMasterApply(res([], { added: 3 }))).toBe('単価マスタに 3 行を入れました — 続けて材料を取り直してください')
    expect(describeRateMasterApply(res([], { added: 1, kept: 1, unresolved: 2 }))).toBe('単価マスタに 1 行を入れました (据え置き 1 名 / 入れられない 2 名) — 続けて材料を取り直してください')
    expect(describeRateMasterApply(res([], { kept: 1 }))).toBe('単価マスタに 0 行を入れました (据え置き 1 名)')
  })
})
