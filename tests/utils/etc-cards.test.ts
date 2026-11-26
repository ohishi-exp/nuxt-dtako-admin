import { describe, expect, it } from 'vitest'
import {
  applyEdit,
  canRegister,
  cardLast5,
  countByStatus,
  etcCardErrorText,
  formatBytes,
  halfwidth,
  initialStatus,
  isEmptyFields,
  maskedCard,
  normalizeDigits,
  normalizeFields,
  normalizeKubun,
  plate4Of,
  type EtcCardFields,
} from '~/utils/etc-cards'

// 番号はすべて架空 (public repo)
const FULL: EtcCardFields = { kubun: '新規', card_number: '0000000000000010', vehicle_number: 'テスト100あ1234', obu_number: '0000000000000000019' }

describe('halfwidth / normalizeDigits', () => {
  it('全角数字と全角ハイフンを半角にする', () => {
    expect(halfwidth('０１２－３')).toBe('012-3')
  })
  it('数字以外を落とし、桁が合うときだけ返す', () => {
    expect(normalizeDigits('0000 0000 0000 0010', 16)).toBe('0000000000000010')
    expect(normalizeDigits('００００００００００００００１０', 16)).toBe('0000000000000010')
    expect(normalizeDigits('000000000000001', 16)).toBeNull()
    expect(normalizeDigits('   ', 16)).toBeNull()
    expect(normalizeDigits(10, 16)).toBeNull()
    expect(normalizeDigits(null, 16)).toBeNull()
  })
})

describe('normalizeKubun', () => {
  it('末尾の「発行」を落として 3 種だけ通す', () => {
    expect(normalizeKubun('新規発行')).toBe('新規')
    expect(normalizeKubun(' 追加 ')).toBe('追加')
    // 「発行」を先に落とすと「再」になって消える (落とす前の形を先に見る)
    expect(normalizeKubun('再発行')).toBe('再発行')
    expect(normalizeKubun('再発行発行')).toBe('再発行')
    expect(normalizeKubun('追加発行')).toBe('追加')
    expect(normalizeKubun('廃止')).toBeNull()
    expect(normalizeKubun('')).toBeNull()
    expect(normalizeKubun(undefined)).toBeNull()
  })
})

describe('normalizeFields / isEmptyFields', () => {
  it('OCR の行を 4 項目にし、読めない項目は null', () => {
    expect(normalizeFields({ kubun: '新規発行', card_number: '0000-0000-0000-0010', vehicle_number: ' テスト100あ1234 ', obu_number: '0000000000000000019' }))
      .toEqual(FULL)
    expect(normalizeFields({ card_number: '123' })).toEqual({ kubun: null, card_number: null, vehicle_number: null, obu_number: null })
  })
  it('object でない行は全部 null で、空行と判定される', () => {
    expect(isEmptyFields(normalizeFields(null))).toBe(true)
    expect(isEmptyFields(normalizeFields('x'))).toBe(true)
    expect(isEmptyFields({ ...normalizeFields(null), vehicle_number: 'テスト' })).toBe(false)
  })
})

describe('plate4Of', () => {
  it('末尾の数字を下 4 桁にし、先頭の 0 を落とす', () => {
    expect(plate4Of('テスト100あ1234')).toBe('1234')
    expect(plate4Of('テスト100あ0056')).toBe('56')
    expect(plate4Of('テスト100あ１２３４')).toBe('1234')
  })
  it('一連指定番号の区切り (- ・ 空白) は読み飛ばす', () => {
    expect(plate4Of('テスト100あ12-34')).toBe('1234')
    expect(plate4Of('テスト100あ・・12')).toBe('12')
    expect(plate4Of('テスト 100 あ 1234')).toBe('1234')
  })
  it('数字が無い・4 桁を超える・0 だけ・null は null', () => {
    expect(plate4Of('テスト100あ')).toBeNull()
    expect(plate4Of('テスト100あ12345')).toBeNull()
    expect(plate4Of('テスト100あ0000')).toBeNull()
    expect(plate4Of(null)).toBeNull()
  })
})

describe('initialStatus', () => {
  it('4 項目が揃えば waiting_run', () => {
    expect(initialStatus(FULL)).toBe('waiting_run')
  })
  it('どれか欠ければ needs_review (車両番号はあっても下 4 桁が読めなければ欠け)', () => {
    expect(initialStatus({ ...FULL, kubun: null })).toBe('needs_review')
    expect(initialStatus({ ...FULL, card_number: null })).toBe('needs_review')
    expect(initialStatus({ ...FULL, obu_number: null })).toBe('needs_review')
    expect(initialStatus({ ...FULL, vehicle_number: 'テスト100あ' })).toBe('needs_review')
  })
})

