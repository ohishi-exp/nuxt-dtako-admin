/**
 * Y時間 Excel 追記エクスポート (Cloudflare Worker 上で実行される Nitro server route)。
 *
 * 1. body から `{ driver_cd, from, to, template_key }` を受け取る
 * 2. Y時間 の行を取る (`server/utils/y-time-rows.ts` の `fetchYTimeRows`)。元は 2 つ:
 *    勤怠の勤務の記録 (下の「行の元」) と、運行 (rust-alc-api `/api/dtako/y-time-export` を
 *    auth-worker `/alc-proxy` 経由で GET)。**どちらの元か・倒し方・1 社固定の認可・失敗の形は
 *    util が持つ** — ここには書かない
 * 3. R2 binding (`env.DTAKO_R2`) でテンプレ xlsx を fetch
 * 4. ExcelJS で Y時間 シートに書き込み
 * 5. xlsx binary を octet-stream で return
 *
 * R2 binding がない (ローカル `nuxt dev` 等) 環境では明示的に 503 を返す。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * **ここは D 段 (認可ゼロ) ではなく B 段だった** — `alcProxyFetch` が browser JWT を
 * cookie / `Authorization: Bearer` から拾って転送し、上流の auth-worker `/alc-proxy`
 * が **token 不在を fail-closed で 401 にする** (`ippoan/auth-worker@dd220b2`
 * `src/handlers/alc-proxy.ts` の `if (!token) return jsonError(401, "Unauthorized")`)。
 * `X-Alc-Proxy-Secret` は consumer proof であって身元ではないので、secret だけでは
 * 通らない。**`/api/ichiban/**` (Service Token を無条件に付け、呼び出し元の身元を
 * 一切見ない) とは型が違う** — 誤読しやすいのでここに書いておく。
 *
 * **⇒ ここは無防備ではなく、`requireAuth` を入れる前も xlsx は無認証の呼び出し元には
 * 返っていない** (上流 401 がそのまま `createError({statusCode: apiRes.status})` で
 * 返り、R2 のテンプレ取得にも到達しない)。「開いていたので塞いだ」とは書かないこと。
 *
 * それでも A 段に上げる: **B 段の防御は上流の実装依存**で、この repo からは
 * 保証できない (`docs/plan-922-single-signin.md` §1 が `/api/ichiban/**` の項で
 * 書いている性質と同じ)。Nitro 側で確定させれば、上流が変わっても規約が残る。
 * ここが返す xlsx は**乗務員 1 人の日別 拘束/運転/休憩 の実データ**なので、
 * 「Access を通れる誰か」ではなく「ログインしている人」に限る。
 * 呼ぶのは Y時間 のページ (`/y-time-export`) と訴訟準備の出力タブ (`/litigation`) の
 * **ブラウザだけ**で、relay / cron / service binding からの呼び出しは無い (`git grep` で確認)。
 *
 * 前置き (secret の解決 → `requireAuth` → role の確認) は `server/utils/scraper-relay.ts` の
 * `authorizeScraperRelay` 1 本 (行を JSON で返す `y-time-rows.post.ts` と同じ)。ここに写しを持たない。
 *
 * **書き口 (`y-time-template.put.ts`) と読み口 (`y-time-template.get.ts`) が
 * 認証を要求するのに、テンプレを使って出力する側だけ素通し**、という食い違いも
 * ここで解消する。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   403 — role が admin / payroll でない
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_R2 binding 未設定
 *
 * ## `period_rewrite` (訴訟準備の出力タブ、Refs #1133 c1133-2)
 *
 * `true` のときだけ、テンプレの対象期間 (`要素!F3`/`I3`・Y時間 A 列・`月所!B6`) を
 * body の `from`/`to` に振り直す (`writeYTimeRows` の `period`)。無指定の呼び出し
 * (`/y-time-export` ページ) は今までどおりテンプレ自前の期間を使う。
 * **意味はこれだけ** — 行の元はこの欄で変わらない (下の「行の元」)。
 *
 * ## 件数ヘッダ (`x-y-time-rows` / `-missing-count` / `-warnings-count`)
 *
 * `x-y-time-missing-dates` は先頭 30 件、`x-y-time-warnings` は先頭 5 件で切るので、
 * **切った後の件数だけ見ると「全部で何件か」が読めない**。本当の件数を別に載せる。
 * `x-y-time-rows` は上流が返した行数 (元に関わらず)。**0 が何の 0 件かは元で違う** —
 * 運行の元なら「その期間に運行が無い」、勤怠の元なら「行を作れた勤務が無い」
 * (`x-y-time-source` と `-excluded-reasons` を合わせて画面が言い分ける。
 * 404 = 乗務員CD が alc に無い、とは別物)。
 *
 * ## 行の元 (`x-y-time-source` ほか、Refs #1133 c1133-46 / c1133-47)
 *
 * **どの呼び出しも**、勤怠の勤務の記録 (wage report と同じ元) から行を作る — 訴訟準備の出力も
 * Y時間 のページも同じ。運行 (デジタコ) から作るのは、util が倒す 3 つの形のときだけ
 * (勤怠の記録が無い会社・勤怠の設定が無い環境)。同じページのプレビュー (`POST /api/y-time-rows`) も
 * 同じ util を通るので、Excel とプレビューで元が食い違わない。
 * どの元で作ったかと、行を作れなかった勤務・勤務の記録の無い月は応答ヘッダで返す
 * (`yTimeSourceHeaders`。値は ASCII の決まった語だけ)。
 *
 * ## 上流の 404 だけ `data.upstream = 'alc'` を付ける
 *
 * 404 は 2 か所から出る: 運行の経路の上流 (`driver_cd not found`、alc の NotFound はこれだけ) と、
 * R2 にテンプレが無いとき。**画面が「乗務員CD が alc に未登録」と言ってよいのは前者だけ**
 * なので、上流由来のエラーに印を付けて区別させる (本文の文言で当てない)。
 * 印を付けるのは util の運行の経路だけで、勤怠の経路の失敗には付かない。
 */

