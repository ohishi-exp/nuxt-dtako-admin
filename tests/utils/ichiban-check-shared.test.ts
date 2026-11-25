/**
 * 「すべて出す」の運行 id を、relay の cron (`workers/dtako-scraper-relay/src/ichiban-makecsv.ts`) と
 * **同じ fixture で**固定する (片側だけ規則が動いたら、どちらかのテストが落ちる)。
 */
import { describe, expect, it } from 'vitest'
import { flattenIchibanCheck, idsOfRows, type IchibanCheckResponse } from '~/utils/ichiban-check'
import fixture from '../fixtures/ichiban-check/makecsv-ids.json'

describe('一番星突合 → すべて出す の id (relay と共有の fixture)', () => {
  it('画面の行数と id の並び', () => {
    const rows = flattenIchibanCheck(fixture.response as IchibanCheckResponse)
    expect(rows).toHaveLength(fixture.rows)
    expect(idsOfRows(rows)).toEqual(fixture.ids)
  })
})
