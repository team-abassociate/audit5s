#!/usr/bin/env bash
# Run from CI on the VPS after a successful main-branch CI run.
set -euo pipefail

sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected a full commit SHA" >&2; exit 1; }
cd /opt/audit5s
[[ -f .env ]] || { echo "Missing /opt/audit5s/.env" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] ||
  { echo "Tracked files on the deployment checkout are modified" >&2; exit 1; }

git fetch origin main
git cat-file -e "$sha^{commit}"
git checkout --detach "$sha"

# The images were published by the workflow before this script was called.
sed -i -E "s|^API_IMAGE=.*$|API_IMAGE=ghcr.io/team-abassociate/audit5s-api:$sha|" .env
sed -i -E "s|^WEB_IMAGE=.*$|WEB_IMAGE=ghcr.io/team-abassociate/audit5s-web:$sha|" .env
sudo -n ./infra/bootstrap.sh

app_host="$(sed -nE 's/^APP_HOST=//p' .env | head -1)"
api_host="$(sed -nE 's/^API_HOSTNAME=//p' .env | head -1)"
objects_host="$(sed -nE 's/^OBJECTS_HOST=//p' .env | head -1)"
api_healthy() {
  curl -fsS "https://$api_host/api/v1/health" 2>/dev/null |
    python3 -c 'import json,sys; sys.exit(1 if json.load(sys.stdin)["status"] == "error" else 0)' 2>/dev/null
}
for attempt in $(seq 1 30); do
  if curl -fsS "https://$app_host/" >/dev/null 2>&1 &&
     api_healthy &&
     curl -fsS "https://$objects_host/minio/health/ready" >/dev/null 2>&1; then
    echo "Deployment health checks passed: $sha"
    exit 0
  fi
  echo "Waiting for public HTTPS health checks ($attempt/30)"
  sleep 10
done
echo "Deployment health checks failed; inspect docker compose ps and Caddy logs" >&2
exit 1
