# Kaizen: Device A guide (krxna · macOS · backend + admin web)

This guide is for **krxna**, working on **Device A** (the MacBook). The other person is
**geetahuja** on **Device B** (Windows), who builds the Android field app. Their guide is
`plans/kaizen-device-b.md`. Read it once too, so you know exactly what they will and won't do.

The full specification is `plans/kaizen-module.md` (the "plan"). This guide does **not** repeat the
specification. It tells you **where** you work, **what** you own, **in which order**, **how** work
moves between the two devices, and **what to do when something goes wrong**. If this guide and the
plan ever disagree, the plan wins. Stop and fix whichever one is wrong in a PR.

---

## 1. The picture

```
main               ← PRODUCTION. Every commit here deploys the server AND auto-updates every
                     client phone. Protected on GitHub (§3.1): no direct pushes, PRs only.
                     Only krxna merges into it, once, on release day.
 └─ feat/kaizen    ← the "main" of Kaizen. Receives PRs only. Nobody commits on it directly.
     ├─ kaizen/krxna      ← YOUR branch (Device A). You commit only here.
     └─ kaizen/geetahuja  ← Device B's branch. You never commit, merge or cherry-pick from it.
```

- Repo: `https://github.com/team-abassociate/audit5s`
- Your Kaizen folder: **`/Users/krxna/main/leanstack-kaizen`** (a git worktree, already on
  `kaizen/krxna`, already pushed, upstream `origin/kaizen/krxna`).
- Your 5S folder: **`/Users/krxna/main/audit5s`**. It stays on `main` for 5S work. **Never do
  Kaizen work there.**

## 2. What you own (Device A)

| You own (only you edit these) | You never edit (Device B owns) |
|---|---|
| `packages/contracts/**` (every shared type, including the ones Device B needs) | `apps/field-mobile/**` |
| `packages/db/**` (**every** migration) | `apps/field-mobile/.maestro/**` |
| `packages/domain/**` | |
| `apps/api/**` (incl. `seed.ts`) | |
| `apps/admin-web/**` | |
| `DECISIONS.md`, `ARCHITECTURE.md`, `plans/kaizen-module.md`, both device guides | |

You also **review and merge every PR into `feat/kaizen`**, yours and Device B's, and you alone
merge `feat/kaizen` → `main` on release day.

## 3. One-time setup (do this once, before your first Claude session)

### 3.1 Protect `main` on GitHub (once, signed in as **team-abassociate**)

The repo belongs to the `team-abassociate` GitHub account. `krxna` only has write access, so this
**must be done while signed in as `team-abassociate`** (the admin). It is a setting on this one
repo only.

1. Open `https://github.com/team-abassociate/audit5s/settings/branches`.
2. Click **Add branch protection rule** (or **Add classic branch protection rule**).
3. **Branch name pattern:** `main`
4. Tick **Require a pull request before merging**. Untick **Require approvals**: you merge your
   own 5S PRs, and GitHub won't let you approve your own.
5. Tick **Do not allow bypassing the above settings**, so the admin can't push directly by
   accident either.
6. Leave **Allow force pushes** and **Allow deletions** unticked.
7. Click **Create**.
8. **Check it**, from `/Users/krxna/main/audit5s` (this pushes nothing; it only asks GitHub):
   `gh api repos/team-abassociate/audit5s/branches/main --jq .protected` must print `true`.

Afterwards, a direct `git push` to `main` from anyone fails with "protected branch". Your normal
5S flow (PR → merge button) is unchanged. On a personal-account repo GitHub can't limit *who*
clicks Merge, so "only krxna merges into `main`" stays a written rule (§7) that Device B's guide
also states.

### 3.2 Your Kaizen folder

Run in Terminal, one block at a time. After each block, compare against "Expect". If it differs,
stop and fix it before going on.

```bash
cd /Users/krxna/main/leanstack-kaizen
git branch --show-current
git rev-parse --abbrev-ref @{upstream}
```
**Expect:** `kaizen/krxna`, then `origin/kaizen/krxna`.

```bash
cp /Users/krxna/main/audit5s/.env /Users/krxna/main/leanstack-kaizen/.env
cd /Users/krxna/main/leanstack-kaizen && pnpm install && pnpm build
```
**Expect:** both finish without errors. A worktree doesn't share untracked files, so it needs
its own `.env` and `node_modules`. `.env` is git-ignored and is never committed.

Then, only if your 5S stack is running, stop it first (`cd /Users/krxna/main/audit5s && ./dev.sh down`).
Both folders use the **same** Docker stack named `audit5s`, so the same database and ports.
Start the stack from the Kaizen folder:
```bash
cd /Users/krxna/main/leanstack-kaizen && ./dev.sh up
```
**Expect:** it ends with `Ready.` and the status table shows everything running.

