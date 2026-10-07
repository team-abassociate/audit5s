# Kaizen: Device B guide (geetahuja · Windows · Android field app)

This guide is for **geetahuja**, working on **Device B** (Windows). The other person is **krxna**
on **Device A** (Mac), who builds the database, the API and the admin website, and who reviews
and merges your work. Their guide is `plans/kaizen-device-a.md`.

The full specification is `plans/kaizen-module.md` (the "plan"). This guide does **not** repeat
the specification. It tells you **where** you work, **what** you own, **in which order**, **how**
your work reaches krxna, and **what to do when something goes wrong**. If this guide and the plan
ever disagree, the plan wins. Tell krxna, who fixes whichever one is wrong.

**Your audit5s setup on this machine already works.** Nothing in this guide reinstalls Node,
pnpm, Docker, Android tooling or your `.env`. You only add one folder, one branch and a few
Claude Code skills.

---

## 1. The picture

```
main               ← PRODUCTION. Every commit here deploys the server AND auto-updates every
                     client's phone. Protected on GitHub: nobody can push to it directly.
                     You never touch it in any way.
 └─ feat/kaizen    ← the "main" of Kaizen. Receives pull requests only. krxna merges them.
     ├─ kaizen/geetahuja  ← YOUR branch. You commit only here.
     └─ kaizen/krxna      ← krxna's branch. You never commit to it, merge from it or copy from it.
```

- Repo: `https://github.com/team-abassociate/audit5s`
- Your 5S folder: your existing `audit5s` folder. It stays exactly as it is. **Never do Kaizen
  work in it.**
- Your Kaizen folder: **`leanstack-kaizen`**, created in §3 right **next to** your `audit5s`
  folder (same parent folder). Example: if `audit5s` is `C:\Users\you\projects\audit5s`, the Kaizen
  folder is `C:\Users\you\projects\leanstack-kaizen`.

## 2. What you own (Device B)

| You own (only you edit these) | You never edit (krxna owns) |
|---|---|
| `apps/field-mobile/**` | `packages/contracts/**`, `packages/db/**` (all migrations), `packages/domain/**` |
| `apps/field-mobile/.maestro/**` | `apps/api/**`, `apps/admin-web/**` |
| | `DECISIONS.md`, `ARCHITECTURE.md`, everything in `plans/`, `pnpm-lock.yaml`* |

\* `pnpm-lock.yaml` changes only when a dependency is added. **You add no dependency at all**
without krxna's written OK (plan §3, §5). A new native one means every client must reinstall the app.

**Need something in krxna's files** (a new field, a changed type, a new endpoint)? Don't edit them,
and don't work around them. Open a GitHub issue (website: repo → **Issues** → **New issue**) titled
**`[Kaizen Device A] <what you need>`**, explain why, and carry on with something else. krxna replies
on the issue with the PR number once it's merged into `feat/kaizen`.

## 3. One-time setup

Open **PowerShell** and go to your existing `audit5s` folder (`cd <path to your audit5s folder>`).
Run each block, then compare against "Expect". If anything differs, **stop and message krxna**
with a screenshot. Don't improvise.

**3.1 Check the starting point**
```powershell
git status
git remote get-url origin
```
**Expect:** `git remote get-url origin` prints `https://github.com/team-abassociate/audit5s.git`
(or the `git@github.com:` form of it). `git status` may show anything; this folder isn't
touched.

**3.2 Create your Kaizen folder and branch**
```powershell
git fetch origin
git worktree add ..\leanstack-kaizen -b kaizen/geetahuja origin/feat/kaizen
cd ..\leanstack-kaizen
git push -u origin kaizen/geetahuja
git branch --show-current
git rev-parse --abbrev-ref "@{upstream}"
```
**Expect:** the last two lines print `kaizen/geetahuja`, then `origin/kaizen/geetahuja`.
From now on, a plain `git push` from this folder can only go to `kaizen/geetahuja`.

