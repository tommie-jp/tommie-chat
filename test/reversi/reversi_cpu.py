#!/usr/bin/env python3
"""
リバーシ CPU 疑似クライアント (Windows CLI)

doc/reversi/61-UARTプロトコル仕様.md に沿って CPU 側として動作する。
- サーバから届いた PI/VE/SB/SW/MO/PA/BO/EB/EW/ED を処理
- 手番になったら合法手の先頭を選んで MOxx を返す
- 送受信したシリアルデータはすべて標準出力にダンプ

使い方:
  pip install pyserial
  python reversi_cpu.py --port COM3 --baud 115200
  python reversi_cpu.py --port /dev/ttyUSB0 --baud 115200
"""

import argparse
import sys
import time

import serial

BLACK = 1
WHITE = 2
EMPTY = 0
DIRS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def init_board():
    b = [[EMPTY] * 8 for _ in range(8)]
    b[3][3] = WHITE
    b[3][4] = BLACK
    b[4][3] = BLACK
    b[4][4] = WHITE
    return b


def opponent(c):
    return WHITE if c == BLACK else BLACK


def find_flips(board, row, col, color):
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
    out = []
    for r in range(8):
        for c in range(8):
            if find_flips(board, r, c, color):
                out.append((r, c))
    return out


def apply_move(board, row, col, color):
    flips = find_flips(board, row, col, color)
    if not flips:
        return False
    board[row][col] = color
    for r, c in flips:
        board[r][c] = color
    return True


def parse_coord(s):
    s = s.lower()
    col = ord(s[0]) - ord("a")
    row = ord(s[1]) - ord("1")
    if not (0 <= col < 8 and 0 <= row < 8):
        raise ValueError(f"out of range: {s!r}")
    return row, col


def fmt_coord(row, col):
    return f"{chr(ord('a') + col)}{row + 1}"


def board_from_bo(s):
    if len(s) != 64 or any(ch not in "012" for ch in s):
        return None
    b = [[EMPTY] * 8 for _ in range(8)]
    for i, ch in enumerate(s):
        b[i // 8][i % 8] = int(ch)
    return b


def print_board(board):
    print("    a b c d e f g h")
    for r in range(8):
        row = " ".join("." if v == 0 else ("B" if v == BLACK else "W") for v in board[r])
        print(f"  {r + 1} {row}")
    sys.stdout.flush()


def ts():
    t = time.time()
    return time.strftime("%H:%M:%S", time.localtime(t)) + f".{int((t % 1) * 1000):03d}"


def log_rx(raw):
    print(f"[{ts()}] RX <- {raw!r}", flush=True)


def log_tx(raw):
    print(f"[{ts()}] TX -> {raw!r}", flush=True)


class ReversiCPU:
    def __init__(self, ser, log_ping=False):
        self.ser = ser
        self.board = init_board()
        self.color = None          # BLACK / WHITE / None(IDLE)
        self.state = "IDLE"        # IDLE | MY_TURN | WAIT_OPP
        self.log_ping = log_ping

    def send(self, line):
        data = (line + "\n").encode("ascii")
        if self.log_ping or not line.upper().startswith("PO"):
            log_tx(line + "\n")
        self.ser.write(data)

    def handle(self, line):
        s = line.strip()
        if self.log_ping or not s[:2].upper() == "PI":
            log_rx(line + "\n")
        if len(s) < 2:
            return
        cmd = s[:2].upper()
        rest = s[2:]

        if cmd == "PI":
            self.send("PO")
        elif cmd == "VE":
            self.send("VE01tommie-py-cpu")
        elif cmd == "SB":
            self.board = init_board()
            self.color = BLACK
            self.state = "MY_TURN"
            print("[INFO] SB received — I play BLACK", flush=True)
            print_board(self.board)
            self.my_move()
        elif cmd == "SW":
            self.board = init_board()
            self.color = WHITE
            self.state = "WAIT_OPP"
            print("[INFO] SW received — I play WHITE", flush=True)
            print_board(self.board)
        elif cmd == "MO":
            if self.color is None or len(rest) < 2:
                return
            try:
                r, c = parse_coord(rest[:2])
            except ValueError as e:
                print(f"[WARN] bad coord: {e}", flush=True)
                return
            if not apply_move(self.board, r, c, opponent(self.color)):
                print(f"[WARN] illegal opponent move: {rest[:2]}", flush=True)
                return
            print(f"[INFO] opponent played {fmt_coord(r, c)}", flush=True)
            print_board(self.board)
            self.state = "MY_TURN"
            self.my_move()
        elif cmd == "PA":
            print("[INFO] opponent passed", flush=True)
            self.state = "MY_TURN"
            self.my_move()
        elif cmd == "BO":
            b = board_from_bo(rest)
            if b is None:
                print(f"[WARN] bad BO payload: {rest!r}", flush=True)
                return
            self.board = b
            print("[INFO] BO board sync", flush=True)
            print_board(self.board)
        elif cmd in ("EB", "EW", "ED"):
            result = {"EB": "BLACK wins", "EW": "WHITE wins", "ED": "DRAW"}[cmd]
            print(f"[INFO] game over: {result}", flush=True)
            self.state = "IDLE"
            self.color = None
        else:
            print(f"[WARN] unknown cmd: {s!r}", flush=True)

    def my_move(self):
        if self.state != "MY_TURN" or self.color is None:
            return
        moves = legal_moves(self.board, self.color)
        if not moves:
            print("[INFO] no legal move — pass", flush=True)
            self.send("PA")
            self.state = "WAIT_OPP"
            return
        r, c = moves[0]
        apply_move(self.board, r, c, self.color)
        print(f"[INFO] my move: {fmt_coord(r, c)}", flush=True)
        print_board(self.board)
        self.send(f"MO{fmt_coord(r, c)}")
        self.state = "WAIT_OPP"


def main():
    ap = argparse.ArgumentParser(description="リバーシ CPU 疑似クライアント")
    ap.add_argument("--port", required=True, help="シリアルポート (例: COM3 / /dev/ttyUSB0)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("-l", "--log-ping", action="store_true", help="PI/PO ハートビートもログ出力する")
    args = ap.parse_args()

    ser = serial.Serial(args.port, args.baud, timeout=0.1)
    print(f"[INFO] opened {args.port} @ {args.baud}bps", flush=True)

    cpu = ReversiCPU(ser, log_ping=args.log_ping)
    cpu.send("RE")

    buf = b""
    last_rx = time.time()
    try:
        while True:
            chunk = ser.read(128)
            if chunk:
                buf += chunk
                last_rx = time.time()
                while True:
                    idx_lf = buf.find(b"\n")
                    idx_cr = buf.find(b"\r")
                    if idx_lf < 0 and idx_cr < 0:
                        break
                    idxs = [i for i in (idx_lf, idx_cr) if i >= 0]
                    idx = min(idxs)
                    line_bytes = buf[:idx]
                    nxt = idx + 1
                    if buf[idx:idx + 1] == b"\r" and buf[nxt:nxt + 1] == b"\n":
                        nxt += 1
                    buf = buf[nxt:]
                    if line_bytes:
                        cpu.handle(line_bytes.decode("ascii", errors="replace"))
            else:
                if buf and (time.time() - last_rx) > 0.1:
                    print(f"[WARN] inter-char timeout, discard: {buf!r}", flush=True)
                    buf = b""
    except KeyboardInterrupt:
        print("\n[INFO] interrupted", flush=True)
    finally:
        ser.close()


if __name__ == "__main__":
    main()
