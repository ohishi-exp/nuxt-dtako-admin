import { describe, expect, it } from 'vitest'
import {
  ALL_COMPS_VIEWER_EMAILS_VAR,
  allCompsViewerEmails,
  allowedViewerComps,
  compIdsInSameTenant,
  devViewerCompIds,
  isAllCompsViewer,
  isR2OnlyRestraintPath,
  normalizeViewerEmail,
  VIEWER_ADMIN_ROLE,
  viewerCompIdsForTenant,
} from '../src/restraint-viewer-auth'
import type { DtakoAccountEntry } from '../src/cron'

describe('isR2OnlyRestraintPath', () => {
  it('theearth を実際に触るルートは対象外 (theearth セッション必須のまま)', () => {
    for (const p of [
      '/restraint-api/login',
      '/restraint-api/logout',
      '/restraint-api/report',
      '/restraint-api/csv',
    ]) {
      expect(isR2OnlyRestraintPath(p), p).toBe(false)
    }
  })

  it('R2 だけを読み書きするルートは viewer 経路の対象', () => {
    for (const p of [
      '/restraint-api/wage-report',
      '/restraint-api/wage-master',
      '/restraint-api/wage-master/csv',
      '/restraint-api/min-wage',
      '/restraint-api/wage-config',
      '/restraint-api/salary-item-config',
      '/restraint-api/archive/months',
      '/restraint-api/archive/summaries',
      '/restraint-api/archive/csv-list',
      '/restraint-api/archive/csv',
      '/restraint-api/archive/history',
      '/restraint-api/archive/resummarize',
    ]) {
      expect(isR2OnlyRestraintPath(p), p).toBe(true)
    }
  })

  it('/restraint-api 以外のパスは対象外', () => {
    expect(isR2OnlyRestraintPath('/dvr-api/wage-report')).toBe(false)
    expect(isR2OnlyRestraintPath('/restraint-api')).toBe(false)
  })
})

describe('viewerCompIdsForTenant', () => {
  const accounts: DtakoAccountEntry[] = [
    { comp_id: '100', user_name: 'a', user_pass: 'x', tenant_id: 't-1' },
    { comp_id: '200', user_name: 'b', user_pass: 'x', tenant_id: 't-1' },
    { comp_id: '300', user_name: 'c', user_pass: 'x', tenant_id: 't-2' },
    { comp_id: '', user_name: 'd', user_pass: 'x', tenant_id: 't-1' },
  ]

  it('tenant の comp_id 集合を逆引きする (空 comp_id は除外)', () => {
    expect([...viewerCompIdsForTenant(accounts, 't-1')].sort()).toEqual(['100', '200'])
    expect([...viewerCompIdsForTenant(accounts, 't-2')]).toEqual(['300'])
  })

  it('未知 tenant・空 tenant・空 accounts は空集合 (fail-closed)', () => {
    expect(viewerCompIdsForTenant(accounts, 't-9').size).toBe(0)
    expect(viewerCompIdsForTenant(accounts, '').size).toBe(0)
    expect(viewerCompIdsForTenant([], 't-1').size).toBe(0)
  })
})

describe('devViewerCompIds', () => {
  it('カンマ区切りを集合にする (前後空白・空要素は落とす)', () => {
    expect([...devViewerCompIds('local, other ,,')].sort()).toEqual(['local', 'other'])
  })

  it('単一指定も従来どおり効く', () => {
    expect(devViewerCompIds('local').has('local')).toBe(true)
    expect(devViewerCompIds('local').has('other')).toBe(false)
  })
})

describe('compIdsInSameTenant', () => {
  const accounts: DtakoAccountEntry[] = [
    { comp_id: '100', user_name: 'a', user_pass: 'x', tenant_id: 't-1' },
    { comp_id: '200', user_name: 'b', user_pass: 'x', tenant_id: 't-1' },
    { comp_id: '300', user_name: 'c', user_pass: 'x', tenant_id: 't-2' },
  ]

  it('同じ tenant の comp を全部返す (自分を含む)', () => {
    expect([...compIdsInSameTenant(accounts, '100')].sort()).toEqual(['100', '200'])
  })

  it('DTAKO_ACCOUNTS に無い comp は空集合 (fail-closed)', () => {
    expect(compIdsInSameTenant(accounts, '999').size).toBe(0)
  })
})

