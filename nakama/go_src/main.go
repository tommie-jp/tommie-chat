package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)

var serverUpTime = time.Now().UTC().Format(time.RFC3339)

// logf は時刻プレフィックス付きでログを出力する
func logf(format string, a ...interface{}) {
	ts := time.Now().Format("15:04:05")
	fmt.Printf(ts+" "+format, a...)
}

const (
	streamModeChannel uint8 = 2
	chatRoomLabel           = "world"
	chunkSize               = 16 // 1チャンク = 16x16セル
	chunkCount              = 64 // 64x64チャンク
	worldSize               = chunkSize * chunkCount // 1024x1024セル
	opInitPos      int64 = 1
	opMoveTarget   int64 = 2
	opAvatarChange int64 = 3
	opBlockUpdate  int64 = 4
	opAOIUpdate    int64 = 5
	opAOIEnter     int64 = 6 // AOI内に入ったプレイヤー情報
	opAOILeave     int64 = 7 // AOI外に出たプレイヤー通知
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
	hash  uint64 // FNV-1a 64bit ハッシュ（setBlock更新時に再計算）
}

// calcHash: チャンクのFNV-1a 64bitハッシュを計算してhashメンバに格納。呼び出し元がLock保持
func (ch *chunk) calcHash() {
	h := fnv.New64a()
	for lx := 0; lx < chunkSize; lx++ {
		for lz := 0; lz < chunkSize; lz++ {
			c := ch.cells[lx][lz]
			h.Write([]byte{
				uint8(c.BlockID & 0xFF), uint8(c.BlockID >> 8),
				c.R, c.G, c.B, c.A,
			})
		}
	}
	ch.hash = h.Sum64()
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
	logf("[getServerInfo] uid=%s\n", uid)
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
	logf("[getWorldMatch] uid=%s\n", uid)
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

// playerAOI はプレイヤーのArea of Interest（チャンク範囲）
type playerAOI struct {
	MinCX, MinCZ, MaxCX, MaxCZ int
}

// containsChunk はチャンク(cx,cz)がAOI内かどうか
func (a *playerAOI) containsChunk(cx, cz int) bool {
	return cx >= a.MinCX && cx <= a.MaxCX && cz >= a.MinCZ && cz <= a.MaxCZ
}

// playerPos はプレイヤーの最新位置（チャンク座標）
type playerPos struct {
	CX, CZ     int    // チャンク座標
	X, Z       float64 // ワールド座標
	RY         float64 // 回転
	TextureUrl string // アバターテクスチャ
}

// matchState はマッチの状態（プレイヤーごとのAOI管理）
type matchState struct {
	AOIs      map[string]*playerAOI      // sessionID -> AOI
	Presences map[string]runtime.Presence // sessionID -> Presence
	Positions map[string]*playerPos      // sessionID -> 位置
}

// worldMatch は Nakama マッチハンドラの実装
type worldMatch struct{}

func (m *worldMatch) MatchInit(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, params map[string]interface{}) (interface{}, int, string) {
	return &matchState{
		AOIs:      make(map[string]*playerAOI),
		Presences: make(map[string]runtime.Presence),
		Positions: make(map[string]*playerPos),
	}, 10, "world"
}

func (m *worldMatch) MatchJoinAttempt(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presence runtime.Presence, metadata map[string]string) (interface{}, bool, string) {
	return state, true, ""
}

func (m *worldMatch) MatchJoin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	ms := state.(*matchState)
	for _, p := range presences {
		sid := p.GetSessionId()
		ms.AOIs[sid] = &playerAOI{0, 0, chunkCount - 1, chunkCount - 1}
		ms.Presences[sid] = p
		ms.Positions[sid] = &playerPos{CX: 0, CZ: 0, X: 0, Z: 0, RY: 0, TextureUrl: ""}
	}
	return ms
}

func (m *worldMatch) MatchLeave(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	ms := state.(*matchState)
	for _, p := range presences {
		sid := p.GetSessionId()
		delete(ms.AOIs, sid)
		delete(ms.Presences, sid)
		delete(ms.Positions, sid)
	}
	return ms
}

// collectAOITargets は送信者のチャンク位置(cx,cz)がAOI内にある他プレイヤーを収集する
// AOI未登録のプレイヤーは全体可視とみなす（参加直後でまだsendAOIしていない場合）
func (ms *matchState) collectAOITargets(senderSID string, cx, cz int) []runtime.Presence {
	var targets []runtime.Presence
	for sid, p := range ms.Presences {
		if sid == senderSID {
			continue // 送信者自身はスキップ（reliable=true で自動受信）
		}
		aoi, hasAOI := ms.AOIs[sid]
		if !hasAOI || aoi.containsChunk(cx, cz) {
			targets = append(targets, p)
		}
	}
	return targets
}

