#!/usr/bin/env bash
# dev-login ローカル検証環境を 1 コマンドで立ち上げる (Windows Git Bash / Linux 両対応)。
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
# build の既定は「.output/server/index.mjs が無い時だけ実行」。**いつ --build が要るかは
# hybrid かどうかで変わる**:
#   --hybrid あり: UI は nuxt dev (:3000) が配信するので .output が古くても問題ない。
#                  server/ 配下や依存 (auth-client 等) を変えた時だけ --build。
#   --hybrid なし: **.output が UI そのもの**。app/ の .vue・画面の文言を変えたら
#                  --build が要る。付け忘れると **古いバンドルを配信したまま測ってしまう**
#                  (chunk のハッシュが変わらないのが唯一の手掛かり。2026-08-24 に実害)。
#
# やること: git fetch → worktree add/更新 (origin/main detached) → node_modules を
# donor から junction / cp -al (0秒) or npm install (gh auth token) → wrangler.prebuilt.toml 生成
# → port 先住チェック → nuxt build → wrangler dev 起動 (Ready 待ち) → (--hybrid で
# nuxt dev も起動)。最後に issue_dev_login_url に渡す port を表示する。
set -euo pipefail

# Windows (Git Bash) と Linux で道具が違うのは 3 箇所だけ (node_modules の複製 / port の
# 先住チェック / ゾンビ workerd の検出)。共有部分 (worktree・build・wrangler 起動、約 140 行) を
# 二重管理にすると「片方だけ直して片方が腐る」ので、**別スクリプトに分けずその場で分岐する** (#1001)。
IS_LINUX=0
if [ "$(uname -s)" = Linux ]; then IS_LINUX=1; fi

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
  # donor は **package.json が origin/main と一致するものだけ**採る。
  # 「実体があるものを先着で使う」だと古い依存の worktree を引いて、build が
  # `"createDevLoginCallbackHandler" is not exported by @ippoan/auth-client` のような
  # 分かりにくい rollup エラーで落ちる (2026-07-25 実害。以前は warn するだけだった)。
  DONOR=""
  MAIN_PKG=$(mktemp)
  git -C "$ROOT" show origin/main:package.json > "$MAIN_PKG" 2>/dev/null || true
  for c in "$ROOT" "$ROOT"/.claude/worktrees/*; do
    [ "$c" = "$WT" ] && continue
    [ -d "$c/node_modules" ] && [ ! -L "$c/node_modules" ] || continue
    if diff -q "$MAIN_PKG" "$c/package.json" > /dev/null 2>&1; then
      DONOR="$c"
      break
    fi
    echo "   donor 候補 $c は package.json が origin/main と違うので使わない"
  done
  rm -f "$MAIN_PKG"
  if [ -n "$DONOR" ] && [ "$IS_LINUX" = 1 ]; then
    # Linux には junction が無い。**`ln -s` は使わない** — symlink で node_modules を張ると
    # vite の `/@fs` allowlist に弾かれて**テストが全滅する** (SKILL.md の既知の罠。
    # 2026-08-27 に別 repo で実測: 156 テストファイル全滅)。`cp -al` のハードリンク複製なら
    # 中身は「本物のディレクトリ」になるので回避でき、メタデータのみの複製なので
    # junction と同じくほぼ 0 秒で済む。
    cp -al "$DONOR/node_modules" "$WT/node_modules" \
      || { echo "!! node_modules のハードリンク複製に失敗した ($DONOR/node_modules)"; exit 1; }
    echo "   cp -al -> $DONOR/node_modules (package.json は origin/main と一致)"
  elif [ -n "$DONOR" ]; then
    # `cmd //c mklink /J` は使わない — MSYS の引数変換で `/J` が潰れ
    # 「無効なスイッチです」で失敗する (2026-07-25 実害)。PowerShell の
    # New-Item -ItemType Junction は引数変換の影響を受けない。
    powershell -NoProfile -Command \
      "New-Item -ItemType Junction -Path '$(cygpath -w "$WT/node_modules")' -Target '$(cygpath -w "$DONOR/node_modules")' | Out-Null" \
      || { echo "!! junction 作成に失敗した ($DONOR/node_modules)"; exit 1; }
    echo "   junction -> $DONOR/node_modules (package.json は origin/main と一致)"
  else
    echo "   donor なし -> npm install (gh auth token で GH Packages 認証)"
    NPMRC=$(mktemp)
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(gh auth token)" > "$NPMRC"
    # `--no-save` 必須: 検証用の install が package-lock.json を書き換えてしまい、
    # 検証中のブランチに無関係な lockfile 差分が混ざる (2026-07-25 実害)。
    (cd "$WT" && NPM_CONFIG_USERCONFIG="$NPMRC" npm install --no-save --no-audit --no-fund)
    rm -f "$NPMRC"
  fi
fi

echo "== [3/6] wrangler.prebuilt.toml ([build] 除去で起動 168s->23s)"
sed '/^\[build\]$/,/^$/d' "$WT/wrangler.toml" > "$WT/wrangler.prebuilt.toml"

echo "== [4/6] port 先住 + ゾンビチェック"
CHECK_PORTS="$WPORT"
[ "$HYBRID" = 1 ] && CHECK_PORTS="$WPORT $NPORT"
for p in $CHECK_PORTS; do
  if [ "$IS_LINUX" = 1 ]; then
    # `ss` は netstat と出力が違う: 状態は `LISTEN` (`LISTENING` ではない)、Local Address は
    # `0.0.0.0:8787` / `[::]:8787` / `127.0.0.1:8787` のどれでも出る。プロセス名は要らないので
    # 「その port を listen しているか」だけを、最後の `:port` の完全一致で見る
    # (`:${p}[^0-9]` のような部分一致は :3000 が :30000 に釣られる)。
    if ss -ltn 2>/dev/null | awk -v want=":${p}" '$1 == "LISTEN" { a = $4; sub(/.*:/, ":", a); if (a == want) found = 1 } END { exit found ? 0 : 1 }'; then
      echo "   !! port ${p} に先住プロセスあり。旧 workerd が旧バンドルで応答する罠 (SKILL.md 手順0)。"
      echo "   !! 掃除 (**自分が起動したものか確かめてから**止める。兄弟セッションの dev を巻き込まない):"
      echo "   !!         ss -ltnp \"sport = :${p}\"     # 塞いでいる PID が出る"
      echo "   !!         ls -l /proc/<PID>/cwd        # どの worktree のものか分かる"
      echo "   !!         kill <PID>"
      exit 1
    fi
  elif netstat -ano 2>/dev/null | grep "LISTENING" | grep -q ":${p}[^0-9]"; then
    echo "   !! port ${p} に先住プロセスあり。旧 workerd が旧バンドルで応答する罠 (SKILL.md 手順0)。"
    echo "   !! 掃除: powershell -ExecutionPolicy Bypass -File $(dirname "$0")/kill-dev-zombies.ps1"
    exit 1
  fi
done
# **port が空いていてもゾンビは残る** — listener を落とした親 wrangler や workerd が
# 生き続け、次の起動で port を奪い返す (2026-07-25 実測: 5 ports 全部 free なのに
# node/workerd が 5 個生存)。名前で分かる workerd だけ先に見る。
if [ "$IS_LINUX" = 1 ]; then
  # Linux の作業機は**複数セッションが同時に dev を回す**ので、素の `pgrep -x workerd` で
  # 落とすと兄弟セッションの dev を「ゾンビ」と誤判定して常に exit 1 になる
  # (2026-08-27 実測: 無関係な workerd が **30 個**生存、しかし port 8787 は空き)。
  # 元の意図は「前回の**自分の** wrangler dev の残骸」なので、この worktree 由来のものだけ見る。
  # workerd の cwd が起動元の worktree を指すことは実測で確認した (30 個中 25 個が各 worktree の
  # パス。残りは worktree ごと消えた archive 済みセッションの孤児で cwd が `... (deleted)` になる)。
  # **文字列比較ではなく `-ef` (device+inode 一致)** で見るのは、その `(deleted)` 表記と
  # `readlink -f` の正規化に引きずられないため。消えた worktree は $WT と一致しようがない。
  ZOMBIE=""
  UNKNOWN=0
  for zpid in $(pgrep -x workerd 2>/dev/null || true); do
    if [ "/proc/$zpid/cwd" -ef "$WT" ]; then
      ZOMBIE="$ZOMBIE $zpid"
    elif ! readlink "/proc/$zpid/cwd" > /dev/null 2>&1; then
      UNKNOWN=$((UNKNOWN + 1))
    fi
  done
  if [ -n "$ZOMBIE" ]; then
    echo "   !! この worktree の workerd が残っている (前回の wrangler dev の子プロセス):$ZOMBIE"
    echo "   !! 掃除 — **ここに出た PID 以外は絶対に kill しないこと**。この機では無関係な"
    echo '   !!        workerd が常時 30 個ほど動いており、`pkill -x workerd` のような一括 kill は'
    echo "   !!        兄弟セッションの実測ごと壊す:"
    echo "   !!         ps -o pid,lstart,args -p $(echo $ZOMBIE | tr ' ' ',')"
    echo "   !!         kill$ZOMBIE"
    exit 1
  fi
  # **持ち主を判定できなかった分は warn に倒して先へ進める。** ゾンビ検出は二次的な
  # ヒューリスティックで、**本当の衝突は上の port 先住チェックが捕まえる**。確信が持てないのに
  # 起動を阻むと、「起動できない」を直したスクリプトが別の理由で起動を阻むことになる。
  if [ "$UNKNOWN" -gt 0 ]; then
    echo "   (warn) 持ち主を判定できない workerd が ${UNKNOWN} 個ある (/proc/<pid>/cwd が読めない)。"
    echo "   (warn) この worktree のものではない前提で続行する。旧バンドルが応答する疑いが出たら"
    echo "   (warn) ps -o pid,lstart,args -C workerd で手で確認すること。"
  fi
elif tasklist //FI "IMAGENAME eq workerd.exe" 2>/dev/null | grep -qi workerd; then
  echo "   !! workerd.exe が残っている (前セッションの wrangler dev の子プロセス)。"
  echo "   !! 掃除: powershell -ExecutionPolicy Bypass -File $(dirname "$0")/kill-dev-zombies.ps1"
  exit 1
fi

if [ "$BUILD" = auto ]; then
  if [ -f "$WT/.output/server/index.mjs" ]; then
    BUILD=0
    if [ "$HYBRID" = 1 ]; then
      echo "== [5/6] nuxt build スキップ (.output あり。UI は nuxt dev が配信。server/ や依存を変えた時は --build)"
    else
      echo "== [5/6] nuxt build スキップ (.output あり)"
      echo "!! この .output が UI を配信する。app/ を変えたなら --build が要る (古いバンドルを配信したまま測ることになる)"
    fi
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
