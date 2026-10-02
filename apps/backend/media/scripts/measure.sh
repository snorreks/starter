#!/usr/bin/env bash
# apps/backend/media/scripts/measure.sh
#
# Measures the container image and asserts the numbers in README.md. It exits
# non-zero when one does not match, which is the point: a README whose table has
# drifted away from the image is documentation that lies, and this is what makes
# it lie loudly.
#
# It needs a Docker-compatible engine on PATH. If there is none it says so and
# exits non-zero — it does not fall back to measuring nothing and printing zeros.
#
# Usage: scripts/measure.sh [--no-build]
set -euo pipefail

cd "$(dirname "$0")/.."
IMAGE="starter-media:measure"
# A free port in this checkout's range, found by binding one and releasing it.
# A hard-coded port makes a second concurrent run (or a developer's own container)
# fail with "address already in use", which reads like a broken image.
if [ -n "${MEDIA_MEASURE_PORT:-}" ]; then
  PORT="$MEDIA_MEASURE_PORT"
else
  PORT=$(python3 - <<'PY'
import socket
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    print(probe.getsockname()[1])
PY
)
fi
BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

failures=0

note() { printf '%s\n' "$*"; }
check() { # label expected actual [tolerance]
  local label="$1" expected="$2" actual="$3" tolerance="${4:-0}"
  if [ "$tolerance" = "0" ]; then
    if [ "$expected" = "$actual" ]; then
      note "  ok    $label: $actual"
    else
      note "  DRIFT $label: expected $expected, measured $actual"
      failures=$((failures + 1))
    fi
  else
    if [ "$((actual - expected))" -ge "-$tolerance" ] && [ "$((actual - expected))" -le "$tolerance" ]; then
      note "  ok    $label: $actual (expected ~$expected ±$tolerance)"
    else
      note "  DRIFT $label: expected ~$expected ±$tolerance, measured $actual"
      failures=$((failures + 1))
    fi
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  note "measure: no docker-compatible engine on PATH."
  note "measure: this lane needs one (Docker, or Podman aliased as docker)."
  note "measure: nothing was measured, so nothing is reported."
  exit 4
fi

# A previous run that was interrupted leaves its containers behind, and the next
# run then fails on a name collision instead of on a real measurement.
docker rm -f measure-serve measure-cold >/dev/null 2>&1 || true

if [ "$BUILD" = "1" ]; then
  note "== building the image =="
  docker build -t "$IMAGE" . >/dev/null
fi

note "== sizes =="
image_bytes=$(docker image inspect "$IMAGE" --format '{{.Size}}')
binary_bytes=$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'stat -c %s /usr/local/bin/starter-media')
ffmpeg_bytes=$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'stat -c %s /usr/bin/ffmpeg')
# The numbers in README.md, measured on 2026-10-03. Sizes move when a base image
# or an FFmpeg package version moves; that is a change to record deliberately,
# not a failure to silence, so a mismatch is reported as DRIFT.
check "image bytes" 546177873 "$image_bytes" 8000000
check "binary bytes" 790688 "$binary_bytes" 200000
check "ffmpeg bytes" 293288 "$ffmpeg_bytes" 200000

note "== the binary is the real program, not a stub =="
version=$(docker run --rm "$IMAGE" --version 2>&1)
case "$version" in
  *+*) note "  ok    --version reported: $version" ;;
  *) note "  DRIFT --version printed nothing; the image may contain a stub binary"; failures=$((failures + 1)) ;;
esac
docker run --rm "$IMAGE" bogus >/dev/null 2>&1 && {
  note "  DRIFT an unknown command exited 0; usage errors must not look like success"
  failures=$((failures + 1))
} || note "  ok    an unknown command exits non-zero"

note "== cold start: docker run -> first 200 on /health =="
cold_total=0
cold_runs=0
cold_max=0
for _ in 1 2 3 4 5; do
  docker rm -f measure-cold >/dev/null 2>&1 || true
  start=$(date +%s%N)
  docker run -d --name measure-cold -p "$PORT:8080" "$IMAGE" >/dev/null
  for _ in $(seq 1 400); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)" = "200" ] && break
    sleep 0.02
  done
  finish=$(date +%s%N)
  ms=$(( (finish - start) / 1000000 ))
  cold_total=$((cold_total + ms))
  cold_runs=$((cold_runs + 1))
  [ "$ms" -gt "$cold_max" ] && cold_max=$ms
  note "  run: ${ms} ms"
  docker rm -f measure-cold >/dev/null 2>&1 || true