func (m *worldMatch) MatchLoop(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, messages []runtime.MatchData) interface{} {
	ms := state.(*matchState)
	for _, msg := range messages {
		sid := msg.GetSessionId()
		op := msg.GetOpCode()

		if op == opAOIUpdate {
			// AOI更新: {"minCX":0,"minCZ":0,"maxCX":15,"maxCZ":15}
			var aoi struct {
				MinCX int `json:"minCX"`
				MinCZ int `json:"minCZ"`
				MaxCX int `json:"maxCX"`
				MaxCZ int `json:"maxCZ"`
			}
			if err := json.Unmarshal(msg.GetData(), &aoi); err != nil {
				continue
			}
			// クランプ
			if aoi.MinCX < 0 { aoi.MinCX = 0 }
			if aoi.MinCZ < 0 { aoi.MinCZ = 0 }
			if aoi.MaxCX >= chunkCount { aoi.MaxCX = chunkCount - 1 }
			if aoi.MaxCZ >= chunkCount { aoi.MaxCZ = chunkCount - 1 }

			oldAOI := ms.AOIs[sid]
			newAOI := &playerAOI{aoi.MinCX, aoi.MinCZ, aoi.MaxCX, aoi.MaxCZ}
			ms.AOIs[sid] = newAOI

			// AOI変更時: 新しいAOI内に入ったプレイヤーの情報を通知
			senderPresence, hasSender := ms.Presences[sid]
			if !hasSender {
				continue
			}
			for otherSID, otherPos := range ms.Positions {
				if otherSID == sid {
					continue
				}
				wasVisible := oldAOI != nil && oldAOI.containsChunk(otherPos.CX, otherPos.CZ)
				nowVisible := newAOI.containsChunk(otherPos.CX, otherPos.CZ)
				if nowVisible && !wasVisible {
					// このプレイヤーが新しく見えるようになった → OP_AOI_ENTER を送信
					logf("[send:AOI_ENTER] to=%s target=%s x=%.1f z=%.1f tex=%s (aoiChange)\n", sid, otherSID, otherPos.X, otherPos.Z, otherPos.TextureUrl)
					enterData, _ := json.Marshal(map[string]interface{}{
						"sessionId":  otherSID,
						"x":          otherPos.X,
						"z":          otherPos.Z,
						"ry":         otherPos.RY,
						"textureUrl": otherPos.TextureUrl,
					})
					dispatcher.BroadcastMessage(opAOIEnter, enterData, []runtime.Presence{senderPresence}, nil, true)
				} else if wasVisible && !nowVisible {
					// このプレイヤーがAOI外に出た → OP_AOI_LEAVE を送信
					logf("[send:AOI_LEAVE] to=%s target=%s (aoiChange)\n", sid, otherSID)
					leaveData, _ := json.Marshal(map[string]interface{}{
						"sessionId": otherSID,
					})
					dispatcher.BroadcastMessage(opAOILeave, leaveData, []runtime.Presence{senderPresence}, nil, true)
				}
			}
			continue
		}

		if op == opInitPos {
			// 初期位置: {"x":..., "z":..., "ry":...}
			var pos struct {
				X  float64 `json:"x"`
				Z  float64 `json:"z"`
				RY float64 `json:"ry"`
			}
			if err := json.Unmarshal(msg.GetData(), &pos); err == nil {
				half := float64(worldSize) / 2
				cx := int((pos.X + half) / chunkSize)
				cz := int((pos.Z + half) / chunkSize)
				if cx < 0 { cx = 0 }
				if cz < 0 { cz = 0 }
				if cx >= chunkCount { cx = chunkCount - 1 }
				if cz >= chunkCount { cz = chunkCount - 1 }
				if p, ok := ms.Positions[sid]; ok {
					p.CX = cx; p.CZ = cz; p.X = pos.X; p.Z = pos.Z; p.RY = pos.RY
				} else {
					ms.Positions[sid] = &playerPos{CX: cx, CZ: cz, X: pos.X, Z: pos.Z, RY: pos.RY}
				}
			}
			// 送信者のチャンク位置がAOI内のプレイヤーにだけ送信
			if p, ok := ms.Positions[sid]; ok {
				targets := ms.collectAOITargets(sid, p.CX, p.CZ)
				logf("[send:INIT_POS] from=%s x=%.1f z=%.1f chunk=(%d,%d) targets=%d\n", sid, p.X, p.Z, p.CX, p.CZ, len(targets))
				if len(targets) > 0 {
					dispatcher.BroadcastMessage(op, msg.GetData(), targets, msg, true)
				}
			}
			continue
		}

		if op == opMoveTarget {
			// 移動目標: {"x":..., "z":...}
			var pos struct {
				X float64 `json:"x"`
				Z float64 `json:"z"`
			}
			if err := json.Unmarshal(msg.GetData(), &pos); err == nil {
				half := float64(worldSize) / 2
				oldCX, oldCZ := -1, -1
				if p, ok := ms.Positions[sid]; ok {
					oldCX, oldCZ = p.CX, p.CZ
				}
				cx := int((pos.X + half) / chunkSize)
				cz := int((pos.Z + half) / chunkSize)
				if cx < 0 { cx = 0 }
				if cz < 0 { cz = 0 }
				if cx >= chunkCount { cx = chunkCount - 1 }
				if cz >= chunkCount { cz = chunkCount - 1 }
				if p, ok := ms.Positions[sid]; ok {
					p.CX = cx; p.CZ = cz; p.X = pos.X; p.Z = pos.Z
				} else {
					ms.Positions[sid] = &playerPos{CX: cx, CZ: cz, X: pos.X, Z: pos.Z}
				}
				// チャンクが変わった場合、新しいチャンクのAOIに入っている他プレイヤーに通知
				if cx != oldCX || cz != oldCZ {
					logf("[send:MOVE_TARGET] from=%s chunk=(%d,%d)->(%d,%d)\n", sid, oldCX, oldCZ, cx, cz)
					for otherSID, otherAOI := range ms.AOIs {
						if otherSID == sid {
							continue
						}
						wasVisible := oldCX >= 0 && otherAOI.containsChunk(oldCX, oldCZ)
						nowVisible := otherAOI.containsChunk(cx, cz)
						if nowVisible && !wasVisible {
							// 他プレイヤーのAOIに自分が入った → OP_AOI_ENTER
							if otherP, ok := ms.Presences[otherSID]; ok {
								myPos := ms.Positions[sid]
								logf("[send:AOI_ENTER] to=%s target=%s x=%.1f z=%.1f tex=%s (move)\n", otherSID, sid, myPos.X, myPos.Z, myPos.TextureUrl)
								enterData, _ := json.Marshal(map[string]interface{}{
									"sessionId":  sid,
									"x":          myPos.X,
									"z":          myPos.Z,
									"ry":         myPos.RY,
									"textureUrl": myPos.TextureUrl,
								})
								dispatcher.BroadcastMessage(opAOIEnter, enterData, []runtime.Presence{otherP}, nil, true)
							}
						} else if wasVisible && !nowVisible {
							// 他プレイヤーのAOIから自分が出た → OP_AOI_LEAVE
							if otherP, ok := ms.Presences[otherSID]; ok {
								logf("[send:AOI_LEAVE] to=%s target=%s (move)\n", otherSID, sid)
								leaveData, _ := json.Marshal(map[string]interface{}{
									"sessionId": sid,
								})
								dispatcher.BroadcastMessage(opAOILeave, leaveData, []runtime.Presence{otherP}, nil, true)
							}
						}
					}
				}
			}
			// AOIフィルタ: 送信者のチャンク位置が受信者のAOI内の場合のみ送信
			if p, ok := ms.Positions[sid]; ok {
				targets := ms.collectAOITargets(sid, p.CX, p.CZ)
				if len(targets) > 0 {
					dispatcher.BroadcastMessage(op, msg.GetData(), targets, msg, true)
				}
			}
			continue
		}

		if op == opAvatarChange {
			// アバター変更: {"textureUrl":...}
			var av struct {
				TextureUrl string `json:"textureUrl"`
			}
			if err := json.Unmarshal(msg.GetData(), &av); err == nil {
				logf("[avatarChange] sid=%s textureUrl=%s\n", sid, av.TextureUrl)
				if p, ok := ms.Positions[sid]; ok {
					p.TextureUrl = av.TextureUrl
				}
			}
			// 保存済みの位置でAOIフィルタ
			if p, ok := ms.Positions[sid]; ok {
				targets := ms.collectAOITargets(sid, p.CX, p.CZ)
				logf("[send:AVATAR_CHANGE] from=%s tex=%s targets=%d\n", sid, av.TextureUrl, len(targets))
				if len(targets) > 0 {
					dispatcher.BroadcastMessage(op, msg.GetData(), targets, msg, true)
				}
			}
			continue
		}

		// その他のメッセージは全員にブロードキャスト
		if err := dispatcher.BroadcastMessage(op, msg.GetData(), nil, msg, true); err != nil {
			logger.Warn("BroadcastMessage error: %v", err)
		}
	}
	return ms
}

