#!/usr/bin/env bash
#
# The backup-age alarm. Pings the heartbeat URL only if the newest backup is recent
# enough; silence is what raises the alert, so this failing to run also alerts.
set -euo pipefail

MAX_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-36}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/audit5s/docker-compose.yml}"
ENV_FILE="$(dirname "$COMPOSE_FILE")/.env"
# Cron has no application environment. Read the URL as data, never source .env.
HEARTBEAT_URL="${BACKUP_HEARTBEAT_URL:-$(sed -nE 's/^BACKUP_HEARTBEAT_URL=//p' "$ENV_FILE" | head -1)}"

info="$(docker compose -f "$COMPOSE_FILE" --env-file "$(dirname "$COMPOSE_FILE")/.env" exec -T pgbackrest \
  pgbackrest --stanza=audit5s --output=json info 2>/dev/null)" || exit 1

newest="$(printf '%s' "$info" | python3 -c '
import json, sys
data = json.load(sys.stdin)
stamps = [b["timestamp"]["stop"] for s in data for b in s.get("backup", [])]
print(max(stamps) if stamps else 0)
')"

[[ "$newest" -gt 0 ]] || exit 1

age_hours=$(( ( $(date +%s) - newest ) / 3600 ))
if (( age_hours > MAX_AGE_HOURS )); then
  echo "Newest backup is ${age_hours}h old (limit ${MAX_AGE_HOURS}h)" >&2
  exit 1
fi

if [[ -n "$HEARTBEAT_URL" ]]; then
  curl -fsS --max-time 10 "$HEARTBEAT_URL" >/dev/null
fi
