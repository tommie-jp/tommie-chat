"""
リバーシの純粋ルール実装 (I/O 非依存)。

外部 CPU テストスクリプト (test/reversi/cpu_tester/) と参照 CPU 実装
(test/reversi/reversi_cpu.py) の両方から共有される。

仕様: doc/reversi/61-UARTプロトコル仕様.md §7 座標・盤面の向き
"""

BLACK = 1
WHITE = 2
EMPTY = 0
DIRS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def init_board():
    """初期局面: d4=W, e4=B, d5=B, e5=W"""
    b = [[EMPTY] * 8 for _ in range(8)]
    b[3][3] = WHITE
    b[3][4] = BLACK
    b[4][3] = BLACK
    b[4][4] = WHITE
    return b


def opponent(c):
    return WHITE if c == BLACK else BLACK


def find_flips(board, row, col, color):
    """(row,col) に color を置いたとき裏返せる座標リストを返す。不正なら []"""
    if board[row][col] != EMPTY:
        return []
    opp = opponent(color)
    flips = []
    for dr, dc in DIRS:
        r, c = row + dr, col + dc
        line = []
        while 0 <= r < 8 and 0 <= c < 8 and board[r][c] == opp:
            line.append((r, c))
            r += dr
            c += dc
        if line and 0 <= r < 8 and 0 <= c < 8 and board[r][c] == color:
            flips.extend(line)
    return flips


def legal_moves(board, color):
    """color の合法手座標リスト (row,col)"""
    out = []
    for r in range(8):
        for c in range(8):
            if find_flips(board, r, c, color):
                out.append((r, c))
    return out


def apply_move(board, row, col, color):
    """(row,col) に color を置いて裏返す。不正なら False (board は変更しない)"""
    flips = find_flips(board, row, col, color)
    if not flips:
        return False
    board[row][col] = color
    for r, c in flips:
        board[r][c] = color
    return True


def parse_coord(s):
    """'d3' → (row, col) = (2, 3) に変換。大文字小文字不問。範囲外は ValueError"""
    s = s.lower()
    col = ord(s[0]) - ord("a")
    row = ord(s[1]) - ord("1")
    if not (0 <= col < 8 and 0 <= row < 8):
        raise ValueError(f"out of range: {s!r}")
    return row, col


def fmt_coord(row, col):
    """(row, col) → 'd3' 形式の小文字表記"""
    return f"{chr(ord('a') + col)}{row + 1}"


def board_from_bo(s):
    """BO 形式の 64 文字列 (§7) → 8x8 int 配列。不正なら None"""
    if len(s) != 64 or any(ch not in "012" for ch in s):
        return None
    b = [[EMPTY] * 8 for _ in range(8)]
    for i, ch in enumerate(s):
        b[i // 8][i % 8] = int(ch)
    return b


def board_to_bo(board):
    """8x8 int 配列 → BO 形式の 64 文字列 (§7 行優先 a1..h1, a2..h2, ...)"""
    return "".join(str(board[r][c]) for r in range(8) for c in range(8))
