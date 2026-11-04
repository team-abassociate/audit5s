#!/usr/bin/env bash
# Deploys one commit to staging (R-84). Runs on the VPS from /opt/audit5s-staging, and touches
# nothing of production's except reading its MinIO license and the Super Admin's seed details.
set -euo pipefail

sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected a full commit SHA" >&2; exit 1; }
cd /opt/audit5s-staging

compose() { docker compose -f compose.yml --env-file .env "$@"; }
env_value() { sed -nE "s/^$1=//p" "$2" | head -1; }

# First run: secrets of its own, shared with nothing in production.
if [[ ! -f .env ]]; then
  umask 077
  key="$(mktemp)"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$key" 2>/dev/null
  cat > .env <<EOF
POSTGRES_SUPERUSER_PASSWORD=$(openssl rand -hex 32)
APP_OWNER_PASSWORD=$(openssl rand -hex 32)
APP_PASSWORD=$(openssl rand -hex 32)
MINIO_ROOT_USER=$(openssl rand -hex 16)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 32)
S3_ACCESS_KEY_ID=$(openssl rand -hex 16)
S3_SECRET_ACCESS_KEY=$(openssl rand -hex 32)
JWT_PRIVATE_KEY_B64=$(base64 -w0 "$key")
JWT_PUBLIC_KEY_B64=$(openssl pkey -in "$key" -pubout | base64 -w0)
API_IMAGE=
WEB_IMAGE=
EOF
  rm -f "$key"
  umask 022
fi

sed -i -E "s|^API_IMAGE=.*$|API_IMAGE=ghcr.io/team-abassociate/audit5s-api:staging-$sha|" .env
sed -i -E "s|^WEB_IMAGE=.*$|WEB_IMAGE=ghcr.io/team-abassociate/audit5s-web:staging-$sha|" .env

compose pull -q
compose up -d --no-deps --wait postgres object-storage

for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:9100/minio/health/ready >/dev/null 2>&1 && break
  sleep 2
done

# The same private bucket and restricted app user as production's bootstrap.sh.
export MC_HOST_staging="http://$(env_value MINIO_ROOT_USER .env):$(env_value MINIO_ROOT_PASSWORD .env)@127.0.0.1:9100"
policy="$(mktemp)"; cors="$(mktemp)"
trap 'rm -f "$policy" "$cors"' EXIT
cat > "$policy" <<'POLICY'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":["arn:aws:s3:::audit5s-staging/*"]}]}
POLICY
cat > "$cors" <<'CORS'
<CORSConfiguration><CORSRule><AllowedOrigin>https://staging.leanstack.tech</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>
CORS
mc mb --ignore-existing staging/audit5s-staging >/dev/null
mc admin policy create staging audit5s-app "$policy" >/dev/null
mc admin user add staging "$(env_value S3_ACCESS_KEY_ID .env)" "$(env_value S3_SECRET_ACCESS_KEY .env)" >/dev/null
mc admin policy attach staging audit5s-app --user "$(env_value S3_ACCESS_KEY_ID .env)" >/dev/null 2>&1 || true
mc cors set staging/audit5s-staging "$cors" >/dev/null
unset MC_HOST_staging

export APP_OWNER_PASSWORD="$(env_value APP_OWNER_PASSWORD .env)"
export APP_PASSWORD="$(env_value APP_PASSWORD .env)"
compose exec -T -e APP_OWNER_PASSWORD -e APP_PASSWORD postgres \
  psql -v ON_ERROR_STOP=1 -q -U postgres -d audit5s -f - < 00-roles.sql

export DATABASE_MIGRATION_URL="postgres://audit5s_owner:$APP_OWNER_PASSWORD@postgres:5432/audit5s"
compose run --rm --no-deps -e DATABASE_MIGRATION_URL api \
  node -e "require('/repo/packages/db/dist/migrate.js')"

# First run: the same Super Admin as production. Their first password is their phone number.
# Output is dropped so their details stay out of the workflow log; errors still show.
if [[ ! -f .seeded ]]; then
  SEED_SUPER_ADMIN_FULL_NAME="$(env_value SEED_SUPER_ADMIN_FULL_NAME /opt/audit5s/.env)" \
  SEED_SUPER_ADMIN_PHONE="$(env_value SEED_SUPER_ADMIN_PHONE /opt/audit5s/.env)" \
  SEED_SUPER_ADMIN_EMAIL="$(env_value SEED_SUPER_ADMIN_EMAIL /opt/audit5s/.env)" \
    compose run --rm --no-deps -e DATABASE_MIGRATION_URL \
      -e SEED_SUPER_ADMIN_FULL_NAME -e SEED_SUPER_ADMIN_PHONE -e SEED_SUPER_ADMIN_EMAIL \
      api node dist/seed.js >/dev/null
  touch .seeded
fi

compose up -d --remove-orphans

for attempt in $(seq 1 30); do
  if curl -fsS https://staging.leanstack.tech/api/v1/health >/dev/null 2>&1 &&
     curl -fsS https://staging.leanstack.tech/ >/dev/null 2>&1 &&
     curl -fsS https://objects-staging.leanstack.tech/minio/health/ready >/dev/null 2>&1; then
    echo "Staging is up: $sha"
    docker images --format '{{.Repository}}:{{.Tag}}' |
      grep -E '^ghcr\.io/team-abassociate/audit5s-(api|web):staging-' |
      grep -v ":staging-$sha$" | xargs -r docker rmi >/dev/null || true
    exit 0
  fi
  echo "Waiting for staging ($attempt/30)"
  sleep 10
done
echo "Staging health checks failed" >&2
exit 1
