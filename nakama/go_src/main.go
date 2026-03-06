package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

var serverUpTime = time.Now().UTC().Format(time.RFC3339)

const (
	streamModeChannel uint8 = 2
	chatRoomLabel           = "world"
	groundSize              = 100
	opBlockUpdate     int64 = 4
)

// 地面テーブル: groundTable[gx][gz] = blockID (uint16)
var (
	groundMu    sync.RWMutex
	groundTable [groundSize][groundSize]uint16
)

// rpcGetServerInfo はサーバ情報（ノード名・バージョン・起動時刻・プレイヤー数）を返す
func rpcGetServerInfo(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	playerCount, err := nk.StreamCount(streamModeChannel, "", "", chatRoomLabel)
	if err != nil {
		logger.Warn("StreamCount error: %v", err)
		playerCount = 0
	}

	env, _ := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string)
	node, _ := ctx.Value(runtime.RUNTIME_CTX_NODE).(string)

	version := "unknown"
	if v, ok := env["NAKAMA_VERSION"]; ok {
		version = v
	}

	info := map[string]interface{}{
		"name":         node,
		"version":      version,
		"serverUpTime": serverUpTime,
		"playerCount":  playerCount,
	}
	b, err := json.Marshal(info)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// rpcGetWorldMatch は稼働中の "world" マッチを探し、なければ新規作成して返す
func rpcGetWorldMatch(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	matches, err := nk.MatchList(ctx, 1, true, "world", nil, nil, "")
	if err != nil {
		logger.Warn("MatchList failed: %v", err)
	} else if len(matches) > 0 {
		matchID := matches[0].GetMatchId()
		logger.Info("Found active world match: %s", matchID)
		b, _ := json.Marshal(map[string]string{"matchId": matchID})
		return string(b), nil
	}

	matchID, err := nk.MatchCreate(ctx, "world", map[string]interface{}{})
	if err != nil {
		return "", err
	}
	logger.Info("Created world match: %s", matchID)
	b, _ := json.Marshal(map[string]string{"matchId": matchID})
	return string(b), nil
}

// worldMatch は Nakama マッチハンドラの実装
type worldMatch struct{}

func (m *worldMatch) MatchInit(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, params map[string]interface{}) (interface{}, int, string) {
	return map[string]interface{}{}, 10, "world"
}

func (m *worldMatch) MatchJoinAttempt(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presence runtime.Presence, metadata map[string]string) (interface{}, bool, string) {
	return state, true, ""
}

func (m *worldMatch) MatchJoin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	return state
}

func (m *worldMatch) MatchLeave(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	return state
}

func (m *worldMatch) MatchLoop(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, messages []runtime.MatchData) interface{} {
	for _, msg := range messages {
		if err := dispatcher.BroadcastMessage(msg.GetOpCode(), msg.GetData(), nil, msg, true); err != nil {
			logger.Warn("BroadcastMessage error: %v", err)
		}
	}
	return state
}

func (m *worldMatch) MatchTerminate(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, graceSeconds int) interface{} {
	return state
}

func (m *worldMatch) MatchSignal(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, data string) (interface{}, string) {
	// ブロック更新シグナルを全プレイヤーへブロードキャスト
	if err := dispatcher.BroadcastMessage(opBlockUpdate, []byte(data), nil, nil, false); err != nil {
		logger.Warn("MatchSignal BroadcastMessage error: %v", err)
	}
	return state, data
}

// rpcPing はクライアントのラウンドトリップ時間計測用 RPC
func rpcPing(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ string) (string, error) {
	return "{}", nil
}

type blockReq struct {
	GX      int    `json:"gx"`
	GZ      int    `json:"gz"`
	BlockID uint16 `json:"blockId"`
}

// dumpGroundTableCSV は地面テーブルを /nakama/data/log/groundTable.csv に書き出す
func dumpGroundTableCSV(logger runtime.Logger) {
	const path = "/nakama/data/log/groundTable.csv"
	if err := os.MkdirAll("/nakama/data/log", 0755); err != nil {
		logger.Warn("dumpGroundTableCSV MkdirAll: %v", err)
		return
	}
	groundMu.RLock()
	var sb strings.Builder
	for gz := 0; gz < groundSize; gz++ {
		cols := make([]string, groundSize)
		for gx := 0; gx < groundSize; gx++ {
			cols[gx] = fmt.Sprintf("%d", groundTable[gx][gz])
		}
		sb.WriteString(strings.Join(cols, ","))
		sb.WriteByte('\n')
	}
	groundMu.RUnlock()
	if err := os.WriteFile(path, []byte(sb.String()), 0644); err != nil {
		logger.Warn("dumpGroundTableCSV WriteFile: %v", err)
	}
}

