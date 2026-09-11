#!/usr/bin/env bash
# The workspace's dev command — what Superset starts when you hit Run.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ -f package.json ] && grep -q '"dev"' package.json; then
  exec pnpm dev
fi

echo "run: nothing to start yet — no dev script. See STACK.md §7 for the build order."
