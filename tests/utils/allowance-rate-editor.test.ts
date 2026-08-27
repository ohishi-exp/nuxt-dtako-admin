/**
 * 運行手当マスタの**編集** (Refs #805 PR-3)。
 *
 * 見ているのは 4 つ:
 *
 * 1. **3 状態のうち編集させるのは 2 つだけ** — `error` は `locked`。読めていない版を
 *    上書きすると他の人の保存が消える
 * 2. **`seed` でも `baseVersion` を送る** (空文字)。省くと relay が無条件保存になり、
 *    同じ `seed` を見た 2 人の後勝ちで先の登録が黙って消える
 * 3. **409 では手元を上書きしない** — サーバの現在値は別に読み解いて並べるだけ
 * 4. **編集 UI を足しても金額は 1 円も動かない** — 入力欄への往復 (`RateRow` →
 *    文字列 → `RateRow`) を通した 62 行で golden (2026-07 / 313 便) を引き直す
 *
 * **陽性対照を付けてある** — 入力欄で 1 円だけ変えると 4 が落ちること、
 * 0 行にすると保存が止まることを固定する。落ちない対照は対照ではない。
 */
import { describe, it, expect } from 'vitest'
import {
  ALLOWANCE_RATE_STALE_AMOUNTS_NOTICE,
  allowanceRateDiffLabel,
  allowanceRateEditability,
  allowanceRateRowDiff,
  allowanceRateSaveLabel,
  allowanceRateSavedMessage,
  emptyAllowanceRateDraftRow,
  parseAllowanceRateDraft,
  resolveAllowanceRateConflict,
  resolveAllowanceRateSave,
  toAllowanceRateDraft,
  type AllowanceRateDraftRow,
} from '~/utils/allowance-rate-editor'
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

function draftRow(over: Partial<AllowanceRateDraftRow> = {}): AllowanceRateDraftRow {
  return { ...toAllowanceRateDraft([row()])[0]!, ...over }
}

// --- 1. 3 状態のどれで編集させるか -------------------------------------------

describe('allowanceRateEditability — 編集させてよいのは 2 状態だけ', () => {
  it('r2 → edit。baseVersion は読んだ version', () => {
    expect(allowanceRateEditability({ status: 'r2', rows: [row()], version: 'abc123', updatedAt: 'x' }))
      .toEqual({ mode: 'edit', baseVersion: 'abc123', rows: [row()] })
  })

  it('r2 で version が null なら空文字 (その回だけ楽観排他が効かない)', () => {
    expect(allowanceRateEditability({ status: 'r2', rows: [row()], version: null, updatedAt: null }))
      .toEqual({ mode: 'edit', baseVersion: '', rows: [row()] })
  })

  it('seed → register。**baseVersion は空文字を送る** (省かない)', () => {
    // 空文字は relay の `typeof baseVersion === "string"` を満たすので、
    // 先に誰かが登録していたら 409 になる。省くと無条件保存で後勝ちになる。
    expect(allowanceRateEditability({ status: 'seed', rows: [row()] }))
      .toEqual({ mode: 'register', baseVersion: '', rows: [row()] })
  })

  it('error → locked。**rows を持たない**ので初期値へ倒しようがない', () => {
    const locked = allowanceRateEditability({ status: 'error', reason: '応答に exists がありません' })
    expect(locked.mode).toBe('locked')
    expect(locked).not.toHaveProperty('rows')
    expect(locked).not.toHaveProperty('baseVersion')
  })

  it('locked の理由は**何が起きるか**まで書く (読めないまま保存すると他人の版が消える)', () => {
    const locked = allowanceRateEditability({ status: 'error', reason: 'R2 のマスタが 0 行です' })
    expect(locked.mode === 'locked' && locked.reason).toBe(
      '運行手当マスタを読めていないので編集できません — R2 のマスタが 0 行です。'
      + '読めないまま保存すると、他の人が保存した版を上書きします。',
    )
  })
})

// --- 2. ボタンと保存後の 1 文 -------------------------------------------------

describe('allowanceRateSaveLabel — 「登録」と「保存」を分ける', () => {
  it('register は「R2 に登録」', () => {
    expect(allowanceRateSaveLabel('register')).toBe('R2 に登録')
  })

  it('edit は「マスタを保存」', () => {
    expect(allowanceRateSaveLabel('edit')).toBe('マスタを保存')
  })

  it('2 つは同じ文字列にならない (押す前に区別が付く)', () => {
    expect(allowanceRateSaveLabel('register')).not.toBe(allowanceRateSaveLabel('edit'))
  })
})

