#!/bin/sh
# Serves tools/mic-probe/ on 127.0.0.1:$1 (default 8765) from a temp folder where sdk.js points at the installed SDK. Ctrl-C stops it.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT INT TERM
ln -s "$HERE/index.html" "$D/index.html"
ln -s "$HERE/../../node_modules/@evenrealities/even_hub_sdk/dist/index.js" "$D/sdk.js"
exec python3 -m http.server "${1:-8765}" --bind 127.0.0.1 --directory "$D"
