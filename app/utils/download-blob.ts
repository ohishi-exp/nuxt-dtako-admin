/**
 * fetch レスポンスを Blob としてブラウザにダウンロードさせる共通処理。
 * `content-disposition` の filename を優先し、無ければ fallback を使う。
 * y-time-export.vue と daily-report-edit.vue が個別に持っていた同型ロジック
 * (fetch → blob → createObjectURL → 一時 `<a>` click → revokeObjectURL) を
 * 統合したもの (rule-of-two、Refs #169)。
 */
export async function downloadBlobResponse(res: Response, fallbackFilename: string): Promise<void> {
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const cd = res.headers.get('content-disposition') ?? ''
  const m = cd.match(/filename="([^"]+)"/)
  a.download = m ? m[1]! : fallbackFilename
  a.click()
  URL.revokeObjectURL(url)
}
