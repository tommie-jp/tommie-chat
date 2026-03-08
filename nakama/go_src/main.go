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

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)

var serverUpTime = time.Now().UTC().Format(time.RFC3339)

const (
	streamModeChannel uint8 = 2
	chatRoomLabel           = "world"
	chunkSize               = 16 // 1チャンク = 16x16セル
	chunkCount              = 16 // 16x16チャンク
	worldSize               = chunkSize * chunkCount // 256x256セル
	opBlockUpdate     int64 = 4
)

// 地面セル: blockID (uint16) + RGBA 各1バイト
type blockData struct {
	BlockID    uint16
	R, G, B, A uint8
}

// chunk はチャンク単位のデータとロックをまとめた構造体
type chunk struct {
	mu    sync.RWMutex
	cells [chunkSize][chunkSize]blockData
}

// toFlat: 16x16 セルを 6バイト/セル (lo,hi,R,G,B,A) へ変換。呼び出し元がRLock保持
func (ch *chunk) toFlat() []uint8 {
	flat := make([]uint8, chunkSize*chunkSize*6)
	for lx := 0; lx < chunkSize; lx++ {
		for lz := 0; lz < chunkSize; lz++ {
			i := (lx*chunkSize + lz) * 6
			c := ch.cells[lx][lz]
			flat[i] = uint8(c.BlockID & 0xFF)
			flat[i+1] = uint8(c.BlockID >> 8)
			flat[i+2] = c.R
			flat[i+3] = c.G
			flat[i+4] = c.B
			flat[i+5] = c.A
		}
	}
	return flat
}

// fromFlat: 6バイト/セル の []uint8 からチャンクを復元。呼び出し元がLock保持
func (ch *chunk) fromFlat(flat []uint8) bool {
	if len(flat) != chunkSize*chunkSize*6 {
		return false
	}
	for lx := 0; lx < chunkSize; lx++ {
		for lz := 0; lz < chunkSize; lz++ {
			i := (lx*chunkSize + lz) * 6
			ch.cells[lx][lz] = blockData{
				BlockID: uint16(flat[i]) | uint16(flat[i+1])<<8,
				R: flat[i+2], G: flat[i+3], B: flat[i+4], A: flat[i+5],
			}
		}
	}
	return true
}

// 地面テーブル: 16x16 チャンクの配列
var chunks [chunkCount][chunkCount]chunk

// ストレージキー
const (
	groundCollection = "world_data"
	systemUserID     = "00000000-0000-0000-0000-000000000000"
)

func chunkStorageKey(cx, cz int) string {
	return fmt.Sprintf("chunk_%d_%d", cx, cz)
}

// flatToInts は []uint8 を JSON 数値配列として出力するための []int に変換する
// Go の json.Marshal は []uint8 を base64 文字列にしてしまうため必要
func flatToInts(flat []uint8) []int {
	ints := make([]int, len(flat))
	for i, v := range flat {
		ints[i] = int(v)
	}
	return ints
}

func saveChunkToStorage(ctx context.Context, nk runtime.NakamaModule, logger runtime.Logger, cx, cz int) {
	ch := &chunks[cx][cz]
	ch.mu.RLock()
	flat := ch.toFlat()
	ch.mu.RUnlock()
	data, err := json.Marshal(struct {
		Table []int `json:"table"`
	}{Table: flatToInts(flat)})
	if err != nil {
		logger.Warn("saveChunk marshal: %v", err)
		return
	}
	if _, err := nk.StorageWrite(ctx, []*runtime.StorageWrite{{
		Collection:      groundCollection,
		Key:             chunkStorageKey(cx, cz),
		UserID:          systemUserID,
		Value:           string(data),
		PermissionRead:  2,
		PermissionWrite: 1,
	}}); err != nil {
		logger.Warn("saveChunk StorageWrite: %v", err)
	}
}

// rpcGetServerInfo はサーバ情報（ノード名・バージョン・起動時刻・プレイヤー数）を返す
func rpcGetServerInfo(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	fmt.Printf("[getServerInfo] uid=%s\n", uid)
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
		"worldSize":    worldSize,
		"chunkSize":    chunkSize,
		"chunkCount":   chunkCount,
	}
	b, err := json.Marshal(info)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// rpcGetWorldMatch は稼働中の "world" マッチを探し、なければ新規作成して返す
func rpcGetWorldMatch(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	fmt.Printf("[getWorldMatch] uid=%s\n", uid)
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
	fmt.Println("[ping]")
	return "{}", nil
}

type blockReq struct {
	GX      int    `json:"gx"`
	GZ      int    `json:"gz"`
	BlockID uint16 `json:"blockId"`
	R       uint8  `json:"r"`
	G       uint8  `json:"g"`
	B       uint8  `json:"b"`
	A       uint8  `json:"a"`
}

