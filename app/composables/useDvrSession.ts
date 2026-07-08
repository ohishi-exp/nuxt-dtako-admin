/**
 * /dvr-viewer 系ページ (動画ビューア / 位置情報・動態履歴) で共有する theearth
 * credential pass-through セッション (Refs #90)。`useTheearthSession.ts` の
 * 汎用 factory を `/dvr-api` prefix で具体化した薄いラッパー
 * (Refs #169 で useDailyReportSession.ts との重複を統合)。
 */
export type DvrSession = TheearthAccountSession

export const dvrErrorMessage = theearthSessionErrorMessage
export const dvrErrorStatus = theearthSessionErrorStatus

export function useDvrSession() {
  return useTheearthSession({
    apiPrefix: '/dvr-api',
    headerPrefix: 'X-Dvr',
    stateNamespace: 'dvr',
    storageKey: 'dvr-viewer-session',
    lastAccountStorageKey: 'dvr-viewer-last-account',
  })
}
