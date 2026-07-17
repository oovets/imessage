#!/usr/bin/env bash
# reset-demo.sh — remove every trace of the Messages Desktop client (and,
# optionally, the BlueBubbles server) from this Mac, so the first-run installer
# starts from a truly clean slate.
#
# Deleting /Applications/Messages Desktop.app is not enough: the app also leaves
# data in the keychain, Application Support, Caches, WebView storage, Preferences
# and saved application state. This wipes all of it.
#
# Usage:
#   scripts/reset-demo.sh [--server] [--dry-run] [--yes]
#
#   --server    also remove the BlueBubbles server, its data and launch agents
#   --dry-run   print what it would delete without touching anything (implies --yes)
#   --yes       don't pause for confirmation
set -euo pipefail

# --- identifiers (must match the app) --------------------------------------
CLIENT_APP="/Applications/Messages Desktop.app"
CLIENT_BUNDLE="com.oovets.messages"          # tauri.conf.json identifier
TG_APP_ID="dev.stefan.TelegramGui"           # shared::AppConfig::APP_ID
LEGACY_KEYCHAIN="com.oovets.imessagereact"   # pre-rename iMessage keychain
BB_APP="/Applications/BlueBubbles.app"
BB_SUPPORT="$HOME/Library/Application Support/bluebubbles-server"
TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"

INCLUDE_SERVER="0"
ASSUME_YES="0"
DRY_RUN="0"

# --- pretty logging --------------------------------------------------------
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
would(){ printf '  \033[35m∅ would\033[0m %s\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --server)  INCLUDE_SERVER="1" ;;
    --yes|-y)  ASSUME_YES="1" ;;
    --dry-run) DRY_RUN="1"; ASSUME_YES="1" ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '\033[31m✗ unknown option: %s (try --help)\033[0m\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

# rm a path (file or dir); log it; honour --dry-run.
wipe() {
  local path="$1"
  if [ -e "$path" ] || ls "$path" >/dev/null 2>&1; then
    if [ "$DRY_RUN" = "1" ]; then would "delete $path"; else rm -rf "$path" && ok "deleted $path"; fi
  fi
}

# Delete every keychain generic-password item for a service (there may be more
# than one — legacy per-key items plus the consolidated blob).
wipe_keychain() {
  local svc="$1" n=0
  if [ "$DRY_RUN" = "1" ]; then
    if security find-generic-password -s "$svc" >/dev/null 2>&1; then would "remove keychain items for $svc"; fi
    return
  fi
  while security delete-generic-password -s "$svc" >/dev/null 2>&1; do n=$((n+1)); done
  [ "$n" -gt 0 ] && ok "removed $n keychain item(s) for $svc"
}

quit_app() { # quit by name, then force if needed
  local name="$1"
  [ "$DRY_RUN" = "1" ] && { would "quit $name"; return; }
  osascript -e "tell application \"$name\" to quit" >/dev/null 2>&1 || true
  pkill -f "$name" >/dev/null 2>&1 || true
}

# --- confirm ---------------------------------------------------------------
if [ "$ASSUME_YES" != "1" ]; then
  printf 'This removes the Messages Desktop client'
  [ "$INCLUDE_SERVER" = "1" ] && printf ' AND the BlueBubbles server'
  printf ' and all their data. Continue? [y/N] '
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
fi

# --- client ----------------------------------------------------------------
step "Removing the Messages Desktop client"
quit_app "Messages Desktop"
wipe "$CLIENT_APP"
wipe "$HOME/Library/Application Support/$CLIENT_BUNDLE"
wipe "$HOME/Library/Caches/$CLIENT_BUNDLE"
wipe "$HOME/Library/WebKit/$CLIENT_BUNDLE"
wipe "$HOME/Library/HTTPStorages/$CLIENT_BUNDLE"
wipe "$HOME/Library/HTTPStorages/$CLIENT_BUNDLE.binarycookies"
wipe "$HOME/Library/Preferences/$CLIENT_BUNDLE.plist"
wipe "$HOME/Library/Saved Application State/$CLIENT_BUNDLE.savedState"
wipe "$HOME/Library/LaunchAgents/$CLIENT_BUNDLE.plist"

step "Removing Telegram data + cache"
wipe "$HOME/Library/Application Support/$TG_APP_ID"
wipe "$HOME/Library/Caches/$TG_APP_ID"

step "Removing temp media"
wipe "$TMP/unified-inbox-media"
wipe "$TMP/unified-inbox-upload"

step "Clearing keychain entries"
wipe_keychain "$CLIENT_BUNDLE"
wipe_keychain "$LEGACY_KEYCHAIN"
wipe_keychain "$TG_APP_ID"

# --- server (optional) -----------------------------------------------------
if [ "$INCLUDE_SERVER" = "1" ]; then
  step "Removing the BlueBubbles server"
  quit_app "BlueBubbles"
  wipe "$BB_APP"
  wipe "$BB_SUPPORT"
  for p in "$HOME"/Library/Caches/com.bluebubbles.* "$HOME"/Library/Preferences/com.bluebubbles.*.plist "$HOME"/Library/LaunchAgents/*luebubbles*; do
    [ -e "$p" ] && wipe "$p"
  done
fi

step "Done"
[ "$DRY_RUN" = "1" ] && warn "dry run — nothing was actually deleted."
echo "Next launch of Messages Desktop will start from a clean first-run state."
