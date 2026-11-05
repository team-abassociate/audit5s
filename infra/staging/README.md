# Staging (temporary, R-84)

Kaizen testing beside production on the one VPS, at `https://staging.leanstack.tech`. Phones
use `https://staging.leanstack.tech/field` in a browser. Accounts and data are separate from
production. Sign in as the Super Admin (the first password is their phone number, for 72 hours),
then add a test Unit and testers and grant Kaizen as usual.

**Deploy a fix before it merges:** `gh workflow run deploy-staging.yml --ref <short-branch>`. Each
fix goes to `main` in its own PR after it passes here (R-84).

**Wipe the test data:** on the VPS, in `/opt/audit5s-staging`:
`docker compose --env-file .env down -v && rm .seeded`, then deploy again.

**Remove it for good:**

1. On the VPS, in `/opt/audit5s-staging`: `docker compose --env-file .env down -v --rmi all`,
   then `rm -rf /opt/audit5s-staging`.
2. In a PR: delete `infra/staging/` and `.github/workflows/deploy-staging.yml`, and remove the
   staging lines from `infra/Caddyfile` and `infra/deploy.sh`.
3. Remove the two DNS records.
