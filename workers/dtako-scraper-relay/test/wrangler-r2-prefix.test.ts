import { describe, expect, it } from 'vitest'

/**
 * `wrangler.toml` の R2 key prefix が named environment ごとに分離されているか
 * (Refs #983)。
 *
 * この worker は本番・staging・preview が**同じ `dtako-uploads` bucket** を共有し、
 * 分離は key prefix だけで担保している。ところが prefix はどれもコード側に
 * `env.X_R2_PREFIX || "既定"` のフォールバックを持つので、**宣言を 1 本書き忘れると
 * 「本番の prefix に書く」に静かに倒れる** (top-level `[vars]` は named environment に
 * 継承されない)。実際 `KINTAI_R2_PREFIX` がそうなっており、staging の日次 cron と
 * viewer の「取り込み」が本番の `kintai/` に版を足し、`raw/history.jsonl`
 * (追記型の監査証跡) にも混ざっていた。
 *
 * ⇒ **対象の一覧は src から機械的に引く。** 新しい prefix を足した人がこのテストを
 * 書き換えなくても、宣言漏れがそのまま落ちる。
 */

/** vitest の cwd = `workers/dtako-scraper-relay` 前提 (restraint-wage-golden.test.ts と同じ)。
 * tsconfig は @cloudflare/workers-types のみで node 型を持たないため、`node:fs` は
 * 非リテラル指定子の動的 import で型解決を回避する (同ファイルと同じ手)。 */
async function readText(path: string): Promise<string> {
  const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as {
    readFileSync: (p: string, enc: string) => string
  }
  return fs.readFileSync(path, 'utf8')
}

/** `[section]` / `[[section]]` ごとの中身の行 (コメント・空行は落とす)。
 * 見出しより前 (top-level の直書き) は拾わない。 */
function tomlSections(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let cur: string | null = null
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    const header = /^\[\[?([^\][]+)\]\]?$/.exec(line)
    if (header) {
      cur = header[1]!
      if (!out.has(cur)) out.set(cur, [])
      continue
    }
    if (!line || line.startsWith('#') || cur === null) continue
    out.get(cur)!.push(line)
  }
  return out
}

/** `KEY = "value"` の行から key → value を作る。 */
function keyValues(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of lines) {
    const m = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line)
    if (m) out.set(m[1]!, m[2]!)
  }
  return out
}

describe('wrangler.toml: R2 key prefix の env 分離 (Refs #983)', () => {
  it('src が読む *_R2_PREFIX は named environment ごとに、既定と違う値で宣言されている', async () => {
    const [toml, src] = await Promise.all([
      readText('wrangler.toml'),
      readText('src/dtako-scraper-relay-do.ts'),
    ])

    // src の `env.X_R2_PREFIX || "既定"` から {変数名 → 本番で使われる既定値} を作る。
    const defaults = new Map<string, string>()
    for (const m of src.matchAll(/env\.([A-Z0-9_]+_R2_PREFIX)\s*\|\|\s*"([^"]+)"/g)) {
      defaults.set(m[1]!, m[2]!)
    }
    // 陰性対照: 抽出そのものが壊れたら (0 件) 以下の assert が全部素通りする。
    expect(defaults.size).toBeGreaterThanOrEqual(5)
    expect(defaults.get('KINTAI_R2_PREFIX')).toBe('kintai')

    const sections = tomlSections(toml)
    // named environment の一覧も toml から引く (`[env.<name>.*]`)。
    const namedEnvs = [
      ...new Set([...sections.keys()].flatMap((s) => /^env\.([^.]+)\./.exec(s)?.[1] ?? [])),
    ].sort()
    expect(namedEnvs).toEqual(['preview', 'staging'])

    // 除外は 1 つも持たない。**「この env は cron を持たないから安全」で外さないこと**
    // — `kintai/` へ書くのは cron 経路だけではなく、viewer 経路
    // (`POST /restraint-api/kintai/fetch`) も同じ `handleKintaiFetch` を呼び、
    // その route 分岐は env の門を持たない (#983)。
    const missing: string[] = []
    for (const env of namedEnvs) {
      const vars = keyValues(sections.get(`env.${env}.vars`) ?? [])
      for (const [name, fallback] of defaults) {
        const declared = vars.get(name)
        // 未宣言 = コード側の既定 (= 本番の prefix) に倒れる。
        if (declared === undefined) missing.push(`${env}.${name}: 未宣言 (既定 "${fallback}" に倒れる)`)
        // 宣言はあるが本番と同値 = 分離されていない。
        else if (declared === fallback) missing.push(`${env}.${name}: 本番と同値 "${declared}"`)
      }
    }
    expect(missing).toEqual([])
  })

  it('kintai prefix は staging / preview とも本番と別 (この issue の本体)', async () => {
    const sections = tomlSections(await readText('wrangler.toml'))
    const varsOf = (env: string) => keyValues(sections.get(`env.${env}.vars`) ?? [])
    expect(varsOf('staging').get('KINTAI_R2_PREFIX')).toBe('kintai-staging')
    expect(varsOf('preview').get('KINTAI_R2_PREFIX')).toBe('kintai-preview')
    // top-level [vars] には対を置かない (宣言が 2 か所になる) — 本番の値はコード側の既定。
    expect(keyValues(sections.get('vars') ?? []).has('KINTAI_R2_PREFIX')).toBe(false)
  })
})
