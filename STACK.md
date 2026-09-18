# audit5s — Engineering Handoff (Stack Decision Record)

**Read this first.** It is the operating contract for work on this repository.
Decisions recorded here are settled. Do not re-open them mid-task; if you believe one is
wrong, say so explicitly and wait for a decision before writing code against a different
assumption.

- **Product:** 5S audit platform for industrial facilities (India).
- **Stage:** Stage 1 — pre-revenue, ≤10 Units, <100 users, ~120 audits/month.
- **Budget ceiling:** ₹1,000/month total infrastructure. The VPS is already subscribed;
  this topology adds no paid storage service.
- **Source documents:** `ARCHITECTURE.md` (domain model, authorization matrix, state
  machines, sync protocol — authoritative) and this Stack Decision Record (infrastructure
  and technology choices — supersedes `ARCHITECTURE.md` PART 3.1).

> **Refinements.** [`DECISIONS.md`](./DECISIONS.md) records five binding resolutions
> (R-1 … R-5) settling points where this document and `ARCHITECTURE.md` disagreed or were
> silent. **R-1 replaces the precedence rule in §10 below**: the rule is now *this document
> wins on any technology name; `ARCHITECTURE.md` wins on any behaviour.* R-2 (pg-boss is the
> only enqueue mechanism), R-3 (scope-resolver enforcement), R-4 (no encryption at rest on
> the mobile database) and R-5 (evidence redaction) refine §5 and §7.

---

## 1. The two rules that explain every other decision

1. **The VM is the production data host.** PostgreSQL, private object storage and encrypted
   pgBackRest backups all use its disk. Included weekly VPS backups provide the only separate
   copy at launch. A total VPS loss can lose up to one week of changes (R-27); monitor disk
   use and rehearse full restores before accepting production data.
2. **Authorization correctness is the dominant risk.** Not performance, not scale. Four
   roles with resource-level scope rules, and an explicit threat model naming IDOR and
   cross-Unit access. Every endpoint is guarded by default; an unguarded endpoint is a bug,
   not a shortcut.

---

## 2. Stack

| Layer | Technology |
|---|---|
| Field mobile | React Native 0.8x + Expo (prebuild / custom dev client), TypeScript, expo-router |
| Camera | `expo-camera` (in-app live capture only — no gallery path). Superseded react-native-vision-camera; see `DECISIONS.md` R-11 |
| Location | expo-location |
| Offline store | expo-sqlite + Drizzle (SQLite dialect) + hand-written `outbox` and `media_queue` |
| Mobile state | Zustand (UI) + TanStack Query (server cache) |
| Mobile secrets | expo-secure-store (Android Keystore / iOS Keychain) |
| OTA updates | EAS Update (free tier) |
| Admin web + corrective-action page | React 19 + Vite 7 SPA, **no SSR** |
| Web routing / data | TanStack Router + TanStack Query |
| Web UI | Tailwind + shadcn/ui, Recharts, react-hook-form + Zod |
| API | NestJS 11 on the **Fastify** adapter, Node 22 LTS, modular monolith, one image, three entrypoints |
| API validation | Zod via nestjs-zod, schemas imported from `packages/contracts` |
| Database | PostgreSQL 18, self-hosted in Docker, RLS enabled, pinned major version |
| Extensions | pgcrypto, pg_trgm, uuid-ossp — **no others without a decision** |
| ORM | Drizzle ORM + drizzle-kit (pg dialect on server, sqlite dialect on mobile) |
| Queue / jobs | pg-boss on the same PostgreSQL. **No Redis.** |
| PDF reports | Playwright + chrome-headless-shell, dedicated worker, concurrency 1 |
| Authentication | Custom JWT — Argon2id, 15-min access, rotating single-use refresh with no time limit (`DECISIONS.md` R-21), JTI denylist, device binding, offline unlock |
| Authorization | Application `ScopeGuard` (canonical) + Postgres RLS (defence-in-depth) |
| Object storage | Single-node MinIO AIStor Free on the VPS, private S3 bucket via `@aws-sdk/client-s3` |
| Push | Firebase Cloud Messaging, behind a `PushChannel` adapter |
| WhatsApp / SMS | `NotificationChannel` interface; not wired at MVP |
| Compute | Hostinger VPS KVM 2, 2 vCPU / 8 GB / 100 GB NVMe, x86-64 |
| Static hosting | Caddy serves the Vite SPA on the VPS |
| Edge and ingress | Registrar DNS → Caddy on ports 80/443, automatic HTTPS; API rate limits remain |
| Backups | Encrypted pgBackRest POSIX repository on the VPS; included weekly VPS backups are the separate copy |
| Monitoring | BetterStack free (uptime) + Sentry free (errors) + backup-age alarm |
| CI/CD | GitHub Actions → buildx linux/amd64 → GHCR → `docker compose pull && up -d` |
| Containers | Docker + Docker Compose, seven services. **Not Kubernetes.** |
| Infra as code | `docker-compose.yml` + `bootstrap.sh` in git. No Terraform. |

