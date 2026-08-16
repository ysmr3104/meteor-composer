#!/bin/bash
#
# run-remote.sh - このリポジトリをテスト実行機へ同期して、そこでコマンドを実行する
#
# 前提となる構成:
#   編集する PC (Claude Code が動く)  →  テスト実行機 (データと PixInsight がある)
#
# 評価用データは外付け SSD にあり、それが繋がっているのはテスト実行機だけなので、
# 実データを触る処理は必ず向こうで動かす必要がある。一方コードの編集は手元で行う
# ため、実行前に毎回同期する。git を経由すると 1 回の試行ごとにコミットが必要に
# なるので、rsync で直接送る。
#
# 使い方:
#   tools/run-remote.sh node tests/ut/test_detection_core.js
#   tools/run-remote.sh --pjsr tests/pjsr/run_detection.js
#   tools/run-remote.sh --sync-only
#
# 環境変数:
#   METEOR_REMOTE       接続先 (既定: mbp4ysmr)
#   METEOR_REMOTE_PATH  リモート側のリポジトリパス
#                       (既定: ~/projects/pixinsight/meteor-composer)
#   METEOR_NO_CAFFEINATE  1 にすると caffeinate を使わない
#
set -euo pipefail

REMOTE="${METEOR_REMOTE:-mbp4ysmr}"
REMOTE_PATH="${METEOR_REMOTE_PATH:-\$HOME/projects/pixinsight/meteor-composer}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PIXINSIGHT="/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight"

sync_repo() {
   echo "==> 同期: $REPO -> $REMOTE:$REMOTE_PATH"
   # .git は送らない。リモート側のリポジトリはあくまで実行用のミラーであり、
   # 履歴の正本は手元にある。--delete で手元の削除も反映させる。
   rsync -az --delete \
      --exclude='.git/' \
      --exclude='node_modules/' \
      --exclude='.DS_Store' \
      --exclude='.venv/' \
      "$REPO/" "$REMOTE:$REMOTE_PATH/"
}

run_remote() {
   local cmd="$1"
   # ログインシェルを経由しないと node や homebrew のパスが通らない。
   # SSH の非対話シェルは .zshrc を読まないため。
   echo "==> 実行 ($REMOTE): $cmd"
   ssh "$REMOTE" "zsh -lc 'cd $REMOTE_PATH && $cmd'"
}

main() {
   if [ $# -eq 0 ]; then
      echo "使い方: $0 [--sync-only | --pjsr <script.js> | <コマンド>...]" >&2
      exit 2
   fi

   case "$1" in
      --sync-only)
         sync_repo
         echo "==> 同期のみ完了"
         ;;
      --pjsr)
         shift
         if [ $# -eq 0 ]; then
            echo "--pjsr にはスクリプトのパスが必要です" >&2
            exit 2
         fi
         sync_repo
         local script="$1"
         # PixInsight は絶対パスで指定する必要がある。
         # caffeinate を挟むのは、654 枚の検出に 8 分かかり、その間に
         # スリープすると処理が止まるため。
         local pi_cmd="$PIXINSIGHT -n --automation-mode --no-splash \
-r=$REMOTE_PATH/$script --force-exit"
         if [ "${METEOR_NO_CAFFEINATE:-0}" = "1" ]; then
            run_remote "$pi_cmd"
         else
            run_remote "caffeinate -i $pi_cmd"
         fi
         ;;
      *)
         sync_repo
         run_remote "$*"
         ;;
   esac
}

main "$@"
