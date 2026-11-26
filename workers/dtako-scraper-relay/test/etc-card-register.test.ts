import { describe, expect, it } from 'vitest'
import {
  buildCardRegisterEmail,
  buildCardRegisterFields,
  buildRunConfirmEmail,
  cardRegisterConfirmKey,
  cardRegisterErrorKey,
  CardRegisterDataError,
  countNonEtcRows,
  dateOfDateTime,
  decodeCsvBytes,
  effectiveRegistrationDate,
  extractPageError,
  findRunForPlate,
  isCardInputPage,
  isCardRegisterDonePage,
  isCardRegisterTick,
  isRunDateUsable,
  jstDate,
  jstStamp,
  maskCardNumber,
  maskUserId,
  parseTollCsv,
  plate4OfVehicleCd,
  resolveCardRegisterMode,
  runSearchWindow,
  splitCsvLine,
  type CardRegisterResult,
  fetchEtcAccountType,
  parseAccountType,
  pickCardRegisterAccount,
  type EtcAccountTypeNamespace,
} from '../src/etc-card-register'

// ★ 番号はすべて架空値 (public repo)。
const CARD = '0000111122223333'
const OBU = '9999988888888777777'

// 2026-11-26 09:00 JST
const NOW = new Date('2026-11-26T00:00:00Z')
/** 窓に効かない (61 日前・今年 1/1 より古い) 登録日。登録日以外の下限を見るテストで使う。 */
const OLD_REG = '2025-01-01'

/**
 * 実効の登録日の入出力。**front の `tests/utils/etc-cards.test.ts` にも同じ表がある** — 両方の
 * `effectiveRegistrationDate` が同じ値を返すことをこの表で固定する (片方だけ直したら落ちる)。
 */
const EFFECTIVE_REG_CASES: [string | null, string, string][] = [
  ['2026-11-01', '2026-11-20T03:00:00.000Z', '2026-11-01'], // 入れた登録日が勝つ
  [null, '2026-11-20T03:00:00.000Z', '2026-11-20'], // 空なら受信日 (JST)
  [null, '2026-11-20T14:59:59.999Z', '2026-11-20'], // JST 23:59
  [null, '2026-11-20T15:00:00.000Z', '2026-11-21'], // UTC 15:00 以降は JST の翌日
]

describe('resolveCardRegisterMode / isCardRegisterTick', () => {
  it('"live" と完全一致のときだけ live、他は dry-run', () => {
    expect(resolveCardRegisterMode('live')).toBe('live')
    for (const v of [undefined, '', 'LIVE', 'dry_run', ' live', 'OFF', ' off']) {
      expect(resolveCardRegisterMode(v)).toBe('dry_run')
    }
    expect(resolveCardRegisterMode('off')).toBe('off')
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
    expect(runSearchWindow(NOW, OLD_REG)).toEqual({ from: '2026-09-26', to: '2026-11-26' })
  })

  it('年初は今年の 1/1 で切る (利用年は今年しか選べない)', () => {
    expect(runSearchWindow(new Date('2026-02-10T00:00:00Z'), OLD_REG)).toEqual({ from: '2026-01-01', to: '2026-02-10' })
  })

  it('登録日が 61 日前・今年 1/1 より後なら登録日が下限。前なら効かない', () => {
    expect(runSearchWindow(NOW, '2026-11-10')).toEqual({ from: '2026-11-10', to: '2026-11-26' })
    expect(runSearchWindow(NOW, '2026-09-01')).toEqual({ from: '2026-09-26', to: '2026-11-26' }) // 61 日前が勝つ
    expect(runSearchWindow(new Date('2026-02-10T00:00:00Z'), '2025-12-20')).toEqual({ from: '2026-01-01', to: '2026-02-10' })
    // 今日より後の登録日 → from > to (何も拾わない)
    expect(runSearchWindow(NOW, '2026-11-27')).toEqual({ from: '2026-11-27', to: '2026-11-26' })
  })

  it('effectiveRegistrationDate: 入れた登録日、空なら受信日の JST の日付 (UTC 15:00 の境界を含む)', () => {
    for (const [reg, received, want] of EFFECTIVE_REG_CASES) {
      expect(effectiveRegistrationDate(reg, received)).toBe(want)
    }
  })

  it('dateOfDateTime は / と - の両方を読み、読めなければ null', () => {
    expect(dateOfDateTime('2026/11/2 3:04:05')).toBe('2026-11-02')
    expect(dateOfDateTime('2026-11-20T14:23')).toBe('2026-11-20')
    expect(dateOfDateTime('')).toBeNull()
  })
})

