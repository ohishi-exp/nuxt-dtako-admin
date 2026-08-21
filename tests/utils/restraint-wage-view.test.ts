/**
 * `app/utils/restraint-wage-view.ts` の表示ヘルパテスト。
 *
 * - fmtMinutes: 分 → "XhYYm" 表記 (Refs #251)。null/undefined は "-"
 * - fmtYen / fmtArchiveTs / fmtYm の基本フォーマット
 * - groupMinWageRows: 最低賃金チェックの並び (会社 → 職員区分 → 営業所 → 乗務員CD)
 */

import { describe, it, expect } from 'vitest'
import type { MinWageRowAttrs } from '../../app/utils/restraint-wage-view'
import { fastBadgeState, fmtMinutes, fmtYen, fmtArchiveTs, fmtYm, groupMinWageRows, isTimecardSynced, MIN_WAGE_JOB_GROUP_LABEL, minWageCompareRow, monthRange, MONTH_RANGE_MAX, nextYm, prevYm, theearthSyncState } from '../../app/utils/restraint-wage-view'

describe('fmtMinutes', () => {
  it('時間+分を "XhYYm" 表記にする', () => {
    expect(fmtMinutes(345 * 60 + 50)).toBe('345h50m')
    expect(fmtMinutes(239 * 60 + 39)).toBe('239h39m')
  })

  it('分は 2 桁ゼロ埋めする', () => {
    expect(fmtMinutes(63)).toBe('1h03m')
    expect(fmtMinutes(60)).toBe('1h00m')
  })

  it('1 時間未満は 0h 始まり', () => {
    expect(fmtMinutes(36)).toBe('0h36m')
    expect(fmtMinutes(0)).toBe('0h00m')
  })

  it('null / undefined は "-"', () => {
    expect(fmtMinutes(null)).toBe('-')
    expect(fmtMinutes(undefined)).toBe('-')
  })
})

describe('fmtYen', () => {
  it('3 桁区切りにする', () => {
    expect(fmtYen(1234567)).toBe('1,234,567')
  })

  it('null / undefined は "-"', () => {
    expect(fmtYen(null)).toBe('-')
    expect(fmtYen(undefined)).toBe('-')
  })
})

describe('fmtArchiveTs', () => {
  it('R2 版タイムスタンプを "YYYY-MM-DD HH:mm" にする', () => {
    expect(fmtArchiveTs('20260716T183000')).toBe('2026-07-16 18:30')
  })

  it('形式不一致はそのまま返す', () => {
    expect(fmtArchiveTs('invalid')).toBe('invalid')
  })

  it('null / undefined / 空文字は "-"', () => {
    expect(fmtArchiveTs(null)).toBe('-')
    expect(fmtArchiveTs(undefined)).toBe('-')
    expect(fmtArchiveTs('')).toBe('-')
  })
})

describe('fmtYm', () => {
  it('"YYYY-MM" を "YYYY年M月" にする (先頭ゼロ除去)', () => {
    expect(fmtYm('2025-04')).toBe('2025年4月')
    expect(fmtYm('2025-12')).toBe('2025年12月')
  })

  it('形式不一致はそのまま返す', () => {
    expect(fmtYm('2025/04')).toBe('2025/04')
  })
})

describe('nextYm / prevYm (支給月 ⇄ 勤務月、月末締め・翌月払い Refs #282)', () => {
  it('nextYm: 通常月は +1', () => {
    expect(nextYm('2026-06')).toBe('2026-07')
    expect(nextYm('2026-01')).toBe('2026-02')
  })

  it('nextYm: 12月は翌年1月へ繰り上がる (年跨ぎ)', () => {
    expect(nextYm('2026-12')).toBe('2027-01')
  })

  it('prevYm: 通常月は -1', () => {
    expect(prevYm('2026-07')).toBe('2026-06')
    expect(prevYm('2026-12')).toBe('2026-11')
  })

  it('prevYm: 1月は前年12月へ繰り下がる (年跨ぎ)', () => {
    expect(prevYm('2027-01')).toBe('2026-12')
  })

  it('往復で元に戻る (12月/1月境界含む)', () => {
    for (const ym of ['2026-01', '2026-06', '2026-12']) {
      expect(prevYm(nextYm(ym))).toBe(ym)
    }
  })

  it('形式不一致はそのまま返す', () => {
    expect(nextYm('2026/12')).toBe('2026/12')
    expect(prevYm('bad')).toBe('bad')
  })
})

