/**
 * `writeYTimeRows` の `period` (テンプレの対象期間の振り直し、Refs #1133 c1133-2)。
 *
 * ## fixture を repo に置かない理由
 *
 * 本物のテンプレ (R2 `templates/kyoto-soft/base.xlsx`) は `xl/workbook.xml` に
 * **作成元の保存先パス (案件名を含む)** を持っているので、public repo に commit しない。
 * 代わりに、本物と**同じ形のセル**だけを持つ最小の xlsx をテスト内で JSZip で組む:
 *
 * - `要素!F3` / `要素!I3` = 値の直書き (本物: 44986 = 2023-03-01 / 45392 = 2024-04-10)
 * - `Y時間!A7` = `<f>要素!F3</f><v>…</v>`、`A8` 以降 = `IF(A{n-1}="","",IF(A{n-1}+1=要素!$I$3+1,"",A{n-1}+1))`、
 *   期間外の行は `t="str"` + `<v/>` (本物の A414 以降と同じ形)
 * - `月所!B6` = 値の直書き (本物: 45017)、`E6 = EDATE(B6,12)-1`
 *
 * 本物のテンプレに対する実測 (行 7〜371 に 365 日、`missingDates` 0 件) は PR 本文に書く。
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { writeYTimeRows, buildDateRowIndex } from '../../app/utils/y-time-xlsx'
import type { YTimeRow } from '../../app/types'

const TPL_FROM = 44986 // 2023-03-01
const TPL_TO = 45392 // 2024-04-10
const LAST_ROW = 500

function serialOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number]
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000
}

function yTimeSheetXml(): string {
  const rows: string[] = [
    '<row r="5"><c r="A5" s="257"/></row>',
    '<row r="6"><c r="A6" s="258"/><c r="B6"><v>3</v></c></row>',
  ]
  for (let n = 7; n <= LAST_ROW; n++) {
    const f = n === 7
      ? '<f>要素!F3</f>'
      : `<f>IF(A${n - 1}="","",IF(A${n - 1}+1=要素!$I$3+1,"",A${n - 1}+1))</f>`
    const serial = TPL_FROM + (n - 7)
    const a = serial <= TPL_TO
      ? `<c r="A${n}" s="99">${f}<v>${serial}</v></c>`
      : `<c r="A${n}" s="99" t="str">${f}<v/></c>`
    rows.push(`<row r="${n}">${a}<c r="G${n}" s="104"/><c r="H${n}" s="104"/></row>`)
  }
  return `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`
}

const YOSO_XML = '<worksheet><sheetData>'
  + '<row r="2"><c r="F2" s="284"/></row>'
  + `<row r="3"><c r="A3" s="266" t="s"><v>29</v></c><c r="F3" s="269"><v>${TPL_FROM}</v></c>`
  + `<c r="H3" s="6" t="s"><v>30</v></c><c r="I3" s="269"><v>${TPL_TO}</v></c></row>`
  + '</sheetData></worksheet>'

const GESSHO_XML = '<worksheet><sheetData>'
  + '<row r="6"><c r="A6" s="66"/><c r="B6" s="444"><v>45017</v></c>'
  + '<c r="E6" s="445"><f>IF(B6="","",EDATE(B6,12)-1)</f><v>45382</v></c></row>'
  + '</sheetData></worksheet>'

interface TemplateParts { yoso?: string | null; gessho?: string | null }

async function buildTemplate(parts: TemplateParts = {}): Promise<ArrayBuffer> {
  const yoso = parts.yoso === undefined ? YOSO_XML : parts.yoso
  const gessho = parts.gessho === undefined ? GESSHO_XML : parts.gessho
  const sheets: { name: string; xml: string }[] = [{ name: 'Y時間', xml: yTimeSheetXml() }]
  if (yoso !== null) sheets.push({ name: '要素', xml: yoso })
  if (gessho !== null) sheets.push({ name: '月所', xml: gessho })

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

async function sheetXml(bytes: Uint8Array | ArrayBuffer, idx: number): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  return zip.file(`xl/worksheets/sheet${idx}.xml`)!.async('string')
}

/** A 列のセル XML を行番号ごとに取り出す */
function aCells(xml: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const m of xml.matchAll(/<c r="A(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) out.set(Number(m[1]), m[0])
  return out
}

function row(date: string): YTimeRow {
  return {
    date,
    start_minutes_of_day: 480,
    end_minutes_from_bucket_date: 1020,
    previous_day_start: false,
    note: null,
    rest_prev_5_22: 0,
    rest_prev_22_0: 0,
    rest_today_0_5: 0,
    rest_today_5_22: 60,
    rest_today_22_0: 0,
    rest_next_0_5: 0,
    rest_next_5_22: 0,
  } as YTimeRow
}

const PERIOD = { from: '2024-06-01', to: '2025-05-31' }
const PERIOD_ROWS = ['2024-06-01', '2024-12-31', '2025-05-31'].map(row)

describe('writeYTimeRows — period 無し (既存の /y-time-export の呼び方)', () => {
  it('★ 要素 / 月所 のシート XML は 1 バイトも変わらず、Y時間 の A 列も変わらない', async () => {
    const tpl = await buildTemplate()
    const res = await writeYTimeRows(tpl, PERIOD_ROWS, { clearPeriod: PERIOD })
    expect(await sheetXml(res.bytes, 2)).toBe(YOSO_XML)
    expect(await sheetXml(res.bytes, 3)).toBe(GESSHO_XML)
    expect(aCells(await sheetXml(res.bytes, 1))).toEqual(aCells(await sheetXml(tpl, 1)))
  })

  it('テンプレの期間外の日は今までどおり missingDates に落ちる (陽性対照)', async () => {
    const res = await writeYTimeRows(await buildTemplate(), PERIOD_ROWS, { clearPeriod: PERIOD })
    expect(res.missingDates).toEqual(['2024-06-01', '2024-12-31', '2025-05-31'])
  })

  it('要素 / 月所 が無いテンプレでも period 無しなら今までどおり動く', async () => {
    const tpl = await buildTemplate({ yoso: null, gessho: null })
    const res = await writeYTimeRows(tpl, [row('2023-03-01')])
    expect(res.missingDates).toEqual([])
  })
})

describe('writeYTimeRows — period で期間を振り直す (Refs #1133 c1133-2)', () => {
  it('★ 要素!F3 / I3 と 月所!B6 が区切りの開始・終了の serial になる (style は保持)', async () => {
    const res = await writeYTimeRows(await buildTemplate(), [], { period: PERIOD })
    const yoso = await sheetXml(res.bytes, 2)
    expect(yoso).toContain(`<c r="F3" s="269"><v>${serialOf('2024-06-01')}</v></c>`)
    expect(yoso).toContain(`<c r="I3" s="269"><v>${serialOf('2025-05-31')}</v></c>`)
    // 同じ行の他のセルは触らない
    expect(yoso).toContain('<c r="A3" s="266" t="s"><v>29</v></c>')
    expect(yoso).toContain('<c r="H3" s="6" t="s"><v>30</v></c>')
    const gessho = await sheetXml(res.bytes, 3)
    expect(gessho).toContain(`<c r="B6" s="444"><v>${serialOf('2024-06-01')}</v></c>`)
    expect(gessho).toContain('<f>IF(B6="","",EDATE(B6,12)-1)</f>')
  })

  it('★ Y時間 A7〜A371 が 2024-06-01〜2025-05-31 の連番、A372 以降は空、式は全行に残る', async () => {
    const tpl = await buildTemplate()
    const res = await writeYTimeRows(tpl, [], { period: PERIOD })
    const cells = aCells(await sheetXml(res.bytes, 1))
    const before = aCells(await sheetXml(tpl, 1))

    expect(cells.get(7)).toBe(`<c r="A7" s="99"><f>要素!F3</f><v>${serialOf('2024-06-01')}</v></c>`)
    for (let n = 7; n <= 371; n++) {
      expect(cells.get(n)).toContain(`<v>${serialOf('2024-06-01') + (n - 7)}</v>`)
      expect(cells.get(n)).not.toContain('t="str"')
    }
    expect(cells.get(371)).toContain(`<v>${serialOf('2025-05-31')}</v>`)
    for (const n of [372, 373, LAST_ROW]) {
      expect(cells.get(n)).toBe(
        `<c r="A${n}" s="99" t="str"><f>IF(A${n - 1}="","",IF(A${n - 1}+1=要素!$I$3+1,"",A${n - 1}+1))</f><v/></c>`,
      )
    }
    // 式 (<f>…</f>) は 1 つも消えず、1 文字も変わらない
    const formulas = (m: Map<number, string>) => [...m].map(([n, c]) => [n, /<f>[^<]*<\/f>/.exec(c)?.[0] ?? null])
    expect(formulas(cells)).toEqual(formulas(before))
    // 式の無い見出しの A セルは触らない
    expect(cells.get(5)).toBe(before.get(5))
    expect(cells.get(6)).toBe(before.get(6))

    const idx = buildDateRowIndex(await sheetXml(res.bytes, 1))
    expect(idx.get('2024-06-01')).toBe(7)
    expect(idx.get('2025-05-31')).toBe(371)
    expect(idx.has('2025-06-01')).toBe(false)
    expect(idx.has('2024-05-31')).toBe(false)
  })

  it('★ その期間の行は missingDates に落ちず、日付の行に書かれる', async () => {
    const res = await writeYTimeRows(await buildTemplate(), PERIOD_ROWS, { clearPeriod: PERIOD, period: PERIOD })
    expect(res.missingDates).toEqual([])
    const xml = await sheetXml(res.bytes, 1)
    for (const d of ['2024-06-01', '2024-12-31', '2025-05-31']) {
      const n = 7 + serialOf(d) - serialOf('2024-06-01')
      expect(xml).toContain(`<c r="G${n}" s="104"><v>${480 / 1440}</v></c>`)
      expect(xml).toContain(`<c r="H${n}" s="104"><v>${1020 / 1440}</v></c>`)
    }
    // 期間外の日 (区切りの翌日) は書かれず missingDates に出る
    const res2 = await writeYTimeRows(await buildTemplate(), [row('2025-06-01')], { period: PERIOD })
    expect(res2.missingDates).toEqual(['2025-06-01'])
  })

  it('閏年を含む 1 年 (366 日) は A372 まで埋まり A373 から空', async () => {
    const res = await writeYTimeRows(await buildTemplate(), [], { period: { from: '2024-01-01', to: '2024-12-31' } })
    const cells = aCells(await sheetXml(res.bytes, 1))
    expect(cells.get(372)).toContain(`<v>${serialOf('2024-12-31')}</v>`)
    expect(cells.get(373)).toContain('<v/>')
  })

  it('用意された行より長い期間は、あふれた日が missingDates に出る (黙って落とさない)', async () => {
    const res = await writeYTimeRows(await buildTemplate(), [row('2025-12-31')], {
      period: { from: '2024-06-01', to: '2025-12-31' },
    })
    const cells = aCells(await sheetXml(res.bytes, 1))
    expect(cells.get(LAST_ROW)).toContain(`<v>${serialOf('2024-06-01') + LAST_ROW - 7}</v>`)
    expect(res.missingDates).toEqual(['2025-12-31'])
  })

  it('fullCalcOnLoad が立つ (Excel が開いた時に振り直した期間で再計算する)', async () => {
    const res = await writeYTimeRows(await buildTemplate(), [], { period: PERIOD })
    const zip = await JSZip.loadAsync(res.bytes)
    expect(await zip.file('xl/workbook.xml')!.async('string')).toContain('fullCalcOnLoad="1"')
  })

  it('日付の形式違い / 実在しない日 / 逆順は throw (古い期間のまま出さない)', async () => {
    const tpl = await buildTemplate()
    await expect(writeYTimeRows(tpl, [], { period: { from: '2024-6-1', to: '2025-05-31' } }))
      .rejects.toThrow('yyyy-mm-dd')
    await expect(writeYTimeRows(tpl, [], { period: { from: '2024-02-30', to: '2025-05-31' } }))
      .rejects.toThrow('not a real date')
    await expect(writeYTimeRows(tpl, [], { period: { from: '2025-06-01', to: '2025-05-31' } }))
      .rejects.toThrow('is after')
  })

  it('要素 / 月所 シートが無い・対象行が無いテンプレは throw (黙って古い期間を出さない)', async () => {
    await expect(writeYTimeRows(await buildTemplate({ yoso: null }), [], { period: PERIOD }))
      .rejects.toThrow('sheet "要素" not found')
    await expect(writeYTimeRows(await buildTemplate({ gessho: null }), [], { period: PERIOD }))
      .rejects.toThrow('sheet "月所" not found')
    await expect(writeYTimeRows(await buildTemplate({ yoso: '<worksheet><sheetData/></worksheet>' }), [], { period: PERIOD }))
      .rejects.toThrow('row 3 not found in sheet "要素"')
  })
})
