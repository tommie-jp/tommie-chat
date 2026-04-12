#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# doBanner.sh — テキストをドットバナーとして CSV 出力する
#
# Usage:
#   bash nakama/doBanner.sh "Hello"
#   bash nakama/doBanner.sh --pen "#" --fill "." "漢字"
#   bash nakama/doBanner.sh --size 24 "ABC"
#
# Options:
#   --pen  <char>   フォントを埋める文字 (default: 1)
#   --fill <char>   空白を埋める文字     (default: 0)
#   --size <int>    フォントサイズ       (default: 16)
#   --font <path>   フォントファイルパス (default: 自動検出)
#   --mode <mono|color>  出力モード (default: mono)
#                    mono  — pen/fill で出力
#                    color — 色を16進 (rrggbb) で出力、空白は fill
# ─────────────────────────────────────────────────────────────
set -euo pipefail

PEN="1"
FILL="0"
SIZE=16
FONT=""
MODE="mono"
TEXT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pen)  PEN="$2";  shift 2 ;;
    --fill) FILL="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --font) FONT="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,/^# ────/{ /^# ────/d; s/^# \?//p }' "$0"
      exit 0 ;;
    -*) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
    *)  TEXT="$1"; shift ;;
  esac
done

if [[ -z "$TEXT" ]]; then
  echo "ERROR: テキストを指定してください" >&2
  echo "Usage: bash $0 \"Hello\"" >&2
  exit 1
fi

python3 - "$TEXT" "$PEN" "$FILL" "$SIZE" "$FONT" "$MODE" <<'PYEOF'
import sys
from PIL import Image, ImageDraw, ImageFont

import re, os

text = sys.argv[1]
pen  = sys.argv[2]
fill = sys.argv[3]
size = int(sys.argv[4])
font_path = sys.argv[5]
mode = sys.argv[6]  # "mono" or "color"

# 異体字セレクタ (U+FE0E, U+FE0F) を除去
text = re.sub(r'[\uFE0E\uFE0F]', '', text)

# 絵文字判定（1文字単位）
EMOJI_RE = re.compile(r'[\U0001F300-\U0001F9FF\U00002600-\U000027BF\U00002B50-\U00002B55\U0001FA00-\U0001FA9F]')
def is_emoji_char(ch):
    return bool(EMOJI_RE.match(ch))

# テキストを絵文字/非絵文字の連続区間に分割
def split_segments(s):
    """[(text, is_emoji), ...] に分割"""
    segments = []
    cur = ""
    cur_emoji = None
    for ch in s:
        e = is_emoji_char(ch)
        if cur_emoji is not None and e != cur_emoji:
            segments.append((cur, cur_emoji))
            cur = ""
        cur += ch
        cur_emoji = e
    if cur:
        segments.append((cur, cur_emoji))
    return segments

# フォント候補
EMOJI_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf",
]
TEXT_FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
]

def try_load(path, sz):
    """フォント読み込み。ビットマップフォント(固定サイズ)の場合はサイズを自動調整"""
    try:
        return ImageFont.truetype(path, sz)
    except OSError:
        for try_sz in [109, 128, 136, 64, 32, 16]:
            try:
                return ImageFont.truetype(path, try_sz)
            except OSError:
                continue
    return None

def find_font(candidates, sz):
    for fp in candidates:
        if not os.path.exists(fp):
            continue
        f = try_load(fp, sz)
        if f:
            return f
    return None

# フォントをロード
if font_path:
    text_font = try_load(font_path, size)
    emoji_font = text_font
    if text_font is None:
        print(f"ERROR: フォントを読み込めません: {font_path}", file=sys.stderr)
        sys.exit(1)
else:
    text_font = find_font(TEXT_FONT_CANDIDATES, size)
    emoji_font = find_font(EMOJI_FONT_CANDIDATES, size)
    if text_font is None and emoji_font is None:
        print("ERROR: フォントが見つかりません。--font でパスを指定してください", file=sys.stderr)
        sys.exit(1)

# 区間ごとに描画して横に結合
def render_segment(seg_text, font_obj):
    bbox = font_obj.getbbox(seg_text)
    w = bbox[2] - bbox[0] + 2
    h = bbox[3] - bbox[1] + 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    try:
        ImageDraw.Draw(img).text((-bbox[0] + 1, -bbox[1] + 1), seg_text,
                                  fill=(255, 255, 255, 255), font=font_obj, embedded_color=True)
    except TypeError:
        ImageDraw.Draw(img).text((-bbox[0] + 1, -bbox[1] + 1), seg_text,
                                  fill=(255, 255, 255, 255), font=font_obj)
    return img

segments = split_segments(text)
images = []
for seg_text, seg_is_emoji in segments:
    fnt = (emoji_font if seg_is_emoji and emoji_font else text_font) or emoji_font
    images.append(render_segment(seg_text, fnt))

# 高さを揃えて横結合
target_h = size + 2
parts = []
for im in images:
    if im.height != target_h:
        ratio = target_h / im.height
        im = im.resize((max(1, int(im.width * ratio)), target_h), Image.NEAREST)
    parts.append(im)

total_w = sum(p.width for p in parts)
img = Image.new("RGBA", (total_w, target_h), (0, 0, 0, 0))
x_offset = 0
for p in parts:
    img.paste(p, (x_offset, 0))
    x_offset += p.width
w, h = img.size

# 出力
for y in range(h):
    row = []
    for x in range(w):
        r, g, b, a = img.getpixel((x, y))
        if a > 0:
            if mode == "color":
                row.append(f"{r:02x}{g:02x}{b:02x}")
            else:
                row.append(pen)
        else:
            row.append(fill)
    print(",".join(row))
PYEOF
