# CLAUDE.md

このファイルは、Claude Code (claude.ai/code) がこのリポジトリで作業する際のガイダンスです。

**PJSR コーディング規約・配布フロー・アカウント方針・座標系の注意は、上位の [`../CLAUDE.md`](../CLAUDE.md) を参照してください。** ここにはこのリポジトリ固有の内容のみを書きます。

---

## ⚠️ main への直接 push は行わないこと

**このリポジトリの main は保護されていません**（private + GitHub Free プランでは branch protection / ruleset のいずれも適用不可）。

**保護が無くても、保護されている場合と同じ手順を踏んでください。** git が拒否してくれないため、ここだけは自分で守る必要があります。

```bash
git checkout -b feature/<description>
git add <files>
git commit
git push -u origin feature/<description>
gh pr create --title "..." --body "..."
gh pr merge --merge --delete-branch
```

リリース時に public 化して保護を設定します（[docs/requirements.md](docs/requirements.md) の未決事項を参照）。

---

## プロジェクト概要

MeteorComposer は、一眼カメラで撮影した流星群の連番画像から流星を自動検出し、人手によるスクリーニングを経て流星群コンポジット画像を生成する PixInsight スクリプトです。PJSR ネイティブで完結し、Python や外部プロセスに依存しません。

機能要件の全体像は [docs/requirements.md](docs/requirements.md) にあります。設計判断の根拠（なぜ参照差分を使わないか、なぜ比較明合成では駄目か等）も同ドキュメントに記録しているので、方針を変えようとする前に必ず目を通してください。

### 現在の実装状況（Phase 1 進行中）

| ファイル | 内容 | 状態 |
|---|---|---|
| `javascript/detection_core.js` | 検出コア（純粋 JS） | 実装済み |
| `javascript/mask_geometry.js` | 除外領域 Tier 1 / Tier 2（純粋 JS） | 実装済み |
| `javascript/candidate_ops.js` | 共線マージ・横断照合 | 実装済み |
| `javascript/MeteorComposer.js` | UI とパイプライン統合（PJSR） | 未着手 |
| `tests/pjsr/probe_*.js` | PJSR API 実地調査 | 完了 |
| `tests/pjsr/probe_preview.js` | プレビュー生成の実測 | 完了 |
| `tests/pjsr/run_detection.js` | 実データでの検出実行 | 実装済み |
| `tests/eval/evaluate.js` | 正解との突き合わせ | 実装済み |

## コマンド

```bash
# Small テスト（Node.js。外部依存なし、秒オーダー）
node tests/ut/test_detection_core.js
node tests/ut/test_mask_geometry.js

# PJSR API 調査（PixInsight 必要）
/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight \
  -n --automation-mode --no-splash \
  -r="$(pwd)/tests/pjsr/probe_pjsr_api.js" --force-exit

# 実データでの検出実行（PixInsight + 評価用データ必要。654枚で約8分）
/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight \
  -n --automation-mode --no-splash \
  -r="$(pwd)/tests/pjsr/run_detection.js" --force-exit

# 検出性能の評価（テストではない。docs/tests.md 5 章）
node tests/eval/evaluate.js
node tests/eval/evaluate.js --save-baseline   # ベースライン更新
```

PJSR スクリプトの出力は標準出力に出ません。ログとレポートは評価用データのディレクトリに書かれます。

## 設計上の重要な決定

実装時に忘れると破綻する項目です。詳細と根拠は requirements.md の該当節を参照。

- **検出は単フレーム線検出。参照差分は使わない**（requirements.md 4.1）
  参照差分が消せるのは星と静的構造だけで、本当に難しい衛星・飛行機の除外には効かない。加えて固定撮影で地上景が入ると master light に地上物が流れて写り、差分が破綻する。

- **2 パス構成が前提**（requirements.md 4.3）
  1st pass は 1/8 縮小で全 500 枚をスクリーニング、2nd pass は通過した数枚のみ原寸で精密解析。ダウンサンプルは線状天体の S/N をむしろ約 3 倍改善するので、感度は落ちない。

- **除外領域は MAD 計算より前に適用する**（requirements.md 5.4）
  順序を間違えると、明るい地上景が統計に入って MAD が引き上げられ、空側の検出感度が丸ごと落ちる。背景モデル生成時も同様。

- **星の領域をゼロにしてはならない**（requirements.md 4.6）
  流星が星の上を通過している場合に 2 本の短い線に分断される。連結成分とモーメントを取った「後」に、候補の重心が星と一致するかで棄却する。

- **コンポジットに比較明合成（max）を使ってはならない**（requirements.md 7.3）
  サブフレームは master light よりノイズが大きく、マスク内の背景ノイズが master に勝つ。`master + residual × feathered_mask` で流星の光だけを加算する。

