/**
 * **この bundle を作ったコードの版**を決める pure util (Refs #826)。
 *
 * 粗利の集計を R2 に版管理で残すとき、**同じ入力でもロジックが変われば数字は動く**ので
 * 「どのコードが出した数字か」を版に刻む必要がある。
 *
 * **このファイルは import を 1 つも持たない。** `nuxt.config.ts` が
 * (ビルド時定数を組み立てるために) 直接 import するため — 依存が 1 つでもあると
 * 設定の読み込み (jiti) が画面側の依存グラフを引きずり込む。
 * 粗利側から使うぶんは `margin-r2.ts` が re-export する。
 */

/**
 * ビルド時定数が入らなかったときの版。**空文字や `undefined` を版に混ぜない**ため、
 * 「不明」を 1 つの文字列に倒す (preview / staging / ローカル dev はすべてこれ)。
 */
export const UNKNOWN_CODE_VERSION = 'unknown'

/**
 * ビルド時に埋めた版を、保存に使える形にする。
 *
 * **空文字・空白・非文字列はすべて `unknown`** に倒す — 落とすのではなく「不明」と
 * 記録する (キーが消えると「昔の版か、埋め忘れか」を後から区別できない)。
 *
 * **画面 (client bundle) 側とサーバー route 側の両方で通す。** 数字を計算するのは画面
 * なので版の出どころも画面だが、古いタブが開きっぱなしの端末から何が飛んでくるか
 * 分からない — 受け取る側でも同じ関数で正規化して、空文字を版に混ぜない。
 */
export function resolveCodeVersion(raw: unknown): string {
  if (typeof raw !== 'string') return UNKNOWN_CODE_VERSION
  const trimmed = raw.trim()
  return trimmed === '' ? UNKNOWN_CODE_VERSION : trimmed
}

/**
 * CI の環境変数からビルド時定数を組む (`nuxt.config.ts` が呼ぶ)。
 *
 * GitHub Actions は全ての step に `GITHUB_REF_TYPE` / `GITHUB_REF_NAME` を渡すので、
 * reusable workflow (ippoan/ci-workflows) 経由の `wrangler deploy` →
 * `[build] npm run build` からでもそのまま読める (**workflow ファイルは触らない**)。
 *
 * **タグ (`v*` push) のビルドだけが値を持つ。** branch のビルド
 * (staging = `main` push / preview / ローカル) は**空文字**を返す —
 * `main` や branch 名は**中身が動き続ける名前**なので、それを「版」として記録すると
 * 「いつ変わったか」を辿れない (v0.0.512 と v0.0.517 がどちらも `main` になる)。
 * 空文字は保存側が `resolveCodeVersion` で `unknown` に倒す。
 */
export function ciBuildCodeVersion(refType: string | undefined, refName: string | undefined): string {
  if (refType !== 'tag') return ''
  return typeof refName === 'string' ? refName.trim() : ''
}
