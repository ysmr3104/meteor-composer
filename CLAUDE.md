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

**現在は要件整理段階で、実装コードはまだありません。**

機能要件の全体像は [docs/requirements.md](docs/requirements.md) にあります。設計判断の根拠（なぜ参照差分を使わないか、なぜ比較明合成では駄目か等）も同ドキュメントに記録しているので、方針を変えようとする前に必ず目を通してください。

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

## 実装前に確認が必要な PJSR API

存在は確実だが、引数と戻り値の正確な形をドキュメントで確認すること。

- `StarDetector` — 星検出。プロパティと `stars()` の戻り値の構造
- `IntegerResample` / `Image.resample()` — ダウンサンプル時の補間モード指定（median の可否）
- `Image.getLuminance()` — 輝度成分の抽出
- `Image.MAD()` / `Image.median()` — ロバスト統計
- `LinearFit` プロセスの PJSR からの呼び出し方法

V8 移行ガイドや CodeSign の公式ドキュメントの保存版が `../pixinsight-next-javascript/` にあります（mbp4yossy のみ）。

## 配布時の注意

新しいスクリプトなので、配信するには `pixinsight-scripts/integrate.sh` の `SOURCES` 配列への追記が必要です。

**V8 専用（PixInsight 1.9.4 以降）です。** SpiderMonkey には対応しません。既存 2 本が両対応なのは SpiderMonkey で書いたものを移植した経緯によるもので、本スクリプトには当てはまりません。配信する `<platform>` は `1.9.4:9.9.9` の 1 つだけです。

メニュー登録は機能カテゴリとベンダーカテゴリの両方に出します。`#feature-id` は 1 つのディレクティブ内で `|` 区切りで複数のメニュー位置を指定できます。

```
#feature-id  MeteorComposer : Image Analysis > MeteorComposer | ysmrastro > MeteorComposer
```

**本スクリプトの公開時に、既存 2 本も `ysmrastro` カテゴリへ同時掲載するよう変更します。** 詳細と手順は [docs/requirements.md](docs/requirements.md) の 8.3 を参照してください。

## テスト方針

未定。実装開始時に決めます。既存 2 プロジェクトの構成が参考になります。

- `manual-image-solver` — Node.js 単体テスト（数学関数）＋ PJSR 統合テスト
- `split-image-solver` — UT / IT-Solver / IT-Wavefront / E2E の 6 分類、ベースライン管理あり
