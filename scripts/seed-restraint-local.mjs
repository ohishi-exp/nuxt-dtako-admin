// 共有 fixture (tests/fixtures/restraint-wage/) をローカル R2 (wrangler dev の
// miniflare 永続化) へ投入する (Refs #268 PR-D、org 方針: local-first-testing skill)。
//
// unit テスト / golden と**同一の fixture** を seed する — テストデータの二重管理を
// しない。投入先は comp `local` / 2026-07 (fixture の設計月)。
//
// 使い方 (repo root):
//   npm run seed:local
// その後:
//   npx wrangler dev -c workers/dtako-scraper-relay/wrangler.toml --persist-to .wrangler-local \
//     --var RESTRAINT_DEV_VIEWER_COMP:local            … relay (127.0.0.1:8787)
//   NUXT_PUBLIC_STAGING_TENANT_ID=local npm run dev    … app (nitro devProxy が relay へ転送)
// (.claude/launch.json に同じ構成あり)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const COMP = process.env.SEED_COMP || 'local'
const YM = '2026-07' // fixture summaries.json の設計月 (fixture README 参照)
const BUCKET = 'dtako-uploads' // workers/dtako-scraper-relay/wrangler.toml の DTAKO_R2
const FIXTURE_DIR = 'tests/fixtures/restraint-wage'
const PERSIST = '.wrangler-local' // wrangler dev 側と同じ --persist-to (repo root 相対)

const readJson = name => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
const tmp = mkdtempSync(join(tmpdir(), 'restraint-seed-'))

function put(key, value) {
  const file = join(tmp, 'obj.json')
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  execFileSync('npx', [
    'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
    '--file', file, '--local', '--persist-to', PERSIST,
    '-c', 'workers/dtako-scraper-relay/wrangler.toml',
  ], { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' })
  console.log(`seeded: ${key}`)
}

try {
  for (const summary of readJson('summaries.json')) {
    put(`restraint/${COMP}/${YM}/summary/${summary.driverCd}/latest.json`, summary)
  }
  put(`restraint/${COMP}/wage-master/latest.json`, readJson('wage-master.json'))
  put(`restraint/${COMP}/min-wage/latest.json`, readJson('min-wage-master.json'))
  console.log(`done: comp=${COMP} month=${YM} → ${PERSIST}`)
}
finally {
  rmSync(tmp, { recursive: true, force: true })
}
