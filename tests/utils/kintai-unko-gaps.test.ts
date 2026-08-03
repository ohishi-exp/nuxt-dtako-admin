import { describe, it, expect } from 'vitest'
import {
  kintaiUnkoGapDtakoCheckResultFromLookup,
  kintaiUnkoGapDtakoCheckView,
  kintaiUnkoGapsDeriveStartOpe,
  kintaiUnkoGapsDriverTotalCount,
  kintaiUnkoGapsReadability,
  parseKintaiUnkoGaps,
} from '~/utils/kintai-unko-gaps'

/**
 * rust-ichibanboshi `unko_gaps.rs` の実応答形 (★ #630-1 で本番実測して確定 —
 * `drivers[].driver_cd` は `HashMap<String, _>` 由来の**文字列**。トップレベルの
 * `driver_cd` (絞り込み指定の echo) だけが `Option<i64>` = 数値 or null で別物)。
 * #623-2 時点の fixture は `drivers[].driver_cd` を数値と誤って固定しており、
 * それがそのまま「候補は実在するのに `drivers: []` に化ける」実バグだった。
 */
function body(over: Record<string, unknown> = {}) {
  return {
    month: '2026-06',
    driver_cd: null,
    gcp_etags_available: true,
    driver_cds_available: true,
    unko_no_digits: 22,
    drivers: [
      { driver_cd: '1445', unko_nos: ['2606011234560001234560'], truncated: false },
      { driver_cd: '1740', unko_nos: ['2606021234560001234561', '2606031234560001234562'], truncated: false },
    ],
    drivers_truncated: false,
    unknown_driver_unko_nos: [],
    unknown_driver_unko_nos_truncated: false,
    elapsed_ms: 12345,
    ...over,
  }
}

describe('parseKintaiUnkoGaps', () => {
  it('確定済みの応答を camelCase に読み替える', () => {
    const r = parseKintaiUnkoGaps(body())
    expect(r).toEqual({
      month: '2026-06',
      driverCd: null,
      gcpEtagsAvailable: true,
      driverCdsAvailable: true,
      unkoNoDigits: 22,
      drivers: [
        { driverCd: '1445', unkoNos: ['2606011234560001234560'], truncated: false },
        { driverCd: '1740', unkoNos: ['2606021234560001234561', '2606031234560001234562'], truncated: false },
      ],
      driversTruncated: false,
      unknownDriverUnkoNos: [],
      unknownDriverUnkoNosTruncated: false,
      elapsedMs: 12345,
    })
  })

  it('driver_cd (絞り込み指定・トップレベル) が文字列でも数値でも読む', () => {
    expect(parseKintaiUnkoGaps(body({ driver_cd: '1445' })).driverCd).toBe('1445')
    // 実際の受け口は Option<i64> = 数値 or null で返す (drivers[].driver_cd とは別物)
    expect(parseKintaiUnkoGaps(body({ driver_cd: 1445 })).driverCd).toBe('1445')
  })

  it('null/文字列/配列でない drivers は空扱い (壊さない)', () => {
    expect(parseKintaiUnkoGaps(null)).toEqual({
      month: null,
      driverCd: null,
      gcpEtagsAvailable: null,
      driverCdsAvailable: null,
      unkoNoDigits: null,
      drivers: [],
      driversTruncated: false,
      unknownDriverUnkoNos: [],
      unknownDriverUnkoNosTruncated: false,
      elapsedMs: null,
    })
    expect(parseKintaiUnkoGaps('x').drivers).toEqual([])
    expect(parseKintaiUnkoGaps(body({ drivers: 'not-array' })).drivers).toEqual([])
  })

  it('driver_cd の無い/空文字・object でない要素は捨てる (driver_cd が主キー、文字列も数値も両方受ける)', () => {
    const r = parseKintaiUnkoGaps(
      body({
        drivers: [
          { unko_nos: ['x'] },
          'x',
          null,
          { driver_cd: '', unko_nos: ['x'] },
          { driver_cd: '9', unko_nos: ['x'] },
          { driver_cd: 9, unko_nos: ['2606011234560001234560'], truncated: true },
        ],
      }),
    )
    expect(r.drivers).toEqual([
      { driverCd: '9', unkoNos: ['x'], truncated: false },
      { driverCd: '9', unkoNos: ['2606011234560001234560'], truncated: true },
    ])
  })

  it('unko_nos が配列でない/文字列以外を含むなら弾く', () => {
    const r = parseKintaiUnkoGaps(body({ drivers: [{ driver_cd: '1', unko_nos: ['a', 1, null, 'b'] }] }))
    expect(r.drivers).toEqual([{ driverCd: '1', unkoNos: ['a', 'b'], truncated: false }])
  })

  it('可用性フラグが真偽値以外なら null (「引けていない」を捨てない)', () => {
    const r = parseKintaiUnkoGaps(body({ gcp_etags_available: 'x', driver_cds_available: undefined }))
    expect(r.gcpEtagsAvailable).toBeNull()
    expect(r.driverCdsAvailable).toBeNull()
  })

  it('unknown_driver_unko_nos / truncated 系のデフォルトは空・false', () => {
    const r = parseKintaiUnkoGaps({ month: '2026-06' })
    expect(r.unknownDriverUnkoNos).toEqual([])
    expect(r.unknownDriverUnkoNosTruncated).toBe(false)
    expect(r.driversTruncated).toBe(false)
  })
})

