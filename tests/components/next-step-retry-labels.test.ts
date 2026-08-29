/**
 * `describeResponseFailure(res, retry)` の `retry` が**その画面に実在するボタン**を
 * 指しているかを測る (Refs #1008 #996)。
 *
 * ## なぜ要るのか
 *
 * `retry` の規約は「**その画面に実在するボタンの表記そのまま**を渡す」。守られないと
 * 画面は **存在しないボタンを案内する** — 失敗した人が押すものを探して見つからない、
 * という**直す前より悪い状態**になる。だが `retry` はただの文字列なので、
 * **型検査も既存のテストも 1 つも落ちない**。機械で見ていない規約は必ず腐る。
 *
 * ## 測り方
 *
 * `app/**` の `.vue` の **`<script>` 側**から `retry` の形をした文字列リテラル
 * (**`「…」` を含み、かつ `してください` で終わる**) を集め、その `「…」` の中身を
 * 「ボタンの表記の引用」とみなして、**同じファイルの `<template>` に在る**ことを見る。
 *
 * ## ★ `describeResponseFailure(` の呼び出しを探すのでは足りない
 *
 * `retry` は**画面から直接**渡ることもあれば (`y-time-export` / `vehicle-settings`)、
 * **`app/utils/api.ts` の関数の引数として**渡ることもある (`restraint-report` /
 * `restraint-compare` / `operations` / `scraper` — Refs #1008)。後者は `.vue` の中に
 * `describeResponseFailure(` が 1 度も現れないので、**呼び出しを探すと 8 本取り逃す**
 * (実際に最初そう書いて 13 本中 8 本が漏れた)。**規約の側 (文字列の形) で拾う。**
 *
 * - `「…」` を含まない `retry` は**ボタンを名指ししていない**ので対象外
 *   (`'ページを再読み込みしてください'` / `'zip ファイルを選択してください'`)。
 * - ラベルが `` :label="`IVT一括分割 (${n}件未分割)`" `` のように**件数だけ可変**なとき、
 *   括弧の中が補足でしかないものは**固定部だけを引用**する (`「IVT一括分割」`)。
 *   `…` を含む引用は `…` で分割して**各断片が順に現れる**ことを見る。
 *
 * ## ★ 可変部が意味を持つラベルは、ここではなく `computed` の共有で守る
 *
 * `restraint-compare` の一括ボタン (`未知差分${N}名 再計算`) は**件数まで含めて 1 つの表記**
 * なので、伏せ字にすると案内が実物とずれる。式を `batchRecalcLabel` (computed) に切り出して
 * **template と `retry` が同じものを読む**形にしてあり、ずれが**構造的に起こらない**。
 * その `retry` はリテラルではないのでここには現れない — **突き合わせは
 * `tests/components/restraint-compare-recalc.test.ts` の
 * 「retry は画面に出ている一括ボタンのラベルそのもの」**が、描画結果に対して行う。
 *
 * ## ★ 見ているのは template の**ソース**であって描画結果ではない
 *
 * 描画まで見るには 5 画面を mount することになり、`retry` 1 つのために合わない。
 * 「ラベル文字列がその画面のソースに在る」までで、**創作したラベル**は捕まる。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const APP_DIR = join(REPO_ROOT, 'app')

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory()
      ? vueFiles(join(dir, e.name))
      : e.name.endsWith('.vue') ? [join(dir, e.name)] : [],
  )
}

/**
 * `<script>` 側の「`retry` の形をした文字列リテラル」。
 * **`「…」` を含み、かつ `してください` を含む** 1 行のシングルクォート文字列。
 */
