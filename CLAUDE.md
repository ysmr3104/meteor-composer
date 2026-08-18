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

### 現在の実装状況（Stage 1〜4 が実データで通っている。2026-08-18）

**未検証のものは「未検証」と書く。** 動くはずだが確かめていないものを「実装済み」と書くと、次にこのファイルを読む者がそれを前提に積み上げる。

| ファイル | 内容 | 状態 |
|---|---|---|
| `javascript/paths.js` | ファイル名・出力先の決定（純粋 JS） | 実装済み |
| `javascript/detection_core.js` | 検出コア（純粋 JS） | 実装済み |
| `javascript/mask_geometry.js` | 除外領域 Tier 1 / Tier 2（純粋 JS） | 実装済み・**未 include**（Tier 1 の UI が未着手） |
| `javascript/candidate_ops.js` | 共線マージ・横断照合 | 実装済み |
| `javascript/preview_geometry.js` | オーバーレイの座標変換・ヒットテスト（純粋 JS） | 実装済み |
| `javascript/session_model.js` | スクリーニング状態・判定・JSON 往復（純粋 JS） | 実装済み |
| `javascript/classifier.js` | 固定構造・軌跡・色によるスコアリング（純粋 JS） | 実装済み |
| `javascript/trail_mask.js` | corridor と、光から作るマスク（純粋 JS） | 実装済み |
| `javascript/composition.js` | フィット・局所背景・加算合成（純粋 JS） | 実装済み |
| `javascript/MeteorComposer.js` | UI とパイプライン統合（PJSR） | 実装済み・**GUI 実動作を確認済み** |
| `tests/ut/*.js` | Small テスト（1001 アサーション） | 全通過 |
| `tests/pjsr/probe_*.js` | PJSR API・プレビュー・色・回転・チャンネル書き戻しの実測 | 完了 |
| `tests/pjsr/probe_trail_profile.js` / `probe_trail_flare.js` | 流星光の広がりの実測（マスク寸法の根拠） | 完了 |
| `tests/pjsr/run_detection.js` | 実データでの検出実行 | 実装済み・**決定性は未確認** |
| `tests/pjsr/run_composite.js` | 実データでのコンポジット生成 | 実装済み |
| `tests/pjsr/verify_composite.js` | 出力の正しさの検査 | 実装済み |
| `tests/pjsr/compare_composites.js` | UI 経路と probe 経路の一致検査 | 実装済み（ビット単位で一致） |
| `tests/eval/evaluate.js` | 正解との突き合わせ | 実装済み |
| `tests/eval/analyze_mask.js` | マスク幾何とフレーム間の重なりの分析 | 実装済み |

**GUI で確認済み**（2026-08-18、Screening モード・411 候補・31 本採用）: Score 列、スコア順ソート、カットオフのプリセット、衛星・飛行機のフィルタ、判定フィルタ、プレビューの回転保持・拡大ペイン・STF 固定、自動保存の復元、`Compose...`（パス推定・進捗表示・除外理由のコンソール出力）。

**書き出し先は 1 か所にまとめてある。** `Source / Destination` の `Output:` で指定したディレクトリに、`detection_results.json`・`meteor_session.json`（判定ごとに自動保存）・コンポジットのすべてが入る。**frames ディレクトリには何も書かない**（操作者の入力データなので）。既定値は frames の親（親が `registered` なら更にその上）で、Settings に保存される。

**まだ確認していないこと**: GUI の `Run detection` の実動作（これまで検出はヘッドレスの `run_detection.js` でしか回していない）。および 2 回回して同じ結果が出るか（決定性）。判定は `file` + `indexInFrame` で紐づいているので、**ここがずれるとスクリーニングのやり直しになる**。

## コマンド

