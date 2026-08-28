import { describe, it, expect } from 'vitest'

import { describeApiError, describeFetchThrow, describeResponseFailure } from '~/utils/api-error'
import { marginSummarySaveNote } from '~/utils/margin-r2'

describe('describeApiError', () => {
  /** 既定の message は status しか持たない。**理由は upstream の本文にある。** */
  it('本文の error を拾って status と並べる', () => {
    expect(describeApiError({
      statusCode: 503,
      data: { error: '[kintai_push] が無効です (書き先がありません)' },
      message: '[GET] "/api/kyuyo/wage-range": 503',
    })).toBe('503 [kintai_push] が無効です (書き先がありません)')
  })

  it('本文の error が文字列なら message より先に拾う (順序は変えていない)', () => {
    expect(describeApiError({
      statusCode: 503,
      data: { error: 'upstream が落ちています', message: 'Service Unavailable' },
    })).toBe('503 upstream が落ちています')
  })

  it('本文が文字列でも拾う', () => {
    expect(describeApiError({ statusCode: 502, data: 'upstream down' })).toBe('502 upstream down')
  })

  it('data.message / statusMessage にも落ちる', () => {
    expect(describeApiError({ statusCode: 400, data: { message: 'month は YYYY-MM' } }))
      .toBe('400 month は YYYY-MM')
    expect(describeApiError({ statusCode: 401, statusMessage: 'Unauthorized' }))
      .toBe('401 Unauthorized')
  })

  it('status が無ければ理由だけ', () => {
    expect(describeApiError(new Error('Failed to fetch'))).toBe('Failed to fetch')
  })

  it('何も無くても文字列を返す', () => {
    expect(describeApiError(null)).toBe('null')
    // 拾える文言が無ければ String(e) に落ちる (黙って空文字にしない)
    expect(describeApiError({ statusCode: 500, data: {} })).toBe('500 [object Object]')
  })

  /**
   * **`data: null` でも落ちない** (`typeof null === 'object'` なので `!== null` の側で外す)。
   * 本文が空の 502 を返す中継が実在するので、`err.data` が null で来る形は起こりうる。
   */
  it('本文が null でも status に落ちる', () => {
    expect(describeApiError({ statusCode: 502, data: null, message: 'Bad Gateway' }))
      .toBe('502 Bad Gateway')
  })
})

describe('describeApiError — 自前の server/api の日本語 (Refs #890)', () => {
  /**
   * ofetch の `FetchError.message` は HTTP の reason phrase から組まれるので
   * **日本語だけが抜ける**。本文には無傷で残っているので、そちらを読めば元の 1 文になる。
   */
  const message = 'schemaVersion(=2)/ym/totals/cache (ym 一致)/fuelRateOverrides/runCostShareMode が必要です'
  const fetchError = {
    statusCode: 400,
    // reason phrase 由来 — **日本語が消えた**姿 (`一致` と `が必要です` が無い)
    statusMessage: 'schemaVersion(=2)/ym/totals/cache (ym )/fuelRateOverrides/runCostShareMode ',
    message: '[POST] "/api/profit/margin-summary": 400 schemaVersion(=2)/ym/totals/cache (ym )/fuelRateOverrides/runCostShareMode ',
    // JSON 本文 — 日本語が残っている側。**dev の実機 400 から写した形**
    // (`npx wrangler dev` + `POST /api/profit/margin-summary` に形式 1 の body)。
    // ★ `error` は**真偽値**。ここが `??` を使えない理由 (Refs #890)。
    data: { error: true, url: 'http://dtako.ippoan.org/api/profit/margin-summary', statusCode: 400, statusMessage: message, message },
  }

  it('★ 本文の `error` が真偽値でも、`message` の日本語に落ちる', () => {
    // `d.error ?? d.message` だと `true` で止まり、reason phrase 由来の
    // 「日本語が抜けた文」に落ちてしまう。**文字列である最初の 1 つ**を選ぶ。
    expect(fetchError.data.error).toBe(true)
    expect(describeApiError(fetchError)).toContain('が必要です')
  })

  it('画面に出ていた「日本語が抜けた文」が、本文の 1 文に戻る', () => {
    // 直す前 (`e instanceof Error ? e.message : String(e)`) が拾っていたもの
    expect(fetchError.message).not.toContain('一致')
    expect(fetchError.message).not.toContain('が必要です')
    // 直した後
    expect(describeApiError(fetchError)).toBe(`400 ${message}`)
  })

  /**
   * ★ `data.message` を `data.statusMessage` より先に見る順序が効いていること。
   * `H3Error.toJSON()` の経路は **`statusMessage` だけを sanitize** して `message` を
   * 素通しするので、その日が来ても `message` 側から日本語を拾える。
   */
  it('本文の statusMessage が sanitize 済みでも、message から日本語を拾う', () => {
    expect(describeApiError({
      statusCode: 400,
      data: { error: true, statusMessage: 'schemaVersion(=2)/ym/totals/cache (ym )/', message },
    })).toBe(`400 ${message}`)
  })

  /** 合成後の 1 文で読む — 注記に埋め込まれたときに日本語が出ること。 */
  it('保存失敗の注記に、日本語のまま埋め込まれる', () => {
    const note = marginSummarySaveNote(null, describeApiError(fetchError))
    expect(note).toContain(`(400 ${message})`)
    expect(note).toContain('cache (ym 一致)')
    expect(note).toContain('が必要です')
  })
})