describe('monthRange', () => {
  it('両端を含めて昇順に並べる', () => {
    expect(monthRange('2026-05', '2026-08')).toEqual(['2026-05', '2026-06', '2026-07', '2026-08'])
  })

  it('同じ月なら 1 件', () => {
    expect(monthRange('2026-07', '2026-07')).toEqual(['2026-07'])
  })

  it('年を跨ぐ', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('逆順に指定されても入れ替えて扱う (画面で から/まで を逆に選べる)', () => {
    expect(monthRange('2026-08', '2026-05')).toEqual(['2026-05', '2026-06', '2026-07', '2026-08'])
  })

  it('上限で打ち切る (給与DB は 1 社 10〜20 秒 かかるため)', () => {
    expect(monthRange('2020-01', '2030-12')).toHaveLength(MONTH_RANGE_MAX)
    expect(monthRange('2026-01', '2026-12', 3)).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  it('形式不正・範囲外の月は空配列 (呼び出し側は「指定なし」として扱う)', () => {
    expect(monthRange('', '2026-07')).toEqual([])
    expect(monthRange('2026-07', '')).toEqual([])
    expect(monthRange('2026/07', '2026-08')).toEqual([])
    expect(monthRange('2026-13', '2026-14')).toEqual([])
    expect(monthRange('2026-00', '2026-01')).toEqual([])
  })
})

describe('fastBadgeState (「高速表示可」バッジの 2 段階、Refs #543 followup)', () => {
  const synced = ['2026-05', '2026-06']

  it('未同期の月はバッジ無し (キャッシュ有無に関わらず)', () => {
    expect(fastBadgeState('2026-07', synced, ['2026-07'])).toBe('none')
    expect(fastBadgeState('2026-07', synced, null)).toBe('none')
    expect(fastBadgeState('2026-07', [], [])).toBe('none')
  })

  it('同期済み + キャッシュ有りはフル表示', () => {
    expect(fastBadgeState('2026-06', synced, ['2026-06'])).toBe('full')
  })

  it('同期済みのみ (キャッシュ無し / フラグ off の空配列) は弱表示', () => {
    expect(fastBadgeState('2026-06', synced, ['2026-05'])).toBe('synced-only')
    expect(fastBadgeState('2026-06', synced, [])).toBe('synced-only')
  })

  it('旧 relay 応答 (フィールド無し = null) は従来どおりフル表示に fallback', () => {
    expect(fastBadgeState('2026-06', synced, null)).toBe('full')
  })
})

describe('isTimecardSynced (timecard 側の無人同期状態、Refs #611 / #614)', () => {
  it('同期済み月一覧に含まれていれば true', () => {
    expect(isTimecardSynced('2026-06', ['2026-05', '2026-06'])).toBe(true)
  })

  it('含まれていなければ false', () => {
    expect(isTimecardSynced('2026-07', ['2026-05', '2026-06'])).toBe(false)
  })

  it('空配列 (未設定・失敗時のフォールバック) は false', () => {
    expect(isTimecardSynced('2026-06', [])).toBe(false)
  })
})

describe('theearthSyncState (デジタコ拘束サマリの状態、Refs #712)', () => {
  const synced = ['2026-06', '2026-07']
  const archive = ['2026-05', '2026-06', '2026-07']
  const active = ['2026-05', '2026-06', '2026-07', '2026-08']

  it('ichiban 同期済みの月は synced', () => {
    expect(theearthSyncState('2026-07', synced, archive, active)).toBe('synced')
  })

  it('未同期でも R2 アーカイブがあれば archived-only — 行は落ちない (遅いだけ)', () => {
    expect(theearthSyncState('2026-05', synced, archive, active)).toBe('archived-only')
  })

  it('同期もアーカイブも無く打刻だけある月は unsynced (当月がこれになる)', () => {
    expect(theearthSyncState('2026-08', synced, archive, active)).toBe('unsynced')
  })

  it('打刻すら無い月は out-of-scope — 過去の全月を警告で埋めない', () => {
    expect(theearthSyncState('2026-09', synced, archive, active)).toBe('out-of-scope')
    expect(theearthSyncState('2020-01', [], [], [])).toBe('out-of-scope')
  })

  it('同期済みならアーカイブ・打刻が無くても synced が優先する', () => {
    expect(theearthSyncState('2026-04', ['2026-04'], [], [])).toBe('synced')
  })
})

// ---- groupMinWageRows (最低賃金チェックの並び、ユーザー決定 2026-07-30) ----

describe('groupMinWageRows', () => {
  interface Row { cd: string }
  const rows = (...cds: string[]): Row[] => cds.map(cd => ({ cd }))
  /** 乗務員CD → 所属 (会社 / 所属コード / 営業所名 / 職種名)。 */
  const attrs: Record<string, MinWageRowAttrs> = {
    // 0100: 事務 (本社) / 乗務 (本社・佐賀)
    1001: { company: '0100', branchCode: 1, branchName: '本社', jobName: '一般管理事務' },
    1002: { company: '0100', branchCode: 3, branchName: '本社', jobName: '乗務員' },
    1003: { company: '0100', branchCode: 8, branchName: '佐賀営業所', jobName: '乗務員(トレーラ)' },
    1004: { company: '0100', branchCode: 2, branchName: '本社', jobName: '作業員点呼者' },
    1005: { company: '0100', branchCode: 4, branchName: '本社', jobName: '整備' },
    1006: { company: '0100', branchCode: 9, branchName: '本社', jobName: '役員' },
    // 0200 は別会社なので必ず 0100 の後ろ
    2001: { company: '0200', branchCode: 1, branchName: '本社', jobName: '乗務員' },
  }
  const group = (list: Row[]) =>
    groupMinWageRows(list, r => r.cd, r => attrs[r.cd] ?? null)

  it('会社コード昇順 → 職員区分 (事務 → 作業 → 整備 → 乗務 → その他) で区切る', () => {
    const sections = group(rows('2001', '1006', '1003', '1005', '1004', '1001'))
    expect(sections.map(s => [s.company, s.jobGroup])).toEqual([
      ['0100', 'clerical'],
      ['0100', 'worker'],
      ['0100', 'maintenance'],
      ['0100', 'driver'],
      ['0100', 'other'],
      ['0200', 'driver'],
    ])
  })

  it('区分の中は営業所 (所属コード) 順 → 乗務員CD 順', () => {
    // 1003 は佐賀 (所属コード 8)、1002 は本社 (3) なので本社が先
    const drivers = group(rows('1003', '1002')).find(s => s.jobGroup === 'driver')
    expect(drivers?.rows.map(r => r.cd)).toEqual(['1002', '1003'])
  })

  it('1 営業所が職種ごとに別の所属コードを持っても営業所は割れない', () => {
    // 本番 2026-04 で踏んだ形: 同じ乗務員区分の中に
    // 「本社 乗務員」(3) と「本社 乗務員(トレーラ)」(21) があり、間に他営業所の
    // コード (諸富 10 / 大阪 15) が挟まる。素の所属コード順では本社が 2 つに割れる
    const trailer: Record<string, MinWageRowAttrs> = {
      h1: { company: '0200', branchCode: 3, branchName: '本社', jobName: '乗務員' },
      m1: { company: '0200', branchCode: 10, branchName: '諸富営業所', jobName: '乗務員' },
      o1: { company: '0200', branchCode: 15, branchName: '大阪営業所', jobName: '乗務員' },
      h2: { company: '0200', branchCode: 21, branchName: '本社', jobName: '乗務員(トレーラ)' },
    }
    const sections = groupMinWageRows(rows('h1', 'm1', 'o1', 'h2'), r => r.cd, r => trailer[r.cd] ?? null)
    expect(sections).toHaveLength(1)
    // 本社 (最小コード 3) → 諸富 (10) → 大阪 (15)。本社は 2 行が隣り合う
    expect(sections[0]!.rows.map(r => r.cd)).toEqual(['h1', 'h2', 'm1', 'o1'])
  })

  it('同じ営業所の中は乗務員CD の数値順 (ゼロ詰めでも桁で崩れない)', () => {
    const same: Record<string, MinWageRowAttrs> = {
      9: { company: '0100', branchCode: 1, branchName: '本社', jobName: '乗務員' },
      10: { company: '0100', branchCode: 1, branchName: '本社', jobName: '乗務員' },
    }
    const sections = groupMinWageRows(rows('10', '9'), r => r.cd, r => same[r.cd] ?? null)
    expect(sections[0]!.rows.map(r => r.cd)).toEqual(['9', '10'])
  })

  it('所属コードをまったく持たない営業所 (再取り込み前) は区分の末尾', () => {
    const mixed: Record<string, MinWageRowAttrs> = {
      a: { company: '0100', branchCode: null, branchName: '本社', jobName: '乗務員' },
      b: { company: '0100', branchCode: null, branchName: '佐賀営業所', jobName: '乗務員' },
      c: { company: '0100', branchCode: 8, branchName: '佐賀営業所', jobName: '乗務員' },
    }
    const sections = groupMinWageRows(rows('a', 'b', 'c'), r => r.cd, r => mixed[r.cd] ?? null)
    // 佐賀 (営業所の最小コード 8) がまとまって先、コードの無い本社が末尾
    expect(sections[0]!.rows.map(r => r.cd)).toEqual(['c', 'b', 'a'])
  })

  it('営業所名も所属コードも無い行 (会社不明) は比較関数を壊さず並ぶ', () => {
    const none: Record<string, MinWageRowAttrs> = {
      12: { company: null, branchCode: null, branchName: null, jobName: null },
      3: { company: null, branchCode: null, branchName: null, jobName: null },
    }
    const sections = groupMinWageRows(rows('12', '3'), r => r.cd, r => none[r.cd] ?? null)
    expect(sections[0]!.rows.map(r => r.cd)).toEqual(['3', '12'])
  })

  it('社員マスタで引けない人は末尾の「会社不明」へ (落とさない)', () => {
    const sections = group(rows('9999', '2001', '1001'))
    expect(sections.map(s => s.company)).toEqual(['0100', '0200', null])
    expect(sections.at(-1)!.rows.map(r => r.cd)).toEqual(['9999'])
    // 職種も引けないので「その他」区分
    expect(sections.at(-1)!.jobGroup).toBe('other')
  })

  it('行を 1 つも落とさない', () => {
    const list = rows('2001', '1006', '1003', '1005', '1004', '1002', '1001', '9999')
    const flat = group(list).flatMap(s => s.rows.map(r => r.cd))
    expect(flat.slice().sort()).toEqual(list.map(r => r.cd).slice().sort())
  })

  it('空配列は空の区画', () => {
    expect(group([])).toEqual([])
  })

  it('区分の見出しは 事務員 / 作業員 / 整備 / 乗務員 / その他', () => {
    expect(MIN_WAGE_JOB_GROUP_LABEL.clerical).toBe('事務員')
    expect(MIN_WAGE_JOB_GROUP_LABEL.worker).toBe('作業員')
    expect(MIN_WAGE_JOB_GROUP_LABEL.maintenance).toBe('整備')
    expect(MIN_WAGE_JOB_GROUP_LABEL.driver).toBe('乗務員')
    expect(MIN_WAGE_JOB_GROUP_LABEL.other).toContain('その他')
  })
})

// ---- minWageCompareRow (右端の突合ブロック、ユーザー決定 2026-07-30) ----

describe('minWageCompareRow', () => {
  const calc = { base: 173112, overtime: 60271, total: 262857 }

  it('比較は 給与 − 計算 (給与比較タブと同じ向き)', () => {
    const r = minWageCompareRow(calc, { base: 173112, overtime: 145883 })
    expect(r.diffBase).toBe(0)
    expect(r.diffOvertime).toBe(145883 - 60271)
    // 合計は (基本給+残業代)(給与) − 合計(計算)
    expect(r.paidTotal).toBe(173112 + 145883)
    expect(r.diffTotal).toBe(173112 + 145883 - 262857)
  })

  it('支払いが理論値を下回るとマイナス', () => {
    const r = minWageCompareRow(calc, { base: 150000, overtime: 20000 })
    expect(r.diffBase).toBe(150000 - 173112)
    expect(r.diffOvertime).toBe(20000 - 60271)
    expect(r.diffTotal).toBeLessThan(0)
  })

  it('給与明細 未取り込み (paid null) は差を出さない', () => {
    const r = minWageCompareRow(calc, null)
    expect(r.paidBase).toBeNull()
    expect(r.paidOvertime).toBeNull()
    expect(r.paidTotal).toBeNull()
    expect(r.diffBase).toBeNull()
    expect(r.diffOvertime).toBeNull()
    expect(r.diffTotal).toBeNull()
    // 計算側はそのまま出る
    expect(r.calcBase).toBe(173112)
    expect(r.calcTotal).toBe(262857)
  })

  it('単価未設定 (計算が null) の列も差は null で 0 に倒さない', () => {
    const r = minWageCompareRow({ base: null, overtime: null, total: null }, { base: 100, overtime: 200 })
    expect(r.diffBase).toBeNull()
    expect(r.diffOvertime).toBeNull()
    expect(r.diffTotal).toBeNull()
    expect(r.paidTotal).toBe(300)
  })
})