```bash
# Small テスト（Node.js。外部依存なし、秒オーダー）
node tests/ut/test_detection_core.js
node tests/ut/test_mask_geometry.js
node tests/ut/test_candidate_ops.js
node tests/ut/test_preview_geometry.js
node tests/ut/test_session_model.js
node tests/ut/test_module_isolation.js   # #include の名前衝突と V8 定数の静的検査

# まとめて実行
for f in tests/ut/*.js; do node "$f" | tail -2; done

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

- **合成は「手つかずの master に対するフィット」＋「0 でクリップした加算」**（requirements.md 7.1.10 / 7.3）
  `master + max over frames( max(0, sub − fit(master) − 局所背景) × feathered_mask )`。マスク内では比較明合成と等価で、**出力が master より暗くなる経路を持たない**。
  かつて「比較明合成を使ってはならない」としていたが 2026-08-18 に撤回した。棄却理由（マスク内がザラつく）は、マスクを実測した光の広がりまで切り詰めた時点で成立しなくなり、クリップしないことの害（黒抜け）のほうが大きかった。
  **フレームごとに合成結果へ書き戻してはならない。** 露出をまたいだ流星の 2 枚目が 1 枚目の光を引き算し、真っ黒に抜ける。

- **マスクは幾何ではなく光から作る**（requirements.md 7.1.11）
  候補が持つ軸は 1/8 場の端点由来で、**実測で最大 12 px 実際の痕からずれる**（平行移動と回転の両方）。カプセルの半径をどう調整しても解けない。カプセルは「探す範囲（corridor）」であって、マスクは corridor 内で残差が平滑化ノイズの 3σ を超え、かつ芯に連結した領域とする。
  `minorLength` は 1/8 場で測った値なので光の広がりとは無相関（幅 43 px の候補の光は 3 px）。係数を掛けてはいけない。

- **用語は Composition。Integration は使わない**（requirements.md 7.3）
  `ImageIntegration` の意味論（シグマクリップ、重み付け、リジェクション）を期待させるため。

- **プレビューは原寸（1:1）でレンダリングする**（requirements.md 7.1）
  縮小は流星痕を実際に壊す。実測で 1:3 に縮小すると軌跡のピークコントラストが 1:1 の 19% まで落ちた。`manual-image-solver` の `MAX_BITMAP_EDGE 2048` は 6024 px に対して約 1:3 にあたるので、**この上限を引き継いではいけない**。`Image.render()` は原寸でも 17〜26 ms なので縮小する動機が無い。`createStretchedBitmap()` の per-pixel ループも流用しない（ネイティブ API で足りる。上位 `../CLAUDE.md` 参照）。

- **検出座標から原寸への変換は単純な 8 倍ではない**（requirements.md 7.1）
  `full = (n + 0.5) * s - 0.5`。単純に掛けると 8×8 ブロックの左上隅を指し最大 4 px ずれる。流星痕は 1〜2 px 幅なのでこれで完全に外す。オーバーレイ描画とヒットテストの両方で使う。

## PJSR の沈黙する失敗（実測で確定させたもの）

例外も警告も出ないまま何もしない呼び出しがある。**推測で書くと、動いているように見えて出力だけが間違う。**

- **`Image.apply()` の第 4 引数 `channel` は書き込み先。** `firstChannel` / `lastChannel` は**ソース側**のチャンネル範囲。1 チャンネルのソースに対して `firstChannel = 1` を渡すと選択されるものが無く、**例外も出さず何も書かずに戻る**。チャンネル別に書き戻す正しい形は次のとおり（`tests/pjsr/probe_channel_write.js` で 5 通りを実測）。

  ```js
  image.apply(channelImage, ImageOp.Mov, new Point(0, 0), targetChannel);
  ```

  この取り違えで、コンポジットが R チャンネルにしか光を持たない状態になった。`Image.assign()` は代替にならない（画像全体を置き換えるので 3ch が 1ch になる）。

- **`ScrollBox.autoScrolls` は存在しない**（実際は `horizontalAutoScroll` / `verticalAutoScroll`）。JS は任意のプロパティを代入できるので、既存 2 スクリプトで一度も効いていなかった。

- **`new Image(TypedArray, w, h, 3, ColorSpace.RGB)` の並びは planar**（`[R 全部][G 全部][B 全部]`）。

- **`//` 行コメントの中に `/*` を書いてはいけない。** PixInsight のプリプロセッサは JavaScript を読まない。行コメント内の `/*` をブロックコメントの開始と解釈し、閉じが見つからず**ファイルを丸ごと拒否する**（`*** Error: ..., line 44: Unterminated block comment.` が出てスクリプトが起動しない）。ディレクトリ構成を説明するコメントに `<group>/*.xisf` のようなグロブを書くと踏む。**`node --check` は通る**（JS としては正しいため）。文字列リテラル内の `/*` は問題ない（`FileFind` に `dir + "/*"` を渡すのは全域で使っている）。`tests/ut/test_module_isolation.js` が静的に検査する。

- **`FileDialog.filters` は拡張子を配列の要素ごとに 1 つずつ渡す。** `[["Images", "*.xisf *.fit *.fits"]]` のようにスペース区切りの 1 文字列にすると**どのファイルにもマッチせず**、ダイアログにファイルが 1 つも出ない（フォルダだけが選べて `Open` が disable になる）。エラーは出ない。正しい形は `[["FITS Files", "*.fit", "*.fits", "*.fts"]]`。画像を選ばせるなら手書きせず `dlg.loadImageFilters()` を使う。

- **`FileDialog.initialPath` はディレクトリ。** ファイル名まで含めたパスは同梱スクリプトに用例が無い（`sfd.initialPath = engine.params.workingDir`）。保存ダイアログでは `overwritePrompt = true` を明示すること。

- **`fileName` / `fileNames` は非推奨。** 正は `filePath` / `filePaths`（`OpenFileDialog` / `SaveFileDialog` 双方）。

- **`TextAlign` というクラスは存在しない。** 正は `TextAlignment`、垂直中央は `VerticalCenter`（`VertCenter` ではない）。旧定数の `TextAlign_Right` からアンダースコアを取っただけでは直らない。**存在しないクラスを参照すると構築時に例外が出て、ダイアログが黙って出ないだけになる。** `tests/ut/test_module_isolation.js` が静的に検査する。

## UI に実装用語を出してはいけない

**2 回続けて同じ失敗をした。** どちらも操作者から「意味が分からない」と言われて気づいた。

