/**
 * Y金額 の時間の集計 (Refs #1133 c1133-31) が `y-time-xlsx.ts` に足したもの:
 *
 * - `yTimeRowInputCells` / `inputDays` — 入力列 (F〜O) に「何を書くか」を、xlsx への書き込みと
 *   集計の入力で共有する。**集計の入力 = シートの中身** を、出力の xml を読み直して確かめる
 * - `readSheetCells` — `要素` シートの設定をセルの型つきで読む
 *
 * テンプレの実物は fixture にしない (理由は `y-time-xlsx-period.test.ts` の冒頭)。
 * 同じ形のセルだけを持つ最小の xlsx をテスト内で組む。値はどれも架空。
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readSheetCells, writeYTimeRows, yTimeRowInputCells } from '../../app/utils/y-time-xlsx'
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

async function buildWorkbook(sheets: { name: string, xml: string }[], sharedStrings?: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file('xl/workbook.xml', '<workbook><sheets>'
    + sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets><calcPr calcId="191029"/></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships>'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + '</Relationships>')
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, s.xml))
  if (sharedStrings !== undefined) zip.file('xl/sharedStrings.xml', sharedStrings)
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
  })
})

describe('writeYTimeRows の inputDays — 集計の入力 = シートに実際に書かれた値', () => {
  const rows = [
    row('2030-01-07', { rest_today_5_22: 60 }),
    row('2030-01-08', { previous_day_start: true, start_minutes_of_day: 1320, end_minutes_from_bucket_date: 360, rest_prev_22_0: 15, rest_today_0_5: 30 }),
    // 同じ日付が 2 行: 2 行目の F は書かれない (1 行目の 1 が残る)、G/H は 2 行目、休憩はセルごとに後勝ち
    row('2030-01-10', { previous_day_start: true, start_minutes_of_day: 1380, end_minutes_from_bucket_date: 300, rest_today_0_5: 20, rest_today_5_22: 45 }),
    row('2030-01-10', { start_minutes_of_day: 600, end_minutes_from_bucket_date: 1500, rest_today_5_22: 50, rest_next_0_5: 10 }),
    // テンプレに行が無い日 (期間の外)
    row('2030-02-01', { rest_today_5_22: 60 }),
  ]

  it('★ 期間内を消してから書いた xlsx の入力列を読み直すと、inputDays と同じ', async () => {
    const tpl = await buildWorkbook([{ name: 'Y時間', xml: yTimeSheetXml() }])
    const res = await writeYTimeRows(tpl, rows, { clearPeriod: PERIOD })
    const fromSheet = await sheetInputs(res.bytes)
    expect(Object.fromEntries(res.inputDays.map((d) => [d.date, d.cells]))).toEqual(fromSheet)
    expect(res.inputDays).toEqual([
      { date: '2030-01-07', cells: { G: 480, H: 1020, L: 60 } },
      { date: '2030-01-08', cells: { F: 1, G: 1320, H: 360, J: 15, K: 30 } },
      { date: '2030-01-10', cells: { F: 1, G: 600, H: 1500, K: 20, L: 50, N: 10 } },
    ])
    expect(res.missingDates).toEqual(['2030-02-01'])
  })

  it('陽性対照: 入力を 1 分変えると、シートの中身も inputDays も同じだけ変わる', async () => {
    const tpl = await buildWorkbook([{ name: 'Y時間', xml: yTimeSheetXml() }])
    const changed = [row('2030-01-07', { rest_today_5_22: 61 }), ...rows.slice(1)]
    const res = await writeYTimeRows(tpl, changed, { clearPeriod: PERIOD })
    expect((await sheetInputs(res.bytes))['2030-01-07']).toEqual({ G: 480, H: 1020, L: 61 })
    expect(res.inputDays[0]).toEqual({ date: '2030-01-07', cells: { G: 480, H: 1020, L: 61 } })
  })

  it('陽性対照: 期間内を消さない呼び方では、シートに残った値と inputDays は一致しない (集計は消してから書く呼び方が前提)', async () => {
    const tpl = await buildWorkbook([{ name: 'Y時間', xml: yTimeSheetXml() }])
    const res = await writeYTimeRows(tpl, rows)
    const fromSheet = await sheetInputs(res.bytes)
    expect(fromSheet['2030-01-07']!.F).toBe(0.9)
    expect(Object.fromEntries(res.inputDays.map((d) => [d.date, d.cells]))).not.toEqual(fromSheet)
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

  it('行が 0 件なら inputDays も空', async () => {
    const tpl = await buildWorkbook([{ name: 'Y時間', xml: yTimeSheetXml() }])
    expect((await writeYTimeRows(tpl, [], { clearPeriod: PERIOD })).inputDays).toEqual([])
  })
})

describe('readSheetCells — シートのセルを型つきで読む', () => {
  // 0: ふりがな (rPh) つきの rich text / 1: 素の <t> / 2: 空の <si/> / 3: 実体参照 / 4: 前後に空白
  const SHARED = '<sst>'
    + '<si><r><rPr><sz val="10"/></rPr><t>日</t></r><rPh sb="0" eb="1"><t>ニチ</t></rPh><phoneticPr fontId="1"/></si>'
    + '<si><t>末</t></si>'
    + '<si/>'
    + '<si><t>A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;</t></si>'
    + '<si><r><t xml:space="preserve">月 </t></r><r><t>曜</t></r></si>'
    + '</sst>'
  const SHEET = '<worksheet><sheetData>'
    + '<row r="3"><c r="F3" s="269"><v>47484</v></c><c r="H3" s="6" t="s"><v>1</v></c></row>'
    + '<row r="5"><c r="F5" s="150" t="s"><v>0</v></c><c r="G5" t="s"><v>2</v></c><c r="H5" t="s"><v>3</v></c>'
    + '<c r="I5" t="s"><v>4</v></c><c r="J5" t="s"><v>99</v></c></row>'
    + '<row r="7"><c r="F7" s="12"><v>37.5</v></c><c r="G7" s="12"/><c r="H7" t="n"><v>0</v></c><c r="I7"><v>abc</v></c>'
    + '<c r="J7" s="1"><f>F7*2</f><v>75</v></c><c r="K7"><v></v></c></row>'
    + '<row r="9"><c r="F9" t="inlineStr"><is><t>火</t></is></c><c r="G9" t="inlineStr"><is><r><t>水</t></r><rPh sb="0" eb="1"><t>スイ</t></rPh></is></c>'
    + '<c r="H9" t="str"><f>"週"&amp;F7</f><v>週 &amp; 37.5</v></c><c r="I9" t="str"><f>T(G7)</f><v xml:space="preserve"> 不適用 </v></c></row>'
    + '<row r="27"><c r="U27" s="18" t="b"><v>0</v></c><c r="V27" t="b"><v>1</v></c><c r="W27" t="e"><v>#N/A</v></c></row>'
    + '</sheetData></worksheet>'
  const workbook = (shared: string | undefined = SHARED) =>
    buildWorkbook([{ name: 'Y時間', xml: yTimeSheetXml() }, { name: '要素', xml: SHEET }], shared)

  it('★ 数値・真偽・文字を型で読み分ける (真偽の 0 は FALSE、数値の 0 は 0)', async () => {
    const cells = await readSheetCells(await workbook(), '要素', ['F3', 'F7', 'H7', 'J7', 'U27', 'V27'])
    expect(cells).toEqual({
      F3: { kind: 'number', value: 47484 },
      F7: { kind: 'number', value: 37.5 },
      H7: { kind: 'number', value: 0 },
      J7: { kind: 'number', value: 75 },
      U27: { kind: 'boolean', value: false },
      V27: { kind: 'boolean', value: true },
    })
  })

  it('★ sharedStrings は <t> 本体だけを繋ぎ、ふりがなを捨てる', async () => {
    const cells = await readSheetCells(await workbook(), '要素', ['F5', 'H3', 'G5', 'H5', 'I5'])
    expect(cells).toEqual({
      F5: { kind: 'string', value: '日' },
      H3: { kind: 'string', value: '末' },
      G5: { kind: 'string', value: '' },
      H5: { kind: 'string', value: 'A & B <C> "D" \'E\'' },
      I5: { kind: 'string', value: '月 曜' },
    })
  })

  it('inlineStr と式の文字 (t="str") も文字として読む', async () => {
    const cells = await readSheetCells(await workbook(), '要素', ['F9', 'G9', 'H9', 'I9'])
    expect(cells).toEqual({
      F9: { kind: 'string', value: '火' },
      G9: { kind: 'string', value: '水' },
      H9: { kind: 'string', value: '週 & 37.5' },
      I9: { kind: 'string', value: ' 不適用 ' },
    })
  })

  it('★ セルが無い・値が無いは empty、エラー値・数値でない中身・範囲外の文字番号は error', async () => {
    const cells = await readSheetCells(await workbook(), '要素', ['Z99', 'G7', 'K7', 'W27', 'I7', 'J5'])
    expect(cells).toEqual({
      Z99: { kind: 'empty' },
      G7: { kind: 'empty' },
      K7: { kind: 'empty' },
      W27: { kind: 'error' },
      I7: { kind: 'error' },
      J5: { kind: 'error' },
    })
  })

  it('セル番地は完全一致で引く (F1 が F11 を拾わない)', async () => {
    const sheet = '<worksheet><sheetData><row r="11"><c r="F11"><v>5</v></c></row></sheetData></worksheet>'
    const wb = await buildWorkbook([{ name: '要素', xml: sheet }])
    expect(await readSheetCells(wb, '要素', ['F1', 'F11'])).toEqual({
      F1: { kind: 'empty' }, F11: { kind: 'number', value: 5 },
    })
  })

  it('sharedStrings.xml が無いテンプレでは、文字番号のセルは error', async () => {
    const wb = await buildWorkbook([{ name: '要素', xml: SHEET }])
    expect(await readSheetCells(wb, '要素', ['F5'])).toEqual({ F5: { kind: 'error' } })
  })

  it('シートが無ければ null', async () => {
    expect(await readSheetCells(await workbook(), '無いシート', ['F5'])).toBeNull()
  })
})
