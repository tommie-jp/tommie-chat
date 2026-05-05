#!/bin/bash
# デプロイテスト（curl でリポジトリから doDeployTest.sh を取得して実行）
# Usage: ./doDeployTest-curl.sh [-h] [-v]
#
# 任意のディレクトリに配置して実行できる。
# git clone → ビルド → デプロイ → テストを一括で行う。
# 開発環境（WSL2 Ubuntu 24.04）で実行する。
SCRIPT_VERSION="2026-04-03"

case "${1:-}" in
    -h|--help)
        cat <<'EOF'
Usage: ./doDeployTest-curl.sh [-h] [-v]

本番デプロイ前のローカル一括テスト（WSL2 Ubuntu 24.04 で実行）

curl で最新の doDeployTest.sh を取得して実行します。
任意のディレクトリに配置して使えます。

処理内容:
  1. リポジトリから doDeployTest.sh を取得
  2. tommie-chat を git clone
  3. npm install && npm run build（フロントエンドビルド）
  4. nakama/doDeploy.sh（Docker 環境構築・サーバー起動）
  5. doTest-ping.sh（疎通テスト 5項目）
  6. doTest-minio.sh（MinIO 疎通テスト 11項目）

前提:
  - Docker がインストール済み
  - Node.js がインストール済み

セットアップ:
  mkdir -p ~/deploy-test && cd ~/deploy-test
  curl -fsSL https://raw.githubusercontent.com/tommie-jp/tommie-chat/main/test/doDeployTest-curl.sh -o doDeployTest-curl.sh
  chmod +x doDeployTest-curl.sh
  ./doDeployTest-curl.sh
EOF
        exit 0 ;;
    -v|--version)
        echo "doDeployTest-curl.sh  version: ${SCRIPT_VERSION}"
        exit 0 ;;
esac

echo "doDeployTest-curl.sh  version: ${SCRIPT_VERSION}"
echo ""

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 最新の doDeployTest.sh を取得して実行
curl -fsSL https://raw.githubusercontent.com/tommie-jp/tommie-chat/main/test/doDeployTest.sh -o doDeployTest.sh
chmod +x doDeployTest.sh
exec ./doDeployTest.sh
