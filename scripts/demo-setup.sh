#!/usr/bin/env bash
# demo-setup.sh — one-command demo of Messages Desktop on this Mac.
#
# Installs and headless-configures a BlueBubbles server, then installs the
# Messages Desktop client and pre-fills its connection — so a reviewer can go
# from nothing to a working iMessage client in one command.
#
# Automated end to end:
#   • download + install BlueBubbles server (and, unless --no-client, the client)
#   • pre-seed the server config (password, port, headless, launch-at-login) via
#     its SQLite config.db — no GUI setup wizard
#   • start the server, verify the API responds and can read the Messages DB
#   • pre-fill the client's saved connection (macOS keychain)
#
# NOT automatable by any script on modern macOS — you're guided and we wait:
#   • Full Disk Access / Accessibility / Automation (TCC) — three toggles
#   • signing into iCloud + Messages (a hard prerequisite)
#
# Usage:
#   scripts/demo-setup.sh [--password PW] [--port N] [--login] [--headless]
#                         [--no-client] [--yes]
#
#   --password PW   server password (default: a generated one, printed at the end)
#   --port N        server port (default: 1234)
#   --login         start the BlueBubbles server at login
#   --headless      run the server without its dock icon / window
#   --no-client     set up only the server, skip the Messages Desktop client
#   --yes           don't pause for confirmation before installing
#   --uninstall     remove the apps + saved connection (add --purge to also
#                   delete the BlueBubbles data directory)
#   --dry-run       print what it would do without touching the system (implies --yes)
set -euo pipefail

# --- config ----------------------------------------------------------------
BB_REPO="BlueBubblesApp/bluebubbles-server"
CLIENT_REPO="oovets/imessage"
BB_SUPPORT="$HOME/Library/Application Support/bluebubbles-server"
BB_DB="$BB_SUPPORT/config.db"
KEYCHAIN_SERVICE="com.oovets.messages"
KEYCHAIN_ACCOUNT="secure-config"

PASSWORD=""
PORT="1234"
SET_LOGIN="0"
HEADLESS="0"
INSTALL_CLIENT="1"
ASSUME_YES="0"
UNINSTALL="0"
PURGE="0"
DRY_RUN="0"

# --- pretty logging --------------------------------------------------------
bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
would() { printf '  \033[35m∅ would\033[0m %s\n' "$1"; }

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '  %s [y/N] ' "$1"
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# --- args ------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --port)     PORT="${2:-}"; shift 2 ;;
    --login)    SET_LOGIN="1"; shift ;;
    --headless) HEADLESS="1"; shift ;;
    --no-client) INSTALL_CLIENT="0"; shift ;;
    --uninstall) UNINSTALL="1"; shift ;;
    --purge)    PURGE="1"; shift ;;
    --dry-run)  DRY_RUN="1"; ASSUME_YES="1"; shift ;;
    --yes|-y)   ASSUME_YES="1"; shift ;;
    -h|--help)  awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# --- uninstall -------------------------------------------------------------
uninstall() {
  step "Uninstalling the demo"
  osascript -e 'tell application "BlueBubbles" to quit' >/dev/null 2>&1 || pkill -x BlueBubbles 2>/dev/null || true
  osascript -e 'tell application "Messages Desktop" to quit' >/dev/null 2>&1 || pkill -f "Messages Desktop" 2>/dev/null || true
  sleep 1

  for app in "BlueBubbles.app" "Messages Desktop.app"; do
    if [ -d "/Applications/$app" ]; then
      rm -rf "/Applications/$app" && ok "Removed /Applications/$app"
    fi
  done

  if security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; then
    security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1 \
      && ok "Removed saved connection from keychain"
  fi

  if [ "$PURGE" = "1" ]; then
    rm -rf "$BB_SUPPORT" && ok "Deleted BlueBubbles data ($BB_SUPPORT)"
    rm -rf "$HOME/Library/Application Support/$KEYCHAIN_SERVICE" 2>/dev/null || true
  else
    warn "Kept BlueBubbles data at $BB_SUPPORT (re-run with --purge to delete it)."
  fi
  step "Uninstall complete"
}

if [ "$UNINSTALL" = "1" ]; then
  uninstall
  exit 0
fi

# --- preflight -------------------------------------------------------------
step "Checking prerequisites"
[ "$(uname -s)" = "Darwin" ] || die "this installer is macOS-only."
command -v sqlite3 >/dev/null || die "sqlite3 not found (ships with macOS — unexpected)."
command -v python3 >/dev/null || die "python3 not found."

case "$(uname -m)" in
  arm64)  ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
ok "macOS on $ARCH"

