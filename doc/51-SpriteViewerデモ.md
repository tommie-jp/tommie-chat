# 51. SpriteViewer デモ（RPGツクール キャラチップ表示）

## 概要

RPGツクールのキャラチップ画像を Babylon.js のスプライトとして3D空間に表示するツール。
キャラチップのフォーマット自動判定、背景色透過、方向順変換などの機能を持つ。

対応フォーマット: MV/MZ, VX/VXAce, XP, 2000, 2003

## ディレクトリ構成

```text
lib/babylon-rpgmaker-sprites/
  src/
    RpgMakerSpriteSheet.ts   ... ライブラリ本体（他プロジェクトでも利用可）
  index.html                 ... デモ（Babylon.jsで歩行アニメを表示）
```

## 起動方法

プロジェクトルートから:

```bash
cd lib/babylon-rpgmaker-sprites
npx vite
```

ブラウザで `http://localhost:5173` を開く。

### 注意

- `file://` プロトコルでは動作しない（ES module の CORS 制約）
- Vite が `.ts` の import を自動的に処理するため、ビルド不要
- Babylon.js は CDN から読み込まれるため、オンライン環境が必要

## 操作方法

### PC

| 操作 | 動作 |
| --- | --- |
| 左ドラッグ | カメラ回転 |
| ホイール | ズーム |
| 右ドラッグ | パン |
| ファイルドロップ | 素材切替 |

### スマホ

| 操作 | 動作 |
| --- | --- |
| 1本指ドラッグ | カメラ回転 |
| ピンチ | ズーム |
| 2本指ドラッグ | パン |
| ハンバーガーメニュー → 選択 | 素材切替 |

## ライブラリ API

`src/RpgMakerSpriteSheet.ts` は Babylon.js に依存しない純粋関数群。
tommieChat 本体や他プロジェクトから import して使える。

### 主な関数

| 関数 | 説明 |
| --- | --- |
| `analyzeSheet(w, h)` | 画像サイズからフォーマット・フレームサイズを自動判定 |
| `cellIndex(info, col, row, dir, frame)` | スプライトシートのセルインデックスを計算 |
| `animRange(info, col, row, dir)` | 歩行アニメーションの範囲を返す |
| `buildTransparentPNG(src, r, g, b, thresh, scale)` | 背景色を透過処理したPNGを生成 |
| `sampleBgColor(src)` | 四隅ピクセルから背景色を推定 |
| `worldDirToSpriteDir(mvx, mvz, camAlpha)` | 移動方向とカメラ角からスプライト方向を算出 |
| `detectDirOrder(img, fw, fh, cols, rows)` | 肌色解析で方向順序を自動検出 |

### 使用例

```ts
import {
  analyzeSheet,
  cellIndex,
  buildTransparentPNG,
} from './src/RpgMakerSpriteSheet.ts';

// シート解析
const info = analyzeSheet(576, 384);
// { format: 'MV', frameW: 48, frameH: 48, charCols: 4, charRows: 2, ... }

// セルインデックス（キャラ0,0 / 下向き / フレーム1）
const idx = cellIndex(info, 0, 0, 0, 1);

// 背景透過PNG生成
const result = await buildTransparentPNG(imgSrc, 0, 0, 0, 30);
// result.dataURL, result.info, result.finalScale
```

## 将来の予定

- ライブラリを別 git リポジトリに分離し、npm パッケージ化
- tommieChat 本体からは `npm install` で依存として取り込む
