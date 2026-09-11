# Handoff to Claude Code — Phase 5 complete, CI checkout needs correction

Read `AGENTS.md`, `STACK.md`, `DECISIONS.md` R-12, and `HANDOFF.md` before changing code.
`HANDOFF-PHASE5.md` is the historical backend-only handoff; its “web/mobile not started”
status is superseded by this file.

## Repository state

- Working branch: `codex/Krishna`.
- Implementation head before this handoff: `8ab2adf`.
- Writable remote: `fork` (`https://github.com/krxna/audit5s.git`).
- `origin` (`team-abassociate/audit5s`) rejects the configured `krxna` credential with
  HTTP 403. Do not change remotes or credentials silently.
- No PR has been opened.

## Completed work

Phase 5 is complete across mobile, web, acceptance, smoke, and documentation:

1. `f0286f8` — offline-first walk-by mobile flow, using the existing camera and outbox.
   It includes description/leader snapshots, photo preview/delete, remarks,
   reclassification, summary flags, and the local photo completion gate.
2. `2b0f1ae` — cursor-paged admin evidence gallery, server-side Zone/classification/flag
   filters, thumbnail tiles, an original-on-demand viewer, and `Audit.scored` rendering.
3. `e3820cf` — Phase 5 acceptance using the real mobile repositories and `runSync`. The
   module-level offline switch makes every HTTP request throw. Three photographed Zones
   complete and sync; flag limits hold; the empty fourth Zone is rejected locally and is
   dead-lettered when deliberately pushed past the client gate.
4. `8ab2adf` — live walk-by/gallery smoke coverage and Phase 5 docs. The smoke work also
   fixed script-relative fixture lookup, configurable Chromium selection, two missing
   React list keys, and cross-origin rendering of signature-authorized local evidence.

No dependency or migration was added. `0009` remains the next migration. Q2, Q5, and Q8
remain unanswered and use the documented defaults.

## Verification already completed

- `pnpm lint` — clean.
- `pnpm -r typecheck` — clean.
- `pnpm -r build` — clean; only the existing Vite/Zod annotation and chunk-size warnings.
- `pnpm -r test` — 461 unit tests passed.
- API E2E — 428 tests passed across 20 files, including Phase 5 acceptance.
- `expo export --platform android` — passed (1,634 modules).
- Fresh migrated/seeded live stack — `smoke.mjs` and `smoke-audit.mjs` both passed with no
  browser console errors. Screenshots 20 and 21 verified the filtered flagged gallery and
  a fully decoded original in the viewer.
- Database tests ran on local PostgreSQL 17. Production and CI remain pinned to 18; no
  PostgreSQL-17-specific behavior was introduced.

## GitHub Actions API image failure

The supplied failed build record reports this exact layer:

```text
process "/bin/sh -c pnpm install --frozen-lockfile --prod" ... exit code: 1
```

That command proves the Actions checkout did not contain `30ef4fa` (`Fix non-interactive
production install in API image`). The current Dockerfile instead has:

```dockerfile
RUN CI=true pnpm install --frozen-lockfile --prod
```

The current branch was built locally with the same requested platform:

```text
docker build --platform linux/arm64 -f infra/docker/api.Dockerfile -t audit5s-api:phase5 .
image: sha256:57a023df02e3261f4c831c6f1fe05ad5dae40cfded653e34ca93f9cb6e44cc70
architecture: arm64
```

Both dependency installs, compilation, the corrected production prune, runtime copies,
and image export succeeded. The ignored `argon2`, `@swc/core`, and `esbuild` build-script
warning is expected per the project brief; do not “fix” it with `pnpm approve-builds`.

## Next action

Check the failed Actions run SHA and its source branch. Ensure that branch contains
`30ef4fa` (or the complete `codex/Krishna` history), then rerun the API image job. If the
target is under `team-abassociate/audit5s`, upstream write access or a maintainer merge is
required because the current credential cannot push there.
