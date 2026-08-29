import { describe, it, expect } from 'vitest'

import { describeApiError, describeCaughtError, describeFetchThrow, describeResponseFailure, pickBodyReason } from '~/utils/api-error'
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
      + ' — ログインが切れていた場合はログイン画面に移ります。'
      + '移らないときはネットワークの側を確認してください。',
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
    // ★ 初稿の「ネットワークが原因のときは同じ表示のままです」は**実機で偽と分かった**
    // (CDP `offline:true` で再読み込みすると ERR_INTERNET_DISCONNECTED の画面になる)。
    // 画面と API は同一オリジンなので、繋がっていなければページ自体が出ない。
    expect(s).not.toContain('同じ表示のまま')
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

/**
 * `pickBodyReason` — **parse 済みの本文から理由の 1 文を拾う** (Refs #1050)。
 *
 * `describeApiError` が `err.data` に対してやっている選び方だけを切り出したもの。
 * ここで固定するのは **順序が `[error, message, statusMessage]` であること**と、
 * **`statusMessage` しか無い応答が今までどおり出ること** (陽性対照) の 2 つ。
 *
 * 直す前の front 4 経路は `statusMessage` を先に読んでいたので、server route が
 * ASCII を `statusMessage`・日本語を `message` に置く形 (**`statusMessage` に日本語を
 * 入れると本番 workerd で reason phrase が壊れるので、server 側では直せない**。
 * #1032 / #886) だと**画面に ASCII だけが出ていた**。
 */
describe('pickBodyReason (Refs #1050)', () => {
  /** `requireRole` 系の 403 の実物の形 — ASCII が `statusMessage`、日本語が `message`。 */
  const FORBIDDEN_BODY = {
    error: true,
    url: '/api/kyuyo-master/refresh',
    statusCode: 403,
    statusMessage: 'requires one of roles: kyuyo, admin',
    message: 'この操作には kyuyo または admin の権限が必要です',
  }

  it('日本語の message を ASCII の statusMessage より先に拾う', () => {
    expect(pickBodyReason(FORBIDDEN_BODY)).toBe('この操作には kyuyo または admin の権限が必要です')
  })

  /** **陰性対照** — 直す前の順序 (`statusMessage` 先) で出ていた ASCII が 1 文字も出ない。 */
  it('ASCII の statusMessage は出ない (陰性対照)', () => {
    expect(pickBodyReason(FORBIDDEN_BODY)).not.toContain('requires one of roles')
  })

  /**
   * ★★ **陽性対照** — `statusMessage` しか無い応答は**これまでどおり `statusMessage`**。
   * 「日本語を出す」直しで**英文しか無いときに理由がゼロになる**と、直す前より悪い。
   * `requireAuth` (`@ippoan/auth-client`) の 401 は `statusMessage: 'Unauthorized'` 固定で
   * **日本語の理由が最初から存在しない**ので、この道は実際に通る。
   */
  it('statusMessage しか無ければ statusMessage を出す (陽性対照)', () => {
    expect(pickBodyReason({ statusCode: 401, statusMessage: 'Unauthorized' })).toBe('Unauthorized')
    expect(pickBodyReason({ error: true, statusCode: 503, statusMessage: 'R2 binding (DTAKO_R2) not available' }))
      .toBe('R2 binding (DTAKO_R2) not available')
  })

  /** upstream proxy が passthrough する `{ error: '…' }` (文字列) は先頭で拾う。 */
  it('error が文字列なら message より先に拾う', () => {
    expect(pickBodyReason({ error: 'upstream が落ちています', message: 'Service Unavailable' }))
      .toBe('upstream が落ちています')
  })

  /** Nitro の既定の本文は `error` が**真偽値**。`??` だとここで止まって日本語に届かない。 */
  it('error が真偽値なら飛ばす (`??` では拾えない形)', () => {
    expect(pickBodyReason({ error: true, message: '日本語の理由' })).toBe('日本語の理由')
    expect(pickBodyReason({ error: false, statusMessage: 'Bad Request' })).toBe('Bad Request')
  })

  it('本文が文字列ならそれ自体が理由 (空文字は理由ではない)', () => {
    expect(pickBodyReason('upstream down')).toBe('upstream down')
    expect(pickBodyReason('')).toBeNull()
  })

  /** 拾えなかったときの代替 (`HTTP ${status}` 等) は**呼び出し側**が決める。 */
  it('理由が無ければ null (代替文を作らない)', () => {
    expect(pickBodyReason({})).toBeNull()
    expect(pickBodyReason({ error: true, statusCode: 500 })).toBeNull()
    expect(pickBodyReason(null)).toBeNull()
    expect(pickBodyReason(undefined)).toBeNull()
    expect(pickBodyReason(502)).toBeNull()
  })

  /**
   * ★ **順序の正本は `describeApiError`。** 片方だけ直すと #1050 と同じ形の欠陥に戻るので、
   * 同じ本文を両方に当てて**理由の文字列が一致する**ことを固定する
   * (`describeApiError` は `${statusCode} ` を前置するので、そこだけ剥がして比べる)。
   */
  it('describeApiError と同じ順序で拾う (二重管理の見張り)', () => {
    const bodies: Record<string, unknown>[] = [
      FORBIDDEN_BODY,
      { error: 'upstream が落ちています', message: 'Service Unavailable', statusMessage: 'Service Unavailable' },
      { error: true, message: '日本語の理由', statusMessage: 'ASCII reason' },
      { statusMessage: 'Unauthorized' },
    ]
    for (const data of bodies) {
      expect(describeApiError({ statusCode: 400, data })).toBe(`400 ${pickBodyReason(data)}`)
    }
  })
})

