/**
 * fetch レスポンスを Blob としてブラウザにダウンロードさせる共通処理。
 * `content-disposition` の filename を優先し、無ければ fallback を使う。
 * y-time-export.vue と daily-report-edit.vue が個別に持っていた同型ロジック
 * (fetch → blob → createObjectURL → 一時 `<a>` click → revokeObjectURL) を
 * 統合したもの (rule-of-two、Refs #169)。
 */
export async function downloadBlobResponse(res: Response, fallbackFilename: string): Promise<void> {
  const blob = await res.blob()
  downloadBlob(blob, contentDispositionFilename(res.headers.get('content-disposition')) ?? fallbackFilename)
}

/** `content-disposition` の `filename="…"` を取り出す。ヘッダが無い・filename が無いときは null。 */
export function contentDispositionFilename(header: string | null): string | null {
  const m = (header ?? '').match(/filename="([^"]+)"/)
  return m ? m[1]! : null
}

/**
 * 手元で組んだ Blob (JSZip で束ねた ZIP 等) をそのままの名前でダウンロードさせる
 * (訴訟準備の出力タブ、Refs #1133 c1133-2)。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
