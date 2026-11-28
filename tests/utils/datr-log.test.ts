import { describe, it, expect } from 'vitest'
import { buildEmployeeInfoMap, countByCode, DEFAULT_EXCLUDED_CODES, parseDatrLine, parseDatrFiles, parseCodeList, searchDatr, hasAlcohol, isDatrLogFile, DatrIndex } from '~/utils/datr-log'

const L1 = '1029,0,43019,8.215278E-02,"17101101581600001029.jpg","",0,0,0,0'
const L2 = '1026,0,43019,.1015856,"17101102261400001026.jpg","",0,0,0,0'
const L3 = '1042,0,43020,3.137732E-02,"17101200450900001042.jpg","",0,0,0,0'

describe('parseDatrLine', () => {
  it('Excel シリアルと日割り時刻を日付・時刻に直す', () => {
    expect(parseDatrLine(L1)).toEqual({
      code: '1029', date: '2017-10-11', time: '01:58:18', image: '17101101581600001029.jpg',
      alcohol: '0', extra: ['', '0', '0', '0', '0'],
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

describe('DatrIndex', () => {
  it('ファイルを足すたびに records() が増える (途中経過を出せる)', () => {
    const index = new DatrIndex()
    index.add({ name: 'b', text: L3 })
    expect(index.records().map(r => r.code)).toEqual(['1042'])
    index.add({ name: 'a', text: `${L1}\n${L3}` })
    expect(index.records().map(r => [r.code, r.sources])).toEqual([['1029', ['a']], ['1042', ['b', 'a']]])
  })
})

describe('hasAlcohol', () => {
  it('0 は無し、.062 のような値は有り。空や数値でないものは見落とさないよう有り', () => {
    expect(hasAlcohol({ alcohol: '0' })).toBe(false)
    expect(hasAlcohol({ alcohol: '0.000' })).toBe(false)
    expect(hasAlcohol({ alcohol: '.062' })).toBe(true)
    expect(hasAlcohol({ alcohol: '' })).toBe(true)
    expect(hasAlcohol({ alcohol: 'abc' })).toBe(true)
  })
})

describe('isDatrLogFile', () => {
  it('2017 年の .datr/.bakr と 2026 年の .dat/.bak を対象にする', () => {
    expect(['a.datr', 'a.bakr', 'a.dat', 'A.BAK'].map(isDatrLogFile)).toEqual([true, true, true, true])
    expect(['a.jpg', 'a.txt', 'a.data', 'a.datrx'].map(isDatrLogFile)).toEqual([false, false, false, false])
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

  it('alcoholOnly はアルコール値が 0 でない行だけ', () => {
    const r = parseDatrFiles([{ name: 'a.dat', text: [L1, '1729,.062,46354,.2807871,"x.jpg","",0,0,0,0'].join('\n') }])
    const hits = searchDatr(r.records, { codes: [], from: '', to: '', alcoholOnly: true }).hits
    expect(hits.map(x => [x.code, x.date, x.time, x.alcohol])).toEqual([['1729', '2026-11-28', '06:44:20', '.062']])
  })

  it('excludeCodes のコードは外す (コード指定に入っていても外す)', () => {
    const r = parseDatrFiles([{ name: 'a', text: [L1, '99999999,0,43022,.5420718,"x.jpg","",0,0,0,0'].join('\n') }])
    expect(searchDatr(r.records, { codes: [], from: '', to: '' }).hits).toHaveLength(2)
    expect(searchDatr(r.records, { codes: [], from: '', to: '', excludeCodes: DEFAULT_EXCLUDED_CODES }).hits.map(x => x.code)).toEqual(['1029'])
    expect(searchDatr(r.records, { codes: ['99999999'], from: '', to: '', excludeCodes: DEFAULT_EXCLUDED_CODES }).hits).toEqual([])
  })

  it('期間は両端を含む', () => {
    expect(searchDatr(records, { codes: [], from: '2017-10-12', to: '' }).hits.map(x => x.code)).toEqual(['1042'])
    expect(searchDatr(records, { codes: [], from: '', to: '2017-10-11' }).hits).toHaveLength(2)
  })
})

describe('countByCode', () => {
  it('読み込んだ全件をコードごとに数える', () => {
    const { records } = parseDatrFiles([{ name: 'a', text: [L1, L2, L3, L1.replace('43019', '43021')].join('\n') }])
    expect([...countByCode(records)].sort()).toEqual([['1026', 1], ['1029', 2], ['1042', 1]])
  })
})

describe('buildEmployeeInfoMap', () => {
  it('社員C → 氏名・入社日・退職日。× 付き (退職) もそのまま、コードが空の行は捨てる', () => {
    const map = buildEmployeeInfoMap([
      { employee_code: ' 1029 ', employee_name: ' 甲 太郎 ', dept_code: '010', hire_date: '2010-04-01', retire_date: null },
      { employee_code: '1005', employee_name: '×丙', dept_code: '010', hire_date: '2001-05-01', retire_date: '2018-03-31' },
      { employee_code: '', employee_name: '丁', dept_code: '010', hire_date: null, retire_date: null },
    ])
    expect([...map]).toEqual([
      ['1029', { name: '甲 太郎', hireDate: '2010-04-01', retireDate: null }],
      ['1005', { name: '×丙', hireDate: '2001-05-01', retireDate: '2018-03-31' }],
    ])
  })
})
