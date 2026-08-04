/**
 * 突合明細の行 (driver_cd + date) から、その日の運行一覧を引いた結果の表示用
 * pure ロジック (Refs #633-17)。
 *
 * `GET /restraint-api/kintai/day-operations` (relay
 * `dtako-scraper-relay-do.ts` の `handleKintaiDayOperationsList`、中身は
 * `dtako-day-operations-list.ts`) の応答をそのまま読む。**新しい判定はしない**
 * — 運行が複数あっても自動で1件を選ばない (`day-events-lookup` の ambiguous を
 * 自動で選ばないのと同じ理由)。全部並べて人に選ばせる。
 *
 * すべて `unknown` を受けて防御的に読む (root `npm install` が通らず front は CI
 * が初検証のため、実行時前提を増やさない — CLAUDE.md の規範)。
 */

export interface KintaiDayOperation {
  unkoNo: string
  /** alc へ上げ直すのに使う22桁 (上流の `zip_request.ope_no` をそのまま)。 */
  opeNo: string
  /** alc へ上げ直すのに使う出庫日時 (上流の `zip_request.start_ope` をそのまま)。 */
  startOpe: string
  runStart: string | null
  vehicle: string | null
}

export interface KintaiDayOperationsResult {
  driverCd: string | null
  date: string | null
  operations: KintaiDayOperation[]
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

const UNKO_NO_23_RE = /^\d{23}$/

/** `unkoNo` が③ (勤務時間再登録、`resetby-unko-no`) に使える23桁 (対象CD込み) か。
 * relay 側 (`pickDayOperationsList`) は既に23桁だけを通しているはずだが、front は
 * 応答を信用せず自前で確認する (CLAUDE.md の防御的読み取り方針)。22桁のまま
 * ③へ渡すと「別の乗務員の行を消しかねない」ため、ボタンの活性判定に使う。 */
export function isKintaiDayOperationUnkoNo23Digit(unkoNo: string): boolean {
  return UNKO_NO_23_RE.test(unkoNo)
}

/** ohishi-dev の旅費行 (運行1件) 詳細画面へのリンク (Refs #633-27)。URL キーは
 * オンプレの23桁そのものなので、22桁 (対象CD無し) では別運行/存在しない行を指しうる
 * — `isKintaiDayOperationUnkoNo23Digit` と同じガードで23桁以外は `null` にする。 */
export function kintaiDayOperationRyohiRowsUrl(unkoNo: string): string | null {
  if (!isKintaiDayOperationUnkoNo23Digit(unkoNo)) return null
  return `http://ohishi-dev.ohishi.local/ryohi-rows/view/${unkoNo}`
}

/** `GET /restraint-api/kintai/day-operations` の応答を読む。壊れた形は空配列に
 * 倒す (捏造しない) — 呼び出し側は「運行がありません」と「読めなかった」を
 * 混同しないよう、この関数の戻り値ではなく呼び出し元の try/catch で区別する。 */
export function parseKintaiDayOperations(raw: unknown): KintaiDayOperationsResult {
  const r = (raw ?? {}) as Record<string, unknown>
  const opsRaw = Array.isArray(r.operations) ? r.operations : []
  const operations: KintaiDayOperation[] = []
  for (const op of opsRaw) {
    if (op == null || typeof op !== 'object') continue
    const o = op as Record<string, unknown>
    const unkoNo = typeof o.unko_no === 'string' ? o.unko_no : ''
    const opeNo = typeof o.ope_no === 'string' ? o.ope_no : ''
    const startOpe = typeof o.start_ope === 'string' ? o.start_ope : ''
    if (!unkoNo || !opeNo || !startOpe) continue
    operations.push({
      unkoNo,
      opeNo,
      startOpe,
      runStart: toStringOrNull(o.run_start),
      vehicle: toStringOrNull(o.vehicle),
    })
  }
  return {
    driverCd: toStringOrNull(r.driver_cd),
    date: toStringOrNull(r.date),
    operations,
  }
}
