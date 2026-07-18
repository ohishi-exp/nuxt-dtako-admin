#!/bin/bash
# コード + skills + docs を横断検索するユーティリティ
#
# Usage:
#   scripts/xref.sh <keyword>
#
# 出所グループ別 (ソース / ドキュメント / その他) に見出しを付けて
# ripgrep (rg) で検索する。rg が無ければ grep -rn にフォールバックする。

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/xref.sh <keyword>" >&2
  exit 1
fi

KEYWORD="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

search_dir() {
  target="$1"
  path="$ROOT/$target"
  if [ ! -e "$path" ]; then
    return 0
  fi
  if command -v rg >/dev/null 2>&1; then
    rg -i -n "$KEYWORD" "$path" || true
  else
    grep -rn -i "$KEYWORD" "$path" || true
  fi
}

search_file() {
  target="$1"
  path="$ROOT/$target"
  if [ ! -e "$path" ]; then
    return 0
  fi
  if command -v rg >/dev/null 2>&1; then
    rg -i -n "$KEYWORD" "$path" || true
  else
    grep -n -i "$KEYWORD" "$path" || true
  fi
}

echo "== ソース =="
for d in app server worker; do
  search_dir "$d"
done
if [ -d "$ROOT/workers" ]; then
  for d in "$ROOT"/workers/*/src; do
    [ -d "$d" ] || continue
    search_dir "workers/$(basename "$(dirname "$d")")/src"
  done
fi

echo "== ドキュメント =="
search_dir "docs"
search_dir ".claude/skills"

echo "== その他 =="
search_dir "migrations"
search_file "CLAUDE.md"
