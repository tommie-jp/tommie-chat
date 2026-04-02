# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

tommieChat — ブラウザで動く3D MMOチャット。Babylon.js (3Dエンジン) + Nakama (ゲームサーバー) + Vite (ビルド)。
チャット主体のアバターSNS（アメーバPigg 立体版）を目指している。

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
cd nakama && docker compose up -d    # Start all services
bash nakama/doBuild.sh --fresh       # Build Go plugin
```

## Architecture

### Client (TypeScript, `/src/`)

| File | Role |
|------|------|
| `main.ts` | Entry point |
| `GameScene.ts` | Babylon.js scene, player movement, block placement, chunk rendering |
| `NakamaService.ts` | Nakama SDK wrapper — auth, WebSocket, RPC, chat, presence |
| `UIPanel.ts` | All UI — login, chat input/overlay, menus, panels, tooltips |
| `DebugOverlay.ts` | Debug panel — rendering settings, theme, chat overlay config, profiling |
| `AOIManager.ts` | Area of Interest — visible chunk calculation, server sync |
| `SpriteAvatarSystem.ts` | 2D sprite avatar rendering (32x32 spritesheet) |
| `AvatarSystem.ts` | 3D mesh avatar (legacy) |
| `ChunkDB.ts` | IndexedDB chunk cache |
| `WorldConstants.ts` | `CHUNK_SIZE=16`, `CHUNK_COUNT=64`, `WORLD_SIZE=1024` |

### Server (Go, `/nakama/go_src/main.go`)

Single Go file (~3000 lines) containing:
- RPC handlers: `ping`, `getWorldMatch`, `setBlock`, `getGroundChunk`, `syncChunks`, etc.
- Match loop (10 Hz): AOI-filtered broadcast of movement, blocks, presence
- World data: 64×64 chunks of 16×16 cells, FNV-1a hash for delta sync
- CCU tracking with Prometheus metrics

### Communication

- **Login**: HTTP REST → `authenticateDevice` (device ID in localStorage + Cookie for PWA bridge)
- **Real-time**: WebSocket match messages with opcodes (`OP_MOVE_TARGET=2`, `OP_BLOCK_UPDATE=4`, etc.)
- **Chat**: Nakama channel chat (`joinChat("world")`)
- **RPC**: `socket.rpc("funcName", payload)` for request-response

### Docker Services (`/nakama/docker-compose.yml`)

PostgreSQL, Nakama (port 7350/7351), Nginx (port 80), MinIO (S3), Prometheus

## Key Conventions

- **応答は日本語** — Claudeの応答・説明・コミットメッセージは日本語で書く
- **自動コミットしない** — コミットはユーザーが明示的に指示した場合のみ
- **日本語UI** — ツールチップ、エラーメッセージ、パネルは日本語
- **テスト** — `npm run test` は常にパスする状態を維持する
- **Markdownの文法チェック** — `*.md` ファイルを編集した後は、日本語の誤字脱字・文法を確認し、`npx markdownlint-cli <file>` でlintを通してから完了とする
- **モバイル対応** — `@media (pointer: coarse) and (min-resolution: 2dppx)` でスマホ判定。ポートレート/ランドスケープ/iPhone PWA standalone それぞれ個別対応
- **テーマ** — デバッグツール 02b.Theme で「背景黒」「ポップ１」切替。`body.theme-dark` クラスで CSS 上書き
- **パネルレイアウト** — モバイルではパネル位置を CSS `!important` で管理。`clampToViewport` はモバイルではスキップ
- **Cookie保存** — UI設定（テーマ、デバイダー位置、チャットオーバーレイ設定等）は Cookie に保存
- **PWA** — Safari↔PWA 間でデバイスIDを Cookie 経由で引き継ぎ（`max-age=3600`、引き継ぎ後即削除）

## Documentation

- `/doc/10-ブラウザ側ファイル構成.md` — Client file structure
- `/doc/11-RPC関数一覧.md` — RPC reference
- `/doc/03-nakama-サーバ構築.md` — Server setup
- `/doc/06-nakama-チューニング.md` — Performance tuning
- `/doc/30-テストスクリプト一覧.md` — Test scripts