describe('kintaiUnkoGapsReadability (★ #620/#615-7 と同型: 「無い」と「引けていない」を区別する)', () => {
  it('両方 true なら ok', () => {
    expect(kintaiUnkoGapsReadability(parseKintaiUnkoGaps(body()))).toBe('ok')
  })

  it('gcp_etags_available: false は etags_unavailable (driver_cds の値に関わらず優先)', () => {
    expect(
      kintaiUnkoGapsReadability(parseKintaiUnkoGaps(body({ gcp_etags_available: false }))),
    ).toBe('etags_unavailable')
    expect(
      kintaiUnkoGapsReadability(
        parseKintaiUnkoGaps(body({ gcp_etags_available: false, driver_cds_available: false })),
      ),
    ).toBe('etags_unavailable')
  })

  it('driver_cds_available: false だけなら driver_cds_unavailable', () => {
    expect(
      kintaiUnkoGapsReadability(parseKintaiUnkoGaps(body({ driver_cds_available: false }))),
    ).toBe('driver_cds_unavailable')
  })

  it('null (欠落・型不一致) は false 同様に「引けていない」扱い', () => {
    expect(kintaiUnkoGapsReadability(parseKintaiUnkoGaps({}))).toBe('etags_unavailable')
  })

  it('driver_cds_available だけが欠落・型不一致でも driver_cds_unavailable (gcp_etags_available: true と同時に成立させて確認)', () => {
    expect(
      kintaiUnkoGapsReadability(parseKintaiUnkoGaps(body({ driver_cds_available: undefined }))),
    ).toBe('driver_cds_unavailable')
    expect(
      kintaiUnkoGapsReadability(parseKintaiUnkoGaps(body({ driver_cds_available: 'x' }))),
    ).toBe('driver_cds_unavailable')
  })
})

describe('kintaiUnkoGapsDriverTotalCount', () => {
  it('乗務員別 unko_nos の延べ件数を数える', () => {
    expect(kintaiUnkoGapsDriverTotalCount(parseKintaiUnkoGaps(body()))).toBe(3)
  })

  it('drivers が空なら0', () => {
    expect(kintaiUnkoGapsDriverTotalCount(parseKintaiUnkoGaps({}))).toBe(0)
  })
})

