import { describe, expect, it } from 'vitest'
import {
  buildCardRegisterEmail,
  buildCardRegisterFields,
  cardRegisterConfirmKey,
  cardRegisterErrorKey,
  CardRegisterDataError,
  dateOfDateTime,
  extractPageError,
  hasNextOperationsPage,
  isCardInputPage,
  isCardRegisterDonePage,
  isCardRegisterTick,
  jstDate,
  jstStamp,
  latestEtcRunDate,
  maskCardNumber,
  matchVehicle,
  parseOperationsPage,
  plate4OfVehicleCd,
  resolveCardRegisterMode,
  runSearchWindow,
  type CardRegisterResult,
} from '../src/etc-card-register'

// ★ 番号はすべて架空値 (public repo)。
const CARD = '0000111122223333'
const OBU = '9999988888888777777'

// 2026-11-26 09:00 JST
const NOW = new Date('2026-11-26T00:00:00Z')

describe('resolveCardRegisterMode / isCardRegisterTick', () => {
  it('"live" と完全一致のときだけ live、他は dry-run', () => {
    expect(resolveCardRegisterMode('live')).toBe('live')
    for (const v of [undefined, '', 'LIVE', 'dry_run', ' live']) {
      expect(resolveCardRegisterMode(v)).toBe('dry_run')
    }
  })

  it('21 時 (UTC) だけ true', () => {
    expect(isCardRegisterTick(new Date('2026-11-25T21:00:00Z'))).toBe(true)
    expect(isCardRegisterTick(new Date('2026-11-25T22:00:00Z'))).toBe(false)
    expect(isCardRegisterTick(new Date('2026-11-26T00:00:00Z'))).toBe(false)
  })
})

describe('日付 (JST)', () => {
  it('jstDate / jstStamp は JST で切る', () => {
    expect(jstDate(new Date('2026-11-25T15:00:00Z'))).toBe('2026-11-26')
    expect(jstStamp(new Date('2026-11-25T15:04:05Z'))).toBe('20261126000405')
  })

  it('範囲は 61 日前〜今日', () => {
    expect(runSearchWindow(NOW)).toEqual({ from: '2026-09-26', to: '2026-11-26' })
  })

  it('年初は今年の 1/1 で切る (利用年は今年しか選べない)', () => {
    expect(runSearchWindow(new Date('2026-02-10T00:00:00Z'))).toEqual({ from: '2026-01-01', to: '2026-02-10' })
  })

  it('dateOfDateTime は / と - の両方を読み、読めなければ null', () => {
    expect(dateOfDateTime('2026/11/2 3:04:05')).toBe('2026-11-02')
    expect(dateOfDateTime('2026-11-20T14:23')).toBe('2026-11-20')
    expect(dateOfDateTime('')).toBeNull()
  })
})

describe('plate4OfVehicleCd / matchVehicle', () => {
  it('車輌CD % 10000 (先頭 0 なし)、数字でなければ null', () => {
    expect(plate4OfVehicleCd('20001234')).toBe('1234')
    expect(plate4OfVehicleCd(' 50000056 ')).toBe('56')
    expect(plate4OfVehicleCd('ABC')).toBeNull()
    expect(plate4OfVehicleCd(null)).toBeNull()
    expect(plate4OfVehicleCd(undefined)).toBeNull()
  })

  const op = (unko_no: string, vehicle_cd: string | null, reading_date: string) => ({ unko_no, vehicle_cd, reading_date })

  it('一致なし → none', () => {
    expect(matchVehicle([op('U1', '10009999', '2026-11-01'), op('U2', null, '2026-11-01')], '1234')).toEqual({ kind: 'none' })
  })

  it('別の車輌CD が 2 つ一致 → multiple', () => {
    expect(matchVehicle([op('U1', '10001234', '2026-11-01'), op('U2', '20001234', '2026-11-02')], '1234')).toEqual({
      kind: 'multiple',
      vehicleCds: ['10001234', '20001234'],
    })
  })

  it('1 台 → 読取日の新しい順・運行NO で重複を畳む', () => {
    const r = matchVehicle(
      [
        op('U1', '10001234', '2026-11-01'),
        op('U3', '10001234', '2026-11-03'),
        op('U2', '10001234', '2026-11-02'),
        op('U3', '10001234', '2026-11-03'), // 2 マンの crew_role 違い
        op('U4', '10001234', '2026-11-02'),
      ],
      '1234',
    )
    expect(r).toEqual({ kind: 'one', vehicleCd: '10001234', unkoNos: ['U3', 'U2', 'U4', 'U1'] })
  })
})

