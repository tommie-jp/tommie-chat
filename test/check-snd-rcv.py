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
import bisect
from typing import List, Tuple

# ── 設定 ──────────────────────────────────────────────
WINDOW_SEC  = 2.0   # snd→rcv の最大許容遅延（秒）
WINDOW_SEC_LARGE = 5.0  # 大人数(1000人超)用: サーバ負荷による遅延を許容
CLOCK_SLACK = 0.5   # 0.1秒精度ログの丸め誤差許容（秒）
LOGOUT_WINDOW_SEC = 15.0  # logout用: 一斉切断時のサーバ処理遅延を許容
LARGE_THRESHOLD = 1000  # この人数以上でWINDOW_SEC_LARGEを使用

# 警告扱い（エラーカウントに含めない）ペアのラベル
WARN_ONLY_LABELS = {'logout'}

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
# --movetarget: opMoveTarget テスト
PAIRS_MOVETARGET = [
    ('snd moveTarget',      'rcv moveTarget',      'moveTarget',        'cs'),
    ('rcv matchdata op=2',  'snd moveTarget:signal', 'moveTarget:signal', 'sc'),
]
# --avatarchange: opAvatarChange テスト
PAIRS_AVATARCHANGE = [
    ('snd avatarChange',    'rcv avatarChange',    'avatarChange',      'cs'),
    ('rcv matchdata op=3',  'snd avatarChange:signal', 'avatarChange:signal', 'sc'),
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

def local_to_utc(sec: float) -> float:
    """ローカル秒（深夜0時からの秒数）を UTC 秒に変換（日付境界を正規化）"""
    return (sec + _UTC_OFFSET) % 86400

def hms_to_sec(h: int, m: int, s: int, ds: int = 0) -> float:
    """時分秒+0.1秒 → 秒数"""
    return h * 3600 + m * 60 + s + ds * 0.1

# ── ログパース ─────────────────────────────────────────

Event = Tuple[float, str]  # (utc_sec, message)

_CLIENT_RE = re.compile(
    r'\[.+?\] (\d{2}):(\d{2}):(\d{2})(?:\.(\d))? (.+)'
)
_SERVER_RE = re.compile(
    r'^(\d{2}):(\d{2}):(\d{2})(?:\.(\d))? (.+)'
)

def parse_client_log(path: str) -> List[Event]:
    events: List[Event] = []
    with open(path, errors='replace') as f:
        for raw in f:
            line = strip_ansi(raw).strip()
            m = _CLIENT_RE.search(line)
            if m:
                sec = hms_to_sec(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                                 int(m.group(4)) if m.group(4) else 0)
                events.append((local_to_utc(sec), m.group(5)))
    return events

def parse_server_log(path: str) -> List[Event]:
    events: List[Event] = []
    with open(path, errors='replace') as f:
        for raw in f:
            line = raw.strip()
            m = _SERVER_RE.match(line)
            if m:
                sec = hms_to_sec(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                                 int(m.group(4)) if m.group(4) else 0)
                events.append((sec, m.group(5)))  # server は UTC のまま
    return events

def sec_to_hms(sec: float) -> str:
    sec = sec % 86400
    h, rem = divmod(int(abs(sec)), 3600)
    m, s   = divmod(rem, 60)
    ds = int((abs(sec) % 1) * 10)
    return f'{h:02d}:{m:02d}:{s:02d}.{ds}'

# ── 1対1マッチング ─────────────────────────────────────

def match_events(
    first:  List[Event],   # 先に起きるべきイベント
    second: List[Event],   # 後に起きるべきイベント
    window_sec: float = WINDOW_SEC,
) -> Tuple[int, List[Event]]:
    """
    first の各イベントに対して、時間窓内の second イベントを貪欲マッチ。
    O(n log n): second をソートし二分探索で候補を絞る。
    返り値: (matched_count, unmatched_first_events)
    """
    # second を時刻でソート（元のインデックスを保持）
    sorted_second = sorted(enumerate(second), key=lambda x: x[1][0])
    s_times = [s[1][0] for s in sorted_second]

    used: set = set()
    matched = 0
    unmatched: List[Event] = []

    for f_sec, f_msg in first:
        # 窓: [f_sec - CLOCK_SLACK, f_sec + window_sec]
        lo = f_sec - CLOCK_SLACK
        hi = f_sec + window_sec
        # 二分探索で候補範囲を特定
        left = bisect.bisect_left(s_times, lo)
        right = bisect.bisect_right(s_times, hi)

        found = False
        for j in range(left, right):
            orig_i = sorted_second[j][0]
            if orig_i in used:
                continue
            used.add(orig_i)
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
) -> Tuple[bool, bool]:
    """返り値: (ok, is_warn_only) — is_warn_only=True なら失敗でもエラーカウントしない"""
    warn_only = label in WARN_ONLY_LABELS
    # イベント数に応じて窓を選択
    c_evs_pre = [(t, m) for t, m in client_events if c_pattern in m]
    is_large = len(c_evs_pre) >= LARGE_THRESHOLD
    if label in WARN_ONLY_LABELS:
        win = LOGOUT_WINDOW_SEC
    elif is_large:
        win = WINDOW_SEC_LARGE
    else:
        win = WINDOW_SEC

    c_evs = c_evs_pre
    s_evs = [(t, m) for t, m in server_events if s_pattern in m]

    if not c_evs and not s_evs:
        print(f'  ⚪ {label}  (両方なし — スキップ)')
        return True, warn_only

    if not c_evs:
        icon = '⚠️' if warn_only else '❌'
        print(f'  {icon} {label}  クライアントログなし (server={len(s_evs)}件)')
        for t, msg in s_evs:
            print(f'       server {sec_to_hms(t)} {msg[:80]}')
        return False, warn_only

    if not s_evs:
        icon = '⚠️' if warn_only else '❌'
        print(f'  {icon} {label}  サーバログなし (client={len(c_evs)}件)')
        for t, msg in c_evs:
            print(f'       client {sec_to_hms(t + (-_UTC_OFFSET))} (UTC {sec_to_hms(t)}) {msg[:80]}')
        return False, warn_only

    # 方向に応じて first/second を決定
    if direction == 'cs':
        first, second = c_evs, s_evs    # client snd が先、server rcv が後
        first_label, second_label = 'client', 'server'
    else:
        first, second = s_evs, c_evs    # server snd が先、client rcv が後
        first_label, second_label = 'server', 'client'

    matched, unmatched = match_events(first, second, window_sec=win)

    if unmatched:
        icon = '⚠️' if warn_only else '❌'
        suffix = '（警告のみ）' if warn_only else ''
        print(f'  {icon} {label}  未マッチあり{suffix}'
              f' (matched={matched}/{len(first)}, client={len(c_evs)}, server={len(s_evs)},'
              f' window=[-{CLOCK_SLACK:.1f}s,+{win:.1f}s])')
        # 未マッチ詳細は最大20件表示
        show = unmatched[:20]
        for t, msg in show:
            if first_label == 'client':
                local_t = t - _UTC_OFFSET
                print(f'       未マッチ {first_label}: {sec_to_hms(local_t)} (UTC {sec_to_hms(t)}) {msg[:80]}')
            else:
                print(f'       未マッチ {first_label}: UTC {sec_to_hms(t)} {msg[:80]}')
        if len(unmatched) > 20:
            print(f'       ... 他 {len(unmatched) - 20}件省略')
        return False, warn_only
    else:
        print(f'  ✅ {label}  (matched={matched}/{len(first)}, client={len(c_evs)}, server={len(s_evs)},'
              f' window=[-{CLOCK_SLACK:.1f}s,+{win:.1f}s])')
        return True, warn_only

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
    parser.add_argument('--setblock',    action='store_true',
                        help='setBlock/getGroundChunk/setBlock:signal チェックも実施（setBlock テスト用）')
    parser.add_argument('--movetarget',  action='store_true',
                        help='moveTarget/moveTarget:signal チェックも実施（opMoveTarget テスト用）')
    parser.add_argument('--avatarchange', action='store_true',
                        help='avatarChange/avatarChange:signal チェックも実施（opAvatarChange テスト用）')
    args = parser.parse_args()

    enabled = []
    if args.duo:          enabled.append('--duo')
    if args.aoi_leave:    enabled.append('--aoi-leave')
    if args.setblock:     enabled.append('--setblock')
    if args.movetarget:   enabled.append('--movetarget')
    if args.avatarchange: enabled.append('--avatarchange')

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
             + (PAIRS_AOI_ENTER   if args.duo          else [])
             + (PAIRS_AOI_LEAVE   if args.aoi_leave    else [])
             + (PAIRS_SETBLOCK    if args.setblock     else [])
             + (PAIRS_MOVETARGET  if args.movetarget   else [])
             + (PAIRS_AVATARCHANGE if args.avatarchange else []))

    errors = 0
    warnings = 0
    for c_pat, s_pat, label, direction in pairs:
        ok, warn_only = check_pair(client_events, server_events, c_pat, s_pat, label, direction)
        if not ok:
            if warn_only:
                warnings += 1
            else:
                errors += 1

    if warnings > 0:
        print(f'\n  ⚠️ 警告: {warnings}件（エラーカウント対象外）')

    return errors

if __name__ == '__main__':
    sys.exit(main())