func (m *worldMatch) MatchTerminate(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, graceSeconds int) interface{} {
	return state
}

func (m *worldMatch) MatchSignal(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, data string) (interface{}, string) {
	ms := state.(*matchState)

	// シグナルタイプをルーティング
	var sig struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(data), &sig); err == nil && sig.Type != "" {
		switch sig.Type {
		case "getPlayersAOI":
			return m.handleGetPlayersAOI(ms, data)
		}
	}

	// デフォルト: ブロック更新シグナル
	var blk struct {
		GX int `json:"gx"`
		GZ int `json:"gz"`
	}
	if err := json.Unmarshal([]byte(data), &blk); err != nil {
		dispatcher.BroadcastMessage(opBlockUpdate, []byte(data), nil, nil, false)
		return ms, data
	}
	cx := blk.GX / chunkSize
	cz := blk.GZ / chunkSize
	var targets []runtime.Presence
	for sid, aoi := range ms.AOIs {
		if aoi.containsChunk(cx, cz) {
			if p, ok := ms.Presences[sid]; ok {
				targets = append(targets, p)
			}
		}
	}
	logf("[setBlock:signal] chunk=(%d,%d) targets=%d/%d\n", cx, cz, len(targets), len(ms.AOIs))
	if len(targets) > 0 {
		if err := dispatcher.BroadcastMessage(opBlockUpdate, []byte(data), targets, nil, false); err != nil {
			logger.Warn("MatchSignal BroadcastMessage error: %v", err)
		}
	}
	return ms, data
}

