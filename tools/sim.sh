#!/bin/sh
# Even Hub simulator, headless on the build machine: podman jail (WebKitGTK + Xvfb stay off the host) + automation API on 127.0.0.1.
# Image: podman build -t localhost/er-sim:bookworm tools/sim-container
# Usage: [SIM_MIC=1] sim.sh start <http(s)-url> [port] | speak <file.wav> | stop | status | wipe. --network=host → load ONLY our own URLs (it can reach the host's localhost).
# The start address is the app's URL as given, query included: on the dev server `sim.sh start 'http://127.0.0.1:5174/?pair=123456'`
# pairs the simulator with a code from a local sign-in (src/dev-pair.ts; production builds ignore it).
# Storage: the simulator user's home (WebView data) is the named volume $SIM_VOLUME (default er-sim-data); `wipe` removes the
# container and that volume. SIM_VOLUME= (empty) = no volume (what `npm run shots` uses, so its runs start clean).
# A paired session does NOT survive `stop` + `start`, volume or not: simulator 0.9.5 keeps the SDK storage in memory only
# (seen 2026-11-23, README « Known limits »). After a restart pass `?pair=` again with a fresh code.
# Microphone (D5): `SIM_MIC=1 sim.sh start <url> [port]` runs the simulator with a virtual microphone: image localhost/er-sim:mic
# (podman build -t localhost/er-sim:mic -f tools/sim-container/Containerfile.mic tools/sim-container; the plain image stays as it is),
# a PulseAudio null sink inside the jail (no host sound, no root, no kernel module), the simulator started with `--aid alsa:pulse`.
# The app then gets 3,200-byte audio events every 100 ms; silence while nothing plays. `sim.sh speak <file.wav>` plays a WAV
# (16 kHz mono 16-bit, any other format is resampled) into that microphone at real speed, then returns. Only exactly SIM_MIC=1
# turns it on; without it every command below behaves as before. `speak` needs a running `SIM_MIC=1` start, else it fails (exit 1).
# API (skill simulator-automation): GET /api/ping · /api/screenshot/glasses (576x288 RGBA) · /api/screenshot/webview · /api/console · POST /api/input
set -eu
# The simulator binary comes from this folder's own packages: `cd tools && npm ci --ignore-scripts` (exact versions).
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/node_modules/@evenrealities/sim-linux-x64/bin"
[ -x "$BIN/evenhub-simulator" ] || [ "${1:-}" = stop ] || [ "${1:-}" = status ] || [ "${1:-}" = wipe ] || [ "${1:-}" = speak ] || { echo "no simulator binary: run 'npm ci --ignore-scripts' in $HERE" >&2; exit 1; }
PORT="${3:-9898}"
VOL="${SIM_VOLUME-er-sim-data}"
case "$VOL" in ''|[A-Za-z0-9]*) ;; *) echo "SIM_VOLUME must be a volume name" >&2; exit 2 ;; esac
case "$VOL" in *[!A-Za-z0-9_.-]*) echo "SIM_VOLUME must be a volume name" >&2; exit 2 ;; esac
MOUNT=""
[ -n "$VOL" ] && MOUNT="-v $VOL:/home/sim:U"
case "${1:-}" in
  start)
    url="${2:?usage: sim.sh start <url> [port]}"
    podman rm -f er-sim >/dev/null 2>&1 || true
    # shellcheck disable=SC2086 # MOUNT is empty or one checked `-v name:/home/sim:U` (:U = owned by the container's user)
    # D4 review, note 6: the port and the address go in as arguments ($1, $2), never as shell text (test/sim-sh.test.ts)
    # shellcheck disable=SC2016 # the single quotes are meant: $1 and $2 are expanded by the container's shell
    if [ "${SIM_MIC:-}" = 1 ]; then
      # shellcheck disable=SC2086,SC2016 # same as below; the sink `mic` is the default source's monitor, the ALSA `pulse` device is its door
      podman run -d --init --name er-sim --network=host $MOUNT -v "$BIN:/opt/sim:ro" localhost/er-sim:mic sh -c \
        'export XDG_RUNTIME_DIR=/tmp/rt; mkdir -p -m 700 "$XDG_RUNTIME_DIR"; pulseaudio -n --daemonize=yes --exit-idle-time=-1 -L module-native-protocol-unix -L "module-null-sink sink_name=mic rate=16000 channels=1" && pactl set-default-source mic.monitor; Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -nolisten unix & export DISPLAY=:99; for i in 1 2 3 4 5 6 7 8 9 10; do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.5; done; exec /opt/sim/evenhub-simulator --aid alsa:pulse --automation-port "$1" "$2"' \
        sh "$PORT" "$url" >/dev/null
    else
    podman run -d --init --name er-sim --network=host $MOUNT -v "$BIN:/opt/sim:ro" localhost/er-sim:bookworm sh -c \
      'Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -nolisten unix & export DISPLAY=:99; for i in 1 2 3 4 5 6 7 8 9 10; do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.5; done; exec /opt/sim/evenhub-simulator --automation-port "$1" "$2"' \
      sh "$PORT" "$url" >/dev/null
    fi
    curl -s -m 40 --retry 30 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$PORT/api/ping"; echo ;;
  speak)
    # the file's NAME never reaches the container (not as an argument, not as shell text): its bytes go in on stdin
    file="${2:?usage: sim.sh speak <file.wav>}"
    [ -f "$file" ] || { echo "no such file" >&2; exit 2; }
    # shellcheck disable=SC2016 # single quotes meant: the container's shell runs this
    podman exec -i -e XDG_RUNTIME_DIR=/tmp/rt er-sim sh -c 'cat > /tmp/speak.wav && paplay --device=mic /tmp/speak.wav; rc=$?; rm -f /tmp/speak.wav; exit $rc' < "$file" ;;
  stop) podman rm -f er-sim >/dev/null 2>&1 || true ;;
  status) podman ps -a --filter name=er-sim --format '{{.Status}}'; curl -s -m 3 "http://127.0.0.1:$PORT/api/ping" || true; echo ;;
  wipe) podman rm -f er-sim >/dev/null 2>&1 || true; [ -z "$VOL" ] || podman volume rm -f "$VOL" >/dev/null 2>&1 || true ;;
  *) echo "usage: [SIM_MIC=1] sim.sh start <url> [port] | speak <file.wav> | stop | status | wipe" >&2; exit 2 ;;
esac
