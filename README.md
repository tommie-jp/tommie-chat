# tommieChat

[English](README.md) | [日本語](README.ja.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Babylon.js](https://img.shields.io/badge/Babylon.js-8.x-red.svg)](https://www.babylonjs.com/)
[![Nakama](https://img.shields.io/badge/Nakama-3.35-blueviolet.svg)](https://heroiclabs.com/nakama/)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8.svg)](https://go.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg)](https://docs.docker.com/compose/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1.svg)](https://www.postgresql.org/)

Updated: April 1, 2026

> **Project Status:** Currently under active development. An experimental server is available at [mmo.tommie.jp](https://mmo.tommie.jp).

A 3D MMO chat game that runs in the browser.
Built with Babylon.js + Nakama, it provides a real-time multiplayer environment where you can place blocks and chat with others.

## Table of Contents

1. [Screenshots](#1-screenshots)
2. [Features](#2-features)
3. [Tech Stack](#3-tech-stack)
4. [Requirements](#4-requirements)
5. [Setup](#5-setup)
6. [Port Numbers](#6-port-numbers)
7. [Controls](#7-controls)
8. [Directory Structure](#8-directory-structure)
9. [Documentation](#9-documentation)
10. [Development Tools](#10-development-tools)
11. [Contributing](#11-contributing)
12. [License](#12-license)
13. [Author](#13-author)

## 1. Screenshots

*Screenshots are from the development version and may change significantly.*

![tommieChat screenshot](ss/00-ver0.1.10.png)

![tommieChat screenshot](ss/01-ver0.1.5.png)

## 2. Features

- Runs entirely in the browser (no installation required)
- PWA support (installable to home screen for fullscreen experience)
- Real-time chat in a 3D world with speech bubbles
- Sprite-based avatar system
- World editing through block placement
- Supports multiple simultaneous users
- Easy login via device authentication
- Asset storage via MinIO

## 3. Tech Stack

| Component | Technology |
|---|---|
| 3D Engine | [Babylon.js](https://www.babylonjs.com/) 8.x |
| Game Server | [Nakama](https://heroiclabs.com/nakama/) 3.35 |
| Server Logic | Go |
| Frontend | TypeScript |
| Build Tool | Vite |
| Database | PostgreSQL 16 |
| Object Storage | [MinIO](https://min.io/) |
| Container | Docker Compose |

## 4. Requirements

### Development Environment

- Node.js v24+ (required for frontend build)
- Docker / Docker Compose (required for server startup)

### Production Environment

- Docker / Docker Compose only (deploy pre-built `dist/`)

### Browser

- Mobile support (iOS Safari, Android Chrome)
- WebGL 2.0 compatible browsers (Chrome, Edge, Firefox, Safari)

## 5. Setup

### 5.1 Clone the Repository

```bash
git clone https://github.com/open-tommie/tommie-chat.git
cd tommie-chat
```

### 5.2 Client (Frontend)

```bash
npm install
npm run build
```

### 5.3 Server (Nakama)

```bash
# Set up environment variables
cp nakama/.env.example nakama/.env

# Start the server
cd nakama && docker compose up -d && cd ..

# Build & deploy the Go plugin
bash nakama/doBuild.sh --fresh
```

### 5.4 Open in Browser

Open <http://localhost> (serves `dist/` via nginx).

During development, you can also use the Vite dev server (<http://localhost:5173>) with `npm run dev`.

Nakama admin dashboard: <http://localhost:7351> (default credentials: `admin` / `password`)

### 5.5 Testing

```bash
# Type checking
npm run check

# Unit tests
npm test

# Integration tests (run while Nakama server is running)
bash test/doAll.sh

# Lint all files
bash test/doLint.sh
```

## 6. Port Numbers

| Port | Purpose |
|---|---|
| 80 | Web frontend (nginx) |
| 5173 | Vite dev server |
| 5432 | PostgreSQL |
| 6060 | Go pprof profiler |
| 7349 | Nakama gRPC API |
| 7350 | Nakama client API |
| 7351 | Nakama admin dashboard |
| 9090 | Prometheus metrics |

## 7. Controls

- **Login**: Enter a user ID and click the login button
- **Move**: Click or tap to set a destination
- **Place Block**: B key + click (mobile: not yet supported)
- **Chat**: Send messages from the text input at the bottom
- **Camera**: Drag or swipe to rotate

## 8. Directory Structure

```text
tommieChat/
├── src/                  # Client-side source code (TypeScript)
│   ├── main.ts           # Entry point
│   ├── GameScene.ts      # Babylon.js game scene
│   ├── NakamaService.ts  # Nakama server communication
│   ├── UIPanel.ts        # UI panels
│   ├── AOIManager.ts     # AOI (Area of Interest) management
│   ├── AvatarSystem.ts   # Avatar management
│   ├── SpriteAvatarSystem.ts # Sprite-based avatar system
│   ├── ChunkDB.ts        # Chunk database
│   ├── CloudSystem.ts    # Cloud effects
│   ├── NPCSystem.ts      # NPC management
│   ├── Profiler.ts       # Performance profiling
│   ├── WorldConstants.ts # World constants
│   └── DebugOverlay.ts   # Debug overlay
├── public/               # Static assets
│   ├── textures/         # Textures (.ktx2)
│   ├── manifest.json     # PWA manifest
│   └── sw.js             # Service Worker
├── nakama/               # Server-side
│   ├── docker-compose.yml
│   ├── go_src/           # Go server plugin (main.go)
│   ├── nginx.conf        # Reverse proxy configuration
│   ├── doBuild.sh        # Plugin build script
│   └── doRestart.sh      # Server restart script
├── test/                 # Test scripts & test code
│   ├── doAll.sh          # Run all tests
│   ├── doLint.sh         # Lint check
│   ├── doNight.sh        # Overnight long-running tests
│   ├── doTest-*.sh       # Various test scripts
│   ├── nakama-*.test.ts  # Vitest test files
│   └── log/              # Test report output
├── doc/                  # Documentation
├── pic/                  # Image assets & conversion scripts
├── .github/              # GitHub Actions / Dependabot
├── index.html            # Main HTML
├── package.json
├── vite.config.ts
├── vitest.config.ts
└── tsconfig.json
```

## 9. Documentation

Detailed documentation is available in the `doc/` directory.

| Document | Description |
|----------|-------------|
| [03-nakama-server-setup](doc/03-nakama-サーバ構築.md) | Nakama server setup guide |
| [04-DB-concurrent-connections](doc/04-DB-同接データ.md) | Concurrent connection DB design |
| [05-user-ID-deletion](doc/05-ユーザID削除.md) | User ID deletion procedure |
| [06-nakama-tuning](doc/06-nakama-チューニング.md) | Server tuning parameters |
| [07-MinIO-asset-storage](doc/07-MinIO-アセットストレージ.md) | MinIO asset storage |
| [10-frontend-file-structure](doc/10-ブラウザ側ファイル構成.md) | Frontend file structure |
| [11-RPC-function-list](doc/11-RPC関数一覧.md) | Server RPC function list |
| [20-browser-profiling](doc/20-ブラウザプロファイル.md) | Browser-side performance profiling |
| [21-nakama-server-profiling](doc/21-nakamaサーバプロファイル.md) | Server-side profiling |
| [30-test-script-list](doc/30-テストスクリプト一覧.md) | Test scripts and options |
| [40-deployment-guide](doc/40-デプロイ手順.md) | Sakura VPS deployment guide |
| [42-LAN-connection](doc/42-LAN接続手順.md) | LAN connection guide |
| [43-mobile-display-test](doc/43-スマホ表示テスト.md) | Mobile display testing |
| [51-SpriteViewer-demo](doc/51-SpriteViewerデモ.md) | SpriteViewer demo |

## 10. Development Tools

This project extensively uses [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic) for design, implementation, testing, and documentation.

## 11. Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 12. License

[MIT License](LICENSE)

## 13. Author

- tommie.jp
- X: [@tommie_nico](https://x.com/tommie_nico)
