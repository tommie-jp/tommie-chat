package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"math/rand"
	"strings"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

// 内蔵リバーシ CPU エンジン。Nakama match から直接呼び出し、シリアル接続・別プロセス不要で
// 常時 CPU 対戦を提供する。
//
// 計画: doc/reversi/70-実装計画-内蔵CPU.md
// レーティングとアンカー設計: doc/reversi/69-マッチング-Elo-Glicko.md §5.6
//
// 参考実装 (Python, UART 越しの同等 CPU): test/reversi/reversi_cpu.py

// CpuEngine は盤面から次の手を決定する戦略 interface。
// 将来の多段難易度 (貪欲法 / minimax 等) は同じ interface を実装する別型で差し替える。
type CpuEngine interface {
	Name() string
	// NextMove は color の手番で次の手を返す。合法手がない場合は pass=true を返す
	// (ただし othelloApplyMove は auto-pass を内部で処理するので、スケジューラから
	// 呼ばれる時点で合法手が 1 つ以上あるはず)。
	NextMove(board *[64]int8, color int8) (row, col int, pass bool)
}

// HiyokoCpu: 合法手を行優先 (r=0..7, c=0..7) で走査して最初に見つかったものを打つ、
// 3 歳相当 (§69 §5.12.2) の決定的 CPU。
// test/reversi/reversi_cpu.py と挙動一致 (Python 側 legal_moves も同じ走査順)。
type HiyokoCpu struct{}

// Name は engine 識別名を返す。reversi_cpu_meta.cpu_id の suffix にも使う想定。
func (HiyokoCpu) Name() string { return "hiyoko" }

// NextMove は行優先で最初の合法手を返す。合法手が無ければ pass=true。
func (HiyokoCpu) NextMove(board *[64]int8, color int8) (int, int, bool) {
	for r := 0; r < 8; r++ {
		for c := 0; c < 8; c++ {
			if len(othelloGetFlips(board, r, c, color)) > 0 {
				return r, c, false
			}
		}
	}
	return 0, 0, true
}

// cpuEngines は UID (sentinel) から CPU エンジン実装を引く。
// UID は "cpu:<engine_name>" 形式。OthelloGame.BlackUID / WhiteUID に直接入れる。
var cpuEngines = map[string]CpuEngine{
	"cpu:hiyoko": HiyokoCpu{},
}

// isCpuUID は UID が内蔵 CPU の sentinel かどうかを返す。
func isCpuUID(uid string) bool {
	return strings.HasPrefix(uid, "cpu:")
}

// cpuEngineForUID は UID に対応するエンジン実装を返す。未登録なら nil。
func cpuEngineForUID(uid string) CpuEngine {
	return cpuEngines[uid]
}

// cpuDisplayName は CPU sentinel UID に対する表示名を返す。doc/reversi/69 §5.12 参照。
func cpuDisplayName(cpuUID string) string {
	switch cpuUID {
	case "cpu:hiyoko":
		return "ひよこ(3歳)"
	}
	return cpuUID
}

// init は CPU sentinel UID の表示名キャッシュを事前登録する。
// othelloGameResponse が playerInfo(uid) を呼んで displayNameCache を参照するため、
// CPU 側も人間と同じ経路で表示名を取れるようにする。
func init() {
	for uid := range cpuEngines {
		displayNameCache.Store(uid, cpuDisplayName(uid))
		usernameCache.Store(uid, uid)
	}
}

// CPU 思考時間の演出用ディレイ (ms)。瞬答だと「考えてない」と人間が感じるので揺らぎを入れる。
const (
	cpuThinkMinMs = 300
	cpuThinkMaxMs = 800
)

// cpuThinkDelay はランダムな思考時間を返す。
func cpuThinkDelay() time.Duration {
	ms := cpuThinkMinMs + rand.Intn(cpuThinkMaxMs-cpuThinkMinMs+1)
	return time.Duration(ms) * time.Millisecond
}

