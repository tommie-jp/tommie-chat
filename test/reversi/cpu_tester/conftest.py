"""
pytest 共通設定。

`--port COM3` / `--baud 115200` を CLI で受け取り、`cpu` フィクスチャとして
serial.Serial インスタンスを提供する。各テストは cpu.send_line() / cpu.read_line()
で UART とやり取りする薄いラッパ経由で書ける。
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

import pytest
import serial

# 親ディレクトリ (test/reversi) を import path に追加し、reversi_rules を使えるようにする
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def pytest_collection_modifyitems(config, items):
    """pytest.ini が UNC パスで読まれない環境でも確実にタイムアウト/リトライを効かせるため、
    個別のテストに以下マーカーを強制付与する:
      - @pytest.mark.timeout(15) — 無限ハング防止 (Windows の thread method でも動く)
      - @pytest.mark.flaky(reruns=3, reruns_delay=2) — HHD free 版仮想ブリッジ等の
        一時的な通信不調に対して自動リトライ (最大 4 回まで試行、2秒間隔)
    """
    import pytest as _pytest
    for item in items:
        if not any(m.name == "timeout" for m in item.iter_markers()):
            item.add_marker(_pytest.mark.timeout(15))
        if not any(m.name == "flaky" for m in item.iter_markers()):
            item.add_marker(_pytest.mark.flaky(reruns=3, reruns_delay=2))


def pytest_addoption(parser):
    parser.addoption("--port", default=None,
                     help="CPU の接続ポート (例: COM3 / /dev/ttyUSB0)")
    parser.addoption("--baud", type=int, default=115200,
                     help="ボーレート (default: 115200)")
    parser.addoption("--read-timeout", type=float, default=0.5,
                     help="1 行読み出しのタイムアウト秒 (default: 0.5)")
    parser.addoption("--no-serial", action="store_true",
                     help="シリアル接続をスキップ (テスト開発用)")
    parser.addoption("--reference-cpu", action="store_true",
                     help="参照 CPU (reversi_cpu.py) をサブプロセスで起動し "
                          "pty 経由でテストする。実機不要。Linux/macOS のみ。")

    parser.addoption("--required-only", action="store_true",
                     help="§6.1/§6.2 で必須マーク (✔) が付いているコマンドのテストのみ実行。"
                          "任意コマンド (BO / EN / RS / ST / NC 等) のテストは skip する。"
                          "デフォルトは全テスト実行。")

    parser.addoption("--protocol-only", action="store_true",
                     help="L1 プロトコル適合テスト (test_1_protocol.py) のみ実行し、"
                          "L2 ゲームルール適合テスト (test_2_game_rule.py) は skip する。"
                          "CPU の UART プロトコル層だけ検証したい場合に。"
                          "デフォルトは全テスト実行。")


class CpuConn:
    """UART 越しの CPU との会話を扱う薄いラッパ。タイムスタンプ付きでログも蓄積する。"""

    def __init__(self, ser: serial.Serial):
        self.ser = ser
        self.log: list[tuple[float, str, str]] = []  # (ts, direction, payload)
        self._read_buf = b""  # read_line 内で行末 \n が来るまでの部分受信を蓄積

    def send_line(self, text: str, eol: str = "\n") -> None:
        self.send_raw(text + eol, log_label=text)

    def send_raw(self, payload: str, log_label: str | None = None) -> None:
        """LF 自動付与なしで任意バイト列を送信 (CR 混入等の仕様違反テスト用)"""
        import time as _time
        data = payload.encode("ascii")
        self.ser.write(data)
        # OS 出力バッファを明示的にフラッシュし、HHD 等の仮想ブリッジでの送信詰まりを避ける
        try:
            self.ser.flush()
        except Exception:
            pass
        label = log_label if log_label is not None else repr(payload)
        self.log.append((time.time(), "TX", label))
        # HHD 仮想ブリッジは連続 send を 1 回の burst に束ねて遅延配送することがある。
        # 送信後に 20ms 休止することで受信側 (CPU) が即座に読み込める機会を与える。
        _time.sleep(0.02)

    def read_line(self, timeout: float | None = None, skip_status: bool = True) -> str:
        """指定秒内に 1 行受信する。timeout 超過で TimeoutError。
        Windows の serial.readline は GetOverlappedResult でブロックし得るので、
        in_waiting でポーリングしつつ自前バッファで行を組み立てる (非ブロッキング)。
        skip_status=True のとき §6.2 #8 ST と #9 NC は診断情報として読み飛ばす。
        """
        import time as _time
        eff_timeout = timeout if timeout is not None else self.ser.timeout
        deadline = _time.time() + eff_timeout
        buf = getattr(self, "_read_buf", b"")
        while True:
            # 既にバッファに完全な 1 行があれば取り出す
            idx = buf.find(b"\n")
            if idx >= 0:
                line_bytes, buf = buf[: idx + 1], buf[idx + 1:]
                self._read_buf = buf
                line = line_bytes.decode("ascii", errors="replace").rstrip("\r\n")
                self.log.append((time.time(), "RX", line))
                if skip_status and len(line) >= 2 and line[:2].upper() in ("ST", "NC"):
                    continue  # 診断応答はスキップしてループを続ける
                return line
            # 不足分を読み込む (非ブロッキング)
            try:
                n = self.ser.in_waiting
            except Exception:
                n = 0
            if n > 0:
                buf += self.ser.read(n)
                continue
            if _time.time() >= deadline:
                self._read_buf = buf
                self.log.append((time.time(), "TIMEOUT", repr(buf)))
                raise TimeoutError(f"no LF received within {eff_timeout}s: {buf!r}")
            _time.sleep(0.005)

    def drain(self, settle_ms: int = 200, max_total_ms: int = 2000) -> None:
        """受信バッファを空にする。テスト間の cross-talk 防止。
        Windows の serial.read は GetOverlappedResult でブロックし得るので、
        in_waiting でポーリングして確実に非ブロッキングに実装する。
        settle_ms: 最後の byte から無音状態をこの秒数確認するまで読み続ける
                    (CPU が複数行を遅れて送ってくるケースに対応するため長めに)
        max_total_ms: この秒を超えたら強制終了 (無限ハング防止)
        また自前行バッファ (_read_buf) もクリアする。
        """
        import time as _time
        deadline = _time.time() + max_total_ms / 1000
        last_data_t = _time.time()
        while _time.time() < deadline:
            try:
                n = self.ser.in_waiting
            except Exception:
                n = 0
            if n > 0:
                self.ser.read(n)  # サイズ指定の read は n バイト揃うまで待たない
                last_data_t = _time.time()
            else:
                if _time.time() - last_data_t >= settle_ms / 1000:
                    break
                _time.sleep(0.01)
        self._read_buf = b""  # read_line の自前バッファも破棄
        self.log.append((time.time(), "DRAIN", ""))

    def dump_log(self) -> str:
        return "\n".join(f"[{t:.3f}] {d} {p}" for t, d, p in self.log)


@pytest.fixture(scope="session")
def cpu(request) -> CpuConn:
    """セッション越しで使い回す CPU 接続。実機 (--port) か参照 CPU (--reference-cpu) を選ぶ。"""
    if request.config.getoption("--no-serial"):
        pytest.skip("--no-serial: シリアル接続なしのテスト開発モード")
    timeout = request.config.getoption("--read-timeout")

    if request.config.getoption("--reference-cpu"):
        # 参照 CPU (reversi_cpu.py) を pty で起動し、その pty デバイスに serial.Serial 接続
        yield from _spawn_reference_cpu(timeout)
        return

    port = request.config.getoption("--port")
    if not port:
        pytest.skip("--port または --reference-cpu のどちらかを指定してください")
    baud = request.config.getoption("--baud")
    try:
        ser = serial.Serial(port, baud, timeout=timeout)
    except serial.SerialException as e:
        msg = str(e).lower()
        if "access is denied" in msg or "permissionerror" in msg or "アクセス" in str(e):
            pytest.exit(
                f"\n[COM ポート使用中] {port!r} を他のプロセスが掴んでいます。\n"
                f"\n考えられる原因:\n"
                f"  1. tommieChat のシリアルテストパネル (ブラウザ) が接続中\n"
                f"     → 「接続を切る」ボタンを押すかタブを閉じる\n"
                f"  2. 前回の reversi_cpu.py などの Python プロセスが残留\n"
                f"     → PowerShell で Get-Process py,python,pythonw | Stop-Process -Force\n"
                f"  3. 他のターミナル端末ソフト (PuTTY / TeraTerm) が COM を開いている\n"
                f"     → 該当ソフトの接続を切る\n"
                f"\n元のエラー: {e}\n",
                returncode=4,
            )
        if "could not open port" in msg or "filenotfounderror" in msg:
            pytest.exit(
                f"\n[COM ポート未存在] {port!r} が見つかりません。\n"
                f"\n考えられる原因:\n"
                f"  1. COM ポート番号のタイプミス (--port の値を確認)\n"
                f"  2. HHD / com0com の仮想ブリッジが未作成 / 再起動で消失\n"
                f"     → 仮想シリアルツールの GUI でブリッジを作成\n"
                f"  3. 実機 CPU の USB ケーブルが外れている\n"
                f"\n元のエラー: {e}\n",
                returncode=4,
            )
        raise
    time.sleep(0.1)
    ser.reset_input_buffer()
    conn = CpuConn(ser)

    # 疎通確認: PI → PO が 1 秒以内に返るか。未応答なら初心者向けメッセージで早期失敗。
    _sanity_check(conn, port)

    yield conn
    ser.close()


def _sanity_check(conn: "CpuConn", port: str) -> None:
    """PI を投げて PO が返るかだけ確認。タイムアウトなら対処法付きで fail。"""
    conn.send_line("PI")
    conn.ser.timeout = 1.0
    raw = conn.ser.readline()
    if raw.strip() == b"PO" or raw.strip() == b"po":
        return  # OK
    # 応答なし or 別応答 → CPU が接続されてない可能性が高い
    pytest.exit(
        f"\n[CPU 疎通失敗] {port!r} は開けましたが、PI に対する PO が返りません。\n"
        f"\n考えられる原因:\n"
        f"  1. もう一方のポートで CPU (reversi_cpu.py や自作 FPGA) が起動していない\n"
        f"     → 仮想ブリッジ経由の自己テストなら、別ターミナルで以下を先に起動:\n"
        f"          cd test/reversi\n"
        f"          py reversi_cpu.py --port COM2 --baud 115200\n"
        f"     → 実機 CPU なら電源・ケーブル・ボーレート設定を確認\n"
        f"  2. HHD / com0com の仮想ブリッジが停止している\n"
        f"     → 仮想シリアルツールの GUI でブリッジ状態を確認\n"
        f"  3. CPU が PI を解釈できない (プロトコル未実装・バグ)\n"
        f"     → §6.2 #3 PONG 応答の実装を確認\n"
        f"  4. ボーレート不一致 (両端とも --baud 115200 で揃っているか)\n"
        f"\n受信した生データ: {raw!r} (期待: b'PO\\n')\n",
        returncode=4,
    )


def _spawn_reference_cpu(timeout: float):
    """reversi_cpu.py を pty で起動して serial.Serial から叩けるようにする。"""
    import os
    import pty
    import subprocess
    master_fd, slave_fd = pty.openpty()
    slave_name = os.ttyname(slave_fd)
    ref_path = Path(__file__).resolve().parent.parent / "reversi_cpu.py"
    proc = subprocess.Popen(
        ["python3", str(ref_path), "--port", slave_name, "--baud", "115200"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    os.close(slave_fd)
    # master_fd 越しに serial.Serial 的なインターフェースをエミュレート
    ser = serial.Serial(port=None, baudrate=115200, timeout=timeout)
    ser.fd = master_fd  # type: ignore[attr-defined]

    class _FdSerial:
        def __init__(self, fd, timeout):
            self.fd = fd
            self.timeout = timeout
            self._buf = b""

        def write(self, data):
            os.write(self.fd, data)

        def readline(self):
            import select
            while b"\n" not in self._buf:
                r, _, _ = select.select([self.fd], [], [], self.timeout)
                if not r:
                    return self._buf  # timeout: 蓄積した不完全分を返す
                chunk = os.read(self.fd, 1024)
                if not chunk:
                    break
                self._buf += chunk
            idx = self._buf.find(b"\n")
            if idx < 0:
                line, self._buf = self._buf, b""
            else:
                line, self._buf = self._buf[:idx + 1], self._buf[idx + 1:]
            return line

        def read(self, n):
            # _buf を優先して取り出す (in_waiting が先行で読み込んでいる可能性)
            if self._buf:
                data, self._buf = self._buf[:n], self._buf[n:]
                return data
            import select
            r, _, _ = select.select([self.fd], [], [], self.timeout)
            return os.read(self.fd, n) if r else b""

        def reset_input_buffer(self):
            import select
            while True:
                r, _, _ = select.select([self.fd], [], [], 0)
                if not r:
                    break
                os.read(self.fd, 4096)
            self._buf = b""

        @property
        def in_waiting(self):
            import select
            r, _, _ = select.select([self.fd], [], [], 0)
            if not r:
                return len(self._buf)
            # 利用可能なバイトを読み取ってバッファに移す
            try:
                chunk = os.read(self.fd, 4096)
                self._buf += chunk
            except OSError:
                pass
            return len(self._buf)

        def flush(self):
            pass

        def close(self):
            os.close(self.fd)

    conn = CpuConn(_FdSerial(master_fd, timeout))  # type: ignore[arg-type]
    time.sleep(0.2)  # reversi_cpu.py 起動待ち
    conn.ser.reset_input_buffer()
    # reversi_cpu.py が起動時に RE を送る可能性があるので drain
    try:
        conn.ser.timeout = 0.1
        conn.ser.readline()
    except Exception:
        pass
    yield conn
    try:
        conn.ser.close()
    except Exception:
        pass
    proc.terminate()
    proc.wait(timeout=2)


@pytest.fixture(autouse=True)
def _drain_between_tests(cpu):
    """各テスト開始時に前テストの残渣を完全に掃除する。
    手順:
      1. 残留データを drain (短時間)
      2. PI → PO 同期 (CPU が完全に前の入力を処理し終えたことを確認)
      3. 再度 drain (PI/PO と遅延到着分を捨てる)
    これで HHD 仮想ブリッジ等で遅延伝送が起きる環境でも test 間の cross-talk を防げる。
    """
    import time as _time
    try:
        cpu.drain(settle_ms=100, max_total_ms=500)
        # PI-PO 同期: 前テストの全処理が終わるまで待つ
        cpu.send_line("PI")
        try:
            while True:
                line = cpu.read_line(timeout=1.0)
                if line.upper() == "PO":
                    break  # 同期成功
        except TimeoutError:
            pass  # PO が返らなくても続行 (CPU 側の問題としてテスト側で検出されるはず)
        # 最終 drain: PI-PO 送受信中に遅延到着した前テスト残渣を掃除
        cpu.drain(settle_ms=100, max_total_ms=500)
    except AttributeError:
        pass  # --no-serial 時
    yield


def check_regex(pattern: str, text: str) -> bool:
    return bool(re.match(pattern, text))
