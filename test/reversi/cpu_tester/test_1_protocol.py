"""
UART プロトコル適合テスト (§6.1 / §6.2)。

cases/protocol/*.json をデータ駆動で実行する。CPU 実装者がまず最初に
走らせるべき診断セット。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from conftest import check_regex


CASES_DIR = Path(__file__).parent / "cases" / "protocol"


def _load_cases() -> list:
    return [(p.stem, json.loads(p.read_text(encoding="utf-8")))
            for p in sorted(CASES_DIR.glob("*.json"))]


def _run_case(cpu, case: dict):
    timeout_s = case.get("timeout_ms", 500) / 1000
    for i, step in enumerate(case["steps"]):
        if "tx" in step:
            cpu.send_line(step["tx"])
        elif "tx_raw" in step:
            # LF を含めた任意バイト列をそのまま送信 (CR 混入テスト等)
            cpu.send_raw(step["tx_raw"])
        elif "rx" in step:
            got = cpu.read_line(timeout=timeout_s)
            assert got == step["rx"], \
                f"§{case.get('section', '?')} step[{i}]: expected {step['rx']!r}, got {got!r}\n\nLog:\n{cpu.dump_log()}"
        elif "rx_regex" in step:
            got = cpu.read_line(timeout=timeout_s)
            assert check_regex(step["rx_regex"], got), \
                f"§{case.get('section', '?')} step[{i}]: expected /{step['rx_regex']}/, got {got!r}\n\nLog:\n{cpu.dump_log()}"
        else:
            pytest.fail(f"step[{i}]: unknown directive: {step!r}")


@pytest.mark.parametrize(
    "case_id,case",
    [pytest.param(name, c, id=name) for name, c in _load_cases()],
)
def test_protocol(request, cpu, case_id: str, case: dict):
    """プロトコル適合 (§6.1/§6.2) のデータ駆動テスト。"""
    if request.config.getoption("--required-only") and not case.get("required", True):
        pytest.skip("optional protocol (§6.1/§6.2 の任意コマンド) - --required-only で除外")
    _run_case(cpu, case)