describe('plate4OfVehicleCd', () => {
  it('車輌CD % 10000 (先頭 0 なし)、数字でなければ null', () => {
    expect(plate4OfVehicleCd('20001234')).toBe('1234')
    expect(plate4OfVehicleCd(' 50000056 ')).toBe('56')
    expect(plate4OfVehicleCd('ABC')).toBeNull()
    expect(plate4OfVehicleCd(null)).toBeNull()
    expect(plate4OfVehicleCd(undefined)).toBeNull()
  })
})

describe('decodeCsvBytes (文字コード)', () => {
  const text = '運行NO,車輌CD,終了日時,ETC利用\r\n'
  it('UTF-8 として読めれば UTF-8', () => {
    expect(decodeCsvBytes(new TextEncoder().encode(text))).toBe(text)
  })
  it('UTF-8 として壊れていれば Shift_JIS', () => {
    // 「運行」の Shift_JIS = 89 5E 8D 73 (UTF-8 としては不正)
    expect(decodeCsvBytes(new Uint8Array([0x89, 0x5e, 0x8d, 0x73, 0x4e, 0x4f]))).toBe('運行NO')
  })
})

describe('splitCsvLine / parseTollCsv', () => {
  it('引用符・その中の , と "" を扱い、前後の空白を落とす', () => {
    expect(splitCsvLine(' a ,"b,c","d""e",')).toEqual(['a', 'b,c', 'd"e', ''])
  })

  it('必要な 4 列を拾う (BOM・空行・列不足の行も読む)', () => {
    const csv = '\uFEFF"運行NO","車輌CD","開始日時","終了日時","ETC利用"\r\n' +
      '"U1","10001234","2026/11/19 23:00:00","2026/11/20 01:00:00","1"\r\n\r\n' +
      'U2\n'
    expect(parseTollCsv(csv)).toEqual([
      { unkoNo: 'U1', vehicleCd: '10001234', endDate: '2026-11-20', etc: '1' },
      { unkoNo: 'U2', vehicleCd: '', endDate: null, etc: '' },
    ])
  })

  it('列の順は見出しで決める (列が足りない行は空)', () => {
    expect(parseTollCsv('ETC利用,車輌CD,運行NO,終了日時\n1\n')).toEqual([{ unkoNo: '', vehicleCd: '', endDate: null, etc: '1' }])
  })

  it('列が無ければ loud fail (空の本文も)', () => {
    expect(() => parseTollCsv('運行NO,車輌CD,終了日時\n')).toThrow(CardRegisterDataError)
    expect(() => parseTollCsv('運行NO,車輌CD,終了日時\n')).toThrow('ETC利用')
    expect(() => parseTollCsv('')).toThrow('運行NO')
  })
})

