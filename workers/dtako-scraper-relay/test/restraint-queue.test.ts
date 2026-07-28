import { describe, expect, it } from 'vitest'
import { needsTheearthQueue } from '../src/restraint-queue'

describe('needsTheearthQueue', () => {
  it('theearth の cookie を read→write するルート (+ kintai/fetch) は直列化する', () => {
    for (const p of [
      '/restraint-api/login',
      '/restraint-api/logout',
      '/restraint-api/report',
      '/restraint-api/csv',
      '/restraint-api/kintai/fetch',
    ]) {
      expect(needsTheearthQueue(p), p).toBe(true)
    }
  })

  it('theearth に触らないルートは並行してよい (Refs #507 の主目的)', () => {
    for (const p of [
      // 上流 ichiban (rust-ichibanboshi)
      '/restraint-api/wage-report',
      '/restraint-api/kintai/kosoku-daily',
      '/restraint-api/kintai/pdf-json',
      '/restraint-api/timecard-compare',
      // R2 のみ
      '/restraint-api/wage-master',
      '/restraint-api/wage-master/csv',
      '/restraint-api/min-wage',
      '/restraint-api/min-wage/import-mhlw',
      '/restraint-api/min-wage/branches',
      '/restraint-api/min-wage/apply-to-wage-master',
      '/restraint-api/wage-config',
      '/restraint-api/salary-item-config',
      '/restraint-api/kintai/archive',
      '/restraint-api/archive/summaries',
      '/restraint-api/archive/csv-list',
      '/restraint-api/archive/csv',
      '/restraint-api/archive/history',
      '/restraint-api/archive/resummarize',
      '/restraint-api/archive/months',
      // D1 のみ
      '/restraint-api/employee-master',
      '/restraint-api/comp-map',
      '/restraint-api/work-schedule',
      '/restraint-api/holiday-work',
      '/restraint-api/night-shift',
    ]) {
      expect(needsTheearthQueue(p), p).toBe(false)
    }
  })

  it('未知のパスはキューに入れない (dispatch 側で 404 に落ちるだけ)', () => {
    expect(needsTheearthQueue('/restraint-api/unknown')).toBe(false)
    expect(needsTheearthQueue('')).toBe(false)
  })
})
