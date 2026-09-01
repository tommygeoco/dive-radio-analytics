#!/bin/sh
# install-hooks.sh — PRD v11 W36/W41: drift is caught at push time, not at 07:00.
# Installs .git/hooks/pre-push, which runs the fixture tests and the validator
# in STRICT mode on a fresh build (drift blocks here), restores the generated
# files, and warns when a push from a non-chain machine carries store files.
#   sh scripts/dev/install-hooks.sh
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$REPO/.git/hooks/pre-push"
cat > "$HOOK" <<'HOOKEOF'
#!/bin/sh
# pre-push (installed by scripts/dev/install-hooks.sh) — PRD v11 W36/W41
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO" || exit 1
echo "pre-push: fixtures + strict validator on a fresh build …"
node tools/dive-analytics/audit/baselines.test.mjs >/dev/null || { echo "pre-push: baselines fixtures failed — push refused" >&2; exit 1; }
node tools/dive-analytics/audit/chain-heal.test.mjs >/dev/null || { echo "pre-push: chain-heal rehearsal failed — push refused" >&2; exit 1; }
node tools/dive-analytics/audit/validate-tiers.test.mjs >/dev/null || { echo "pre-push: validator tier test failed — push refused" >&2; exit 1; }
DIRTY_DATA=0; git diff --quiet -- data.json data.js || DIRTY_DATA=1
node tools/dive-analytics/build-data.mjs >/dev/null || { echo "pre-push: build-data failed — push refused" >&2; exit 1; }
OUT="$(node tools/dive-analytics/audit/validate.mjs 2>&1)"; CODE=$?
[ "$DIRTY_DATA" = 0 ] && git checkout -- data.json data.js 2>/dev/null
if [ $CODE -ne 0 ]; then
  echo "$OUT" | grep -E "^(FAIL|DRIFT)" | head -20 >&2
  echo "pre-push: the strict validator refused this tree (fail or drift above) — fix before pushing" >&2
  exit 1
fi
# rule 26: stores have one writer (the chain machine, DIVE_CHAIN_MACHINE=1)
if [ -z "${DIVE_CHAIN_MACHINE:-}" ]; then
  while read -r local_ref local_sha remote_ref remote_sha; do
    [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue
    if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then RANGE="$local_sha"; else RANGE="$remote_sha..$local_sha"; fi
    STORES="$(git diff --name-only "$RANGE" -- 'data/restream/*' data.json data.js 2>/dev/null | head -5)"
    [ -n "$STORES" ] && echo "pre-push: WARNING — this push changes store or generated files from a machine that is not the chain machine:
$STORES
  (rule 26: the chain machine is the only writer; its next run heals a same-day conflict, but prefer code-only pushes)" >&2
  done
fi
echo "pre-push: ok"
exit 0
HOOKEOF
chmod +x "$HOOK"
echo "install-hooks: pre-push installed at $HOOK"
