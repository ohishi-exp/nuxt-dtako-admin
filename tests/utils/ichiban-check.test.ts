import { describe, expect, it } from 'vitest'
import {
  baseKey,
  chunkIds,
  countMakecsv,
  describeMakecsvReason,
  flattenIchibanCheck,
  idsOfRows,
  parseMakecsvResults,
} from '~/utils/ichiban-check'

// 乗務員CD・氏名・運行NO はすべて架空 (public repo に実データを載せない)
const A = '26100106000000000011111'
const B = '26100206000000000011121'
const C = '26100306000000000022221'

describe('baseKey', () => {
  it.each([
    ['2026-10-01差分', '2026-10-01'],
    ['20261030003747_車両番号', '20261030003747'],
    ['20261030003747_部門', '20261030003747'],
    ['20261030003747_dtako_row_id', '20261030003747'],
    ['20261030003747', '20261030003747'],
    ['差分', '差分'],
  ])('%s → %s', (k, want) => {
    expect(baseKey(k)).toBe(want)
  })
})

describe('flattenIchibanCheck', () => {
  it('勤怠は 項目 → 乗務員 → 日付 で 1 行にし、値と差分・両方の ids を集める', () => {
    const rows = flattenIchibanCheck({
      diffs: { 勤怠: { 運転: { 9001: { '2026-10-01': '8.5', '2026-10-01差分': -1.5 } } } },
      ids: { 勤怠: { 運転: { 9001: { '2026-10-01': [A], '2026-10-01差分': [A, B] } } } },
      drivers: { 9001: '架空 太郎' },
    })
    expect(rows).toEqual([{
      key: '勤怠|運転|9001|2026-10-01',
      category: '勤怠',
      item: '運転',
      driverCd: '9001',
      driverName: '架空 太郎',
      label: '2026-10-01',
      value: '8.5',
      diff: '-1.5',
      vehicle: '',
      dept: '',
      ids: [A, B],
      etcExcluded: false,
    }])
  })

  it('旅費残業は 差分・車両番号・部門 を本体のキーの行に寄せる。ids の無いキーは空', () => {
    const rows = flattenIchibanCheck({
      diffs: {
        旅費残業: { 9002: { 20261030003747: 3, '20261030003747差分': 3, '20261030003747_車両番号': '374700', '20261030003747_部門': '010' } },
        経費: { 9002: { 20261005: '1200' } },
      },
      ids: { 旅費残業: { 9002: { 20261030003747: [C] } }, 経費: { 9002: { 20261005: [] } } },
    })
    expect(rows.map(r => [r.category, r.label, r.value, r.diff, r.vehicle, r.dept, r.ids, r.driverName])).toEqual([
      ['経費', '20261005', '1200', '', '', '', [], ''],
      ['旅費残業', '20261030003747', '3', '3', '374700', '010', [C], ''],
    ])
  })

  it('ETC 除外中の運行を含む行に印を付ける', () => {
    const rows = flattenIchibanCheck({
      diffs: { 経費: { 9003: { k1: '1', k2: '2' } } },
      ids: { 経費: { 9003: { k1: [A], k2: [B] } } },
      etcExcludedRowIds: [B, 7],
    })
    expect(rows.map(r => [r.label, r.etcExcluded])).toEqual([['k1', false], ['k2', true]])
  })

  it('形が違うところは読み飛ばす (空の応答・配列・null・値が object)', () => {
    expect(flattenIchibanCheck({})).toEqual([])
    expect(flattenIchibanCheck({ diffs: { 燃料: [] as unknown, 勤怠: { 運転: null } }, drivers: [] })).toEqual([])
    const rows = flattenIchibanCheck({
      diffs: { 燃料: { 9004: { k: { nested: 1 } }, 9005: 'x' } },
      ids: { 燃料: { 9004: { k: [A, 1] } } },
    })
    expect(rows.map(r => [r.driverCd, r.value, r.ids])).toEqual([['9004', '', [A]]])
  })

  it('並びは 項目の固定順 → 乗務員CD → キー', () => {
    const rows = flattenIchibanCheck({
      diffs: {
        支払日: { 2: { b: 'x' } },
        燃料: { 2: { b: 1, a: 2 }, 1: { z: 3 } },
        勤怠: { 休息: { 1: { d: '1' } }, 運転: { 1: { d: '1' } } },
      },
    })
    expect(rows.map(r => r.key)).toEqual([
      '勤怠|休息|1|d',
      '勤怠|運転|1|d',
      '燃料||1|z',
      '燃料||2|a',
      '燃料||2|b',
      '支払日||2|b',
    ])
  })
})

describe('idsOfRows / chunkIds', () => {
  it('行の並びのまま重複なく集め、上限ごとに分ける', () => {
    const rows = flattenIchibanCheck({
      diffs: { 燃料: { 1: { a: 1, b: 2 } } },
      ids: { 燃料: { 1: { a: [A, B], b: [B, C] } } },
    })
    expect(idsOfRows(rows)).toEqual([A, B, C])
    expect(chunkIds([A, B, C], 2)).toEqual([[A, B], [C]])
    expect(chunkIds([])).toEqual([])
    expect(chunkIds(Array.from({ length: 501 }, (_, i) => String(i))).map(c => c.length)).toEqual([500, 1])
  })
})

describe('makecsv の結果', () => {
  it('CakePHP の results を読み、形が違う要素は落とす', () => {
    const results = parseMakecsvResults({
      results: [
        { id: A, status: 'written', reason: null, written: ['x.csv'] },
        { id: B, status: 'skipped', reason: 'not_found', written: [] },
        { id: C, status: 'error', reason: 'exception', written: 'no', message: 'boom' },
        { id: 1, status: 'written' },
        { id: A, status: 'other' },
        'junk',
      ],
    })
    expect(results).toEqual([
      { id: A, status: 'written', reason: null, written: ['x.csv'] },
      { id: B, status: 'skipped', reason: 'not_found', written: [] },
      { id: C, status: 'error', reason: 'exception', written: [], message: 'boom' },
    ])
    expect(countMakecsv(results)).toEqual({ written: 1, skipped: 1, error: 1 })
    expect(parseMakecsvResults(null)).toEqual([])
    expect(parseMakecsvResults({ results: 'x' })).toEqual([])
  })

  it('理由コードを日本語にし、知らないコードはそのまま', () => {
    expect(describeMakecsvReason('not_ending_with_1')).toBe('主乗務員の行ではない (末尾が 1 でない)')
    expect(describeMakecsvReason('ichizip_folder_missing')).toBe('ichizip の取り込みフォルダが無い')
    expect(describeMakecsvReason('new_reason')).toBe('new_reason')
    expect(describeMakecsvReason(null)).toBe('')
  })
})