/**
 * ★ **理由がどこにも無いとき、status を 2 回書かない** (Refs #900)。
 *
 * 一番星 (`/api/ichiban/**`) はエラー側が素の `StatusCode` で**本文を返さない**。
 * 本番 (h3 = reason phrase が空) では `statusMessage` も空になるので、拾える文字が
 * `err.message` (= ofetch が組んだ `[GET] "…": 503`) しか残らず、`${statusCode}` の
 * 前置とあわせて **`503 [GET] "…": 503`** になっていた。
 *
 * 下の値は**実測から写した形** (`ofetch` を reason phrase 空の 503 に当てて
 * `statusMessage: ""` / `data: ""` / `message: '[GET] "…": 503 '` を確認)。
 */
describe('describeApiError — 理由が 1 つも無いとき (Refs #900)', () => {
  const noReason = {
    statusCode: 503,
    statusMessage: '',
    data: '',
    message: '[GET] "/api/ichiban/api/sales/vehicle-daily?vehicle=101": 503 ',
  }

  it('status が 2 回出ない (method と URL だけ残す)', () => {
    expect(describeApiError(noReason))
      .toBe('503 応答に理由が入っていません (GET /api/ichiban/api/sales/vehicle-daily?vehicle=101)')
    // 直す前に出ていた形 — status が 2 回
    expect(describeApiError(noReason)).not.toContain('": 503')
  })

  /** dev (node = reason phrase あり) では `statusMessage` が勝つ — 挙動を変えない。 */
  it('reason phrase があればそれを使う (dev の HTTP/1.1)', () => {
    expect(describeApiError({ ...noReason, statusMessage: 'Service Unavailable' }))
      .toBe('503 Service Unavailable')
  })

  /** ★ 陰性対照。**手投げの message は畳まない** — status を落とすと情報が減る。 */
  it('ofetch が組んだ形でない message は今までどおり status を前置する', () => {
    expect(describeApiError({ statusCode: 502, data: null, message: '中継が応答しませんでした' }))
      .toBe('502 中継が応答しませんでした')
  })

  /** status が無ければ前置するものが無いので、そもそも二重にならない。 */
  it('statusCode が無ければ message をそのまま返す', () => {
    expect(describeApiError({ message: '[GET] "/api/ichiban/health": 503 ' }))
      .toBe('[GET] "/api/ichiban/health": 503 ')
  })

  /** 本文に理由があれば、そちらが勝つ (proxy が空本文を補った後の姿。Refs #900) */
  it('proxy が補った日本語があれば、そちらを出す', () => {
    expect(describeApiError({
      ...noReason,
      data: { error: '一番星 API が応答しませんでした (/api/sales/vehicle-daily) — 停止か DB 接続プール枯渇の可能性 (一番星が理由を返していません)' },
    })).toBe('503 一番星 API が応答しませんでした (/api/sales/vehicle-daily) — 停止か DB 接続プール枯渇の可能性 (一番星が理由を返していません)')
  })
})

