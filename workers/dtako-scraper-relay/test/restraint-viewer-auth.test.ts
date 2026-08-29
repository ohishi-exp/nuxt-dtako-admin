import { describe, expect, it } from 'vitest'
import {
  allowedViewerComps,
  compIdsInSameTenant,
  devViewerCompIds,
  isAllCompsViewer,
  isR2OnlyRestraintPath,
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
 * 全社許可 (Refs #1049)。
 *
 * **★ ここは「権限を狭めた」ことを測る陰性対照**: 以前は `role === 'admin'` だけで
 * 全社が開いていた。いまは **auth-worker の `USER_ACL` 由来の `org_wide`** だけで、
 * **role は一切見ない**。この relay は allowlist の写しを持たない。
 *
 * **★ 受け取り側の fail-closed はこの repo の責任** — 値は上流 worker の JSON
 * 応答から来るので、型注釈は実行時の保証にならない。古い auth-worker は
 * キーごと返さない (additive な変更)。
 */

/** `org_wide` として届きうる「true ではないもの」。**全部 false に倒れること。**
 * `"false"` は `Boolean("false") === true` なので truthy 判定では通ってしまう。 */
const NOT_TRUE: unknown[] = [undefined, null, false, 'false', 'true', 0, 1, '', {}, []]

describe('isAllCompsViewer (真の boolean の true だけを通す)', () => {
  it('true (真の boolean) だけが全社許可', () => {
    expect(isAllCompsViewer(true)).toBe(true)
  })

  it('★ 陰性対照: undefined / null / "false" / "true" / 0 / 1 / {} / [] は全部 false', () => {
    for (const v of NOT_TRUE) {
      expect(isAllCompsViewer(v), JSON.stringify(v) ?? 'undefined').toBe(false)
    }
  })

  it('★ 陰性対照: 引数を渡さない (キーごと欠落 / 古い auth-worker) も false', () => {
    expect(isAllCompsViewer(undefined)).toBe(false)
  })

  it('★ Boolean() で受けていたら通ってしまう値が、実際に落ちている', () => {
    // 計測器の対照: この 2 つは truthy なので、`Boolean(x)` 実装なら true になる。
    expect(Boolean('false')).toBe(true)
    expect(Boolean(1)).toBe(true)
    expect(isAllCompsViewer('false')).toBe(false)
    expect(isAllCompsViewer(1)).toBe(false)
  })
})

describe('allowedViewerComps (全社は org_wide だけ、Refs #1049)', () => {
  const accounts: DtakoAccountEntry[] = [
    { comp_id: '100', user_name: 'a', user_pass: 'x', tenant_id: 't-1' },
    { comp_id: '200', user_name: 'b', user_pass: 'x', tenant_id: 't-2' },
    { comp_id: '', user_name: 'c', user_pass: 'x', tenant_id: 't-2' },
  ]

  it('org_wide なら DTAKO_ACCOUNTS の全会社 (空 comp_id は除外)', () => {
    expect([...allowedViewerComps(accounts, 't-1', true)].sort()).toEqual(['100', '200'])
  })

  it('org_wide でも DTAKO_ACCOUNTS に無い会社は許可しない (ヘッダ偽装対策)', () => {
    expect(allowedViewerComps(accounts, 't-1', true).has('999')).toBe(false)
  })

  it('★ 陰性対照: org_wide が true でない値のときは、他社が 1 件も通らない', () => {
    for (const v of NOT_TRUE) {
      const got = allowedViewerComps(accounts, 't-1', v)
      expect([...got], JSON.stringify(v) ?? 'undefined').toEqual(['100'])
      expect(got.has('200'), JSON.stringify(v) ?? 'undefined').toBe(false)
    }
  })

  it('org_wide でも tenant が未知なら自 tenant 側は空 (fail-closed は従来どおり)', () => {
    expect(allowedViewerComps(accounts, 't-9', undefined).size).toBe(0)
  })
})

describe('compIdsInSameTenant (2 か所目の全社許可、Refs #1049)', () => {
  const accounts: DtakoAccountEntry[] = [
    { comp_id: '100', user_name: 'a', user_pass: 'x', tenant_id: 't-1' },
    { comp_id: '200', user_name: 'b', user_pass: 'x', tenant_id: 't-2' },
  ]

  it('org_wide なら会社対応表も全社ぶん見られる', () => {
    expect([...compIdsInSameTenant(accounts, '100', true)].sort()).toEqual(['100', '200'])
  })

  it('★ 陰性対照: org_wide が true でない値のときは自 tenant のみ', () => {
    for (const v of NOT_TRUE) {
      expect([...compIdsInSameTenant(accounts, '100', v)], JSON.stringify(v) ?? 'undefined').toEqual([
        '100',
      ])
    }
  })

  it('★ 陰性対照: 引数を省いた呼び方 (#1049 以前の古い record) も自 tenant のみ', () => {
    expect([...compIdsInSameTenant(accounts, '100')]).toEqual(['100'])
  })
})
