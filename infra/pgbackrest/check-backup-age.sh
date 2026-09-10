#!/usr/bin/env bash
#
# The backup-age alarm. Pings the heartbeat URL only if the newest backup is recent
# enough; silence is what raises the alert, so this failing to run also alerts.
set -euo pipefail

MAX_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-36}"
HEARTBEAT_URL="${BACKUP_HEARTBEAT_URL:-}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/audit5s/docker-compose.yml}"

info="$(docker compose -f "$COMPOSE_FILE" exec -T pgbackrest \
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

[[ -n "$HEARTBEAT_URL" ]] && curl -fsS --max-time 10 "$HEARTBEAT_URL" >/dev/null