describe('applyEdit', () => {
  const partial: EtcCardFields = { kubun: null, card_number: '0000000000000010', vehicle_number: null, obu_number: null }

  it('入れた項目を重ね、揃えば waiting_run になる値を返す', () => {
    const r = applyEdit(partial, { kubun: '新規', card_number: '', vehicle_number: 'テスト100あ1234', obu_number: '０００００００００００００００００１９' })
    expect(r).toEqual({ ok: true, fields: FULL })
    expect(r.ok && initialStatus(r.fields)).toBe('waiting_run')
  })
  it('card_number の空欄は今の値のまま、他の欄は空で消せる、無い鍵は触らない', () => {
    expect(applyEdit(FULL, { card_number: '  ', kubun: '', obu_number: '' }))
      .toEqual({ ok: true, fields: { ...FULL, kubun: null, obu_number: null } })
    expect(applyEdit(FULL, { vehicle_number: '' })).toEqual({ ok: true, fields: { ...FULL, vehicle_number: null } })
    expect(applyEdit(FULL, {})).toEqual({ ok: true, fields: FULL })
  })
  it('card_number を入れたら全桁で置き換える', () => {
    expect(applyEdit(FULL, { card_number: '0000 0000 0000 0020' })).toEqual({ ok: true, fields: { ...FULL, card_number: '0000000000000020' } })
  })
  it('規則に合わない値は null に落とさず誤りにする', () => {
    expect(applyEdit(FULL, { kubun: '廃止' })).toEqual({ ok: false, error: '区分は 新規 / 追加 / 再発行 のどれかです' })
    expect(applyEdit(FULL, { card_number: '123' })).toEqual({ ok: false, error: 'カード番号は数字 16 桁です' })
    expect(applyEdit(FULL, { vehicle_number: 'テスト' })).toEqual({ ok: false, error: '車両番号の末尾にナンバー (4 桁以内の数字) が読めません' })
    expect(applyEdit(FULL, { obu_number: '1' })).toEqual({ ok: false, error: '車載器番号は数字 19 桁です' })
  })
  it('本文が object でなければ誤り', () => {
    expect(applyEdit(FULL, null)).toEqual({ ok: false, error: '入力の形が違います' })
    expect(applyEdit(FULL, 'x')).toEqual({ ok: false, error: '入力の形が違います' })
  })
})

describe('表示', () => {
  it('カード番号は末尾 5 桁', () => {
    expect(cardLast5('0000000000000010')).toBe('00010')
    expect(cardLast5(null)).toBeNull()
    expect(maskedCard('00010')).toBe('…00010')
    expect(maskedCard(null)).toBe('(未読)')
  })
  it('大きさは 1KB 未満を 0 KB にしない', () => {
    expect(formatBytes(26)).toBe('26 B')
    expect(formatBytes(1536)).toBe('2 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })
  it('status ごとの件数 (0 件も並べ、知らない status は数えない)', () => {
    expect(countByStatus([{ status: 'needs_review' }, { status: 'needs_review' }, { status: 'registered' }, { status: 'bogus' }]))
      .toEqual({ needs_review: 2, waiting_run: 0, dry_run_ok: 0, registered: 1, failed: 0 })
  })
  it('今すぐ登録は要確認と登録済みには出さない', () => {
    expect(canRegister('needs_review')).toBe(false)
    expect(canRegister('registered')).toBe(false)
    expect(canRegister('waiting_run')).toBe(true)
    expect(canRegister('dry_run_ok')).toBe(true)
    expect(canRegister('failed')).toBe(true)
  })
})

describe('etcCardErrorText', () => {
  const err = (statusCode: number) => Object.assign(new Error(`x: ${statusCode}`), { statusCode })
  it('404 は口が無いか行が無い、409 は状態の不一致', () => {
    expect(etcCardErrorText(err(404), 'r')).toContain('登録の仕組みがまだ入っていない')
    expect(etcCardErrorText(err(409), 'r')).toBe('今の状態ではこの操作はできません。再読み込みしてください')
  })
  it('それ以外は共通の文 (retry を含む)', () => {
    expect(etcCardErrorText(err(500), 'もう一度押してください')).toContain('もう一度押してください')
  })
})