---

## 3. Repository layout

```
audit5s/
├─ apps/
│  ├─ api/                 NestJS — api, worker-general, worker-report entrypoints
│  ├─ admin-web/           React + Vite SPA (includes the corrective-action route)
│  └─ field-mobile/        React Native + Expo
├─ packages/
│  ├─ contracts/           Zod schemas + inferred types — THE reason TypeScript won
│  ├─ domain/              Scoring, state machines. Pure, no IO. 90% coverage target.
│  └─ db/                  Drizzle schema + SQL migrations
├─ infra/                  compose, bootstrap.sh, pgbackrest conf, runbooks
├─ docker-compose.yml
└─ pnpm-workspace.yaml
```

pnpm workspaces. **No Turborepo** until CI exceeds ~10 minutes.

### The contracts rule

`packages/contracts` is the single definition of every type crossing an app boundary:
checklist and question models, question responses, sync envelopes, idempotency key shapes,
API request/response types. `packages/domain` holds scoring rules and state machines as
pure functions.

**Never define a shared type twice.** If mobile and API both need it, it belongs in
`contracts`. If you find yourself copying a type between apps, stop and move it.

---

## 4. Where things run

All services run on the VPS. Seven containers, `mem_limit` on every one:

```
postgres        postgres:18-alpine     2304m   volume: pgdata (NVMe)
api             ghcr.io/…:sha          768m    node dist/main
worker-general  ghcr.io/…:sha          512m    node dist/worker.general
worker-report   ghcr.io/…:sha          1536m   node dist/worker.report
pgbackrest      pgbackrest:…           384m    volume: backuprepo
object-storage  quay.io/minio/aistor   768m    volume: objectdata
caddy           ghcr.io/…:sha          128m    HTTPS, SPA, API and S3 ingress
```

Caddy is the only public container. The MinIO console and PostgreSQL stay private.

---

## 5. Non-negotiable implementation rules

### Security and authorization
- Guards are global and composed: `JwtAuthGuard → PermissionGuard → ScopeGuard`. Opting an
  endpoint out is explicit and must be justified in the PR.
- Scope resolvers are DI-injected classes, unit-tested in isolation against fake
  repositories. The authorization suite is the most important test suite in the project.
- RLS policies are written from day one, not retrofitted. They are defence-in-depth behind
  the application guards, never the only line.
- Passwords: Argon2id. Refresh tokens: single-use, rotating, with reuse detection that
  revokes the entire token family.

### Data integrity
- **Nothing is hard-deleted.** Append-only tables enforce this with `BEFORE UPDATE` /
  `BEFORE DELETE` triggers that raise. This is a database guarantee, not a convention.
- **Scoring is server-authoritative.** Client-submitted scores are inputs to be recomputed,
  never stored as truth.
- **Idempotency keys on every mutating endpoint**, from the first commit. Retrofitting this
  into an offline client already in the field means a forced app update.
- `timestamptz` everywhere, stored in UTC.
- The NA-excluded scoring denominator is implemented once, in `packages/domain`, and used
  by both server and client. In SQL it maps to `FILTER (WHERE response <> 'NA')`.

### Media
- **Media never transits the API.** Presigned PUT to upload (minted only after a scope
  check), short-TTL presigned GET (≤5 min) to download.
- No public buckets, ever.
- Client downscales to ≤1920px long edge at ~80% JPEG *before* writing to local storage.
- On upload completion the server validates content-type by magic bytes (not extension),
  re-encodes to strip EXIF (GPS is stored in the DB, not the file), enforces a size cap,
  and records the SHA-256.
- Object key is stable and content-addressed:
  `unit/{unitId}/audit/{auditId}/{sha256}.jpg` — re-uploads are harmless overwrites.
- **Local files are deleted only after the server confirms the Evidence row is committed.**

