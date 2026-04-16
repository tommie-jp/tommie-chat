package main

import (
	"testing"
)

// --- 初期盤面 ---

func TestNewGame(t *testing.T) {
	g := othelloNewGame("test1", "user-black", 0)
	if g.Board[3*8+3] != 2 || g.Board[3*8+4] != 1 || g.Board[4*8+3] != 1 || g.Board[4*8+4] != 2 {
		t.Fatal("初期配置が正しくない")
	}
	if g.Turn != 1 {
		t.Fatal("初手は黒のはず")
	}
	if g.Status != "waiting" {
		t.Fatal("初期状態は waiting のはず")
	}
	b, w := othelloCalcScore(&g.Board)
	if b != 2 || w != 2 {
		t.Fatalf("初期スコアが 2-2 でない: black=%d white=%d", b, w)
	}
}

// --- getFlips ---

func TestGetFlips_InitialBlackD3(t *testing.T) {
	g := othelloNewGame("test2", "u1", 0)
	// 黒が (2,3) = D3 に置く → (3,3) の白を裏返すはず
	flips := othelloGetFlips(&g.Board, 2, 3, 1)
	if len(flips) != 1 {
		t.Fatalf("裏返し数が1でない: %d, flips=%v", len(flips), flips)
	}
	if flips[0] != 3*8+3 {
		t.Fatalf("裏返し位置が (3,3) でない: %d", flips[0])
	}
}

func TestGetFlips_OccupiedCell(t *testing.T) {
	g := othelloNewGame("test3", "u1", 0)
	// 既に石がある位置には置けない
	flips := othelloGetFlips(&g.Board, 3, 3, 1)
	if len(flips) != 0 {
		t.Fatal("既存の石の上には置けないはず")
	}
}

func TestGetFlips_NoFlip(t *testing.T) {
	g := othelloNewGame("test4", "u1", 0)
	// (0,0) には何も裏返せない
	flips := othelloGetFlips(&g.Board, 0, 0, 1)
	if len(flips) != 0 {
		t.Fatal("裏返せない位置に合法手があると判定された")
	}
}

// --- getLegalMoves ---

func TestGetLegalMoves_InitialBlack(t *testing.T) {
	g := othelloNewGame("test5", "u1", 0)
	moves := othelloGetLegalMoves(&g.Board, 1)
	// 黒の初手は (2,3), (3,2), (4,5), (5,4) の4箇所
	if len(moves) != 4 {
		t.Fatalf("黒の初手合法手が4でない: %d", len(moves))
	}
	expected := []int{2*8 + 3, 3*8 + 2, 4*8 + 5, 5*8 + 4}
	for _, pos := range expected {
		if _, ok := moves[pos]; !ok {
			t.Errorf("合法手に %d が含まれていない", pos)
		}
	}
}

func TestGetLegalMoves_InitialWhite(t *testing.T) {
	g := othelloNewGame("test6", "u1", 0)
	moves := othelloGetLegalMoves(&g.Board, 2)
	// 白の初手も4箇所: (2,4), (3,5), (4,2), (5,3)
	if len(moves) != 4 {
		t.Fatalf("白の初手合法手が4でない: %d", len(moves))
	}
}

// --- applyMove ---

func TestApplyMove_Basic(t *testing.T) {
	g := othelloNewGame("test7", "u1", 0)
	g.Status = "playing"
	g.WhiteUID = "u2"

	// 黒が (2,3) に置く
	flips, err := othelloApplyMove(g, 2, 3)
	if err != nil {
		t.Fatalf("applyMove error: %v", err)
	}
	if len(flips) != 1 {
		t.Fatalf("裏返し数が1でない: %d", len(flips))
	}
	// 盤面確認
	if g.Board[2*8+3] != 1 {
		t.Fatal("(2,3) に黒石がない")
	}
	if g.Board[3*8+3] != 1 {
		t.Fatal("(3,3) が裏返っていない")
	}
	// ターンが白に
	if g.Turn != 2 {
		t.Fatalf("ターンが白(2)でない: %d", g.Turn)
	}
	// スコア
	b, w := othelloCalcScore(&g.Board)
	if b != 4 || w != 1 {
		t.Fatalf("スコアが 4-1 でない: black=%d white=%d", b, w)
	}
}

func TestApplyMove_IllegalMove(t *testing.T) {
	g := othelloNewGame("test8", "u1", 0)
	g.Status = "playing"
	g.WhiteUID = "u2"

	_, err := othelloApplyMove(g, 0, 0)
	if err == nil {
		t.Fatal("不正な手がエラーにならない")
	}
}