const RETRY_LITERAL = /'([^'\\\n]*「[^」\n]+」[^'\\\n]*してください)'/g

function retryLiterals(script: string): string[] {
  return [...script.matchAll(RETRY_LITERAL)].map(m => m[1]!)
}

/** `retry` が名指ししているボタン表記 (`「…」` の中身)。 */
function quotedLabels(retry: string): string[] {
  return [...retry.matchAll(/「([^」]+)」/g)].map(m => m[1]!)
}

/** `label` (可変部は `…`) が template のソースに順に現れるか。 */
function templateHasLabel(template: string, label: string): boolean {
  let at = 0
  for (const part of label.split('…')) {
    if (part === '') continue
    const i = template.indexOf(part, at)
    if (i < 0) return false
    at = i + part.length
  }
  return true
}

function templateOf(src: string): string {
  const i = src.indexOf('<template>')
  return i < 0 ? '' : src.slice(i)
}

const cases = vueFiles(APP_DIR).flatMap((path) => {
  const src = readFileSync(path, 'utf-8')
  const at = src.indexOf('<template>')
  const script = at < 0 ? src : src.slice(0, at)
  const rel = path.slice(REPO_ROOT.length + 1)
  return retryLiterals(script).flatMap(retry =>
    quotedLabels(retry).map(label => ({ rel, template: templateOf(src), retry, label })),
  )
})

describe('describeResponseFailure の retry は実在するボタンを指す', () => {
  // ★ 陽性対照。改名や書式変更で抽出が 0 件になると、下の `it.each` が
  //   **1 本も走らないまま緑になる**。件数の下限をここで固定する。
  it('★ 陽性対照: retry が名指ししているボタンを抽出できている', () => {
    // **★ 数えたもの**: `app/**` の `.vue` の `<script>` 側にある
    // 「`「…」` を含み `してください` で終わるシングルクォート文字列」から取った
    // `「…」` の**引用 1 つ = 1 件**。ファイル数はそれが 1 件以上あるファイルの数。
    //
    // | | 本 | ファイル |
    // | --- | --- | --- |
    // | base `b78116493dc9` (= #996 + #1008 PR-1) | 18 | **9** |
    // | **+ #1008 PR-2** | **27** | **14** |
    // | 差 | +9 | +5 (`margin` 3 / `upload` 2 / `monthly` 2 / `allowance` 1 / `compare` 1) |
    // | **+ #1008 PR-3** | **27** | **14** |
    // | 差 | **+0** | **+0** |
    //
    // **★ PR-3 の増分が 0 なのは数え漏れではない。** PR-3 が足したのは
    // `daily-hours` / `operations` の**表の取得失敗**で、`retry` は両画面に既にある
    // `RETRY_RELOAD` (`'ページを再読み込みしてください'`) — **`「…」` が無いので
    // この抽出の対象外**。理由は下の 2 つ目の項目と同じ (失敗した回に押せるボタンが
    // 画面に出ていない) で、`.vue` 側の `describeListFailure` の doc に実測が書いてある。
    // **数え直しは `999` に上げて落とし、`expected X to be greater than or equal to 999`
    // の X を読む** — 下限をそのまま「いま何本あるか」として引用しない (下記)。
    //
    // **★ 旧版の注記は「8 ファイル」と書いていたが、それは下限値であって実測ではない。**
    // 同じ行の内訳 (`#996 で 3 画面 + 1 component` / `PR-1 で 4 画面` = 8) も
    // **PR-1 側が 1 ファイル数え落としていた** — 実測は 9
    // (#996 の 4 = `vehicle-settings/{index,history,unconfirmed}` +
    // `VehicleSettingsDumpPicker` / PR-1 の 5 = `restraint-compare` / `operations` /
    // `restraint-report` / `scraper` / `y-time-export`)。
    // **下限をそのまま「いま何本あるか」として引用しない。**
    //
    // **リテラルが無い `retry` はここに出ない** — 数え漏れではなく設計:
    // - `restraint-compare` の一括ボタンと `allowance` の保存ボタンは
    //   **ラベルが可変**なので `computed` / 共有関数から組む (上の注記)
    // - `daily-hours` / `operations` の乗務員・車両一覧**と表そのもの** (#1008 PR-3)、
    //   `restraint-report` の乗務員一覧、`ProfitPanel` は
    //   **失敗した回に押せるボタンが画面に出ていない**ので `「…」` を使わない文を
    //   渡している (ボタンを名指ししていない = 対象外)
    // - `margin` の R2 保存注記と `allowance` の暫定手当注記は、**注記そのものが
    //   やり直し方を持っている**ので `retry` を渡していない (指示が 2 つ並ぶため)
    //
    // **下限は上げるだけ。下げない。**
    expect(cases.length).toBeGreaterThanOrEqual(27)
    expect(new Set(cases.map(c => c.rel)).size).toBeGreaterThanOrEqual(14)
  })

  it.each(cases.map(c => [c.rel, c.label, c] as const))(
    '%s — 「%s」がこの画面の template に在る',
    (_rel, _label, c) => {
      expect(templateHasLabel(c.template, c.label), `retry: ${c.retry}`).toBe(true)
    },
  )

  // ★ 陰性対照。判定器そのものが「何を渡しても true」になっていないことを見る。
  //   これが無いと、上の it.each が全部緑でも「測れていない」可能性が残る。
  it('★ 陰性対照: 実在しないラベルは落ちる', () => {
    const template = '<template><UButton label="再計算" /></template>'
    expect(templateHasLabel(template, '再計算')).toBe(true)
    expect(templateHasLabel(template, '再計算ボタン')).toBe(false)
    expect(templateHasLabel(template, '全員再計算')).toBe(false)
    // 可変部 `…` は「順に現れる」ことまで見る (順序が逆なら落ちる)
    expect(templateHasLabel('<template>未知差分3名 再計算</template>', '未知差分…名 再計算')).toBe(true)
    expect(templateHasLabel('<template>再計算 未知差分3名</template>', '未知差分…名 再計算')).toBe(false)
  })
})
