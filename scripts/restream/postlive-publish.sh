#!/bin/sh
# postlive-publish.sh — commit today's data, push main, deploy production, prove
# the live site serves what was built. The repo is the served site.
#
# PRD v11 W38 (2026-09-01): a publish must not fail for a reason it can fix
# itself, and must never re-run capture because of a deploy race.
#   • local data changes are stashed around `git pull --rebase`; a stash-pop
#     conflict is healed by chain-heal.mjs (health store merged by day, other
#     stores keep this machine's version — one writer, rule 26 — generated
#     files rebuilt) instead of aborting
#   • a push rejected because main moved during the deploy window is rebased
#     and pushed once more
#   • the Vercel deploy is attempted twice before the parity loop gives up;
#     a parity miss after a successful push+deploy exits 2 ("published,
#     parity unconfirmed") — the chain treats that as published + one alert
#   • --dry prints the decisions this run would take and changes nothing
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || { echo "publish: cannot cd to $REPO" >&2; exit 1; }
[ -d .git ] || { echo "publish: $REPO is not a git repo" >&2; exit 1; }
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1
say() { echo "publish: $*"; }

if [ "$DRY" = 1 ]; then
  say "dry run — would: $( [ -n "$(git status --porcelain)" ] && echo "stash local data," ) pull --rebase origin/main, heal any stash-pop conflict, commit 'data refresh', rebase, push, deploy prod (2 attempts), confirm parity (exit 2 if unconfirmed)"
  git status --porcelain | head -8
  exit 0
fi

STASHED=0
if [ -n "$(git status --porcelain)" ]; then
  git stash push --quiet --include-untracked -m "publish-pre-pull"
  STASHED=1
fi
if ! git pull --rebase --quiet origin main; then
  [ "$STASHED" = 1 ] && git stash pop --quiet || true
  say "remote moved and could not be rebased — not publishing (pull manually)" >&2
  exit 1
fi
if [ "$STASHED" = 1 ] && ! git stash pop --quiet; then
  say "today's files conflict with what was pulled — healing (health store merged by day, other stores keep this machine's version, generated files rebuilt)"
  if ! node -e 'import("./tools/dive-analytics/chain-heal.mjs").then((m) => { m.healLeftovers(process.cwd()); }).catch((e) => { console.error("publish: heal failed — " + e.message); process.exit(1); })'; then
    say "could not heal the conflict — not publishing (resolve, then rerun the chain)" >&2
    exit 1
  fi
  node tools/dive-analytics/build-data.mjs || { say "rebuild after heal failed — not publishing" >&2; exit 1; }
fi

git add -A
if git diff --cached --quiet; then
  say "no new changes to commit."
else
  git commit -m "data refresh $(date '+%Y-%m-%d %H:%M %Z')" --quiet
fi

# Main has more than one writer for CODE (working sessions land there between
# runs) and exactly one for data (this chain). Replay our commits on top of
# origin; a genuine conflict aborts loudly and changes nothing on the remote.
git fetch origin main --quiet
git rebase origin/main --quiet || { git rebase --abort; say "local commits conflict with origin/main — resolve by hand" >&2; exit 1; }
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  say "origin already has everything — skipping deploy."
  exit 0
fi
if ! git push origin main --quiet; then
  say "push rejected (main moved again) — rebasing once more"
  git fetch origin main --quiet
  git rebase origin/main --quiet || { git rebase --abort; say "second rebase conflicts — resolve by hand" >&2; exit 1; }
  git push origin main --quiet || { say "push failed twice — not deployed" >&2; exit 1; }
fi
say "pushed to GitHub."

LOCAL_STAMP="$(node -e "console.log(JSON.parse(require('fs').readFileSync('data.json','utf8')).generatedAt)")"
live_stamp() { curl -fsS --max-time 20 "https://dive-radio-analytics.vercel.app/data.json?cb=$(date +%s)" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).generatedAt)}catch{console.log('unparsable')}})" 2>/dev/null || echo fetch-failed; }
confirm_parity() { i=1; while [ $i -le 4 ]; do LIVE="$(live_stamp)"; [ "$LIVE" = "$LOCAL_STAMP" ] && return 0; sleep $((15 * i)); i=$((i + 1)); done; return 1; }

attempt=1
while [ $attempt -le 2 ]; do
  vercel deploy --prod --yes 2>&1 | tail -3
  say "Vercel production deploy attempt $attempt done."
  if confirm_parity; then
    say "live site serves $LOCAL_STAMP — parity confirmed."
    exit 0
  fi
  attempt=$((attempt + 1))
done
say "pushed and deployed, but the live site still serves $(live_stamp) instead of $LOCAL_STAMP — parity unconfirmed (exit 2); the freshness check re-reads the site at 08:15 and noon" >&2
exit 2
