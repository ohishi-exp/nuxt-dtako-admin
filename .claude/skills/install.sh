#!/bin/bash
# nuxt-dtako-admin の repo ローカル skill (.claude/skills/<name>/SKILL.md) を
# ~/.claude/skills/<name> に symlink して、この repo を開いていない他 session /
# 他 repo からも `/<skill-name>` で使えるようにする。
#
# 使い方:
#   bash .claude/skills/install.sh            # symlink を作る/更新する
#   bash .claude/skills/install.sh --copy     # symlink ではなく実体コピー (repo を消しても残る)
#   bash .claude/skills/install.sh --dry-run  # 何をするか表示するだけ
#
# べき等。既存の同名 skill が別実体を指している場合は上書きしない (warn するだけ)。
#
# 参考: yhonda-ohishi/claude-hooks の session-start-install-skills.sh は
# claude-skills / claude-hooks repo を対象に同じことを SessionStart で自動化する。
# 本 script は nuxt-dtako-admin 固有 skill (theearth-venus 等) を手動 install する用。
set -u

MODE="link"
for arg in "$@"; do
  case "$arg" in
    --copy) MODE="copy" ;;
    --dry-run) MODE="dry" ;;
    -h|--help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

# repo 内の .claude/skills を basename から解決 (どこから叩かれても動く)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR"
DEST_ROOT="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

if [ ! -d "$SKILLS_SRC" ]; then
  echo "skills dir not found: $SKILLS_SRC" >&2
  exit 1
fi

mkdir -p "$DEST_ROOT"

installed=0
skipped=0
for skill_dir in "$SKILLS_SRC"/*/; do
  [ -d "$skill_dir" ] || continue
  name="$(basename "$skill_dir")"
  [ -f "$skill_dir/SKILL.md" ] || continue
  dest="$DEST_ROOT/$name"

  # 既存が別 repo / 別実体を指しているなら壊さない (warn のみ)
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    # コピー実体が既にある場合、この repo 由来か判別できないので上書きしない
    echo "skip (exists, not a symlink): $dest" >&2
    skipped=$((skipped + 1))
    continue
  fi

  case "$MODE" in
    dry)
      echo "would install: $name -> $skill_dir"
      ;;
    copy)
      rm -rf "$dest"
      cp -R "$skill_dir" "$dest"
      echo "copied: $name"
      installed=$((installed + 1))
      ;;
    link)
      # symlink はディレクトリごと張る (SKILL.md + scripts/ 等を丸ごと見せる)
      rm -f "$dest"
      ln -s "${skill_dir%/}" "$dest"
      echo "linked: $name -> ${skill_dir%/}"
      installed=$((installed + 1))
      ;;
  esac
done

if [ "$MODE" != "dry" ]; then
  echo "done: $installed installed, $skipped skipped -> $DEST_ROOT"
  echo "次の session から /<skill-name> (例: /theearth-venus) が使えます。"
fi
