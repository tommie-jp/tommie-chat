package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"hash/fnv"
	"net/http"
	_ "net/http/pprof"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)



// loginRateLimiter はログイン試行を秒あたりの最大数で制限する
var loginRateLimiter = newLoginRateLimiter()

type loginRateLimiterT struct {
	mu       sync.Mutex
	maxPerSec int
	window   []time.Time
}

func newLoginRateLimiter() *loginRateLimiterT {
	maxPerSec := 50
	if v := os.Getenv("MAX_LOGIN_RATE_PER_SEC"); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
			maxPerSec = n
		}
	}
	logf("loginRateLimiter: MAX_LOGIN_RATE_PER_SEC=%d\n", maxPerSec)
	return &loginRateLimiterT{maxPerSec: maxPerSec}
}

func (r *loginRateLimiterT) Allow() bool {
	now := time.Now()
	cutoff := now.Add(-time.Second)
	r.mu.Lock()
	defer r.mu.Unlock()
	// 1秒より古いエントリを削除
	i := 0
	for i < len(r.window) && r.window[i].Before(cutoff) {
		i++
	}
	r.window = r.window[i:]
	if len(r.window) >= r.maxPerSec {
		return false
	}
	r.window = append(r.window, now)
	return true
}

// displayNameCache は uid → 表示名 のキャッシュ
var displayNameCache sync.Map

// dn は uid に対応する表示名を "(name)" 形式で返す（未登録時は "(?)"）
func dn(uid string) string {
	if v, ok := displayNameCache.Load(uid); ok {
		return "(" + v.(string) + ")"
	}
	return "(?)"
}

// cacheDN は uid の表示名をキャッシュに登録する（未登録時のみ nk.UsersGetId を呼ぶ）
func cacheDN(ctx context.Context, nk runtime.NakamaModule, uid string) {
	if _, ok := displayNameCache.Load(uid); ok {
		return
	}
	users, err := nk.UsersGetId(ctx, []string{uid}, nil)
	if err != nil || len(users) == 0 {
		return
	}
	displayNameCache.Store(uid, users[0].DisplayName)
}

// logf は時刻プレフィックス付きでログを出力する
func logf(format string, a ...interface{}) {
	now := time.Now()
	ts := now.Format("15:04:05") + fmt.Sprintf(".%d", now.Nanosecond()/100_000_000)
	fmt.Printf(ts+" "+format, a...)
}

// ─── サーバサイド プロファイラ ───

type funcProfile struct {
	Calls   int64   `json:"calls"`
	TotalUs int64   `json:"totalUs"` // マイクロ秒
	MaxUs   int64   `json:"maxUs"`
}

var (
	profileMu   sync.RWMutex
	profileData = make(map[string]*funcProfile)
	profileOn   int32 // atomic: 0=off, 1=on
)

// prof はプロファイル計測を開始し、deferで呼ぶクロージャを返す
// 使い方: defer prof("funcName")()
func prof(name string) func() {
	if atomic.LoadInt32(&profileOn) == 0 {
		return func() {}
	}
	t0 := time.Now()
	return func() {
		us := time.Since(t0).Microseconds()
		profileMu.Lock()
		p, ok := profileData[name]
		if !ok {
			p = &funcProfile{}
			profileData[name] = p
		}
		p.Calls++
		p.TotalUs += us
		if us > p.MaxUs {
			p.MaxUs = us
		}
		profileMu.Unlock()
	}
}

func rpcProfileStart(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ string) (string, error) {
	profileMu.Lock()
	profileData = make(map[string]*funcProfile)
	profileMu.Unlock()
	atomic.StoreInt32(&profileOn, 1)
	logf("Profile started\n")
	return `{"status":"started"}`, nil
}

func rpcProfileStop(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ string) (string, error) {
	atomic.StoreInt32(&profileOn, 0)
	logf("Profile stopped\n")
	return `{"status":"stopped"}`, nil
}

func rpcProfileDump(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ string) (string, error) {
	profileMu.RLock()
	defer profileMu.RUnlock()
	type entry struct {
		Name    string  `json:"name"`
		Calls   int64   `json:"calls"`
		TotalMs float64 `json:"totalMs"`
		AvgUs   float64 `json:"avgUs"`
		MaxUs   int64   `json:"maxUs"`
	}
	var entries []entry
	for name, p := range profileData {
		avgUs := float64(0)
		if p.Calls > 0 {
			avgUs = float64(p.TotalUs) / float64(p.Calls)
		}
		entries = append(entries, entry{
			Name:    name,
			Calls:   p.Calls,
			TotalMs: float64(p.TotalUs) / 1000.0,
			AvgUs:   avgUs,
			MaxUs:   p.MaxUs,
		})
	}
	b, _ := json.Marshal(map[string]interface{}{"profiling": atomic.LoadInt32(&profileOn) == 1, "functions": entries})
	return string(b), nil
}

