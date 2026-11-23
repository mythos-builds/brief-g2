#!/bin/sh
# Even Hub simulator, headless on the build machine: podman jail (WebKitGTK + Xvfb stay off the host) + automation API on 127.0.0.1.
# Image: podman build -t localhost/er-sim:bookworm tools/sim-container
# Usage: sim.sh start <http(s)-url> [port] | stop | status. --network=host → load ONLY our own URLs (it can reach the host's localhost).
# API (skill simulator-automation): GET /api/ping · /api/screenshot/glasses (576x288 RGBA) · /api/screenshot/webview · /api/console · POST /api/input
set -eu
# The simulator binary comes from this folder's own packages: `cd tools && npm ci --ignore-scripts` (exact versions).
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/node_modules/@evenrealities/sim-linux-x64/bin"
[ -x "$BIN/evenhub-simulator" ] || [ "${1:-}" = stop ] || [ "${1:-}" = status ] || { echo "no simulator binary: run 'npm ci --ignore-scripts' in $HERE" >&2; exit 1; }
PORT="${3:-9898}"
case "${1:-}" in
  start)
    url="${2:?usage: sim.sh start <url> [port]}"
    podman rm -f er-sim >/dev/null 2>&1 || true
    podman run -d --init --name er-sim --network=host -v "$BIN:/opt/sim:ro" localhost/er-sim:bookworm sh -c \
      "Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -nolisten unix & export DISPLAY=:99; for i in 1 2 3 4 5 6 7 8 9 10; do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.5; done; exec /opt/sim/evenhub-simulator --automation-port $PORT '$url'" >/dev/null
    curl -s -m 40 --retry 30 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$PORT/api/ping"; echo ;;
  stop) podman rm -f er-sim >/dev/null 2>&1 || true ;;
  status) podman ps -a --filter name=er-sim --format '{{.Status}}'; curl -s -m 3 "http://127.0.0.1:$PORT/api/ping" || true; echo ;;
  *) echo "usage: sim.sh start <url> [port] | stop | status" >&2; exit 2 ;;
esac
