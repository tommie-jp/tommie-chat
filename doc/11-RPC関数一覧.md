# RPC関数一覧

> このファイルは自動生成です。編集しないでください。
> 再生成: `cd doc && bash 91-make-RPC-func-list.sh`

## カスタムRPC（WebSocket `socket.rpc()`）

| RPC名 | 用途 | クライアント側 | サーバ側ハンドラ |
|--------|------|---------------|-----------------|
| `getWorldMatch` | ワールドマッチID取得 | NakamaService.ts | `rpcGetWorldMatch` |
| `getServerInfo` | サーバ情報取得 | NakamaService.ts | `rpcGetServerInfo` |
| `ping` | レイテンシ計測 | NakamaService.ts | `rpcPing` |
| `setBlock` | 地形ブロック設置 | NakamaService.ts | `rpcSetBlock` |
| `getGroundTable` | 地面ブロックテーブル取得 | NakamaService.ts | `rpcGetGroundTable` |
| `getGroundChunk` | 特定チャンク取得 | NakamaService.ts | `rpcGetGroundChunk` |
| `syncChunks` | チャンク同期 | NakamaService.ts | `rpcSyncChunks` |
| `getPlayersAOI` | 全プレイヤーAOI取得 | NakamaService.ts | `rpcGetPlayersAOI` |
| `getPlayerCount` | プレイヤー数取得 | NakamaService.ts | `rpcGetPlayerCount` |
| `profileStart` | プロファイル開始 | NakamaService.ts | `rpcProfileStart` |
| `profileStop` | プロファイル停止 | NakamaService.ts | `rpcProfileStop` |
| `profileDump` | プロファイル結果取得 | NakamaService.ts | `rpcProfileDump` |

## Nakama組み込みAPI（HTTP `client.*`）

| API | 用途 | 呼び出し箇所 |
|-----|------|-------------|
| `client.authenticateDevice()` | デバイス認証 | NakamaService.ts |
| `client.updateAccount()` | ユーザ名・表示名更新 | NakamaService.ts |
| `client.getUsers()` | ユーザ情報取得 | NakamaService.ts |
| `client.writeStorageObjects()` | ストレージ書き込み | NakamaService.ts |
| `client.readStorageObjects()` | ストレージ読み込み | NakamaService.ts |

## WebSocketリアルタイム通信（`socket.*`）

| API | OpCode | 用途 |
|-----|--------|------|
| `socket.sendMatchState()` | `OP_INIT_POS` | 初期位置送信 |
| `socket.sendMatchState()` | `OP_AVATAR_CHANGE` | アバター変更 |
| `socket.sendMatchState()` | `OP_DISPLAY_NAME` | 表示名変更 |
| `socket.sendMatchState()` | `OP_MOVE_TARGET` | 移動先送信 |
| `socket.sendMatchState()` | `OP_AOI_UPDATE` | AOI範囲更新 |
| `socket.writeChatMessage()` | - | チャット送信 |
| `socket.joinMatch()` | - | マッチ参加 |
| `socket.joinChat()` | - | チャット参加 |

## サーバ側フック（API呼び出し時に自動実行）

| フック | トリガー |
|--------|---------|
| `BeforeUpdateAccount` | 表示名バリデーション |
| `AfterAuthenticateDevice` | デバイスログイン記録 |
| `AfterAuthenticateCustom` | カスタムログイン記録 |
| `EventSessionEnd` | ログアウト記録 |
