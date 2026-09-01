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

# PRD v9 F26: a remote that moved (a merge from another machine) must fail
# loudly here, never as a rejected push after the build already ran. Local
# data changes are stashed around the pull; a conflict aborts the publish
# instead of committing conflict markers.
STASHED=0
if [ -n "$(git status --porcelain)" ]; then
  git stash push --quiet --include-untracked -m "publish-pre-pull"
  STASHED=1
fi
if ! git pull --rebase --quiet origin main; then
  [ "$STASHED" = 1 ] && git stash pop --quiet || true
  echo "publish: remote moved and could not be rebased — not publishing (pull manually)" >&2
  exit 1
fi
if [ "$STASHED" = 1 ] && ! git stash pop --quiet; then
  # PRD v10 W34: the only files the chain changes are generated from the
  # stores, so a conflict with pulled code is never a data conflict — take the
  # pulled tree, rebuild data.json/data.js from the stores, and carry on. The
  # stores themselves (data/restream/*) are append-only and never conflict
  # with code; a genuine store conflict still stops the publish below.
  echo "publish: today's generated files conflict with pulled code — taking the pulled tree and rebuilding data.json"
  git checkout -- data.json data.js 2>/dev/null || true
  if ! git diff --name-only --diff-filter=U | grep -q .; then
    git stash drop --quiet || true
    node tools/dive-analytics/build-data.mjs || { echo "publish: rebuild after pull failed — not publishing" >&2; exit 1; }
  else
    echo "publish: a store file conflicts with what was pulled — not publishing (resolve, then rerun the chain)" >&2
    exit 1
  fi
fi

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
# W11.3 (2026-08-31): the CDN can serve the previous build for a while after a
# successful deploy — the 2026-08-31 weekly run deployed fine but failed parity
# inside a ~15s window (three checks 5s apart). Check immediately, then wait
# 30/60/90s between retries (~3 minutes total) before calling it a failure.
for i in 1 2 3 4; do
  LIVE_STAMP=$(curl -fsS --max-time 20 "$SITE/data.json?cb=$(date +%s)" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).generatedAt))" || echo "fetch-failed")
  [ "$LIVE_STAMP" = "$LOCAL_STAMP" ] && { echo "publish: live site serves $LIVE_STAMP — parity confirmed."; exit 0; }
  [ "$i" = 4 ] && break
  WAIT=$((30 * i))
  echo "publish: live stamp $LIVE_STAMP != local $LOCAL_STAMP (attempt $i/4) — waiting ${WAIT}s for CDN…"
  sleep "$WAIT"
done
echo "publish: FAILED live-site parity — deployed data.json does not match local after 4 checks over ~3 minutes." >&2
exit 1