describe('findRunForPlate / countNonEtcRows / isRunDateUsable', () => {
  // ★ W は runSearchWindow(NOW, OLD_REG) と同じ。登録日の効き目は下の it で窓を作り直して見る
  const W = { from: '2026-09-26', to: '2026-11-26' }
  const r = (unkoNo: string, vehicleCd: string, endDate: string | null, etc = '1') => ({ unkoNo, vehicleCd, endDate, etc })

  it('ETC 走行の終了日のうち範囲内の最新日。同じ日なら運行NO の大きい方', () => {
    const rows = [
      r('U1', '10001234', '2026-11-20'),
      r('U3', '10001234', '2026-11-21'),
      r('U2', '10001234', '2026-11-21'),
      r('U4', '10001234', '2026-11-22', '0'), // ETC でない
      r('U5', '10001234', '2026-11-27'), // 未来
      r('U6', '10001234', '2026-09-25'), // 古い
      r('U7', '10001234', null),
      r('X1', '10009999', '2026-11-25'), // 別の車両
    ]
    expect(findRunForPlate(rows, '1234', W)).toEqual({ kind: 'found', runDate: '2026-11-21', unkoNo: 'U3' })
    expect(findRunForPlate([r('U2', '10001234', '2026-11-21'), r('U3', '10001234', '2026-11-21')], '1234', W)).toMatchObject({ unkoNo: 'U3' })
    expect(countNonEtcRows(rows)).toBe(1)
  })

  it('一致なし・範囲内の ETC 走行なし → none', () => {
    expect(findRunForPlate([r('X', '10009999', '2026-11-20')], '1234', W)).toEqual({ kind: 'none' })
    expect(findRunForPlate([r('U', '10001234', '2026-11-20', '2')], '1234', W)).toEqual({ kind: 'none' })
  })

  it('plate4 が一致する車輌CD が 2 種類 → multiple (ETC でない行も数える)', () => {
    expect(findRunForPlate([r('U1', '10001234', '2026-11-20'), r('U2', '20001234', null, '0')], '1234', W)).toEqual({
      kind: 'multiple',
      vehicleCds: ['10001234', '20001234'],
    })
  })

  it('登録日より前の走行だけ → none / 登録日以降に走行あり → その日 (登録日の当日を含む)', () => {
    const rows = [r('U1', '10001234', '2026-11-08'), r('U2', '10001234', '2026-11-09')]
    expect(findRunForPlate(rows, '1234', runSearchWindow(NOW, '2026-11-10'))).toEqual({ kind: 'none' })
    expect(findRunForPlate([...rows, r('U3', '10001234', '2026-11-12')], '1234', runSearchWindow(NOW, '2026-11-10'))).toEqual({
      kind: 'found',
      runDate: '2026-11-12',
      unkoNo: 'U3',
    })
    expect(findRunForPlate(rows, '1234', runSearchWindow(NOW, '2026-11-09'))).toMatchObject({ runDate: '2026-11-09' })
  })

  it('登録日が空 → 受信日の JST の日付が下限 (UTC 15:00 の受信は翌日扱い)', () => {
    const rows = [r('U1', '10001234', '2026-11-20')]
    const at = (received: string) => runSearchWindow(NOW, effectiveRegistrationDate(null, received))
    expect(findRunForPlate(rows, '1234', at('2026-11-20T14:59:59.999Z'))).toMatchObject({ runDate: '2026-11-20' })
    expect(findRunForPlate(rows, '1234', at('2026-11-20T15:00:00.000Z'))).toEqual({ kind: 'none' })
  })

  it('isRunDateUsable: 範囲内 (今年) だけ true', () => {
    expect(isRunDateUsable('2026-11-20', NOW, OLD_REG)).toBe(true)
    expect(isRunDateUsable('2026-09-25', NOW, OLD_REG)).toBe(false)
    expect(isRunDateUsable('2026-11-27', NOW, OLD_REG)).toBe(false)
    expect(isRunDateUsable(null, NOW, OLD_REG)).toBe(false)
    expect(isRunDateUsable('2026/11/20', NOW, OLD_REG)).toBe(false)
    expect(isRunDateUsable('2025-12-31', new Date('2026-01-05T00:00:00Z'), OLD_REG)).toBe(false)
  })

  it('isRunDateUsable: 確認段と同じ窓 — 登録日より前の走行日は false、61 日前より古い登録日なら 61 日前が下限', () => {
    expect(isRunDateUsable('2026-11-09', NOW, '2026-11-10')).toBe(false)
    expect(isRunDateUsable('2026-11-10', NOW, '2026-11-10')).toBe(true)
    expect(isRunDateUsable('2026-09-25', NOW, '2026-09-01')).toBe(false)
    expect(isRunDateUsable('2026-09-26', NOW, '2026-09-01')).toBe(true)
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

  it('user_id は末尾 4 文字まで', () => {
    expect(maskUserId('abcdef1234')).toBe('*1234')
  })

  it('user_id が 4 文字未満なら (不明)', () => {
    expect(maskUserId('abc')).toBe('(不明)')
  })
})

describe('buildCardRegisterEmail', () => {
  const r = (over: Partial<CardRegisterResult>): CardRegisterResult => ({ id: 1, cardNumber: CARD, kind: 'dry_run_ok', ...over })

  it('結末が 0 件なら送らない (null)', () => {
    expect(buildCardRegisterEmail([], 'dry_run', NOW)).toBeNull()
  })

  it('dry-run の件名と本文 (カード番号は末尾 5 桁、走行待ちは載せない)', () => {
    const mail = buildCardRegisterEmail(
      [
        r({ id: 1, kind: 'dry_run_ok', runDate: '2026-11-20' }),
        r({ id: 2, kind: 'failed', detail: '車両が複数一致' }),
        r({ id: 3, kind: 'error', detail: 'timeout' }),
        r({ id: 4, kind: 'expired', runDate: '2026-09-01' }),
      ],
      'dry_run',
      NOW,
    )!
    expect(mail.subject).toBe('[dtako] ETC カード登録 (dry-run) 2026-11-26 登録 0 / dry-run 1 / 失敗 2')
    expect(mail.body.split('\n')).toEqual([
      '【ETC カード追加登録】dry-run (確認画面で停止)',
      'id 1 カード *23333: 確認画面まで (dry-run) 走行日 2026-11-20',
      'id 2 カード *23333: 失敗 — 車両が複数一致',
      'id 3 カード *23333: 通信で失敗 — timeout',
      'id 4 カード *23333: 走行日が古くなったので待ちに戻した 走行日 2026-09-01',
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

describe('buildRunConfirmEmail (確認段)', () => {
  it('複数一致も失敗も無ければ送らない', () => {
    expect(buildRunConfirmEmail([{ id: 1, cardNumber: CARD, kind: 'found', runDate: '2026-11-20' }], null, '2026-11-25')).toBeNull()
  })

  it('複数一致と処理の失敗を載せる (カード番号は末尾 5 桁)', () => {
    const mail = buildRunConfirmEmail(
      [
        { id: 1, cardNumber: CARD, kind: 'multiple', detail: '車両が複数一致 (車輌CD a, b)' },
        { id: 2, cardNumber: CARD, kind: 'none' },
      ],
      'boom',
      '2026-11-25',
    )!
    expect(mail.subject).toBe('[dtako] ETC カードの走行日の確認で要対応 (読取日 2026-11-25)')
    expect(mail.body.split('\n')).toEqual([
      '【ETC カード追加登録】読取日 2026-11-25 の zip 登録時の走行日の確認',
      'id 1 カード *23333: 失敗 — 車両が複数一致 (車輌CD a, b)',
      '走行日の確認が失敗: boom',
    ])
    expect(mail.body).not.toContain(CARD)
  })
})

// 担当アカウント (Refs #1287)。user_id は架空値。
describe('pickCardRegisterAccount', () => {
  const reader = (types: Record<string, string | null | Error>) => async (id: string) => {
    const t = types[id]
    if (t instanceof Error) throw t
    return parseAccountType(t)
  }

  it('並び順で最初の法人を返す (個人は飛ばす、後ろは読まない)', async () => {
    const seen: string[] = []
    const pick = await pickCardRegisterAccount(['a', 'b', 'c'], async (id) => {
      seen.push(id)
      return ({ a: 'personal', b: 'corporate', c: 'corporate' } as const)[id as 'a']
    })
    expect(pick).toEqual({ kind: 'found', userId: 'b' })
    expect(seen).toEqual(['a', 'b'])
  })

  it('前に未記録 (読み取り失敗を含む) が居れば unconfirmed', async () => {
    expect(await pickCardRegisterAccount(['a', 'b'], reader({ a: null, b: 'corporate' }))).toEqual({
      kind: 'unconfirmed',
      userId: 'a',
    })
    expect(await pickCardRegisterAccount(['a', 'b'], reader({ a: 'personal', b: new Error('x') }))).toEqual({
      kind: 'unconfirmed',
      userId: 'b',
    })
  })

  it('全員個人・0 件は none', async () => {
    expect(await pickCardRegisterAccount(['a'], reader({ a: 'personal' }))).toEqual({ kind: 'none' })
    expect(await pickCardRegisterAccount([], reader({}))).toEqual({ kind: 'none' })
  })
})

describe('fetchEtcAccountType', () => {
  function ns(res: Response) {
    const calls: string[] = []
    const n: EtcAccountTypeNamespace = {
      idFromName: (name) => `id:${name}`,
      get: (id) => ({
        fetch: async (url) => {
          calls.push(`${String(id)} ${url}`)
          return res
        },
      }),
    }
    return { n, calls }
  }

  it('etc-{user_id} の DO の種別を読む', async () => {
    const { n, calls } = ns(Response.json({ account_type: 'corporate' }))
    expect(await fetchEtcAccountType(n, 'u1')).toBe('corporate')
    expect(calls).toEqual(['id:etc-u1 https://relay.internal/internal/etc-account-type'])
  })

  it('記録なし・不正な値・null 本文・異常応答は null', async () => {
    expect(await fetchEtcAccountType(ns(Response.json({ account_type: null })).n, 'u')).toBeNull()
    expect(await fetchEtcAccountType(ns(Response.json({ account_type: 'other' })).n, 'u')).toBeNull()
    expect(await fetchEtcAccountType(ns(Response.json(null)).n, 'u')).toBeNull()
    expect(await fetchEtcAccountType(ns(new Response('x', { status: 500 })).n, 'u')).toBeNull()
  })
})

describe('parseAccountType', () => {
  it('personal / corporate だけ通す', () => {
    expect(parseAccountType('personal')).toBe('personal')
    expect(parseAccountType('corporate')).toBe('corporate')
    expect(parseAccountType(undefined)).toBeNull()
  })
})
