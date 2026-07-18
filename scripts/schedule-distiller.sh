#!/usr/bin/env bash
# schedule-distiller.sh — run the Style Distiller nightly (Personality Engine §19).
#
# Profiles must be rebuilt in batches, never per message: incremental updates
# make the personality drift and wobble. A nightly job keeps them fresh while
# the app only ever reads the result.
#
# Uses launchd (the macOS way — survives reboots, and unlike cron it catches up
# after the Mac was asleep at the scheduled time).
#
# Usage:
#   scripts/schedule-distiller.sh [--hour 4] [--uninstall] [--status]
set -uo pipefail

LABEL="com.oovets.messages.distiller"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Application Support/com.oovets.messages/ai"
HOUR=4

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hour) HOUR="${2:-4}"; shift 2 ;;
    --uninstall)
      step "Removing the nightly distiller"
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
      rm -f "$PLIST" && ok "removed $PLIST"
      exit 0 ;;
    --status)
      step "Status"
      launchctl list 2>/dev/null | grep -q "$LABEL" && ok "loaded in launchd" || warn "not loaded"
      [ -f "$LOG_DIR/distiller.log" ] && tail -5 "$LOG_DIR/distiller.log" || warn "no log yet"
      exit 0 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

command -v node >/dev/null || { echo "node not found in PATH"; exit 1; }
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

step "Installing nightly distillation at ${HOUR}:15"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$REPO/scripts/style-distiller.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>15</integer></dict>
  <!-- Run once after waking if the Mac was asleep at the scheduled time. -->
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG_DIR/distiller.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/distiller.log</string>
  <key>WorkingDirectory</key><string>$REPO</string>
</dict>
</plist>
EOF
ok "wrote $PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  ok "loaded into launchd"
else
  warn "could not load — run: launchctl bootstrap gui/$(id -u) $PLIST"
fi

step "Done"
echo "  Profiles rebuild nightly at ${HOUR}:15; the app picks them up within 5 minutes."
echo "  Log:       $LOG_DIR/distiller.log"
echo "  Status:    scripts/schedule-distiller.sh --status"
echo "  Remove:    scripts/schedule-distiller.sh --uninstall"
echo
echo "  Note: the distiller reads the BlueBubbles password from the server's own"
echo "  config.db, so it needs that server present on this machine."