### Jobs
- Every job is async and retryable. No external HTTP call inside a database transaction.
- Enqueue happens in the same transaction as the domain write — that is why pg-boss was
  chosen, and it is why there is no separate transactional-outbox dispatcher.
  *(See `DECISIONS.md` R-2: this guarantee is asserted by a permanent rollback test, and
  must be verified against the pinned pg-boss version at build step 3.)*
- Set a pg-boss archive-retention policy on day one, or completed jobs become the largest
  table in the database.

### PDF rendering
- Never render inside an HTTP request. The API enqueues `report.render` and returns 202.
- `worker-report` only: concurrency 1, `mem_limit: 1536m`, `--disable-dev-shm-usage`,
  `--shm-size=256m`, 120s job timeout, one retry, then a visible dead-letter.
- Set `oom_score_adj` low on Postgres so the kernel never chooses it as the OOM victim.
- Report templates are React → HTML → CSS `@page` and must stay **free of
  JavaScript-dependent layout**, so a swap to WeasyPrint stays a renderer change rather
  than a rewrite.

### Offline behaviour (mobile)
- Offline login works against a device-bound Argon2id verifier held in the OS keystore,
  for a 7-day window, then requires a network login.
- The active ChecklistVersion is cached locally; the questionnaire never needs a network
  call.
- SQLite writes are committed **per question response**, not per section. A crash loses at
  most the field being typed.
- On restart, resume from the audit's `resume_cursor` to the exact section/question.
- Back button navigates questions and never discards. Leaving requires an explicit Pause
  (`IN_PROGRESS → PAUSED`), which never deletes.
- Sync indicator states: `Synced` · `N pending` · `Syncing…` · `N failed — tap to retry`.
- Backoff is exponential with jitter: 1s, 2s, 4s … capped at 5 min.

---

## 6. Do not add

Each of these has a defined trigger. Absent the trigger, adding it is strictly negative.