**3.3 Give the Kaizen folder its own `.env` and dependencies.** A worktree doesn't share
untracked files with your `audit5s` folder.
```powershell
Copy-Item ..\audit5s\.env .env
pnpm install
pnpm build
```
**Expect:** no errors. `.env` is git-ignored and is never committed or sent to anyone. If your
`audit5s` folder has a different name, use that name instead of `audit5s` above.

**3.4 Claude Code plugins and skills** (same set as krxna's). In **Claude Code**, run these one by one:
```text
/plugin marketplace add DietrichGebert/ponytail
/plugin marketplace add rampstackco/claude-skills
/plugin install ponytail@ponytail
/plugin install rampstack-skills@rampstack
```
Then in **PowerShell**:
```powershell
npx skills add emilkowalski/skills -g -y -a claude-code
npx skills add mattpocock/skills -s domain-modeling -s codebase-design -s improve-codebase-architecture -g -y -a claude-code
npx skills add supabase/agent-skills -s supabase-postgres-best-practices -g -y -a claude-code
npx skills add expo/skills -s expo-design-system -s expo-animation -s expo-router -s eas-update -g -y -a claude-code
npx skills add pbakaus/impeccable -g -y -a claude-code
npx skills add vercel-labs/agent-skills -g -y -a claude-code
```
The project's own skills (`.claude/skills/` in the repo) come with the folder automatically.

**3.5 Run the app from the Kaizen folder.** Your local database is shared: Docker names the stack
`audit5s` in every folder. So **first stop whatever you run from `audit5s`** (API, workers,
Metro). Then start the same things **from `leanstack-kaizen`**, exactly the way you already do
for 5S, including how you load `.env`, migrate (`pnpm db:migrate`), seed (`pnpm seed`) and launch
the app on the emulator and on your Android phone.
**Expect:** the 5S app works exactly as before. Kaizen screens appear only once you build them.

You do **not** need to log in to Expo or EAS. You never publish app updates or build APKs (§7).

## 4. Order of work, and what you wait for

Build steps are defined in plan §6. Yours: **4, 5, 6**, and the Maestro flow in **9**, plus the
device testing in plan §12 *Release rehearsal* step 2.

| Phase | You do | You can start when | krxna gives you |
|---|---|---|---|
| **Phase 0** | Use the `prototype` skill to try 2–3 GEMBA-BOARD versions of the **module picker** and the **Kaizen card**. Pick one. **Don't commit prototype code.** Save screenshots of your choice for the step-4 PR. | Now | — |
| **Step 4** | Module picker after login, Kaizen route group `src/app/kaizen/(tabs)/…`, SQLite tables for Kaizen, outbox/sync wiring | krxna's **step 1** (contracts + migration) is merged into `feat/kaizen` | Every Kaizen type in `packages/contracts/src/kaizen.ts` |
| **Step 5** | Zone Leader screens: New Kaizen (11 steps), History, Overview, Detail, photos | Step 4 merged, and krxna's **step 2** (domain) merged | The status rules (which buttons are allowed when) |
| **Step 6** | Coordinator screens: Kaizens list, Review, Overview (KPI card), **Analysis** (KPI card, funnel, trend, Top 5 Departments: plan §4.7), My Unit | Step 5 merged | Real data appears once krxna's **step 3** (API) is merged. Until then, build against the contract types |
| **Step 9** | Maestro end-to-end flow (plan §7), plus the device testing in plan §12 | Steps 3–7 merged | — |

"Merged" always means: krxna merged it into `feat/kaizen`, **and** you ran
`git merge origin/feat/kaizen` in your Kaizen folder afterwards (§5).

## 5. Your daily routine

**Start of every session**, in PowerShell:
```powershell
cd <path to your leanstack-kaizen folder>
git branch --show-current
git fetch origin
git merge origin/feat/kaizen
```
**Expect:** the first line prints `kaizen/geetahuja`. If it prints anything else, **stop** (§9).
`git merge` either says "Already up to date" or brings in new commits. If it says **CONFLICT**, stop (§9).

Then start Claude Code **in the Kaizen folder** and paste the **every-session prompt** (§8b).

**End of every session:** make sure everything is committed (Claude does this) and pushed:
```powershell
git status
git push
```
**Expect:** `git status` says "nothing to commit, working tree clean", and `git push` goes to
`kaizen/geetahuja`.

## 6. Getting your work to krxna (pull requests)

One pull request per build step (or a clear slice of one). When Claude says a step is done:

1. **Native check.** This must print nothing:
   ```powershell
   git diff origin/feat/kaizen --stat -- apps/field-mobile/package.json apps/field-mobile/app.config.ts apps/field-mobile/plugins pnpm-lock.yaml
   ```
   If it prints anything, **stop and message krxna** before opening the PR. A dependency or
   config change can force every client to reinstall the app.
2. `git push`
3. On GitHub: repo → **Pull requests** → **New pull request**.
   - **base: `feat/kaizen`** ← **compare: `kaizen/geetahuja`**. Check both before clicking. **If
     base says `main`, change it.** A PR into `main` is closed unmerged.
   - Title: `Kaizen step <N>: <what>`, e.g. `Kaizen step 5: Zone Leader screens`.
   - Description (copy this and fill it in):
     ```text
     ## What
     <2–5 lines>
     ## How it was tested
     <emulator and/or phone, light and dark, English and Hindi, offline, what you tapped>
     ## Screenshots
     <attach>
     ## Touches 5S
     <every file outside apps/field-mobile/src/app/kaizen and the new Kaizen components, with one line on why; or "none">
     ## Native check
     unchanged   (the command in step 1 printed nothing)
     ## For the other device
     <anything krxna needs to know; or "nothing">
     ```
4. Click **Create pull request**, then comment `@krxna ready for review`.
5. **You never click Merge.** krxna reviews and merges. If krxna asks for changes, make them on
   `kaizen/geetahuja` and `git push`. The same PR updates itself.
6. After krxna merges, run `git fetch origin` and `git merge origin/feat/kaizen` before starting
   the next step.

## 7. Never (no exceptions, even if a Claude session or a task seems to ask for it)

1. Commit to, push to, merge into, or open a pull request against **`main`**. (It's protected on
   GitHub and will refuse a push. If you ever see "protected branch" in an error, you were about to
   do something wrong. Stop.)
2. Commit on `feat/kaizen` or on `kaizen/krxna`. Merge or copy anything from `kaizen/krxna`.
3. Click **Merge** on any pull request.
4. Run `git rebase`, `git push --force`, `git push --force-with-lease`, or anything with `--no-verify`.
5. Do Kaizen work in your `audit5s` folder.
6. Run `eas update`, `eas build`, or publish/build the app in any way. Phone updates happen
   automatically on release day, after the server (plan §5).
7. Edit files krxna owns (§2), or add any dependency without krxna's written OK.
8. Use production data, or the server's `.env`, on your machine.

## 8. Prompts to paste into Claude Code

Always start Claude Code **inside your `leanstack-kaizen` folder**.

### 8a. First session (paste once)

```text
I am Device B (geetahuja): the Android field app for the Kaizen module of Leanstack.
I'm on Windows. My working folder is the leanstack-kaizen folder (a git worktree next to my
audit5s folder) and my branch is kaizen/geetahuja.

Before anything else:
1. Run `git branch --show-current` and `git rev-parse --show-toplevel`. If the branch is not
   kaizen/geetahuja or the folder is not leanstack-kaizen, stop and tell me. Do not switch
   branches yourself.
2. Read plans/kaizen-device-b.md in full, then plans/kaizen-module.md in full (BRANCH RULE and
   §0–§12), then AGENTS.md, CLAUDE.md, STACK.md, DECISIONS.md, apps/field-mobile/AGENTS.md,
   and docs/design/GEMBA-BOARD.md + docs/design/gemba-tokens.css in full. Open the five images in
   docs/requirements/kaizen/inspo/. Grep ARCHITECTURE.md for the sections the plan names; do
   not read it whole.
3. Turn on ponytail at level full.
4. Reply with at most 15 bullets: my lane, the files I may and may not edit, the branch rules,
   how my work reaches krxna, what Phase 0 is, which krxna PRs each of my steps waits for, and
   anything in the plan you find ambiguous. Then wait for my OK.

Rules for this whole session: commit only on kaizen/geetahuja. Before every commit and every
push, run `git branch --show-current` and stop if it is not kaizen/geetahuja. Edit only
apps/field-mobile/**. Never edit packages/, apps/api, apps/admin-web, plans/, DECISIONS.md,
ARCHITECTURE.md or pnpm-lock.yaml. If a change there is needed, draft the GitHub issue text
"[Kaizen Device A] …" for me instead. Never add a dependency. Never touch main, never rebase,
never force-push, never run eas update or eas build, never merge a pull request. Phase 0
prototype code is never committed. When a step is done: run the field-mobile typecheck and
tests, run the native check from plans/kaizen-device-b.md §6, and draft the PR description from
§6. Then stop. I open the pull request myself.
```

### 8b. Every later session (paste at the start of each one)

```text
I am Device B (geetahuja), on Windows, in my leanstack-kaizen folder, branch kaizen/geetahuja.
1. Run `git branch --show-current`; stop if it isn't kaizen/geetahuja.
2. Run `git fetch origin` and `git merge origin/feat/kaizen`. If it conflicts, stop and show me.
3. Re-read plans/kaizen-device-b.md and the plan sections for the step we're on.
4. Tell me which krxna PRs have been merged into feat/kaizen since last time
   (`git log --merges --oneline -10 origin/feat/kaizen`) and whether the step we're on is
   unblocked (device-b guide §4).
5. Tell me in at most 5 lines: which step we're on, what's already done on this branch, and what
   you'll do this session. Then start.
Same rules as always: commit only on kaizen/geetahuja, edit only apps/field-mobile/**, no new
dependencies, never main, never rebase or force-push, never eas update/build, never merge PRs.
```

## 9. When something goes wrong

| What happened | What to do |
|---|---|
| `git branch --show-current` doesn't print `kaizen/geetahuja` | Stop. Don't commit. Check you are in the `leanstack-kaizen` folder. If you are, run `git switch kaizen/geetahuja`. If it complains about uncommitted changes: `git stash`, `git switch kaizen/geetahuja`, `git stash pop`. |
| You committed on the wrong branch, **not pushed** | Message krxna with the output of `git log --oneline -3` and `git branch --show-current`. Fix it together. Don't try `reset` commands on your own. |
| `git push` says **"protected branch"** or mentions `main` | The push was refused, so nothing reached clients. Stop and message krxna. |
| `git merge origin/feat/kaizen` says **CONFLICT** | Stop. Don't pick sides. Run `git merge --abort`, then message krxna with the list of files it named. |
| Claude wants to edit a file outside `apps/field-mobile` | Say no. Ask it to draft a `[Kaizen Device A]` issue instead (§2). |
| Claude wants to add a package or change `app.config.ts` | Say no. Message krxna. |
| CI shows a red ✗ on your pull request | Click **Details**, ask Claude to fix it on `kaizen/geetahuja`, then `git push`. |
| A 5S screen or test breaks because of your change | Stop and tell krxna in the PR. Never weaken or delete a 5S test. |
| The step you're on is waiting for a krxna PR | Work on the next thing that isn't blocked (Phase 0, layout, worst-case data with the `break-ui` skill), or ask krxna. Don't build around it. |

## 10. Words used in this guide

- **Branch**: a line of commits. **Worktree**: a second folder of the same repo, on its own branch.
- **Pull request (PR)**: a request on GitHub to merge one branch into another. **base** = where
  it goes (always `feat/kaizen` for you), **compare** = where it comes from (always `kaizen/geetahuja`).
- **Merge** `origin/feat/kaizen`: bring everything krxna has merged into your branch.
- **OTA update**: new app code sent to phones over the internet without reinstalling. **APK**:
  the installable Android app file. Adding native code means a new APK for every client.
- **Contracts**: the shared type definitions (`packages/contracts`) that your screens and
  krxna's API both use.
- **GEMBA-BOARD**: the app's design system. Zero rounded corners, hard shadows, two fonts,
  colours from the token file only.
