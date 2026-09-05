#!/usr/bin/env bash
# One-shot deploy for the Wayland WebUI at https://os.warriorhi.com.
#
#   scripts/deploy-webui.sh            # build current checkout + restart
#   scripts/deploy-webui.sh --pull     # also fetch upstream + rebase local patches first
#   scripts/deploy-webui.sh --no-restart
#
# Steps: (1) pinned wayland-core into resources/bundled-wayland-core (the desktop
# fails closed on a contract-minor mismatch, so this is NOT optional after an
# upstream bump), (2) constitution-fs helper, (3) renderer + server + stdio MCP
# bundles via build:webui, (4) verify:webui, (5) pin-drift check, (6) pm2 restart,
# (7) smoke: local 200 + public 200 + boot marker in pm2 log.
#
# WAYLAND_ALLOW_MISSING_MCP=1 is passed by build:webui itself: the four optional
# @wayland/{imap,news,cal-com,apple}-mcp packages live in a FerroxLabs repo that is
# not public, so they are intentionally not bundled here. The 6 required stdio MCP
# scripts are still verified.
set -euo pipefail
REPO=/home/forge/wayland-desktop
cd "$REPO"
export PATH=/home/forge/.bun/bin:/home/forge/.nvm/versions/node/v24.16.0/bin:$PATH

PULL=0; RESTART=1
for a in "$@"; do case "$a" in --pull) PULL=1;; --no-restart) RESTART=0;; *) echo "unknown arg $a"; exit 2;; esac; done

step() { printf '\n\033[1;36m[deploy %s]\033[0m %s\n' "$1" "$2"; }

if [ "$PULL" = 1 ]; then
  step 0 "fetch upstream and rebase local patches"
  git fetch origin
  branch=$(git branch --show-current)
  [ -n "$(git status --porcelain)" ] && { echo "working tree dirty; commit or stash first"; exit 1; }
  git rebase origin/main || { echo "rebase conflict: resolve, then rerun without --pull"; exit 1; }
  echo "rebased $branch onto origin/main"
fi

step 1 "pinned wayland-core"
pinned=$(grep -oE "DEFAULT_WCORE_VERSION = 'v[0-9.]+'" scripts/prepareWaylandCore.js | grep -oE 'v[0-9.]+')
WCORE_VERSION="${WCORE_VERSION:-$pinned}" node scripts/prepareWaylandCore.js

step 2 "constitution-fs helper"
node scripts/prepareConstitutionFs.js

step 3 "build:webui (renderer + server + MCP)"
NODE_ENV=production bun run build:webui

step 4 "verify:webui"
node scripts/verify-webui.mjs

step 5 "engine pin drift check"
scripts/check-core-pin.sh

if [ "$RESTART" = 1 ]; then
  step 6 "pm2 restart"
  pm2 restart wayland-webui --update-env >/dev/null
  for i in $(seq 1 40); do
    if awk '/Received SIGINT/{buf=""} {buf=buf"\n"$0} END{print buf}' ~/.pm2/logs/wayland-webui-out.log | grep -q 'WebUI started'; then break; fi
    sleep 1
  done
  step 7 "smoke"
  local_code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3403/)
  pub_code=$(curl -s -o /dev/null -w '%{http_code}' https://os.warriorhi.com/)
  echo "local $local_code  public $pub_code"
  [ "$local_code" = 200 ] && [ "$pub_code" = 200 ] || { echo "smoke FAILED"; pm2 logs wayland-webui --lines 30 --nostream; exit 1; }
  pm2 jlist | python3 -c "import json,sys;[print('pm2',p['pm2_env']['status'],'restarts',p['pm2_env']['restart_time']) for p in json.load(sys.stdin) if p['name']=='wayland-webui']"
fi
echo; echo "deploy OK $(git rev-parse --short HEAD) $(date -Is)"
