Set-Location $PSScriptRoot

# Go テストは WSL2 側のホスト Go で実行する (Windows ネイティブ Go は UNC パス経由で遅いため)。
# ~/.bashrc は非インタラクティブで early return するので PATH 設定を明示的に入れる。
$wslCmd = @'
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
if ! command -v go >/dev/null 2>&1; then
    echo "❌ go コマンドが見つかりません (apt install golang-go 等で入れてください)" >&2
    exit 2
fi
cd ~/24-mmo-Tommie-chat/nakama/go_src
go test -count=1 ./...
'@
wsl bash -c $wslCmd
exit $LASTEXITCODE