done
note "  mean: $((cold_total / cold_runs)) ms, max: ${cold_max} ms"

note "== health =="
docker run -d --name measure-serve -p "$PORT:8080" "$IMAGE" >/dev/null
for _ in $(seq 1 400); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)" = "200" ] && break
  sleep 0.02
done
health_code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")
check "GET /health" 200 "$health_code"

note "== fixture encode =="
scratch=$(mktemp -d)
encode_ms=0
output_bytes=0
for attempt in 1 2 3; do
  start=$(date +%s%N)
  code=$(curl -s -o "$scratch/out.mp4" -w '%{http_code}' \
    -X POST --data-binary @fixtures/media/sample-v1.mp4 \
    -H 'x-protocol: sample-v1' -H 'x-preset: demo-180p-v1' \
    -H "x-attempt-id: measure-$attempt" "http://127.0.0.1:$PORT/encode")
  finish=$(date +%s%N)
  ms=$(( (finish - start) / 1000000 ))
  check "POST /encode attempt $attempt" 200 "$code"
  encode_ms=$((ms > encode_ms ? ms : encode_ms))
  output_bytes=$(stat -c%s "$scratch/out.mp4")
  note "  wall: ${ms} ms, output: ${output_bytes} bytes"
done
check "output bytes (README)" 112717 "$output_bytes" 2000

note "== peak memory, fixture encode =="
docker exec measure-serve sh -c 'echo 0 > /sys/fs/cgroup/memory.peak' 2>/dev/null || true
curl -s -o /dev/null -X POST --data-binary @fixtures/media/sample-v1.mp4 \
  -H 'x-preset: demo-180p-v1' -H 'x-attempt-id: measure-peak' "http://127.0.0.1:$PORT/encode"
peak=$(docker exec measure-serve cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)
note "  cgroup memory.peak: ${peak} bytes ($((peak / 1000000)) MB)"
note "  README records 61-62 MB; a large drift here is a reason to revisit the profile"

note "== negative controls against the running image =="
head -c 6000000 /dev/zero > "$scratch/oversize.bin"
oversize=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @"$scratch/oversize.bin" \
  -H 'x-preset: demo-180p-v1' -H 'x-attempt-id: measure-oversize' "http://127.0.0.1:$PORT/encode")
check "oversized input" 400 "$oversize"
printf 'this is not media' > "$scratch/invalid.bin"
invalid=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @"$scratch/invalid.bin" \
  -H 'x-preset: demo-180p-v1' -H 'x-attempt-id: measure-invalid' "http://127.0.0.1:$PORT/encode")
check "undecodable input" 400 "$invalid"
no_preset=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @fixtures/media/sample-v1.mp4 \
  -H 'x-attempt-id: measure-nopreset' "http://127.0.0.1:$PORT/encode")
check "missing preset header" 400 "$no_preset"
missing_route=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/nope")
check "unknown route" 404 "$missing_route"
body=$(curl -s -X POST --data-binary @fixtures/media/sample-v1.mp4 \
  -H 'x-preset: demo-180p-v1' -H 'x-attempt-id: measure-bad-proto' \
  -H 'x-protocol: sample-v2' "http://127.0.0.1:$PORT/encode")
case "$body" in
  *protocol_mismatch*) note "  ok    a wrong protocol is refused: $body" ;;
  *) note "  DRIFT expected protocol_mismatch, got: $body"; failures=$((failures + 1)) ;;
esac
case "$body" in
  *ffmpeg*|*tmp*) note "  DRIFT the error body leaked tool output or a path: $body"; failures=$((failures + 1)) ;;
  *) note "  ok    the error body carries no subprocess output or path" ;;
esac

note "== no temp files survive the refusals =="
leftovers=$(docker exec measure-serve sh -c 'ls -1 /var/tmp/media | wc -l')
check "temp entries after 4 refusals" 0 "$leftovers"

note "== the container stops on SIGTERM =="
docker stop -t 20 measure-serve >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' measure-serve)
check "exit status after SIGTERM" 0 "$exit_code"
docker logs measure-serve 2>&1 | tail -2 | sed 's/^/  log: /'
docker rm -f measure-serve >/dev/null 2>&1 || true
rm -rf "$scratch"

note ""
if [ "$failures" -eq 0 ]; then
  note "measure: every assertion matched the README's table."
  exit 0
fi
note "measure: ${failures} assertion(s) drifted from the README's table. Update README.md deliberately."
exit 1