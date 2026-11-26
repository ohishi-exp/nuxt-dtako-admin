import { describe, expect, it } from 'vitest'
import {
  applyEdit,
  canRegister,
  canRescan,
  rescanResultText,
  cardLast5,
  countByStatus,
  effectiveRegistrationDate,
  etcCardErrorText,
  formatBytes,
  halfwidth,
  initialStatus,
  isEmptyFields,
  maskedCard,
  normalizeDigits,
  normalizeFields,
  normalizeKubun,
  parseRegistrationDateInput,
  plate4Of,
  receivedDate,
  statusAfterRegistrationDateChange,
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
    expect(canRescan({ status: 'waiting_run', plate4: '1234' })).toBe(true)
    expect(canRescan({ status: 'waiting_run', plate4: null })).toBe(false)
    expect(canRescan({ status: 'dry_run_ok', plate4: '1234' })).toBe(false)
    const base = { operations: 3, skipped: 0, truncated: false }
    expect(rescanResultText({ ...base, kind: 'found', run_date: '2026-11-20' })).toBe('走行日 2026-11-20 が見つかりました (運行 3 件を確認)')
    expect(rescanResultText({ ...base, kind: 'kept', run_date: '2026-11-21' })).toBe('走行日は 2026-11-21 のままです (これより新しい走行はありません) (運行 3 件を確認)')
    expect(rescanResultText({ ...base, kind: 'none', run_date: null })).toBe('見つかりませんでした (運行 3 件を確認)')
    expect(rescanResultText({ operations: 200, skipped: 2, truncated: true, kind: 'multiple', run_date: null }))
      .toBe('下 4 桁が同じ車両が複数あるため「失敗」にしました (運行 200 件を確認。料金所の記録が無い運行 2 件は飛ばしました。運行が多いため新しい方だけ確認しました)')
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

/**
 * 実効の登録日の入出力。**relay の `workers/dtako-scraper-relay/test/etc-card-register.test.ts` にも同じ表がある**
 * — 両方の `effectiveRegistrationDate` が同じ値を返すことをこの表で固定する (片方だけ直したら落ちる)。
 */
const EFFECTIVE_REG_CASES: [string | null, string, string][] = [
  ['2026-11-01', '2026-11-20T03:00:00.000Z', '2026-11-01'], // 入れた登録日が勝つ
  [null, '2026-11-20T03:00:00.000Z', '2026-11-20'], // 空なら受信日 (JST)
  [null, '2026-11-20T14:59:59.999Z', '2026-11-20'], // JST 23:59
  [null, '2026-11-20T15:00:00.000Z', '2026-11-21'], // UTC 15:00 以降は JST の翌日
]

describe('登録日', () => {
  it('effectiveRegistrationDate: 入れた登録日、空なら受信日の JST の日付 (relay と同じ表)', () => {
    for (const [reg, received, want] of EFFECTIVE_REG_CASES) {
      expect(effectiveRegistrationDate(reg, received)).toBe(want)
    }
    expect(receivedDate('2026-11-20T15:00:00.000Z')).toBe('2026-11-21')
  })

  it('parseRegistrationDateInput: 実在する YYYY-MM-DD と null / 空文字だけ通す', () => {
    expect(parseRegistrationDateInput({ registration_date: '2026-11-10' })).toEqual({ ok: true, value: '2026-11-10' })
    expect(parseRegistrationDateInput({ registration_date: '2028-02-29' })).toEqual({ ok: true, value: '2028-02-29' })
    expect(parseRegistrationDateInput({ registration_date: null })).toEqual({ ok: true, value: null })
    expect(parseRegistrationDateInput({ registration_date: '' })).toEqual({ ok: true, value: null })
    const bad = { ok: false, error: '登録日は YYYY-MM-DD の日付です' }
    for (const v of ['2026-02-30', '2026-13-01', '2026/11/10', '2026-11-1', 20261110, true]) {
      expect(parseRegistrationDateInput({ registration_date: v })).toEqual(bad)
    }
    for (const input of [null, 'x', {}, { other: 1 }]) {
      expect(parseRegistrationDateInput(input)).toEqual({ ok: false, error: '入力の形が違います' })
    }
  })

  it('statusAfterRegistrationDateChange: dry_run_ok / failed は waiting_run に戻し、他はそのまま', () => {
    expect(statusAfterRegistrationDateChange('dry_run_ok')).toBe('waiting_run')
    expect(statusAfterRegistrationDateChange('failed')).toBe('waiting_run')
    expect(statusAfterRegistrationDateChange('waiting_run')).toBe('waiting_run')
    expect(statusAfterRegistrationDateChange('needs_review')).toBe('needs_review')
  })
})