/**
 * `describeResponseFailure` — 生 `fetch` の `Response` から「理由 + 次の一手」の 1 文 (Refs #996)。
 *
 * 直す前の `/vehicle-settings` は `抽出失敗 (401): ${await res.text()}` で、
 * **Nitro のエラー本文 (JSON) をそのまま画面に貼っていた**。ここで固定するのは
 *
 *  1. **本文の JSON がそのまま出ない**こと (陰性対照: `"error":true` を含まない)
 *  2. **status ごとに次の一手が変わる**こと — 401 (ログイン) / 403 (権限) /
 *     404 (対象が無い) / 413 (大きさ) / 5xx (設定・障害) / その他 4xx (送った内容) を
 *     **両側から**固定する。
 *     混ぜると「権限があるのに自分には権限が無い」の逆方向の誤読が出る
 *     (`kyuyo-access.ts` と同じ判断)
 *  3. **「理由が無い」と「理由を読めなかった」を同じ見た目にしない**こと
 *
 * `statusText` は**本番の形 (空)** を使う — `res.statusText` に落ちる実装なら
 * ここで区切り文字の後ろが空になって落ちる。
 */
describe('describeResponseFailure (Refs #996)', () => {
  const RETRY = 'もう一度「設定を抽出」を押してください'

  /** 本番と同じ形の応答 (reason phrase 無し)。 */
  function res(status: number, body: string): Response {
    return new Response(body, { status, statusText: '' })
  }

  /** `requireAuth` が実際に投げる本文 (`@ippoan/auth-client/src/server/auth.mjs`)。
   * `statusMessage` は `'Unauthorized'` 固定で、**日本語の理由は最初から無い**。 */
  const UNAUTHORIZED_BODY = JSON.stringify({
    error: true,
    url: '/api/vehicle-settings/extract',
    statusCode: 401,
    statusMessage: 'Unauthorized',
    message: 'Unauthorized',
  })

  it('401 は「再ログイン」を出す — 本文の JSON は 1 文字も出さない', async () => {
    const s = await describeResponseFailure(res(401, UNAUTHORIZED_BODY), RETRY)
    expect(s).toBe(
      '401 Unauthorized — ログインが切れています。'
      + '再ログインしてからもう一度「設定を抽出」を押してください'
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)',
    )
  })

  /**
   * **陰性対照** — 直す前はここが `{"error":true,…}` の丸ごとだった。
   * 「本文を貼っていない」ことと「次の一手が書いてある」ことを別々に固定する。
   */
  it('401 の本文 JSON を画面に貼らない (陰性対照)', async () => {
    const s = await describeResponseFailure(res(401, UNAUTHORIZED_BODY), RETRY)
    expect(s).not.toContain('"error":true')
    expect(s).not.toContain('statusCode')
    expect(s).toContain('再ログイン')
  })

  /**
   * **401 と 403 を混ぜない。**401 は再ログインで直る / 403 は直らない。
   * 逆に書くと「再ログインすれば見られる」と誤解させる。
   */
  it('403 は権限の話にする (再ログインしても変わらないと書く)', async () => {
    const s = await describeResponseFailure(
      res(403, JSON.stringify({ error: true, statusCode: 403, message: 'Forbidden' })),
      RETRY,
    )
    expect(s).toBe(
      '403 Forbidden — この操作の権限がありません (ログインし直しても変わりません)。'
      + '管理者に許可の追加を依頼してください',
    )
    expect(s).not.toContain('再ログイン')
  })

  /** 5xx は**設定・障害**の話。「権限の問題ではありません」を必ず書く。 */
  it('503 は設定・障害の話にする (権限の話にしない)', async () => {
    const s = await describeResponseFailure(
      res(503, JSON.stringify({
        error: true,
        statusCode: 503,
        statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です',
        message: 'INTERNAL_SHARED_SECRET binding が未設定です',
      })),
      RETRY,
    )
    expect(s).toBe(
      '503 INTERNAL_SHARED_SECRET binding が未設定です — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してからもう一度「設定を抽出」を押してください',
    )
  })

  /**
   * ★ **404 は「その他 4xx」に落とさない** (Refs #1005 #1021)。
   *
   * `/vehicle-settings/history` と `<VehicleSettingsDumpPicker>` は、一覧の行を
   * **クリックしただけ**で `object.get.ts` の 404 を受け取る。「送った内容を直せ」に
   * 落ちると**何も送っていない人に直せないものを直させる**ので、
   * 「対象がもう無い」と書いて画面ごとの `retry` に繋ぐ。
   *
   * **これは #1005 の暫定 (呼び出し側の `if (res.status === 404)`) を畳んだ恒久策**で、
   * 理由の半分は**本文から読む** (暫定は本文を読まず自分で書いていた)。
   */
  it('404 は「指した対象がもう無い」話にする', async () => {
    const s = await describeResponseFailure(
      res(404, JSON.stringify({
        error: true,
        statusCode: 404,
        message: 'object not found: vehicle-settings/4437/20260514_093253-0-0-4437.json',
      })),
      RETRY,
    )
    expect(s).toBe(
      '404 object not found: vehicle-settings/4437/20260514_093253-0-0-4437.json — '
      + '指していた対象がサーバにもう存在しません。'
      + '画面の情報が古くなっているので、もう一度「設定を抽出」を押してください',
    )
  })

  /** **陰性対照** — 「その他 4xx」の文言を 404 に流用していたら、ここで落ちる。
   * 401 / 403 / 413 / 5xx の文言の混入も同時に見る。 */
  it('404 に「その他 4xx」「再ログイン」「権限」の文言を混ぜない (陰性対照)', async () => {
    const s = await describeResponseFailure(
      res(404, JSON.stringify({ error: true, statusCode: 404, message: 'object not found: x' })),
      RETRY,
    )
    expect(s).not.toContain('送った内容')
    expect(s).not.toContain('直してから')
    expect(s).not.toContain('再ログイン')
    expect(s).not.toContain('権限')
    expect(s).not.toContain('ファイル')
    // 陽性対照 — 「もう無い」と、画面ごとのやり直し方は残っていること。
    expect(s).toContain('もう存在しません')
    expect(s).toContain(RETRY)
  })

  it('413 はファイルの大きさの話にする', async () => {
    const s = await describeResponseFailure(
      res(413, JSON.stringify({
        error: true,
        statusCode: 413,
        message: 'zip が大きすぎます (6000000 bytes, max 5242880)',
      })),
      RETRY,
    )
    expect(s).toBe(
      '413 zip が大きすぎます (6000000 bytes, max 5242880) — '
      + '送ったファイルがサーバの上限を超えています。'
      + '小さいファイルにしてからもう一度「設定を抽出」を押してください',
    )
  })

  it('その他の 4xx は「送った内容」の話にする', async () => {
    const s = await describeResponseFailure(
      res(400, JSON.stringify({
        error: true,
        statusCode: 400,
        message: 'field "file" に zip を添付してください',
      })),
      RETRY,
    )
    expect(s).toBe(
      '400 field "file" に zip を添付してください — '
      + '送った内容をサーバが受け付けませんでした。'
      + '上の理由のとおりに直してからもう一度「設定を抽出」を押してください',
    )
  })

  /**
   * **「理由が無い」/「JSON ではない」/「JSON だが理由の文字列が無い」は別々の文。**
   * 1 つにまとめると「サーバは何も言っていない」と誤読される
   * (`statusText` に落とすと**本番は空**なので区切り文字の後ろが消える)。
   */
  it('本文が空・JSON でない・理由の文字列が無い を撃ち分ける', async () => {
    expect(await describeResponseFailure(res(500, ''), RETRY))
      .toBe('500 (応答本文が空でした) — サーバ側の設定か障害です (権限の問題ではありません)。'
        + '復旧してからもう一度「設定を抽出」を押してください')
    expect(await describeResponseFailure(res(502, '<html>Bad Gateway</html>'), RETRY))
      .toBe('502 (応答が JSON ではありません: <html>Bad Gateway</html>) — '
        + 'サーバ側の設定か障害です (権限の問題ではありません)。'
        + '復旧してからもう一度「設定を抽出」を押してください')
    expect(await describeResponseFailure(res(500, '{}'), RETRY))
      .toBe('500 (本文に理由の文字列がありません: {}) — '
        + 'サーバ側の設定か障害です (権限の問題ではありません)。'
        + '復旧してからもう一度「設定を抽出」を押してください')
  })

  /** 本文が JSON の**文字列**・数値・null でも落ちない (中継が返す形)。 */
  it('本文が JSON の文字列 / 数値 / null でも撃ち分ける', async () => {
    expect(await describeResponseFailure(res(502, '"upstream down"'), RETRY))
      .toContain('502 upstream down — ')
    expect(await describeResponseFailure(res(502, '""'), RETRY))
      .toContain('502 (本文に理由の文字列がありません: "")')
    expect(await describeResponseFailure(res(502, '42'), RETRY))
      .toContain('502 (本文に理由の文字列がありません: 42)')
    expect(await describeResponseFailure(res(502, 'null'), RETRY))
      .toContain('502 (本文に理由の文字列がありません: null)')
  })

  /** 長い本文は 120 字で切る (画面を本文で埋めない)。 */
  it('JSON でない本文は 120 字で切る', async () => {
    const s = await describeResponseFailure(res(502, 'x'.repeat(300)), RETRY)
    expect(s).toContain(`(応答が JSON ではありません: ${'x'.repeat(120)})`)
    expect(s).not.toContain('x'.repeat(121))
  })

  /** `retry` は画面ごとに違う (理由は共通・やり直し方は画面ごと)。 */
  it('やり直し方は呼び出し側から受け取る', async () => {
    const s = await describeResponseFailure(res(401, UNAUTHORIZED_BODY), '「再取得」を押してください')
    expect(s).toContain('再ログインしてから「再取得」を押してください')
  })

  /** 本文が読めない (`res.text()` が投げる) 場合も「空」に倒して落ちない。 */
  it('本文が読めなくても落ちない', async () => {
    const broken = { status: 500, text: async () => { throw new Error('stream error') } } as unknown as Response
    expect(await describeResponseFailure(broken, RETRY)).toContain('500 (応答本文が空でした) — ')
  })
})

