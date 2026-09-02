#!/bin/sh
# Compatibility entry point for chain.json. The checked release flow lives in
# a Node module so its retry and production-proof behavior can be tested.
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || { echo "publish: cannot open $REPO" >&2; exit 1; }
exec node tools/dive-analytics/publish-flow.mjs "$@"
