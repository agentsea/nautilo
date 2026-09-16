# Green PR

Turn a sprint / worktree / folder into an open PR with **green CI**, then
stop. Fix lints and tests *properly* — never by mutating code to dodge the
check. "Flaky" and "pre-existing" are claims you **prove**, not excuses you
assume.

Sister to `/review-pr` (cold-eyes review of a diff) and `/phase-end`
(self-check after a coding pass). This command is the loop that gets the
branch to a green, reviewable PR in the first place. It does **not** merge.

---

## Two ways to run

**Direct** — run the loop yourself in the current chat.

**Dispatch a subagent** — fire-and-forget. Paste this block, filled in:

> You own getting `<TARGET>` to a green PR against `<BASE, default main>`.
> Follow the `/green-pr` command end to end. Hard rules, no exceptions:
> - **Check staleness FIRST.** If the branch is behind `<BASE>`, do not burn
>   CI on a stale branch. Clean rebase → rebase + `--force-with-lease`, note
>   it. Conflicts → STOP, report it as a blocker, don't guess.
> - Fix lints and tests by fixing the **real cause**. Never silence a check
>   (`eslint-disable`, `@ts-ignore`, `as any`, `.skip`, deleted/weakened
>   assertions, loosened thresholds) to go green.
> - "Flaky" and "pre-existing" are forbidden as assumptions. Prove them
>   with the evidence this command requires, or treat the failure as yours.
> - **Do not exclude any existing change because it looks "unrelated."**
>   Everything in the working tree/branch is in scope; if something looks
>   out of place, include it and flag it in the done-report — never drop a
>   file by omission. Splitting the PR is the operator's call, not yours.
> - Stage deliberately with `git add <paths>` (avoid blind `git add -A`).
>   Never `git push` to `main`/`master`; force-push only
>   `--force-with-lease` on the feature branch after a clean rebase. Never
>   commit secrets/`.env`. Surface every deferral per `no-silent-deferrals`.
> Report back: how far behind base you started + whether you rebased, the
> PR URL, the green check list, and every fix with its root cause (one line
> each). Do not claim done until CI is actually green **on a fresh base**.

---

## The loop

### 1. Resolve the target

Figure out what "it" is, in this order:

| Input | Meaning |
|---|---|
| a sprint id / stack id | the stack's worktree + branch (see `/sprint`) |
| a worktree path / `nautilo-stack-*` dir | that worktree's current branch |
| a folder / branch name | that branch |
| nothing | current branch in cwd |

Establish and state up front: **working dir**, **branch**, **base**
(default `main`). Everything below runs in that working dir.

### 2. Check staleness first — don't green a stale branch

Greening CI on a branch that's behind base is wasted work: base may have
moved under you, the checks ran against an outdated merge, and the rebase
you'll eventually owe can re-trigger every check *and* surface new
failures/conflicts. Settle this **before** burning a CI cycle.

- Fetch base: `git fetch origin <base>`.
- Measure drift:
  - behind: `git rev-list --count <branch>..origin/<base>`
  - ahead:  `git rev-list --count origin/<base>..<branch>`
