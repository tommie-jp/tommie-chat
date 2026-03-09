Windows 11上のWSL2 (Ubuntu 24.04) 環境ですね。

先ほどの unknown shorthand flag: 'd' in -d というエラーは、Ubuntu側に最新の「Docker Compose プラグイン」が正しくインストールされていないために発生しています（docker コマンドが compose というサブコマンドを認識できず、後続の -d を不正なオプションとして処理してしまった状態です）。

正確さを期すため、まずはUbuntu 24.04内に公式の最新版DockerとComposeプラグインをクリーンインストールし、その後にNakamaを起動する手順をご案内します。Ubuntuのターミナルで以下の手順を実行してください。

1. Docker環境のクリーンインストール
古いパッケージが干渉しないよう削除し、公式リポジトリから最新版をインストールします。

Bash
# 1. 競合する古いパッケージを削除します
sudo apt-get remove docker docker-engine docker.io containerd runc

# 2. 必要な前提パッケージをインストールします
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release

# 3. Docker公式のGPGキーを追加します
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 4. 公式リポジトリを設定します

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 5. Docker本体とComposeプラグインをインストールします
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
2. Dockerデーモンの起動と権限付与
WSL2環境でDockerサービスを起動し、現在のユーザーが sudo なしでDockerを実行できるように設定します。

Bash
# 1. Dockerサービスを起動します
sudo service docker start

# 2. 現在のユーザーをdockerグループに追加します
sudo usermod -aG docker $USER

# ※ここで設定を反映させるため、一度ターミナルを閉じて再度WSL(Ubuntu)を立ち上げ直すか、以下のコマンドを実行してください。
su - $USER
3. Nakamaサーバーのダウンロードと起動
環境が整いましたので、再度Nakamaの起動を行います。

Bash
# 1. プロジェクト用のディレクトリを作成して移動します
mkdir ~/nakama-project
cd ~/nakama-project

# 2. 公式の docker-compose.yml をダウンロードします
curl -fsSL https://raw.githubusercontent.com/heroiclabs/nakama/master/docker-compose.yml -o docker-compose.yml

# 3. コンテナをバックグラウンドで起動します
docker compose up -d
4. 動作確認
Windows 11とWSL2間はネットワークが透過的に繋がっているため、Windows側のブラウザからそのままアクセスできます。

Windowsのブラウザを開き、以下のURLにアクセスしてください。

URL: http://localhost:7351 または http://127.0.0.1:7351

ユーザー名: admin

パスワード: password

無事にコンソール画面は表示されましたでしょうか？
ログインが確認できましたら、Webクライアント側の通信テスト、もしくはサーバーサイドのTypeScript環境の構築のどちらに進むかご指定ください。準備のお手伝いをいたします。