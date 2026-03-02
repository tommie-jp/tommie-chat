#!/bin/bash

# ==========================================
# PNG -> KTX2 一括変換スクリプト (POT判定・安全装置付き)
# ==========================================

INPUT_DIR="."
OUTPUT_DIR="./ktx2_output"

# 色付け用の変数（見やすくするため）
YELLOW='\033[1;33m'
GREEN='\033[1;32m'
RED='\033[1;31m'
NC='\033[0m' # No Color

mkdir -p "$OUTPUT_DIR"

# ------------------------------------------
# 数値が2の累乗(POT)かどうかを判定する関数
# (ビット演算: N & (N - 1) == 0 なら2の累乗)
# ------------------------------------------
is_pot() {
    local n=$1
    (( n > 0 && (n & (n - 1)) == 0 ))
}

echo "PNGからKTX2への一括変換を開始します..."
echo "========================================"

for png_file in "$INPUT_DIR"/*.png; do
    [ -e "$png_file" ] || continue

    filename=$(basename -- "$png_file")
    filename_no_ext="${filename%.*}"
    output_file="$OUTPUT_DIR/${filename_no_ext}.ktx2"

    # fileコマンドと正規表現を使って画像の幅と高さを抽出 (Ubuntu環境用)
    dim=$(file "$png_file" | grep -oP '\d+\s*x\s*\d+' | head -n 1)
    if [[ -n "$dim" ]]; then
        width=$(echo "$dim" | awk -F'x' '{print $1}' | tr -d ' ')
        height=$(echo "$dim" | awk -F'x' '{print $2}' | tr -d ' ')
    else
        width=0
        height=0
    fi

    echo "対象: $filename (サイズ: ${width} x ${height})"

    # POTチェックとオプションの動的切り替え
    if is_pot "$width" && is_pot "$height"; then
        echo -e "${GREEN}✅ サイズは2の累乗(POT)です。ミップマップを生成します。${NC}"
        MIPMAP_OPT="--genmipmap"
    else
        echo -e "${YELLOW}⚠️ [警告] サイズが2の累乗(POT)ではありません！${NC}"
        echo -e "${YELLOW}   WebGLでのエラーを防ぐため、ミップマップなしで変換します。${NC}"
        echo -e "${YELLOW}   (推奨: 余白を追加して 512x1024 や 1024x2048 等に変更してください)${NC}"
        MIPMAP_OPT="" # ミップマップオプションを外す
    fi

    # toktxコマンドの実行（MIPMAP_OPT は変数展開で適用/非適用が切り替わる）
    toktx --t2 --encode uastc $MIPMAP_OPT --assign_oetf srgb "$output_file" "$png_file" > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}  -> 完了: ${filename_no_ext}.ktx2${NC}"
    else
        echo -e "${RED}❌ エラーが発生しました: $filename${NC}"
    fi
    echo "----------------------------------------"
done

echo "すべての処理が完了しました！"