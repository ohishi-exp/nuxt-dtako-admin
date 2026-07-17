import { describe, expect, it } from 'vitest'
import { isR2OnlyRestraintPath, viewerCompIdsForTenant } from '../src/restraint-viewer-auth'
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
      '/restraint-api/salary-cd-map',
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
