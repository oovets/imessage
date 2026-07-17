#!/usr/bin/env bash
# RSS snapshot for the Messages Desktop app and its WKWebView renderer.
#
# The WebView content lives in a separate `com.apple.WebKit.WebContent`
# process, which is system-launched and shared by naming with other WKWebView
# apps (including Safari). This script matches the renderer by the attributed
# bundle id in its argv when possible, and otherwise lists every WebContent
# process so you can identify yours with the before/after method:
#
#   scripts/mem-snapshot.sh before   # <-- run BEFORE launching the app
#   # ...launch `npm run tauri:dev`...
#   scripts/mem-snapshot.sh after    # <-- the NEW WebContent pid is yours
#
# Usage: scripts/mem-snapshot.sh [label]
set -euo pipefail

BUNDLE_ID="com.oovets.messages"
APP_NAME="Messages Desktop"
LABEL="${1:-snapshot}"

rss_kb() { ps -o rss= -p "$1" 2>/dev/null | tr -d ' '; }
mb() { awk "BEGIN{printf \"%.1f\", ${1:-0}/1024}"; }

echo "== ${LABEL} =="

MAIN_PID=$(pgrep -f "${APP_NAME}" | head -n1 || true)
if [[ -n "${MAIN_PID:-}" ]]; then
  echo "Rust/main   pid=${MAIN_PID}  RSS=$(mb "$(rss_kb "${MAIN_PID}")") MB"
else
  echo "Rust/main   (not running)"
fi

# Try to match the renderer by attributed bundle id; fall back to listing all.
MATCHED=$(ps -Ao pid=,rss=,args= | grep -i "WebKit.WebContent" | grep -i "${BUNDLE_ID}" || true)
if [[ -n "${MATCHED}" ]]; then
  echo "WebContent (matched ${BUNDLE_ID}):"
  echo "${MATCHED}" | awk '{printf "  pid=%s  RSS=%.1f MB\n", $1, $2/1024}'
else
  echo "WebContent (could not auto-match — all renderers, use before/after diff):"
  ps -Ao pid=,rss= -c -o comm= | grep -i "WebContent" \
    | awk '{printf "  pid=%s  RSS=%.1f MB  %s\n", $1, $2/1024, $3}'
fi
