#!/usr/bin/env bash
# Runs when Superset discards a workspace. Stop anything the run script started;
# leave the git worktree itself to Superset.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ -f docker-compose.yml ]; then
  docker compose down --remove-orphans >/dev/null 2>&1 || true
fi
