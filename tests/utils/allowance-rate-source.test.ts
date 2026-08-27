/**
 * 運行手当マスタの出どころ (Refs #805 PR-2)。
 *
 * 見ているのは 2 つ:
 *
 * 1. **3 状態が別々に決まること** — `r2` / `seed` / `error`。とくに
 *    **`error` を `seed` に倒さない**こと (最低賃金マスタで実際に踏んだ形)
 * 2. **R2 経由で解決したマスタで金額が 1 円も動かないこと** — 手当表PDF
 *    (2026-07 / 313 便) の golden を、同梱の初期値と R2 応答由来の配列の
 *    **両方**で引いて突き合わせる
 *
 * **陽性対照を付けてある** — 1 円だけ違う版・1 経路だけ消した版を作って、
 * 上の突合が**落ちる**ことを固定する。落ちない対照は対照ではない。
 */
import { describe, it, expect } from 'vitest'
import {
  ALLOWANCE_RATE_ENDPOINT,
  allowanceRateNotice,
  allowanceRateReadError,
  allowanceRateRows,
  resolveAllowanceRateMaster,
  type AllowanceRateState,
} from '~/utils/allowance-rate-source'
import { RATE_MASTER, type RateRow } from '~/utils/allowance-rate-master'
import { lookupAllowance } from '~/utils/allowance-rate'
import { ALLOWANCE_GOLDEN_2026_07 } from '../fixtures/allowance-golden-2026-07'

function row(over: Partial<RateRow> = {}): RateRow {
  return {
    shipper: '大石グループ',
    customer: '大石畜産',
    loader: '中部飼料',
    origin: '釧路',
    dest: '上士幌',
    brand: '大石前期',
    farePerT: 2750,
    allowanceYen: 9000,
    note: '',
    ...over,
  }
}

/** relay (`handleWageMasterRoute`) の GET 応答をそのまま真似る。 */
function getResponse(rows: RateRow[], over: Record<string, unknown> = {}) {
  return {
    exists: true,
    data: { rows: JSON.parse(JSON.stringify(rows)) as unknown },
    updated_at: '2026-08-27T00:00:00.000Z',
    version: 'a1b2c3d4e5f6',
    ...over,
  }
}

describe('ALLOWANCE_RATE_ENDPOINT', () => {
  it('PR-1 が足した relay の口を指す', () => {
    expect(ALLOWANCE_RATE_ENDPOINT).toBe('/restraint-api/allowance-rate')
  })
})

describe('resolveAllowanceRateMaster — 3 状態', () => {
  it('exists:true なら R2 の版で計算する (r2)', () => {
    const state = resolveAllowanceRateMaster(getResponse([row()]))
    expect(state).toEqual({
      status: 'r2',
      rows: [row()],
      version: 'a1b2c3d4e5f6',
      updatedAt: '2026-08-27T00:00:00.000Z',
    })
  })

  it('exists:false なら同梱の初期値 (seed)', () => {
    const state = resolveAllowanceRateMaster({ exists: false, data: null, version: null })
    expect(state).toEqual({ status: 'seed', rows: RATE_MASTER })
  })

  it('seed は差し替えられる (テストが本物の 62 行に依存しないように)', () => {
    const seed = [row({ allowanceYen: 1 })]
    expect(resolveAllowanceRateMaster({ exists: false }, seed)).toEqual({ status: 'seed', rows: seed })
  })

  it('version / updated_at が文字列でなければ null にする (error には倒さない)', () => {
    const state = resolveAllowanceRateMaster(getResponse([row()], { version: null, updated_at: undefined }))
    expect(state).toMatchObject({ status: 'r2', version: null, updatedAt: null })
  })
})

describe('resolveAllowanceRateMaster — 壊れていたら error (初期値へ倒さない)', () => {
  const cases: Array<[string, unknown, string]> = [
    ['応答が null', null, '応答が JSON オブジェクトではありません'],
    ['応答が文字列', 'ng', '応答が JSON オブジェクトではありません'],
    ['応答が配列', [], '応答が JSON オブジェクトではありません'],
    ['exists が無い', {}, '応答に exists がありません'],
    ['exists が文字列', { exists: 'true' }, '応答に exists がありません'],
    ['data が null', { exists: true, data: null }, 'data が JSON オブジェクトではありません'],
    ['data が配列', { exists: true, data: [] }, 'data が JSON オブジェクトではありません'],
    ['rows が配列でない', { exists: true, data: { rows: {} } }, 'data.rows が配列ではありません'],
    ['0 行', { exists: true, data: { rows: [] } }, 'R2 のマスタが 0 行です'],
  ]
  for (const [label, res, reason] of cases) {
    it(`${label} → error (${reason})`, () => {
      expect(resolveAllowanceRateMaster(res)).toEqual({ status: 'error', reason })
    })
  }

  it('**0 行を seed に倒さない** — 倒すと「読めた」と区別が付かなくなる', () => {
    const state = resolveAllowanceRateMaster({ exists: true, data: { rows: [] } })
    expect(state.status).toBe('error')
    expect(allowanceRateRows(state)).toBeNull()
  })
})

