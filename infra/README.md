# Infrastructure

One Oracle Cloud Ampere A1 (2 OCPU / 12 GB, `ap-mumbai-1`), six Docker containers, and
Cloudflare in front. `STACK.md` is the decision record; this file is the operating manual.

There is **one environment**. Migrations are files in git applied by CI, never
`drizzle-kit push`, and the deploy step takes a pgBackRest snapshot immediately before
applying them.

## Files

| Path | What it is |
| --- | --- |
| `docker-compose.yml` | The six production services. |
| `docker-compose.dev.yml` | Local override: exposed ports, a local build, and MinIO standing in for R2. Dev convenience only — nothing in `apps/` or `packages/` names it. |
| `infra/bootstrap.sh` | Provisions a fresh host. Idempotent, and doubles as the recovery script for the restore drill. |
| `infra/docker/api.Dockerfile` | The one API image; three entrypoints plus the seed run from it. |
| `infra/sql/00-roles.sql` | Creates `audit5s_owner` and `audit5s_app`. Runs once, as a superuser, before the first migration. |
| `infra/pgbackrest/` | Backup configuration, schedule, and the backup-age alarm. |

## Required secrets

Every value the deployment needs. None of these belong in the repository or in an image —
they live in the password manager and reach the host as a `.env` beside
`docker-compose.yml` (`chmod 600`). `.env.example` at the repo root is the machine-readable
copy of this table.

### Database

| Variable | Notes |
| --- | --- |
| `POSTGRES_SUPERUSER_PASSWORD` | Postgres superuser. Used by bootstrap and psql only. |
| `DATABASE_URL` | The **application** role `audit5s_app`. Not the owner: it must not bypass RLS, and it holds no UPDATE/DELETE on the append-only tables. |
| `DATABASE_MIGRATION_URL` | The **owner** role `audit5s_owner`. Used by migrations and the seed, never by the API. |

### JWT (RS256)

Asymmetric so workers verify without holding the signing key (§12.3). Generate with:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt-private.pem
openssl rsa -pubout -in jwt-private.pem -out jwt-public.pem
base64 -w0 jwt-private.pem   # → JWT_PRIVATE_KEY_B64
base64 -w0 jwt-public.pem    # → JWT_PUBLIC_KEY_B64
```

| Variable | Notes |
| --- | --- |
| `JWT_PRIVATE_KEY_B64` | Signing key. The API only. |
| `JWT_PUBLIC_KEY_B64` | Verification key. Safe to distribute to workers. |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Must match across API and workers, or every token is rejected. |

Rotating these invalidates every access token immediately and every refresh token at its
next use. That is the intended emergency lever.

### Cloudflare R2

| Variable | Notes |
| --- | --- |
| `R2_ENDPOINT` | Account-specific S3 endpoint. An env var precisely so MinIO can stand in locally. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Scoped to the three buckets below. |
| `R2_BUCKET_EVIDENCE` | Evidence photos and selfies. **Never public.** |
| `R2_BUCKET_REPORTS` | Generated PDFs. **Never public.** |
| `R2_BUCKET_BACKUP` | The pgBackRest repository. Separate credential if the provider allows. |
| `R2_BUCKET_IMPORTS` | Uploaded checklist workbooks and the annotated error reports. **Never public.** |

> **`R2_ENDPOINT` selects the storage driver.** Set, the API and workers talk to R2 (or any
> S3-compatible endpoint, which is how the dev MinIO stands in). **Unset, they fall back to a
> filesystem driver under `OBJECT_STORAGE_LOCAL_DIR`** — that is the CI and seed path, and it
> is not a production configuration. Every boot logs which driver is live; a deployed API
> logging `file:` at startup is a misconfiguration to fix before anything is uploaded.

### Backups

| Variable | Notes |
| --- | --- |
| `PGBACKREST_CIPHER_PASS` | Backups are encrypted client-side. **Lose this and every backup is unreadable** — it is the single most important string in the password manager. |
| `BACKUP_HEARTBEAT_URL` | BetterStack heartbeat. Pinged only when the newest backup is under 36 h old; silence raises the alert. |

### Edge and delivery

| Variable | Notes |
| --- | --- |
| `CLOUDFLARE_TUNNEL_TOKEN` | cloudflared dials out; there is no public inbound port on the origin. |
| `CORS_ORIGINS` | Comma-separated allow-list. No wildcard. |
| `API_IMAGE` | GHCR image reference, pinned to a commit SHA rather than `latest`. |

### Seed and integrations

| Variable | Notes |
| --- | --- |
| `SEED_SUPER_ADMIN_FULL_NAME`, `_PHONE`, `_EMAIL` | The first Super Admin. The seed fails loudly if unset (open question Q4). |
| `SENTRY_DSN` | Optional. |
| `FCM_SERVICE_ACCOUNT_JSON_B64` | Optional until Phase 6. Absent, the push adapter logs instead of sending (Q1). |

> **Not yet supplied.** Open questions Q2 (Oracle/Cloudflare account access, bucket names,
> tunnel credentials, GHCR token) and Q5 (a vector logo) are still outstanding. Everything
> above is written against environment variables so nothing is blocked on them, and no fake
> provider is stubbed in their place.

## First deploy

```sh
git clone https://github.com/team-abassociate/audit5s /opt/audit5s
cd /opt/audit5s
cp .env.example .env && "$EDITOR" .env     # fill in from the password manager
sudo ./infra/bootstrap.sh
docker compose run --rm api node dist/seed.js
```

The seed creates the Super Admin, writes the PART 6 permission matrix, and imports the
nine checklist templates through the real import pipeline — so it is also the first
integration test of the importer.

## Restore drill — quarterly, mandatory

An untested backup is a rumour. Once a quarter, on a **fresh VM at a different provider**,
restore using only this repository and the password manager:

```sh
git clone https://github.com/team-abassociate/audit5s /opt/audit5s && cd /opt/audit5s
cp .env.example .env && "$EDITOR" .env
docker compose up -d postgres
docker compose run --rm pgbackrest pgbackrest --stanza=audit5s restore --delta
docker compose up -d
# smoke: sign in, list Units, open an audit, download a report
```

Record the wall-clock time. **If it takes more than 60 minutes, fix the runbook**, not the
expectation. Write the result down; a drill with no written result did not happen.

## Tripwires

Raise these rather than working around them (`STACK.md` §8):

- Available RAM below ~4 GB → move the report worker to WeasyPrint. The templates are
  JS-free HTML/CSS precisely so this stays a renderer change.
- Multi-device concurrent editing of one audit requested → the outbox design assumes one
  device owns an in-progress audit. Do not relax this casually.
- A second organization signed → multi-org tenancy touches every scope predicate.
- CI over 10 minutes → add Turborepo. It is a drop-in, not a migration.