- **0 behind** → say so in one line, proceed to §3.
- **Behind** → inform up front (this is the line the operator/subagent
  caller needs): `branch is N behind origin/<base>; rebasing first so CI
  isn't run twice`. Then resolve by conflict risk:
  - **Clean rebase** (`git rebase origin/<base>` applies with no
    conflicts): do it now, then repeat the final audit for the new `HEAD` before updating
    the PR with `git push --force-with-lease` (feature branch only — the one
    sanctioned force-push; never `main`). *Then* drive CI. A rebase changes
    the SHA, so the earlier audit cannot stand in for it.
  - **Conflicts** (`git rebase` stops, or `git merge-tree` predicts them):
    do **not** guess. `git rebase --abort`, then —
    - **Direct mode**: surface the conflict set and ask how to proceed
      (rebase-and-resolve here, or green-as-is and rebase later).
    - **Subagent mode** (can't reach the operator): leave the branch
      unrebased, flag it as a **blocker** in the done-report with the
      conflicting paths, and do not force-push. Green-as-is only if the
      caller already authorized it.

This is the same staleness signal `/review-pr`'s topology pass reports
("branch is N commits behind main") — catch it here so review never has to.

### 3. Open (or locate) the PR

- Commit the uncommitted work. **Everything already in the working tree /
  branch is in scope by default — you do not get to decide a change is
  "unrelated" and drop it.** Excluding a file is a silent scope cut, and
  silent cuts are banned (`no-silent-deferrals`).
- Use explicit `git add <paths>` so you *know exactly* what you're staging
  — not as a way to quietly omit changes you'd rather not own. `git add -A`
  is discouraged only because it sweeps untracked junk in blindly; the fix
  is "stage deliberately + ask about anything surprising," **never** "drop
  what I judged irrelevant."
- If a change genuinely looks out of place (unrelated to the task, a
  possible accidental edit, or stray cruft like a build artifact / debug
  log / `.env`), **stop and ask** — list the exact paths and let the
  operator decide include/split/drop. **Subagent mode** (can't reach the
  operator): include it and flag it loudly in the done-report with the
  paths and your doubt — never resolve scope by omission. Splitting a PR is
  the operator's call, not yours.
- **Before every push, including this first one, complete the final
  orchestrator audit and record the exact audited `HEAD`.** Run the fast
  local checks in §4, then audit the exact `HEAD` about to be pushed: re-read
  the diff, confirm scope and local checks, and verify no prohibited
  workaround or unreported deferral remains. Re-audit whenever the SHA changes, including after a rebase.

- Push the branch: `git push -u origin <branch>` (never to `main`) — but
  run that pre-push protocol first so CI never runs on a typo and the pushed
  SHA is attributable.
- `gh pr view` — if a PR exists, use it. Else `gh pr create` with a title +
  body that states what the change does and why. The body is a claim
  `/review-pr` will check, so don't over-claim.

### 4. Drive CI to green

The two rules here exist to kill dead-waiting: don't spend a CI minute on a
failure you could have caught in seconds locally, and don't sit through a
full 3–5 min run watching a check that has *already* gone red.

**Pre-flight the fast checks locally before every push.** The fastest CI
failure is the one that never runs. Before the initial push (§3) *and*
before every re-push in the fix loop — including a `--force-with-lease` push
after a SHA-changing rebase — run the cheap, reproducible checks locally,
then repeat §3's final audit for the exact SHA about to be pushed:

```bash
turbo run typecheck lint --filter=...   # + test:unit where it's cheap
```

If that's red, fix it (§5) and re-run locally — you never spend a CI cycle
on a typo/lint/type error, and a local run surfaces **all** the fast
failures at once so you fix them in one round instead of ping-ponging
through CI. CI is then *confirmation*, not *discovery*. Only push once the
local fast checks are green.

**Watch CI with `--fail-fast`, then confirm with a full watch.** For the
checks only CI can run (supply-chain, desktop smoke, anything
env-specific):

```bash
gh pr checks --watch --fail-fast   # returns the instant the FIRST check fails
```

- On a red exit: go straight to that check's **actual log**, not the
  summary. Reproduce locally where you can, fix the root cause (§5),
  pre-flight locally, push, re-watch.
- **Do not hand off on a fail-fast partial pass.** `--fail-fast` bails on
  the first red, so a "no failure yet" exit is not proof of green. Once
  you believe it's fixed, run a **full** `gh pr checks --watch` (no
  `--fail-fast`) and confirm every check is green before §7.
- Re-running CI to "see if it passes this time" is not a fix. If a check
  only passes on retry, that's §6 — investigate, don't shrug.

(No interval-polling loop: `--fail-fast` is the deterministic "react on
first red" — don't burn tokens re-inspecting `gh pr checks` every N
seconds when the flag already blocks-then-returns for you.)

