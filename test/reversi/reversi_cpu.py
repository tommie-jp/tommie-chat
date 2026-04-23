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
import re
import signal
import sys
import time

import serial

# ブラウザ側シリアルパネルがタイムスタンプ付きで出した Replay 行 (例: "[01:23:45.678] TX SB") を許容するための前置タイムスタンプ
_TS_PREFIX_RE = re.compile(r"^\[[0-9:.\-]+\]\s+")

_interrupted = False


def _install_sigint_handler():
    def _handler(signum, frame):
        global _interrupted
        _interrupted = True
    signal.signal(signal.SIGINT, _handler)

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


def board_to_bo(board):
    """BO エンコーディング形式の 64 文字列 (行優先 a1..h1, a2..h2, ...)"""
    return "".join(str(board[r][c]) for r in range(8) for c in range(8))


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
        # STUCK 検知用: PI/PO 以外の「ゲーム活動」があった最終時刻
        self.last_game_activity = time.time()

    def send(self, line):
        data = (line + "\n").encode("ascii")
        head = line[:2].upper()
        if head not in ("PI", "PO"):
            self.last_game_activity = time.time()
        if self.log_ping or head != "PO":
            log_tx(line + "\n")
        self.ser.write(data)

    def handle(self, line):
        s = line.strip()
        head = s[:2].upper()
        if head not in ("PI", "PO"):
            self.last_game_activity = time.time()
        if self.log_ping or head != "PI":
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
                # 盤面乖離 → §6.2 #10 RS (REQUEST SYNC) で再同期要求。
                # ホスト側は §12.1 に従い BO で盤面を送り、直前の MO を再送する
                coord = rest[:2]
                print(f"[WARN] illegal opponent move: {coord} — request resync via RS", flush=True)
                print(f"[BOARD pre-OPP illegal] {board_to_bo(self.board)}", flush=True)
                self.send("RS")
                # state は WAIT_OPP のまま。Adapter から BO + MO が届けば回復
                return
            print(f"[INFO] opponent played {fmt_coord(r, c)}", flush=True)
            print(f"[BOARD post-OPP {fmt_coord(r, c)}] {board_to_bo(self.board)}", flush=True)
            print_board(self.board)
            # §6.2 #8 ST でサーバ側にも現在盤面を通知（盤面突合のため）
            self.send(f"ST BO{board_to_bo(self.board)}")
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
            print(f"[BOARD post-BO] {board_to_bo(self.board)}", flush=True)
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
        print(f"[BOARD post-MY {fmt_coord(r, c)}] {board_to_bo(self.board)}", flush=True)
        print_board(self.board)
        self.send(f"MO{fmt_coord(r, c)}")
        # §6.2 #8 ST でサーバ側にも現在盤面を通知（盤面突合のため）
        self.send(f"ST BO{board_to_bo(self.board)}")
        self.state = "WAIT_OPP"


class _CaptureSerial:
    """--replay モード用の fake serial。ReversiCPU.send() の書き込みを記録する。"""
    def __init__(self):
        self.sent_lines = []

    def write(self, data):
        if isinstance(data, (bytes, bytearray)):
            data = data.decode("ascii", errors="replace")
        for ln in data.split("\n"):
            ln = ln.rstrip("\r")
            if ln:
                self.sent_lines.append(ln)


