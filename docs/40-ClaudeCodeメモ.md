# Claude Code メモ

## よく使うスラッシュコマンド

### 日常的に使うもの

| コマンド | 用途 |
| -------- | ---- |
| `/help` | コマンド一覧・ショートカットの確認 |
| `/clear` | 会話履歴をクリア（コンテキストが長くなったとき） |
| `/compact` | 会話を要約して圧縮（コンテキスト節約） |
| `/fast` | 高速モード切替（同じOpusモデルで出力速度UP） |

### 開発・品質

| コマンド | 用途 |
| -------- | ---- |
| `/simplify` | 変更したコードの品質レビュー＋自動修正 |
| `/init` | CLAUDE.md を自動生成（新プロジェクト向け） |
| `/update-config` | settings.json の hooks/permissions を対話的に設定 |

### 高度な機能

| コマンド | 用途 |
| -------- | ---- |
| `/loop 5m /simplify` | 指定間隔で繰り返し実行 |
| `/schedule` | cron で定期実行するリモートエージェントを管理 |
| `/claude-api` | Anthropic SDK を使ったコードを書くときのガイド |

## このプロジェクトでのおすすめ

- **`/compact`** — `main.go` (3000行) や `UIPanel.ts` を読むとコンテキストが膨らむので、こまめに圧縮
- **`/simplify`** — 変更後にサッと品質チェック
- **`/fast`** — 単純な修正は高速モードで素早く

## 設定ファイル構成

| ファイル | 役割 | git |
| -------- | ---- | --- |
| `CLAUDE.md` | プロジェクト指示書（コードベースにコミット） | 対象 |
| `.claude/settings.json` | permissions, hooks（プロジェクト共有） | 除外 |
| `.claude/settings.local.json` | 会話中に許可した一時的なパーミッション | 除外 |

## hooks 設定（現在有効）

- **PreToolUse**: `.env` 等の機密ファイル編集をブロック
- **PostToolUse**: `.ts` 編集後に `tsc --noEmit` 自動実行
- **PostToolUse**: `.go` 編集後に `go vet` 自動実行
- **PostToolUse**: `nakama/go_src/` 変更時にビルド必要の通知