describe('allowanceRateSavedMessage — changed の出し分け (salary-item-config と同じ型)', () => {
  it('★ 陽性対照: changed:true で「新しい版を作成」', () => {
    expect(allowanceRateSavedMessage('edit', true)).toBe('運行手当マスタを保存しました (新しい版を作成)')
  })

  it('★ 陽性対照: changed:false で「内容は前回と同一」', () => {
    // 「保存しました」だけだと、同じ内容を押した人が「版が増えた」と誤解する。
    expect(allowanceRateSavedMessage('edit', false)).toBe('運行手当マスタを保存しました (内容は前回と同一)')
  })

  it('register も同じ出し分けを持つ (文言だけ「R2 に登録しました」)', () => {
    expect(allowanceRateSavedMessage('register', true)).toBe('運行手当マスタを R2 に登録しました (新しい版を作成)')
    expect(allowanceRateSavedMessage('register', false)).toBe('運行手当マスタを R2 に登録しました (内容は前回と同一)')
  })

  it('4 通りが全部違う文字列 (どれを押したか読み取れる)', () => {
    const all = [
      allowanceRateSavedMessage('edit', true),
      allowanceRateSavedMessage('edit', false),
      allowanceRateSavedMessage('register', true),
      allowanceRateSavedMessage('register', false),
    ]
    expect(new Set(all).size).toBe(4)
  })
})

describe('ALLOWANCE_RATE_STALE_AMOUNTS_NOTICE — 保存直後の金額は古い', () => {
  it('「保存前のマスタ」と「集計 を押す」の両方が入っている', () => {
    expect(ALLOWANCE_RATE_STALE_AMOUNTS_NOTICE)
      .toBe('表示中の金額は保存前のマスタで計算したものです。集計 を押すと引き直します。')
  })
})

// --- 3. 入力欄 ⇔ RateRow -----------------------------------------------------

describe('toAllowanceRateDraft — 数値を入力欄の文字列にする', () => {
  it('farePerT: null は**空欄**にする (0 にしない)', () => {
    expect(toAllowanceRateDraft([row({ farePerT: null })])[0]!.farePerT).toBe('')
  })

  it('数値は文字列になる', () => {
    const d = toAllowanceRateDraft([row()])[0]!
    expect(d.farePerT).toBe('2750')
    expect(d.allowanceYen).toBe('9000')
    expect(d.shipper).toBe('大石グループ')
    expect(d.note).toBe('')
  })
})

describe('emptyAllowanceRateDraftRow — 追加した行', () => {
  it('**手当も空**にする (0 を既定にすると「手当 ¥0 の経路」を黙って作る)', () => {
    expect(emptyAllowanceRateDraftRow()).toEqual({
      shipper: '', customer: '', loader: '', origin: '', dest: '', brand: '',
      farePerT: '', allowanceYen: '', note: '',
    })
  })

  it('追加した直後は保存できない (手当が空なので止まる)', () => {
    expect(parseAllowanceRateDraft([draftRow(), emptyAllowanceRateDraftRow()]))
      .toEqual({ ok: false, errors: ['2 行目: 手当 (円/便) が空です'] })
  })
})

