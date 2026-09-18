# Single-VPS production deployment

The web app, API, two workers, PostgreSQL, encrypted local pgBackRest repository, private
AIStor S3 bucket, and Caddy run on the existing 2 vCPU / 8 GB / 100 GB Hostinger KVM 2.
There is no Cloudflare service in this topology. The Android app runs on users' devices;
its release APK is downloaded from the web origin.

**Recovery limit:** pgBackRest and object files are on the same VPS disk. Hostinger's
included weekly VPS backup is the only separate copy. A total VPS loss may lose a week of
work. The former five-minute disaster RPO and four-hour RTO do not apply (R-27).

## Before the first deploy

1. Create DNS A records for `app.example.com`, `api.example.com`, and
   `objects.example.com`, all pointing to the VPS IPv4 address. Use your domain registrar's
   DNS. Remove stale AAAA records unless IPv6 reaches this VPS. In the Hostinger firewall
   allow inbound TCP 22, 80, and 443 only. Caddy needs 80/443 for public HTTPS certificates.
2. Enable **weekly automatic VPS backups** in Hostinger's Snapshots & Backups dashboard,
   and note the most recent backup timestamp. The included backups are separate from the
   VPS disk but remain tied to the Hostinger account.
3. Request a single-node [AIStor Free license](https://docs.min.io/aistor/operations/licenses/).
   It does not expire, but the server blocks S3 operations without it. Save the license
   as `/opt/audit5s/infra/.local/minio.license` with mode 600. Never commit it.
4. Clone this repository at `/opt/audit5s`. Copy `.env.example` to `.env`, fill the
   production values below from a password manager, and set mode 600. Use unique random
   credentials for PostgreSQL, the object-store root, the S3 application user, and JWT.
   The root and application S3 users must differ. Generate URL-safe MinIO root credentials
   with `openssl rand -hex 32`.
5. Set `APP_HOST`, `API_HOSTNAME`, `OBJECTS_HOST` and `ACME_EMAIL`. Set
   `JWT_ISSUER=https://<api-host>`. Set `API_IMAGE` and `WEB_IMAGE` to the same
   published 40-character commit SHA. Run `sudo docker login ghcr.io` on the VPS if the
   packages are private; bootstrap runs Docker as root. The production Compose file derives
   `WEB_APP_URL` and `S3_ENDPOINT` from
   these hosts.
6. Generate an APK download password hash with
   `docker run --rm caddy:2-alpine caddy hash-password --plaintext 'chosen-password'`.
   Put the resulting bcrypt hash in `APK_DOWNLOAD_PASSWORD_HASH` using single quotes in
   `.env`, so Compose treats its dollar signs literally. Store the plain password only
   in the password manager.
7. Create a GitHub **production** environment with required reviewer approval. Add
   `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, and `VPS_KNOWN_HOSTS` as environment secrets.
   `VPS_USER` must be able to run `sudo -n /opt/audit5s/infra/bootstrap.sh`, access
   Docker, and update the deployment checkout. Capture the real SSH host key out of band;
   do not disable host-key checking.

Bootstrap validates configuration before starting services. It installs Docker and the
AIStor CLI, sets up swap and the firewall, provisions one private S3 bucket and restricted
app user, takes a full pre-migration backup, applies migrations, then starts Caddy and
the application. From the VPS:

```sh
cd /opt/audit5s
sudo ./infra/bootstrap.sh
docker compose --env-file .env run --rm -e DATABASE_MIGRATION_URL api node dist/seed.js
```

The seed creates the first Super Admin and imports checklist templates. Do not run it
with real production data unless its documented idempotency is intended.

## Deployments

CI runs on every push. A successful `main` run triggers `.github/workflows/deploy.yml`;
the required GitHub production environment approval is the release gate. The workflow
publishes commit-tagged API and web images, connects by verified SSH, checks out that
commit on the VPS, and calls `infra/deploy.sh`. The deploy takes a full pgBackRest backup
before migrations and checks the three public HTTPS origins after startup. Never use
`drizzle-kit push` against production.

If the deploy fails during a migration, keep the API closed until the schema and
pre-migration backup have been inspected. An older application image may be incompatible
with a partially applied migration.

## Private storage and browser access

The only public S3 address is `https://<objects-host>`. Caddy preserves Host, path and
query parameters so SigV4 links remain valid. The AIStor console is not published.
`127.0.0.1:9000` is available only on the VPS for the administrative `mc` CLI. One
bucket, `S3_BUCKET`, holds evidence, reports and imports under their existing key
prefixes. Bucket access is private; the app user has only GetObject and PutObject.
Bootstrap sets CORS to the exact web origin. Presigned GET remains capped at five
minutes and PUT at fifteen.

The `S3_ENDPOINT` application setting is mandatory in production. The filesystem
driver is only for development and CI. A production startup with no S3 endpoint now
fails instead of silently storing media in an API container.

## Android release APK

Configure the Expo production environment for the `vps` build profile with
`API_BASE_URL=https://<api-host>/api/v1` and `WEB_APP_HOST=<app-host>`. Build with
`eas build --platform android --profile vps`; its internal distribution profile emits
an APK. Download the completed APK, verify its signing certificate and SHA-256, then
place it at `/opt/audit5s/infra/.local/releases/field.apk` with mode 644. Auditors
download it from `https://<app-host>/downloads/field.apk` using the separate download
password. Test installation and an upgrade on a real field device before sharing it.

For verified Android corrective-action links, put an `assetlinks.json` with the
`in.abassociate.audit5s` package and release signing-certificate SHA-256 fingerprint at
`infra/.local/well-known/assetlinks.json`. Caddy serves it from
`https://<app-host>/.well-known/assetlinks.json`. Until this exists, Android may show
an app chooser; the web corrective-action page remains usable.

## Backups, capacity, and restore

pgBackRest archives WAL to the encrypted `backuprepo` Docker volume, takes daily
incrementals and weekly full backups. `infra/pgbackrest/check-backup-age.sh` runs hourly
and pings `BACKUP_HEARTBEAT_URL` only while the latest backup is under 36 hours old and
Docker's disk is below 70% use. Configure an external heartbeat for an actionable alarm.
At 70% disk use, plan an expansion; do not wait for 80%, and never remove retained
evidence to free space. Check `docker system df`, pgBackRest info, and object data
growth weekly.

Before accepting live data, create a Hostinger snapshot, restore it on this still-empty
VPS, and rerun bootstrap and smoke checks. Restoring a provider snapshot overwrites the
whole VPS; after go-live, use a spare VPS for that drill or arrange a maintenance window.
Quarterly, run `sudo ./infra/restore-drill.sh` to restore local pgBackRest into a
scratch Docker volume, then inspect representative objects with the AIStor CLI.
Record the backup timestamp and result. Local restore proves
the pgBackRest repository, while the provider snapshot drill tests the only disaster copy.

Smoke checks after each deploy: web sign-in, list Units, offline audit sync, signed evidence
PUT and expiring GET, checklist import, report generation/download, and private bucket
access denial without a signature. Watch RAM during simultaneous upload, backup and report
render before increasing any container memory limit.