/**
 * 全社許可の allowlist (Refs #1049)。
 *
 * **★ ここは「権限を狭めた」ことを測る陰性対照**: 以前は `role === 'admin'` だけで
 * 全社が開いていた。いまは `ALL_COMPS_VIEWER_EMAILS` に載っている email だけで、
 * **role は一切見ない**。未設定・壊れた設定は fail-closed (全員が自 tenant のみ)。
 *
 * **メールアドレスは全部ダミー** (`example.com`)。この repo は public で、
 * 実際に許可するアカウントは dashboard の plain 変数にしか無い。
 */
const ALLOWED_EMAIL = 'viewer@example.com'
const OTHER_EMAIL = 'someone-else@example.com'
const ALLOWLIST = JSON.stringify([ALLOWED_EMAIL])

describe('normalizeViewerEmail', () => {
  it('前後の空白を落として小文字化する', () => {
    expect(normalizeViewerEmail('  Viewer@Example.COM ')).toBe(ALLOWED_EMAIL)
  })

  it('undefined・空文字・空白だけは空文字 (突き合わせない)', () => {
    expect(normalizeViewerEmail(undefined)).toBe('')
    expect(normalizeViewerEmail('')).toBe('')
    expect(normalizeViewerEmail('   ')).toBe('')
  })
})

describe('allCompsViewerEmails (壊れた設定で全社を開かない)', () => {
  it('JSON の文字列配列を正規化して集合にする', () => {
    expect([...allCompsViewerEmails(' ["  Viewer@Example.COM ", "b@example.com"] ')].sort()).toEqual([
      'b@example.com',
      ALLOWED_EMAIL,
    ])
  })

  it('未設定・空文字は空集合 (fail-closed)', () => {
    expect(allCompsViewerEmails(undefined).size).toBe(0)
    expect(allCompsViewerEmails('').size).toBe(0)
  })

  it('JSON としてパースできない値は空集合 (fail-closed)', () => {
    expect(allCompsViewerEmails('viewer@example.com').size).toBe(0)
    expect(allCompsViewerEmails('["a@example.com"').size).toBe(0)
  })

  it('配列でない JSON は空集合 (fail-closed)', () => {
    expect(allCompsViewerEmails('{"emails":["a@example.com"]}').size).toBe(0)
    expect(allCompsViewerEmails('"a@example.com"').size).toBe(0)
    expect(allCompsViewerEmails('null').size).toBe(0)
  })

  it('空配列は空集合 (= 全社許可を 1 件も出さない)', () => {
    expect(allCompsViewerEmails('[]').size).toBe(0)
  })

  it('文字列でない要素・空白だけの要素は落とす (他の要素は生かす)', () => {
    expect([...allCompsViewerEmails('[1, null, {"a":1}, "   ", "a@example.com"]')]).toEqual([
      'a@example.com',
    ])
  })
})

describe('isAllCompsViewer (role を見ないこと)', () => {
  it('allowlist に載っている email は true (大文字小文字・前後空白を無視)', () => {
    expect(isAllCompsViewer(ALLOWED_EMAIL, ALLOWLIST)).toBe(true)
    expect(isAllCompsViewer(' VIEWER@Example.com ', ALLOWLIST)).toBe(true)
    expect(isAllCompsViewer(ALLOWED_EMAIL, JSON.stringify([' VIEWER@Example.com ']))).toBe(true)
  })

  it('email 不在・allowlist 未設定/空/未収載 はすべて false (fail-closed)', () => {
    expect(isAllCompsViewer(undefined, ALLOWLIST)).toBe(false)
    expect(isAllCompsViewer('', ALLOWLIST)).toBe(false)
    expect(isAllCompsViewer(ALLOWED_EMAIL, undefined)).toBe(false)
    expect(isAllCompsViewer(ALLOWED_EMAIL, '[]')).toBe(false)
    expect(isAllCompsViewer(ALLOWED_EMAIL, 'not json')).toBe(false)
    expect(isAllCompsViewer(OTHER_EMAIL, ALLOWLIST)).toBe(false)
  })

  it('★ role の値は判定に一切効かない (admin でも allowlist 外なら false)', () => {
    // 引数に role を取らないので「admin だから通る」経路が構造的に無い。
    // VIEWER_ADMIN_ROLE を email として渡しても、当然ながら通らない。
    expect(isAllCompsViewer(VIEWER_ADMIN_ROLE, ALLOWLIST)).toBe(false)
  })
})

