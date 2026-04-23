"""
ゲームルール適合テスト (§7 座標, §9 正常フロー)。

cases/game_rule/*.json で定義された局面で CPU の応答が
**リバーシとして合法か** を検証する。プロトコル層 (test_protocol.py)
で文字列フォーマットの適合を確認した上で、ゲームロジックまで踏み込んで
チェックする層。

盤面は内部で追跡し、reversi_rules のルールエンジンで合法手判定する。

ステップ種別:
  { "tx": "<text>" }         - テキスト送信 (盤面変更なし)
  { "tx_bo": "<64char>" }    - "BO<64char>" を送り、盤面トラッカーも同期
  { "tx_opp_mo": "<coord>" } - "MO<coord>" を送り、opp の手として盤面に適用
  { "tx_pa" }                - "PA" を送る (opp パス通知、盤面変更なし)
  { "rx": "<exact>" }        - 完全一致応答
  { "rx_regex": "<pat>" }    - 正規表現応答
  { "rx_mo_legal" }          - "MO<coord>" を受信し、CPU 色の合法手であること
                                さらに受信した手を盤面に適用
  { "rx_pa" }                - "PA" 応答を期待 (CPU に合法手が無い局面で)
  { "rx_silent_ms": N }      - N ms 間 応答が無いことを確認

ケース共通フィールド:
  cpu_color: "B" または "W"      (必須)
  initial_board: "initial" or 64-char BO 文字列 (デフォルト: initial)
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from conftest import check_regex
from reversi_rules import (
    BLACK, WHITE,
    init_board, board_from_bo, legal_moves, apply_move,
    parse_coord, fmt_coord,
)


CASES_DIR = Path(__file__).parent / "cases" / "game_rule"


def _load_cases() -> list:
    return [(p.stem, json.loads(p.read_text(encoding="utf-8")))
            for p in sorted(CASES_DIR.glob("*.json"))]


def _make_initial_state(case: dict):
    """case から初期盤面と CPU 色を取り出す"""
    cpu_color_str = case["cpu_color"]
    cpu_color = BLACK if cpu_color_str == "B" else WHITE
    init = case.get("initial_board", "initial")
    if init == "initial":
        board = init_board()
    else:
        board = board_from_bo(init)
        if board is None:
            pytest.fail(f"initial_board 不正: {init!r}")
    return board, cpu_color


def _opp_color(cpu_color: int) -> int:
    return WHITE if cpu_color == BLACK else BLACK


def _run_case(cpu, case: dict):
    board, cpu_color = _make_initial_state(case)
    opp_color = _opp_color(cpu_color)
    timeout_s = case.get("timeout_ms", 2000) / 1000
    section = case.get("section", "?")

    for i, step in enumerate(case["steps"]):
        if "tx" in step:
            cpu.send_line(step["tx"])

        elif "tx_bo" in step:
            bo = step["tx_bo"]
            new_board = board_from_bo(bo)
            if new_board is None:
                pytest.fail(f"§{section} step[{i}]: tx_bo の文字列不正: {bo!r}")
            board = new_board
            cpu.send_line(f"BO{bo}")

        elif "tx_opp_mo" in step:
            coord = step["tx_opp_mo"]
            r, c = parse_coord(coord)
            if not apply_move(board, r, c, opp_color):
                pytest.fail(
                    f"§{section} step[{i}]: テストシナリオが不正: "
                    f"opp が {coord} を打とうとしたが合法手ではない"
                )
            cpu.send_line(f"MO{coord}")

        elif "tx_pa" in step:
            cpu.send_line("PA")

        elif "rx" in step:
            got = cpu.read_line(timeout=timeout_s)
            assert got == step["rx"], \
                f"§{section} step[{i}]: expected {step['rx']!r}, got {got!r}\n\nLog:\n{cpu.dump_log()}"

        elif "rx_regex" in step:
            got = cpu.read_line(timeout=timeout_s)
            assert check_regex(step["rx_regex"], got), \
                f"§{section} step[{i}]: expected /{step['rx_regex']}/, got {got!r}\n\nLog:\n{cpu.dump_log()}"

        elif "rx_mo_legal" in step:
            got = cpu.read_line(timeout=timeout_s)
            m = re.match(r"^MO([a-hA-H])([1-8])$", got)
            assert m, \
                f"§{section} step[{i}]: MO<coord> 形式でない応答: {got!r}\n\nLog:\n{cpu.dump_log()}"
            coord = (m.group(1) + m.group(2)).lower()
            r, row_c = parse_coord(coord)
            legals = legal_moves(board, cpu_color)
            assert (r, row_c) in legals, (
                f"§{section} step[{i}]: CPU の手 {coord!r} は "
                f"{'BLACK' if cpu_color == BLACK else 'WHITE'} の合法手ではない。\n"
                f"合法手: {[fmt_coord(r, c) for r, c in legals]}\n"
                f"盤面:\n{_ascii_board(board)}\n\nLog:\n{cpu.dump_log()}"
            )
            apply_move(board, r, row_c, cpu_color)

        elif "rx_pa" in step:
            got = cpu.read_line(timeout=timeout_s)
            assert got == "PA", \
                f"§{section} step[{i}]: expected 'PA' (CPU は合法手無しのはず), got {got!r}\n" \
                f"合法手: {[fmt_coord(r, c) for r, c in legal_moves(board, cpu_color)]}\n\n" \
                f"Log:\n{cpu.dump_log()}"

        elif "rx_silent_ms" in step:
            # N ms 間 ST/NC 以外の応答が来ないことを確認。
            # time.sleep で固定待機 → in_waiting で残量確認 (non-blocking で確実に止まる)。
            import time as _time
            wait_s = step["rx_silent_ms"] / 1000
            _time.sleep(wait_s)
            n_available = cpu.ser.in_waiting
            if n_available > 0:
                raw = cpu.ser.read(n_available)
                cpu.log.append((_time.time(), "RX-raw", repr(raw)))
                text = raw.decode("ascii", errors="replace")
                for line in text.splitlines():
                    if not line.strip():
                        continue
                    if len(line) >= 2 and line[:2].upper() in ("ST", "NC"):
                        continue  # 診断応答は無視
                    pytest.fail(
                        f"§{section} step[{i}]: {wait_s}s 間 応答無しを期待したが "
                        f"{line!r} を受信\n\nLog:\n{cpu.dump_log()}"
                    )

        else:
            pytest.fail(f"step[{i}]: unknown directive: {step!r}")


def _ascii_board(board) -> str:
    lines = ["    a b c d e f g h"]
    for r in range(8):
        row = " ".join("." if v == 0 else ("B" if v == BLACK else "W") for v in board[r])
        lines.append(f"  {r + 1} {row}")
    return "\n".join(lines)


@pytest.mark.parametrize(
    "case_id,case",
    [pytest.param(name, c, id=name) for name, c in _load_cases()],
)
def test_game_rule(request, cpu, case_id: str, case: dict):
    """ゲームルール適合のデータ駆動テスト。"""
    if request.config.getoption("--protocol-only"):
        pytest.skip("L2 game-rule test - --protocol-only で除外")
    if request.config.getoption("--required-only") and not case.get("required", True):
        pytest.skip("optional protocol (§6.1/§6.2 の任意コマンド) - --required-only で除外")
    _run_case(cpu, case)
