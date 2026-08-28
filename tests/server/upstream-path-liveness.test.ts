/**
 * 上流 (`ippoan/rust-alc-api`) の path が **実在する**ことを測る (Refs #1035 #1033)。
 *
 * ## なぜ要るのか
 *
 * `server/api/vehicle-settings/unconfirmed.get.ts` は存在しない `/api/dtako/vehicles`
 * を叩いていて**本番で 404** だったのに、この repo の CI は緑のままだった (#1033)。
 * route テストが `alcProxyFetch` を **mock** しているので、守られていたのは
 * **「その path で呼んだ」**ことだけで、**「その path が上流に在る」**は誰も見て
 * いなかった。ここがその穴を塞ぐ。
 *
 * ## 2 段構え
 *
 * - **② 静的突合 (常に走る)** — `server/` を走査して `alcProxyFetch` /
 *   `alcInternalProxyFetch` に渡している `path:` リテラルを抜き、下の
 *   `UPSTREAM_PATHS` と**集合として一致**するか見る。呼び出しが増減・改名された
 *   のに一覧が置き去りになるのを止める。
 * - **③ live 実測 (`API_BASE_URL` があるときだけ)** — その path を上流コンテナに
 *   投げて **404 でない**ことを見る。CI では `.github/workflows/test.yml` の
 *   `has_integration: true` が `docker-compose.test.yml` を起動し、
 *   `ghcr.io/ippoan/rust-alc-api` の実イメージが `localhost:18080` に居る
 *   (`integration_env: 'API_BASE_URL=http://localhost:18080'`)。**上流 repo の
 *   checkout も新しい secret も要らない。**
 *
 * ## なぜ「404 でない」だけを見るのか
 *
 * 401 / 403 / 405 / 422 は**通す** — 認証や method の違いは「route が在る」ことの
 * 証拠だから。認証を付ける必要も無い (404 と 401 が区別できればよい)。
 *
 * **区別できることは実測済み**: 上流は routing の**後**に認証層が走るので、
 * 在る path は 401、無い path は 404 になる。手元で `docker compose -f
 * docker-compose.test.yml up` (`ghcr.io/ippoan/rust-alc-api:dev`
 * `sha256:8a09890…`、image created 2026-08-25T09:07:41Z) を起こして curl した実測:
 *
 *     GET  /api/health                -> 200
 *     GET  /api/vehicles              -> 401   (在る)
 *     GET  /api/dtako/y-time-export   -> 401   (在る。GET でも 405 ではなく 401)
 *     GET  /api/internal/operations   -> 401   (在る。ただし下記の env が要る)
 *     GET  /api/dtako/vehicles        -> 404   (#1033 で壊れていた値)
 *     GET  /api/__nonexistent…__      -> 404
 *
 * ## `/api/internal/operations` には compose の env が要る
 *
 * 上流の `internal_shared_secret_router` は env `INTERNAL_SHARED_SECRET` が空だと
 * **empty Router** になり、この route が丸ごと生えない
 * (`rust-alc-api@5df8b03` `src/routes/mod.rs:258` / `src/main.rs:525`。route 定義
 * 自体は `crates/alc-dtako/src/dtako_operations.rs:35`)。
 * `docker-compose.test.yml` はこれを設定していなかったので **404 だった** —
 * 「上流から消えた」ではない。同 PR で compose に dummy 値を 1 行足して解消済みで、
 * **足す前 404 → 足した後 401** を実測している。
 *
 * 切り分けに使った陽性対照: 無条件 mount の別 router
 * (`/api/internal/auth/sso-config` / `/api/internal/notify/line/webhook` /
 * `/api/internal/pending`) は env 無しでも **401** を返す。つまり
 * 「`/api/internal` 名前空間ごと無い」のではなく **secret gate の route だけ**が
 * 無かった。**接頭辞で判定せず、上流のどの router に merge されているかを読むこと。**
 *
 * ## ★ ログは `console.*` ではなく `process.stdout.write` で出す
 *
 * **実測**: vitest の既定 reporter (= `npm test` = CI と同条件) は
 * **`console.info` / `console.log` を 1 行も出さない**。`--reporter=verbose` で
 * しか見えないので、`console` で書くと ④ の「CI ログで実際に走ったか読める」が
 * 成立しない。`process.stdout.write` / `process.stderr.write` は既定 reporter でも
 * **skip した test からでも**出る (使い捨て probe で 6 出口を比較して確認)。
 *
 * ## ★ 既存の `callApi` ヘルパを使ってはいけない
 *
 * `tests/helpers/api-test-env.ts` の `callApi` は「API エラー = エンドポイントに
 * 到達した」として **4xx を全部通す** — **404 も通る**ので、この用途には使えない。
 * ここでは status を直接読む。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { API_BASE, isLive, restoreNativeApis } from '../helpers/api-test-env'

// ---------------------------------------------------------------------------
// ① 対象 path の全数列挙
// ---------------------------------------------------------------------------

interface UpstreamPathEntry {
  /** 上流 (rust-alc-api) の path。`alcProxyFetch` / `alcInternalProxyFetch` の `path:` */
  path: string
  /** 呼び出し元 (repo root からの相対パス) */
  caller: string
  /**
   * live で 404 判定を測るか。`false` にするなら `reason` が必須
   * (理由の無い除外は下の「④ 穴を塞ぐ」テストが落とす)。
   */
  liveProbe: boolean
  /** `liveProbe: false` の理由 */
  reason?: string
}

