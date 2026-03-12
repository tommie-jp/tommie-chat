#!/usr/bin/env python3
"""
snd/rcv 整合性チェック（タイムスタンプ付き1対1マッチング）

使い方:
  python3 test/check-snd-rcv.py <client_log> <server_log> [--duo]

  --duo  AOI_ENTER(双方向) チェックも実施（2人ログインテスト用）

終了コード: エラー件数（0 = 全チェック通過）
"""

import sys
import re
import time
import argparse
from typing import List, Tuple

# ── 設定 ──────────────────────────────────────────────
WINDOW_SEC  = 5   # snd→rcv の最大許容遅延（秒）
CLOCK_SLACK = 2   # 秒精度ログの丸め誤差許容（秒）

# クライアント → サーバ の snd/rcv ペア定義
# (クライアントlog検索パターン, サーバlog検索パターン, ラベル, 方向)
# 方向 'cs': client→server（clientが先）
#      'sc': server→client（serverが先）
PAIRS_COMMON = [
    # ── client → server ──
    ('snd Login',           'rcv login',           'Login',           'cs'),
    ('snd logout',          'rcv logout',          'logout',          'cs'),
    ('snd storeLoginTime',  'rcv storeLoginTime',  'storeLoginTime',  'cs'),
    ('snd getWorldMatch',   'rcv getWorldMatch',   'getWorldMatch',   'cs'),
    ('snd initPos',         'rcv initPos',         'initPos',         'cs'),
    ('snd AOI_UPDATE',      'rcv AOI_UPDATE',      'AOI_UPDATE',      'cs'),
    ('snd syncChunks',      'rcv syncChunks',      'syncChunks',      'cs'),
    ('snd getServerInfo',   'rcv getServerInfo',   'getServerInfo',   'cs'),
]
# --duo: 2人ログインテスト（AOI_ENTER 双方向）
PAIRS_AOI_ENTER = [
    ('rcv AOI_ENTER',       'snd AOI_ENTER',       'AOI_ENTER(双方向)', 'sc'),
]
# --aoi-leave: AOI_LEAVE テスト
PAIRS_AOI_LEAVE = [
    ('rcv matchdata op=7',  'snd AOI_LEAVE',       'AOI_LEAVE',         'sc'),
]
# --setblock: setBlock テスト
PAIRS_SETBLOCK = [
    ('snd setBlock',        'rcv setBlock',        'setBlock',          'cs'),
    ('snd getGroundChunk',  'rcv getGroundChunk',  'getGroundChunk',    'cs'),
    ('rcv matchdata op=4',  'snd setBlock:signal', 'setBlock:signal',   'sc'),
]

# ── ANSI エスケープ除去 ────────────────────────────────
ANSI_RE = re.compile(r'\x1b\[[0-9;]*[mGKHF]')

def strip_ansi(s: str) -> str:
    return ANSI_RE.sub('', s)

# ── ローカル→UTC 変換 ──────────────────────────────────
# time.timezone: ローカルタイムゾーンの UTC 西方向オフセット（秒）
# 東方向（JST など）は負の値
# UTC秒 = ローカル秒 + time.timezone
_UTC_OFFSET = time.timezone  # e.g. JST: -32400

def local_to_utc(sec: int) -> int:
    """ローカル秒（深夜0時からの秒数）を UTC 秒に変換"""
    return sec + _UTC_OFFSET

def hms_to_sec(h: int, m: int, s: int) -> int:
    return h * 3600 + m * 60 + s

# ── ログパース ─────────────────────────────────────────

Event = Tuple[int, str]  # (utc_sec, message)

_CLIENT_RE = re.compile(
    r'\[.+?\] (\d{2}):(\d{2}):(\d{2}) (.+)'
)
_SERVER_RE = re.compile(
    r'^(\d{2}):(\d{2}):(\d{2}) (.+)'
)

