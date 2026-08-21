import { describe, it, expect } from 'vitest'
import {
  normalizePlace,
  placeKey,
  resolveDest,
  matchRows,
  lookupAllowance,
  lookupFare,
  DEST_ALIASES,
} from '~/utils/allowance-rate'
import { RATE_MASTER, type RateRow } from '~/utils/allowance-rate-master'
import { ALLOWANCE_GOLDEN_2026_07 } from '../fixtures/allowance-golden-2026-07'

/** テスト用のマスタ行。既定はどの検査にも引っかからない中立な値。 */
function row(over: Partial<RateRow>): RateRow {
  return {
    shipper: '', customer: '', loader: '', origin: 'テスト積地', dest: 'テスト卸地',
    brand: '', farePerT: 1000, allowanceYen: 5000, note: '', ...over,
  }
}

describe('normalizePlace', () => {
  it('全角空白・半角空白を落として NFKC で揃える', () => {
    expect(normalizePlace('清水　ﾉﾍﾞﾙｽﾞDF')).toBe('清水ノベルズDF')
    expect(normalizePlace('  上士幌 ')).toBe('上士幌')
  })

  it('null / undefined は空文字にする (API 越しに来うる)', () => {
    expect(normalizePlace(null)).toBe('')
    expect(normalizePlace(undefined)).toBe('')
  })
})

describe('placeKey', () => {
  it('複数卸しは最終卸し地を採る', () => {
    expect(placeKey('清水・富士')).toBe('富士')
    expect(placeKey('札内・音更')).toBe('音更')
  })

  it('括弧書きは括弧の外を採る (全角・半角どちらも)', () => {
    expect(placeKey('駒場（別海）')).toBe('駒場')
    expect(placeKey('駒場(釧路)')).toBe('駒場')
    expect(placeKey('（清水）・富士')).toBe('富士')
  })

  it('空セルは空文字', () => {
    expect(placeKey('')).toBe('')
    expect(placeKey('・')).toBe('')
  })
})

describe('resolveDest', () => {
  it('積地によって卸し先が変わる地名を、積地込みで寄せる', () => {
    expect(resolveDest('釧路', '士幌')).toBe('溝口')
    expect(resolveDest('広尾', '士幌')).toBe('松山/士幌')
  })

  it('別名の無い地名はそのまま', () => {
    expect(resolveDest('釧路', '川西')).toBe('川西')
  })

  it('別名表のキーは必ず 積地|卸地 の形 (卸地だけのキーを混ぜない)', () => {
    for (const key of Object.keys(DEST_ALIASES)) expect(key).toContain('|')
  })
})

describe('matchRows', () => {
  it('積地と (寄せた) 卸地の両方が一致する行だけを返す', () => {
    const rows = matchRows('釧路', '標茶')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.origin === '釧路' && r.dest === 'FCS標茶')).toBe(true)
  })

  it('士幌 は積地違いで別の行に当たる (上士幌 に吸われない)', () => {
    expect(matchRows('釧路', '士幌').every(r => r.dest === '溝口')).toBe(true)
    expect(matchRows('広尾', '士幌').every(r => r.dest === '松山/士幌')).toBe(true)
  })

  it('マスタを差し替えられる', () => {
    const master = [row({ origin: 'A', dest: 'B' })]
    expect(matchRows('A', 'B', master)).toHaveLength(1)
    expect(matchRows('A', 'C', master)).toHaveLength(0)
  })
})

describe('lookupAllowance', () => {
  it('2026-07 の手当表PDF 24 経路と突き合わせる', () => {
    const mismatches: string[] = []
    for (const g of ALLOWANCE_GOLDEN_2026_07) {
      const got = lookupAllowance(g.origin, g.dest)
      if (g.irregular) {
        if (got.status !== 'unknown') mismatches.push(`${g.origin}〜${g.dest}: ${got.status} (マスタに無いはず)`)
        continue
      }
      if (got.status !== 'ok') mismatches.push(`${g.origin}〜${g.dest}: ${got.status}`)
      else if (got.allowanceYen !== g.allowanceYen) {
        mismatches.push(`${g.origin}〜${g.dest}: マスタ ${got.allowanceYen} / PDF ${g.allowanceYen}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('PDF の便のうちマスタで金額が決まる割合を固定する (回帰検知)', () => {
    const covered = ALLOWANCE_GOLDEN_2026_07
      .filter(g => !g.irregular)
      .reduce((sum, g) => sum + g.trips, 0)
    const total = ALLOWANCE_GOLDEN_2026_07.reduce((sum, g) => sum + g.trips, 0)
    expect(total).toBe(313)
    // 294 → 295: `釧路〜駒場（別海）` (1 便) をマスタへ足した (2026-08-21)。
    expect(covered).toBe(295)
  })

  it('マスタに無い経路は推測せず unknown を返す', () => {
    const got = lookupAllowance('広尾', '芽室')
    expect(got).toEqual({ status: 'unknown', dest: '芽室' })
  })

  it('同じ経路に複数の金額があれば ambiguous (自動では決めない)', () => {
    const master = [
      row({ origin: 'A', dest: 'B', allowanceYen: 9000 }),
      row({ origin: 'A', dest: 'B', allowanceYen: 8000 }),
    ]
    expect(lookupAllowance('A', 'B', master)).toEqual({
      status: 'ambiguous', dest: 'B', candidates: [8000, 9000],
    })
  })
})

describe('lookupFare', () => {
  it('銘柄まで見て運賃 (円/t) を引く', () => {
    expect(lookupFare('釧路', '標茶', '星空の前期')).toBe(3000)
    expect(lookupFare('釧路', '士幌', 'ﾐｯｸｽ18')).toBe(3900)
  })

  it('銘柄が空のマスタ行はどの銘柄にも一致する (卸地だけで運賃が決まる契約)', () => {
    expect(lookupFare('士幌', '清水', '何でもよい')).toBe(2520)
  })

  it('該当が無ければ null', () => {
    expect(lookupFare('釧路', '標茶', '存在しない銘柄')).toBeNull()
  })

  it('運賃が一意に決まらなければ null', () => {
    const master = [
      row({ origin: 'A', dest: 'B', farePerT: 3000 }),
      row({ origin: 'A', dest: 'B', farePerT: 4000 }),
    ]
    expect(lookupFare('A', 'B', '', master)).toBeNull()
  })

  it('運賃が未設定 (null) の行しか無ければ null', () => {
    expect(lookupFare('A', 'B', '', [row({ origin: 'A', dest: 'B', farePerT: null })])).toBeNull()
  })
})

describe('RATE_MASTER', () => {
  it('積地・卸地・給与が埋まっている (結合セルの引き継ぎ漏れ検知)', () => {
    // 60 → 61: `釧路〜駒場（別海）` を足した (2026-08-21、xlsx 未収載の実在経路)。
    expect(RATE_MASTER.length).toBe(61)
    for (const r of RATE_MASTER) {
      expect(r.origin).not.toBe('')
      expect(r.dest).not.toBe('')
      expect(r.allowanceYen).toBeGreaterThan(0)
    }
  })

  it('同じ 積地+卸地 に 2 通りの給与が無い', () => {
    const byRoute = new Map<string, Set<number>>()
    for (const r of RATE_MASTER) {
      const key = `${r.origin}|${r.dest}`
      const set = byRoute.get(key) ?? new Set<number>()
      set.add(r.allowanceYen)
      byRoute.set(key, set)
    }
    expect([...byRoute].filter(([, v]) => v.size > 1).map(([k]) => k)).toEqual([])
  })
})
