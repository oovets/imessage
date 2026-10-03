#!/usr/bin/env bash
# install-linux-service.sh — build Messages Desktop and install it for the
# desktop: an app-launcher entry (Walker, rofi, GNOME…), and optionally a
# systemd user service that starts it with the graphical session.
#
# Usage:
#   scripts/install-linux-service.sh              build, install launcher entry
#   scripts/install-linux-service.sh --autostart  …and start it at login
#   scripts/install-linux-service.sh --no-build   install the existing build
#   scripts/install-linux-service.sh --uninstall
#
# Telegram credentials come from ~/.tg and Slack workspaces from
# ~/.slack_config.json at every start (see with-credentials.sh). The app is
# single-instance: launching it again focuses the running window.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="messages-desktop.service"
DESKTOP_FILE="$DATA_DIR/applications/messages-desktop.desktop"

BUILD=1
AUTOSTART=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --autostart) AUTOSTART=1 ;;
    --uninstall)
      systemctl --user disable --now "$UNIT" 2>/dev/null || true
      rm -f "$UNIT_DIR/$UNIT" "$BIN_DIR/messages-desktop" "$BIN_DIR/messages-desktop-launch" \
        "$DESKTOP_FILE" "$DATA_DIR"/icons/hicolor/*/apps/messages-desktop.png
      systemctl --user daemon-reload
      echo "Uninstalled Messages Desktop."
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$BUILD" = 1 ]; then
  (cd "$REPO" && npx tauri build --no-bundle)
fi

# Installed copies, so a rebuild in the repo never swaps the binary out from
# under a running app; rerun this script to pick up a new build.
install -Dm755 "$REPO/target/release/app" "$BIN_DIR/messages-desktop"
install -Dm755 "$REPO/scripts/with-credentials.sh" "$BIN_DIR/messages-desktop-launch"
install -Dm644 "$REPO/src-tauri/icons/128x128.png" "$DATA_DIR/icons/hicolor/128x128/apps/messages-desktop.png"
install -Dm644 "$REPO/src-tauri/icons/128x128@2x.png" "$DATA_DIR/icons/hicolor/256x256/apps/messages-desktop.png"

mkdir -p "$(dirname "$DESKTOP_FILE")"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Messages Desktop
GenericName=Messaging
Comment=iMessage, Telegram and Slack in one inbox
Exec=$BIN_DIR/messages-desktop-launch $BIN_DIR/messages-desktop
Icon=messages-desktop
Terminal=false
Categories=Network;InstantMessaging;Chat;
Keywords=imessage;telegram;slack;chat;sms;
StartupWMClass=messages-desktop
EOF
update-desktop-database "$(dirname "$DESKTOP_FILE")" 2>/dev/null || true

if [ "$AUTOSTART" = 1 ]; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$UNIT" <<'EOF'
[Unit]
Description=Messages Desktop (iMessage, Telegram, Slack)
PartOf=graphical-session.target
After=graphical-session.target
Requisite=graphical-session.target

[Service]
ExecStart=%h/.local/bin/messages-desktop-launch %h/.local/bin/messages-desktop
# Quitting from the tray exits cleanly and stays quit; crashes come back.
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT"
  systemctl --user restart "$UNIT"
  echo "Installed; starts at login ($UNIT) and from the app launcher."
else
  # Launcher only: drop a service left by an earlier --autostart install.
  if [ -f "$UNIT_DIR/$UNIT" ]; then
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_DIR/$UNIT"
    systemctl --user daemon-reload
  fi
  echo "Installed; start it from the app launcher (\"Messages Desktop\")."
fi