/**
 * **issue #1035 の「対象は 2 本」は誤り — 実測 3 本。**
 * `alcInternalProxyFetch` 経由の `/api/internal/operations` が数え落とされている。
 */
const UPSTREAM_PATHS: UpstreamPathEntry[] = [
  {
    path: '/api/vehicles',
    caller: 'server/api/vehicle-settings/unconfirmed.get.ts',
    liveProbe: true,
  },
  {
    path: '/api/dtako/y-time-export',
    caller: 'server/api/y-time-export.post.ts',
    liveProbe: true,
  },
  {
    path: '/api/internal/operations',
    caller: 'server/api/tariff/dtako-operations.get.ts',
    // `docker-compose.test.yml` に `INTERNAL_SHARED_SECRET` を足すまでは 404 で、
    // 「上流から消えた」と区別できなかった (経緯は冒頭の docstring)。
    // env を足して 401 になったので live で測れる。
    liveProbe: true,
  },
]

/**
 * live 実測から外れている path の件数。**現在 0 件**。
 *
 * ここを固定しておくと、次に誰かが `liveProbe: false` を黙って足したときに落ちる。
 * 外すのが正当なら**この数と `reason` を一緒に**直すことになるので、除外が
 * 「気づかれないまま増える」ことがなくなる (この repo が何度も踏んでいる
 * 「緑だが検証ゼロ」の穴を、件数側からも塞ぐ)。
 */
const EXPECTED_EXCLUDED_FROM_LIVE = 0

// ---------------------------------------------------------------------------
// ② server/ を走査して実装側の path: リテラルを抜く
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const SERVER_DIR = join(REPO_ROOT, 'server')

/** `alcProxyFetch` / `alcInternalProxyFetch` の呼び出しに渡す `path:` だけを数える。 */
const PROXY_FNS = ['alcProxyFetch', 'alcInternalProxyFetch'] as const

