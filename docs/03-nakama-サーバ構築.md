# nakama サーバ構築手順（WSL2 Ubuntu 24.04）

Windows 11 上の WSL2 (Ubuntu 24.04) 環境に Docker と Nakama をインストールする手順。

## 1. Docker 環境のクリーンインストール

古いパッケージが干渉しないよう削除し、公式リポジトリから最新版をインストールする。

```bash
# 1. 競合する古いパッケージを削除
sudo apt-get remove docker docker-engine docker.io containerd runc

# 2. 必要な前提パッケージをインストール
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release

# 3. Docker公式のGPGキーを追加
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 4. 公式リポジトリを設定
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 5. Docker本体とComposeプラグインをインストール
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

## 2. Docker デーモンの起動と権限付与

WSL2 環境で Docker サービスを起動し、現在のユーザーが sudo なしで Docker を実行できるように設定する。

```bash
# 1. Dockerサービスを起動
sudo service docker start

# 2. 現在のユーザーをdockerグループに追加
sudo usermod -aG docker $USER

# 設定を反映させるため、一度ターミナルを閉じて再度WSL(Ubuntu)を立ち上げ直すか、
# 以下のコマンドを実行する
su - $USER
```

## 3. Nakama サーバーのダウンロードと起動

```bash
# 1. プロジェクト用のディレクトリを作成して移動
mkdir ~/nakama-project
cd ~/nakama-project

# 2. 公式の docker-compose.yml をダウンロード
curl -fsSL https://raw.githubusercontent.com/heroiclabs/nakama/master/docker-compose.yml \
  -o docker-compose.yml

# 3. コンテナをバックグラウンドで起動
docker compose up -d
```

## 4. 動作確認

Windows 11 と WSL2 間はネットワークが透過的に繋がっているため、Windows 側のブラウザからそのままアクセスできる。

ブラウザで `http://localhost:7351` にアクセスする。

| 項目 | 値 |
| --- | --- |
| URL | `http://localhost:7351` |
| ユーザー名 | `admin` |
| パスワード | `password` |