# Messages / iCloud must be set up — the server reads ~/Library/Messages/chat.db.
if [ ! -f "$HOME/Library/Messages/chat.db" ]; then
  warn "No Messages database found ($HOME/Library/Messages/chat.db)."
  warn "Sign into iCloud, open Messages, and send/receive at least one iMessage first."
  confirm "Continue anyway?" || die "Set up Messages, then re-run."
else
  ok "Messages database present"
fi

if [ -z "$PASSWORD" ]; then
  PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-16)"
  GENERATED_PW="1"
else
  GENERATED_PW="0"
fi

bold ""
bold "Plan:"
echo "  • BlueBubbles server  → /Applications  (port $PORT, headless=$HEADLESS, login=$SET_LOGIN)"
[ "$INSTALL_CLIENT" = "1" ] && echo "  • Messages Desktop    → /Applications, connection pre-filled"
[ "$DRY_RUN" = "1" ] && bold "  (dry run — nothing will be downloaded, installed, or changed)"
confirm "Proceed?" || die "Aborted."

# --- download + install helpers -------------------------------------------
# Resolve a release asset download URL by (repo, substring match on asset name).
asset_url() {
  local repo="$1" pattern="$2"
  curl -fsSL "https://api.github.com/repos/$repo/releases/latest" \
    | python3 -c "
import json,sys,re
pat=re.compile(sys.argv[1])
d=json.load(sys.stdin)
for a in d.get('assets',[]):
    if pat.search(a['name']):
        print(a['browser_download_url']); break
" "$pattern"
}

install_dmg() {
  # install_dmg <dmg-url> <App Name.app>  → copies the .app into /Applications
  local url="$1" appname="$2" dmg mnt
  step "Downloading $appname"
  if [ "$DRY_RUN" = "1" ]; then
    would "download $url"
    would "install into /Applications/$appname (dequarantined)"
    return 0
  fi
  dmg="$(mktemp -t bbdemo).dmg"
  curl -fL --progress-bar "$url" -o "$dmg" || die "download failed: $url"
  mnt="$(mktemp -d)"
  hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg" || die "could not mount $dmg"
  local src="$mnt/$appname"
  [ -d "$src" ] || src="$(/usr/bin/find "$mnt" -maxdepth 1 -name '*.app' | head -1)"
  [ -d "$src" ] || { hdiutil detach -quiet "$mnt"; die "no .app inside $appname dmg"; }
  rm -rf "/Applications/$appname"
  cp -R "$src" "/Applications/$appname"
  hdiutil detach -quiet "$mnt" || true
  rm -f "$dmg"
  # Clear the quarantine flag so unsigned/self-signed builds launch without the
  # "app is damaged" Gatekeeper block.
  xattr -dr com.apple.quarantine "/Applications/$appname" 2>/dev/null || true
  ok "Installed /Applications/$appname"
}

# --- server config seeding -------------------------------------------------
seed_config() {
  # seed_config <name> <value> — upsert into BlueBubbles' config.db
  if [ "$DRY_RUN" = "1" ]; then
    local shown="$2"; [ "$1" = "password" ] && shown="********"
    would "set config $1 = $shown"; return 0
  fi
  sqlite3 "$BB_DB" \
    "INSERT INTO config(name,value) VALUES('$1','$2')
     ON CONFLICT(name) DO UPDATE SET value=excluded.value;"
}

# --- 1) BlueBubbles server -------------------------------------------------
BB_URL="$(asset_url "$BB_REPO" "$( [ "$ARCH" = arm64 ] && echo 'arm64\.dmg$' || echo '^BlueBubbles-[0-9.]+\.dmg$' )" || true)"
[ -n "$BB_URL" ] || die "could not find a BlueBubbles $ARCH release asset."
install_dmg "$BB_URL" "BlueBubbles.app"

# First launch creates config.db (typeorm migrations); then quit so we can seed.
step "Initializing BlueBubbles config"
if [ "$DRY_RUN" = "1" ]; then
  would "launch BlueBubbles once to create config.db, then quit"
else
  open -a "BlueBubbles" || die "could not launch BlueBubbles"
  for _ in $(seq 1 60); do [ -f "$BB_DB" ] && break; sleep 1; done
  [ -f "$BB_DB" ] || die "BlueBubbles did not create its config database in time."
  sleep 2
  osascript -e 'tell application "BlueBubbles" to quit' >/dev/null 2>&1 || pkill -x BlueBubbles || true
  sleep 2
  ok "config.db ready"
fi

