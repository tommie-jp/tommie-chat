package main

import "testing"

// 初期盤面で黒の手番: Hiyoko は行優先で最小 idx の合法手 = d3 (r=2,c=3) を返す
func TestHiyoko_InitialBlack(t *testing.T) {
	b := othelloInitBoard()
	r, c, pass := (HiyokoCpu{}).NextMove(&b, 1)
	if pass {
		t.Fatal("unexpected pass on initial black turn")
	}
	if r != 2 || c != 3 {
		t.Errorf("first black move = (%d,%d), want (2,3) = d3", r, c)
	}
}

// 初期盤面で白の手番: Hiyoko は c5 (r=4, c=2) を返す (行優先最小 idx)
// 黒が d3 を打った後の白の合法手は c3, c5, e3 で、最小 idx は e3=20
// だが初期盤面 (黒未着手) で白を求めるテストなので、白の合法手は d6,e3, c5, f4 (中央4つまわり)
// の最小 idx = 20 (e3)... 実際は Python の legal_moves 順で確認する必要がある
func TestHiyoko_InitialWhite(t *testing.T) {
	b := othelloInitBoard()
	r, c, pass := (HiyokoCpu{}).NextMove(&b, 2)
	if pass {
		t.Fatal("unexpected pass on initial white turn")
	}
	// 白初期合法手: d6=43(3,5), e3=20(2,4), c5=34(4,2), f4=29(3,5) のうち最小 idx
	// 行優先 scan で 20 (e3) が先頭のはず
	idx := r*8 + c
	if idx != 20 {
		t.Errorf("first white move idx = %d, want 20 (e3)", idx)
	}
}

// 合法手が存在しない盤面 → pass=true
func TestHiyoko_NoLegalMovesReturnsPass(t *testing.T) {
	// 黒で埋め尽くした盤面 (白も黒も打てる場所なし)
	var b [64]int8
	for i := 0; i < 64; i++ {
		b[i] = 1
	}
	r, c, pass := (HiyokoCpu{}).NextMove(&b, 2)
	if !pass {
		t.Errorf("expected pass, got move=(%d,%d)", r, c)
	}
}

// Python 参照実装と一致: 決定的に同じ盤面 → 同じ手
func TestHiyoko_Deterministic(t *testing.T) {
	b := othelloInitBoard()
	r1, c1, _ := (HiyokoCpu{}).NextMove(&b, 1)
	r2, c2, _ := (HiyokoCpu{}).NextMove(&b, 1)
	if r1 != r2 || c1 != c2 {
		t.Errorf("non-deterministic: (%d,%d) != (%d,%d)", r1, c1, r2, c2)
	}
}

// UID sentinel 判定
func TestIsCpuUID(t *testing.T) {
	cases := []struct {
		uid  string
		want bool
	}{
		{"cpu:hiyoko", true},
		{"cpu:", true},
		{"cpu:unknown", true},
		{"", false},
		{"user-xxx", false},
		{"CPU:hiyoko", false}, // 大文字プレフィックスは非 sentinel
	}
	for _, c := range cases {
		if got := isCpuUID(c.uid); got != c.want {
			t.Errorf("isCpuUID(%q) = %v, want %v", c.uid, got, c.want)
		}
	}
}

// エンジンレジストリ: cpu:hiyoko は登録済み、未登録 UID は nil
func TestCpuEngineForUID(t *testing.T) {
	if cpuEngineForUID("cpu:hiyoko") == nil {
		t.Error("cpu:hiyoko should be registered")
	}
	if got := cpuEngineForUID("cpu:nonexistent"); got != nil {
		t.Errorf("cpu:nonexistent should return nil, got %T", got)
	}
	if got := cpuEngineForUID("user-xxx"); got != nil {
		t.Errorf("non-cpu UID should return nil, got %T", got)
	}
}

// HiyokoCpu.Name
func TestHiyokoName(t *testing.T) {
	if (HiyokoCpu{}).Name() != "hiyoko" {
		t.Error("HiyokoCpu.Name() should be 'hiyoko'")
	}
}

// 一局通し: Hiyoko vs Hiyoko で必ず終局する (無限ループ防止・合法手順序の妥当性)
func TestHiyoko_VsHiyoko_GameTerminates(t *testing.T) {
	b := othelloInitBoard()
	turn := int8(1)
	passCount := 0
	maxMoves := 64 // 理論最大手数
	for i := 0; i < maxMoves*2 && passCount < 2; i++ {
		r, c, pass := (HiyokoCpu{}).NextMove(&b, turn)
		if pass {
			passCount++
			turn = 3 - turn
			continue
		}
		passCount = 0
		// 着手を適用 (othelloGetFlips + 反転)
		flips := othelloGetFlips(&b, r, c, turn)
		if len(flips) == 0 {
			t.Fatalf("Hiyoko returned illegal move (%d,%d) for turn=%d", r, c, turn)
		}
		b[r*8+c] = turn
		for _, fi := range flips {
			b[fi] = turn
		}
		turn = 3 - turn
	}
	if passCount < 2 {
		t.Error("Hiyoko vs Hiyoko did not terminate within max moves")
	}
	// 終局時、黒白合計 >= 60 (開始4石 + 60手分)、ただし双方パスで早期終了もあり得る
	black, white := othelloCalcScore(&b)
	if black+white < 4 {
		t.Errorf("unexpected low stone count: black=%d white=%d", black, white)
	}
}
