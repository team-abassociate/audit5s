# CLAUDE.md

> **Kaizen branch rule (changed by the owner, 2026-10-10):** open Kaizen PRs from your device
> branch (`kaizen/krxna` on Device A, `kaizen/geetahuja` on Device B) **straight into `main`**.
> `feat/kaizen` is retired. `main` still deploys to the production VPS that clients use for 5S,
> so merging into `main` is a release: green CI first, and only with the owner's go. Plan:
> [`plans/kaizen-module.md`](plans/kaizen-module.md) (BRANCH RULE).

**Read [`AGENTS.md`](./AGENTS.md) first.** It is the single brief for every agent working
in this repository — the document precedence rule, the rules that may not be broken, the
build order, and how to behave when several agents run in parallel. Everything in it
applies to you. It is not duplicated here, for the same reason the codebase never defines
a shared type twice.

Claude-specific notes only:

- **Do not read `ARCHITECTURE.md` whole.** It is 225 KB. Grep for the section you need
  (`§5.6`, `§6.2`, the superseded-technology table) and read that.
- **`STACK.md` and `DECISIONS.md` are short — read them in full** at the start of any task
  that writes code.
- When a task spans more than one build step from `AGENTS.md`, plan it out before editing,
  and say which step you are on.
- This repository is at the specification stage. If you are asked to write the first code,
  it starts at build step 1 (`packages/contracts` and `packages/db`) unless told otherwise.