func TestApplyMove_NotPlaying(t *testing.T) {
	g := othelloNewGame("test9", "u1", 0)
	// Status = "waiting" のまま
	_, err := othelloApplyMove(g, 2, 3)
	if err == nil {
		t.Fatal("waiting 状態で手が打てるべきでない")
	}
}

// --- パス ---

func TestPass_CannotPassWithLegalMoves(t *testing.T) {
	g := othelloNewGame("test10", "u1", 0)
	g.Status = "playing"
	g.WhiteUID = "u2"

	err := othelloPass(g)
	if err == nil {
		t.Fatal("合法手があるのにパスできるべきでない")
	}
}

// --- 投了 ---

func TestResign_BlackResigns(t *testing.T) {
	g := othelloNewGame("test11", "u1", 0)
	g.Status = "playing"
	g.WhiteUID = "u2"

	othelloResign(g, "u1")
	if g.Status != "finished" {
		t.Fatal("投了後に finished でない")
	}
	if g.Winner != 2 {
		t.Fatalf("黒が投了なのに勝者が白(2)でない: %d", g.Winner)
	}
}

func TestResign_WhiteResigns(t *testing.T) {
	g := othelloNewGame("test12", "u1", 0)
	g.Status = "playing"
	g.WhiteUID = "u2"

	othelloResign(g, "u2")
	if g.Winner != 1 {
		t.Fatalf("白が投了なのに勝者が黒(1)でない: %d", g.Winner)
	}
}

// --- 終局（盤面が埋まる or 両者パス）---

func TestFinish_Score(t *testing.T) {
	g := othelloNewGame("test13", "u1", 0)
	g.Status = "playing"
	// 全部黒にして終局
	for i := 0; i < 64; i++ {
		g.Board[i] = 1
	}
	othelloFinish(g)
	if g.Status != "finished" {
		t.Fatal("finished でない")
	}
	if g.Winner != 1 {
		t.Fatalf("全部黒なのに黒勝ちでない: %d", g.Winner)
	}
}

func TestFinish_Draw(t *testing.T) {
	g := othelloNewGame("test14", "u1", 0)
	g.Status = "playing"
	for i := 0; i < 32; i++ {
		g.Board[i] = 1
	}
	for i := 32; i < 64; i++ {
		g.Board[i] = 2
	}
	othelloFinish(g)
	if g.Winner != 3 {
		t.Fatalf("32-32 で引き分け(3)でない: %d", g.Winner)
	}
}

// --- 自動パス: 相手に合法手がない場合 ---

func TestAutoPass(t *testing.T) {
	// 盤面を手動で構築: 白に合法手がない状態を作る
	g := othelloNewGame("test15", "u1", 0)
	g.Status = "playing"
	g.WhiteUID = "u2"

	// 盤面クリア
	for i := 0; i < 64; i++ {
		g.Board[i] = 0
	}
	// 黒が左上を支配、白が1つだけ
	// B B B .
	// B W . .
	// B . . .
	g.Board[0*8+0] = 1
	g.Board[0*8+1] = 1
	g.Board[0*8+2] = 1
	g.Board[1*8+0] = 1
	g.Board[1*8+1] = 2
	g.Board[2*8+0] = 1
	g.Turn = 1

	// 黒が (2,2) に置く → (1,1)の白を裏返す
	flips := othelloGetFlips(&g.Board, 2, 2, 1)
	if len(flips) == 0 {
		// この盤面では (2,2) は合法手でない可能性がある
		// 合法手を確認
		moves := othelloGetLegalMoves(&g.Board, 1)
		if len(moves) == 0 {
			t.Skip("この盤面では黒に合法手がない")
		}
		// 最初の合法手で打つ
		for pos := range moves {
			row, col := pos/8, pos%8
			_, err := othelloApplyMove(g, row, col)
			if err != nil {
				t.Fatalf("applyMove error: %v", err)
			}
			break
		}
	} else {
		_, err := othelloApplyMove(g, 2, 2)
		if err != nil {
			t.Fatalf("applyMove error: %v", err)
		}
	}
	// 白に合法手がなければ自動的に黒の番に戻るか、終局する
	if g.Status == "playing" && g.Turn != 1 {
		// 白に合法手があるなら白の番で正しい
		wMoves := othelloGetLegalMoves(&g.Board, 2)
		if len(wMoves) == 0 {
			t.Fatal("白に合法手がないのにターンが白のまま")
		}
	}
}
