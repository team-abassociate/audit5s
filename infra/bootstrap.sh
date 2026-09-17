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
log "Starting services"
docker compose pull
docker compose up -d

log "Waiting for PostgreSQL"
for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U "${POSTGRES_SUPERUSER:-postgres}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# --- 5. Migrations ------------------------------------------------------------
# Files in git, applied here — never `drizzle-kit push` (DECISIONS.md, "Related:
# migrations"). The deploy workflow takes a pgBackRest snapshot immediately before this.
log "Applying migrations"
docker compose run --rm \
  -e DATABASE_MIGRATION_URL="${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL}" \
  api node -e "require('/repo/packages/db/dist/migrate.js')" \
  || die "Migrations failed. The database is unchanged; check the log above."

# --- 6. Backups ---------------------------------------------------------------
# Backups cannot be retrofitted after data loss, so the stanza is created now, not later.
log "Initialising the pgBackRest repository"
docker compose exec -T pgbackrest pgbackrest --stanza=audit5s stanza-create || \
  echo "stanza already exists"
docker compose exec -T pgbackrest pgbackrest --stanza=audit5s --type=full backup

log "Installing backup cron"
install -m 0644 "$REPO_ROOT/infra/pgbackrest/crontab" /etc/cron.d/pgbackrest
systemctl restart cron 2>/dev/null || systemctl restart crond 2>/dev/null || true

log "Done. Check: docker compose ps"