// dumpGroundTableCSV は地面テーブルを /nakama/data/log/groundTable.csv に書き出す
func dumpGroundTableCSV(logger runtime.Logger) {
	const path = "/nakama/data/log/groundTable.csv"
	if err := os.MkdirAll("/nakama/data/log", 0755); err != nil {
		logger.Warn("dumpGroundTableCSV MkdirAll: %v", err)
		return
	}
	// チャンクごとにロックしてスナップショットを取る
	var snapshot [worldSize][worldSize]uint16
	for cx := 0; cx < chunkCount; cx++ {
		for cz := 0; cz < chunkCount; cz++ {
			ch := &chunks[cx][cz]
			ch.mu.RLock()
			for lx := 0; lx < chunkSize; lx++ {
				for lz := 0; lz < chunkSize; lz++ {
					snapshot[cx*chunkSize+lx][cz*chunkSize+lz] = ch.cells[lx][lz].BlockID
				}
			}
			ch.mu.RUnlock()
		}
	}
	var sb strings.Builder
	for gz := 0; gz < worldSize; gz++ {
		cols := make([]string, worldSize)
		for gx := 0; gx < worldSize; gx++ {
			cols[gx] = fmt.Sprintf("%d", snapshot[gx][gz])
		}
		sb.WriteString(strings.Join(cols, ","))
		sb.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(sb.String()), 0644); err != nil {
		logger.Warn("dumpGroundTableCSV WriteFile: %v", err)
	}
}

// rpcSetBlock はブロックを地面テーブルに書き込み、全プレイヤーへ通知する
func rpcSetBlock(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	var req blockReq
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", err
	}
	fmt.Printf("[setBlock] gx=%d gz=%d blockId=%d r=%d g=%d b=%d a=%d\n", req.GX, req.GZ, req.BlockID, req.R, req.G, req.B, req.A)
	if req.GX < 0 || req.GX >= worldSize || req.GZ < 0 || req.GZ >= worldSize {
		return "", fmt.Errorf("setBlock: out of bounds gx=%d gz=%d", req.GX, req.GZ)
	}
	a := req.A
	if a == 0 {
		a = 255
	}
	// 該当チャンクのみロック
	cx := req.GX / chunkSize
	cz := req.GZ / chunkSize
	lx := req.GX % chunkSize
	lz := req.GZ % chunkSize
	ch := &chunks[cx][cz]
	ch.mu.Lock()
	ch.cells[lx][lz] = blockData{BlockID: req.BlockID, R: req.R, G: req.G, B: req.B, A: a}
	ch.mu.Unlock()
	saveChunkToStorage(ctx, nk, logger, cx, cz)
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

