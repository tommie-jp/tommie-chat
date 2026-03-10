#!/bin/bash
# Nakama Go プラグインをビルドするスクリプト
# nakama-pluginbuilder イメージを使って、Nakama サーバと同じ Go バージョンでコンパイルする

set -e

NAKAMA_VERSION="3.35.0"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/modules"
mkdir -p "$OUT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Nakama バイナリから google.golang.org/protobuf の正確なバージョンを取得して go.mod に固定する
# キャッシュ: NAKAMA_VERSION が同じなら再取得をスキップ
CACHE_FILE="$SCRIPT_DIR/.protobuf-version-cache"
CACHED_NAKAMA_VER=""
CACHED_PROTO_VER=""
if [ -f "$CACHE_FILE" ]; then
  CACHED_NAKAMA_VER=$(sed -n '1p' "$CACHE_FILE")
  CACHED_PROTO_VER=$(sed -n '2p' "$CACHE_FILE")
fi

if [ "$CACHED_NAKAMA_VER" = "$NAKAMA_VERSION" ] && [ -n "$CACHED_PROTO_VER" ]; then
  PROTO_VER="$CACHED_PROTO_VER"
  echo "Protobuf version from cache: $PROTO_VER"
else
  echo "Detecting protobuf version from Nakama $NAKAMA_VERSION binary..."
  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT
  CNAME=$(docker create "registry.heroiclabs.com/heroiclabs/nakama:${NAKAMA_VERSION}" 2>/dev/null)
  docker cp "${CNAME}:/nakama/nakama" "$TMPDIR/nakama" 2>/dev/null || true
  docker rm "$CNAME" >/dev/null 2>&1 || true

  PROTO_VER=""
  if [ -f "$TMPDIR/nakama" ]; then
    PROTO_VER=$(go version -m "$TMPDIR/nakama" 2>/dev/null \
      | awk '/\s+google\.golang\.org\/protobuf\s/{print $3}' | head -1)
  fi

  if [ -n "$PROTO_VER" ]; then
    printf '%s\n%s\n' "$NAKAMA_VERSION" "$PROTO_VER" > "$CACHE_FILE"
    echo "Detected and cached: $PROTO_VER"
  fi
fi

if [ -n "$PROTO_VER" ]; then
  if grep -q "google.golang.org/protobuf" "$SCRIPT_DIR/go.mod"; then
    sed -i "s|google.golang.org/protobuf .*|google.golang.org/protobuf $PROTO_VER // indirect|" "$SCRIPT_DIR/go.mod"
  else
    printf '\nrequire google.golang.org/protobuf %s // indirect\n' "$PROTO_VER" >> "$SCRIPT_DIR/go.mod"
  fi
else
  echo "Warning: could not detect Nakama protobuf version, using go.mod as-is"
fi

docker run --rm \
  --entrypoint sh \
  -v "$SCRIPT_DIR":/go_src \
  -v nakama-go-cache:/go/pkg/mod \
  -w /go_src \
  "registry.heroiclabs.com/heroiclabs/nakama-pluginbuilder:${NAKAMA_VERSION}" \
  -c "rm -f go.sum && GONOSUMDB='*' go build -mod=mod -buildmode=plugin -trimpath -o /go_src/world.so ."

mv -f "$SCRIPT_DIR/world.so" "$OUT_DIR/world.so"
echo "Built: $OUT_DIR/world.so"