const (
	groundCollection = "world_data"
	groundKey        = "ground_table"
	systemUserID     = "00000000-0000-0000-0000-000000000000"
)

func saveGroundTableToStorage(ctx context.Context, nk runtime.NakamaModule, logger runtime.Logger) {
	groundMu.RLock()
	flat := make([]uint16, groundSize*groundSize)
	for gx := 0; gx < groundSize; gx++ {
		for gz := 0; gz < groundSize; gz++ {
			flat[gx*groundSize+gz] = groundTable[gx][gz]
		}
	}
	groundMu.RUnlock()
	data, err := json.Marshal(struct {
		Table []uint16 `json:"table"`
	}{Table: flat})
	if err != nil {
		logger.Warn("saveGroundTable marshal: %v", err)
		return
	}
	if _, err := nk.StorageWrite(ctx, []*runtime.StorageWrite{{
		Collection:      groundCollection,
		Key:             groundKey,
		UserID:          systemUserID,
		Value:           string(data),
		PermissionRead:  2,
		PermissionWrite: 1,
	}}); err != nil {
		logger.Warn("saveGroundTable StorageWrite: %v", err)
	}
}

// rpcSetBlock はブロックを地面テーブルに書き込み、全プレイヤーへ通知する
func rpcSetBlock(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	var req blockReq
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", err
	}
	if req.GX < 0 || req.GX >= groundSize || req.GZ < 0 || req.GZ >= groundSize {
		return "", fmt.Errorf("setBlock: out of bounds gx=%d gz=%d", req.GX, req.GZ)
	}
	groundMu.Lock()
	groundTable[req.GX][req.GZ] = req.BlockID
	groundMu.Unlock()
	saveGroundTableToStorage(ctx, nk, logger)
	dumpGroundTableCSV(logger)

	// ワールドマッチへシグナル送信
	matches, err := nk.MatchList(ctx, 1, true, "world", nil, nil, "")
	if err != nil || len(matches) == 0 {
		return "{}", nil
	}
	sigData, _ := json.Marshal(req)
	if _, err := nk.MatchSignal(ctx, matches[0].GetMatchId(), string(sigData)); err != nil {
		logger.Warn("setBlock MatchSignal error: %v", err)
	}
	return "{}", nil
}

// rpcGetGroundTable は現在の地面テーブルをフラット配列で返す
func rpcGetGroundTable(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ string) (string, error) {
	groundMu.RLock()
	defer groundMu.RUnlock()
	flat := make([]uint16, groundSize*groundSize)
	for gx := 0; gx < groundSize; gx++ {
		for gz := 0; gz < groundSize; gz++ {
			flat[gx*groundSize+gz] = groundTable[gx][gz]
		}
	}
	b, err := json.Marshal(map[string]interface{}{"table": flat})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// InitModule は Nakama プラグインのエントリポイント
func InitModule(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, initializer runtime.Initializer) error {
	// ストレージから地面テーブルを復元
	objs, err := nk.StorageRead(ctx, []*runtime.StorageRead{{
		Collection: groundCollection,
		Key:        groundKey,
		UserID:     systemUserID,
	}})
	if err != nil {
		logger.Warn("InitModule StorageRead error: %v", err)
	} else if len(objs) > 0 {
		var data struct {
			Table []uint16 `json:"table"`
		}
		if err := json.Unmarshal([]byte(objs[0].Value), &data); err == nil {
			if len(data.Table) == groundSize*groundSize {
				groundMu.Lock()
				for gx := 0; gx < groundSize; gx++ {
					for gz := 0; gz < groundSize; gz++ {
						groundTable[gx][gz] = data.Table[gx*groundSize+gz]
					}
				}
				groundMu.Unlock()
				logger.Info("ground_table loaded from storage (%d blocks)", groundSize*groundSize)
			}
		}
	}

	if err := initializer.RegisterMatch("world", func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule) (runtime.Match, error) {
		return &worldMatch{}, nil
	}); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("getServerInfo", rpcGetServerInfo); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("getWorldMatch", rpcGetWorldMatch); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("ping", rpcPing); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("setBlock", rpcSetBlock); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("getGroundTable", rpcGetGroundTable); err != nil {
		return err
	}
	logger.Info("server_info module loaded")
	return nil
}
