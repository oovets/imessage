#!/usr/bin/env bash
# with-credentials.sh — run a command with the Telegram API credentials in its
# environment, read from ~/.tg (line 1: api_id, line 2: api_hash; `KEY=value`
# lines work too). Slack needs nothing here: the app imports
# ~/.slack_config.json on its own.
#
# Usage:
#   scripts/with-credentials.sh npm run tauri:dev
#   scripts/with-credentials.sh target/release/app
#
# TG_CREDENTIALS_FILE overrides the path.
set -euo pipefail

TG_FILE="${TG_CREDENTIALS_FILE:-$HOME/.tg}"

if [ -r "$TG_FILE" ]; then
  TG_API_ID="" TG_API_HASH=""
  { read -r TG_API_ID || true; read -r TG_API_HASH || true; } < "$TG_FILE"
  TG_API_ID="${TG_API_ID#*=}"
  TG_API_HASH="${TG_API_HASH#*=}"
  TG_API_ID="${TG_API_ID//[$'\r\t ']/}"
  TG_API_HASH="${TG_API_HASH//[$'\r\t ']/}"
  export TG_API_ID TG_API_HASH
else
  echo "with-credentials: $TG_FILE not readable, Telegram stays disabled" >&2
fi

exec "$@"