- **用語は Composition。Integration は使わない**（requirements.md 7.3）
  `ImageIntegration` の意味論（シグマクリップ、重み付け、リジェクション）を期待させるため。

- **プレビューは原寸（1:1）でレンダリングする**（requirements.md 7.1）
  縮小は流星痕を実際に壊す。実測で 1:3 に縮小すると軌跡のピークコントラストが 1:1 の 19% まで落ちた。`manual-image-solver` の `MAX_BITMAP_EDGE 2048` は 6024 px に対して約 1:3 にあたるので、**この上限を引き継いではいけない**。`Image.render()` は原寸でも 17〜26 ms なので縮小する動機が無い。`createStretchedBitmap()` の per-pixel ループも流用しない（ネイティブ API で足りる。上位 `../CLAUDE.md` 参照）。

- **検出座標から原寸への変換は単純な 8 倍ではない**（requirements.md 7.1）
  `full = (n + 0.5) * s - 0.5`。単純に掛けると 8×8 ブロックの左上隅を指し最大 4 px ずれる。流星痕は 1〜2 px 幅なのでこれで完全に外す。オーバーレイ描画とヒットテストの両方で使う。

## 実装前に確認が必要な PJSR API

存在は確実だが、引数と戻り値の正確な形をドキュメントで確認すること。

- `StarDetector` — 星検出。プロパティと `stars()` の戻り値の構造
- `IntegerResample` / `Image.resample()` — ダウンサンプル時の補間モード指定（median の可否）
- `Image.getLuminance()` — 輝度成分の抽出
- `Image.MAD()` / `Image.median()` — ロバスト統計
- `LinearFit` プロセスの PJSR からの呼び出し方法

V8 移行ガイドや CodeSign の公式ドキュメントの保存版が `../pixinsight-next-javascript/` にあります。

## 実データでの評価を実行する前に

**必ずコミットとプッシュを済ませること。** 検出性能の評価はベースライン比較であり、結果がどのコミットのものか追えなくなると評価そのものが意味を失います（`split-image-solver/CLAUDE.md` と同じ規約）。

評価用データ（外付け SSD）が繋がっているのは 1 台だけなので、実データを読む処理はそちらで動かします。`tools/run-remote.sh` が未コミット・未プッシュを検出して実行を拒否します。

```bash
tools/run-remote.sh --pjsr tests/pjsr/run_detection.js   # 実データで検出
tools/run-remote.sh node tests/eval/evaluate.js          # 評価
tools/run-remote.sh --fetch tests/eval/baseline.json     # 成果物を持ち帰る
```

**Node.js の Small テストはデータも PixInsight も不要なので手元で動きます。** リモートで動かす必要があるのは実データを読む処理だけです。

## 配布時の注意

新しいスクリプトなので、配信するには `pixinsight-scripts/integrate.sh` の `SOURCES` 配列への追記が必要です。

**V8 専用（PixInsight 1.9.4 以降）です。** SpiderMonkey には対応しません。既存 2 本が両対応なのは SpiderMonkey で書いたものを移植した経緯によるもので、本スクリプトには当てはまりません。配信する `<platform>` は `1.9.4:9.9.9` の 1 つだけです。

メニュー登録は機能カテゴリとベンダーカテゴリの両方に出します。`#feature-id` は 1 つのディレクティブ内で `|` 区切りで複数のメニュー位置を指定できます。

```
#feature-id  MeteorComposer : Image Analysis > MeteorComposer | ysmrastro > MeteorComposer
```

**本スクリプトの公開時に、既存 2 本も `ysmrastro` カテゴリへ同時掲載するよう変更します。** 詳細と手順は [docs/requirements.md](docs/requirements.md) の 8.3 を参照してください。

## テスト方針

**[docs/tests.md](docs/tests.md) を参照してください。** 実装前に押さえるべき点だけここに再掲します。

- **モジュール境界をプレーン配列に置く。** PJSR 依存は「XISF 読み込み → 輝度抽出 → 縮小」までに閉じ込め、`{ data: Float32Array, width, height }` を境界とする。これにより検出コアと候補処理の全体が Node.js で Small テストできる
- **テストと検出性能評価を混ぜない。** 閾値 `k` やスコアの重みは単体テストで検証できない。実データに対する評価（recall のベースライン比較）として分離する。混ぜるとテスト結果が信用されなくなる
- **モーメント計算の期待値は実装と独立に導出する。** w×h 矩形の分散は `w²/12`, `h²/12` なので伸長比は厳密に `h/w`。実装の関数を呼んで期待値を作らない（自作自演）
- **PJSR オブジェクトをモックして呼び出しを検証しない。** 実装への密結合になる。Medium テストでは本物の `Image` を使い、出力を検証する
- **合成フィクスチャの乱数は seed 固定。** `Math.random()` は使わない
