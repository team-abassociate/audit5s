#!/usr/bin/env bash
# CI-only local-repository smoke: proves socket access, stanza creation, WAL
# archiving and a full backup with the exact image used by both services.
set -euo pipefail

image=audit5s-postgres-pgbackrest:18
config="$(mktemp)"
cat > "$config" <<'CONF'
[global]
repo1-type=posix
repo1-path=/repo
log-level-file=off
log-level-console=warn

[smoke]
pg1-path=/var/lib/postgresql/data
pg1-socket-path=/var/run/postgresql
pg1-user=postgres
CONF
chmod 644 "$config"

docker volume create audit5s-smoke-data >/dev/null
docker volume create audit5s-smoke-socket >/dev/null
docker volume create audit5s-smoke-repo >/dev/null
docker run --rm -v audit5s-smoke-repo:/repo "$image" chown postgres:postgres /repo
docker run -d --name audit5s-smoke-db \
  -e POSTGRES_PASSWORD=smoke-only -e PGDATA=/var/lib/postgresql/data \
  -v audit5s-smoke-data:/var/lib/postgresql/data \
  -v audit5s-smoke-socket:/var/run/postgresql \
  -v audit5s-smoke-repo:/repo \
  -v "$config":/etc/pgbackrest/pgbackrest.conf:ro \
  "$image" postgres -c archive_mode=on \
  -c 'archive_command=pgbackrest --stanza=smoke archive-push %p' \
  -c archive_timeout=5 >/dev/null
for _ in $(seq 1 60); do
  if docker exec audit5s-smoke-db pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec audit5s-smoke-db pg_isready -U postgres >/dev/null
docker run -d --name audit5s-smoke-backup --user postgres \
  -v audit5s-smoke-data:/var/lib/postgresql/data \
  -v audit5s-smoke-socket:/var/run/postgresql \
  -v audit5s-smoke-repo:/repo \
  -v "$config":/etc/pgbackrest/pgbackrest.conf:ro \
  "$image" sleep infinity >/dev/null
docker exec audit5s-smoke-backup pgbackrest --stanza=smoke stanza-create
docker exec audit5s-smoke-backup pgbackrest --stanza=smoke check
docker exec audit5s-smoke-backup pgbackrest --stanza=smoke --type=full backup
docker exec audit5s-smoke-backup pgbackrest --stanza=smoke info >/dev/null
echo "PostgreSQL WAL archive and full backup smoke passed"
