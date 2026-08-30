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
| `javascript/trail_colour.js` | 候補の色測定（純粋 JS。sampler を受け取る） | 実装済み・配線済み |
| `javascript/mask_geometry.js` | 除外領域 Tier 1 / Tier 2、辺バンド → 半平面の変換、マスク画像の閾値（純粋 JS） | 実装済み・include 済み。**実データ検証は未了** |
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

- **registered の「データが無い」領域を背景モデルと統計から外す**（requirements.md 5.6）
  WBPP は固定キャンバスに書くので、位置合わせではみ出した部分が厳密なゼロになる（片側の帯は常に、楔は最大 38%）。境界に跨る背景ブロックの中央値が空とゼロの間に落ち、**引きすぎた残差が境界沿いの直線として検出される。** 411 候補のうち 61 件がこれだった。
  **ただし縁から一律に除外してはならない。** 正解流星が縁から 4 px の所にあり、それは visual（ハードゲート）である。「縁の近く」ではなく「境界に沿っている」で判定する（`edgeContact`、実測で偽陽性 49〜100% 対 流星 0〜5%）。

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

---

## 普遍的な原則は handbook にある

**失敗から抽出した原則のうち、このスクリプトに依存しないものは `pixinsight-handbook` へ移しました。**

- 一覧: `~/projects/pixinsight/CLAUDE.md`（親として自動で読まれます）
- 根拠: `~/projects/pixinsight/pixinsight-handbook/docs/lessons.md`

移したのは、PJSR が黙って失敗するところ（`Image.apply()` の第 4 引数、`ScrollBox.autoScrolls` が存在しない、`#include` していない sibling への遅延 `require`、フィールドの欠落）、測り方（テストが思い込みに同意する／実装したと効いているは別／検証の軸／範囲内は正しいではない／1 つの数値で 2 つの故障）、設計（永続化・表示リストの位置）、操作者への向き合い方（回避策を証拠にしない・UI に実装用語を出さない）です。

**ここに残しているのは、このリポジトリ固有の事情がある節だけです。**

---

## MeteorComposer.js の構文は自動で検査される

**長い間、誰も検査していなかった。** 純粋モジュールは自身のテストが `require` するので構文エラーは即座に落ちるが、`MeteorComposer.js` は PJSR オブジェクトとプリプロセッサ指令だらけでどのテストも読み込んでいなかった。3000 行のファイルを編集して、確認手段が PixInsight での実行だけという状態だった。

`tests/ut/test_module_isolation.js` が指令を除去して `vm.Script` で**構文解析だけ**行う（実行はしない。実行には PJSR のオブジェクトモデル全部が必要になる）。指令の除去は行継続を考慮すること — `#feature-info` はバックスラッシュで 2 行にまたがっており、1 行目だけ消すと 2 行目が地の文として残る。

同じファイルが、実行しないと分からないはずの不変条件も静的に押さえている。`#engine v8` が 1 行目にあること、`VERSION` の形、`#include` の解決、`MODULES` との一致、`currentDisplayedRow()` 以外から選択行を読まないこと、ラジオの `checked` をペアとして 1 か所からしか書かないこと。**「この形で書いてはいけない」に落とせるものはここへ落とす。**

**静的検査をここ以外に作らないこと。** 2026-08-30 に `test_script_syntax.js` を別に作ったが、構文解析と `#include` の実在確認は**すでにこのファイルにあった**。検査が 2 か所にあると、次に足す人はどちらにも見つけられない。統合して 1 本に戻した。

---

## 判定規則が複数あるなら、パラメータも別々に持たせて測る

横断照合には**近接**（重心が円の中）と**共線連続**（新しい軌跡が古い軌跡の延長線上）の 2 規則があり、フレーム間隔の上限を共有していた。**同じ到達距離を与えるべきではなかった。** 4 フレームの近接は直径 400 サンプルの円でほぼ何でも繋ぐが、4 フレームの共線連続は依然として同じ直線上にあることを要求する。

実測では**両方を 4 に上げると正解流星を 1 本失い、連続だけを上げると失わなかった。** 共有していた間は「間隔を広げると正解を失う」としか見えず、片方だけなら安全だという事実に到達できない。

**規則ごとに何を要求しているかが違うなら、閾値も分けて、分けた状態で測ること。**

---

## 登録済みフレームには「データが無い」領域があり、統計はそれを除外しないと歪む

登録で回転と平行移動が入るので、フレームには参照から外れた領域が残る。そこは 0 で、**master（夜全体の積分）にはそこに空がある。**

`fitOnGrid` はこれを除外していなかった。その画素は `(master = 空, sub = 0)` として最小二乗に入り、**欠損割合に比例した系統的バイアス**で傾きを 0 方向へ引く。実測では欠損 38.7% のフレームで傾きが 0.097（除外後 0.166）、正常なフレームでも 0.42% の欠損で 1.052 → 1.040 とずれていた。**ノイズではないので、サンプルを増やしても消えない。**

判定は `v > 0`。校正後の空は 8.5e-3 付近なので、0 以下は暗い空ではなく欠損である。閾値を置く必要は無い。

同じ理由で `localBackground` も除外する。欠損部の残差は「空 1 枚ぶんのマイナス」で、中央値が耐えられるのは欠損がリングの少数派である間だけ。

**新しく画素統計を足すときは必ず同じ除外を入れる。** 平均・中央値・分散・相関、どれも影響を受ける。

---

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

**public・1.2.0 配信済みです（2026-08-30）。** main は保護済み（PR 必須・承認 0 件・管理者にも強制・force push 禁止・ブランチ削除禁止）。`pixinsight-scripts/integrate.sh` の `SOURCES` にも追加済みで、配信の実地確認（zip をダウンロードして SHA1 照合・旧版が 404・紹介ページの反映）まで済んでいます。

> 2026-08-17 の時点では「Stage 4 まで実装してから公開する。当面 private のままなので署名・ビルド・配信は行わない」と書いてありました。**その状態はとうに過ぎています。** 経緯は [docs/requirements.md](docs/requirements.md) 9 章にあります。

リリースの手順は `~/projects/pixinsight/pixinsight-handbook/docs/release.md` にあります。**署名だけはユーザーの操作が必要**で、1 回のリリースにつき `.js` と `updates.xri` の 2 回です。

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
