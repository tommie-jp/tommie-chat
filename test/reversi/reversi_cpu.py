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

from reversi_rules import (  # noqa: E402
    BLACK, WHITE, EMPTY, DIRS,
    init_board, opponent, find_flips, legal_moves, apply_move,
    parse_coord, fmt_coord, board_from_bo, board_to_bo,
)


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
        # HHD 仮想ブリッジ等でバッファ遅延が起きないよう明示フラッシュ
        try:
            self.ser.flush()
        except Exception:
            pass

    def handle(self, line):
        # §4: CR 混入は仕様違反 → ER03
        if "\r" in line:
            print(f"[WARN] CR detected in input (§4 violation): {line!r}", flush=True)
            self.send("ER03 CR in input")
            return
        s = line.strip()
        head = s[:2]  # §4: コマンドは大文字必須。upper() はしない
        if head not in ("PI", "PO"):
            self.last_game_activity = time.time()
        if self.log_ping or head != "PI":
            log_rx(line + "\n")
        if len(s) < 2:
            return
        cmd = s[:2]
        rest = s[2:]

        # §4: コマンド部は大文字のみ受理。小文字・混在は仕様違反 → ER02
        if not cmd.isupper() or not cmd.isalpha():
            print(f"[WARN] lowercase or non-alpha command (§4 violation): {cmd!r}", flush=True)
            self.send(f"ER02 lowercase cmd {cmd!r}")
            return

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
            coord = rest[:2]
            # §7: 座標は小文字のみ受理 (MOD3 等は ER04)
            if not (coord[0].islower() and coord[1].isdigit()):
                print(f"[WARN] non-lowercase coord (§7 violation): {coord!r}", flush=True)
                self.send(f"ER04 bad coord format {coord!r}")
                return
            try:
                r, c = parse_coord(coord)
            except ValueError as e:
                print(f"[WARN] bad coord: {e}", flush=True)
                self.send(f"ER04 coord out of range {coord!r}")
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
            # §4.1 未知コマンド → ER01
            print(f"[WARN] unknown cmd: {s!r} — responding ER01", flush=True)
            self.send(f"ER01 unknown cmd {cmd!r}")

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

    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.1)
    except serial.SerialException as e:
        msg = str(e).lower()
        port_repr = repr(args.port)
        if "access is denied" in msg or "permissionerror" in msg or "アクセス" in str(e):
            print(
                f"\n[COM ポート使用中] {port_repr} を他のプロセスが掴んでいます。\n"
                f"\n考えられる原因:\n"
                f"  1. tommieChat のシリアルテストパネル (ブラウザ) が接続中\n"
                f"     → 「接続を切る」ボタンを押すかタブを閉じる\n"
                f"  2. 前回の reversi_cpu.py や cpu_tester がまだ残留\n"
                f"     → PowerShell で Get-Process py,python,pythonw | Stop-Process -Force\n"
                f"  3. 他のターミナル端末ソフト (PuTTY / TeraTerm) が COM を開いている\n"
                f"     → 該当ソフトの接続を切る\n"
                f"\n元のエラー: {e}\n",
                file=sys.stderr,
            )
            sys.exit(4)
        if "could not open port" in msg or "filenotfounderror" in msg or "no such file" in msg:
            print(
                f"\n[COM ポート未存在] {port_repr} が見つかりません。\n"
                f"\n考えられる原因:\n"
                f"  1. COM ポート番号のタイプミス (--port の値を確認)\n"
                f"  2. HHD / com0com の仮想ブリッジが未作成 / 再起動で消失\n"
                f"     → 仮想シリアルツールの GUI でブリッジを作成\n"
                f"  3. 実機 CPU の USB ケーブルが外れている\n"
                f"\n元のエラー: {e}\n",
                file=sys.stderr,
            )
            sys.exit(4)
        raise
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
                    # §4: 改行は LF のみ。CR は行内に残したまま handle() に渡し、
                    # handle 内で §4.1 仕様違反として ER 応答させる。
                    idx_lf = buf.find(b"\n")
                    if idx_lf < 0:
                        break
                    line_bytes = buf[:idx_lf]  # CR を含む場合は含めたまま
                    buf = buf[idx_lf + 1:]
                    if line_bytes:
                        cpu.handle(line_bytes.decode("ascii", errors="replace"))
            else:
                if buf and (time.time() - last_rx) > 0.1:
                    print(f"[WARN] inter-char timeout, discard: {buf!r}", flush=True)
                    buf = b""

            # STUCK 検知: MY_TURN (CPU が応答すべき局面) のみ。
            # WAIT_OPP は人間相手の長考で正当に長くなりうるので対象外。
            now = time.time()
            idle = now - cpu.last_game_activity
            if cpu.state == "MY_TURN" and idle > STUCK_THRESHOLD:
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
