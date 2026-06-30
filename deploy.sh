#!/usr/bin/env bash
# Deploy Sim-Drive to the aibox -> https://drive.tedcolegrove.ai
#
# Pushes the current branch to origin/main, then pulls it on the server.
# The box also auto-pulls every 2 min via cron, so this is just the "make it
# live right now" path. Static files only — nginx needs no reload.
set -euo pipefail

BOX="aiadmin@192.168.6.45"
DIR="/srv/drive"

echo "→ pushing to origin/main…"
git push origin HEAD:main

echo "→ pulling on the aibox…"
ssh -o ConnectTimeout=10 "$BOX" \
  "git -C '$DIR' pull --ff-only --quiet && echo '  deployed commit:' \$(git -C '$DIR' rev-parse --short HEAD)"

echo "✓ live at https://drive.tedcolegrove.ai"
