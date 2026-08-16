# MeteorComposer

一眼カメラで撮影した流星群の連番画像から流星を自動検出し、人手によるスクリーニングを経て、流星群コンポジット画像を生成する PixInsight スクリプトです。

Python や外部プロセスを必要とせず、PJSR のみで動作します。

> **開発状況**: 要件整理段階です。まだ動作するスクリプトはありません。
> 機能要件は [docs/requirements.md](docs/requirements.md) を参照してください。

---

## できること（計画）

| Stage | 内容 | 対応 Phase |
|---|---|---|
| 1. 検出 | 全フレームを走査し、流星候補のリストを生成 | Phase 1 |
| 2. スクリーニング | 候補リストとプレビューを表示し、人の目で採否を判断 | Phase 1 |
| 3. マスク生成 | 採用した候補の流星痕マスクを出力 | Phase 3 |
| 4. コンポジット | master light に流星だけを合成した画像を生成 | Phase 4 |

衛星・飛行機の除外はパラメータで厳しさを調整できます。地上景などの検出対象外エリアを、回転可能な直線で指定することもできます。

## 対象とする撮影データ

WBPP で位置合わせ・デベイヤーまで済んだ registered 画像を入力とします。

- 赤道儀による追尾撮影
- 三脚による固定撮影（**NPF ルールを遵守し、星が点像に写っているもの**）

星が線状に流れるレベルの固定撮影は、StarAlignment が通らないため対象外です。固定撮影の場合は視野が時間とともに流れるため、焦点距離に応じた撮影時間の上限があります。詳細は [docs/requirements.md](docs/requirements.md) の「撮影条件の推奨範囲」を参照してください。

## 動作環境

- PixInsight 1.8.9 以降
- 外部依存なし

## インストール

配信リポジトリ経由でインストールできるようになる予定です。

```
https://ysmrastro.github.io/pixinsight-scripts/
```

## 関連プロジェクト

| プロジェクト | 内容 |
|---|---|
| [manual-image-solver](https://github.com/ysmr3104/manual-image-solver) | 手動プレートソルバー |
| [split-image-solver](https://github.com/ysmr3104/split-image-solver) | 広角星野写真向け分割プレートソルバー |

## ライセンス

未定
