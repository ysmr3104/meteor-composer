#!/bin/bash
#
# build-release.sh - PixInsight リポジトリ配布パッケージのビルドスクリプト
#
# 使い方: bash build-release.sh
#
# 生成物:
#   repository/MeteorComposer-{VERSION}.zip  - 配布パッケージ
#   repository/updates-meteor.xri            - リポジトリ情報 XML
#
# ManualImageSolver / SplitImageSolver と違い platform ブロックは 1 つだけです。
# 本スクリプトは V8 専用（PixInsight 1.9.4 以降）で、SpiderMonkey 版は存在しません。
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAIN_SCRIPT="${SCRIPT_DIR}/javascript/MeteorComposer.js"
VERSION=$(grep '#define VERSION' "$MAIN_SCRIPT" | sed 's/.*"\(.*\)".*/\1/')
PACKAGE_NAME="MeteorComposer"
ZIP_NAME="${PACKAGE_NAME}-${VERSION}.zip"
REPO_DIR="${SCRIPT_DIR}/repository"
TMPDIR_BASE="${SCRIPT_DIR}/.build-tmp"
VERSION_RANGE="1.9.4:9.9.9"

# 出荷するファイル。MeteorComposer.js が #include するモジュールがすべて要ります。
# #include はテキスト連結なので、1 つでも欠けるとスクリプトが起動しません。
MODULES=(
    paths.js
    detection_core.js
    candidate_ops.js
    trail_colour.js
    mask_geometry.js
    classifier.js
    trail_mask.js
    composition.js
    preview_geometry.js
    session_model.js
)

echo "=== ${PACKAGE_NAME} v${VERSION} リリースビルド ==="

# 1. #include と MODULES が一致しているか確認する
#
# ここが食い違うと、パッケージは正常に作られたように見えて、インストールした
# 先で起動しません。エラーは Process Console にしか出ないので、外からは
# 「メニューを選んでも何も起きない」ようにしか見えません。
INCLUDED=$(grep '^#include' "$MAIN_SCRIPT" | sed 's/.*"\(.*\)".*/\1/' | sort)
LISTED=$(printf '%s\n' "${MODULES[@]}" | sort)
if [[ "$INCLUDED" != "$LISTED" ]]; then
    echo "エラー: #include と MODULES が一致しません" >&2
    echo "--- MeteorComposer.js の #include ---" >&2
    echo "$INCLUDED" >&2
    echo "--- build-release.sh の MODULES ---" >&2
    echo "$LISTED" >&2
    exit 1
fi
echo "#include と MODULES の一致を確認しました（${#MODULES[@]} ファイル）"

# 2. Small テストを走らせる
#
# 壊れたものを配布しないための最低限の関門です。実データを使う評価は
# tests/eval/ にあり、そちらは別途 tools/run-remote.sh で走らせます。
echo "Small テストを実行中..."
FAILED=0
for f in "${SCRIPT_DIR}"/tests/ut/*.js; do
    if ! node "$f" > /dev/null 2>&1; then
        echo "エラー: $(basename "$f") が失敗しました" >&2
        FAILED=1
    fi
done
if [[ $FAILED -ne 0 ]]; then
    echo "テストが通らないためビルドを中止します" >&2
    exit 1
fi
echo "Small テスト: 全通過"

# 3. 署名の有無を確認する
#
# 署名が無いと Execute Script で実行できません。警告に留めるのは、
# パッケージ自体は作れるからです（署名は PixInsight の CodeSign で行います）。
SIGNATURE="${SCRIPT_DIR}/javascript/${PACKAGE_NAME}.xsgn"
if [[ ! -f "$SIGNATURE" ]]; then
    echo "警告: ${PACKAGE_NAME}.xsgn がありません。" >&2
    echo "      PixInsight の CodeSign で javascript/ 以下に署名してください。" >&2
    echo "      署名の無いパッケージは Execute Script で実行できません。" >&2
fi

# 4. 一時ディレクトリに PixInsight インストール構造を作成
mkdir -p "${REPO_DIR}"
rm -rf "${TMPDIR_BASE}"
mkdir -p "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}"

cp "${MAIN_SCRIPT}" "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"
for m in "${MODULES[@]}"; do
    cp "${SCRIPT_DIR}/javascript/${m}" "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"
done
if [[ -f "$SIGNATURE" ]]; then
    cp "$SIGNATURE" "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"
fi

echo "ファイルをコピーしました:"
ls -la "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"

# 5. zip を作成（同名ファイルのみ削除して再生成）
rm -f "${REPO_DIR}/${ZIP_NAME}"
cd "${TMPDIR_BASE}"
zip -r "${REPO_DIR}/${ZIP_NAME}" src/
cd "${SCRIPT_DIR}"

echo "zip を作成しました: repository/${ZIP_NAME}"

# 6. SHA1 計算
SHA1=$(shasum "${REPO_DIR}/${ZIP_NAME}" | awk '{print $1}')
echo "SHA1: ${SHA1}"

RELEASE_DATE=$(date +%Y%m%d)

# 7. updates-meteor.xri を生成
#
# ファイル名を updates.xri にしないのは、pixinsight-scripts の integrate.sh が
# 各ソースの中間 xri を名前で区別して集めるためです。
cat > "${REPO_DIR}/updates-meteor.xri" << XMLEOF
<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <title>MeteorComposer</title>
      <brief_description>Detect, screen and composite meteors in PixInsight</brief_description>
   </description>
   <platform os="all" arch="noarch" version="${VERSION_RANGE}">
      <package fileName="${ZIP_NAME}"
               sha1="${SHA1}"
               type="script"
               releaseDate="${RELEASE_DATE}">
         <title>MeteorComposer</title>
         <description>
            <p>Detect meteors across a night of registered frames, screen the candidates by eye, and composite the accepted ones onto a master light.</p>
         </description>
      </package>
   </platform>
</xri>
XMLEOF

echo "updates-meteor.xri を生成しました"

rm -rf "${TMPDIR_BASE}"

echo ""
echo "=== ビルド完了 ==="
echo "  ${REPO_DIR}/${ZIP_NAME} (${VERSION_RANGE})"
echo "  ${REPO_DIR}/updates-meteor.xri"
echo "  SHA1: ${SHA1}"
