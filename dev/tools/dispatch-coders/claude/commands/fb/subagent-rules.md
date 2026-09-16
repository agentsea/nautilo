# Subagent rules — paste into every subagent prompt verbatim

The verbatim block to drop into a Composer (or any) subagent prompt so
it doesn't clobber orchestrator work, mutate the lockfile, or commit on
your behalf. Companion to `/fb:dispatch-coders` (the parent-side
orchestrator persona).

These rules preserve parallel work even when several agents share a checkout.

---

## The block (copy-paste verbatim into the subagent prompt)

> 1. You have an **owned-files allow-list**. You may edit ONLY those files.
> 2. **NEVER** run `git add`, `git commit`, `git push`, `bun add`,
>    `bun install`, or anything that mutates the lockfile. The orchestrator
>    handles all commits and dep changes.
> 3. **NEVER** run `git checkout`, `git restore`, `git reset`, `git stash`,
>    or `rm` against any file outside your owned-files set — even if it
>    looks like stray WIP, an out-of-scope edit, or "cleanup". Those
>    uncommitted changes are almost certainly the orchestrator's parallel
>    work-in-flight. **Treat them as invisible.**
> 4. If you discover you need to edit a file NOT in your allow-list: STOP
>    and report. Do not edit it.
> 5. If a file in your allow-list is unexpectedly dirty: STOP and report.
>    Do not stash, revert, or "clean up".
> 6. When done, report:
>    - Files edited (absolute paths)
>    - Files in scope but intentionally untouched (and why)
>    - Acceptance commands run + their output
>    - **Deferrals**: anything you cut, stubbed, narrowed, `TODO`'d, or
>      left unfinished vs. the task you were given — what / why / risk /
>      options. Never absorb a cut silently; "None" is valid only after
>      you re-read your own diff. (See the `no-silent-deferrals` rule.)
>    - Open questions / blockers
>
> If at any point you find yourself about to run `git checkout`, `git reset`,
> `git stash`, or `rm` against a file you did not create or edit, STOP and
> report instead.
>
> Do NOT `git add` / `git commit` / `git push`. Orchestrator commits.

---

## Required scaffolding around the block (orchestrator fills in)

When the orchestrator dispatches a subagent, the subagent prompt should
include — in addition to the verbatim block above:

- **Owned-files allow-list** (absolute paths or glob patterns)
- **Read-only files** the subagent may consult but must not modify
- **Acceptance command(s)** the subagent must run before reporting
- **Model**: explicitly `composer-2.5-fast` unless a heavier tier is
  justified for the specific subagent (parent class is the silent default
  — pass `model` deliberately). Non-fast `composer-2.5` is not currently
  exposed as a subagent slug; the fast variant has the same intelligence
  per Cursor and is still the cheapest capable option for bulk coding.
  See `dispatch-coders.md` Section 2 for the rationale.

See `/fb:dispatch-coders` for the full orchestrator-side workflow.
