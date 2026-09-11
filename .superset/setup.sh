#!/usr/bin/env bash
# Runs once when Superset creates a workspace (a fresh git worktree) for an agent.
# A new worktree carries tracked files only, so anything gitignored — .env files,
# node_modules — has to be brought across or rebuilt here.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# The main checkout is the parent of the shared .git directory.
main_worktree="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

if [ "$main_worktree" != "$PWD" ] && [ -d "$main_worktree" ]; then
  while IFS= read -r -d '' env_file; do
    rel="${env_file#"$main_worktree"/}"
    [ -e "$rel" ] && continue
    mkdir -p "$(dirname "$rel")"
    cp "$env_file" "$rel"
    echo "setup: copied $rel from the main checkout"
  done < <(find "$main_worktree" -name '.env*' -not -path '*/node_modules/*' \
             -not -path '*/.git/*' -type f -print0 2>/dev/null)
fi

if [ -f package.json ]; then
  corepack enable >/dev/null 2>&1 || true
  pnpm install --frozen-lockfile
else
  echo "setup: no package.json yet — this repository is still at the specification stage."
fi
