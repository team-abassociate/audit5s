#!/usr/bin/env bash
#
# One-shot provisioning for a fresh Hostinger VPS KVM 2 host (2 vCPU / 8 GB / NVMe).
#
# It is idempotent: running it twice is safe, and that matters because it doubles as the
# recovery script. The quarterly restore drill (STACK.md §9) rebuilds a host at a
# different provider using only git and the password manager, and this file is the "only
# git" half. If the drill takes more than 60 minutes, fix this script — not the clock.
#
# Usage:  sudo ./infra/bootstrap.sh
# Expects: a .env beside docker-compose.yml, populated per infra/README.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f .env ]] || die "No .env found. Copy .env.example and fill it in (see infra/README.md)."

# docker compose reads .env itself for substitution inside the compose file, but this
# script needs several values directly. Sourcing .env would be shell-evaluating a file
# that legitimately holds spaces (SEED_SUPER_ADMIN_FULL_NAME) and shell metacharacters
# (base64, generated passwords), so read one key at a time instead, without evaluation.
env_value() { sed -nE "s/^$1=//p" .env | head -1; }
# Reject shell overrides and duplicate assignments before trusting .env.
awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{if (++seen[$1] > 1) exit 1}' .env ||
  die "Duplicate variable assignment in .env."
while IFS= read -r _key; do
  [[ -z "${!_key+x}" ]] || die "Unset exported $_key before running bootstrap."
done < <(sed -nE 's/.*\$\{([A-Z][A-Z0-9_]*).*/\1/p' docker-compose.yml | sort -u)
for _key in APP_OWNER_PASSWORD APP_PASSWORD DATABASE_MIGRATION_URL; do
  [[ -z "${!_key+x}" ]] || die "Unset exported $_key before running bootstrap."
done
compose() { docker compose -f "$REPO_ROOT/docker-compose.yml" --env-file "$REPO_ROOT/.env" "$@"; }
# Validate credentials before changing the host or starting containers. Use URL-safe
# password characters so a literal URL comparison remains unambiguous.
APP_OWNER_PASSWORD="$(env_value APP_OWNER_PASSWORD)"
APP_PASSWORD="$(env_value APP_PASSWORD)"
DATABASE_URL_VALUE="$(env_value DATABASE_URL)"
DATABASE_MIGRATION_URL_VALUE="$(env_value DATABASE_MIGRATION_URL)"
for _password in "$APP_OWNER_PASSWORD" "$APP_PASSWORD"; do
  [[ -n "$_password" && "$_password" != *[!a-zA-Z0-9._~-]* ]] || \
    die "Role passwords must be nonempty and use only letters, digits, period, underscore, tilde or hyphen. Generate one with: openssl rand -hex 32"
done
[[ "$DATABASE_URL_VALUE" == "postgres://audit5s_app:$APP_PASSWORD@postgres:5432/audit5s" ]] || \
  die "DATABASE_URL must contain the matching app password and point to postgres:5432/audit5s."
[[ "$DATABASE_MIGRATION_URL_VALUE" == "postgres://audit5s_owner:$APP_OWNER_PASSWORD@postgres:5432/audit5s" ]] || \
  die "DATABASE_MIGRATION_URL must contain the matching owner password and point to postgres:5432/audit5s."
BACKUP_ENDPOINT="$(env_value PGBACKREST_S3_ENDPOINT)"
[[ "$BACKUP_ENDPOINT" =~ ^[A-Za-z0-9.-]+$ ]] ||
  die "PGBACKREST_S3_ENDPOINT must be a nonempty S3 hostname without a scheme or path."
for _key in POSTGRES_SUPERUSER_PASSWORD R2_BUCKET_BACKUP R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY PGBACKREST_CIPHER_PASS; do
  [[ -n "$(env_value "$_key")" ]] || die "$_key is empty in .env."
done

# --- 1. Swap ------------------------------------------------------------------
# 4 GB, so a memory spike degrades instead of OOM-killing Postgres (STACK.md §9).
log "Configuring swap"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "swap already present"
fi

# Swap is the shock absorber for worker-report's render spikes, but Postgres must not be
# paged out to reach it. 10, not the default 60 (STACK.md §9).
log "Setting vm.swappiness"
sysctl -w vm.swappiness=10 >/dev/null
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

# --- 2. Docker ----------------------------------------------------------------
log "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "docker already installed"
fi

# Compare rendered Compose values with .env without printing credentials.
log "Validating effective container configuration"
command -v python3 >/dev/null 2>&1 || die "python3 is required for configuration validation."
export EXPECTED_DATABASE_URL="$DATABASE_URL_VALUE"
export EXPECTED_SUPERUSER_PASSWORD="$(env_value POSTGRES_SUPERUSER_PASSWORD)"
export EXPECTED_BACKUP_ENDPOINT="$BACKUP_ENDPOINT"
export EXPECTED_BACKUP_BUCKET="$(env_value R2_BUCKET_BACKUP)"
export EXPECTED_BACKUP_KEY="$(env_value R2_ACCESS_KEY_ID)"
export EXPECTED_BACKUP_SECRET="$(env_value R2_SECRET_ACCESS_KEY)"
export EXPECTED_BACKUP_CIPHER="$(env_value PGBACKREST_CIPHER_PASS)"
compose config --format json | python3 -c '
import json, os, sys
try:
    services = json.load(sys.stdin)["services"]
    checks = [
        ("api", "DATABASE_URL", "EXPECTED_DATABASE_URL"),
        ("postgres", "POSTGRES_PASSWORD", "EXPECTED_SUPERUSER_PASSWORD"),
    ]
    for service in ("postgres", "pgbackrest"):
        checks.extend([
            (service, "PGBACKREST_REPO1_S3_ENDPOINT", "EXPECTED_BACKUP_ENDPOINT"),
            (service, "PGBACKREST_REPO1_S3_BUCKET", "EXPECTED_BACKUP_BUCKET"),
            (service, "PGBACKREST_REPO1_S3_KEY", "EXPECTED_BACKUP_KEY"),
            (service, "PGBACKREST_REPO1_S3_KEY_SECRET", "EXPECTED_BACKUP_SECRET"),
            (service, "PGBACKREST_REPO1_CIPHER_PASS", "EXPECTED_BACKUP_CIPHER"),
        ])
    if any(services[s]["environment"].get(k) != os.environ[e] for s, k, e in checks):
        raise ValueError()