describe('resolveAllowanceRateMaster — 行の検証 (relay の normalize と同じ規則)', () => {
  const bad: Array<[string, unknown, string]> = [
    ['行が null', null, 'data.rows[0]がオブジェクトではありません'],
    ['行が配列', [], 'data.rows[0]がオブジェクトではありません'],
    ['shipper が無い', { ...row(), shipper: undefined }, 'data.rows[0].shipper が文字列ではありません'],
    ['note が無い', { ...row(), note: undefined }, 'data.rows[0].note が文字列ではありません'],
    ['dest が数値', { ...row(), dest: 1 }, 'data.rows[0].dest が文字列ではありません'],
    ['allowanceYen が文字列', { ...row(), allowanceYen: '9000' }, 'data.rows[0].allowanceYen が 0 以上の数値ではありません'],
    ['allowanceYen が NaN', { ...row(), allowanceYen: Number.NaN }, 'data.rows[0].allowanceYen が 0 以上の数値ではありません'],
    ['allowanceYen が負', { ...row(), allowanceYen: -1 }, 'data.rows[0].allowanceYen が 0 以上の数値ではありません'],
    ['farePerT が文字列', { ...row(), farePerT: '2750' }, 'data.rows[0].farePerT が数値でも null でもありません'],
    ['farePerT が Infinity', { ...row(), farePerT: Number.POSITIVE_INFINITY }, 'data.rows[0].farePerT が数値でも null でもありません'],
  ]
  for (const [label, rowRaw, reason] of bad) {
    it(`${label} → error`, () => {
      expect(resolveAllowanceRateMaster({ exists: true, data: { rows: [rowRaw] } }))
        .toEqual({ status: 'error', reason })
    })
  }

  it('farePerT: null は保持する (欠測を 0 に倒さない)', () => {
    const state = resolveAllowanceRateMaster(getResponse([row({ farePerT: null })]))
    expect(state).toMatchObject({ status: 'r2' })
    expect(allowanceRateRows(state)).toEqual([row({ farePerT: null })])
  })

  it('allowanceYen: 0 は通す (負だけを落とす)', () => {
    expect(resolveAllowanceRateMaster(getResponse([row({ allowanceYen: 0 })])).status).toBe('r2')
  })

  it('壊れた行の位置を理由に出す (2 行目)', () => {
    const state = resolveAllowanceRateMaster({ exists: true, data: { rows: [row(), { ...row(), brand: 3 }] } })
    expect(state).toEqual({ status: 'error', reason: 'data.rows[1].brand が文字列ではありません' })
  })

  it('行の順序を保つ', () => {
    const rows = [row({ dest: 'A' }), row({ dest: 'B' }), row({ dest: 'C' })]
    expect(allowanceRateRows(resolveAllowanceRateMaster(getResponse(rows)))?.map(r => r.dest))
      .toEqual(['A', 'B', 'C'])
  })
})

describe('allowanceRateReadError / allowanceRateRows', () => {
  it('通信の失敗は理由をそのまま運ぶ', () => {
    expect(allowanceRateReadError('502 relay が落ちています'))
      .toEqual({ status: 'error', reason: '502 relay が落ちています' })
  })

  it('error では rows が null (初期値へ倒す逃げ道を作らない)', () => {
    expect(allowanceRateRows(allowanceRateReadError('x'))).toBeNull()
  })

  it('r2 / seed では rows をそのまま返す', () => {
    expect(allowanceRateRows({ status: 'seed', rows: [row()] })).toEqual([row()])
    expect(allowanceRateRows({ status: 'r2', rows: [row()], version: null, updatedAt: null })).toEqual([row()])
  })
})

describe('allowanceRateNotice — 画面に出る 1 文 (合成後で固定)', () => {
  it('seed: 「R2 未設定のため同梱の初期値で表示しています」を必ず含む', () => {
    const state: AllowanceRateState = { status: 'seed', rows: RATE_MASTER }
    expect(allowanceRateNotice(state)).toBe(
      'R2 未設定のため同梱の初期値で表示しています (同梱 62 行)。R2 に登録すると deploy なしで金額を変えられます。',
    )
  })

  it('error: 理由を出し、「初期値には倒さない」「金額を出さない」と言う', () => {
    const state = allowanceRateReadError('会社IDまたはログイン情報が分かりません。拘束時間・賃金タブを一度開いてください')
    expect(allowanceRateNotice(state)).toBe(
      '運行手当マスタを読めませんでした — 会社IDまたはログイン情報が分かりません。'
      + '拘束時間・賃金タブを一度開いてください。同梱の初期値には倒さないため、手当・収支は表示しません。',
    )
  })

  it('r2: どの版で計算したかを出す', () => {
    const state = resolveAllowanceRateMaster(getResponse([row()]))
    expect(allowanceRateNotice(state)).toBe(
      'R2 の運行手当マスタで計算しています (1 行 / 版 a1b2c3d4e5f6 / 更新 2026-08-27T00:00:00.000Z)。',
    )
  })

  it('r2: 版・更新時刻が欠けていれば「不明」と出す (黙って隠さない)', () => {
    const state = resolveAllowanceRateMaster(getResponse([row()], { version: null, updated_at: null }))
    expect(allowanceRateNotice(state)).toBe(
      'R2 の運行手当マスタで計算しています (1 行 / 版 不明 / 更新 不明)。',
    )
  })

  it('3 状態の文はどれも同じにならない', () => {
    const seen = new Set([
      allowanceRateNotice({ status: 'seed', rows: RATE_MASTER }),
      allowanceRateNotice({ status: 'r2', rows: RATE_MASTER, version: 'v', updatedAt: 't' }),
      allowanceRateNotice(allowanceRateReadError('x')),
    ])
    expect(seen.size).toBe(3)
  })
})