const (
	streamModeChannel uint8 = 2
	chatRoomLabel           = "world"
	chunkSize               = 16 // 1チャンク = 16x16セル
	chunkCount              = 64 // 64x64チャンク
	worldSize               = chunkSize * chunkCount // 1024x1024セル
	// matchデータ opコード（WebSocket sendMatchState 経由の双方向メッセージ）
	// MatchLoop のメッセージキューで処理。同一接続内で送信順が保証される。
	// RPC と異なり非同期応答（別opコード）で結果を返す。
	opInitPos          int64 = 1  // C→S     ログイン時の初期位置・表示名・テクスチャ・loginTime
	opMoveTarget       int64 = 2  // C→S→C   クリック移動の目標位置（AOI内ブロードキャスト）
	opAvatarChange     int64 = 3  // C→S→C   アバターテクスチャ変更（AOI内ブロードキャスト）
	opBlockUpdate      int64 = 4  // C→S→C   ブロック設置/削除（AOI内ブロードキャスト＋Storage保存）
	opAOIUpdate        int64 = 5  // C→S     AOI範囲更新（チャンク座標）
	opAOIEnter         int64 = 6  // S→C     プレイヤーがAOI内に入った（位置のみ）
	opAOILeave         int64 = 7  // S→C     プレイヤーがAOI外に出た
	opDisplayName      int64 = 8  // C→S→C   表示名変更（全員ブロードキャスト）
	opProfileRequest   int64 = 9  // C→S     プロフィール要求（sessionId[]）
	opProfileResponse  int64 = 10 // S→C     プロフィール応答（要求者のみ）
	opPlayersAOIReq    int64 = 11 // C→S     全プレイヤーAOI情報要求
	opPlayersAOIResp   int64 = 12 // S→C     全プレイヤーAOI情報応答（要求者のみ）
	opChat             int64 = 13 // C→S→C   チャットメッセージ（全員ブロードキャスト）
	opSystemMsg        int64 = 14 // S→C     システムメッセージ（ログイン/ログアウト通知）
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

// dirtyChunks は更新されたチャンク座標のキュー（重複排除付き）
var (
	dirtyChunksMu  sync.Mutex
	dirtyChunksSet = make(map[[2]int]struct{}) // 重複排除用
)

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

// 同接数履歴（2層）
// 1秒間隔: 最大300サンプル（5分間）
// 1分間隔: 最大14400サンプル（10日間）
const (
	ccu1sMax        = 300   // 5分 × 60秒
	ccu1mMax        = 14400 // 10日 × 24時間 × 60分
	ccuSampleTicks  = 10    // 10tick/s × 1s = 10
	ccuMinuteTicks  = 600   // 10tick/s × 60s = 600
)

var (
	ccuMu          sync.Mutex
	ccuHistory1s   []int   // 1秒間隔サンプル
	ccuHistory1m   []int   // 1分間隔サンプル（1分間の平均値）
	ccuHistory1mTs []int64 // 1分間隔サンプルのUnix秒タイムスタンプ
	ccu1sAccum     []int   // 1分間の1sサンプル蓄積（平均計算用）
	ccuLiveCount   int64   // MatchJoin/Leaveで増減するリアルタイム同接数
)

func appendCcu1sSample(count int) {
	ccuMu.Lock()
	ccuHistory1s = append(ccuHistory1s, count)
	if len(ccuHistory1s) > ccu1sMax {
		ccuHistory1s = ccuHistory1s[len(ccuHistory1s)-ccu1sMax:]
	}
	ccu1sAccum = append(ccu1sAccum, count)
	ccuMu.Unlock()
}

func flushCcu1mSample() {
	ccuMu.Lock()
	if len(ccu1sAccum) > 0 {
		sum := 0
		for _, v := range ccu1sAccum {
			sum += v
		}
		avg := sum / len(ccu1sAccum)
		ccuHistory1m = append(ccuHistory1m, avg)
		ccuHistory1mTs = append(ccuHistory1mTs, time.Now().Unix())
		if len(ccuHistory1m) > ccu1mMax {
			ccuHistory1m = ccuHistory1m[len(ccuHistory1m)-ccu1mMax:]
			ccuHistory1mTs = ccuHistory1mTs[len(ccuHistory1mTs)-ccu1mMax:]
		}
		ccu1sAccum = ccu1sAccum[:0]
	}
	ccuMu.Unlock()
}

// getCcuHistoryRange は指定レンジの履歴を返す
// "1m"=直近60件(1s), "5m"=直近300件(1s), "1h"=直近60件(1m),
// "12h"=直近720件(1m), "1d"=直近1440件(1m), "10d"=全件(1m)
type ccuHistoryResult struct {
	Values     []int
	Timestamps []int64 // Unix秒。1sデータの場合はnil
}

func getCcuHistoryRange(rangeStr string) ccuHistoryResult {
	ccuMu.Lock()
	defer ccuMu.Unlock()

	var src []int
	var n int
	var maxSec int64 // 期間の秒数（0=件数のみでフィルタ）
	switch rangeStr {
	case "1m":
		src = ccuHistory1s
		n = 60
	case "5m":
		src = ccuHistory1s
		n = 300
	case "1h":
		src = ccuHistory1m
		n = 60
		maxSec = 3600
	case "12h":
		src = ccuHistory1m
		n = 720
		maxSec = 12 * 3600
	case "1d":
		src = ccuHistory1m
		n = 1440
		maxSec = 24 * 3600
	case "10d":
		src = ccuHistory1m
		n = 14400
		maxSec = 10 * 24 * 3600
	default:
		src = ccuHistory1s
		n = 300
	}

	// 1分間隔データはタイムスタンプでフィルタ（サーバ停止中のギャップを除外）
	if maxSec > 0 && len(ccuHistory1mTs) == len(src) {
		cutoff := time.Now().Unix() - maxSec
		startIdx := len(src)
		for i := len(ccuHistory1mTs) - 1; i >= 0; i-- {
			if ccuHistory1mTs[i] < cutoff {
				break
			}
			startIdx = i
		}
		vals := make([]int, len(src)-startIdx)
		copy(vals, src[startIdx:])
		ts := make([]int64, len(vals))
		copy(ts, ccuHistory1mTs[startIdx:])
		return ccuHistoryResult{Values: vals, Timestamps: ts}
	}

	if n > len(src) {
		n = len(src)
	}
	vals := make([]int, n)
	copy(vals, src[len(src)-n:])
	// 1sデータにはタイムスタンプなし
	return ccuHistoryResult{Values: vals}
}

func getLatestCcu() int {
	return int(atomic.LoadInt64(&ccuLiveCount))
}

// ストレージキー
const (
	groundCollection = "world_data"
	ccuCollection    = "ccu_data"
	ccuStorageKey    = "history_1m"
	systemUserID     = "00000000-0000-0000-0000-000000000000"
)

// marshalCcuHistory1m はccuHistory1mをJSON化して返す（ロック取得・解放込み）
func marshalCcuHistory1m() ([]byte, int, error) {
	ccuMu.Lock()
	n := len(ccuHistory1m)
	if n == 0 {
		ccuMu.Unlock()
		return nil, 0, nil
	}
	if len(ccuHistory1mTs) != n {
		ccuMu.Unlock()
		return nil, 0, fmt.Errorf("length mismatch ts=%d vals=%d", len(ccuHistory1mTs), n)
	}
	ts := make([]int64, n)
	vals := make([]int, n)
	copy(ts, ccuHistory1mTs)
	copy(vals, ccuHistory1m)
	ccuMu.Unlock()

	data, err := json.Marshal(struct {
		Timestamps []int64 `json:"timestamps"`
		Values     []int   `json:"values"`
	}{Timestamps: ts, Values: vals})
	return data, n, err
}

// saveCcuHistory1m は1分間隔の同接履歴をNakama StorageAPIで保存する（通常時用）
func saveCcuHistory1m(ctx context.Context, nk runtime.NakamaModule, logger runtime.Logger) {
	data, n, err := marshalCcuHistory1m()
	if n == 0 || err != nil {
		if err != nil {
			logger.Warn("saveCcuHistory1m: %v", err)
		}
		return
	}
	if _, err := nk.StorageWrite(ctx, []*runtime.StorageWrite{{
		Collection:      ccuCollection,
		Key:             ccuStorageKey,
		UserID:          systemUserID,
		Value:           string(data),
		PermissionRead:  0,
		PermissionWrite: 0,
	}}); err != nil {
		logger.Warn("saveCcuHistory1m StorageWrite: %v", err)
		return
	}
	logger.Info("saveCcuHistory1m: saved %d samples", n)
}


// loadCcuHistory1m はDBから1分間隔の同接履歴を復元する（過去10日分のみ）
func loadCcuHistory1m(ctx context.Context, nk runtime.NakamaModule, logger runtime.Logger) {
	objs, err := nk.StorageRead(ctx, []*runtime.StorageRead{{
		Collection: ccuCollection,
		Key:        ccuStorageKey,
		UserID:     systemUserID,
	}})
	if err != nil || len(objs) == 0 {
		return
	}
	var stored struct {
		Timestamps []int64 `json:"timestamps"`
		Values     []int   `json:"values"`
	}
	if err := json.Unmarshal([]byte(objs[0].Value), &stored); err != nil {
		logger.Warn("loadCcuHistory1m unmarshal: %v", err)
		return
	}
	if len(stored.Timestamps) != len(stored.Values) {
		logger.Warn("loadCcuHistory1m: length mismatch ts=%d vals=%d", len(stored.Timestamps), len(stored.Values))
		return
	}
	// 過去10日分のみフィルタ＋重複タイムスタンプ除去
	cutoff := time.Now().Unix() - int64(10*24*60*60)
	seen := make(map[int64]bool, len(stored.Timestamps))
	ccuMu.Lock()
	ccuHistory1m = ccuHistory1m[:0]
	ccuHistory1mTs = ccuHistory1mTs[:0]
	for i, t := range stored.Timestamps {
		if t >= cutoff && !seen[t] {
			seen[t] = true
			ccuHistory1m = append(ccuHistory1m, stored.Values[i])
			ccuHistory1mTs = append(ccuHistory1mTs, t)
		}
	}
	ccuMu.Unlock()
	logger.Info("loadCcuHistory1m: restored %d samples (filtered from %d, deduped)", len(ccuHistory1m), len(stored.Values))
}

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

// markChunkDirty は更新されたチャンク座標をキューに追加する（重複排除）
func markChunkDirty(cx, cz int) {
	key := [2]int{cx, cz}
	dirtyChunksMu.Lock()
	dirtyChunksSet[key] = struct{}{}
	dirtyChunksMu.Unlock()
}

// flushDirtyChunks はキューからダーティチャンクを取り出し、1回の StorageWrite でバッチ保存する
func flushDirtyChunks(ctx context.Context, nk runtime.NakamaModule, logger runtime.Logger) {
	dirtyChunksMu.Lock()
	if len(dirtyChunksSet) == 0 {
		dirtyChunksMu.Unlock()
		return
	}
	// キューをコピーしてクリア
	keys := make([][2]int, 0, len(dirtyChunksSet))
	for k := range dirtyChunksSet {
		keys = append(keys, k)
	}
	dirtyChunksSet = make(map[[2]int]struct{})
	dirtyChunksMu.Unlock()

	// 全ダーティチャンクを1回の StorageWrite でバッチ保存
	writes := make([]*runtime.StorageWrite, 0, len(keys))
	for _, k := range keys {
		cx, cz := k[0], k[1]
		ch := &chunks[cx][cz]
		ch.mu.RLock()
		flat := ch.toFlat()
		ch.mu.RUnlock()
		data, err := json.Marshal(struct {
			Table []int `json:"table"`
		}{Table: flatToInts(flat)})
		if err != nil {
			logger.Warn("saveChunk marshal chunk(%d,%d): %v", cx, cz, err)
			continue
		}
		writes = append(writes, &runtime.StorageWrite{
			Collection:      groundCollection,
			Key:             chunkStorageKey(cx, cz),
			UserID:          systemUserID,
			Value:           string(data),
			PermissionRead:  2,
			PermissionWrite: 1,
		})
	}
	if len(writes) > 0 {
		if _, err := nk.StorageWrite(ctx, writes); err != nil {
			logger.Warn("flushDirtyChunks StorageWrite %d chunks: %v", len(writes), err)
		} else {
			logf("flushDirtyChunks: saved %d chunks\n", len(writes))
		}
	}
}

// rpcGetServerInfo はサーバ情報（ノード名・バージョン・起動時刻・プレイヤー数）を返す
func rpcGetServerInfo(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	defer prof("rpcGetServerInfo")()
	uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	sid, _ := ctx.Value(runtime.RUNTIME_CTX_SESSION_ID).(string)
	cacheDN(ctx, nk, uid)
	logf("rcv getServerInfo uid=%s%s sid=%s\n", uid, dn(uid), shortSID(sid))
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
		// serverUpTime は運用情報のためクライアントには非公開
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

// worldMatchID はプロセス内で一意のワールドマッチIDをキャッシュする
var (
	worldMatchMu       sync.Mutex
	worldMatchID       string
	worldMatchCachedAt time.Time
)

// worldPlayersCache は getWorldMatch RPC 用のプレイヤー情報キャッシュ
type worldPlayerEntry struct {
	SessionID   string  `json:"sessionId"`
	X           float64 `json:"x"`
	Z           float64 `json:"z"`
	RY          float64 `json:"ry"`
	TextureUrl  string  `json:"textureUrl"`
	DisplayName string  `json:"displayName"`
}
var (
	worldPlayersMu    sync.RWMutex
	worldPlayersCache map[string]*worldPlayerEntry // sessionID -> entry
)

const worldMatchCacheTTL = 10 * time.Second

// buildWorldMatchResponse は matchId と現在のプレイヤーリストを含むレスポンスを構築する
func buildWorldMatchResponse(matchId string) map[string]interface{} {
	worldPlayersMu.RLock()
	players := make([]*worldPlayerEntry, 0, len(worldPlayersCache))
	for _, e := range worldPlayersCache {
		players = append(players, e)
	}
	worldPlayersMu.RUnlock()
	return map[string]interface{}{"matchId": matchId, "players": players}
}

// rpcGetWorldMatch は稼働中の "world" マッチを探し、なければ新規作成して返す
func rpcGetWorldMatch(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	defer prof("rpcGetWorldMatch")()
	uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	sid, _ := ctx.Value(runtime.RUNTIME_CTX_SESSION_ID).(string)
	cacheDN(ctx, nk, uid)
	logf("rcv getWorldMatch uid=%s%s sid=%s\n", uid, dn(uid), shortSID(sid))

	worldMatchMu.Lock()
	defer worldMatchMu.Unlock()

	// キャッシュを最優先で確認（MatchListはミリ秒以内に作成されたマッチを返さない場合がある）
	if worldMatchID != "" && time.Since(worldMatchCachedAt) < worldMatchCacheTTL {
		logger.Info("Returning cached world match: %s", worldMatchID)
		b, _ := json.Marshal(buildWorldMatchResponse(worldMatchID))
		return string(b), nil
	}

	// キャッシュが古い or 空の場合はMatchListで確認
	matches, err := nk.MatchList(ctx, 1, true, "world", nil, nil, "")
	if err != nil {
		logger.Warn("MatchList failed: %v", err)
	} else if len(matches) > 0 {
		worldMatchID = matches[0].GetMatchId()
		worldMatchCachedAt = time.Now()
		logger.Info("Found active world match: %s", worldMatchID)
		b, _ := json.Marshal(buildWorldMatchResponse(worldMatchID))
		return string(b), nil
	}

	// マッチが見つからない場合は新規作成
	worldMatchID, err = nk.MatchCreate(ctx, "world", map[string]interface{}{})
	if err != nil {
		worldMatchID = ""
		return "", err
	}
	worldMatchCachedAt = time.Now()
	logger.Info("Created world match: %s", worldMatchID)
	b, _ := json.Marshal(buildWorldMatchResponse(worldMatchID))
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
	CX, CZ      int     // チャンク座標
	X, Z        float64 // ワールド座標
	RY          float64 // 回転
	TextureUrl  string  // アバターテクスチャ
	CharCol     int     // スプライトシート キャラ列
	CharRow     int     // スプライトシート キャラ行
	DisplayName string  // 表示名
	LoginTime   string  // ログイン時刻(ISO8601)
	NameColor   string  // 名前色（#RRGGBB）
}

// matchState はマッチの状態（プレイヤーごとのAOI管理）
type matchState struct {
	AOIs             map[string]*playerAOI               // sessionID -> AOI
	Presences        map[string]runtime.Presence          // sessionID -> Presence
	Positions        map[string]*playerPos               // sessionID -> 位置
	PendingAOIEnter  map[string][]map[string]interface{} // recipientSID -> 未送信 AOI_ENTER エントリ
	PendingInit      map[string]*playerPos               // sessionID -> joinMatch metadata から取得した初期位置
	PrevSIDs         map[string]string                   // sessionID -> 前回セッションID（ゴーストキック用）
}

// worldMatch は Nakama マッチハンドラの実装
type worldMatch struct{}

func (m *worldMatch) MatchInit(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, params map[string]interface{}) (interface{}, int, string) {
	defer prof("MatchInit")()
	return &matchState{
		AOIs:            make(map[string]*playerAOI),
		Presences:       make(map[string]runtime.Presence),
		Positions:       make(map[string]*playerPos),
		PendingAOIEnter: make(map[string][]map[string]interface{}),
		PendingInit:     make(map[string]*playerPos),
		PrevSIDs:        make(map[string]string),
	}, 10, "world"
}

// shortSID はセッションIDを先頭8文字に切り詰める（クライアント送信用）
func shortSID(sid string) string {
	if len(sid) > 8 {
		return sid[:8]
	}
	return sid
}

func (m *worldMatch) MatchJoinAttempt(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presence runtime.Presence, metadata map[string]string) (interface{}, bool, string) {
	defer prof("MatchJoinAttempt")()
	if !loginRateLimiter.Allow() {
		return state, false, "too many logins, try again later"
	}
	ms := state.(*matchState)
	newSID := presence.GetSessionId()

	// metadata から初期位置を保存（joinMatch 1回で全て完結するため）
	if metadata != nil {
		x, _ := strconv.ParseFloat(metadata["x"], 64)
		z, _ := strconv.ParseFloat(metadata["z"], 64)
		ry, _ := strconv.ParseFloat(metadata["ry"], 64)
		cc, _ := strconv.Atoi(metadata["cc"])
		cr, _ := strconv.Atoi(metadata["cr"])
		ms.PendingInit[newSID] = &playerPos{
			X: x, Z: z, RY: ry,
			TextureUrl:  metadata["tx"],
			DisplayName: metadata["dn"],
			LoginTime:   metadata["lt"],
			CharCol:     cc,
			CharRow:     cr,
			NameColor:   metadata["nc"],
		}
		logger.Info("PendingInit stored for sid=%s x=%.1f z=%.1f prevSid=%s", shortSID(newSID), x, z, metadata["prevSid"])
		// 前回セッションIDを保存（MatchJoin でゴーストキック用）
		if prevSid := metadata["prevSid"]; prevSid != "" {
			ms.PrevSIDs[newSID] = prevSid
		}
	}

	return state, true, ""
}

func (m *worldMatch) MatchJoin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	defer prof("MatchJoin")()
	ms := state.(*matchState)
	half := float64(worldSize / 2)
	for _, p := range presences {
		sid := p.GetSessionId()
		uid := p.GetUserId()

		// 前回セッションIDが指定されていれば、そのセッションをキック（ゴーストアバター防止）
		if prevSid, ok := ms.PrevSIDs[sid]; ok && prevSid != "" {
			if oldP, exists := ms.Presences[prevSid]; exists {
				logger.Info("MatchKick prevSid: old=%s new=%s", shortSID(prevSid), shortSID(sid))
				dispatcher.MatchKick([]runtime.Presence{oldP})

				// MatchLoop が MatchJoin より先に実行されるため、キック対象の
				// AOI_ENTER が既にフラッシュ済みの場合がある。
				// 明示的に AOI_LEAVE を全員に送信して打ち消す。
				leaveData, _ := json.Marshal(map[string]interface{}{"sessionId": prevSid})
				var leaveTargets []runtime.Presence
				for otherSID2, otherP2 := range ms.Presences {
					if otherSID2 != prevSid && otherSID2 != sid {
						leaveTargets = append(leaveTargets, otherP2)
					}
				}
				if len(leaveTargets) > 0 {
					dispatcher.BroadcastMessage(opAOILeave, leaveData, leaveTargets, nil, true)
				}

				// ステートから即座に除去
				delete(ms.Presences, prevSid)
				delete(ms.Positions, prevSid)
				delete(ms.AOIs, prevSid)
				delete(ms.PendingInit, prevSid)
				delete(ms.PendingAOIEnter, prevSid)
				delete(ms.PrevSIDs, prevSid)
				for recipSID, entries := range ms.PendingAOIEnter {
					filtered := entries[:0]
					for _, e := range entries {
						if e["sessionId"] != prevSid {
							filtered = append(filtered, e)
						}
					}
					if len(filtered) > 0 {
						ms.PendingAOIEnter[recipSID] = filtered
					} else {
						delete(ms.PendingAOIEnter, recipSID)
					}
				}
				worldPlayersMu.Lock()
				delete(worldPlayersCache, prevSid)
				worldPlayersMu.Unlock()
			}
			delete(ms.PrevSIDs, sid)
		}

		ms.AOIs[sid] = &playerAOI{-1, -1, -1, -1}
		ms.Presences[sid] = p

		// PendingInit があれば初期位置を即座に登録（joinMatch 1回で完結）
		if init, ok := ms.PendingInit[sid]; ok {
			cx := int((init.X + half) / chunkSize)
			cz := int((init.Z + half) / chunkSize)
			if cx < 0 { cx = 0 }
			if cz < 0 { cz = 0 }
			if cx >= chunkCount { cx = chunkCount - 1 }
			if cz >= chunkCount { cz = chunkCount - 1 }
			init.CX = cx
			init.CZ = cz
			ms.Positions[sid] = init
			delete(ms.PendingInit, sid)
			logger.Info("MatchJoin with init pos: uid=%s sid=%s x=%.1f z=%.1f", uid, shortSID(sid), init.X, init.Z)

			// displayNameCache 更新
			if init.DisplayName != "" {
				displayNameCache.Store(uid, init.DisplayName)
			}
			// グローバルキャッシュ更新
			if init.TextureUrl != "" {
				worldPlayersMu.Lock()
				if worldPlayersCache == nil { worldPlayersCache = make(map[string]*worldPlayerEntry) }
				worldPlayersCache[sid] = &worldPlayerEntry{SessionID: sid, X: init.X, Z: init.Z, RY: init.RY, TextureUrl: init.TextureUrl, DisplayName: init.DisplayName}
				worldPlayersMu.Unlock()
			}
		} else {
			ms.Positions[sid] = &playerPos{CX: -1, CZ: -1, X: 0, Z: 0, RY: 0, TextureUrl: ""}
		}

		// システムメッセージ: ログイン通知を全員に送信
		uname := p.GetUsername()
		sysMsg, _ := json.Marshal(map[string]interface{}{
			"type":     "join",
			"username": uname,
			"userId":   uid,
		})
		dispatcher.BroadcastMessage(opSystemMsg, sysMsg, nil, p, true)
	}
	return ms
}

func (m *worldMatch) MatchLeave(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	defer prof("MatchLeave")()
	ms := state.(*matchState)
	half := float64(worldSize / 2)
	for _, p := range presences {
		sid := p.GetSessionId()
		// 退出プレイヤーの位置を取得し、そのチャンクをAOIに含む他プレイヤーへAOI_LEAVEを通知
		if pos, ok := ms.Positions[sid]; ok {
			cx, cz := pos.CX, pos.CZ
			if cx < 0 {
				// initPos未受信の場合はX/Z座標からチャンクを算出
				cx = int((pos.X + half) / chunkSize)
				cz = int((pos.Z + half) / chunkSize)
			}
			leaveData, _ := json.Marshal(map[string]interface{}{"sessionId": sid})
			for otherSID, otherAOI := range ms.AOIs {
				if otherSID == sid {
					continue
				}
				if otherAOI.containsChunk(cx, cz) {
					if otherP, ok := ms.Presences[otherSID]; ok {
						toUID := otherP.GetUserId()
						logf("snd AOI_LEAVE uid=%s%s sid=%s about=%s\n", toUID, dn(toUID), shortSID(otherSID), shortSID(sid))
						dispatcher.BroadcastMessage(opAOILeave, leaveData, []runtime.Presence{otherP}, nil, true)
					}
				}
			}
		}
		// システムメッセージ: ログアウト通知を全員に送信
		uname := p.GetUsername()
		uid := p.GetUserId()
		sysMsg, _ := json.Marshal(map[string]interface{}{
			"type":     "leave",
			"username": uname,
			"userId":   uid,
		})
		// 残っている全プレゼンスに送信（退出者自身は除外済み）
		var targets []runtime.Presence
		for otherSID, otherP := range ms.Presences {
			if otherSID != sid { targets = append(targets, otherP) }
		}
		if len(targets) > 0 {
			dispatcher.BroadcastMessage(opSystemMsg, sysMsg, targets, nil, true)
		}

		delete(ms.AOIs, sid)
		delete(ms.Presences, sid)
		delete(ms.Positions, sid)
		delete(ms.PendingInit, sid)
		delete(ms.PrevSIDs, sid)
		// PendingAOIEnter からも除去（退出セッション宛の通知 + 退出セッションに関する通知）
		delete(ms.PendingAOIEnter, sid)
		for recipSID, entries := range ms.PendingAOIEnter {
			filtered := entries[:0]
			for _, e := range entries {
				if e["sessionId"] != sid {
					filtered = append(filtered, e)
				}
			}
			if len(filtered) > 0 {
				ms.PendingAOIEnter[recipSID] = filtered
			} else {
				delete(ms.PendingAOIEnter, recipSID)
			}
		}
		worldPlayersMu.Lock()
		delete(worldPlayersCache, sid)
		worldPlayersMu.Unlock()
	}
	// 最後のプレイヤーが退出したらダーティチャンクを即座に保存
	if len(ms.Presences) == 0 {
		flushDirtyChunks(ctx, nk, logger)
	}
	return ms
}

// collectAOITargets は送信者のチャンク位置(cx,cz)がAOI内にある他プレイヤーを収集する
// AOI未登録のプレイヤーは全体可視とみなす（参加直後でまだsendAOIしていない場合）
func (ms *matchState) collectAOITargets(senderSID string, cx, cz int) []runtime.Presence {
	defer prof("collectAOITargets")()
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
	defer prof("MatchLoop")()
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
			aoiUID := ""
			if p, ok := ms.Presences[sid]; ok { aoiUID = p.GetUserId() }
			logf("rcv AOI_UPDATE uid=%s%s sid=%s (%d,%d)-(%d,%d)\n", aoiUID, dn(aoiUID), shortSID(sid), aoi.MinCX, aoi.MinCZ, aoi.MaxCX, aoi.MaxCZ)
			logf("rcv DBG AOI_UPDATE sid=%s newAOI=(%d,%d)-(%d,%d) checking %d other players\n", shortSID(sid), aoi.MinCX, aoi.MinCZ, aoi.MaxCX, aoi.MaxCZ, len(ms.Positions)-1)
			half := float64(worldSize) / 2
			// AOI_ENTER はバルク送信（N-1件→1件に削減）
			var enterBulk []map[string]interface{}
			toUID := senderPresence.GetUserId()
			for otherSID, otherPos := range ms.Positions {
				if otherSID == sid {
					continue
				}
				// CX<0はopInitPos未受信（センチネル）→ X/Z座標から正確なchunkを算出
				effectiveCX, effectiveCZ := otherPos.CX, otherPos.CZ
				if effectiveCX < 0 {
					effectiveCX = int((otherPos.X + half) / chunkSize)
					effectiveCZ = int((otherPos.Z + half) / chunkSize)
				}
				wasVisible := oldAOI != nil && oldAOI.containsChunk(effectiveCX, effectiveCZ)
				nowVisible := newAOI.containsChunk(effectiveCX, effectiveCZ)
				logf("rcv DBG AOI_UPDATE sid=%s other=%s CX=%d CZ=%d effCX=%d effCZ=%d nowVisible=%v wasVisible=%v\n", shortSID(sid), shortSID(otherSID), otherPos.CX, otherPos.CZ, effectiveCX, effectiveCZ, nowVisible, wasVisible)
				if nowVisible && !wasVisible {
					// このプレイヤーが新しく見えるようになった → バルクリストに追加
					logf("snd AOI_ENTER uid=%s%s sid=%s about=%s\n", toUID, dn(toUID), shortSID(sid), shortSID(otherSID))
					enterBulk = append(enterBulk, map[string]interface{}{
						"sessionId": otherSID,
						"x":         otherPos.X,
						"z":         otherPos.Z,
						"ry":        otherPos.RY,
					})
				} else if wasVisible && !nowVisible {
					// このプレイヤーがAOI外に出た → OP_AOI_LEAVE を送信
					logf("snd AOI_LEAVE uid=%s%s sid=%s about=%s\n", toUID, dn(toUID), shortSID(sid), shortSID(otherSID))
					leaveData, _ := json.Marshal(map[string]interface{}{
						"sessionId": otherSID,
					})
					dispatcher.BroadcastMessage(opAOILeave, leaveData, []runtime.Presence{senderPresence}, nil, true)
				}
			}
			// AOI_ENTER をバッファに積む（aoiEnterFlushTicks 後にバルクフラッシュ）
			for _, entry := range enterBulk {
				ms.PendingAOIEnter[sid] = append(ms.PendingAOIEnter[sid], entry)
			}
			continue
		}

		if op == opInitPos {
			// 初期位置: {"x":..., "z":..., "ry":..., "lt":..., "dn":..., "tx":..., "cc":..., "cr":...}
			var pos struct {
				X           float64 `json:"x"`
				Z           float64 `json:"z"`
				RY          float64 `json:"ry"`
				TextureUrl  string  `json:"tx"`
				DisplayName string  `json:"dn"`
				LoginTime   string  `json:"lt"`
				CharCol     int     `json:"cc"`
				CharRow     int     `json:"cr"`
				NameColor   string  `json:"nc"`
			}
			if err := json.Unmarshal(msg.GetData(), &pos); err == nil {
				initUID := ""
				if p, ok := ms.Presences[sid]; ok { initUID = p.GetUserId() }
				logf("rcv initPos uid=%s%s sid=%s x=%.1f z=%.1f\n", initUID, dn(initUID), shortSID(sid), pos.X, pos.Z)
				half := float64(worldSize) / 2
				cx := int((pos.X + half) / chunkSize)
				cz := int((pos.Z + half) / chunkSize)
				if cx < 0 { cx = 0 }
				if cz < 0 { cz = 0 }
				if cx >= chunkCount { cx = chunkCount - 1 }
				if cz >= chunkCount { cz = chunkCount - 1 }
				oldCX, oldCZ := -1, -1
				if p, ok := ms.Positions[sid]; ok {
					oldCX, oldCZ = p.CX, p.CZ
					p.CX = cx; p.CZ = cz; p.X = pos.X; p.Z = pos.Z; p.RY = pos.RY
					if pos.TextureUrl != "" { p.TextureUrl = pos.TextureUrl }
					p.CharCol = pos.CharCol; p.CharRow = pos.CharRow
					if pos.DisplayName != "" { p.DisplayName = pos.DisplayName }
					if pos.LoginTime != "" { p.LoginTime = pos.LoginTime }
					if pos.NameColor != "" { p.NameColor = pos.NameColor }
				} else {
					ms.Positions[sid] = &playerPos{CX: cx, CZ: cz, X: pos.X, Z: pos.Z, RY: pos.RY, TextureUrl: pos.TextureUrl, CharCol: pos.CharCol, CharRow: pos.CharRow, DisplayName: pos.DisplayName, LoginTime: pos.LoginTime, NameColor: pos.NameColor}
				}
				logf("rcv DBG INIT_POS sid=%s oldCX=%d newCX=%d oldCZ=%d newCZ=%d\n", shortSID(sid), oldCX, cx, oldCZ, cz)
				// チャンクが変わった場合、他プレイヤーのAOIへの入退場を通知（opMoveTargetと同様）
				logf("rcv DBG INIT_POS sid=%s cx=%d cz=%d oldCX=%d oldCZ=%d chunkChanged=%v\n", shortSID(sid), cx, cz, oldCX, oldCZ, cx != oldCX || cz != oldCZ)
				if cx != oldCX || cz != oldCZ {
					// AOI_ENTER: 自分の参加を他プレイヤーへ通知（presencesをまとめてBroadcastMessage1回）
					var enterTargets []runtime.Presence
					for otherSID, otherAOI := range ms.AOIs {
						if otherSID == sid { continue }
						wasVisible := oldCX >= 0 && otherAOI.containsChunk(oldCX, oldCZ)
						nowVisible := otherAOI.containsChunk(cx, cz)
						logf("rcv DBG INIT_POS sid=%s other=%s AOI=(%d,%d)-(%d,%d) nowVisible=%v\n", shortSID(sid), shortSID(otherSID), otherAOI.MinCX, otherAOI.MinCZ, otherAOI.MaxCX, otherAOI.MaxCZ, nowVisible)
						if nowVisible && !wasVisible {
							if otherP, ok := ms.Presences[otherSID]; ok {
								toUID := otherP.GetUserId()
								logf("snd AOI_ENTER uid=%s%s sid=%s about=%s\n", toUID, dn(toUID), shortSID(otherSID), shortSID(sid))
								enterTargets = append(enterTargets, otherP)
							}
						}
					}
					if len(enterTargets) > 0 {
						myPos := ms.Positions[sid]
						entry := map[string]interface{}{
							"sessionId": sid,
							"x":         myPos.X,
							"z":         myPos.Z,
							"ry":        myPos.RY,
						}
						// AOI_ENTER をバッファに積む（aoiEnterFlushTicks 後にバルクフラッシュ）
						for _, otherP := range enterTargets {
							recipSID := otherP.GetSessionId()
							ms.PendingAOIEnter[recipSID] = append(ms.PendingAOIEnter[recipSID], entry)
						}
					}
				}
			}
			// RPC用グローバルキャッシュを更新
			if p, ok := ms.Positions[sid]; ok && p.TextureUrl != "" {
				worldPlayersMu.Lock()
				if worldPlayersCache == nil { worldPlayersCache = make(map[string]*worldPlayerEntry) }
				worldPlayersCache[sid] = &worldPlayerEntry{SessionID: sid, X: p.X, Z: p.Z, RY: p.RY, TextureUrl: p.TextureUrl, DisplayName: p.DisplayName}
				worldPlayersMu.Unlock()
			}
			// 送信者のチャンク位置がAOI内のプレイヤーにだけ送信
			if p, ok := ms.Positions[sid]; ok {
				targets := ms.collectAOITargets(sid, p.CX, p.CZ)
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
				moveUID := ""
				if p, ok := ms.Presences[sid]; ok { moveUID = p.GetUserId() }
				logf("rcv moveTarget uid=%s%s sid=%s x=%.1f z=%.1f\n", moveUID, dn(moveUID), shortSID(sid), pos.X, pos.Z)
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
								enterData, _ := json.Marshal(map[string]interface{}{
									"sessionId": sid,
									"x":         myPos.X,
									"z":         myPos.Z,
									"ry":        myPos.RY,
								})
								dispatcher.BroadcastMessage(opAOIEnter, enterData, []runtime.Presence{otherP}, nil, true)
							}
						} else if wasVisible && !nowVisible {
							// 他プレイヤーのAOIから自分が出た → OP_AOI_LEAVE
							if otherP, ok := ms.Presences[otherSID]; ok {
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
					logf("snd moveTarget sid=%s targets=%d\n", shortSID(sid), len(targets))
					dispatcher.BroadcastMessage(op, msg.GetData(), targets, msg, true)
				}
			}
			continue
		}

		if op == opAvatarChange {
			// アバター変更: {"textureUrl":..., "cc":..., "cr":...}
			var av struct {
				TextureUrl string `json:"textureUrl"`
				CharCol    int    `json:"cc"`
				CharRow    int    `json:"cr"`
			}
			if err := json.Unmarshal(msg.GetData(), &av); err == nil {
				avatarUID := ""
				if p, ok := ms.Presences[sid]; ok { avatarUID = p.GetUserId() }
				logf("rcv avatarChange uid=%s%s sid=%s\n", avatarUID, dn(avatarUID), shortSID(sid))
				if p, ok := ms.Positions[sid]; ok {
					p.TextureUrl = av.TextureUrl
					p.CharCol = av.CharCol
					p.CharRow = av.CharRow
				}
			}
			// 保存済みの位置でAOIフィルタ
			if p, ok := ms.Positions[sid]; ok {
				targets := ms.collectAOITargets(sid, p.CX, p.CZ)
				if len(targets) > 0 {
					logf("snd avatarChange sid=%s targets=%d\n", shortSID(sid), len(targets))
					dispatcher.BroadcastMessage(op, msg.GetData(), targets, msg, true)
				}
			}
			continue
		}

		if op == opBlockUpdate {
			// ブロック設置/削除: {"gx":...,"gz":...,"blockId":...,"r":...,"g":...,"b":...,"a":...}
			var req blockReq
			if err := json.Unmarshal(msg.GetData(), &req); err != nil {
				continue
			}
			logf("rcv setBlock(match) sid=%s gx=%d gz=%d blockId=%d\n", shortSID(sid), req.GX, req.GZ, req.BlockID)
			if req.GX < 0 || req.GX >= worldSize || req.GZ < 0 || req.GZ >= worldSize {
				continue
			}
			a := req.A
			if a == 0 { a = 255 }
			cx := req.GX / chunkSize
			cz := req.GZ / chunkSize
			lx := req.GX % chunkSize
			lz := req.GZ % chunkSize
			ch := &chunks[cx][cz]
			ch.mu.Lock()
			ch.cells[lx][lz] = blockData{BlockID: req.BlockID, R: req.R, G: req.G, B: req.B, A: a}
			ch.calcHash()
			ch.mu.Unlock()
			markChunkDirty(cx, cz)
			// AOI内のプレイヤーにブロードキャスト
			var targets []runtime.Presence
			for aoiSid, aoi := range ms.AOIs {
				if aoi.containsChunk(cx, cz) {
					if p, ok := ms.Presences[aoiSid]; ok {
						targets = append(targets, p)
					}
				}
			}
			if len(targets) > 0 {
				logf("snd blockUpdate sid=%s chunk=(%d,%d) targets=%d\n", shortSID(sid), cx, cz, len(targets))
				dispatcher.BroadcastMessage(opBlockUpdate, msg.GetData(), targets, nil, false)
			}
			continue
		}

		if op == opPlayersAOIReq {
			// 全プレイヤーAOI情報要求 → 応答を送信者に返す
			type aoiEntry struct {
				SessionID string  `json:"sessionId"`
				Username  string  `json:"username"`
				MinCX     int     `json:"minCX"`
				MinCZ     int     `json:"minCZ"`
				MaxCX     int     `json:"maxCX"`
				MaxCZ     int     `json:"maxCZ"`
				X         float64 `json:"x"`
				Z         float64 `json:"z"`
			}
			var entries []aoiEntry
			for aoiSid, aoi := range ms.AOIs {
				p, ok := ms.Presences[aoiSid]
				if !ok { continue }
				var x, z float64
				if pos, ok := ms.Positions[aoiSid]; ok { x = pos.X; z = pos.Z }
				entries = append(entries, aoiEntry{
					SessionID: shortSID(aoiSid), Username: p.GetUsername(),
					MinCX: aoi.MinCX, MinCZ: aoi.MinCZ, MaxCX: aoi.MaxCX, MaxCZ: aoi.MaxCZ,
					X: x, Z: z,
				})
			}
			respData, _ := json.Marshal(map[string]interface{}{"players": entries})
			if senderP, ok := ms.Presences[sid]; ok {
				dispatcher.BroadcastMessage(opPlayersAOIResp, respData, []runtime.Presence{senderP}, nil, true)
			}
			continue
		}

		if op == opProfileRequest {
			// プロフィール要求: {"sessionIds":["sid1","sid2",...]}
			var req struct {
				SessionIds []string `json:"sessionIds"`
			}
			if err := json.Unmarshal(msg.GetData(), &req); err == nil {
				type profileEntry struct {
					SessionId   string `json:"sessionId"`
					DisplayName string `json:"displayName"`
					TextureUrl  string `json:"textureUrl"`
					CharCol     int    `json:"cc"`
					CharRow     int    `json:"cr"`
					LoginTime   string `json:"loginTime"`
					NameColor   string `json:"nameColor,omitempty"`
				}
				profiles := make([]profileEntry, 0, len(req.SessionIds))
				for _, reqSid := range req.SessionIds {
					pos, ok := ms.Positions[reqSid]
					if !ok {
						continue
					}
					profiles = append(profiles, profileEntry{
						SessionId:   reqSid,
						DisplayName: pos.DisplayName,
						TextureUrl:  pos.TextureUrl,
						CharCol:     pos.CharCol,
						CharRow:     pos.CharRow,
						LoginTime:   pos.LoginTime,
						NameColor:   pos.NameColor,
					})
				}
				respData, _ := json.Marshal(map[string]interface{}{"profiles": profiles})
				logf("snd profileResponse sid=%s count=%d\n", shortSID(sid), len(profiles))
				if senderP, ok := ms.Presences[sid]; ok {
					dispatcher.BroadcastMessage(opProfileResponse, respData, []runtime.Presence{senderP}, nil, true)
				}
			}
			continue
		}

		if op == opDisplayName {
			// 表示名変更: {"displayName":..., "nc":...}
			var dn struct {
				DisplayName string `json:"displayName"`
				NameColor   string `json:"nc"`
			}
			if err := json.Unmarshal(msg.GetData(), &dn); err == nil {
				if p, ok := ms.Positions[sid]; ok {
					p.DisplayName = dn.DisplayName
					if dn.NameColor != "" { p.NameColor = dn.NameColor }
				}
			}
			// 表示名はユーザリスト全体に影響するため全員にブロードキャスト（AOIフィルタなし）
			dispatcher.BroadcastMessage(op, msg.GetData(), nil, msg, true)
			continue
		}

		if op == opChat {
			// チャットメッセージ: 全員にブロードキャスト（AOIフィルタなし）
			// クライアントは {"text":"..."} を送信。サーバーは username/userId を付与して転送
			var chatMsg map[string]interface{}
			if err := json.Unmarshal(msg.GetData(), &chatMsg); err == nil {
				if p, ok := ms.Presences[sid]; ok {
					chatMsg["username"] = p.GetUsername()
					chatMsg["userId"] = p.GetUserId()
					enriched, _ := json.Marshal(chatMsg)
					dispatcher.BroadcastMessage(opChat, enriched, nil, nil, true)
				}
			}
			continue
		}

		// その他のメッセージは全員にブロードキャスト
		if err := dispatcher.BroadcastMessage(op, msg.GetData(), nil, msg, true); err != nil {
			logger.Warn("BroadcastMessage error: %v", err)
		}
	}

	// AOI_ENTER バッファ: 同一tick内の通知をバルクにまとめて送信
	if len(ms.PendingAOIEnter) > 0 {
		for recipSID, entries := range ms.PendingAOIEnter {
			if p, ok := ms.Presences[recipSID]; ok && len(entries) > 0 {
				data, _ := json.Marshal(entries)
				dispatcher.BroadcastMessage(opAOIEnter, data, []runtime.Presence{p}, nil, true)
			}
		}
		ms.PendingAOIEnter = make(map[string][]map[string]interface{})
	}

	// 同接数サンプリング（1秒ごと）
	if tick%ccuSampleTicks == 0 {
		n := len(ms.Presences)
		appendCcu1sSample(n)
		atomic.StoreInt64(&ccuLiveCount, int64(n))
	}
	// 1分ごとに1m履歴へフラッシュ
	if tick%ccuMinuteTicks == 0 {
		flushCcu1mSample()
	}

	// ダーティチャンクをDBにバッチ保存（60秒ごと）
	if tick%600 == 0 {
		flushDirtyChunks(ctx, nk, logger)
	}

	return ms
}

