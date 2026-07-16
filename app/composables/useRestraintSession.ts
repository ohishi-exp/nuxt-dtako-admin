/**
 * /restraint-fetch (拘束時間管理表 CSV 取得、Refs #241) が使う theearth
 * credential pass-through セッション。`useTheearthSession.ts` の共有セッションを
 * `/restraint-api` prefix (login/logout の経路) で参照する薄いラッパー。
 * セッション状態・localStorage・worker 側 DO は DVR viewer / 日報編集と共有
 * される (Refs #233)。
 */
export const restraintErrorMessage = theearthSessionErrorMessage
export const restraintErrorStatus = theearthSessionErrorStatus

export function useRestraintSession() {
  return useTheearthSession('/restraint-api')
}
