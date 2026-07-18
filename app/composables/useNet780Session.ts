/**
 * /net780 (theearth F-VOS3020 検索・NET780 生データ一括ダウンロード、Refs #302)
 * が使う theearth credential pass-through セッション。`useTheearthSession.ts` の
 * 共有セッションを `/net780-api` prefix (login/logout の経路) で参照する薄い
 * ラッパー。セッション状態・localStorage・worker 側 DO は DVR viewer / 日報編集
 * / 拘束時間管理表と共有される (Refs #233)。
 */
export const net780ErrorMessage = theearthSessionErrorMessage
export const net780ErrorStatus = theearthSessionErrorStatus

export function useNet780Session() {
  return useTheearthSession('/net780-api')
}
