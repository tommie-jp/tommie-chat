# nakama サーバプロファイル手順

Go の `net/http/pprof` を使い、nakama サーバ (Go プラグイン) の CPU・メモリ・goroutine を計測する。

## 1. 仕組み

[nakama/go_src/main.go](../nakama/go_src/main.go) の `InitModule` で pprof HTTP サーバをポート 6060 で起動している。

```go
import (
    "net/http"
    _ "net/http/pprof"
)

func InitModule(...) error {
    go func() {
        http.ListenAndServe(":6060", nil)
    }()
    // ...
}
```

[nakama/docker-compose.yml](../nakama/docker-compose.yml) でポート 6060 をホストに公開している。

```yaml
ports:
  - "6060:6060"  # pprof
```

## 2. 基本操作

### ブラウザで一覧表示

[http://localhost:6060/debug/pprof/](http://localhost:6060/debug/pprof/)

### CPU プロファイル

```bash
# 30秒間のCPUプロファイルを取得 → 対話シェルで分析
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# ブラウザで可視化 (flame graph 等)
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=30
```

対話シェルでの主なコマンド:

```
(pprof) top 20       # CPU消費トップ20関数
(pprof) web           # SVGグラフをブラウザで表示
(pprof) list funcName # 関数のソース行ごとの消費
```

### ヒープ (メモリ)

```bash
go tool pprof http://localhost:6060/debug/pprof/heap
```

```
(pprof) top 20              # メモリ割り当てトップ20
(pprof) top 20 -cum         # 累積割り当て順
```

### goroutine

```bash
# goroutine 数のサマリ
curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | head -20

# 全 goroutine のスタックトレース
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 > goroutine-dump.txt
```

### ブロックプロファイル

goroutine のブロック (mutex 待ち、channel 待ち) を計測する。

```bash
go tool pprof http://localhost:6060/debug/pprof/block
```

## 3. 負荷テストとの組み合わせ

テスト実行中にプロファイルを取得することで、ボトルネックを特定できる。

```bash
# ターミナル1: テスト実行
./test/doTest-sustain.sh -n 2000

# ターミナル2: テスト中にCPUプロファイル取得 (20秒)
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=20

# ターミナル2: goroutine 数を確認 (接続切断の原因調査)
curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | head -5
```

### 調査シナリオ例

**WebSocket 大量切断の原因調査:**

```bash
# 1. テスト開始前の goroutine 数を記録
curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | head -3

# 2. テスト中に定期的に goroutine 数を確認
watch -n 3 'curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | head -3'

# 3. 切断発生時のスタックトレースを保存
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 > goroutine-disconnect.txt

# 4. CPU プロファイルで match loop の負荷を確認
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=30
```

**MatchLoop ボトルネック調査:**

```bash
# CPU プロファイル取得後、対話シェルで:
(pprof) top 20
(pprof) list MatchLoop    # MatchLoop 内の行ごとの消費
(pprof) list broadcastToAOI  # AOI配信の消費
```

## 4. よく確認するポイント

| 指標 | 確認方法 | 注意すべき値 |
|------|----------|-------------|
| goroutine 数 | `goroutine?debug=1` | 接続数の 3〜5 倍を超えたら異常 |
| CPU 消費トップ | `profile?seconds=30` → `top 20` | match loop / AOI 配信が支配的か |
| メモリ割り当て | `heap` → `top 20` | JSON marshal/unmarshal が多くないか |
| mutex 競合 | `block` | `worldMatchMu` 等の lock 待ち時間 |

## 5. 設定箇所

| 項目 | ファイル | 場所 |
|------|----------|------|
| pprof サーバ起動 | [nakama/go_src/main.go](../nakama/go_src/main.go) | `InitModule` 内の goroutine |
| ポート公開 | [nakama/docker-compose.yml](../nakama/docker-compose.yml) | `ports: "6060:6060"` |
| ブラウザ側プロファイル | [doc/20-ブラウザプロファイル.md](20-ブラウザプロファイル.md) | — |
| チューニングパラメータ | [doc/06-nakama-チューニング.md](06-nakama-チューニング.md) | — |
