#!/usr/bin/env bash
# Pin-drift alarm for the Wayland WebUI engine (os.warriorhi.com).
#
# The desktop fails CLOSED when the wayland-core binary it resolves advertises a
# different desktop-contract minor than DESKTOP_CORE_V1_PIN in
# src/process/agent/wcore/desktopContractV1.ts. From the browser that looks like
# "the agent does nothing"; the only trace is a stderr line in pm2. This script
# performs the same handshake the desktop does and compares minor/generator.
#
# Exit 0 = in sync, 1 = drift or engine missing, 2 = script error.
# Alerts: appends to /home/forge/wayland/logs/core-pin.log; if
# /home/forge/wayland/alert.env defines SLACK_BOT_TOKEN and SLACK_CHANNEL, posts
# to Slack (chat.postMessage) once per distinct failure (state file dedupes).
set -uo pipefail
REPO=/home/forge/wayland-desktop
BIN="$REPO/resources/bundled-wayland-core/linux-x64/wayland-core"
PIN_FILE="$REPO/src/process/agent/wcore/desktopContractV1.ts"
LOG=/home/forge/wayland/logs/core-pin.log
STATE=/home/forge/wayland/logs/core-pin.state
ALERT_ENV=/home/forge/wayland/alert.env

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

alert() {
  local msg="$1"
  local key; key=$(printf '%s' "$msg" | sha256sum | cut -c1-16)
  if [ -f "$STATE" ] && grep -qx "$key" "$STATE"; then return; fi  # already alerted
  echo "$key" > "$STATE"
  if [ -f "$ALERT_ENV" ]; then
    # shellcheck disable=SC1090
    . "$ALERT_ENV"
    if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_CHANNEL:-}" ]; then
      curl -s -m 10 -X POST https://slack.com/api/chat.postMessage \
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H 'content-type: application/json' \
        -d "$(python3 -c 'import json,sys;print(json.dumps({"channel":sys.argv[1],"text":sys.argv[2]}))' "$SLACK_CHANNEL" "$msg")" >/dev/null || true
    fi
  fi
}

[ -x "$BIN" ] || { log "FAIL engine binary missing at $BIN"; alert ":rotating_light: os.warriorhi.com: wayland-core binary missing at $BIN"; exit 1; }
[ -r "$PIN_FILE" ] || { log "ERROR pin file missing"; exit 2; }

want_minor=$(grep -m1 -E '^\s*minor:\s*[0-9]+' "$PIN_FILE" | grep -oE '[0-9]+')
want_gen=$(grep -m1 -oE "generator: '[^']+'" "$PIN_FILE" | cut -d"'" -f2)

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
out=$(cd "$tmp" && timeout 20 "$BIN" --json-stream --no-tui --no-color </dev/null 2>/dev/null | head -c 20000 | tr -d '\000')
have_minor=$(printf '%s' "$out" | grep -oE '"minor":\s*[0-9]+' | head -1 | grep -oE '[0-9]+')
have_gen=$(printf '%s' "$out" | grep -oE '"generator":\s*"[^"]+"' | head -1 | cut -d'"' -f4)
ver=$("$BIN" --version 2>/dev/null | head -1)

if [ -z "$have_minor" ]; then
  log "FAIL handshake produced no contract (engine $ver)"; alert ":rotating_light: os.warriorhi.com: wayland-core handshake failed ($ver)"; exit 1
fi
if [ "$have_minor" != "$want_minor" ] || [ "$have_gen" != "$want_gen" ]; then
  msg="os.warriorhi.com: wayland-core PIN DRIFT. engine $ver advertises minor $have_minor/$have_gen, desktop pins minor $want_minor/$want_gen. Run: WCORE_VERSION=<pinned> node scripts/prepareWaylandCore.js && pm2 restart wayland-webui"
  log "FAIL $msg"; alert ":rotating_light: $msg"; exit 1
fi
log "OK engine $ver minor $have_minor $have_gen matches pin"
rm -f "$STATE"
exit 0
