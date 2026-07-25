#!/usr/bin/env bash
# dev-login ローカル検証環境を 1 コマンドで立ち上げる (Windows Git Bash 前提)。
#
# nuxt-dtako-admin の repo ルート (メイン worktree) から実行:
#   bash .claude/skills/dev-login-local-verify/setup-dev-env.sh [name] [options]
#
#   name              worktree 名 (default: wrangler-dev-test)。.claude/worktrees/<name> に作る
#   --here            **いま居る worktree をそのまま使う** (checkout も fetch もしない)。
#                     自分のブランチを dev で実機確認する時はこれ。付けないと
#                     origin/main の検証用 worktree を作るので**自分の変更は載らない**
#   --hybrid          nuxt dev (HMR) も並走させる。編集→反映が nuxt build 90秒 → 0.1秒になる。
#                     nuxt.config.ts の devProxy に /api/proxy と /__dev の :8787 転送が必要
#   --wrangler-port N wrangler dev の port (default: 8787)。hybrid 時は devProxy が 8787 固定
#                     なので変えないこと
#   --nuxt-port N     nuxt dev の port (default: 3000)
#   --no-build        nuxt build を強制スキップ
#   --build           nuxt build を強制実行
#
# build の既定は「.output/server/index.mjs が無い時だけ実行」。hybrid では UI は
# nuxt dev (:3000) が配信するため、wrangler 側の .output は binding 依存 route
# (/api/proxy, /__dev) を動かすためだけに必要 — UI が古くても問題ない。
# server/ 配下や依存 (auth-client 等) を変えた時だけ --build を付けること。
#
# やること: git fetch → worktree add/更新 (origin/main detached) → node_modules を
# donor から junction (0秒) or npm install (gh auth token) → wrangler.prebuilt.toml 生成
# → port 先住チェック → nuxt build → wrangler dev 起動 (Ready 待ち) → (--hybrid で
# nuxt dev も起動)。最後に issue_dev_login_url に渡す port を表示する。
set -euo pipefail

NAME="wrangler-dev-test"
HYBRID=0
HERE=0
WPORT=8787
NPORT=3000
BUILD=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --here) HERE=1 ;;
    --hybrid) HYBRID=1 ;;
    --wrangler-port) WPORT=$2; shift ;;
    --nuxt-port) NPORT=$2; shift ;;
    --build) BUILD=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) grep '^#' "$0" | head -20; exit 0 ;;
    *) NAME=$1 ;;
  esac
  shift
done

# worktree の中から実行されても**メイン worktree**を基準にする。
# `git rev-parse --show-toplevel` は「いま居る worktree」を返すので、worktree の中で
# 実行すると .claude/worktrees/<name> を入れ子に作ってしまう (2026-07-25 に実害:
# 入れ子 worktree が origin/main で作られ、front worker が自分のブランチではなく
# main のビルドを配信していた)。`git worktree list` の 1 行目がメイン worktree。
ROOT=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
HERE_WT=$(git rev-parse --show-toplevel)

if [ "$HERE" = 1 ]; then
  WT="$HERE_WT"
  echo "== [1/6] worktree = いま居る worktree ($WT) — checkout/fetch しない"
  echo "   branch: $(git -C "$WT" rev-parse --abbrev-ref HEAD) / $(git -C "$WT" log --oneline -1)"
  if [ -n "$(git -C "$WT" status --porcelain -- ':!.claude/worktrees')" ]; then
    echo "   (未コミットの変更あり = それを検証する。これが --here の目的)"
  fi
else
  WT="$ROOT/.claude/worktrees/$NAME"
  echo "== [1/6] worktree ($WT)"
  echo "   ※ origin/main を検証する。**自分のブランチを見たいなら --here** を付ける"
  git -C "$ROOT" fetch origin
  if [ -d "$WT" ]; then
    git -C "$WT" checkout --detach origin/main
  else
    git -C "$ROOT" worktree add --detach "$WT" origin/main
  fi
fi

echo "== [2/6] node_modules"
# 壊れた symlink (donor worktree 削除後の残骸) は作り直す
if [ -L "$WT/node_modules" ] && [ ! -e "$WT/node_modules" ]; then
  rm "$WT/node_modules"