describe('allowedViewerComps (全社は allowlist だけ、Refs #1049)', () => {
  const accounts: DtakoAccountEntry[] = [
    { comp_id: '100', user_name: 'a', user_pass: 'x', tenant_id: 't-1' },
    { comp_id: '200', user_name: 'b', user_pass: 'x', tenant_id: 't-2' },
    { comp_id: '', user_name: 'c', user_pass: 'x', tenant_id: 't-2' },
  ]

  it('allowlist に載っている email は DTAKO_ACCOUNTS の全会社 (空 comp_id は除外)', () => {
    expect([...allowedViewerComps(accounts, 't-1', ALLOWED_EMAIL, ALLOWLIST)].sort()).toEqual([
      '100',
      '200',
    ])
  })

  it('大文字小文字・前後空白が違っても通る', () => {
    expect([...allowedViewerComps(accounts, 't-1', ' Viewer@Example.COM ', ALLOWLIST)].sort()).toEqual(
      ['100', '200'],
    )
  })

  it('allowlist でも DTAKO_ACCOUNTS に無い会社は許可しない (ヘッダ偽装対策)', () => {
    expect(allowedViewerComps(accounts, 't-1', ALLOWED_EMAIL, ALLOWLIST).has('999')).toBe(false)
  })

  it('★ 陰性対照: allowlist が未設定なら、他社は 1 件も通らない (全員が自 tenant のみ)', () => {
    expect([...allowedViewerComps(accounts, 't-1', ALLOWED_EMAIL, undefined)]).toEqual(['100'])
    expect(allowedViewerComps(accounts, 't-1', ALLOWED_EMAIL, undefined).has('200')).toBe(false)
  })

  it('★ 陰性対照: 壊れた設定 (不正 JSON / 配列でない / 空配列) でも全社は開かない', () => {
    for (const raw of ['not json', '{"emails":["viewer@example.com"]}', '[]', '""']) {
      expect(allowedViewerComps(accounts, 't-1', ALLOWED_EMAIL, raw).has('200'), raw).toBe(false)
    }
  })

  it('★ 陰性対照: allowlist に載っていない email は自 tenant のみ', () => {
    expect([...allowedViewerComps(accounts, 't-1', OTHER_EMAIL, ALLOWLIST)]).toEqual(['100'])
  })

  it('email が無い (theearth 由来 / dev 短絡で未設定) なら自 tenant のみ', () => {
    expect([...allowedViewerComps(accounts, 't-1', undefined, ALLOWLIST)]).toEqual(['100'])
  })
})

describe('compIdsInSameTenant (2 か所目の全社許可、Refs #1049)', () => {
  const accounts: DtakoAccountEntry[] = [
    { comp_id: '100', user_name: 'a', user_pass: 'x', tenant_id: 't-1' },
    { comp_id: '200', user_name: 'b', user_pass: 'x', tenant_id: 't-2' },
  ]

  it('allowlist に載っている email は会社対応表も全社ぶん見られる', () => {
    expect([...compIdsInSameTenant(accounts, '100', ALLOWED_EMAIL, ALLOWLIST)].sort()).toEqual([
      '100',
      '200',
    ])
    expect(
      [...compIdsInSameTenant(accounts, '100', ' VIEWER@Example.com ', ALLOWLIST)].sort(),
    ).toEqual(['100', '200'])
  })

  it('★ 陰性対照: allowlist 未設定 / 壊れた設定 / 未収載 は自 tenant のみ', () => {
    expect([...compIdsInSameTenant(accounts, '100', ALLOWED_EMAIL, undefined)]).toEqual(['100'])
    expect([...compIdsInSameTenant(accounts, '100', ALLOWED_EMAIL, '[]')]).toEqual(['100'])
    expect([...compIdsInSameTenant(accounts, '100', ALLOWED_EMAIL, 'not json')]).toEqual(['100'])
    expect([...compIdsInSameTenant(accounts, '100', OTHER_EMAIL, ALLOWLIST)]).toEqual(['100'])
  })

  it('引数を省いた従来の呼び方も自 tenant のみ (全社にはならない)', () => {
    expect([...compIdsInSameTenant(accounts, '100')]).toEqual(['100'])
  })
})

describe('ALL_COMPS_VIEWER_EMAILS_VAR', () => {
  it('wrangler.toml / dashboard と同じキー名を指す', () => {
    expect(ALL_COMPS_VIEWER_EMAILS_VAR).toBe('ALL_COMPS_VIEWER_EMAILS')
  })
})
