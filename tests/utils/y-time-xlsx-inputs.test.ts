/**
 * `y-time-xlsx.ts` の `yTimeRowInputCells` — 入力列 (F〜O) の「どのセルに何を書くか」と、
 * その結果シートに実際に入る値 (出力の xml を読み直して確かめる)。
 *
 * テンプレの実物は fixture にしない (理由は `y-time-xlsx-period.test.ts` の冒頭)。
 * 同じ形のセルだけを持つ最小の xlsx をテスト内で組む。値はどれも架空。
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { writeYTimeRows, yTimeRowInputCells } from '../../app/utils/y-time-xlsx'
import type { YTimeRow } from '../../app/types'

const FIRST = '2030-01-06'
const DAYS = 14

function serialOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number]
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000
}

const INPUT_COLS = ['F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O']

/** 行 7 から DAYS 日ぶん。入力列は全部「前回の出力が残っている」体で値を入れておく */
function yTimeSheetXml(): string {
  const rows: string[] = []
  for (let i = 0; i < DAYS; i++) {
    const n = 7 + i
    const stale = INPUT_COLS.map((c) => `<c r="${c}${n}" s="104"><v>0.9</v></c>`).join('')
    rows.push(`<row r="${n}"><c r="A${n}" s="99"><v>${serialOf(FIRST) + i}</v></c><c r="C${n}" s="3"/>${stale}`
      + `<c r="P${n}" s="5"><f>SUM(AK${n}:AQ${n})</f><v>0</v></c></row>`)
  }
  return `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`
}

async function buildWorkbook(sheets: { name: string, xml: string }[]): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file('xl/workbook.xml', '<workbook><sheets>'
    + sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets><calcPr calcId="191029"/></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships>'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + '</Relationships>')
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, s.xml))
  const out = await zip.generateAsync({ type: 'uint8array' })
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}

function row(date: string, over: Partial<YTimeRow> = {}): YTimeRow {
  return {
    date,
    previous_day_start: false,
    start_minutes_of_day: 480,
    end_minutes_from_bucket_date: 1020,
    rest_prev_5_22: 0,
    rest_prev_22_0: 0,
    rest_today_0_5: 0,
    rest_today_5_22: 0,
    rest_today_22_0: 0,
    rest_next_0_5: 0,
    rest_next_5_22: 0,
    note: null,
    ...over,
  }
}

/** 出力の Y時間 シートから、入力列に実際に入っている値を日付ごとに読み直す (F は 1、G〜O は分) */
async function sheetInputs(bytes: Uint8Array): Promise<Record<string, Record<string, number>>> {
  const zip = await JSZip.loadAsync(bytes)
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
  const out: Record<string, Record<string, number>> = {}
  for (let i = 0; i < DAYS; i++) {
    const n = 7 + i
    const cells: Record<string, number> = {}
    for (const col of INPUT_COLS) {
      const v = new RegExp(`<c r="${col}${n}"[^>/]*><v>([^<]*)</v></c>`).exec(xml)?.[1]
      if (v !== undefined) cells[col] = col === 'F' ? Number(v) : Math.round(Number(v) * 1440)
    }
    if (Object.keys(cells).length > 0) {
      out[new Date(Date.UTC(1899, 11, 30) + (serialOf(FIRST) + i) * 86400000).toISOString().slice(0, 10)] = cells
    }
  }
  return out
}

const PERIOD = { from: '2030-01-06', to: '2030-01-19' }

describe('yTimeRowInputCells — 1 行が入力列のどのセルに何を書くか', () => {
  it('★ F は前日始業のときだけ・G/H は必ず・I〜O は 0 なら書かない (書く順も固定)', () => {
    expect(yTimeRowInputCells(row('2030-01-07'))).toEqual([['G', 480], ['H', 1020]])
    expect(yTimeRowInputCells(row('2030-01-07', {
      previous_day_start: true,
      start_minutes_of_day: 1320,
      end_minutes_from_bucket_date: 1500,
      rest_prev_5_22: 1, rest_prev_22_0: 2, rest_today_0_5: 3, rest_today_5_22: 4,
      rest_today_22_0: 5, rest_next_0_5: 6, rest_next_5_22: 7,
    }))).toEqual([
      ['F', 1], ['G', 1320], ['H', 1500], ['I', 1], ['J', 2], ['K', 3], ['L', 4], ['M', 5], ['N', 6], ['O', 7],
    ])
    expect(yTimeRowInputCells(row('2030-01-07', { rest_today_5_22: 60, start_minutes_of_day: 0 })))
      .toEqual([['G', 0], ['H', 1020], ['L', 60]])
    // 終業は bucket の日の 0:00 からの分をそのまま書く。勤務の記録から作る行の最大 46:00 (2760) でも書き方は同じ
    expect(yTimeRowInputCells(row('2030-01-07', { start_minutes_of_day: 1320, end_minutes_from_bucket_date: 2760 })))
      .toEqual([['G', 1320], ['H', 2760]])
  })
})