fi
if [ ! -e "$WT/node_modules" ]; then
  DONOR=""
  for c in "$ROOT" "$ROOT"/.claude/worktrees/*; do
    [ "$c" = "$WT" ] && continue
    if [ -d "$c/node_modules" ] && [ ! -L "$c/node_modules" ]; then
      DONOR="$c"
      break
    fi
  done
  if [ -n "$DONOR" ]; then
    cmd //c mklink /J "$(cygpath -w "$WT/node_modules")" "$(cygpath -w "$DONOR/node_modules")" > /dev/null
    echo "   junction -> $DONOR/node_modules"
    if ! diff -q <(git -C "$ROOT" show origin/main:package.json) "$DONOR/package.json" > /dev/null 2>&1; then
      echo "   !! donor の package.json が origin/main と異なる (auth-client bump 等)。"
      echo "   !! 必要なら donor で npm install してから再実行するか、junction を消して"
      echo "   !! このスクリプトを再実行 (npm install パスに落ちる)"
    fi
  else
    echo "   donor なし -> npm install (gh auth token で GH Packages 認証)"
    NPMRC=$(mktemp)
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(gh auth token)" > "$NPMRC"
    (cd "$WT" && NPM_CONFIG_USERCONFIG="$NPMRC" npm install --no-audit --no-fund)
    rm -f "$NPMRC"
  fi
fi

echo "== [3/6] wrangler.prebuilt.toml ([build] 除去で起動 168s->23s)"
sed '/^\[build\]$/,/^$/d' "$WT/wrangler.toml" > "$WT/wrangler.prebuilt.toml"

echo "== [4/6] port 先住 + ゾンビチェック"
CHECK_PORTS="$WPORT"
[ "$HYBRID" = 1 ] && CHECK_PORTS="$WPORT $NPORT"
for p in $CHECK_PORTS; do
  if netstat -ano 2>/dev/null | grep "LISTENING" | grep -q ":${p}[^0-9]"; then
    echo "   !! port ${p} に先住プロセスあり。旧 workerd が旧バンドルで応答する罠 (SKILL.md 手順0)。"
    echo "   !! 掃除: powershell -ExecutionPolicy Bypass -File $(dirname "$0")/kill-dev-zombies.ps1"
    exit 1
  fi
done
# **port が空いていてもゾンビは残る** — listener を落とした親 wrangler や workerd が
# 生き続け、次の起動で port を奪い返す (2026-07-25 実測: 5 ports 全部 free なのに
# node/workerd が 5 個生存)。名前で分かる workerd だけ先に見る。
if tasklist //FI "IMAGENAME eq workerd.exe" 2>/dev/null | grep -qi workerd; then
  echo "   !! workerd.exe が残っている (前セッションの wrangler dev の子プロセス)。"
  echo "   !! 掃除: powershell -ExecutionPolicy Bypass -File $(dirname "$0")/kill-dev-zombies.ps1"
  exit 1
fi

if [ "$BUILD" = auto ]; then
  if [ -f "$WT/.output/server/index.mjs" ]; then
    BUILD=0
    echo "== [5/6] nuxt build スキップ (.output あり。server/ や依存を変えた時は --build)"
  else
    BUILD=1
  fi
fi
if [ "$BUILD" = 1 ]; then
  echo "== [5/6] nuxt build (~90s)"
  (cd "$WT" && npx nuxt build)
elif [ ! -f "$WT/.output/server/index.mjs" ]; then
  echo "!! --no-build 指定だが .output が無い。一度 build が必要"
  exit 1
fi

echo "== [6/6] wrangler dev 起動"
(cd "$WT" && npx wrangler dev -c wrangler.prebuilt.toml --remote --var DEV_LOGIN:true --port "$WPORT" > wrangler-dev.log 2>&1 &)
for _ in $(seq 1 90); do
  grep -q "Ready on" "$WT/wrangler-dev.log" 2>/dev/null && break
  sleep 2
done
if ! grep -q "Ready on" "$WT/wrangler-dev.log" 2>/dev/null; then
  echo "!! wrangler dev が Ready にならない。$WT/wrangler-dev.log を確認"
  exit 1
fi
echo "   wrangler dev Ready :$WPORT"

if [ "$HYBRID" = 1 ]; then
  if ! grep -q "'/api/proxy'" "$WT/nuxt.config.ts"; then
    echo "!! nuxt.config.ts の devProxy に /api/proxy 転送がない (hybrid 未対応の revision)。"
    echo "!! wrangler dev 単体 (:$WPORT) は使える。SKILL.md の hybrid 節を参照"
    exit 1
  fi
  if [ "$WPORT" != 8787 ]; then
    echo "!! hybrid は devProxy が :8787 固定のため --wrangler-port 変更と併用不可"
    exit 1
  fi
  echo "== hybrid: nuxt dev 起動"
  # `grep -oP` は使わない — Git Bash の locale では
  # `grep: -P supports only unibyte and UTF-8 locales` で落ち、`set -e` のせいで
  # wrangler dev を起動した直後にスクリプトが死ぬ (2026-07-25 に実害)。
  # wrangler.toml には同じキーが env 節にも出るので head -1 = top-level (prod) を採る。
  read_toml_var() { sed -n "s/^$2[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -1; }
  API=$(read_toml_var "$WT/wrangler.toml" NUXT_PUBLIC_API_BASE)
  AUTH=$(read_toml_var "$WT/wrangler.toml" NUXT_PUBLIC_AUTH_WORKER_URL)
  ALC=$(read_toml_var "$WT/wrangler.toml" NUXT_ALC_API_URL)
  if [ -z "$API" ] || [ -z "$AUTH" ] || [ -z "$ALC" ]; then
    echo "!! wrangler.toml から NUXT_PUBLIC_API_BASE / NUXT_PUBLIC_AUTH_WORKER_URL / NUXT_ALC_API_URL を読めなかった"
    exit 1
  fi
  (cd "$WT" && NUXT_PUBLIC_API_BASE="$API" NUXT_PUBLIC_AUTH_WORKER_URL="$AUTH" NUXT_ALC_API_URL="$ALC" \
    npx nuxt dev --port "$NPORT" > nuxt-dev.log 2>&1 &)
  for _ in $(seq 1 60); do
    grep -qE "Local:.*$NPORT" "$WT/nuxt-dev.log" 2>/dev/null && break
    sleep 2
  done
  echo "   nuxt dev Ready :$NPORT (HMR)"
  echo ""
  echo "次: issue_dev_login_url({ port: $NPORT }) -> ブラウザで開く (UI編集は即時反映)"
else
  echo ""
  echo "次: issue_dev_login_url({ port: $WPORT }) -> ブラウザで開く"
  echo "    ソース編集後は worktree で npx nuxt build するだけ (wrangler が自動 reload)"
fi