/** 検算用: `path:` リテラルの総数 (呼び出し元を問わない) */
const ANY_PATH_LITERAL = /(?:^|[\s,({])path:\s*(['"`])([^'"`\n]*)\1/g

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

/** `src[open]` の `(` に対応する `)` の index。見つからなければ -1。 */
function matchingParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

interface FoundPath {
  path: string
  caller: string
  fn: string
}

/** proxy 呼び出しの引数から `path:` リテラルを抜く。 */
function scanProxyCallPaths(): FoundPath[] {
  const found: FoundPath[] = []
  for (const file of listTsFiles(SERVER_DIR)) {
    const src = readFileSync(file, 'utf8')
    const caller = file.slice(REPO_ROOT.length + 1)
    for (const fn of PROXY_FNS) {
      const needle = `${fn}(`
      let from = 0
      for (;;) {
        const at = src.indexOf(needle, from)
        if (at < 0) break
        from = at + needle.length
        // 関数定義そのもの (`export async function alcProxyFetch(`) は呼び出しではない
        const before = src.slice(Math.max(0, at - 40), at)
        if (/\bfunction\s+$/.test(before)) continue
        const open = at + needle.length - 1
        const close = matchingParen(src, open)
        if (close < 0) continue
        const args = src.slice(open, close + 1)
        const m = /(?:^|[\s,({])path:\s*(['"`])([^'"`\n]*)\1/.exec(args)
        if (m) found.push({ path: m[2]!, caller, fn })
      }
    }
  }
  return found
}

/** `server/**` の `path:` リテラル総数 (呼び出し元を問わない)。内訳の検算に使う。 */
function scanAnyPathLiterals(): FoundPath[] {
  const found: FoundPath[] = []
  for (const file of listTsFiles(SERVER_DIR)) {
    const src = readFileSync(file, 'utf8')
    const caller = file.slice(REPO_ROOT.length + 1)
    for (const m of src.matchAll(ANY_PATH_LITERAL)) found.push({ path: m[2]!, caller, fn: '(any)' })
  }
  return found
}

const sorted = (xs: string[]) => [...xs].sort()

/**
 * CI ログに 1 行出す。
 *
 * **`console.info` を使わないこと** — vitest の既定 reporter (= `npm test` =
 * CI と同条件) は console 出力を 1 行も表示しない (`--reporter=verbose` 専用)。
 * `process.stdout.write` なら既定 reporter でも、skip する test からでも出る。
 */
function logLine(msg: string): void {
  process.stdout.write(`[upstream-path-liveness] ${msg}\n`)
}

// ---------------------------------------------------------------------------

describe('上流 path の実在検証 (Refs #1035 #1033)', () => {
  // -------------------------------------------------------------------------
  // ② 静的突合 — live でなくても必ず走る
  // -------------------------------------------------------------------------
  describe('② 一覧と実装の突合 (常に走る)', () => {
    it('UPSTREAM_PATHS の path 集合が server/ の実装と一致する', () => {
      const actual = sorted(scanProxyCallPaths().map(f => f.path))
      const listed = sorted(UPSTREAM_PATHS.map(e => e.path))
      expect(
        actual,
        'server/ の alcProxyFetch / alcInternalProxyFetch に渡している path が '
        + 'このファイルの UPSTREAM_PATHS と食い違っている。'
        + '呼び出しを足した/消した/path を変えたなら UPSTREAM_PATHS も直すこと '
        + '(直さないと上流の実在チェックがその path を素通りする — #1033 の再来)。',
      ).toEqual(listed)
    })

    it('UPSTREAM_PATHS の caller が実際の呼び出し元ファイルと一致する', () => {
      const actual = sorted(scanProxyCallPaths().map(f => `${f.caller} ${f.path}`))
      const listed = sorted(UPSTREAM_PATHS.map(e => `${e.caller} ${e.path}`))
      expect(actual).toEqual(listed)
    })

    it('検算: server/ の path: リテラル総数が proxy 呼び出しの件数と一致する', () => {
      // 総数 > 内訳 なら「proxy 以外の path: リテラルが増えた」= 分類を見直す合図。
      // (grep のヒットを数えるだけで分類しない、を避けるための陽性側の検算)
      const any = scanAnyPathLiterals()
      const proxy = scanProxyCallPaths()
      expect(
        sorted(any.map(f => `${f.caller} ${f.path}`)),
        'server/ の path: リテラルのうち proxy 呼び出し以外のものが現れた。'
        + '上流 path なのか別物なのかを判定して、この検算か UPSTREAM_PATHS を直すこと。',
      ).toEqual(sorted(proxy.map(f => `${f.caller} ${f.path}`)))
    })

    it('④ 穴塞ぎ: liveProbe を落とすなら理由が要る', () => {
      for (const e of UPSTREAM_PATHS) {
        if (e.liveProbe) continue
        expect(
          e.reason,
          `${e.path} が live 実測から外れているのに理由が書かれていない。`
          + '理由なしの除外は「緑だが何も守っていない」を作る。',
        ).toBeTruthy()
      }
    })

    it('④ 穴塞ぎ: 少なくとも 1 本は live 実測の対象になっている', () => {
      // 全部が liveProbe: false になると ③ が丸ごと空回りする。
      expect(UPSTREAM_PATHS.filter(e => e.liveProbe).length).toBeGreaterThan(0)
    })

    it('④ 穴塞ぎ: live 実測から外れている path の件数が想定どおり (陰性対照)', () => {
      const excluded = UPSTREAM_PATHS.filter(e => !e.liveProbe)
      expect(
        excluded.length,
        `live 実測から外れている path が ${EXPECTED_EXCLUDED_FROM_LIVE} 件のはずが `
        + `${excluded.length} 件 (${excluded.map(e => e.path).join(', ')})。`
        + '除外を足す/減らすなら EXPECTED_EXCLUDED_FROM_LIVE も一緒に直すこと。'
        + '黙って除外が増えると「緑だが上流を測っていない」に戻る。',
      ).toBe(EXPECTED_EXCLUDED_FROM_LIVE)
    })
  })

  // -------------------------------------------------------------------------
  // ③ live 実測 — API_BASE_URL があるときだけ。無いときは理由を出してから skip
  // -------------------------------------------------------------------------
  describe('③ live: 上流に path が在る (404 でない)', () => {
    beforeAll(() => {
      // live 時だけ happy-dom の fetch を Node native に戻す (no-op in mock mode)
      restoreNativeApis()
    })

    /** live でなければ理由を CI ログに出してから skip する。 */
    function skipUnlessLive(ctx: { skip: () => void }, what: string): boolean {
      if (isLive) return true
      logLine(
        `SKIP ${what} — API_BASE_URL 未設定のため live で測っていない。`
        + 'CI (has_integration: true) では docker-compose.test.yml の '
        + 'ghcr.io/ippoan/rust-alc-api が localhost:18080 に居るので実行される。',
      )
      ctx.skip()
      return false
    }

    async function statusOf(path: string): Promise<number> {
      const res = await fetch(`${API_BASE}${path}`, { method: 'GET' })
      return res.status
    }

    for (const entry of UPSTREAM_PATHS) {
      if (!entry.liveProbe) {
        it(`${entry.path} — 測っていない (理由あり)`, (ctx) => {
          logLine(`SKIP ${entry.path} — ${entry.reason}`)
          ctx.skip()
        })
        continue
      }

      it(`${entry.path} は上流に在る`, async (ctx) => {
        if (!skipUnlessLive(ctx, entry.path)) return
        const status = await statusOf(entry.path)
        logLine(`LIVE GET ${API_BASE}${entry.path} -> ${status}`)
        expect(
          status,
          `GET ${entry.path} が 404。上流 ippoan/rust-alc-api から path が消えた/`
          + '改名された可能性がある。直す場所はこの repo の呼び出し側 '
          + `(${entry.caller}) か、上流の route (rust-alc-api の crates/**/*.rs) の`
          + 'どちらか — 先に上流の route 定義を読んでから決めること。'
          + '401/403/405/422 は「route は在る」なので通る。',
        ).not.toBe(404)
      })
    }

    it('陰性対照: 実在しない path はちゃんと 404 になる', async (ctx) => {
      if (!skipUnlessLive(ctx, '(陰性対照)')) return
      // これが 404 でなければ、上の「404 でない」判定は何も測れていない
      // (例: 認証層が routing より先に走って全部 401 を返す構成に変わった、等)。
      const bogus = '/api/__upstream-path-liveness-negative-control__'
      const status = await statusOf(bogus)
      logLine(`LIVE GET ${API_BASE}${bogus} -> ${status} (陰性対照)`)
      expect(
        status,
        '実在しない path が 404 を返さない。上流の routing/認証の順序が変わって、'
        + 'このテストの「404 でない」判定が意味を失っている可能性がある。',
      ).toBe(404)
    })
  })
})
