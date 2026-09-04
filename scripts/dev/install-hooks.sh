#!/bin/sh
# Install a candidate-only gate. It never rebuilds or resets the caller's files.
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$(git -C "$REPO" rev-parse --git-path hooks/pre-push)"
case "$HOOK" in /*) ;; *) HOOK="$REPO/$HOOK" ;; esac
mkdir -p "$(dirname "$HOOK")"
cat > "$HOOK" <<'HOOKEOF'
#!/bin/sh
set -eu
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
exec node tools/dive-analytics/release-gate.mjs
HOOKEOF
chmod +x "$HOOK"
printf 'install-hooks: pre-push installed at %s\n' "$HOOK"