### 5. Fix it properly (the whole point)

A check is a smoke detector. The job is to put out the fire, not unplug the
detector.

**Lints / typecheck — fix the cause:**
- Banned as "fixes": `eslint-disable*`, `@ts-ignore`, `@ts-expect-error`,
  `as any` / `as unknown as`, widening a type to `any`, deleting the rule,
  loosening config to stop flagging.
- A suppression is allowed only with a cited, true reason that survives
  `/review-pr` — and you flag it to me, you don't slip it in.

**Tests — make them pass by being right, not by lying:**
- Banned: editing the **assertion** to match buggy output; `.skip` /
  `.only` / `xit` / commenting a test out; deleting a failing test;
  loosening a tolerance/threshold/timeout to mask a real failure; mocking
  the very thing under test so it can't fail; `try/catch`-swallowing the
  failure.
- A red test means one of two things, and you must decide which with
  evidence: **the code is wrong** (fix the code) or **the test is wrong**
  (fix the test, and say *why* the old assertion was incorrect — not just
  "it was failing"). "I changed the test so it's green" is never an answer.

### 6. "Flaky" and "pre-existing" — prove it or own it

These are the two phrases that smuggle real bugs past CI. Both are banned as
assumptions. Each is a claim with a burden of proof:

**"It's flaky":**
- Run it green-then-red: re-run the failing test **in isolation ≥5×**. If it
  ever fails, it is **not** flaky-noise to you — it's a real intermittent
  bug (race, timing, shared state, order dependence). Diagnose it.
- Only call it flaky after you've found the actual nondeterminism *and*
  decided it's out of this PR's scope — then it's a tracked deferral with a
  named home (`no-silent-deferrals`), not a hand-wave.

**"It's pre-existing":**
- Prove the base is red without your change: check out `<base>` (or a clean
  checkout / the PR's merge-base) and run the same check. If it's green on
  base and red on your branch, **it's yours** — full stop.
- If genuinely red on base too: don't silently ride past it. Say so with the
  evidence (the base SHA + the failing command output) and surface it as a
  tracked deferral or ask whether to fix it here.

If you can't produce the evidence, you don't get the excuse — treat the
failure as caused by this change and fix it.

### 7. Self-check, then hand off

- Run `/phase-end` (or its 3-pass spirit) over the final diff: re-read the
  diff, re-anchor to what was asked, smell-sweep for stubs/escape hatches.
- Confirm CI is **actually** green (`gh pr checks`), not "should be".
- Re-confirm not stale: `git rev-list --count <branch>..origin/<base>` is
  `0`. If base moved while you worked, you're back at §2 — rebase and
  re-green rather than hand off a branch that's already behind.
- Surface every deferral (`no-silent-deferrals`): TRACKED (named home),
  DROPPED (signed off), never ORPHANED.

---

## Guardrails

- Stage deliberately with `git add <paths>` (avoid blind `git add -A`), but
  **never exclude an existing change because you judged it "unrelated."**
  In-scope by default; surface doubts and ask — don't drop by omission.
- **Never** `git push` to `main`/`master`; push the feature branch only.
- The **only** sanctioned force-push is `git push --force-with-lease` on the
  feature branch after a clean rebase (§2). Never a bare `--force`, never on
  a shared/base branch, never to discard someone else's pushed work.
- Never commit secrets / `.env` / credentials.
- Don't merge. Green + open + reviewable is "done"; merge is a human call.
- If a fix (or a rebase conflict) is genuinely bigger than this PR's scope,
  that's a deferral/blocker to surface — not a suppression to ship.

## Done means

PR is open, the branch is **not behind base** (§2 settled — rebased if it
had to be), **every** CI check is green on that fresh base, every fix traces
to a real root cause (no suppression, no weakened test), and any
"flaky"/"pre-existing" call is backed by the evidence above or carried as a
tracked deferral.