describe('describeFetchThrow — fetch 自体が throw したとき (Refs #1006)', () => {
  /**
   * 本番実測 (2026-08-28): Access が切れると **cross-origin へ 302** が返り、
   * `fetch` は追随先を返せず `TypeError` を投げる。`res` を見るコードには
   * 1 行も到達しないので、直す場所は `catch` 側しかない。
   */
  it('TypeError なら「どちらか」と書き、やることを 1 つだけ出す', () => {
    const s = describeFetchThrow(new TypeError('Failed to fetch'))
    expect(s).toBe(
      'サーバに接続できませんでした。'
      + 'ログインが切れているか、ネットワークが繋がっていないかのどちらかです'
      + ' (ブラウザからは区別できません)。'
      + 'ページを再読み込みしてください'
      + ' — ログインが切れていた場合はログイン画面が出ます。'
      + 'ネットワークが原因のときは同じ表示のままです。',
    )
  })

  /** ★ 断定しないことが本体 (陰性対照)。どちらか一方に倒したら落ちる。 */
  it('認証切れともネットワーク断とも断定しない (陰性対照)', () => {
    const s = describeFetchThrow(new TypeError('Failed to fetch')) ?? ''
    // 「切れました」「切れています」と言い切る形が入っていないこと
    expect(s).not.toContain('ログインが切れました')
    expect(s).not.toContain('ログインが切れています')
    expect(s).not.toContain('ネットワークが切れています')
    expect(s).not.toContain('再ログインしてください')
    // 両方を挙げていること + 区別できないと明示していること
    expect(s).toContain('ログインが切れているか')
    expect(s).toContain('ネットワークが繋がっていないか')
    expect(s).toContain('どちらか')
    expect(s).toContain('区別できません')
    // やることは 1 つだけ (再読み込み)
    expect(s).toContain('ページを再読み込みしてください')
  })

  /**
   * ★ `e.message` の文字列一致で判定していないこと。文言はブラウザごとに違う
   * (Chrome `Failed to fetch` / Firefox `NetworkError when attempting to fetch resource.`)。
   */
  it('message の文言が違っても同じ文になる (Chrome / Firefox / 空)', () => {
    const chrome = describeFetchThrow(new TypeError('Failed to fetch'))
    expect(describeFetchThrow(new TypeError('NetworkError when attempting to fetch resource.')))
      .toBe(chrome)
    expect(describeFetchThrow(new TypeError(''))).toBe(chrome)
  })

  /** TypeError 以外は当てない — 呼び出し側の既存の文言をそのまま残す。 */
  it('TypeError でなければ null (既存の振る舞いを変えない)', () => {
    expect(describeFetchThrow(new Error('API エラー (503): upstream down'))).toBeNull()
    expect(describeFetchThrow({ statusCode: 401 })).toBeNull()
    expect(describeFetchThrow(null)).toBeNull()
    expect(describeFetchThrow('Failed to fetch')).toBeNull()
  })
})
