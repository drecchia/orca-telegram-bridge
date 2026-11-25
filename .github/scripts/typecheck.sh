#!/usr/bin/env bash
# Type-checks src/ against the Orca plugin typings and Node's.
# Needs the Orca CLI: `orca`, or `orca-ide` on Linux (set ORCA=orca-ide).
set -euo pipefail

ORCA="${ORCA:-orca}"
TOOLS="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/telegram-bridge-typecheck"

# .orca/types is not committed: the installed Orca writes the typings it ships.
"$ORCA" plugin types . --json >/dev/null
npm install --prefix "$TOOLS" --no-save --no-audit --no-fund --silent typescript@5.9.3 @types/node@24.19.4

# The type list is the one in .orca/types/tsconfig.json, plus `node`.
node "$TOOLS/node_modules/typescript/bin/tsc" -p . --noEmit \
  --typeRoots ".orca/types,$TOOLS/node_modules/@types" \
  --types orca,orca-host,orca-frame,orca-worker,orca-services,orca-testing,node
