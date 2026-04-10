# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

tommieChat — ブラウザで動く3D MMOチャット。Babylon.js (3Dエンジン) + Nakama (ゲームサーバー) + Vite (ビルド)。
チャット主体のアバターSNS（アメーバPigg 立体版）を目指している。
同接1000人(最低でも100人)、商用レベルのクオリティを目指している。

## Build & Dev Commands

```bash
npm run dev          # Vite dev server (HMR)
npm run build        # tsc + vite build → dist/
npm run check        # TypeScript type check (tsc --noEmit)
npm run test         # Vitest run
npm run test:watch   # Vitest watch mode
npm run preview      # Preview production build
```

**Nakama server:**

```bash
bash nakama/doBuild.sh --fresh       # Go plugin ビルド (.so)
bash nakama/doRestart.sh             # dev/prod 自動判定で再起動 (whoami=deploy なら本番)
bash nakama/doDeploy.sh              # 本番デプロイ (dist + nginx設定 + CSP)
bash nakama/doVersionUp.sh [X.Y.Z]   # public/js/app-init.js と package.json のバージョン更新
```

## Architecture

### Client (TypeScript, `/src/`)

| File                    | Role                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `main.ts`               | Entry point                                                             |
| `GameScene.ts`          | Babylon.js scene, player movement, block placement, chunk rendering     |
| `NakamaService.ts`      | Nakama SDK wrapper — auth, WebSocket, RPC, chat, presence               |
| `UIPanel.ts`            | All UI — login, chat input/overlay, menus, panels, tooltips, room list  |
| `DebugOverlay.ts`       | Debug panel — rendering settings, theme, chat overlay config, profiling |
| `AOIManager.ts`         | Area of Interest — visible chunk calculation, server sync               |
| `SpriteAvatarSystem.ts` | 2D sprite avatar rendering (32x32 spritesheet)                          |
| `AvatarSystem.ts`       | 3D mesh avatar (legacy)                                                 |
| `NPCSystem.ts`          | NPC アバター（自動歩行・自動チャット）                                  |
| `CloudSystem.ts`        | 空の雲メッシュ                                                          |
| `Minimap.ts`            | 2Dミニマップ（DynamicTextureでチャンク表示）                            |
| `ChunkDB.ts`            | IndexedDB chunk cache                                                   |
| `WorldConstants.ts`     | `CHUNK_SIZE=16`, `CHUNK_COUNT=64`, `WORLD_SIZE=1024`                    |
| `Profiler.ts`           | ブラウザ側関数プロファイラ（サーバ側 prof() と対応）                    |
| `i18n.ts`               | 多言語化（`i18n/ja.ts`, `i18n/en.ts`）                                  |
| `AutoChatMessages.ts`   | 34.AutoChat 用メッセージ一覧                                            |
| `utils.ts`              | `escapeHtml` 等の共通ユーティリティ                                     |

### Public assets (`/public/js/`)

CSP の `'unsafe-inline'` を排除するため、`index.html` のインラインスクリプトは外部化済み。

| File                   | Role                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `app-init.js`          | `APP_VERSION` / `APP_DATE` 定数、ツールチップ初期化（defer）      |
| `panel-flash-guard.js` | 起動時 FOUC 防止（同期ロード）                                    |
| `theme-init.js`        | テーマ初期化（同期ロード）                                        |
| `sw-register.js`       | Service Worker 登録                                               |
| `custom-tooltip.js`    | カスタムツールチップ                                              |

### Server (Go, `/nakama/go_src/main.go`)

Single Go file (~3000 lines) containing:

- RPC handlers: `ping`, `getWorldMatch`, `setBlock`, `getGroundChunk`, `syncChunks`, `createRoom`, `deleteRoom`, `listRooms`, etc.
- Match loop (10 Hz): AOI-filtered broadcast of movement, blocks, presence
- World data: 64×64 chunks of 16×16 cells, FNV-1a hash for delta sync
- 部屋システム: 部屋ごとに地面データを `world_data` collection の `w<id>_chunk_X_Z` キーで保存。プレイヤー数を `worldPlayerCounts sync.Map` で追跡し、0人のときのみ削除可
- 表示名キャッシュ: `displayNameCache` に `DisplayName` を保存（空なら `Username` フォールバック）
- CCU tracking with Prometheus metrics

