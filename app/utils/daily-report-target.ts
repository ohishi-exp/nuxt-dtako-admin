/**
 * 日報編集を「この運行」を名指しして開くための `?unko_no=` の扱い (旅費編集 CakePHP の
 * `ryohi-rows/view` から開く用、Refs yhonda-ohishi/nginx#814)。
 *
 * 社内 MariaDB 由来の運行NO は 23 桁 (開始日時 12 + 車輌CD 10 + 対象CD 1)、theearth の
 * 運行No (`DailyReportRow.operationNo`) は 22 桁。突き合わせは先頭 22 桁で行う。
 */

const UNKO_NO_RE = /^\d{22,23}$/

/** query の値 → 先頭 22 桁。22/23 桁の数字以外 (配列・空・桁違い) は null */
export function parseTargetOpeNo(v: unknown): string | null {
  return typeof v === 'string' && UNKO_NO_RE.test(v) ? v.slice(0, 22) : null
}

/** 一覧の行がその運行か。target が null なら常に false */
export function isTargetRow(operationNo: string, target: string | null): boolean {
  return target !== null && operationNo.slice(0, 22) === target
}