def parse_client_log(path: str) -> List[Event]:
    events: List[Event] = []
    with open(path, errors='replace') as f:
        for raw in f:
            line = strip_ansi(raw).strip()
            m = _CLIENT_RE.search(line)
            if m:
                sec = hms_to_sec(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                events.append((local_to_utc(sec), m.group(4)))
    return events

def parse_server_log(path: str) -> List[Event]:
    events: List[Event] = []
    with open(path, errors='replace') as f:
        for raw in f:
            line = raw.strip()
            m = _SERVER_RE.match(line)
            if m:
                sec = hms_to_sec(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                events.append((sec, m.group(4)))  # server は UTC のまま
    return events

def sec_to_hms(sec: int) -> str:
    sec = sec % 86400
    h, rem = divmod(abs(sec), 3600)
    m, s   = divmod(rem, 60)
    return f'{h:02d}:{m:02d}:{s:02d}'

# ── 1対1マッチング ─────────────────────────────────────

def match_events(
    first:  List[Event],   # 先に起きるべきイベント
    second: List[Event],   # 後に起きるべきイベント
) -> Tuple[int, List[Event]]:
    """
    first の各イベントに対して、時間窓内の second イベントを貪欲マッチ。
    返り値: (matched_count, unmatched_first_events)
    """
    used: set = set()
    matched = 0
    unmatched: List[Event] = []

    for f_sec, f_msg in first:
        found = False
        for i, (s_sec, _s_msg) in enumerate(second):
            if i in used:
                continue
            diff = s_sec - f_sec  # 正 = second が後（正常）
            if -CLOCK_SLACK <= diff <= WINDOW_SEC:
                used.add(i)
                matched += 1
                found = True
                break
        if not found:
            unmatched.append((f_sec, f_msg))

    return matched, unmatched

# ── ペアチェック ───────────────────────────────────────

def check_pair(
    client_events: List[Event],
    server_events: List[Event],
    c_pattern: str,
    s_pattern: str,
    label: str,
    direction: str,  # 'cs' or 'sc'
) -> bool:
    c_evs = [(t, m) for t, m in client_events if c_pattern in m]
    s_evs = [(t, m) for t, m in server_events if s_pattern in m]

    if not c_evs and not s_evs:
        print(f'  ⚪ {label}  (両方なし — スキップ)')
        return True

    if not c_evs:
        print(f'  ❌ {label}  クライアントログなし (server={len(s_evs)}件)')
        for t, msg in s_evs:
            print(f'       server {sec_to_hms(t)} {msg[:80]}')
        return False

    if not s_evs:
        print(f'  ❌ {label}  サーバログなし (client={len(c_evs)}件)')
        for t, msg in c_evs:
            print(f'       client {sec_to_hms(t + (-_UTC_OFFSET))} (UTC {sec_to_hms(t)}) {msg[:80]}')
        return False

    # 方向に応じて first/second を決定
    if direction == 'cs':
        first, second = c_evs, s_evs    # client snd が先、server rcv が後
        first_label, second_label = 'client', 'server'
    else:
        first, second = s_evs, c_evs    # server snd が先、client rcv が後
        first_label, second_label = 'server', 'client'

    matched, unmatched = match_events(first, second)

    if unmatched:
        print(f'  ❌ {label}  未マッチあり'
              f' (matched={matched}/{len(first)}, client={len(c_evs)}, server={len(s_evs)},'
              f' window=[-{CLOCK_SLACK}s,+{WINDOW_SEC}s])')
        for t, msg in unmatched:
            # 未マッチのローカル時刻を再現して表示
            if first_label == 'client':
                local_t = t - _UTC_OFFSET
                print(f'       未マッチ {first_label}: {sec_to_hms(local_t)} (UTC {sec_to_hms(t)}) {msg[:80]}')
            else:
                print(f'       未マッチ {first_label}: UTC {sec_to_hms(t)} {msg[:80]}')
        return False
    else:
        print(f'  ✅ {label}  (matched={matched}/{len(first)}, client={len(c_evs)}, server={len(s_evs)},'
              f' window=[-{CLOCK_SLACK}s,+{WINDOW_SEC}s])')
        return True

# ── メイン ─────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description='snd/rcv 整合性チェック（タイムスタンプ付き1対1マッチング）'
    )
    parser.add_argument('client_log', help='クライアントログファイル')
    parser.add_argument('server_log', help='サーバログファイル')
    parser.add_argument('--duo',       action='store_true',
                        help='AOI_ENTER(双方向) チェックも実施（2人ログインテスト用）')
    parser.add_argument('--aoi-leave', action='store_true',
                        help='AOI_LEAVE チェックも実施（AOI_LEAVE テスト用）')
    parser.add_argument('--setblock',  action='store_true',
                        help='setBlock/getGroundChunk/setBlock:signal チェックも実施（setBlock テスト用）')
    args = parser.parse_args()

    enabled = []
    if args.duo:       enabled.append('--duo')
    if args.aoi_leave: enabled.append('--aoi-leave')
    if args.setblock:  enabled.append('--setblock')

    print(f'  クライアントログ: {args.client_log}')
    print(f'  サーバログ:       {args.server_log}')
    print(f'  UTC オフセット:   {-_UTC_OFFSET // 3600:+d}h'
          f' (ローカル {sec_to_hms(hms_to_sec(0,0,0) - _UTC_OFFSET)[:2]}時 = UTC 00:00)')
    if enabled:
        print(f'  オプション:       {" ".join(enabled)}')
    print()

    client_events = parse_client_log(args.client_log)
    server_events = parse_server_log(args.server_log)

    pairs = (PAIRS_COMMON
             + (PAIRS_AOI_ENTER if args.duo       else [])
             + (PAIRS_AOI_LEAVE if args.aoi_leave else [])
             + (PAIRS_SETBLOCK  if args.setblock  else []))

    errors = 0
    for c_pat, s_pat, label, direction in pairs:
        ok = check_pair(client_events, server_events, c_pat, s_pat, label, direction)
        if not ok:
            errors += 1

    return errors

if __name__ == '__main__':
    sys.exit(main())
