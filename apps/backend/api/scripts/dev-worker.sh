#!/usr/bin/env bash
# Local dev helper for driving the Workers runtime by hand.
#
# Uses PID files rather than `pkill -f`, because a pattern broad enough to match
# the dev server also matches the shell that launched it — which kills the
# caller instead of the server.
set -uo pipefail

cd "$(dirname "$0")/.."

# The pinned workspace copy, not `bunx`: `bunx wrangler` from here or from the
# repository root falls through to the network and runs whatever npm serves.
WRANGLER="$PWD/node_modules/.bin/wrangler"
if [ ! -x "$WRANGLER" ]; then
  echo "wrangler is not installed at $WRANGLER. Run 'bun install' from the repository root." >&2
  exit 1
fi

PIDFILE="${TMPDIR:-/tmp}/starter-wrangler.pid"
LOGFILE="${TMPDIR:-/tmp}/starter-wrangler.log"
PORT="${PORT:-8817}"

stop() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
}

start() {
  stop
  setsid "$WRANGLER" dev --port "$PORT" --local --config wrangler.jsonc \
    --var "DEPLOYMENT_ENV:${DEPLOYMENT_ENV:-local}" \
    --var "AUTH_RATE_LIMIT_MAX:${AUTH_RATE_LIMIT_MAX:-500}" \
    --var "BETTER_AUTH_SECRET:${BETTER_AUTH_SECRET:-local-dev-secret-not-for-production}" \
    > "$LOGFILE" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"

  for _ in $(seq 1 40); do
    sleep 1
    if curl -s --max-time 2 "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1; then
      echo "ready on ${PORT} (pid $(cat "$PIDFILE"), log ${LOGFILE})"
      return 0
    fi
  done
  echo "did not become ready; see ${LOGFILE}" >&2
  return 1
}

case "${1:-}" in
  start) start ;;
  stop) stop; echo "stopped" ;;
  restart) start ;;
  log) tail -n "${2:-40}" "$LOGFILE" ;;
  *) echo "usage: $0 {start|stop|restart|log [n]}" >&2; exit 2 ;;
esac
