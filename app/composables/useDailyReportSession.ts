/**
 * /daily-report-edit (日報編集、Refs #169) が使う theearth credential
 * pass-through セッション。`useTheearthSession.ts` の共有セッションを
 * `/daily-report-api` prefix (login/logout の経路) で参照する薄いラッパー。
 * セッション状態・localStorage・worker 側 DO は DVR viewer 系ページと共有
 * される (Refs #233)。
 */
export type DailyReportSession = TheearthAccountSession

export const dailyReportErrorMessage = theearthSessionErrorMessage
export const dailyReportErrorStatus = theearthSessionErrorStatus

export function useDailyReportSession() {
  return useTheearthSession('/daily-report-api')
}