describe('parseOperationsPage / hasNextOperationsPage', () => {
  it('必要な列を読む (vehicle_cd が無い行は null)', () => {
    const p = parseOperationsPage({
      operations: [{ unko_no: 'U1', vehicle_cd: '1', reading_date: '2026-11-01', extra: 1 }, { unko_no: 'U2', reading_date: '2026-11-02' }],
      total: 3,
      page: 1,
      per_page: 2,
    })
    expect(p.operations).toEqual([
      { unko_no: 'U1', vehicle_cd: '1', reading_date: '2026-11-01' },
      { unko_no: 'U2', vehicle_cd: null, reading_date: '2026-11-02' },
    ])
    expect(hasNextOperationsPage(p)).toBe(true)
    expect(hasNextOperationsPage({ ...p, page: 2 })).toBe(false)
    expect(hasNextOperationsPage({ ...p, operations: [] })).toBe(false)
  })

  it('page / per_page が無ければ 1 / 行数', () => {
    const p = parseOperationsPage({ operations: [{ unko_no: 'U1', reading_date: 'd' }], total: 1 })
    expect(p).toMatchObject({ page: 1, per_page: 1 })
  })

  it('形が違えば loud fail', () => {
    expect(() => parseOperationsPage(null)).toThrow(CardRegisterDataError)
    expect(() => parseOperationsPage({ operations: [] })).toThrow('operations / total')
    expect(() => parseOperationsPage({ operations: [null], total: 1 })).toThrow('unko_no / reading_date')
  })
})

describe('latestEtcRunDate', () => {
  const W = { from: '2026-09-26', to: '2026-11-26' }
  const headers = ['運行NO', '車輌CD', '開始日時', '終了日時', '"ETC利用"', '料金']

  it('ETC利用 = 1 の行の終了日時のうち範囲内の最新日', () => {
    const rows = [
      ['U', '1', '2026/11/19 23:00:00', '2026/11/20 01:00:00', '1', '100'], // 日跨ぎ → 終了日
      ['U', '1', '2026/11/21 10:00:00', '2026/11/21 11:00:00', '"1"', '100'],
      ['U', '1', '2026/11/22 10:00:00', '2026/11/22 11:00:00', '0', '100'], // ETC でない
      ['U', '1', '2026/11/27 10:00:00', '2026/11/27 11:00:00', '1', '100'], // 範囲外 (未来)
      ['U', '1', '2026/09/25 10:00:00', '2026/09/25 11:00:00', '1', '100'], // 範囲外 (古い)
      ['U', '1', '', '', '1', '100'], // 日時が読めない
      'not-an-array',
      ['U', '1', '2026/11/10 10:00:00', '2026/11/10 11:00:00', '1', '100'],
    ]
    expect(latestEtcRunDate({ headers, rows }, W)).toBe('2026-11-21')
  })

  it('該当なしは null', () => {
    expect(latestEtcRunDate({ headers, rows: [] }, W)).toBeNull()
  })

  it('形・列が違えば loud fail', () => {
    expect(() => latestEtcRunDate(null, W)).toThrow('headers / rows')
    expect(() => latestEtcRunDate({ headers: [], rows: 1 }, W)).toThrow('headers / rows')
    expect(() => latestEtcRunDate({ headers: ['終了日時'], rows: [] }, W)).toThrow('ETC利用 / 終了日時')
    expect(() => latestEtcRunDate({ headers: ['ETC利用'], rows: [] }, W)).toThrow('ETC利用 / 終了日時')
  })
})

describe('buildCardRegisterFields', () => {
  const ok = { cardNumber: CARD, obuNumber: OBU, plate4: '1234', runDate: '2026-11-20' }

  it('9 欄を組む (車載器管理番号は 5/8/6 桁に分ける)', () => {
    expect(buildCardRegisterFields(ok, NOW)).toEqual({
      ok: true,
      fields: {
        icCardID: CARD,
        icCardIDConfirm: CARD,
        riyonengappiYear: '2026',
        riyonengappimonth: '11',
        riyonengappiDay: '20',
        syasaikiNoL: '99999',
        syasaikiNoC: '88888888',
        syasaikiNoR: '777777',
        sharyoNo: '1234',
      },
    })
  })

  it.each([
    [{ cardNumber: null }, 'カード番号'],
    [{ cardNumber: '123' }, 'カード番号'],
    [{ obuNumber: null }, '車載器管理番号'],
    [{ obuNumber: '1'.repeat(18) }, '車載器管理番号'],
    [{ plate4: null }, 'ナンバー下 4 桁'],
    [{ plate4: '0123' }, 'ナンバー下 4 桁'],
    [{ plate4: '12345' }, 'ナンバー下 4 桁'],
    [{ runDate: '2026/11/20' }, 'YYYY-MM-DD'],
    [{ runDate: '2025-12-31' }, '今年'],
  ])('%o は送らずに理由を返す', (patch, reason) => {
    const r = buildCardRegisterFields({ ...ok, ...patch }, NOW)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toContain(reason)
  })
})

