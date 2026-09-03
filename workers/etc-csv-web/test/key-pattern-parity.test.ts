import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ETC_CSV_KEY_PATTERN } from '../src/keys'

/**
 * 同じ R2 オブジェクトを返す口が 2 つある (この worker と admin 画面の
 * `/api/etc-csv/download`)。**片方だけを緩めると「admin では弾かれるのにここでは
 * 通る鍵」が生まれる**ので、正規表現が literal で一致していることを機械で検査する。
 *
 * `server/` と `workers/` の間に実コードの import 前例が 0 件なので、共有モジュール
 * への切り出し (= 新しいパッケージ境界) ではなく「写し + この一致テスト」で担保する。
 */
const ROUTE_PATH = join(import.meta.dirname, '../../../server/api/etc-csv/download.get.ts')

describe('ETC_CSV_KEY_PATTERN の写しが本家と一致する', () => {
  const source = readFileSync(ROUTE_PATH, 'utf8')

  it('本家の宣言を 1 つだけ取り出せる', () => {
    expect(source.match(/^const ETC_CSV_KEY_PATTERN = .+$/gm)).toHaveLength(1)
  })

  it('literal が完全一致する', () => {
    const match = source.match(/^const ETC_CSV_KEY_PATTERN = (\/.+\/[a-z]*)$/m)
    expect(match).not.toBeNull()
    // 陽性対照: 取り出した文字列が本当に正規表現リテラルであることを確かめてから比べる
    // (取り出しに失敗して `null` 同士が一致する、という空振りを防ぐ)。
    expect(match?.[1]).toMatch(/^\/\^etc/)
    expect(match?.[1]).toBe(ETC_CSV_KEY_PATTERN.toString())
  })
})
