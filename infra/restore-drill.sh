#!/usr/bin/env bash
# Restore pgBackRest into a disposable Docker volume, never the production pgdata volume.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo "Missing .env" >&2; exit 1; }
pass="$(sed -nE 's/^PGBACKREST_CIPHER_PASS=//p' .env | head -1)"
[[ -n "$pass" ]] || { echo "PGBACKREST_CIPHER_PASS is missing" >&2; exit 1; }
[[ "$(docker compose --env-file .env ps --status running --services pgbackrest)" == "pgbackrest" ]] ||
  { echo "Production pgBackRest must be running" >&2; exit 1; }

volume="audit5s_restore_drill_$(date +%s)_$$"
container="audit5s-restore-drill-$$"
image="audit5s-postgres-pgbackrest:18"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
docker run --rm -v "$volume:/var/lib/postgresql/data" "$image" \
  chown postgres:postgres /var/lib/postgresql/data

export PGBACKREST_REPO1_CIPHER_PASS="$pass"
docker run --rm --user postgres \
  -e PGBACKREST_REPO1_CIPHER_PASS \
  -v "$volume:/var/lib/postgresql/data" \
  -v audit5s_backuprepo:/repo:ro \
  -v "$ROOT/infra/pgbackrest/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
  "$image" pgbackrest --stanza=audit5s --type=immediate restore

docker run -d --name "$container" \
  -e PGDATA=/var/lib/postgresql/data \
  -e PGBACKREST_REPO1_CIPHER_PASS \
  -v "$volume:/var/lib/postgresql/data" \
  -v audit5s_backuprepo:/repo:ro \
  -v "$ROOT/infra/pgbackrest/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
  "$image" postgres -c archive_mode=off >/dev/null
for _ in $(seq 1 60); do
  if docker exec -u postgres "$container" pg_isready -U postgres -d audit5s >/dev/null 2>&1; then
    docker exec -u postgres "$container" psql -v ON_ERROR_STOP=1 -U postgres -d audit5s \
      -Atc 'SELECT current_database(), count(*) FROM pg_catalog.pg_class' >/dev/null
    echo "Scratch restore passed. Record the backup timestamp from pgBackRest info."
    exit 0
  fi
  sleep 2
done
docker logs "$container" >&2
echo "Scratch PostgreSQL did not become ready" >&2
exit 1