| Do not add | Add when |
|---|---|
| Redis | Sustained >100 jobs/sec, or multiple API replicas needing shared cache |
| Kubernetes / K3s / Nomad | >5 nodes with genuine bin-packing needs (probably never) |
| Microservices | A module has a different scaling profile *and* an independent team |
| Kafka / RabbitMQ / NATS | >10k events/sec (currently ~200 jobs/**day**) |
| Elasticsearch | Full-text search becomes a top-3 user request (pg_trgm + GIN until then) |
| Postgres read replica | Analytics measurably contends with transactional load |
| Separate analytics DB | Analytics exceeds ~2s after indexing and materialised rollups |
| Terraform / Pulumi | >1 environment or >1 person provisioning |
| Turborepo / Nx | CI exceeds ~10 minutes |
| Prometheus + Grafana + Loki | You have an on-call rotation |
| Managed auth (Clerk/Auth0/Cognito) | Never — offline login rules it out |
| GraphQL / gRPC | Never at this stage — two clients you own, no service-to-service traffic |
| Server-side rendering (Next.js) | Never for the admin dashboard — it is login-gated, no SEO, no anonymous first paint |
| Vercel / Netlify | Never — Caddy serves the built SPA on the VPS |
| iOS app | Android is validated with real auditors in a real plant |

### The host do-not-touch list

Application code must never name the hosting provider. That
is what keeps a host migration a ~40-minute job instead of a refactor. The Oracle →
Hostinger move of 2026-09-17 is the proof: it changed `infra/`, CI and these documents, and
not one line under `apps/` or `packages/`.

Enforced by a CI grep and an ESLint `no-restricted-imports` rule for `oci-`,
`oraclecloud.com`, `@oracle/` and `hostinger` in `apps/` and `packages/`.

**Forbidden from application code:** any provider SDK or CLI call · provider object storage
· provider Vault/KMS · provider managed database · provider load balancer, DNS, functions,
streaming, email, queue or API gateway · provider-flavoured Terraform.

**Permitted from the provider:** a VM, its disk, firewall, and the included VPS backup
service (R-27). Application code does not integrate with provider APIs.

---

## 7. Build order

1. `packages/contracts` and `packages/db` — schema, migrations, RLS policies, append-only
   triggers. Everything else depends on these.
   *(`DECISIONS.md` R-5: the append-only `BEFORE UPDATE` trigger on `evidence` carves out the
   three redaction columns **here**, not later. R-3a: invariant M-1's partial unique index
   ships in this first migration, with a test.)*
2. `packages/domain` — scoring (including the NA-excluded denominator), state machines.
   Pure functions, 90% coverage, no IO.
3. API skeleton — global guard chain, scope resolvers, **the authorization test suite**,
   `/health`, idempotency middleware.
   *(`DECISIONS.md` R-2: the pg-boss transactional-enqueue rollback test lands here.)*
4. Auth — registration/bootstrap credential (72-hour expiry, forced reset), login, refresh
   rotation with reuse detection, JTI denylist, device binding.
5. Core CRUD — Unit → Zone → membership and consultant assignment.
6. Checklist model and versioning + Excel import (`worker-general`).
7. Mobile shell — offline SQLite schema, outbox, media queue, sync worker, offline unlock.
8. Audit capture flow — questions, evidence capture, GPS, selfie, pause/resume.
9. Admin web — dashboards, audit review, approvals.
10. Reports — `worker-report`, templates, signed corrective-action links.
11. Corrective action flow — token-gated SPA route.
12. Notifications — FCM behind the adapter.

Infrastructure (`bootstrap.sh`, compose, local pgBackRest, the backup-age alarm) is set up
alongside step 3, not at the end. **Backups cannot be retrofitted after data loss.**

---

## 8. Operational tripwires

Raise these to the owner rather than working around them:

- **Available RAM drops below ~4 GB** → switch the report worker to WeasyPrint. Templates
  are HTML/CSS either way, so keep them JS-free in layout.
- **Multi-device concurrent editing of one audit is requested** → the hand-written outbox
  design assumes one device owns an in-progress audit. This assumption must not be relaxed
  casually.
- **Real-time collaborative auditing is requested** → say no. It requires CRDTs and is a
  different product.
- **A second organization is signed** → multi-org tenancy is additive but touches every
  scope predicate. Design it by Stage 2.
- **CI exceeds 10 minutes** → add Turborepo (a drop-in, not a migration).

---

## 9. Facts about the environment

- **The host is a Hostinger VPS KVM 2**, not the Oracle Ampere A1 this document was
  originally sized against (superseded 2026-09-17). Two consequences follow, and they are
  the reason for every memory number below.
- **x86-64, not ARM.** Images are built `linux/amd64`. An arm64 image will not run here.
- **8 GB, not 12 GB.** Ubuntu 26.04.1 LTS reports 7.7 GiB total and 7.4 GiB available at
  idle (393 MiB for the OS), measured on the host 2026-09-17. Seven container ceilings now
  total 6400m (~6.25 GiB), leaving ~1.15 GiB of headroom at that idle measurement.
  Keep 4 GB of swap and `vm.swappiness=10`; verify peak memory during simultaneous
  uploads, backup and report rendering before production use.
- **2 vCPU is less compute than Oracle's 2 OCPU**, which were physical cores. These are
  shared threads. `worker-report` (headless Chromium, concurrency 1) is the container that
  feels it; if renders start hitting the 120s job timeout, raise the timeout before
  raising concurrency.
- Migration targets if this host is outgrown: Netcup (~₹318), Contabo India (~₹399),
  DigitalOcean Bangalore, or Lightsail Mumbai. Hetzner's shared-vCPU plans were
  unavailable as of 2026-09-04.
- A 100 GB disk cannot satisfy seven years of evidence retention indefinitely. Alert at
  70% use and expand capacity before 80%; do not auto-delete evidence to free space.
- Included weekly VPS backups are the disaster copy. Local WAL archive timeout remains
  60s for recoverable database failures; a whole-VPS loss can lose up to a week of data.
- A quarterly restore drill is mandatory. Restore the local pgBackRest repository into a
  scratch database and check object files. Rehearse the provider snapshot restore before
  accepting live data and whenever a spare host is available thereafter. Record the
  backup timestamp and wall-clock time. **An untested backup is a rumour.**

---

## 10. Working agreement

- Prefer a smaller diff that keeps the guard chain intact over a larger one that bypasses
  it "temporarily."
- If a task requires adding a dependency in the "do not add" table, stop and ask.
- ~~If `ARCHITECTURE.md` and this document disagree on infrastructure, this document wins.
  On domain model, authorization, state machines and the sync protocol,
  `ARCHITECTURE.md` wins.~~ **Superseded by `DECISIONS.md` R-1:** this document wins on any
  technology name; `ARCHITECTURE.md` wins on any behaviour. The complete list of superseded
  names is the *Superseded technology choices* table at the top of `ARCHITECTURE.md`.
- If something in either document is ambiguous, say so rather than picking silently — the
  ambiguities that matter here are the ones in the authorization matrix.
