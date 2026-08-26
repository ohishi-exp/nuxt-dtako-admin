import { describe, it, expect } from 'vitest'

import {
  classifyKyuyoAccess,
  kyuyoAccessFromError,
  kyuyoAccessNotice,
  kyuyoErrorStatus,
  KYUYO_CONSEQUENCE_FETCH,
  KYUYO_CONSEQUENCE_RANGE,
  KYUYO_CONSEQUENCE_WAGE,
} from '~/utils/kyuyo-access'

describe('kyuyoErrorStatus', () => {
  it('ofetch の FetchError は status を持つ', () => {
    expect(kyuyoErrorStatus({ status: 403 })).toBe(403)
  })

  /** `createError` 由来は `statusCode` しか持たないことがある。 */
  it('status が無ければ statusCode を見る', () => {
    expect(kyuyoErrorStatus({ statusCode: 503 })).toBe(503)
  })

  it('両方あるときは status を優先する', () => {
    expect(kyuyoErrorStatus({ status: 403, statusCode: 500 })).toBe(403)
  })

  it('数値でなければ null (文字列の status を数字として扱わない)', () => {
    expect(kyuyoErrorStatus({ status: '403', statusCode: '503' })).toBeNull()
  })

  it('status を持たないオブジェクトは null', () => {
    expect(kyuyoErrorStatus({ message: 'boom' })).toBeNull()
  })

  it('null / undefined でも落ちない', () => {
    expect(kyuyoErrorStatus(null)).toBeNull()
    expect(kyuyoErrorStatus(undefined)).toBeNull()
  })
})

describe('classifyKyuyoAccess', () => {
  /** upstream `authorize()` の allowlist 外 = 403。**その人の権限の話。** */
  it('403 は denied', () => {
    expect(classifyKyuyoAccess(403)).toBe('denied')
  })

  /** introspect 未設定 / allowlist 空 / 認可サーバ不達 = 503。**権限とは無関係。** */
  it('503 は unconfigured', () => {
    expect(classifyKyuyoAccess(503)).toBe('unconfigured')
  })

  /** 401 はログインの話 — 権限とも設定とも言えないので unknown に倒す。 */
  it('401 は unknown (権限の話にしない)', () => {
    expect(classifyKyuyoAccess(401)).toBe('unknown')
  })

  it('知らない status も unknown', () => {
    expect(classifyKyuyoAccess(500)).toBe('unknown')
    expect(classifyKyuyoAccess(200)).toBe('unknown')
  })

  it('まだ聞いていない (null) も unknown', () => {
    expect(classifyKyuyoAccess(null)).toBe('unknown')
  })
})

describe('kyuyoAccessFromError', () => {
  it('403 のエラーから denied を出す', () => {
    expect(kyuyoAccessFromError({ status: 403 })).toBe('denied')
  })

  it('503 のエラーから unconfigured を出す', () => {
    expect(kyuyoAccessFromError({ statusCode: 503 })).toBe('unconfigured')
  })

  it('status を取れないエラーは unknown', () => {
    expect(kyuyoAccessFromError(new Error('network'))).toBe('unknown')
  })
})

