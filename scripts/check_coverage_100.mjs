#!/usr/bin/env node
/**
 * coverage_100.toml に登録されたファイルが 100% カバレッジを維持しているか検証する。
 * coverage/coverage-summary.json または coverage/coverage-final.json を読み込む。
 * branches = true のファイルは branches.pct も 100% を要求する。
 *
 * Usage: node scripts/check_coverage_100.mjs
 * Exit 0: 全ファイル 100% or 登録ファイルなし
 * Exit 1: 100% 未満のファイルあり
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TOML_PATH = join(ROOT, 'coverage_100.toml')
const SUMMARY_PATH = join(ROOT, 'coverage', 'coverage-summary.json')
const FINAL_PATH = join(ROOT, 'coverage', 'coverage-final.json')

// Parse coverage_100.toml — extract [[files]] entries with optional branches flag
function parseToml(content) {
  const entries = []
  let current = null
  for (const line of content.split('\n')) {
    if (line.trim() === '[[files]]') {
      current = { path: '', branches: false }
      entries.push(current)
      continue
    }
    if (!current) continue
    const pathMatch = line.match(/^path\s*=\s*"(.+)"/)
    if (pathMatch) { current.path = pathMatch[1]; continue }
    const branchMatch = line.match(/^branches\s*=\s*true/)
    if (branchMatch) current.branches = true
  }
  return entries.filter(e => e.path)
}

// Compute summary from coverage-final.json (istanbul format)
function computeSummaryFromFinal(finalData) {
  const summary = {}
  for (const [filePath, fileCoverage] of Object.entries(finalData)) {
    const lines = { total: 0, covered: 0, pct: 0 }
    const branches = { total: 0, covered: 0, pct: 0 }

    // Lines: statementMap + s
    const s = fileCoverage.s || {}
    for (const key of Object.keys(s)) {
      lines.total++
      if (s[key] > 0) lines.covered++
    }
    lines.pct = lines.total === 0 ? 100 : (lines.covered / lines.total) * 100

    // Branches: branchMap + b
    const b = fileCoverage.b || {}
    for (const key of Object.keys(b)) {
      for (const count of b[key]) {
        branches.total++
        if (count > 0) branches.covered++
      }
    }
    branches.pct = branches.total === 0 ? 100 : (branches.covered / branches.total) * 100

    summary[filePath] = { lines, branches }
  }
  return summary
}

// Load coverage data (prefer summary, fall back to final)
function loadCoverage() {
  if (existsSync(SUMMARY_PATH)) {
    return JSON.parse(readFileSync(SUMMARY_PATH, 'utf-8'))
  }
  if (existsSync(FINAL_PATH)) {
    console.log('Using coverage-final.json (coverage-summary.json not found)')
    const finalData = JSON.parse(readFileSync(FINAL_PATH, 'utf-8'))
    return computeSummaryFromFinal(finalData)
  }
  return null
}

// Main
const tomlContent = readFileSync(TOML_PATH, 'utf-8')
const registeredFiles = parseToml(tomlContent)

if (registeredFiles.length === 0) {
  console.log('coverage_100.toml: No files registered yet. Skipping check.')
  process.exit(0)
}

const summary = loadCoverage()
if (!summary) {
  console.error(`ERROR: Neither ${SUMMARY_PATH} nor ${FINAL_PATH} found. Run "npm run test:coverage" first.`)
  process.exit(1)
}

let failed = false
let branchChecked = 0

for (const { path: filePath, branches: checkBranches } of registeredFiles) {
  // coverage data uses absolute paths as keys
  const absPath = resolve(ROOT, filePath)
  const entry = summary[absPath]

  if (!entry) {
    console.error(`FAIL: ${filePath} — not found in coverage report`)
    failed = true
    continue
  }

  const linesPct = entry.lines.pct
  const branchPct = entry.branches.pct

  if (linesPct < 100) {
    console.error(`FAIL: ${filePath} — lines ${linesPct}% (expected 100%)`)
    failed = true
  } else if (checkBranches && branchPct < 100) {
    console.error(`FAIL: ${filePath} — branches ${branchPct}% (expected 100%)`)
    failed = true
  } else {
    const branchLabel = checkBranches ? ` branches ${branchPct}%` : ''
    console.log(`  OK: ${filePath} — lines 100%${branchLabel}`)
  }

  if (checkBranches) branchChecked++
}

if (failed) {
  console.error('\ncoverage_100 regression detected!')
  process.exit(1)
} else {
  console.log(`\nAll ${registeredFiles.length} files at 100% lines (${branchChecked} also checked branches).`)
  process.exit(0)
}
