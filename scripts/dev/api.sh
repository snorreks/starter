#!/usr/bin/env bash
# Run the API locally, capturing the Worker's log stream to a file.
#
# This is the half of local log capture that a browser cannot do for itself. The
# client's structured events are forwarded to `/api/telemetry`; the Worker logs
# them to its own stream; that stream is stdout here; and `bun run logs
# --mode local` reads the resulting file.
#
# Browser events are therefore **not** in `client.ndjson`. They appear in
# `api.ndjson`, because they were the Worker's to record. The log CLI reports
# which file an app's events come from rather than implying the browser wrote
# them itself.
#
# Uses a PID file rather than `pkill -f`, because a pattern broad enough to match
# this server also matches the shell that launched it — which kills the caller.
set -uo pipefail

# Resolve the repository root from this script's own location, before any cd, so
# the result does not depend on the caller's working directory. Playwright starts
# this with `cwd` set to the repo root; running it by hand from `apps/e2e` must
# work identically.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
API_DIR="$REPO_ROOT/apps/backend/api"

cd "$REPO_ROOT"

LOG_DIR="${STARTER_LOG_DIR:-/tmp/starter-logs}"
LOG_FILE="$LOG_DIR/api.ndjson"
PIDFILE="${TMPDIR:-/tmp}/starter-api-dev.pid"

PORT="${API_PORT:-8787}"

mkdir -p "$LOG_DIR"

if [ -f "$PIDFILE" ]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    kill -TERM "$old" 2>/dev/null || true
    sleep 1
    kill -KILL "$old" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

: > "$LOG_FILE"

# Wrangler's human-readable banners are interleaved with the log JSON, so the
# stream is recorded as-is and the reader skips non-JSON lines. Filtering at
# write time would lose the tail line of a partially-flushed event.
exec > >(tee -a "$LOG_FILE") 2>&1

echo "API log -> $LOG_FILE"
echo "  bun run logs api --mode local --follow"

# `--var NAME:value` rather than an exported environment variable: `wrangler dev`
# only passes a value through to the Worker if it is given as a var, and the
# Worker reads its configuration from its bindings. An exported shell variable is
# visible to the wrangler process and invisible to the code it serves.
#
# Each is passed only when set, so an ordinary `bun run dev:api` does not carry a
# stale run id or a test-only rate limit from a previous run.
WRANGLER_VARS=()
for name in TEST_RUN_ID AUTH_RATE_LIMIT_MAX TRUSTED_ORIGINS; do
  if [ -n "${!name:-}" ]; then
    WRANGLER_VARS+=(--var "${name}:${!name}")
    echo "${name}: ${!name}"
  fi
done

setsid bunx wrangler dev --port "$PORT" --local --config "$API_DIR/wrangler.jsonc" \
  ${WRANGLER_VARS[@]+"${WRANGLER_VARS[@]}"} &
echo $! > "$PIDFILE"

wait
