/**
 * 一番星ヘルスチェック (/ichiban-health) の純粋ロジック (Refs #369)。
 *
 * rust-ichibanboshi の既存 API (CAPE#01 系) と給与読み取り API (OHKEN 系、
 * ohishi-exp/rust-ichibanboshi#82) を軽い 1 クエリずつで一括疎通確認する。
 * 新機能追加のたびにこのページで既存が壊れていないかも同時に確認できるのが目的。
 *
 * fetch はページ側の責務 — ここはチェック定義と応答の判定だけを持つ
 * (org のテスト方針: pure ロジックを util に切り出して 100% カバー)。
 */

/** 給与読み取り API の対象会社 (rust-ichibanboshi#81 で確定した現行 4 社)。 */
export const KYUYO_COMPANIES = ['0100', '0200', '0300', '0400'] as const

export interface HealthCheck {
  id: string
  label: string
  /** 対象 (どの DB / 系統の疎通を意味するか)。 */
  target: string
  /** 同一 origin の proxy 経由 URL。 */
  url: string
  /** kyuyo 系は JWT が必要 (proxy が Authorization を upstream へ素通しする)。 */
  needsAuth: boolean
}

/**
 * 一括実行するチェック一覧。給与明細は賃金期間ベースで当月分が月中は
 * 未確定のことがあるため、対象月はページ側で選択 (既定は前月)。
 */
export function buildHealthChecks(payrollMonth: string): HealthCheck[] {
  return [
    {
      id: 'health',
      label: 'サービス生存 (/health)',
      target: 'rust-ichibanboshi',
      url: '/api/ichiban/health',
      needsAuth: false,
    },
    {
      id: 'sales-departments',
      label: '部門マスタ (売上系)',
      target: 'CAPE#01',
      url: '/api/ichiban/api/sales/departments',
      needsAuth: false,
    },
    {
      id: 'employees',
      label: '社員マスタ',
      target: 'CAPE#01',
      url: '/api/ichiban/api/employees',
      needsAuth: false,
    },
    {
      id: 'vehicles',
      label: '車輌マスタ',
      target: 'CAPE#01',
      url: '/api/ichiban/api/vehicles',
      needsAuth: false,
    },
    {
      id: 'kyuyo-companies',
      label: '給与: 会社×年度一覧',
      target: 'OHKEN (給与大臣)',
      url: '/api/kyuyo/companies',
      needsAuth: true,
    },
    ...KYUYO_COMPANIES.map(company => ({
      id: `kyuyo-payroll-${company}`,
      label: `給与明細 ${company} (${payrollMonth})`,
      target: 'OHKEN (給与大臣)',
      url: `/api/kyuyo/payroll?company=${company}&month=${payrollMonth}`,
      needsAuth: true,
    })),
  ]
}

/** 既定の給与明細チェック対象月 = 前月 ("YYYY-MM")。 */
export function defaultPayrollMonth(now: Date): string {
  const y = now.getFullYear()
  const m = now.getMonth() // 0-based の当月 = 1-based の前月番号
  if (m === 0) return `${y - 1}-12`
  return `${y}-${String(m).padStart(2, '0')}`
}

export type CheckLevel = 'ok' | 'warn' | 'ng'

export interface CheckOutcome {
  level: CheckLevel
  /** 件数や warning 数などの短い説明。金額・氏名は含めない。 */
  detail: string
}

/**
 * HTTP status + 応答 JSON からチェック結果を判定する。
 * - 非 2xx → ng (応答の `error` メッセージがあれば添える)
 * - kyuyo 系の warnings (権限抜け等) や 0 件は warn — 疎通はしているが要確認
 */
export function classifyResult(id: string, httpStatus: number, body: unknown): CheckOutcome {
  if (httpStatus < 200 || httpStatus >= 300) {
    const message = (body as { error?: unknown } | null)?.error
    return {
      level: 'ng',
      detail: `HTTP ${httpStatus}${typeof message === 'string' && message ? `: ${message}` : ''}`,
    }
  }

  if (id === 'health') {
    return { level: 'ok', detail: 'HTTP 200' }
  }

  if (id === 'kyuyo-companies') {
    const companies = (body as { companies?: unknown } | null)?.companies
    const warnings = warningCount(body)
    if (!Array.isArray(companies)) return { level: 'ng', detail: '応答形式が想定外 (companies がありません)' }
    const detail = `${companies.length} 社 / warnings ${warnings}`
    if (warnings > 0) return { level: 'warn', detail }
    if (companies.length !== KYUYO_COMPANIES.length) return { level: 'warn', detail: `${detail} (想定 ${KYUYO_COMPANIES.length} 社)` }
    return { level: 'ok', detail }
  }

  if (id.startsWith('kyuyo-payroll-')) {
    const rows = (body as { rows?: unknown } | null)?.rows
    const warnings = warningCount(body)
    if (!Array.isArray(rows)) return { level: 'ng', detail: '応答形式が想定外 (rows がありません)' }
    const detail = `${rows.length} 名 / warnings ${warnings}`
    if (warnings > 0 || rows.length === 0) return { level: 'warn', detail }
    return { level: 'ok', detail }
  }

  // 既存 API (ApiResponse { source_table, data }) — data が配列で 1 件以上なら ok
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return { level: 'ng', detail: '応答形式が想定外 (data がありません)' }
  if (data.length === 0) return { level: 'warn', detail: '0 件 (マスタが空?)' }
  return { level: 'ok', detail: `${data.length} 件` }
}

function warningCount(body: unknown): number {
  const warnings = (body as { warnings?: unknown } | null)?.warnings
  return Array.isArray(warnings) ? warnings.length : 0
}