def run_replay(path: str, log_ping: bool) -> int:
    """シナリオファイルを再生し、CPU の送信を期待値と照合。一致=0, 不一致=1, 構文エラー=2。"""
    scenario = []  # [(kind, text, lineno)]
    with open(path, encoding="utf-8") as f:
        for lineno, raw in enumerate(f, 1):
            s = raw.rstrip("\r\n")
            # 先頭の "[HH:MM:SS.mmm] " 形式のタイムスタンプを許容（ブラウザ側の Replay モード出力）
            s = _TS_PREFIX_RE.sub("", s, count=1)
            if not s or s.startswith("#"):
                continue
            if s.startswith("TX "):
                scenario.append(("TX", s[3:], lineno))
            elif s.startswith("RX "):
                scenario.append(("RX", s[3:], lineno))
            elif s in ("TX", "RX"):
                # prefix のみの行は空メッセージ扱い (使わないが構文エラー回避)
                scenario.append((s, "", lineno))
            else:
                print(f"[ERR] {path}:{lineno} unknown line: {s!r}", file=sys.stderr)
                return 2

    fake = _CaptureSerial()
    cpu = ReversiCPU(fake, log_ping=log_ping)

    expected = []
    actual_at_rx = []  # RX 時点での actual 末尾位置のスナップショット用
    cursor = 0

    for kind, text, lineno in scenario:
        if kind == "TX":
            cpu.handle(text)
        else:  # RX
            expected.append(text)

    # PI/PO は比較から除外 (シナリオ側で TX PI が無ければ RX PO も発生しない)
    # ST (盤面スナップショット) も診断用なので比較対象外
    actual = [ln for ln in fake.sent_lines
              if (log_ping or ln[:2].upper() not in ("PI", "PO"))
              and ln[:2].upper() != "ST"]

    if actual == expected:
        print(f"[OK] {path}: {len(expected)} RX matched", flush=True)
        return 0

    # 差分表示
    print(f"[FAIL] {path}: expected {len(expected)} RX lines, got {len(actual)}", file=sys.stderr)
    n = max(len(expected), len(actual))
    for i in range(n):
        e = expected[i] if i < len(expected) else "<missing>"
        a = actual[i] if i < len(actual) else "<missing>"
        mark = "  " if e == a else ">>"
        print(f"{mark} {i+1:4d}: expected={e!r}  actual={a!r}", file=sys.stderr)
    return 1


def main():
    ap = argparse.ArgumentParser(description="リバーシ CPU 疑似クライアント")
    ap.add_argument("--port", help="シリアルポート (例: COM3 / /dev/ttyUSB0)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("-l", "--log-ping", action="store_true", help="PI/PO ハートビートもログ出力する")
    ap.add_argument("--replay", help="シナリオファイル (TX/RX 形式) を再生し、CPU 応答を照合")
    args = ap.parse_args()

    if args.replay:
        sys.exit(run_replay(args.replay, log_ping=args.log_ping))

    if not args.port:
        ap.error("--port or --replay is required")

    _install_sigint_handler()

    ser = serial.Serial(args.port, args.baud, timeout=0.1)
    print(f"[INFO] opened {args.port} @ {args.baud}bps (Ctrl+C to quit)", flush=True)

    cpu = ReversiCPU(ser, log_ping=args.log_ping)
    cpu.send("RE")

    buf = b""
    last_rx = time.time()
    last_stuck_dump = 0.0
    STUCK_THRESHOLD = 10.0      # PI/PO 以外の活動が N 秒無ければ STUCK 判定
    STUCK_DUMP_INTERVAL = 10.0  # STUCK 中はこの間隔で再ダンプ
    try:
        while not _interrupted:
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

            # STUCK 検知: MY_TURN / WAIT_OPP で活動が止まったら状態ダンプ
            now = time.time()
            idle = now - cpu.last_game_activity
            if cpu.state != "IDLE" and idle > STUCK_THRESHOLD:
                if now - last_stuck_dump > STUCK_DUMP_INTERVAL:
                    print(
                        f"[STUCK] state={cpu.state} color={cpu.color} "
                        f"idle={idle:.1f}s buf={buf!r} "
                        f"last_rx={now - last_rx:.1f}s ago",
                        flush=True,
                    )
                    print_board(cpu.board)
                    last_stuck_dump = now
    except KeyboardInterrupt:
        pass
    finally:
        print("\n[INFO] interrupted", flush=True)
        ser.close()


if __name__ == "__main__":
    main()