// handleGetPlayersAOI は全プレイヤーのAOI情報を返す
func (m *worldMatch) handleGetPlayersAOI(ms *matchState, data string) (interface{}, string) {
	type aoiEntry struct {
		SessionID  string  `json:"sessionId"`
		Username   string  `json:"username"`
		MinCX      int     `json:"minCX"`
		MinCZ      int     `json:"minCZ"`
		MaxCX      int     `json:"maxCX"`
		MaxCZ      int     `json:"maxCZ"`
		X          float64 `json:"x"`
		Z          float64 `json:"z"`
	}
	var entries []aoiEntry
	for sid, aoi := range ms.AOIs {
		p, ok := ms.Presences[sid]
		if !ok {
			continue
		}
		var x, z float64
		if pos, ok := ms.Positions[sid]; ok {
			x = pos.X
			z = pos.Z
		}
		entries = append(entries, aoiEntry{
			SessionID: sid,
			Username:  p.GetUsername(),
			MinCX:     aoi.MinCX,
			MinCZ:     aoi.MinCZ,
			MaxCX:     aoi.MaxCX,
			MaxCZ:     aoi.MaxCZ,
			X:         x,
			Z:         z,
		})
	}
	result, _ := json.Marshal(map[string]interface{}{"players": entries})
	return ms, string(result)
}

// rpcPing はクライアントのラウンドトリップ時間計測用 RPC
func rpcPing(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ string) (string, error) {
	fmt.Println("[ping]")
	return "{}", nil
}