describe('writeYTimeRows — 入力列に実際に書かれる値', () => {
  const rows = [
    row('2030-01-07', { rest_today_5_22: 60 }),
    row('2030-01-08', { previous_day_start: true, start_minutes_of_day: 1320, end_minutes_from_bucket_date: 360, rest_prev_22_0: 15, rest_today_0_5: 30 }),
    // 同じ日付が 2 行: 2 行目の F は書かれない (1 行目の 1 が残る)、G/H は 2 行目、休憩はセルごとに後勝ち
    row('2030-01-10', { previous_day_start: true, start_minutes_of_day: 1380, end_minutes_from_bucket_date: 300, rest_today_0_5: 20, rest_today_5_22: 45 }),
    row('2030-01-10', { start_minutes_of_day: 600, end_minutes_from_bucket_date: 1500, rest_today_5_22: 50, rest_next_0_5: 10 }),
    // テンプレに行が無い日 (期間の外)
    row('2030-02-01', { rest_today_5_22: 60 }),
  ]

  it('★ 期間内を消してから書くと、入力列には書いた行の値だけが入る (同じ日付の 2 行はセルごとに後勝ち)', async () => {
    const tpl = await buildWorkbook([{ name: 'Y時間', xml: yTimeSheetXml() }])
    const res = await writeYTimeRows(tpl, rows, { clearPeriod: PERIOD })
    expect(await sheetInputs(res.bytes)).toEqual({
      '2030-01-07': { G: 480, H: 1020, L: 60 },
      '2030-01-08': { F: 1, G: 1320, H: 360, J: 15, K: 30 },
      '2030-01-10': { F: 1, G: 600, H: 1500, K: 20, L: 50, N: 10 },
    })
    expect(res.missingDates).toEqual(['2030-02-01'])
  })

  it('陽性対照: 入力を 1 分変えると、シートの中身も同じだけ変わる', async () => {
    const tpl = await buildWorkbook([{ name: 'Y時間', xml: yTimeSheetXml() }])
    const changed = [row('2030-01-07', { rest_today_5_22: 61 }), ...rows.slice(1)]
    const res = await writeYTimeRows(tpl, changed, { clearPeriod: PERIOD })
    expect((await sheetInputs(res.bytes))['2030-01-07']).toEqual({ G: 480, H: 1020, L: 61 })
  })

  it('陽性対照: 期間内を消さない呼び方では、書かなかったセルにテンプレの値が残る', async () => {
    const tpl = await buildWorkbook([{ name: 'Y時間', xml: yTimeSheetXml() }])
    const res = await writeYTimeRows(tpl, rows)
    expect((await sheetInputs(res.bytes))['2030-01-07']!.F).toBe(0.9)
  })

  it('★ 書くセルの中身は今までと同じ形 (F は 1、時刻は 分 / 1440、style は保持)', async () => {
    const tpl = await buildWorkbook([{ name: 'Y時間', xml: yTimeSheetXml() }])
    const res = await writeYTimeRows(tpl, rows, { clearPeriod: PERIOD })
    const xml = await (await JSZip.loadAsync(res.bytes)).file('xl/worksheets/sheet1.xml')!.async('string')
    expect(xml).toContain(
      '<row r="9"><c r="A9" s="99"><v>' + (serialOf(FIRST) + 2) + '</v></c><c r="C9" s="3"/>'
      + '<c r="F9" s="104"><v>1</v></c>'
      + `<c r="G9" s="104"><v>${1320 / 1440}</v></c><c r="H9" s="104"><v>${360 / 1440}</v></c>`
      + '<c r="I9" s="104"/>'
      + `<c r="J9" s="104"><v>${15 / 1440}</v></c><c r="K9" s="104"><v>${30 / 1440}</v></c>`
      + '<c r="L9" s="104"/><c r="M9" s="104"/><c r="N9" s="104"/><c r="O9" s="104"/>'
      + '<c r="P9" s="5"><f>SUM(AK9:AQ9)</f><v>0</v></c></row>',
    )
  })
})