// scheduleCpuMove は CPU の手番が回ってきたときに呼ばれる goroutine 本体。
// ランダム思考時間 → 着手 → 盤面配信 を繰り返し、次も CPU の番なら連打する
// (相手 auto-pass のケース)。ゲームが終局 or 非 playing になったら抜ける。
func scheduleCpuMove(nk runtime.NakamaModule, gameID string) {
	ctx := context.Background()
	for {
		time.Sleep(cpuThinkDelay())

		// 毎ループで最新ゲーム状態を再取得 (途中で投了・削除もあり得る)
		v, ok := othelloGames.Load(gameID)
		if !ok {
			return
		}
		g := v.(*OthelloGame)
		if g.Status != "playing" {
			return
		}

		// 現在の手番が CPU 側かチェック
		var cpuUID string
		if g.Turn == 1 {
			cpuUID = g.BlackUID
		} else {
			cpuUID = g.WhiteUID
		}
		if !isCpuUID(cpuUID) {
			return // 次は人間の手番
		}
		engine := cpuEngineForUID(cpuUID)
		if engine == nil {
			logf("scheduleCpuMove(%s) unknown engine %s, abort\n", gameID, cpuUID)
			return
		}

		r, c, pass := engine.NextMove(&g.Board, g.Turn)
		if pass {
			// auto-pass は othelloApplyMove が処理するはずなので、ここで pass が返るのは異常
			logf("scheduleCpuMove(%s) unexpected pass by %s turn=%d, abort\n",
				gameID, cpuUID, g.Turn)
			return
		}
		_, err := othelloApplyMove(g, r, c)
		if err != nil {
			logf("scheduleCpuMove(%s) illegal move %s (%d,%d): %v\n",
				gameID, cpuUID, r, c, err)
			return
		}
		logf("scheduleCpuMove(%s) cpu=%s move=(%d,%d)\n", gameID, cpuUID, r, c)

		// 人間側にも配信
		othelloSignalBroadcast(ctx, nk, g)

		// 終局処理 (rpcOthelloMove と同じクリーンアップ予約)
		if g.Status == "finished" {
			othelloSaveHistory(ctx, nk, g, "normal")
			othelloListBroadcast(ctx, nk, g.WorldID, true)
			boardGX, boardGZ, worldID := g.BoardGX, g.BoardGZ, g.WorldID
			gid := g.GameID
			go func() {
				time.Sleep(60 * time.Second)
				othelloClearBlocks(context.Background(), nk, boardGX, boardGZ, worldID)
				othelloGames.Delete(gid)
			}()
			return
		}
		// ループ継続: 人間側に合法手なし (auto-pass) で CPU がもう一度打つ場合に対応
	}
}

// rpcOthelloCreateCpu は内蔵 CPU との対戦を即座に開始する。
// 人間 = 黒 (先手)、CPU = 白 (後手)、status = "playing" で即 game 開始。
// 既に同一ユーザの CPU 対戦が進行中ならそれを返す (連打防止)。
func rpcOthelloCreateCpu(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	defer prof("rpcOthelloCreateCpu")()
	uid, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || uid == "" {
		return "", runtime.NewError("authentication required", 7)
	}

	var req struct {
		WorldID int    `json:"worldId"`
		CpuUID  string `json:"cpuUid"`
	}
	if payload != "" {
		_ = json.Unmarshal([]byte(payload), &req)
	}
	if req.CpuUID == "" {
		req.CpuUID = "cpu:hiyoko"
	}
	if cpuEngineForUID(req.CpuUID) == nil {
		return "", runtime.NewError("unknown cpu: "+req.CpuUID, 3)
	}

	// 既に自分が参加している進行中 CPU ゲームがあれば返す (連打防止)
	var existing *OthelloGame
	othelloGames.Range(func(_, v interface{}) bool {
		g := v.(*OthelloGame)
		if g.BlackUID == uid && isCpuUID(g.WhiteUID) && g.Status == "playing" {
			existing = g
			return false
		}
		return true
	})
	if existing != nil {
		resp := othelloGameResponse(existing)
		out, _ := json.Marshal(resp)
		return string(out), nil
	}

	gameID := othelloNextGameID()
	g := othelloNewGame(gameID, uid, req.WorldID)
	g.GameNo = othelloNextGameNo(ctx, nk)
	g.WhiteUID = req.CpuUID
	g.Status = "playing" // CPU 対戦は待機不要で即開始
	g.IsCpu = true       // 既存 UI の CPU 対戦表示を流用
	g.BoardGX = 504
	g.BoardGZ = 504

	cacheDN(ctx, nk, uid)
	computeAuthFlags(ctx, nk, uid)

	ownerName := ""
	if v, ok := displayNameCache.Load(uid); ok {
		ownerName = v.(string)
	}
	if ownerName == "" {
		if v, ok := usernameCache.Load(uid); ok {
			ownerName = v.(string)
		}
	}
	g.Comment = ownerName + " vs " + cpuDisplayName(req.CpuUID)

	othelloGames.Store(gameID, g)

	logf("rpcOthelloCreateCpu: gameId=%s black=%s%s cpu=%s worldId=%d\n",
		gameID, shortSID(uid), dn(uid), req.CpuUID, req.WorldID)

	othelloListBroadcast(ctx, nk, req.WorldID, false)

	resp := othelloGameResponse(g)
	out, _ := json.Marshal(resp)
	return string(out), nil
}