// rpcGetGroundChunk は指定チャンクの地面テーブルを返す
// payload: {"cx":0,"cz":0}
func rpcGetGroundChunk(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, payload string) (string, error) {
	var req struct {
		CX int `json:"cx"`
		CZ int `json:"cz"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", err
	}
	fmt.Printf("[getGroundChunk] cx=%d cz=%d\n", req.CX, req.CZ)
	if req.CX < 0 || req.CX >= chunkCount || req.CZ < 0 || req.CZ >= chunkCount {
		return "", fmt.Errorf("getGroundChunk: out of bounds cx=%d cz=%d", req.CX, req.CZ)
	}
	ch := &chunks[req.CX][req.CZ]
	ch.mu.RLock()
	flat := ch.toFlat()
	ch.mu.RUnlock()
	b, err := json.Marshal(map[string]interface{}{
		"cx":    req.CX,
		"cz":    req.CZ,
		"table": flatToInts(flat),
	})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// rpcGetGroundTable は全チャンクの地面テーブルをまとめて返す（後方互換）
func rpcGetGroundTable(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ string) (string, error) {
	fmt.Println("[getGroundTable]")
	flat := make([]uint8, worldSize*worldSize*6)
	for cx := 0; cx < chunkCount; cx++ {
		for cz := 0; cz < chunkCount; cz++ {
			ch := &chunks[cx][cz]
			ch.mu.RLock()
			for lx := 0; lx < chunkSize; lx++ {
				for lz := 0; lz < chunkSize; lz++ {
					gx := cx*chunkSize + lx
					gz := cz*chunkSize + lz
					i := (gx*worldSize + gz) * 6
					c := ch.cells[lx][lz]
					flat[i] = uint8(c.BlockID & 0xFF)
					flat[i+1] = uint8(c.BlockID >> 8)
					flat[i+2] = c.R
					flat[i+3] = c.G
					flat[i+4] = c.B
					flat[i+5] = c.A
				}
			}
			ch.mu.RUnlock()
		}
	}
	b, err := json.Marshal(map[string]interface{}{"table": flatToInts(flat)})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// InitModule は Nakama プラグインのエントリポイント
func InitModule(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, initializer runtime.Initializer) error {
	// ストレージから地面テーブルを復元（チャンク単位）
	loadedChunks := 0
	for cx := 0; cx < chunkCount; cx++ {
		for cz := 0; cz < chunkCount; cz++ {
			objs, err := nk.StorageRead(ctx, []*runtime.StorageRead{{
				Collection: groundCollection,
				Key:        chunkStorageKey(cx, cz),
				UserID:     systemUserID,
			}})
			if err != nil || len(objs) == 0 {
				continue
			}
			var chunkData struct {
				Table []int `json:"table"`
			}
			if err := json.Unmarshal([]byte(objs[0].Value), &chunkData); err != nil || len(chunkData.Table) != chunkSize*chunkSize*6 {
				continue
			}
			flat8 := make([]uint8, len(chunkData.Table))
			for i, v := range chunkData.Table {
				flat8[i] = uint8(v)
			}
			ch := &chunks[cx][cz]
			ch.mu.Lock()
			ch.fromFlat(flat8)
			ch.mu.Unlock()
			loadedChunks++
		}
	}

	// 旧フォーマットからのマイグレーション（ground_table キーが残っている場合）
	if loadedChunks == 0 {
		objs, err := nk.StorageRead(ctx, []*runtime.StorageRead{{
			Collection: groundCollection,
			Key:        "ground_table",
			UserID:     systemUserID,
		}})
		if err == nil && len(objs) > 0 {
			const oldSize = 100
			// 新フォーマット (6バイト/セル, 100x100)
			var newData struct {
				Table []int `json:"table"`
			}
			if err := json.Unmarshal([]byte(objs[0].Value), &newData); err == nil && len(newData.Table) == oldSize*oldSize*6 {
				for gx := 0; gx < oldSize; gx++ {
					for gz := 0; gz < oldSize; gz++ {
						i := (gx*oldSize + gz) * 6
						cx := gx / chunkSize
						cz := gz / chunkSize
						lx := gx % chunkSize
						lz := gz % chunkSize
						chunks[cx][cz].cells[lx][lz] = blockData{
							BlockID: uint16(newData.Table[i]) | uint16(newData.Table[i+1])<<8,
							R: uint8(newData.Table[i+2]), G: uint8(newData.Table[i+3]),
							B: uint8(newData.Table[i+4]), A: uint8(newData.Table[i+5]),
						}
					}
				}
				logger.Info("Migrated old ground_table (100x100) to chunk format")
				for cx := 0; cx < chunkCount; cx++ {
					for cz := 0; cz < chunkCount; cz++ {
						saveChunkToStorage(ctx, nk, logger, cx, cz)
					}
				}
			} else {
				// 旧旧フォーマット (blockIDのみ uint16 x 10000)
				var oldData struct {
					Table []uint16 `json:"table"`
				}
				if err2 := json.Unmarshal([]byte(objs[0].Value), &oldData); err2 == nil && len(oldData.Table) == oldSize*oldSize {
					for gx := 0; gx < oldSize; gx++ {
						for gz := 0; gz < oldSize; gz++ {
							cx := gx / chunkSize
							cz := gz / chunkSize
							lx := gx % chunkSize
							lz := gz % chunkSize
							chunks[cx][cz].cells[lx][lz] = blockData{BlockID: oldData.Table[gx*oldSize+gz], R: 51, G: 102, B: 255, A: 255}
						}
					}
					logger.Info("Migrated old ground_table (100x100, blockID only) to chunk format")
					for cx := 0; cx < chunkCount; cx++ {
						for cz := 0; cz < chunkCount; cz++ {
							saveChunkToStorage(ctx, nk, logger, cx, cz)
						}
					}
				}
			}
		}
	}

	if loadedChunks > 0 {
		logger.Info("ground_table loaded: %d chunks", loadedChunks)
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
	if err := initializer.RegisterRpc("getGroundChunk", rpcGetGroundChunk); err != nil {
		return err
	}

	// ログイン検知（認証成功後）
	if err := initializer.RegisterAfterAuthenticateCustom(func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, out *api.Session, in *api.AuthenticateCustomRequest) error {
		uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
		username, _ := ctx.Value(runtime.RUNTIME_CTX_USERNAME).(string)
		fmt.Printf("[login] uid=%s username=%s customId=%s\n", uid, username, in.GetAccount().GetId())
		return nil
	}); err != nil {
		return err
	}

	// ログアウト（セッション切断）検知
	if err := initializer.RegisterEventSessionEnd(func(ctx context.Context, logger runtime.Logger, evt *api.Event) {
		uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
		username, _ := ctx.Value(runtime.RUNTIME_CTX_USERNAME).(string)
		fmt.Printf("[logout] uid=%s username=%s\n", uid, username)
	}); err != nil {
		return err
	}

	logger.Info("server_info module loaded (world=%dx%d, chunk=%dx%d, %dx%d chunks)", worldSize, worldSize, chunkSize, chunkSize, chunkCount, chunkCount)
	return nil
}