### Communication

- **Login**: HTTP REST → `authenticateDevice` (device ID in localStorage + Cookie for PWA bridge)
- **Real-time**: WebSocket match messages with opcodes (`OP_MOVE_TARGET=2`, `OP_BLOCK_UPDATE=4`, etc.)
- **Chat**: Nakama channel chat (`joinChat("world")`)
- **RPC**: `socket.rpc("funcName", payload)` for request-response

### Docker Services (`/nakama/docker-compose.yml`)

ベース定義 (`docker-compose.yml`) に dev/prod overlay を重ねて起動する。

- `docker-compose.dev.yml` — dev 用（nginx を `0.0.0.0:80` で公開、Vite devサーバへプロキシ）
- `docker-compose.prod.yml` — 本番用（nginx を `127.0.0.1:8081:80` で公開、ホスト側 nginx で TLS 終端）

サービス: PostgreSQL / Nakama (7350 HTTP+WS, 7351 Console, 9100 Prometheus) / Nginx (web) / MinIO (9000 S3, 9001 Console) / Prometheus

`nakama/doRestart.sh` は `whoami=deploy` のとき本番 overlay、それ以外は dev overlay を自動選択する。

## Key Conventions

- **応答は日本語** — Claudeの応答・説明・コミットメッセージは日本語で書く
- **自動コミットしない** — コミットはユーザーが明示的に指示した場合のみ
- **日本語UI** — ツールチップ、エラーメッセージ、パネルは日本語
- **エラーハンドリング** — `catch` ブロックや `.catch()` でエラーを握りつぶさない。必ず `console.warn` 等でエラーメッセージを出力する
- **テスト** — `npm run test` は常にパスする状態を維持する
- **型チェック** — `npx tsc --noEmit` の実行には許可不要
- **sed** — `sed` コマンドの実行には許可不要
- **lint** — lint コマンドの実行には許可不要
- **配下の編集** — `~/24-mmo-Tommie-chat/` 以下にあるファイルは無許可で編集してよい。ファイル参照、編集のコマンドも無許可でよい。
- **Markdownの文法チェック** — `*.md` ファイルを編集した後は、日本語の誤字脱字・文法を確認し、`npx markdownlint-cli <file>` でlintを通してから完了とする
- **モバイル対応** — `@media (pointer: coarse) and (min-resolution: 2dppx)` でスマホ判定。ポートレート/ランドスケープ/iPhone PWA standalone それぞれ個別対応
- **テーマ** — デバッグツール 02b.Theme で「背景黒」「ポップ１」切替。`body.theme-dark` クラスで CSS 上書き
- **パネルレイアウト** — モバイルではパネル位置を CSS `!important` で管理。`clampToViewport` はモバイルではスキップ
- **Cookie保存** — UI設定（テーマ、デバイダー位置、チャットオーバーレイ設定等）は Cookie に保存
- **PWA** — Safari↔PWA 間でデバイスIDを Cookie 経由で引き継ぎ（`max-age=3600`、引き継ぎ後即削除）
- **CSP** — 本番 nginx で `script-src 'self' 'wasm-unsafe-eval' https://cdn.babylonjs.com`（`'unsafe-inline'` 不可）。新しいスクリプトは `public/js/` に外部ファイルとして追加する
- **ステージング検証** — 本番デプロイ前に `mmo-test.tommie.jp` で動作確認する（CSP/nginx設定の差異で本番のみ起きる問題があるため）

## Documentation

- `/doc/10-ブラウザ側ファイル構成.md` — Client file structure
- `/doc/11-RPC関数一覧.md` — RPC reference
- `/doc/03-nakama-サーバ構築.md` — Server setup
- `/doc/04-DB-スキーマ.md` — PostgreSQL `storage` テーブル全レコード形式
- `/doc/06-nakama-チューニング.md` — Performance tuning
- `/doc/12-クライアント永続化設計.md` — IndexedDB / Cookie / localStorage の使い分け
- `/doc/30-テストスクリプト一覧.md` — Test scripts
- `/doc/40-デプロイ手順.md` — 本番デプロイ手順
- `/doc/50-設計-部屋システム.md` — 部屋（マルチワールド）設計
- `/doc/92-セキュリティレビュー.md` — CSP・セキュリティヘッダ等