func (m *worldMatch) MatchTerminate(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, graceSeconds int) interface{} {
	defer prof("MatchTerminate")()
	logger.Info("MatchTerminate called: graceSeconds=%d tick=%d", graceSeconds, tick)
	// シャットダウン時: ダーティチャンクを保存
	flushDirtyChunks(ctx, nk, logger)
	// 未フラッシュの1sデータを1mに追加してからDB保存
	flushCcu1mSample()
	saveCcuHistory1m(ctx, nk, logger)
	// キャッシュをクリア（次の getWorldMatch で新マッチが作成される）
	worldMatchMu.Lock()
	worldMatchID = ""
	worldMatchMu.Unlock()
	return state
}

func (m *worldMatch) MatchSignal(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ runtime.MatchDispatcher, _ int64, state interface{}, data string) (interface{}, string) {
	return state, data
}

// rpcPing はクライアントのラウンドトリップ時間計測用 RPC
func rpcPing(_ context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, _ string) (string, error) {
	defer prof("rpcPing")()
	return "{}", nil
}

// rpcGetPlayerCount は現在の同接数を返す RPC
// payload: {"range":"5m"} で履歴も返す。range省略時は count のみ。
func rpcGetPlayerCount(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	defer prof("rpcGetPlayerCount")()
	var req struct {
		Range string `json:"range"`
	}
	if payload != "" {
		json.Unmarshal([]byte(payload), &req)
	}

	// 1秒キャッシュから最新の同接数を取得
	count := getLatestCcu()
	out := map[string]interface{}{"count": count}
	if req.Range != "" {
		hr := getCcuHistoryRange(req.Range)
		out["history"] = hr.Values
		if hr.Timestamps != nil {
			out["timestamps"] = hr.Timestamps
		}
	}

	b, _ := json.Marshal(out)
	return string(b), nil
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

// rpcGetGroundChunk は指定チャンクの地面テーブルを返す
// payload: {"cx":0,"cz":0}
func rpcGetGroundChunk(ctx context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, payload string) (string, error) {
	defer prof("rpcGetGroundChunk")()
	uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	sid, _ := ctx.Value(runtime.RUNTIME_CTX_SESSION_ID).(string)
	var req struct {
		CX int `json:"cx"`
		CZ int `json:"cz"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", err
	}
	logf("rcv getGroundChunk uid=%s%s sid=%s cx=%d cz=%d\n", uid, dn(uid), shortSID(sid), req.CX, req.CZ)
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
	defer prof("rpcGetGroundTable")()
	// deprecated: use syncChunks
	return `{"error":"deprecated: use syncChunks with AOI range"}`, nil
}

// rpcSyncChunks はクライアントのハッシュと比較し、差分チャンクだけ返す
// payload: {"minCX":0,"minCZ":0,"maxCX":15,"maxCZ":15,"hashes":{"0_0":"12345",...}}
// AOI範囲内のチャンクのみ比較し、差分を返す
func rpcSyncChunks(ctx context.Context, _ runtime.Logger, _ *sql.DB, _ runtime.NakamaModule, payload string) (string, error) {
	defer prof("rpcSyncChunks")()
	uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	sid, _ := ctx.Value(runtime.RUNTIME_CTX_SESSION_ID).(string)
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
	logf("rcv syncChunks uid=%s%s sid=%s sent=%d/%d (range %d,%d-%d,%d)\n", uid, dn(uid), shortSID(sid), len(diff), total, req.MinCX, req.MinCZ, req.MaxCX, req.MaxCZ)
	b, err := json.Marshal(map[string]interface{}{"chunks": diff})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func rpcUpdateDisplayName(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	uid, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || uid == "" {
		return "", runtime.NewError("not authenticated", 16)
	}
	var req struct {
		DisplayName string `json:"displayName"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", runtime.NewError("invalid payload", 3)
	}
	dn := strings.TrimSpace(req.DisplayName)
	for _, r := range dn {
		if unicode.IsControl(r) {
			return "", runtime.NewError("display name must not contain control characters", 3)
		}
	}
	if dn == "" {
		// AccountUpdateId は空文字を「変更なし」と見なすため、直接DBでクリア
		if _, err := db.ExecContext(ctx, "UPDATE users SET display_name = '' WHERE id = $1", uid); err != nil {
			return "", runtime.NewError("failed to clear display name: "+err.Error(), 13)
		}
	} else {
		if err := nk.AccountUpdateId(ctx, uid, "", nil, dn, "", "", "", ""); err != nil {
			return "", err
		}
	}
	return `{"ok":true}`, nil
}

func rpcGetDisplayNames(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	var req struct {
		UserIds []string `json:"userIds"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", runtime.NewError("invalid payload", 3)
	}
	if len(req.UserIds) == 0 {
		return `{"users":[]}`, nil
	}
	users, err := nk.UsersGetId(ctx, req.UserIds, nil)
	if err != nil {
		return "", err
	}
	type userResult struct {
		ID          string `json:"id"`
		DisplayName string `json:"displayName"`
	}
	results := make([]userResult, 0, len(users))
	for _, u := range users {
		results = append(results, userResult{ID: u.Id, DisplayName: u.DisplayName})
	}
	b, err := json.Marshal(map[string]interface{}{"users": results})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// rpcDeleteUsers はテスト用: 指定ユーザーIDを一括削除する（ENABLE_TEST_RPC=true 時のみ登録）
func rpcDeleteUsers(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	var req struct {
		UserIds []string `json:"userIds"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", runtime.NewError("invalid payload", 3)
	}
	deleted := 0
	for _, uid := range req.UserIds {
		if err := nk.AccountDeleteId(ctx, uid, false); err != nil {
			logger.Warn("deleteUser %s: %v", uid, err)
			continue
		}
		deleted++
	}
	b, _ := json.Marshal(map[string]int{"deleted": deleted})
	return string(b), nil
}

// InitModule は Nakama プラグインのエントリポイント
func InitModule(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, initializer runtime.Initializer) error {
	// pprof サーバ (ポート6060)
	go func() {
		logger.Info("pprof server starting on :6060")
		if err := http.ListenAndServe(":6060", nil); err != nil {
			logger.Error("pprof server error: %v", err)
		}
	}()

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
						markChunkDirty(cx, cz)
					}
				}
				flushDirtyChunks(ctx, nk, logger)
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
							markChunkDirty(cx, cz)
						}
					}
					flushDirtyChunks(ctx, nk, logger)
				}
			}
		}
	}

	if loadedChunks > 0 {
		logger.Info("ground_table loaded: %d chunks", loadedChunks)
	}

	// 同接履歴をDBから復元（過去10日分）
	loadCcuHistory1m(ctx, nk, logger)

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
	if err := initializer.RegisterRpc("getGroundTable", rpcGetGroundTable); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("getGroundChunk", rpcGetGroundChunk); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("syncChunks", rpcSyncChunks); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("getPlayerCount", rpcGetPlayerCount); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("profileStart", rpcProfileStart); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("profileStop", rpcProfileStop); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("profileDump", rpcProfileDump); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("updateDisplayName", rpcUpdateDisplayName); err != nil {
		return err
	}
	if err := initializer.RegisterRpc("getDisplayNames", rpcGetDisplayNames); err != nil {
		return err
	}

	// テスト用 RPC（ENABLE_TEST_RPC=true 時のみ）
	env, _ := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string)
	if env["ENABLE_TEST_RPC"] == "true" {
		logger.Info("Test RPCs enabled (ENABLE_TEST_RPC=true)")
		if err := initializer.RegisterRpc("deleteUsers", rpcDeleteUsers); err != nil {
			return err
		}
	}

	// 表示名バリデーション（updateAccount のフック）
	if err := initializer.RegisterBeforeUpdateAccount(func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, in *api.UpdateAccountRequest) (*api.UpdateAccountRequest, error) {
		if in.DisplayName != nil {
			dn := in.DisplayName.Value
			if strings.TrimSpace(dn) == "" {
				return nil, runtime.NewError("display name must not be empty", 3) // INVALID_ARGUMENT
			}
			for _, r := range dn {
				if unicode.IsControl(r) {
					return nil, runtime.NewError("display name must not contain control characters", 3)
				}
			}
		}
		return in, nil
	}); err != nil {
		return err
	}

	// ログイン検知（カスタム認証 — 後方互換）
	if err := initializer.RegisterAfterAuthenticateCustom(func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, out *api.Session, in *api.AuthenticateCustomRequest) error {
		uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
		cacheDN(ctx, nk, uid)
		logf("rcv login/custom uid=%s%s\n", uid, dn(uid))
		return nil
	}); err != nil {
		return err
	}

	// ログイン検知（デバイス認証）
	if err := initializer.RegisterAfterAuthenticateDevice(func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, out *api.Session, in *api.AuthenticateDeviceRequest) error {
		uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
		cacheDN(ctx, nk, uid)
		logf("rcv login/device uid=%s%s\n", uid, dn(uid))
		return nil
	}); err != nil {
		return err
	}

	// ログアウト（セッション切断）検知
	if err := initializer.RegisterEventSessionEnd(func(ctx context.Context, logger runtime.Logger, evt *api.Event) {
		uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
		displayName := dn(uid)
		displayNameCache.Delete(uid)
		logf("rcv logout uid=%s%s\n", uid, displayName)
	}); err != nil {
		return err
	}

	logger.Info("server_info module loaded (world=%dx%d, chunk=%dx%d, %dx%d chunks)", worldSize, worldSize, chunkSize, chunkSize, chunkCount, chunkCount)
	return nil
}
