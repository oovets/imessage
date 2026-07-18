#!/usr/bin/env bash
# bb-doctor.sh — diagnose why the BlueBubbles server isn't reachable.
#
# The in-app installer configures BlueBubbles headless; if a hidden first launch
# stalls on a setup step, the HTTP server never binds and onboarding just says
# "server not reachable". This makes the server visible, restarts it, and reports
# whether it's actually listening — plus the relevant config and recent log lines.
#
# Usage:
#   scripts/bb-doctor.sh [--port N] [--keep-hidden]
#
#   --port N        server port to probe (default: read from config, else 1234)
#   --keep-hidden   don't clear the headless/hidden flags before relaunching
set -euo pipefail

BB_APP="/Applications/BlueBubbles.app"
BB_SUPPORT="$HOME/Library/Application Support/bluebubbles-server"
BB_DB="$BB_SUPPORT/config.db"

PORT=""
KEEP_HIDDEN="0"

# --- pretty logging --------------------------------------------------------
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --keep-hidden) KEEP_HIDDEN="1"; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

cfg() { # cfg <name> — print a config value, empty if missing
  [ -f "$BB_DB" ] || return 0
  sqlite3 "$BB_DB" "SELECT value FROM config WHERE name='$1' LIMIT 1;" 2>/dev/null || true
}

# --- preconditions ---------------------------------------------------------
step "Checking the install"
[ -d "$BB_APP" ] || die "BlueBubbles is not installed at $BB_APP — run onboarding or demo-setup.sh first."
ok "Found $BB_APP"
if [ -f "$BB_DB" ]; then
  ok "Config database present"
else
  warn "No config.db yet ($BB_DB) — server has never completed first launch."
fi

[ -n "$PORT" ] || PORT="$(cfg socket_port)"
[ -n "$PORT" ] || PORT="1234"
info "Using port $PORT"

# --- make it visible + restart --------------------------------------------
step "Restarting BlueBubbles (visible)"
osascript -e 'tell application "BlueBubbles" to quit' >/dev/null 2>&1 || pkill -x BlueBubbles 2>/dev/null || true
sleep 2
if [ "$KEEP_HIDDEN" != "1" ] && [ -f "$BB_DB" ]; then
  sqlite3 "$BB_DB" \
    "UPDATE config SET value='0' WHERE name IN ('hide_dock_icon','start_minimized','headless');" \
    2>/dev/null && ok "Cleared headless/hidden flags"
fi
open -a BlueBubbles || die "could not launch BlueBubbles"
ok "Launched — if a setup window appears, complete it, then re-run this script"

# --- wait for the port to listen ------------------------------------------
step "Waiting for the server to listen on :$PORT (up to 30s)"
listening="0"
for _ in $(seq 1 30); do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then listening="1"; break; fi
  sleep 1
done

if [ "$listening" = "1" ]; then
  ok "Something is LISTENING on :$PORT"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/    /'
else
  warn "Nothing is listening on :$PORT"
fi

# --- probe the API ---------------------------------------------------------
step "Probing the API"
PW="$(cfg password)"
if [ -z "$PW" ]; then
  warn "No password in config — the server hasn't been configured yet."
else
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://localhost:$PORT/api/v1/server/info?password=$PW" 2>/dev/null || echo 000)"
  case "$code" in
    200) ok "API responded 200 — the server is up and the password matches." ;;
    000) warn "No HTTP response (connection refused) — the server isn't serving on :$PORT." ;;
    401|403) warn "API responded $code — server is up but the password is wrong (stale config)." ;;
    *)   warn "API responded HTTP $code." ;;
  esac
fi

# --- context ---------------------------------------------------------------
step "Server process"
pgrep -xl BlueBubbles | sed 's/^/    /' || warn "BlueBubbles process not running."

step "Relevant config"
for k in socket_port headless start_minimized hide_dock_icon tutorial_is_done auto_start; do
  printf '    %-18s %s\n' "$k" "$(cfg "$k")"
done

step "Recent server log"
logdir="$BB_SUPPORT/logs"
if [ -d "$logdir" ]; then
  latest="$(ls -t "$logdir"/*.log 2>/dev/null | head -1 || true)"
  if [ -n "$latest" ]; then
    info "$latest"
    tail -30 "$latest" | sed 's/^/    /'
  else
    warn "No .log files in $logdir"
  fi
else
  warn "No logs directory at $logdir"
fi

step "Done"
if [ "$listening" = "1" ]; then
  echo "Server is listening — point the client at http://localhost:$PORT with the config password."
else
  echo "Server is NOT listening. Check the BlueBubbles window for a setup step or error,"
  echo "complete it, then re-run this script."
fi