describe('parseAllowanceRateDraft — 規則は relay の normalize と同じ', () => {
  it('62 行を往復させても 1 バイトも変わらない (順序込み)', () => {
    const parsed = parseAllowanceRateDraft(toAllowanceRateDraft(RATE_MASTER))
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.rows).toEqual(RATE_MASTER)
    expect(parsed.ok && parsed.rows.length).toBe(62)
  })

  it('運賃の空欄は null (0 に倒さない)', () => {
    const parsed = parseAllowanceRateDraft([draftRow({ farePerT: '' })])
    expect(parsed.ok && parsed.rows[0]!.farePerT).toBeNull()
  })

  it('空白だけの運賃も null', () => {
    const parsed = parseAllowanceRateDraft([draftRow({ farePerT: '   ' })])
    expect(parsed.ok && parsed.rows[0]!.farePerT).toBeNull()
  })

  it('前後の空白は落として数える', () => {
    const parsed = parseAllowanceRateDraft([draftRow({ farePerT: ' 2750 ', allowanceYen: ' 9000 ' })])
    expect(parsed.ok && parsed.rows[0]).toEqual(row())
  })

  it('手当 0 円は通す (relay も 0 以上なら通すので、ここで弾くと形が割れる)', () => {
    const parsed = parseAllowanceRateDraft([draftRow({ allowanceYen: '0' })])
    expect(parsed.ok && parsed.rows[0]!.allowanceYen).toBe(0)
  })

  it('文字列 7 項目は空を許す (brand / note に空の行が実在する)', () => {
    const parsed = parseAllowanceRateDraft([draftRow({ brand: '', note: '' })])
    expect(parsed.ok).toBe(true)
  })

  const bad: Array<[string, Partial<AllowanceRateDraftRow>, string]> = [
    ['運賃が数値でない', { farePerT: 'いくらか' }, '1 行目: 運賃 (円/t) が数値ではありません'],
    ['手当が数値でない', { allowanceYen: 'たくさん' }, '1 行目: 手当 (円/便) が数値ではありません'],
    ['手当が空', { allowanceYen: '' }, '1 行目: 手当 (円/便) が空です'],
    ['手当が負', { allowanceYen: '-1' }, '1 行目: 手当 (円/便) が負の数です'],
  ]
  for (const [label, over, message] of bad) {
    it(`${label} → 保存しない (${message})`, () => {
      expect(parseAllowanceRateDraft([draftRow(over)])).toEqual({ ok: false, errors: [message] })
    })
  }

  it('1 行に 2 つ壊れていれば 2 つとも出す', () => {
    expect(parseAllowanceRateDraft([draftRow({ farePerT: 'x', allowanceYen: 'y' })]))
      .toEqual({ ok: false, errors: ['1 行目: 運賃 (円/t) が数値ではありません', '1 行目: 手当 (円/便) が数値ではありません'] })
  })

  it('行番号は 1 始まり (画面の行と同じ数え方)', () => {
    expect(parseAllowanceRateDraft([draftRow(), draftRow(), draftRow({ allowanceYen: '' })]))
      .toEqual({ ok: false, errors: ['3 行目: 手当 (円/便) が空です'] })
  })

  it('壊れた行があれば**1 行も保存しない** (部分保存しない)', () => {
    const parsed = parseAllowanceRateDraft([draftRow(), draftRow({ allowanceYen: 'x' })])
    expect(parsed).not.toHaveProperty('rows')
  })

  it('★ 0 行は止める — relay は通すが、次に読むと error になり全便の手当が消える', () => {
    expect(parseAllowanceRateDraft([])).toEqual({
      ok: false,
      errors: ['1 行も残っていません。マスタを空で保存すると、次に読んだとき「0 行」として読めなくなります'],
    })
  })

  it('★ 陰性対照: 1 行でも残っていれば 0 行のエラーは出ない', () => {
    expect(parseAllowanceRateDraft([draftRow()]).ok).toBe(true)
  })
})

// --- 4. 409 (楽観排他) -------------------------------------------------------

/** relay が 409 で返す本文をそのまま真似る。 */
function conflictBody(rows: unknown, version: unknown = 'srv999') {
  return { error: 'conflict', current: { data: rows === null ? null : { rows }, version } }
}

describe('resolveAllowanceRateConflict — 上書きせず現在値を見せる', () => {
  it('先頭は必ず「他の人が先に保存しています」+「送っていない」', () => {
    const c = resolveAllowanceRateConflict(conflictBody([row()]))
    expect(c.message).toBe(
      '他の人が先に保存しています。あなたの編集は送っていません (サーバは書き換わっていません)。'
      + 'サーバの現在値は 1 行 / 版 srv999 です。',
    )
    expect(c.version).toBe('srv999')
    expect(c.rows).toEqual([row()])
  })

  it('version が文字列でなければ「不明」と書く (黙って空にしない)', () => {
    const c = resolveAllowanceRateConflict(conflictBody([row()], 42))
    expect(c.version).toBeNull()
    expect(c.message).toContain('版 不明')
  })

  const noCurrent: Array<[string, unknown]> = [
    ['本文が null', null],
    ['本文が文字列', 'conflict'],
    ['本文が配列', []],
    ['current が無い', { error: 'conflict' }],
    ['current が null', { error: 'conflict', current: null }],
    ['current が配列', { error: 'conflict', current: [] }],
  ]
  for (const [label, body] of noCurrent) {
    it(`${label} → 現在値なしと書く (成功にはしない)`, () => {
      const c = resolveAllowanceRateConflict(body)
      expect(c.rows).toBeNull()
      expect(c.version).toBeNull()
      expect(c.message).toContain('サーバの現在値が応答に入っていません')
    })
  }

  it('現在値が壊れていれば**理由をそのまま運ぶ** (resolveAllowanceRateMaster と同じ規則)', () => {
    const c = resolveAllowanceRateConflict(conflictBody([{ ...row(), allowanceYen: '9000' }]))
    expect(c.rows).toBeNull()
    expect(c.message).toContain('data.rows[0].allowanceYen が 0 以上の数値ではありません')
  })

  it('現在値が 0 行でも「読み取れませんでした」に倒す (0 行は読めたことにしない)', () => {
    const c = resolveAllowanceRateConflict(conflictBody([]))
    expect(c.rows).toBeNull()
    expect(c.message).toContain('R2 のマスタが 0 行です')
  })

  it('data が null なら理由を出す', () => {
    const c = resolveAllowanceRateConflict(conflictBody(null))
    expect(c.rows).toBeNull()
    expect(c.message).toContain('data が JSON オブジェクトではありません')
  })
})