step "Writing headless server configuration"
seed_config password "$PASSWORD"
seed_config socket_port "$PORT"
seed_config tutorial_is_done "1"
seed_config check_for_updates "0"
seed_config proxy_service "lan-url"   # localhost/LAN only — no Cloudflare tunnel
seed_config disable_gpu "1"           # CPU rendering — GPU accel is flaky in VMs
seed_config auto_caffeinate "1"
seed_config start_minimized "1"
seed_config auto_start "$SET_LOGIN"
seed_config headless "$HEADLESS"
[ "$HEADLESS" = "1" ] && seed_config hide_dock_icon "1"
ok "Server configured (port $PORT)"

# --- 2) macOS permissions (the part no script can grant) -------------------
step "Grant BlueBubbles the required macOS permissions"
cat <<'EOF'
  macOS requires you to grant these by hand (System Settings → Privacy & Security):
    1. Full Disk Access     → enable "BlueBubbles"   (to read the Messages database)
    2. Accessibility        → enable "BlueBubbles"   (to send messages)
    3. Automation           → allow BlueBubbles to control "Messages" & "System Events"
EOF
if [ "$DRY_RUN" = "1" ]; then
  would "open the Full Disk Access / Accessibility / Automation panes and wait for you to grant them"
else
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
  confirm "Done granting Full Disk Access?" || warn "You can grant it later; the API won't read history until you do."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation" 2>/dev/null || true
  confirm "Done granting Accessibility & Automation?" || warn "Sending messages will fail until these are granted."
fi

# --- 3) start server + verify ---------------------------------------------
step "Starting BlueBubbles server"
api="http://localhost:$PORT/api/v1"
if [ "$DRY_RUN" = "1" ]; then
  would "start BlueBubbles and poll $api/server/info until the API responds"
  would "check $api/message/count to confirm Full Disk Access works"
else
  open -a "BlueBubbles" || die "could not launch BlueBubbles"
  printf '  waiting for the API'
  reachable="0"
  for _ in $(seq 1 40); do
    if curl -fsS "$api/server/info?password=$PASSWORD" >/dev/null 2>&1; then reachable="1"; break; fi
    printf '.'; sleep 1
  done
  printf '\n'
  [ "$reachable" = "1" ] && ok "API is up on port $PORT" || warn "API not reachable yet — check the server window / permissions."

  # Confirms Full Disk Access actually works (can read the Messages DB).
  if [ "$reachable" = "1" ]; then
    if curl -fsS "$api/message/count?password=$PASSWORD" >/dev/null 2>&1; then
      ok "Server can read the Messages database (Full Disk Access OK)"
    else
      warn "API up but can't read messages yet — re-check Full Disk Access for BlueBubbles."
    fi
  fi
fi

SERVER_URL="http://$(ipconfig getifaddr en0 2>/dev/null || echo localhost):$PORT"

# --- 4) Messages Desktop client -------------------------------------------
if [ "$INSTALL_CLIENT" = "1" ]; then
  CLIENT_URL="$(asset_url "$CLIENT_REPO" '_aarch64\.dmg$|_x64\.dmg$' || true)"
  if [ -z "$CLIENT_URL" ]; then
    warn "No Messages Desktop release asset found — skipping client install."
  else
    install_dmg "$CLIENT_URL" "Messages Desktop.app"
    step "Pre-filling the client's saved connection"
    if [ "$DRY_RUN" = "1" ]; then
      would "save the http://localhost:$PORT connection to the keychain ($KEYCHAIN_SERVICE)"
      would "launch Messages Desktop"
    else
      # Client and server run on the same Mac in this demo, so localhost is the
      # most reliable target (no network-interface guessing).
      CONN_JSON="$(python3 -c "import json,sys;print(json.dumps({'serverUrl':sys.argv[1],'password':sys.argv[2]}))" "http://localhost:$PORT" "$PASSWORD")"
      security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w "$CONN_JSON" 2>/dev/null \
        && ok "Connection saved to keychain" \
        || warn "Could not pre-seed keychain — enter the URL/password on first run instead."
      warn "The client is unsigned: on first keychain read macOS may ask once — click \"Always Allow\"."
      open -a "Messages Desktop" 2>/dev/null || true
    fi
  fi
fi

# --- summary ---------------------------------------------------------------
step "Done"
bold "BlueBubbles server"
echo "  local URL : http://localhost:$PORT"
echo "  LAN URL   : $SERVER_URL"
echo "  password  : $PASSWORD $( [ "$GENERATED_PW" = 1 ] && echo '(generated)')"
[ "$INSTALL_CLIENT" = "1" ] && { bold "Messages Desktop"; echo "  launched with the connection above pre-filled."; }
echo ""
echo "If sending or history doesn't work, re-open System Settings → Privacy & Security"
echo "and confirm BlueBubbles has Full Disk Access, Accessibility, and Automation."
