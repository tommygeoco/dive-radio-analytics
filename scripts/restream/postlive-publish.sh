#!/bin/sh
# postlive-publish.sh — publish the dive-radio-analytics dashboard to
# production. Single-repo layout: this repo is both the source of truth and
# the served site, so publishing is commit -> push -> Vercel deploy, then a
# live-site parity check (curl the deployed data.json and compare its
# generatedAt to the local one). Zero-model, deterministic, idempotent.
#
# Run from the repo root (the cron chain runs validate.mjs before this).
set -eu

REPO="/Users/bones/Dev/2026/dive-radio-analytics"
SITE="https://dive-radio-analytics.vercel.app"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$REPO"
[ -d .git ] || { echo "publish: $REPO is not a git repo" >&2; exit 1; }

git add -A
if git diff --cached --quiet; then
  echo "publish: no new changes to commit."
else
  git commit -m "data refresh $(date '+%Y-%m-%d %H:%M %Z')" --quiet
fi

# Main has more than one writer: working sessions land code on it between
# chain runs. Replay our commits on top of whatever origin has — the data
# files have a single writer (this chain), so the rebase is clean; a genuine
# conflict aborts loudly and changes nothing on the remote. This also pushes
# a commit a previous run made but failed to push.
git fetch origin main --quiet
git rebase origin/main --quiet || { git rebase --abort; echo "publish: local commits conflict with origin/main — resolve by hand" >&2; exit 1; }
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  echo "publish: origin already has everything — skipping deploy."
  exit 0
fi
git push origin main --quiet
echo "publish: pushed to GitHub."

vercel deploy --prod --yes 2>&1 | tail -3
echo "publish: Vercel production deploy done."

# post-deploy parity: the live site must serve the data we just built.
LOCAL_STAMP=$(node -e "console.log(JSON.parse(require('fs').readFileSync('data.json','utf8')).generatedAt)")
for i in 1 2 3; do
  LIVE_STAMP=$(curl -fsS --max-time 20 "$SITE/data.json?cb=$(date +%s)" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).generatedAt))" || echo "fetch-failed")
  [ "$LIVE_STAMP" = "$LOCAL_STAMP" ] && { echo "publish: live site serves $LIVE_STAMP — parity confirmed."; exit 0; }
  echo "publish: live stamp $LIVE_STAMP != local $LOCAL_STAMP (attempt $i/3) — waiting for CDN…"
  sleep 15
done
echo "publish: FAILED live-site parity — deployed data.json does not match local after 3 checks." >&2
exit 1
