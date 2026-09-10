# audit5s

Production-grade 5S Audit Management Platform — admin web portal, offline-first field mobile
application, and a NestJS/PostgreSQL backend.

## Architecture

The complete design and implementation blueprint lives in **[ARCHITECTURE.md](./ARCHITECTURE.md)**:
domain model, authorization matrix, state machines, database schema, REST API, offline
synchronization protocol, reporting pipeline, analytics, security review, repository layout,
a nine-phase roadmap, testing strategy and the production-readiness checklist.

Read PART 1 first — it settles the vocabulary and every contradiction in the source
requirements, and its decisions are binding.

Five points where the blueprint and the engineering handoff disagreed or were silent are
settled in **[DECISIONS.md](./DECISIONS.md)** (R-1 … R-5). The precedence rule is: **the
handoff wins on any technology name, `ARCHITECTURE.md` wins on any behaviour.** The complete
list of superseded technology choices is at the top of `ARCHITECTURE.md`.

## Status

Architecture approved. Implementation begins at PART 14, Phase 1.
