#!/bin/bash
# ohishi-exp/dtako_vid_wasm (private) を wasm-pack でビルドし、
# public/wasm/dtako-vid/ に vendor する。
#
# dtako_vid_wasm は private repo かつ GitHub Actions の課金を避けるため CI を
# 持たない。ビルドはこのスクリプトで手元 (or CCoW) から手動で行う。
#
# Usage:
#   ./scripts/build-dtako-vid-wasm.sh [path-to-dtako_vid_wasm-checkout]
#
# 引数省略時は ../dtako_vid_wasm (このリポジトリの親ディレクトリ) を使う。
# 存在しなければ git clone する (private repo への access が必要)。
#
# Prerequisites: rustup, cargo, git
#   (wasm32-unknown-unknown target と wasm-pack は無ければ自動インストールする)

set -euo pipefail

SRC_DIR="${1:-../dtako_vid_wasm}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/wasm/dtako-vid"

if [ ! -d "$SRC_DIR" ]; then
  echo "cloning ohishi-exp/dtako_vid_wasm into $SRC_DIR ..."
  git clone git@github.com:ohishi-exp/dtako_vid_wasm.git "$SRC_DIR"
fi

if ! rustup target list --installed | grep -q '^wasm32-unknown-unknown$'; then
  rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  cargo install wasm-pack --locked
fi

cd "$SRC_DIR/wasm"
wasm-pack build --target web --release --out-dir pkg

mkdir -p "$OUT_DIR"
cp pkg/dtako_vid_wasm.js pkg/dtako_vid_wasm_bg.wasm pkg/dtako_vid_wasm.d.ts pkg/dtako_vid_wasm_bg.wasm.d.ts "$OUT_DIR/"

echo "vendored dtako_vid_wasm build into $OUT_DIR"