describe('kintaiUnkoGapsDeriveStartOpe (★ 表示専用。捏造しない — 23桁を作らない)', () => {
  it('22桁 (GCP側) の先頭12桁から start_ope 形式を作る (時は0埋めなし)', () => {
    // 26-06-01 09:03:07 の想定 (先頭2桁=年下2桁、以降 月日時分秒)
    expect(kintaiUnkoGapsDeriveStartOpe('2606010903070001234560')).toBe('2026/06/01 9:03:07')
  })

  it('時が2桁 (10時以降) ならそのまま2桁', () => {
    expect(kintaiUnkoGapsDeriveStartOpe('2606011430070001234560')).toBe('2026/06/01 14:30:07')
  })

  it('23桁 (オンプレ形) でも先頭12桁は同じ意味なので読める', () => {
    expect(kintaiUnkoGapsDeriveStartOpe('26060109030700012345601')).toBe('2026/06/01 9:03:07')
  })

  it('22桁でも23桁でもない (桁数違反) は null', () => {
    expect(kintaiUnkoGapsDeriveStartOpe('123')).toBeNull()
    expect(kintaiUnkoGapsDeriveStartOpe('a'.repeat(22))).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 候補ごとの「オンプレにデジタコが在るか」チェック (Refs #633-1 条件8〜14)。
// 親の実測 (2026-08-04): unko-gaps の候補は `time_card_dtako` の有無しか見ておらず、
// `dtako_events` (デジタコ自体) は取り込み済みでも候補に出る (1445 の実例)。
// ─────────────────────────────────────────────────────────────────────────

describe('kintaiUnkoGapDtakoCheckResultFromLookup', () => {
  it('found → present (見つかった23桁を持つ)', () => {
    expect(kintaiUnkoGapDtakoCheckResultFromLookup('found', '26062513554200000034471')).toEqual({
      status: 'present',
      unkoNo23: '26062513554200000034471',
    })
  })

  it('not_found → absent', () => {
    expect(kintaiUnkoGapDtakoCheckResultFromLookup('not_found', null)).toEqual({
      status: 'absent',
      unkoNo23: null,
    })
  })

  it('ambiguous → inconclusive (「無い」と混同しない、条件12)', () => {
    expect(kintaiUnkoGapDtakoCheckResultFromLookup('ambiguous', null)).toEqual({
      status: 'inconclusive',
      unkoNo23: null,
    })
  })

  it('null (応答が読めなかった) → inconclusive', () => {
    expect(kintaiUnkoGapDtakoCheckResultFromLookup(null, null)).toEqual({
      status: 'inconclusive',
      unkoNo23: null,
    })
  })
})

describe('kintaiUnkoGapDtakoCheckView (★ 「押せば直る」と読める書き方をしない、条件10)', () => {
  it('present: 「取り込み漏れではない」は書くが「直る」とは断定しない', () => {
    const view = kintaiUnkoGapDtakoCheckView({ status: 'present', unkoNo23: '26062513554200000034471' })
    expect(view.status).toBe('present')
    expect(view.message).toContain('取り込み漏れではありません')
    expect(view.message).toContain('保証ではありません')
    expect(view.unkoNo23).toBe('26062513554200000034471')
  })

  it('absent: その乗務員・その日で引いた限り、と断定しない書き方', () => {
    const view = kintaiUnkoGapDtakoCheckView({ status: 'absent', unkoNo23: null })
    expect(view.status).toBe('absent')
    expect(view.message).toContain('見つかりません')
    expect(view.unkoNo23).toBeNull()
  })

  it('inconclusive: 「調べられていません」(not_found と同じ文言にしない)', () => {
    const view = kintaiUnkoGapDtakoCheckView({ status: 'inconclusive', unkoNo23: null })
    expect(view.message).toContain('調べられていません')
    expect(view.message).not.toContain('見つかりません')
  })

  it('result が undefined (まだ調べていない候補) も inconclusive と同じ文言 (条件12: ambiguous/エラー/未実行をまとめる)', () => {
    const view = kintaiUnkoGapDtakoCheckView(undefined)
    expect(view.status).toBe('inconclusive')
    expect(view.message).toBe(kintaiUnkoGapDtakoCheckView({ status: 'inconclusive', unkoNo23: null }).message)
  })

  it('★ issue #633 実測: 1445は found (dtako_events 在り) なので present', () => {
    const result = kintaiUnkoGapDtakoCheckResultFromLookup('found', '26062513554200000034471')
    const view = kintaiUnkoGapDtakoCheckView(result)
    expect(view.status).toBe('present')
  })

  it('★ issue #633 実測: 1740は not_found (operations: []) なので absent', () => {
    const result = kintaiUnkoGapDtakoCheckResultFromLookup('not_found', null)
    const view = kintaiUnkoGapDtakoCheckView(result)
    expect(view.status).toBe('absent')
  })
})