// rpcGetPlayersAOI は全プレイヤーのAOI情報を返す（MatchSignal経由）
func rpcGetPlayersAOI(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	matches, err := nk.MatchList(ctx, 1, true, "world", nil, nil, "")
	if err != nil || len(matches) == 0 {
		return `{"players":[]}`, nil
	}
	sigData, _ := json.Marshal(map[string]string{"type": "getPlayersAOI"})
	result, err := nk.MatchSignal(ctx, matches[0].GetMatchId(), string(sigData))
	if err != nil {
		logger.Warn("getPlayersAOI MatchSignal error: %v", err)
		return `{"players":[]}`, nil
	}
	return result, nil
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
	// チャンクごとにロックしてスナップショットを取る（ヒープ確保）
	snapshot := make([][]uint16, worldSize)
	for i := range snapshot { snapshot[i] = make([]uint16, worldSize) }
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
	logf("[setBlock] gx=%d gz=%d blockId=%d r=%d g=%d b=%d a=%d\n", req.GX, req.GZ, req.BlockID, req.R, req.G, req.B, req.A)
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
	ch.calcHash()
	ch.mu.Unlock()
	saveChunkToStorage(ctx, nk, logger, cx, cz)
	// dumpGroundTableCSV(logger)

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
	logf("[getGroundChunk] cx=%d cz=%d\n", req.CX, req.CZ)
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

// rpcGetGroundTable は廃止（ワールドが1024x1024になり全チャンク一括返却は非現実的）
func rpcGetGroundTable(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ string) (string, error) {
	fmt.Println("[getGroundTable] deprecated — use syncChunks")
	return `{"error":"deprecated: use syncChunks with AOI range"}`, nil
}

// rpcSyncChunks はクライアントのハッシュと比較し、差分チャンクだけ返す
// payload: {"minCX":0,"minCZ":0,"maxCX":15,"maxCZ":15,"hashes":{"0_0":"12345",...}}
// AOI範囲内のチャンクのみ比較し、差分を返す
func rpcSyncChunks(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, payload string) (string, error) {
	var req struct {
		MinCX  int               `json:"minCX"`
		MinCZ  int               `json:"minCZ"`
		MaxCX  int               `json:"maxCX"`
		MaxCZ  int               `json:"maxCZ"`
		Hashes map[string]string `json:"hashes"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", err
	}
	// クランプ
	if req.MinCX < 0 { req.MinCX = 0 }
	if req.MinCZ < 0 { req.MinCZ = 0 }
	if req.MaxCX >= chunkCount { req.MaxCX = chunkCount - 1 }
	if req.MaxCZ >= chunkCount { req.MaxCZ = chunkCount - 1 }
	if req.Hashes == nil { req.Hashes = make(map[string]string) }

	type chunkResp struct {
		CX    int    `json:"cx"`
		CZ    int    `json:"cz"`
		Hash  string `json:"hash"`
		Table []int  `json:"table"`
	}
	var diff []chunkResp
	total := 0

	for cx := req.MinCX; cx <= req.MaxCX; cx++ {
		for cz := req.MinCZ; cz <= req.MaxCZ; cz++ {
			total++
			key := fmt.Sprintf("%d_%d", cx, cz)
			ch := &chunks[cx][cz]
			ch.mu.RLock()
			serverHashStr := fmt.Sprintf("%d", ch.hash)
			ch.mu.RUnlock()
			if clientHash, ok := req.Hashes[key]; ok && clientHash == serverHashStr {
				continue
			}
			ch.mu.RLock()
			flat := ch.toFlat()
			h := fmt.Sprintf("%d", ch.hash)
			ch.mu.RUnlock()
			diff = append(diff, chunkResp{
				CX:    cx,
				CZ:    cz,
				Hash:  h,
				Table: flatToInts(flat),
			})
		}
	}
	logf("[syncChunks] sent=%d/%d (range %d,%d-%d,%d)\n", len(diff), total, req.MinCX, req.MinCZ, req.MaxCX, req.MaxCZ)
	b, err := json.Marshal(map[string]interface{}{"chunks": diff})
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
			ch.calcHash()
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
						chunks[cx][cz].calcHash()
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
							chunks[cx][cz].calcHash()
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
	if err := initializer.RegisterRpc("syncChunks", rpcSyncChunks); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("getPlayersAOI", rpcGetPlayersAOI); err != nil {
		return err
	}

	// ログイン検知（認証成功後）
	if err := initializer.RegisterAfterAuthenticateCustom(func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, out *api.Session, in *api.AuthenticateCustomRequest) error {
		uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
		username, _ := ctx.Value(runtime.RUNTIME_CTX_USERNAME).(string)
		logf("[login] uid=%s username=%s customId=%s\n", uid, username, in.GetAccount().GetId())
		return nil
	}); err != nil {
		return err
	}

	// ログアウト（セッション切断）検知
	if err := initializer.RegisterEventSessionEnd(func(ctx context.Context, logger runtime.Logger, evt *api.Event) {
		uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
		username, _ := ctx.Value(runtime.RUNTIME_CTX_USERNAME).(string)
		logf("[logout] uid=%s username=%s\n", uid, username)
	}); err != nil {
		return err
	}

	logger.Info("server_info module loaded (world=%dx%d, chunk=%dx%d, %dx%d chunks)", worldSize, worldSize, chunkSize, chunkSize, chunkCount, chunkCount)
	return nil
}