| UI にあった語 | 操作者に伝わらなかった理由 | 直した先 |
|---|---|---|
| `Hide persistent tracks` | `persistent` は実装の分類名。何が隠れるのか分からない | `Hide satellites and aircraft` |
| `drop fixed structures` | `fixed structure` は設計ノートの語。何を落とすのか分からない | `drop what never moves` |

**書くのは観測であって、内部の分類名ではない。** 「registered 座標で静止している」は我々の言葉で、操作者に必要なのは「同じ場所に何度も出る = 何も飛んでいない」である。原因（恒星起因）は推論なので、断定せず「a star, most likely」と添える。

リスト列も同様に `22 fixed` → `same place x22` にした。列は狭いが、**短さより「読んで意味が分かること」を優先する。**

**テストも語ではなく意味で書くこと。** 分類器のテストが理由文に `stationary` という語を含むかを見ていたため、操作者向けに書き直した時点で失敗した。守るべき性質（「衛星と言ってはいけない」）は保たれていたのに、である。現在は「never moves / same place のいずれかを含み、satellite / aircraft を含まない」を検査している。

## 検証は、バグが乗っている軸を畳み込んではいけない

上の `apply()` のバグは、こちらの検証を一度すり抜けた。コンポジットの検査が**マスク内の加算量を 3 チャンネル通算で見ていた**ため、R だけが光を受け取り G と B がゼロの状態でも合計は正になり「PASS」と報告された。

**集約する軸の選び方が検査の感度を決める。** チャンネルごとの不具合を探すならチャンネルごとに出す。合計しか見ない検査は、合計が保たれる誤りをすべて見逃す。

**同じ誤りを 2 度やっている。** マスク内の検査を「平均が正であること」と書いていたため、2 枚にまたがった流星が互いの光を引き算して**真っ黒に抜けている状態で PASS していた**（requirements.md 7.1.10）。穴は平均に埋もれる。現在は「1 画素も暗くなっていないこと」を検査している。

**要件が「常に成り立つ」形なら、検査もその形で書くこと。** 「光を加算する処理である」の検査は平均ではなく最小値である。平均・合計・割合で書いた検査は、その統計量が保たれる誤りに対して盲目になる。

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

**公開は Stage 4（コンポジット生成）まで実装してからです（2026-08-17 決定）。** Phase 1 完成時に公開する方針は撤回しました。当面は private のまま開発を続けるため、**署名・ビルド・配信の作業はまだ行いません**。判断の根拠と、この変更で失うものは [docs/requirements.md](docs/requirements.md) 9 章「公開時期の変更」にあります。

**private が長く続くぶん、上の「main への直接 push は行わない」が効いてきます。** GitHub Free プランでは private リポジトリに branch protection を適用できず、git が拒否してくれない期間が延びます。

以下は公開時に必要になる事項です。

新しいスクリプトなので、配信するには `pixinsight-scripts/integrate.sh` の `SOURCES` 配列への追記が必要です。

**V8 専用（PixInsight 1.9.4 以降）です。** SpiderMonkey には対応しません。既存 2 本が両対応なのは SpiderMonkey で書いたものを移植した経緯によるもので、本スクリプトには当てはまりません。配信する `<platform>` は `1.9.4:9.9.9` の 1 つだけです。

メニュー登録は機能カテゴリとベンダーカテゴリの両方に出します。`#feature-id` は 1 つのディレクティブ内で `|` 区切りで複数のメニュー位置を指定できます。

```
#feature-id  MeteorComposer : Image Analysis > MeteorComposer | ysmrastro > MeteorComposer
```

既存 2 本の `ysmrastro` カテゴリ掲載（8.3）は、**本スクリプトの公開から切り離しました。** ManualImageSolver / SplitImageSolver のメニュー登録先を増やす作業に MeteorComposer は必要なく、待つ理由がありません。やりたくなった時点で単独で実施できます。手順は [docs/requirements.md](docs/requirements.md) の 8.3 を参照してください。

## テスト方針

**[docs/tests.md](docs/tests.md) を参照してください。** 実装前に押さえるべき点だけここに再掲します。

- **モジュール境界をプレーン配列に置く。** PJSR 依存は「XISF 読み込み → 輝度抽出 → 縮小」までに閉じ込め、`{ data: Float32Array, width, height }` を境界とする。これにより検出コアと候補処理の全体が Node.js で Small テストできる
- **テストと検出性能評価を混ぜない。** 閾値 `k` やスコアの重みは単体テストで検証できない。実データに対する評価（recall のベースライン比較）として分離する。混ぜるとテスト結果が信用されなくなる
- **モーメント計算の期待値は実装と独立に導出する。** w×h 矩形の分散は `w²/12`, `h²/12` なので伸長比は厳密に `h/w`。実装の関数を呼んで期待値を作らない（自作自演）
- **PJSR オブジェクトをモックして呼び出しを検証しない。** 実装への密結合になる。Medium テストでは本物の `Image` を使い、出力を検証する
- **合成フィクスチャの乱数は seed 固定。** `Math.random()` は使わない