/**
 * `describeCaughtError` — **catch した例外**に「次に何をすればいいか」を足す (Refs #1008)。
 *
 * 3 つの枝を**それぞれ 1 本以上**で固定する。とくに 3 番目 (**status が読めない**) は
 * 「**次の一手を付けない = 現状維持**」が仕様なので、**付かないこと**を陰性対照で書く
 * — ここが空文字や例外に倒れると、画面から理由ごと消える。
 */
describe('describeCaughtError (Refs #1008)', () => {
  const RETRY = '「集計」を押してください'

  // --- 枝 1: transport failure (fetch 自体が throw した) ---------------------

  it('枝1 — TypeError は describeFetchThrow の 1 文に retry を足す', () => {
    const out = describeCaughtError(new TypeError('Failed to fetch'), RETRY)
    // 元の 1 文は 1 文字も削らない (切り分けの手順がそこにしか無い)。
    expect(out.startsWith(describeFetchThrow(new TypeError('x'))!)).toBe(true)
    expect(out.endsWith('繋がったあとで「集計」を押してください')).toBe(true)
  })

  it('枝1 — status の話は混ぜない (陰性対照)', () => {
    // `Response` が 1 つも得られていないので status は存在しない。
    // 「ログインが切れています」と断定する 401 の文型を混ぜないこと。
    // **`' — '` では見ない** — `describeFetchThrow` の 1 文が自前で使っている
    // (`ページを再読み込みしてください — ログインが切れていた場合は…`)。
    // 見るのは `nextStepForStatus` が出す文型そのもの。
    const out = describeCaughtError(new TypeError('Failed to fetch'), RETRY)
    expect(out).not.toContain('ログインが切れています。')
    expect(out).not.toContain('この操作の権限がありません')
    expect(out).not.toContain('送った内容をサーバが受け付けませんでした')
    expect(out).not.toContain('サーバ側の設定か障害です')
  })

  // --- 枝 2: status が分かる -------------------------------------------------

  it('枝2 — ofetch の FetchError は statusCode から読む', () => {
    expect(describeCaughtError({
      statusCode: 503,
      data: { error: '[kintai_push] が無効です' },
      message: '[GET] "/api/kyuyo/wage-range": 503',
    }, RETRY)).toBe(
      '503 [kintai_push] が無効です — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。復旧してから「集計」を押してください')
  })

  it('枝2 — createAuthFetch の素の Error は message の `(3桁): ` から読む', () => {
    // `app/utils/api.ts` の `request()` 経路。`statusCode` も `data` も持たない。
    expect(describeCaughtError(
      new Error('API エラー (401): {"error":"Unauthorized"}'), RETRY)).toBe(
      'API エラー (401): {"error":"Unauthorized"} — '
      + 'ログインが切れています。再ログインしてから「集計」を押してください'
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)')
  })

  it('枝2 — errorLabel を決め打ちしない (上流の既定 `API error` でも読む)', () => {
    // `errorLabel` は `createAuthFetch` の option。`'API エラー'` は
    // この repo が渡している値でしかない (`app/utils/api.ts`)。
    for (const label of ['API エラー', 'API error', 'alc']) {
      expect(describeCaughtError(new Error(`${label} (403): {}`), RETRY))
        .toContain('この操作の権限がありません')
    }
  })

  it('枝2 — statusCode を message より先に見る', () => {
    // 上流が `statusCode` を載せるようになったら、そちらが勝つ。
    expect(describeCaughtError(
      { statusCode: 404, message: 'API エラー (500): x' }, RETRY))
      .toContain('指していた対象がサーバにもう存在しません')
  })

  // --- 枝 3: status が読めない = 現状維持 ------------------------------------

  it('枝3 — status が読めないときは describeApiError そのまま (次の一手を付けない)', () => {
    const e = new Error('タイムアウトしました')
    expect(describeCaughtError(e, RETRY)).toBe(describeApiError(e))
  })

  it('枝3 — 陰性対照: 外れても空文字にも例外にもしない / 「次の一手」だけが付かない', () => {
    // ★ 上流が `errorLabel` に括弧を入れたときの形。`AUTH_FETCH_ERROR_MESSAGE` は
    //   当たらなくなるが、**理由の 1 文はそのまま残る**のがこの実装の要点。
    const e = new Error('API (v2) エラー (503): {"error":"落ちています"}')
    const out = describeCaughtError(e, RETRY)
    expect(out).toBe('API (v2) エラー (503): {"error":"落ちています"}')
    expect(out).not.toBe('')
    expect(out).not.toContain('「集計」を押してください')
    expect(out).not.toContain(' — ')
  })

  it('枝3 — message が文字列でない / 例外が null でも落ちない', () => {
    expect(describeCaughtError({ message: 500 }, RETRY)).toBe(describeApiError({ message: 500 }))
    expect(describeCaughtError(null, RETRY)).toBe(describeApiError(null))
    expect(describeCaughtError(undefined, RETRY)).toBe(describeApiError(undefined))
  })

  it('枝3 — 3 桁でない数字は status として読まない', () => {
    // `(12): ` / `(1234): ` に当てて 12 や 123 を status にしない。
    expect(describeCaughtError(new Error('API エラー (12): x'), RETRY)).toBe('API エラー (12): x')
    expect(describeCaughtError(new Error('API エラー (1234): x'), RETRY)).toBe('API エラー (1234): x')
  })

  it('本文の中に `(404): ` が現れても先頭の status を使う (行頭固定)', () => {
    expect(describeCaughtError(
      new Error('API エラー (500): upstream said "API エラー (404): no"'), RETRY))
      .toContain('サーバ側の設定か障害です')
  })
})
