package main

import "testing"

// 初期局面ヘルパの検証
func TestOthelloInitBoard(t *testing.T) {
	b := othelloInitBoard()
	// §7 初期配置
	if b[3*8+3] != 2 || b[3*8+4] != 1 || b[4*8+3] != 1 || b[4*8+4] != 2 {
		t.Errorf("initial 4 cells wrong: d4=%d e4=%d d5=%d e5=%d (want 2 1 1 2)",
			b[3*8+3], b[3*8+4], b[4*8+3], b[4*8+4])
	}
	// 他は全て 0
	for i := 0; i < 64; i++ {
		if i == 3*8+3 || i == 3*8+4 || i == 4*8+3 || i == 4*8+4 {
			continue
		}
		if b[i] != 0 {
			t.Errorf("cell[%d] = %d, want 0", i, b[i])
		}
	}
}

// BoardToBO / BoardFromBO の往復検証（初期盤面）
func TestOthelloBoardBO_InitialRoundtrip(t *testing.T) {
	b := othelloInitBoard()
	s := othelloBoardToBO(&b)
	// 期待: 0000000000000000000000000002100000012000000000000000000000000000
	want := "0000000000000000000000000002100000012000000000000000000000000000"
	if s != want {
		t.Errorf("BoardToBO initial = %q, want %q", s, want)
	}
	b2, ok := othelloBoardFromBO(s)
	if !ok {
		t.Fatal("BoardFromBO(initial) returned ok=false")
	}
	if b != b2 {
		t.Errorf("roundtrip mismatch: original != parsed")
	}
}

// BO パース: 長さ違いは ok=false
func TestOthelloBoardFromBO_WrongLength(t *testing.T) {
	cases := []string{
		"",
		"0",
		"00000000000000000000000000000000000000000000000000000000000000000", // 65
		"012",
	}
	for _, s := range cases {
		if _, ok := othelloBoardFromBO(s); ok {
			t.Errorf("BoardFromBO(len=%d) ok=true, want false", len(s))
		}
	}
}

// BO パース: '0'/'1'/'2' 以外の文字は ok=false
func TestOthelloBoardFromBO_InvalidChar(t *testing.T) {
	base := "0000000000000000000000000002100000012000000000000000000000000000"
	// 適当な位置に不正文字を入れる
	invalids := []byte{'3', '9', 'a', '!', ' '}
	for _, bad := range invalids {
		s := base[:5] + string(bad) + base[6:]
		if _, ok := othelloBoardFromBO(s); ok {
			t.Errorf("BoardFromBO(bad=%q) ok=true, want false", bad)
		}
	}
}

// BO パース: 任意の盤面が復元できる
func TestOthelloBoardFromBO_CustomPosition(t *testing.T) {
	// 角と辺に石を散らした人工盤面
	var orig [64]int8
	orig[0] = 1       // a1 黒
	orig[7] = 2       // h1 白
	orig[56] = 2      // a8 白
	orig[63] = 1      // h8 黒
	orig[3*8+3] = 1   // d4
	orig[4*8+4] = 2   // e5
	s := othelloBoardToBO(&orig)
	parsed, ok := othelloBoardFromBO(s)
	if !ok {
		t.Fatal("BoardFromBO(custom) ok=false")
	}
	if parsed != orig {
		t.Errorf("roundtrip mismatch:\n  orig   = %q\n  parsed = %q", s, othelloBoardToBO(&parsed))
	}
}

// 既存 othelloGetLegalMoves との整合: 初期局面の黒合法手が反復順どおりに並ぶか。
// Python reversi_cpu.py は legal_moves の先頭を選ぶ: (r=0..7, c=0..7) の行優先順で
// 最初に見つかる合法手。初期盤面 (黒先) では d3(idx=19) が最初。
func TestLegalMovesOrder_InitialBlack_FirstIsD3(t *testing.T) {
	b := othelloInitBoard()
	moves := othelloGetLegalMoves(&b, 1)
	// map は順序不定なので idx を全列挙して最小を取り、d3 (19) であることを確認。
	// Python の legal_moves は行優先で走査するので先頭は最小 idx と一致する。
	minIdx := 128
	for idx := range moves {
		if idx < minIdx {
			minIdx = idx
		}
	}
	if minIdx != 19 {
		t.Errorf("min legal move idx = %d, want 19 (d3)", minIdx)
	}
}
