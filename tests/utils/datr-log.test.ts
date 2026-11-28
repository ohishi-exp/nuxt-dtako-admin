import { describe, it, expect } from 'vitest'
import { parseDatrLine, parseDatrFiles, parseCodeList, searchDatr } from '~/utils/datr-log'

const L1 = '1029,0,43019,8.215278E-02,"17101101581600001029.jpg","",0,0,0,0'
const L2 = '1026,0,43019,.1015856,"17101102261400001026.jpg","",0,0,0,0'
const L3 = '1042,0,43020,3.137732E-02,"17101200450900001042.jpg","",0,0,0,0'

describe('parseDatrLine', () => {
  it('Excel シリアルと日割り時刻を日付・時刻に直す', () => {
    expect(parseDatrLine(L1)).toEqual({
      code: '1029', date: '2017-10-11', time: '01:58:18', image: '17101101581600001029.jpg',
    })
    expect(parseDatrLine('310,0,43019,.3068634,"a.jpg","",0,0,0,0')?.time).toBe('07:21:53')
  })

  it('23:59:59.6 のような繰り上がりは 23:59:59 で止める', () => {
    expect(parseDatrLine('1,0,43019,.999999,"a.jpg"')?.time).toBe('23:59:59')
  })

  it.each([
    ['列不足', '1029,0,43019,.1'],
    ['コード空', ',0,43019,.1,"a.jpg"'],
    ['日付が数値でない', '1029,0,x,.1,"a.jpg"'],
    ['日付が小数', '1029,0,43019.5,.1,"a.jpg"'],
    ['日付が 0', '1029,0,0,.1,"a.jpg"'],
    ['時刻が数値でない', '1029,0,43019,x,"a.jpg"'],
    ['時刻が負', '1029,0,43019,-0.1,"a.jpg"'],
    ['時刻が 1 以上', '1029,0,43019,1,"a.jpg"'],
  ])('%s は null', (_, line) => {
    expect(parseDatrLine(line)).toBeNull()
  })
})

describe('parseDatrFiles', () => {
  it('同じ行は 1 件に畳んで入っていたファイルを残し、日時順に並べる', () => {
    const r = parseDatrFiles([
      { name: '20171012.datr', text: `${L3}\r\n` },
      { name: '20171011.datr', text: `${L2}\n${L1}\n` },
      { name: '20171011.bakr', text: `${L1}\n\nゴミ\n` },
    ])
    expect(r.records.map(x => [x.code, x.sources])).toEqual([
      ['1029', ['20171011.datr', '20171011.bakr']],
      ['1026', ['20171011.datr']],
      ['1042', ['20171012.datr']],
    ])
    expect(r.skipped).toEqual([{ source: '20171011.bakr', line: 3, text: 'ゴミ' }])
  })
})

describe('parseCodeList', () => {
  it('改行・カンマ・空白・読点で区切り、重複を除く', () => {
    expect(parseCodeList(' 1029\n1026, 1029、310\t\n')).toEqual(['1029', '1026', '310'])
    expect(parseCodeList('  ')).toEqual([])
  })
})

describe('searchDatr', () => {
  const { records } = parseDatrFiles([{ name: 'a', text: [L1, L2, L3].join('\n') }])

  it('コード指定なし・期間なしは全件', () => {
    const r = searchDatr(records, { codes: [], from: '', to: '' })
    expect(r.hits).toHaveLength(3)
    expect(r.perCode).toEqual([])
  })

  it('指定コードだけ返し、0 件のコードも件数表に残す', () => {
    const r = searchDatr(records, { codes: ['1042', '9999', '1029'], from: '', to: '' })
    expect(r.hits.map(x => x.code)).toEqual(['1029', '1042'])
    expect(r.perCode).toEqual([
      { code: '1042', count: 1 }, { code: '9999', count: 0 }, { code: '1029', count: 1 },
    ])
  })

  it('期間は両端を含む', () => {
    expect(searchDatr(records, { codes: [], from: '2017-10-12', to: '' }).hits.map(x => x.code)).toEqual(['1042'])
    expect(searchDatr(records, { codes: [], from: '', to: '2017-10-11' }).hits).toHaveLength(2)
  })
})