except (KeyError, ValueError, TypeError):
    sys.exit("Effective Compose configuration differs from .env.")
' || die "Container configuration validation failed."
unset EXPECTED_DATABASE_URL EXPECTED_SUPERUSER_PASSWORD
unset EXPECTED_BACKUP_ENDPOINT EXPECTED_BACKUP_BUCKET EXPECTED_BACKUP_KEY
unset EXPECTED_BACKUP_SECRET EXPECTED_BACKUP_CIPHER

# --- 3. Firewall --------------------------------------------------------------
# No public inbound port on the origin: cloudflared dials out, nothing dials in.
# This is the whole reason there is no nginx and no exposed 443 (STACK.md §4).
#
# ufw, not raw iptables. Ubuntu 26.04 dropped `iptables-persistent` (verified on
# the host 2026-09-17: `apt-cache policy` reports no candidate), so hand-written
# iptables rules have nothing to save them across a reboot. ufw is in the base
# image, persists through its own systemd unit, and covers IPv4 and IPv6 in one
# pass instead of two parallel rule sets that can drift apart.
#
# The usual ufw-versus-Docker caveat does not apply here: Docker bypasses ufw
# only for *published* ports, and docker-compose.yml publishes none. Every
# container is reachable solely on the compose network, which is the design.
log "Locking down inbound traffic"

command -v apt-get >/dev/null 2>&1 || die "This script targets Ubuntu/Debian (STACK.md §9)."

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw >/dev/null

# Staged first, activated last. ufw holds rules until `enable` applies them as a
# set, so SSH is never briefly denied the way a raw `-P INPUT DROP` does it.
ufw default deny incoming
ufw default allow outgoing
# SSH stays open; Hostinger's own VPS firewall is the second layer.
ufw allow 22/tcp comment 'ssh'
ufw --force enable

ufw status verbose
log "Firewall active and enabled at boot; no inbound port but 22"

# --- 4. Pull and start --------------------------------------------------------
log "Starting PostgreSQL"
compose pull --ignore-buildable
compose build postgres
compose stop cloudflared api worker-general worker-report
compose up -d --no-deps postgres

log "Waiting for PostgreSQL"
SUPERUSER="$(env_value POSTGRES_SUPERUSER)"
[[ -n "$SUPERUSER" ]] || SUPERUSER=postgres
for _ in $(seq 1 60); do
  if compose exec -T postgres pg_isready -U "$SUPERUSER" -d audit5s >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
compose exec -T postgres pg_isready -U "$SUPERUSER" -d audit5s >/dev/null 2>&1 || \
  die "PostgreSQL did not become ready."

# --- 5. Backup before migrations ----------------------------------------------
# Earlier migration files can commit before a later one fails. Keep app services
# stopped until the stanza, WAL archiving and full backup all succeed.
log "Starting pgBackRest"
compose up -d --no-deps pgbackrest
log "Initialising and checking the pgBackRest repository"
compose exec -T pgbackrest pgbackrest --stanza=audit5s stanza-create ||
  die "pgBackRest stanza creation failed."
compose exec -T pgbackrest pgbackrest --stanza=audit5s check ||
  die "pgBackRest WAL archive check failed."
log "Taking pre-migration full backup"
compose exec -T pgbackrest pgbackrest --stanza=audit5s --type=full backup ||
  die "Pre-migration backup failed; migrations were not started."

# --- 6. Migrations ------------------------------------------------------------
# Files in git, applied here; never `drizzle-kit push` (DECISIONS.md).
# --- 6a. Database roles --------------------------------------------------------
# Applied here rather than from /docker-entrypoint-initdb.d, because these passwords are
# secrets and initdb.d gets no psql variables. See infra/sql/00-roles.sql.
log "Creating database roles"

# Pass credentials through container environment, never process arguments.
export APP_OWNER_PASSWORD APP_PASSWORD
PGPASSWORD="$(env_value POSTGRES_SUPERUSER_PASSWORD)"
[[ -n "$PGPASSWORD" ]] || die "POSTGRES_SUPERUSER_PASSWORD is empty in .env."
export PGPASSWORD
compose exec -T -e PGPASSWORD -e APP_OWNER_PASSWORD -e APP_PASSWORD \
  postgres psql -v ON_ERROR_STOP=1 -q -U "$SUPERUSER" -d audit5s \
  -f - < infra/sql/00-roles.sql || die "Role creation failed; check the log above."
unset PGPASSWORD

# --- 6b. Migrations ------------------------------------------------------------
log "Applying migrations"
export DATABASE_MIGRATION_URL="$DATABASE_MIGRATION_URL_VALUE"
compose run --rm --no-deps \
  -e DATABASE_MIGRATION_URL \
  api node -e "require('/repo/packages/db/dist/migrate.js')" \
  || die "Migrations failed; inspect the database state and the log above."

log "Starting application services"
compose up -d

log "Installing backup cron"
install -m 0644 "$REPO_ROOT/infra/pgbackrest/crontab" /etc/cron.d/pgbackrest
systemctl restart cron 2>/dev/null || systemctl restart crond 2>/dev/null || true

log "Done. Check: docker compose ps"