describe('resolveAllowanceRateSave — ★ 409 で上書きしない', () => {
  it('2xx なら changed の出し分けだけ', () => {
    expect(resolveAllowanceRateSave('edit', [row()], { ok: true, changed: true }))
      .toEqual({ kind: 'saved', message: '運行手当マスタを保存しました (新しい版を作成)' })
    expect(resolveAllowanceRateSave('register', [row()], { ok: true, changed: false }))
      .toEqual({ kind: 'saved', message: '運行手当マスタを R2 に登録しました (内容は前回と同一)' })
  })

  it('★ 409 は saved にならない (押した人が「保存できた」と読まない)', () => {
    const r = resolveAllowanceRateSave('edit', [row()], {
      ok: false, status: 409, body: conflictBody([row({ allowanceYen: 9500 })]), reason: '409 conflict',
    })
    expect(r.kind).toBe('conflict')
    expect(r.kind === 'conflict' && r.conflict.rows).toEqual([row({ allowanceYen: 9500 })])
    expect(r.kind === 'conflict' && r.conflict.message).toContain('他の人が先に保存しています')
  })

  it('★ 409 の結果に**入力欄を差し替える材料が入っていない** (上書きしようがない)', () => {
    const r = resolveAllowanceRateSave('edit', [row()], {
      ok: false, status: 409, body: conflictBody([row({ allowanceYen: 9500 })]), reason: '409 conflict',
    })
    // `rows` / `draft` を持つ形で返していたら、呼び出し側は手元へ代入できてしまう。
    expect(Object.keys(r).sort()).toEqual(['conflict', 'diff', 'kind'])
    expect(r).not.toHaveProperty('rows')
    expect(r).not.toHaveProperty('draft')
  })

  it('409 は手元とサーバの食い違いも数える', () => {
    const r = resolveAllowanceRateSave('edit', [row(), row({ dest: '川西' })], {
      ok: false, status: 409, body: conflictBody([row(), row({ dest: '浦幌' })]), reason: '409 conflict',
    })
    expect(r.kind === 'conflict' && r.diff).toEqual({ onlyMine: 1, onlyTheirs: 1, same: 1 })
  })

  it('409 でサーバの現在値が読めなければ diff は出さない (数えられないことを数えない)', () => {
    const r = resolveAllowanceRateSave('edit', [row()], {
      ok: false, status: 409, body: { error: 'conflict' }, reason: '409 conflict',
    })
    expect(r.kind === 'conflict' && r.diff).toBeNull()
  })

  const otherFailures: Array<[string, number | undefined]> = [
    ['400 (relay が本文を弾いた)', 400],
    ['401 (ログインが切れた)', 401],
    ['503 (R2 未設定)', 503],
    ['status が無い (通信そのものが失敗)', undefined],
  ]
  for (const [label, status] of otherFailures) {
    it(`${label} は failed。理由をそのまま画面へ`, () => {
      expect(resolveAllowanceRateSave('edit', [row()], { ok: false, status, body: null, reason: `${label} の理由` }))
        .toEqual({ kind: 'failed', message: `${label} の理由` })
    })
  }
})