// --- 移行の本体: R2 経由でも金額が 1 円も動かないこと -------------------------

/** golden 24 経路を `master` で引いた答え (`status` と金額)。 */
function goldenAnswers(master: RateRow[]): string[] {
  return ALLOWANCE_GOLDEN_2026_07.map((g) => {
    const got = lookupAllowance(g.origin, g.dest, master)
    return `${g.origin}〜${g.dest}: ${got.status} ${got.status === 'ok' ? got.allowanceYen : '-'}`
  })
}

/** `irregular:false` の経路の Σ(便数 × 手当)。**決まらない経路が出れば落ちる。** */
function goldenTotal(master: RateRow[]): number {
  let sum = 0
  for (const g of ALLOWANCE_GOLDEN_2026_07) {
    if (g.irregular) continue
    const got = lookupAllowance(g.origin, g.dest, master)
    if (got.status !== 'ok') throw new Error(`${g.origin}〜${g.dest} が ${got.status}`)
    sum += got.allowanceYen * g.trips
  }
  return sum
}

describe('R2 経由で解決したマスタ = 同梱の初期値 (手当表PDF 2026-07 / 313 便)', () => {
  /** **relay の GET 応答を通した** 62 行。JSON を 1 往復するので、型の落ち方も見ている。 */
  const viaR2 = allowanceRateRows(resolveAllowanceRateMaster(getResponse(RATE_MASTER)))!

  it('R2 応答を通しても 62 行が順序込みでそのまま戻る', () => {
    expect(viaR2).toEqual(RATE_MASTER)
    expect(viaR2.length).toBe(62)
  })

  it('golden 24 経路の答えが同梱の初期値と 1 つも変わらない', () => {
    expect(goldenAnswers(viaR2)).toEqual(goldenAnswers(RATE_MASTER))
  })

  it('golden の手当合計が 1 円も動かない', () => {
    const seedTotal = goldenTotal(RATE_MASTER)
    expect(goldenTotal(viaR2)).toBe(seedTotal)
    // **値そのものを固定する** — 「両方 0 円」でも上の等号は通ってしまうため。
    // ¥2,618,000 = `irregular:false` の 21 経路 / 296 便。**golden 側の
    // `allowanceYen` (PDF に印字された金額) から独立に足しても同じ額**になる
    // = マスタと PDF が一致している。
    expect(seedTotal).toBe(2618000)
    expect(ALLOWANCE_GOLDEN_2026_07.filter(g => !g.irregular).reduce((s, g) => s + g.allowanceYen * g.trips, 0))
      .toBe(2618000)
  })

  it('★ 陽性対照: 1 円だけ違う版なら上の 2 本が落ちる', () => {
    const bumped = RATE_MASTER.map(r => (
      r.origin === '釧路' && r.dest === '上士幌' ? { ...r, allowanceYen: r.allowanceYen + 1 } : r
    ))
    const tampered = allowanceRateRows(resolveAllowanceRateMaster(getResponse(bumped)))!
    expect(goldenAnswers(tampered)).not.toEqual(goldenAnswers(RATE_MASTER))
    expect(goldenTotal(tampered)).not.toBe(goldenTotal(RATE_MASTER))
    // 釧路〜上士幌 は 46 便。1 円上げれば合計はちょうど 46 円増える。
    expect(goldenTotal(tampered)).toBe(goldenTotal(RATE_MASTER) + 46)
  })

  it('★ 陽性対照: 1 経路を消すと ok → unknown に変わる (手当が減る経路が実在する)', () => {
    const removed = RATE_MASTER.filter(r => !(r.origin === '釧路' && r.dest === '上士幌'))
    const thinned = allowanceRateRows(resolveAllowanceRateMaster(getResponse(removed)))!
    expect(lookupAllowance('釧路', '上士幌', RATE_MASTER).status).toBe('ok')
    expect(lookupAllowance('釧路', '上士幌', thinned).status).toBe('unknown')
    expect(() => goldenTotal(thinned)).toThrow('釧路〜上士幌 が unknown')
  })
})