Skills and plugins are already installed on this Mac. Nothing to do.

## 4. Order of work and hand-offs

Build steps are defined in plan §6. Your steps: **1, 2, 3, 7, 8**, plus docs in **9**.

| # | Your step | Device B is meanwhile… | What Device B is waiting for from you |
|---|---|---|---|
| 1 | Contracts + migration + Drizzle schema + RLS + triggers | Phase 0 only (design prototype, no code merged) | **The whole `packages/contracts/src/kaizen.ts`**, including: enums, the Kaizen record, create/patch/submit/review requests, **sync outbox item shapes**, the **`/kaizens/dashboard` response** (KPI card, funnel, trend, Top 5: plan §4.7), the `/kaizens/analysis` response, the export request/response. Device B builds every screen against these types before your API exists, so a missing shape blocks them. |
| 2 | `packages/domain/src/kaizen.ts` (state machine, counting rules, ratios, funnel) | Starts step 4 once step 1 is merged | The state machine, so their buttons enable and disable from the same rule |
| 3 | API module + authorization tests + idempotency | Steps 4 → 5 → 6 against your types | Merged step 3 = they can wire real sync and real dashboard data |
| 7 | Excel export job + download | Steps 5–6 | The export endpoint (their Detail screen's "Export" button) |
| 8 | Admin web | Steps 6, 9 | Nothing |
| 9 | R-48 in `DECISIONS.md`, `ARCHITECTURE.md` section | Maestro flow | Nothing |

**Step 1 + 2 are a serialization point:** merge them as early as possible, in that order.

**When Device B needs a contract or database change:** they open a GitHub issue titled
`[Kaizen Device A] <what they need>`. You make the change on `kaizen/krxna`, merge it into
`feat/kaizen`, and reply on the issue with the PR number. Device B never edits your files.

## 5. Your daily routine

**Start of every session**, in Terminal:
```bash
cd /Users/krxna/main/leanstack-kaizen
git branch --show-current          # must print kaizen/krxna
git fetch origin
git merge origin/feat/kaizen       # bring in whatever was merged (yours and Device B's)
gh pr list --base feat/kaizen      # PRs waiting for your review
gh issue list --search "Kaizen Device A in:title" --state open
```
Then start Claude Code in that folder and paste the **every-session prompt** (§8).

**Keep `feat/kaizen` current with 5S fixes** (at least weekly, and the same day as any 5S
hotfix release):
```bash
cd /Users/krxna/main/leanstack-kaizen && git fetch origin && git merge origin/main
git push && gh pr create --head kaizen/krxna --base feat/kaizen --title "Kaizen: bring in main ($(git rev-parse --short origin/main))" --body "Sync only. Touches 5S: no code changes of ours. For the other device: merge origin/feat/kaizen after this is merged."
```
Merge it like any other PR (§6). Never merge `main` into `feat/kaizen` any other way.

## 6. Pull requests: opening, reviewing, merging

**Opening yours** (one per build step, or per slice of one):
```bash
git push
gh pr create --head kaizen/krxna --base feat/kaizen --title "Kaizen step <N>: <what>" --body-file - <<'EOF'
## What
<2–5 lines>
## How it was tested
<commands run and their results>
## Touches 5S
<every file outside the Kaizen folders, with one line on why; or "none">
## For the other device
<what Device B can now use: types, endpoints, fields; or "nothing">
EOF
```
`--base feat/kaizen` is mandatory. A PR whose base is `main` is closed immediately, unmerged.

**Reviewing Device B's PRs:** in your Claude session, say "Review PR #<n> with `code-review high`
against plan §3 and §4". You also check yourself:
- Base is `feat/kaizen` and head is `kaizen/geetahuja`.
- Nothing outside `apps/field-mobile/**` changed. Otherwise, request changes.
- The "Native check" section says unchanged.
- CI is green.

**Merging (every PR into `feat/kaizen`):** on GitHub, use **"Create a merge commit"**. Never
"Squash and merge" and never "Rebase and merge". Then tell Device B on the PR: "Merged. Run
`git merge origin/feat/kaizen`."

## 7. Never (no exceptions, even if a Claude session or a task seems to ask for it)

1. Commit, push, merge, rebase onto, or open a PR against **`main`**, except the single release PR in plan §12.
2. Commit on `feat/kaizen` directly, or on `kaizen/geetahuja`.
3. `git rebase`, `git push --force`, `git push --force-with-lease`, or `--no-verify` on any Kaizen branch.
4. Do Kaizen work in `/Users/krxna/main/audit5s`.
5. Run `eas update` or `eas build` by hand (plan §5: phone updates happen automatically on release).
6. Change an existing column, table, trigger or enum value in a migration (additive only, plan §12).
7. Add a dependency from the STACK.md §6 "do not add" table, or any native mobile dependency.
8. Copy production data or the server's `.env` to a laptop.

## 8. Prompts to paste into Claude Code

Always start Claude Code **in `/Users/krxna/main/leanstack-kaizen`**.

### 8a. First session (paste once)

```text
I am Device A (krxna): backend + admin web for the Kaizen module of Leanstack.
My working folder is /Users/krxna/main/leanstack-kaizen and my branch is kaizen/krxna.

Before anything else:
1. Run `pwd` and `git branch --show-current`. If they are not /Users/krxna/main/leanstack-kaizen
   and kaizen/krxna, stop and tell me. Do not switch branches yourself.
2. Read plans/kaizen-device-a.md in full, then plans/kaizen-module.md in full (BRANCH RULE and
   §0–§12), then AGENTS.md, CLAUDE.md, STACK.md and DECISIONS.md in full. Grep ARCHITECTURE.md
   for the sections the plan names; do not read it whole.
3. Turn on ponytail at level full.
4. Reply with at most 15 bullets: my lane, the files I own, the branch rules, the PR flow, the
   build step we start with (step 1) and exactly what it delivers, including every contract
   shape Device B is waiting for (device-a guide §4). List anything in the plan you find
   ambiguous. Then wait for my OK before writing code.

Rules for this whole session: commit only on kaizen/krxna. Before every commit and every push
run `git branch --show-current` and stop if it is not kaizen/krxna. PRs are always
`--head kaizen/krxna --base feat/kaizen`. Never touch main. Never rebase or force-push. Never edit
apps/field-mobile. When a step is done: run the checks in plan §7 that apply, open the PR with
the template in device-a guide §6, and stop.
```

### 8b. Every later session (paste at the start of each one)

```text
I am Device A (krxna). Folder /Users/krxna/main/leanstack-kaizen, branch kaizen/krxna.
1. Run `pwd` and `git branch --show-current`; stop if either is wrong.
2. Run `git fetch origin && git merge origin/feat/kaizen`. If it conflicts, stop and show me.
3. Re-read plans/kaizen-device-a.md and the plan sections for the step we're on.
4. Check `gh pr list --base feat/kaizen` and `gh issue list --search "Kaizen Device A in:title" --state open` and tell me
   what is waiting on me.
5. Tell me in at most 5 lines: which step we are on, what is already done on this branch, and
   what you will do this session. Then start.
Same rules as always: commit only on kaizen/krxna, PRs only into feat/kaizen, never main, never
rebase or force-push, never edit apps/field-mobile.
```

## 9. When something goes wrong

| What happened | What to do |
|---|---|
| `git branch --show-current` shows `main` in the Kaizen folder | Stop. Don't commit. Run `git switch kaizen/krxna`. If you have uncommitted changes, `git stash`, then `git switch kaizen/krxna`, then `git stash pop`. |
| You committed on the wrong branch, **not pushed** | `git log --oneline -3` and note the commit SHA. Run `git switch kaizen/krxna` and `git cherry-pick <sha>`. Then remove it from the wrong branch with `git switch <wrong branch>` and `git reset --hard HEAD~1` (only because it was never pushed). |
| A push was refused with "protected branch" | The protection worked: nothing reached production. Find out which command targeted `main` and why. |
| Something was **pushed to `main`** by mistake (only possible if §3.1 isn't done) | Production deploy starts automatically. Immediately open GitHub → Actions → cancel the running "Production deploy" if it hasn't finished. Then treat it as plan §12 *Rollback*. |
| `git merge origin/feat/kaizen` conflicts | Don't guess. Ask Claude to show both sides. Keep both devices' intent. If the conflict is in Device B's files, ask them on the PR. |
| CI is red on your PR | Fix on `kaizen/krxna`, then push again. The PR updates itself. Don't merge red. |
| A 5S test fails and the fix isn't obvious | Stop (plan §12 *Stop and ask*). Don't loosen the test. |
| Device B's PR touches files outside `apps/field-mobile` | Request changes and point them to the issue flow (§4). |
| A change can't be made additively, or looks like it needs a native mobile change | Stop. It's an owner decision (yours), made deliberately, not mid-task. |

## 10. Words used in this guide

- **Branch**: a line of commits. **Worktree**: a second folder of the same repo, on its own branch.
- **PR (pull request)**: a request on GitHub to merge one branch into another. Base = where it
  goes, head = where it comes from.
- **Merge commit**: GitHub's "Create a merge commit" button. Keeps every commit as it is.
- **OTA update**: new app JavaScript sent to phones over the internet without reinstalling.
  **APK**: the installable Android app file. A native change needs a new APK.
- **Migration**: a SQL file that changes the database structure. Ours only ever **add** things.