describe('kyuyoAccessNotice', () => {
  const W = KYUYO_CONSEQUENCE_WAGE

  /** ★ 403 と 503 で文を分ける — 利用者が次に取る行動が違う。 */
  it('denied は「権限がありません」と言い、管理者への依頼を促す', () => {
    const s = kyuyoAccessNotice('denied', W)!
    expect(s).toContain('閲覧権限がありません')
    expect(s).toContain('管理者')
    // **設定・障害の話に読ませない**
    expect(s).not.toContain('認可設定')
  })

  /** ★ 503 で「権限がありません」と読ませない (逆方向の誤読)。 */
  it('unconfigured は設定・障害の話だと明示し、権限の話ではないと言う', () => {
    const s = kyuyoAccessNotice('unconfigured', W)!
    expect(s).toContain('認可設定が未完了')
    expect(s).toContain('権限の問題ではありません')
    expect(s).not.toContain('閲覧権限がありません')
  })

  /** どちらの文も「何が起きるか」を必ず言う (黙って空欄にしない)。 */
  it('どちらの文も渡した consequence をそのまま含む', () => {
    expect(kyuyoAccessNotice('denied', W)).toContain(W)
    expect(kyuyoAccessNotice('unconfigured', W)).toContain(W)
  })

  /**
   * ★ 結果は画面ごとに違う。**金額を 1 つも出さない `/kyuyo-fetch` に
   * 「金額列は空欄になります」と書かない**ことを固定する
   * (2026-08-26 のスタブ実測で実際に踏んだ)。
   */
  it('画面ごとの consequence が入れ替わらない', () => {
    expect(KYUYO_CONSEQUENCE_WAGE).toContain('金額列')
    expect(KYUYO_CONSEQUENCE_FETCH).not.toContain('金額')
    const fetchNotice = kyuyoAccessNotice('denied', KYUYO_CONSEQUENCE_FETCH)!
    expect(fetchNotice).not.toContain('金額')
    expect(fetchNotice).toContain('アーカイブ一覧')
  })

  /**
   * ★ #949 の一段深い形 — **同じ画面のタブごと**でも結果が違う (Refs #951)。
   *
   * 注記の `<p>` は全タブ共通領域にあるので、句を `KYUYO_CONSEQUENCE_WAGE` に
   * 固定すると**期間集計タブでも「金額列は空欄のままになります」と出る**。
   * 期間集計は `wage-range` 1 本を口ごと 403 にされるので、起きるのは
   * 「表そのものが出ない」で別のこと。**「空欄」と書かない**ことを固定する。
   */
  it('期間集計タブの consequence は「空欄」ではなく「表示されない」と言う', () => {
    expect(KYUYO_CONSEQUENCE_RANGE).not.toContain('空欄')
    expect(KYUYO_CONSEQUENCE_RANGE).not.toContain('金額列')
    expect(KYUYO_CONSEQUENCE_RANGE).toContain('期間集計')
    expect(KYUYO_CONSEQUENCE_RANGE).toContain('表示されません')
    // 3 つの句が互いに入れ替わっていないこと (定数名だけ足して中身を使い回す事故防止)
    expect(new Set([KYUYO_CONSEQUENCE_WAGE, KYUYO_CONSEQUENCE_RANGE, KYUYO_CONSEQUENCE_FETCH]).size).toBe(3)

    const rangeNotice = kyuyoAccessNotice('denied', KYUYO_CONSEQUENCE_RANGE)!
    expect(rangeNotice).not.toContain('空欄')
    expect(rangeNotice).toContain('期間集計')
    // 503 (設定・障害) 側でも日本語として繋がる — 「復旧するまで…表示されません。」
    expect(kyuyoAccessNotice('unconfigured', KYUYO_CONSEQUENCE_RANGE))
      .toContain(`復旧するまで${KYUYO_CONSEQUENCE_RANGE}。`)
  })

  it('句点は関数側で付ける (consequence には付けない)', () => {
    expect(KYUYO_CONSEQUENCE_WAGE.endsWith('。')).toBe(false)
    expect(KYUYO_CONSEQUENCE_FETCH.endsWith('。')).toBe(false)
    expect(KYUYO_CONSEQUENCE_RANGE.endsWith('。')).toBe(false)
    expect(kyuyoAccessNotice('denied', W)).toContain(`${W}。`)
  })

  it('allowed は無言', () => {
    expect(kyuyoAccessNotice('allowed', W)).toBeNull()
  })

  /** ★ unknown を「権限あり」と言い換えない — 無言にする。 */
  it('unknown は無言 (権限ありとも権限なしとも言わない)', () => {
    expect(kyuyoAccessNotice('unknown', W)).toBeNull()
  })
})