import {
  defineEventHandler,
  readBody,
  createError,
  setResponseHeader,
} from 'h3'
import { writeYTimeRows, buildFilename } from '~/utils/y-time-xlsx'
import { cfEnv } from '../utils/cf-env'
import { authorizeScraperRelay } from '../utils/scraper-relay'
import { fetchYTimeRows, yTimeRowsInputFromBody, yTimeSourceHeaders } from '../utils/y-time-rows'

interface RequestBody {
  driver_cd: string
  from: string
  to: string
  template_key: string
  /** true のときだけテンプレの期間を from/to に振り直す (Refs #1133 c1133-2) */
  period_rewrite?: boolean
}

interface R2ObjectMinimal {
  arrayBuffer(): Promise<ArrayBuffer>
}
interface R2BucketMinimal {
  get(key: string): Promise<R2ObjectMinimal | null>
}
interface CloudflareEnv {
  DTAKO_R2?: R2BucketMinimal
}

export default defineEventHandler(async (event) => {
  // **body を読む前・上流を叩く前に認証する。**
  const auth = await authorizeScraperRelay(event)

  const body = await readBody<RequestBody>(event)
  // body が object でない・3 欄のどれかが無いときはここで 400 (この先の `body` は object)
  const input = yTimeRowsInputFromBody(body)
  const templateKey = body.template_key
  if (typeof templateKey !== 'string' || !templateKey.startsWith('templates/')) {
    throw createError({
      statusCode: 400,
      statusMessage: 'template_key must start with "templates/"',
    })
  }
  const periodRewrite = body.period_rewrite === true

  // 1. Y時間 の行。relay へ渡す tenant は認証結果の値 (利用者の body からは取らない)。
  const data = await fetchYTimeRows(event, input, auth)

  // 2. R2 binding でテンプレ取得
  // nitro-cloudflare-pages / cloudflare-module で `event.context.cloudflare.env` に bindings が入る
  const r2 = cfEnv<CloudflareEnv>(event).DTAKO_R2
  if (!r2) {
    throw createError({
      statusCode: 503,
      statusMessage:
        'R2 binding (DTAKO_R2) not available. Deploy via wrangler or set up local R2 binding.',
    })
  }
  const tplObj = await r2.get(templateKey)
  if (!tplObj) {
    throw createError({
      statusCode: 404,
      statusMessage: `template not found in R2: ${templateKey}`,
    })
  }
  const tplBytes = await tplObj.arrayBuffer()

  // 3. xlsx 生成 — 期間内の旧データを書き込み前にクリアして、テンプレ汚染を除去する
  const result = await writeYTimeRows(tplBytes, data.rows, {
    clearPeriod: { from: input.from, to: input.to },
    ...(periodRewrite ? { period: { from: input.from, to: input.to } } : {}),
  })

  setResponseHeader(event, 'x-y-time-rows', String(data.rows.length))
  setResponseHeader(event, 'x-y-time-missing-count', String(result.missingDates.length))
  setResponseHeader(event, 'x-y-time-warnings-count', String(data.warnings.length))

  if (result.missingDates.length > 0) {
    // dev でデバッグしやすいよう warning header にも入れる (本文 binary なので)
    setResponseHeader(
      event,
      'x-y-time-missing-dates',
      result.missingDates.slice(0, 30).join(','),
    )
  }
  if (data.warnings.length > 0) {
    setResponseHeader(
      event,
      'x-y-time-warnings',
      // ASCII safe にだけ落とす (ヘッダーに日本語を直接入れると 500 になる ので URI encode)
      encodeURIComponent(data.warnings.slice(0, 5).join(' / ')),
    )
  }
  for (const [name, value] of Object.entries(yTimeSourceHeaders(data))) setResponseHeader(event, name, value)

  // 4. response
  setResponseHeader(
    event,
    'content-type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  setResponseHeader(
    event,
    'content-disposition',
    `attachment; filename="${buildFilename(input.driverCd, input.from, input.to)}"`,
  )
  return result.bytes
})
