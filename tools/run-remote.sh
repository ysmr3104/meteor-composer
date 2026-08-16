#!/bin/bash
#
# run-remote.sh - テスト実行機でコミット済みの状態を実行する
#
# 前提となる構成:
#   編集する PC (Claude Code が動く)  →  テスト実行機 (データと PixInsight がある)
#
# 評価用データは外付け SSD にあり、それが繋がっているのはテスト実行機だけなので、
# 実データを触る処理は向こうで動かす必要がある。
#
# 同期は git で行う。rsync で未コミットの状態を送る方式も考えられるが、それは
# 採らない。テスト結果がどのコミットに対するものか追えなくなるためで、これは
# split-image-solver/CLAUDE.md に定めた規約でもある:
#
#   「テスト実施前に必ずコミットする。テスト結果がどのコミットに対するもので
#     あるかを明確にするため。」
#
# 検出性能の評価はベースライン比較なので、この対応関係が崩れると評価そのものが
# 意味を失う。したがって本スクリプトは未コミットの変更があると実行を拒否する。
#
# なお Node.js の Small テストはデータも PixInsight も不要なので手元で動く。
# 向こうで動かす必要があるのは実データを読む処理だけ。
#
# 使い方:
#   tools/run-remote.sh --pjsr tests/pjsr/run_detection.js
#   tools/run-remote.sh node tests/eval/evaluate.js
#   tools/run-remote.sh --fetch tests/eval/baseline.json
#
# 環境変数:
#   METEOR_REMOTE         接続先 (既定: mbp4ysmr)
#   METEOR_REMOTE_PATH    リモート側のリポジトリパス
#   METEOR_NO_CAFFEINATE  1 にすると caffeinate を使わない
#   METEOR_ALLOW_DIRTY    1 にすると未コミットでも実行する (非推奨)
#
set -euo pipefail

REMOTE="${METEOR_REMOTE:-mbp4ysmr}"
REMOTE_PATH="${METEOR_REMOTE_PATH:-\$HOME/projects/pixinsight/meteor-composer}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PIXINSIGHT="/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight"

require_clean() {
   if [ "${METEOR_ALLOW_DIRTY:-0}" = "1" ]; then
      echo "警告: METEOR_ALLOW_DIRTY=1 のため未コミットのまま実行します。" >&2
      echo "      結果はどのコミットのものか追えません。" >&2
      return
   fi
   if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
      echo "エラー: 未コミットの変更があります。" >&2
      echo "" >&2
      git -C "$REPO" status --short >&2
      echo "" >&2
      echo "テスト結果をコミットに紐づけるため、先にコミットとプッシュを行ってください。" >&2
      exit 1
   fi
   local unpushed
   unpushed="$(git -C "$REPO" log --oneline @{u}..HEAD 2>/dev/null || true)"
   if [ -n "$unpushed" ]; then
      echo "エラー: プッシュされていないコミットがあります。" >&2
      echo "$unpushed" >&2
      exit 1
   fi
}

sync_remote() {
   local sha
   sha="$(git -C "$REPO" rev-parse --short HEAD)"
   echo "==> 同期: $REMOTE を $sha に更新"
   ssh "$REMOTE" "zsh -lc 'cd $REMOTE_PATH && git fetch --quiet origin && git checkout --quiet $sha 2>/dev/null || git checkout --quiet -B main origin/main'"
   echo "==> リモート側の HEAD: $(ssh "$REMOTE" "zsh -lc 'cd $REMOTE_PATH && git rev-parse --short HEAD'")"
}

run_remote() {
   echo "==> 実行 ($REMOTE): $1"
   ssh "$REMOTE" "zsh -lc 'cd $REMOTE_PATH && $1'"
}

main() {
   if [ $# -eq 0 ]; then
      echo "使い方: $0 [--pjsr <script.js> | --fetch <path> | <コマンド>...]" >&2
      exit 2
   fi

   case "$1" in
      --fetch)
         # リモートで生成された成果物を手元へ持ってくる。
         shift
         for path in "$@"; do
            echo "==> 取得: $REMOTE:$REMOTE_PATH/$path"
            scp -q "$REMOTE:$REMOTE_PATH/$path" "$REPO/$path"
         done
         ;;
      --pjsr)
         shift
         [ $# -gt 0 ] || { echo "--pjsr にはスクリプトのパスが必要です" >&2; exit 2; }
         require_clean
         sync_remote
         # caffeinate を挟むのは、654 枚の検出に 8 分かかり、その間に
         # スリープすると処理が止まるため。
         local pi_cmd="$PIXINSIGHT -n --automation-mode --no-splash -r=$REMOTE_PATH/$1 --force-exit"
         if [ "${METEOR_NO_CAFFEINATE:-0}" = "1" ]; then
            run_remote "$pi_cmd"
         else
            run_remote "caffeinate -i $pi_cmd"
         fi
         ;;
      *)
         require_clean
         sync_remote
         run_remote "$*"
         ;;
   esac
}

main "$@"
