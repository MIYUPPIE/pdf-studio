#!/usr/bin/env bash
# Fetch pinned third-party sources into third_party/ (gitignored).
# Idempotent: skips anything already present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"
mkdir -p "$TP"

MUPDF_VERSION="1.28.6"
JSON_VERSION="v3.12.0"
DOCTEST_VERSION="v2.4.12"
EMSDK_VERSION="6.0.13"

if [ ! -d "$TP/mupdf-$MUPDF_VERSION-source" ]; then
  echo "fetching MuPDF $MUPDF_VERSION"
  curl -fL -o "$TP/mupdf.tar.gz" "https://mupdf.com/downloads/archive/mupdf-$MUPDF_VERSION-source.tar.gz"
  tar xzf "$TP/mupdf.tar.gz" -C "$TP"
  rm "$TP/mupdf.tar.gz"
fi
ln -sfn "mupdf-$MUPDF_VERSION-source" "$TP/mupdf"

# Local fixes to MuPDF (see patches/README.md). --forward makes this idempotent.
for p in "$ROOT"/patches/mupdf-"$MUPDF_VERSION"-*.patch; do
  [ -e "$p" ] || continue
  if patch -d "$TP/mupdf" -p1 --forward --dry-run -s < "$p" >/dev/null 2>&1; then
    patch -d "$TP/mupdf" -p1 --forward -s < "$p" && echo "applied $(basename "$p")"
  fi
done

mkdir -p "$TP/include/nlohmann"
if [ ! -f "$TP/include/nlohmann/json.hpp" ]; then
  echo "fetching nlohmann/json $JSON_VERSION"
  curl -fsSL -o "$TP/include/nlohmann/json.hpp" \
    "https://raw.githubusercontent.com/nlohmann/json/$JSON_VERSION/single_include/nlohmann/json.hpp"
fi
if [ ! -f "$TP/include/doctest.h" ]; then
  echo "fetching doctest $DOCTEST_VERSION"
  curl -fsSL -o "$TP/include/doctest.h" \
    "https://raw.githubusercontent.com/doctest/doctest/$DOCTEST_VERSION/doctest/doctest.h"
fi

EMSDK_DIR="${EMSDK:-$HOME/emsdk}"
if [ ! -x "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
  echo "installing emsdk $EMSDK_VERSION into $EMSDK_DIR"
  [ -d "$EMSDK_DIR" ] || git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
  "$EMSDK_DIR/emsdk" install "$EMSDK_VERSION"
  "$EMSDK_DIR/emsdk" activate "$EMSDK_VERSION"
fi
echo "deps ok"