describe('allowanceRateRowDiff / allowanceRateDiffLabel — 何行食い違っているか', () => {
  it('同じなら onlyMine / onlyTheirs は 0', () => {
    expect(allowanceRateRowDiff([row(), row({ dest: '川西' })], [row(), row({ dest: '川西' })]))
      .toEqual({ onlyMine: 0, onlyTheirs: 0, same: 2 })
  })

  it('手元だけの行・サーバだけの行を別々に数える', () => {
    expect(allowanceRateRowDiff([row(), row({ dest: '川西' })], [row(), row({ dest: '浦幌' })]))
      .toEqual({ onlyMine: 1, onlyTheirs: 1, same: 1 })
  })

  it('1 円だけ違う行は「別の行」として数える', () => {
    expect(allowanceRateRowDiff([row({ allowanceYen: 9001 })], [row()]))
      .toEqual({ onlyMine: 1, onlyTheirs: 1, same: 0 })
  })

  it('同じ行が 2 つある版と 1 つの版を混ぜない (件数で数える)', () => {
    expect(allowanceRateRowDiff([row(), row()], [row()]))
      .toEqual({ onlyMine: 1, onlyTheirs: 0, same: 1 })
    expect(allowanceRateRowDiff([row()], [row(), row()]))
      .toEqual({ onlyMine: 0, onlyTheirs: 1, same: 1 })
  })

  it('farePerT の null と 0 を同じ行と数えない', () => {
    expect(allowanceRateRowDiff([row({ farePerT: null })], [row({ farePerT: 0 })]))
      .toEqual({ onlyMine: 1, onlyTheirs: 1, same: 0 })
  })

  it('1 文にすると「どちらにあるか」が読める', () => {
    expect(allowanceRateDiffLabel({ onlyMine: 2, onlyTheirs: 3, same: 60 }))
      .toBe('あなたの手元だけにある行 2 件 / サーバだけにある行 3 件 (一致 60 件)。')
  })
})

// --- 5. 編集 UI を足しても金額は 1 円も動かない -------------------------------

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

describe('入力欄を往復しても金額は 1 円も動かない (手当表PDF 2026-07 / 313 便)', () => {
  /** **編集 UI を開いて何も触らずに保存した**ときに送られる 62 行。 */
  const roundTrip = (() => {
    const parsed = parseAllowanceRateDraft(toAllowanceRateDraft(RATE_MASTER))
    if (!parsed.ok) throw new Error(parsed.errors.join(' / '))
    return parsed.rows
  })()

  it('62 行が順序込みでそのまま戻る', () => {
    expect(roundTrip).toEqual(RATE_MASTER)
  })

  it('golden 24 経路の答えが 1 つも変わらない', () => {
    expect(goldenAnswers(roundTrip)).toEqual(goldenAnswers(RATE_MASTER))
  })

  it('golden の手当合計が 1 円も動かない (¥2,618,000)', () => {
    expect(goldenTotal(roundTrip)).toBe(goldenTotal(RATE_MASTER))
    // 値そのものを固定する — 「両方 0 円」でも上の等号は通ってしまうため。
    expect(goldenTotal(roundTrip)).toBe(2618000)
  })

  it('★ 陽性対照: 入力欄で 1 円だけ変えると上の 2 本が落ちる', () => {
    const draft = toAllowanceRateDraft(RATE_MASTER).map(d => (
      d.origin === '釧路' && d.dest === '上士幌' ? { ...d, allowanceYen: String(Number(d.allowanceYen) + 1) } : d
    ))
    const parsed = parseAllowanceRateDraft(draft)
    const tampered = parsed.ok ? parsed.rows : []
    expect(goldenAnswers(tampered)).not.toEqual(goldenAnswers(RATE_MASTER))
    // 釧路〜上士幌 は 46 便。1 円上げれば合計はちょうど 46 円増える。
    expect(goldenTotal(tampered)).toBe(goldenTotal(RATE_MASTER) + 46)
  })

  it('★ 陽性対照: 行を消すと ok → unknown に変わる (手当が減る経路が実在する)', () => {
    const draft = toAllowanceRateDraft(RATE_MASTER).filter(d => !(d.origin === '釧路' && d.dest === '上士幌'))
    const parsed = parseAllowanceRateDraft(draft)
    const thinned = parsed.ok ? parsed.rows : []
    expect(lookupAllowance('釧路', '上士幌', RATE_MASTER).status).toBe('ok')
    expect(lookupAllowance('釧路', '上士幌', thinned).status).toBe('unknown')
    expect(() => goldenTotal(thinned)).toThrow('釧路〜上士幌 が unknown')
  })
})
