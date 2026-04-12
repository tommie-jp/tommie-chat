#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# doImage2csv.sh — ドット絵画像を CSV に変換する
#
# Usage:
#   bash nakama/doImage2csv.sh image.png
#   bash nakama/doImage2csv.sh --dot 4 sprite.png
#   bash nakama/doImage2csv.sh --dot auto --mode color icon.png
#
# Options:
#   --dot  <int|auto>  1論理ドットの実ピクセル数 (default: auto)
#                      auto — 繰り返しパターンから自動検出
#   --mode <mono|color> 出力モード (default: mono)
#                      mono  — pen/fill で出力
#                      color — 色を16進 (rrggbb) で出力、空白は fill
#   --pen  <char>      塗りピクセルの文字 (default: 1)
#   --fill <char>      背景ピクセルの文字 (default: 0)
#   --bg   <auto|rrggbb> 背景色 (default: auto = 四隅から推定)
#   --info             画像サイズ・検出ドットサイズを stderr に表示
# ─────────────────────────────────────────────────────────────
set -euo pipefail

DOT="auto"
MODE="mono"
PEN="1"
FILL="0"
BG="auto"
INFO=""
FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dot)  DOT="$2";  shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --pen)  PEN="$2";  shift 2 ;;
    --fill) FILL="$2"; shift 2 ;;
    --bg)   BG="$2";   shift 2 ;;
    --info) INFO="1";  shift ;;
    --help|-h)
      sed -n '2,/^# ────/{ /^# ────/d; s/^# \?//p }' "$0"
      exit 0 ;;
    -*) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
    *)  FILE="$1"; shift ;;
  esac
done

if [[ -z "$FILE" ]]; then
  echo "ERROR: 画像ファイルを指定してください" >&2
  echo "Usage: bash $0 image.png" >&2
  exit 1
fi

if [[ ! -f "$FILE" ]]; then
  echo "ERROR: ファイルが見つかりません: $FILE" >&2
  exit 1
fi

python3 - "$FILE" "$DOT" "$MODE" "$PEN" "$FILL" "$BG" "$INFO" <<'PYEOF'
import sys
from PIL import Image

file_path = sys.argv[1]
dot_arg   = sys.argv[2]   # "auto" or int
mode      = sys.argv[3]   # "mono" or "color"
pen       = sys.argv[4]
fill      = sys.argv[5]
bg_arg    = sys.argv[6]   # "auto" or "rrggbb"
show_info = sys.argv[7]   # "1" or ""

img = Image.open(file_path).convert("RGBA")
w, h = img.size
px = img.load()

# ── 背景色の推定 ──────────────────────────────────────────
if bg_arg == "auto":
    corners = [(0, 0), (w-1, 0), (0, h-1), (w-1, h-1)]
    cr = sum(px[x, y][0] for x, y in corners) // 4
    cg = sum(px[x, y][1] for x, y in corners) // 4
    cb = sum(px[x, y][2] for x, y in corners) // 4
    bg_color = (cr, cg, cb)
else:
    bg_color = (int(bg_arg[0:2], 16), int(bg_arg[2:4], 16), int(bg_arg[4:6], 16))

def is_bg(r, g, b, a):
    """背景色かどうか（透明 or 背景色に近い）"""
    if a < 32:
        return True
    return ((r - bg_color[0])**2 + (g - bg_color[1])**2 + (b - bg_color[2])**2) < 900  # 距離30未満

# ── ドットサイズの自動検出 ──────────────────────────────────
def detect_dot_size(img, px, w, h):
    """隣接ピクセルの同色繰り返し長を統計して論理ドットサイズを推定"""
    candidates = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16]
    best_size = 1
    best_score = 0

    for dot in candidates:
        if dot == 1:
            continue
        if w % dot != 0 or h % dot != 0:
            continue
        # ドット境界でピクセルが一致するか検証
        match = 0
        total = 0
        # サンプリング（全ピクセルは重いのでストライドで間引き）
        step = max(1, (w // dot) // 40)
        for gx in range(0, w // dot, step):
            for gy in range(0, h // dot, step):
                bx, by = gx * dot, gy * dot
                base = px[bx, by]
                ok = True
                for dy in range(dot):
                    for dx in range(dot):
                        if px[bx + dx, by + dy] != base:
                            ok = False
                            break
                    if not ok:
                        break
                total += 1
                if ok:
                    match += 1
        if total > 0:
            score = match / total
            # 80%以上一致 && より大きいドットを優先
            if score > 0.80 and (score > best_score or (score > best_score - 0.05 and dot > best_size)):
                best_score = score
                best_size = dot

    return best_size

if dot_arg == "auto":
    dot = detect_dot_size(img, px, w, h)
else:
    dot = int(dot_arg)

out_w = w // dot
out_h = h // dot

if show_info:
    print(f"image: {w}x{h}  dot: {dot}x{dot}  output: {out_w}x{out_h}  bg: #{bg_color[0]:02x}{bg_color[1]:02x}{bg_color[2]:02x}", file=sys.stderr)

# ── CSV 出力 ──────────────────────────────────────────────
for gy in range(out_h):
    row = []
    for gx in range(out_w):
        # ドットブロックの中央ピクセルを代表値とする
        cx = gx * dot + dot // 2
        cy = gy * dot + dot // 2
        r, g, b, a = px[cx, cy]
        if is_bg(r, g, b, a):
            row.append(fill)
        else:
            if mode == "color":
                row.append(f"{r:02x}{g:02x}{b:02x}")
            else:
                row.append(pen)
    print(",".join(row))
PYEOF
