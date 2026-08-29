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
 * - ラベルが `` :label="`IVT一括分割 (${n}件未分割)`" `` のように**件数だけ可変**な
 *   ときは、`retry` 側で可変部を `…` に置いて `「未知差分…名 再計算」` と書く。
 *   ここでは `…` で分割して**各断片が順に現れる**ことを見る。
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
    // #1008 で 13 本 (4 画面) + #996 で 6 本 (3 画面 + 1 component)。
    expect(cases.length).toBeGreaterThanOrEqual(19)
    expect(new Set(cases.map(c => c.rel)).size).toBeGreaterThanOrEqual(8)
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
