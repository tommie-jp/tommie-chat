package main

// リバーシのルール補助ヘルパ。
//
// コアのルール関数 (othelloGetFlips / othelloGetLegalMoves / othelloApplyMove /
// othelloCalcScore / othelloBoardToBO) は main.go 側に既存。ここでは内蔵 CPU
// (reversi_cpu.go) 実装で追加で要る初期盤面生成と BO パースだけを置く。
//
// 盤面表現は [64]int8 の行優先 (row*8+col)、0=空 / 1=黒 / 2=白。
// doc/reversi/61-UARTプロトコル仕様.md §7 に準拠。
//
// 参考実装 (Python): test/reversi/reversi_rules.py

// othelloInitBoard は §7 の初期局面を返す。
// d4=W(2), e4=B(1), d5=B(1), e5=W(2)、他は全て空 (0)。
func othelloInitBoard() [64]int8 {
	var b [64]int8
	b[3*8+3] = 2 // d4 W
	b[3*8+4] = 1 // e4 B
	b[4*8+3] = 1 // d5 B
	b[4*8+4] = 2 // e5 W
	return b
}

// othelloBoardFromBO は BO<64char> の 64 文字を [64]int8 に復元する。
// 不正 (長さ違い、'0'/'1'/'2' 以外の文字を含む) なら ok=false。
// doc/reversi/61-UARTプロトコル仕様.md §6.1 #5 / §7 参照。
func othelloBoardFromBO(s string) (board [64]int8, ok bool) {
	if len(s) != 64 {
		return board, false
	}
	for i := 0; i < 64; i++ {
		c := s[i]
		if c < '0' || c > '2' {
			return [64]int8{}, false
		}
		board[i] = int8(c - '0')
	}
	return board, true
}
