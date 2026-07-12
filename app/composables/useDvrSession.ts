/**
 * /dvr-viewer 系ページ (動画ビューア / 位置情報・動態履歴) が使う theearth
 * credential pass-through セッション (Refs #90)。`useTheearthSession.ts` の
 * 共有セッションを `/dvr-api` prefix (login/logout の経路) で参照する薄い
 * ラッパー。セッション状態・localStorage・worker 側 DO は daily-report-edit
 * と共有される (Refs #233)。
 */
export type DvrSession = TheearthAccountSession

export const dvrErrorMessage = theearthSessionErrorMessage
export const dvrErrorStatus = theearthSessionErrorStatus

export function useDvrSession() {
  return useTheearthSession('/dvr-api')
}
