/**
 * /daily-report-edit (日報編集、Refs #169) が使う theearth credential
 * pass-through セッション。`useTheearthSession.ts` の汎用 factory を
 * `/daily-report-api` prefix で具体化した薄いラッパー (useDvrSession.ts と
 * 同型だが、DVR viewer とは別の theearth ログインセッションを持つ — worker 側
 * DO instance も `report-{comp}:{userB64}` で分離される、
 * `workers/dtako-scraper-relay/src/report-session.ts` 参照)。
 */
export type DailyReportSession = TheearthAccountSession

export const dailyReportErrorMessage = theearthSessionErrorMessage
export const dailyReportErrorStatus = theearthSessionErrorStatus

export function useDailyReportSession() {
  return useTheearthSession({
    apiPrefix: '/daily-report-api',
    headerPrefix: 'X-Report',
    stateNamespace: 'daily-report',
    storageKey: 'daily-report-edit-session',
    lastAccountStorageKey: 'daily-report-edit-last-account',
  })
}
