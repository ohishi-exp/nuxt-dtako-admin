/**
 * 運行1件をalcへ上げ直した結果の表示用 pure ロジック (Refs #633-17)。
 *
 * `POST /restraint-api/kintai/alc-upload` (relay `dtako-scraper-relay-do.ts`
 * の `handleKintaiAlcUpload`、実処理は既存の `/cron/dtako/alc-upload` /
 * `runDtakoAlcUploadJob` をそのまま呼ぶ) の応答は `DtakoAlcUploadReport`
 * (`dtako-alc-upload.ts`) と同じ形 — **新しい判定はしない**、応答をそのまま
 * 読むだけ。
 *
 * ★ `split_confirmed` は常に `false`。`split_failed: 0` を「分割済み」と
 * 読まない — `notes.split` をそのまま表示するのが安全 (親判断4)。
 *
 * すべて `unknown` を受けて防御的に読む (root `npm install` が通らず front は
 * CI が初検証のため、実行時前提を増やさない — CLAUDE.md の規範)。
 */

export interface KintaiAlcUploadResult {
  opeNo: string | null
  startOpe: string | null
  uploadId: string | null
  /** `2` なら2マンで主・助手の両方が入ったという意味 (2026-08-04実測)。
   * 黙って隠さず、常に表示すること (親判断3)。 */
  operationsCount: number | null
  /** アップロード直後のスナップショット。0でも「成功」ではない (`notes.split` 参照)。 */
  splitFailed: number | null
  splitConfirmed: false
  notes: {
    hasKudgivt: string | null
    split: string | null
    preview: string | null
  }
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function toNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

export function parseKintaiAlcUploadResult(raw: unknown): KintaiAlcUploadResult {
  const r = (raw ?? {}) as Record<string, unknown>
  const notes = (r.notes ?? {}) as Record<string, unknown>
  return {
    opeNo: toStringOrNull(r.ope_no),
    startOpe: toStringOrNull(r.start_ope),
    uploadId: toStringOrNull(r.upload_id),
    operationsCount: toNumberOrNull(r.operations_count),
    splitFailed: toNumberOrNull(r.split_failed),
    splitConfirmed: false,
    notes: {
      hasKudgivt: toStringOrNull(notes.has_kudgivt),
      split: toStringOrNull(notes.split),
      preview: toStringOrNull(notes.preview),
    },
  }
}
