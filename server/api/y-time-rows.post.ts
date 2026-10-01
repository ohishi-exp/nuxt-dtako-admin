/**
 * Y時間 の行を JSON で返す (Refs #1133 c1133-47)。
 *
 * POST /api/y-time-rows  body `{ driver_cd, from, to }`
 *   200 — `{ source, source_reason, rows, warnings, excluded, missing_months, driver?, period? }`
 *   400 — `driver_cd` / `from` / `to` のどれかが無い
 *   401 — 未ログイン (`requireAuth`)
 *   403 — role が admin / payroll でない
 *   503 — INTERNAL_SHARED_SECRET binding 未設定
 *   それ以外 — `server/utils/y-time-rows.ts` が投げた失敗をそのまま
 *
 * 呼ぶのは訴訟準備のエラータブの「検知を実行」と、Y時間 のページのプレビュー (どちらもブラウザ)。
 * **行は Excel を作る `POST /api/y-time-export` と同じ util (`fetchYTimeRows`) が作る** — 元 (勤怠の
 * 勤務の記録 / 運行)・倒し方・1 社固定の認可・失敗の形は util が持ち、ここは呼んで返すだけ。
 * 行の規則・休憩の配り方・時間の計算は 1 行も無い。
 *
 * ## なぜ server route か
 *
 * 勤怠の元の行は relay (`POST /kintai-relay/y-time-shifts`) を通る。relay は共有 secret を要求し、
 * ブラウザは secret を持てないので、勤怠の元の行は必ずこの口を通る。
 * relay へ渡す tenant は認証結果の値で、body に `tenant_id` を入れても読まない。
 *
 * ## `driver` / `period` は運行の元だけ
 *
 * 勤怠の元の応答には乗務員の名前も期間も無い。**補って在るように見せない** — 画面は、名前を
 * 自分の乗務員の一覧から、期間を自分の入力から出す。
 */

import { defineEventHandler, readBody } from 'h3'
import { authorizeScraperRelay } from '../utils/scraper-relay'
import { fetchYTimeRows, yTimeRowsInputFromBody } from '../utils/y-time-rows'

export default defineEventHandler(async (event) => {
  // **body を読む前・relay と上流を叩く前に認証する。**
  const auth = await authorizeScraperRelay(event)
  const input = yTimeRowsInputFromBody(await readBody<unknown>(event))
  const result = await fetchYTimeRows(event, input, auth)
  return {
    source: result.source,
    source_reason: result.sourceReason,
    rows: result.rows,
    warnings: result.warnings,
    excluded: result.excluded,
    missing_months: result.missingMonths,
    driver: result.driver,
    period: result.period,
  }
})