describe('画面の判定 (仮置き)', () => {
  const INPUT = '<form><input type="text" name="icCardIDConfirm" value=""></form>'
  const CONFIRM = '<form><input type="hidden" name="icCardIDConfirm" value="x"><p>以下の内容で登録します</p></form>'

  it('isCardInputPage: 確認欄の入力欄 (hidden でない) が在れば入力画面', () => {
    expect(isCardInputPage(INPUT)).toBe(true)
    expect(isCardInputPage('<input name="icCardIDConfirm">')).toBe(true)
    expect(isCardInputPage(CONFIRM)).toBe(false)
    expect(isCardInputPage('<input type="hidden" name="p"><input name="other">')).toBe(false)
  })

  it('isCardRegisterDonePage: 印を含み、入力画面でない', () => {
    expect(isCardRegisterDonePage('<p>カードの追加登録しました</p>')).toBe(true)
    expect(isCardRegisterDonePage('<p>何か</p>')).toBe(false)
    expect(isCardRegisterDonePage(`${INPUT}<p>登録が完了</p>`)).toBe(false)
  })

  it('extractPageError: class に error を含む要素の文字', () => {
    expect(extractPageError('<div class="msg errorText"><b>カード番号</b> が 誤っています</div>')).toBe('カード番号 が 誤っています')
    expect(extractPageError('<p>ok</p>')).toBe('')
  })
})

describe('R2 key / mask', () => {
  it('confirm / error の key', () => {
    expect(cardRegisterConfirmKey('etc', 7, NOW)).toBe('etc-card-register/7/20261126090000-confirm.html')
    expect(cardRegisterErrorKey('etc-staging', 7, NOW)).toBe('etc-staging-errors/card-register/7/20261126090000.html')
  })

  it('カード番号は末尾 5 桁まで', () => {
    expect(maskCardNumber(CARD)).toBe('*23333')
    expect(maskCardNumber('123')).toBe('(不明)')
    expect(maskCardNumber(null)).toBe('(不明)')
  })
})

describe('buildCardRegisterEmail', () => {
  const r = (over: Partial<CardRegisterResult>): CardRegisterResult => ({ id: 1, cardNumber: CARD, kind: 'no_run', ...over })

  it('走行待ちだけなら送らない (null)', () => {
    expect(buildCardRegisterEmail([], 'dry_run', NOW)).toBeNull()
    expect(buildCardRegisterEmail([r({})], 'live', NOW)).toBeNull()
  })

  it('dry-run の件名と本文 (カード番号は末尾 5 桁、走行待ちは載せない)', () => {
    const mail = buildCardRegisterEmail(
      [
        r({ id: 1, kind: 'dry_run_ok', runDate: '2026-11-20' }),
        r({ id: 2, kind: 'failed', detail: '車両が複数一致' }),
        r({ id: 3, kind: 'error', detail: '照合に失敗' }),
        r({ id: 4, kind: 'no_run' }),
      ],
      'dry_run',
      NOW,
    )!
    expect(mail.subject).toBe('[dtako] ETC カード登録 (dry-run) 2026-11-26 登録 0 / dry-run 1 / 失敗 2')
    expect(mail.body.split('\n')).toEqual([
      '【ETC カード追加登録】dry-run (確認画面で停止)',
      'id 1 カード *23333: 確認画面まで (dry-run) 走行日 2026-11-20',
      'id 2 カード *23333: 失敗 — 車両が複数一致',
      'id 3 カード *23333: 照合できず — 照合に失敗',
    ])
    expect(mail.body).not.toContain(CARD)
  })

  it('live の件名と本文', () => {
    const mail = buildCardRegisterEmail([r({ kind: 'registered', runDate: '2026-11-20' })], 'live', NOW)!
    expect(mail.subject).toBe('[dtako] ETC カード登録 2026-11-26 登録 1 / dry-run 0 / 失敗 0')
    expect(mail.body).toContain('本登録')
    expect(mail.body).toContain('登録済み')
  })
})
