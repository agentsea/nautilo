# Phase-end self-check

Fast defense-in-depth gate to run after a coding pass in a task phase,
before reporting "done" or committing. This is **not** the heavy code
audit (`/fb:audit-code`) — that one runs at major sprint intervals and
produces a durable artifact. This one is lightweight, chat-back only,
and meant to catch the forward-pass-blindness, vibes-only "looks
good", and "pre-existing failure" tendencies before they ship.

Works in either seat: paste it after a Composer subagent reports done
(orchestrator-side), or bake it into the subagent prompt so the
subagent runs it before reporting (subagent-side). Same prompt either
way.

---

## The prompt (copy-paste this block)

> You are forward-pass-only. You don't know what you wrote until you
> re-read it. "Check your work" without re-reading the bytes is
> hallucinated reassurance. Three passes, in order. Skipping a pass =
> work is not done.
>
> ### Pass 1 — Re-read your own bytes
>
> Run `git diff` (or re-read every file you touched, end-to-end).
> Surface ≥1 thing you did NOT notice while writing. Zero findings =
> you didn't actually re-read; do it again.
>
> Before claiming any failure is "pre-existing", "already failing on
> main", or "unrelated to my change", you MUST produce the four
> artifacts under the pre-existing-failure rule below. If you used
> any of those phrases without the artifacts, strike them and either
> (a) run the worktree check now, or (b) treat the failure as yours.
>
> ### Pass 2 — Re-anchor against source of truth
>
> Re-read the phase doc, its parent issue, and any ASCII / diagram in
> scope. For each acceptance-criteria checkbox already in the phase
> doc, either tick it inline with a `file:line` citation, or mark it
> `NOT MET` / `STUBBED` / `DEFERRED` with one sentence why. `DEFERRED`
> is only legal with a destination ref per the deferral-destination
> rule below — a deferral with no home is `NOT MET`, not `DEFERRED`.
> No new sections. No new files. Fill in what's already there.
>
> If the change affects runtime behavior, pull evidence via the
> relevant MCP (`electron-debug` / `server-logs`). If it
> doesn't (pure types/refactor), say so and skip.
>
> Verification claims need raw evidence. If you say "verified",
> "passes", "works", "lint clean", or similar, include the command,
> working directory, exit code, and the relevant output line. If you did
> not run it, say `NOT RUN`.
>
> ### Pass 3 — Evidence-mode smell sweep
>
> For Core, cite `file:line` you checked, or skip with a one-line
> reason. For Applies-if, decide applicability yourself; if you skip
> a category, state in one sentence why it doesn't apply to this
> phase. No bare ✅. No silent omissions.
>
> Core (always considered):
> - Bugs / dangerous mistakes (null paths, off-by-one, unhandled rejection)
> - Duplicate paths — does this concept already exist? (one Grep for
>   the name + 1–2 obvious synonyms)
> - Things in the wrong place / wrong layer
> - Workarounds / fallbacks / hacks / stubs / TODOs left in
> - Tests: do they actually exercise the new path, or pass vacuously?
>   Show the assertion that would fail if the implementation were
>   replaced with a no-op.
> - Contract drift: if you changed a type, prop, IPC channel, event
>   shape, route, schema, tool interface, serialized artifact, or prompt
>   format, Grep all producers/consumers by symbol/string and report
>   every caller checked.
> - New helper / abstraction / service / component: before adding it,
>   Grep 2-3 likely synonyms and report why existing code does not
>   already own the job.
>
> Applies-if (agent decides; state which apply, which don't, and why):
> - Security (input trust, secret handling, IPC boundaries)
> - Money / math / units / timezones / rounding
> - UX (silent failures, confusing errors, lost state on reload)
> - Legacy code paths I should have deleted but didn't
> - Unpinned / out-of-date deps (search npm/uv if you touched any)
> - Configs scattered instead of centralized
> - New dependency: prove necessity by reporting existing local
>   alternatives checked, license/maintenance status, lockfile impact,
>   and central config location. Otherwise do not add it.
> - Backwards compatibility shim: name the shipped/stable consumer that
>   requires it. If none exists, delete the old path instead of
>   preserving broken design.
> - Edge paths: happy path, empty input, error path,
>   cancellation/interruption, repeated invocation, and reload/restart
>   if applicable. Cite evidence or mark untested.
>
> ### Honest closing report (always)
>
> - Claimed-vs-shipped delta: anything in the phase doc I did not
>   actually do
> - Stubbed / TODO'd / deferred. Each line: `file:line` + what + why
>   + **destination ref**. A deferral with no destination is not
>   deferred — it is ORPHANED. Report orphans under "not done", never
>   under "deferred" (deferral-destination rule below).
> - Out-of-scope but smells off (report only, do not fix; flag for
>   future issue)
> - Owned-file set vs touched-file set. Any touched file not in the
>   plan needs explicit justification before it can stay.
> - Final status split into: implemented, verified, not verified,
>   deferred (each with a destination), orphaned (deferred-but-homeless;
>   = not done), and discovered-but-not-fixed. Do not merge these
>   categories. A zero-deferral, zero-orphan report on a non-trivial
>   change is itself suspicious — re-check before claiming it.
> - Confidence: high / medium / low + one sentence why
>
> ### The pre-existing-failure rule (referenced from Pass 1)
>
> The phrase "pre-existing", "already failing on main", "unrelated
> to my change", or any synonym is FORBIDDEN unless accompanied by
> all four:
>
> 1. The commit SHA you tested against (must be `origin/main` HEAD or
>    a named tag — NOT your dirty working tree minus a stash).
> 2. The exact test command you ran (copy-pasteable, same scope as
>    the failing run on your branch).
> 3. The full failure output from that clean run (not paraphrased).
> 4. A one-line statement that the failure on main is byte-equivalent
>    (or substantively equivalent + why) to the failure on your
>    branch.
>
> If you cannot produce all four, the failure is YOURS until proven
> otherwise. Do not ship.
>
> Cheapest reliable reproduction recipe (use this, not `git stash` —
> stash misses untracked files, can leave half-restored state on pop
> conflicts, and tests against `HEAD` not `main`):
>
> ```bash
> git fetch origin main
> git worktree add /tmp/preexist-check origin/main
> cd /tmp/preexist-check && bun install --frozen-lockfile
> # run the EXACT failing test command, record SHA + output
> cd - && git worktree remove /tmp/preexist-check
> ```
>
> Bonus sanity check (one shell call, ~2 seconds):
>
> ```bash
> gh run list --branch main --workflow ci.yml --limit 5
> ```
>
> If main's CI is green and the test you're claiming is "pre-existing"
> runs in that workflow, the claim is dead on arrival — it's yours.
>
> Flaky-test escape hatch (the one legitimate exception): run the
> test 3x on main, 3x on your branch, with seeds/timestamps captured.
> Pre-existing-flaky requires showing failure rate is statistically
> indistinguishable between the two. Anything less is "I want to
> ship and I'm hoping."
>
> ### The deferral-destination rule (referenced from Pass 2 + closing report)
>
> "Deferred" is not a status. Every in-scope item lands in exactly one
> of three spots — DONE, or one of these two when it is not done:
>
> 1. **TRACKED** — carried to a NAMED home. Cite it: an existing
>    `ISSUE-D###` / `ISSUE-M###` / stack-id, OR a new issue/stack you
>    create in THIS turn (name the slug you are creating). The phase
>    doc / parent issue is also a valid home if you add the line there
>    now and cite it.
> 2. **DROPPED** — explicitly killed. Requires operator sign-off + a
>    one-line reason. Never drop silently.
>
> Anything else is **ORPHANED**: incomplete work wearing the word
> "deferred" as a disguise. Orphaned work is `NOT DONE`, full stop.
>
> The words "deferred", "punt", "leave for later", "out of scope for
> now", "follow-up", and "TODO later" are FORBIDDEN unless immediately
> followed by all three:
>
> 1. The **destination ref** (issue/stack id, or `creating now: <slug>`,
>    or `dropped — operator OK'd: <reason>`).
> 2. One line on **what** is being moved (the scope of the cut).
> 3. One line on **why moving it now is safe** — no half-migration,
>    no broken contract, no caller left pointing at a hole.
>
> If you cannot name the destination, the item is not deferred — it is
> unfinished. Either finish it, or stop and ask the operator to TRACK
> or DROP it. Do not narrate it away.

---

## Real-time counter-prompts (paste these into chat when you smell it)

When the agent says "pre-existing" / "unrelated to my change" /
"already failing on main" without the four artifacts:

> Stop. You said "pre-existing". Show me the four artifacts:
> `origin/main` SHA, exact test command, full failure output from a
> clean worktree on that SHA, and equivalence statement. Worktree
> recipe in the phase-end self-check. If you can't produce them in
> the next turn, the failure is yours.

When the agent rubber-stamps Pass 3 with bare ✅ marks:

> No bare checkmarks. For each category you ticked, give me a
> `file:line` you actually opened, or strike the tick and write
> "skipped because…" in one sentence. Run Pass 3 again in
> evidence-mode.

When the agent claims Pass 1 done with no surprises:

> Pass 1 with zero "things I didn't notice while writing" means you
> didn't re-read — you narrated from memory. Re-run the actual
> `git diff`, end-to-end, and surface at least one thing.

When the agent says "verified", "passes", "works", or "lint clean"
without raw command evidence:

> You said you verified this. Show command, cwd, exit code, and the
> relevant output. If you can't, revise to `NOT VERIFIED`.

When a test looks like fixture theater:

> Show me the assertion that would fail if the implementation were
> replaced with a no-op. If none exists, the test is vacuous.

When a type / schema / IPC / route / event / tool contract changed:

> You changed a public contract. Grep all producers and consumers by
> symbol/string, list every caller checked, and report any migrations
> missed.

When the agent adds a new helper / abstraction / service / component:

> Before adding this new thing, grep 2-3 likely synonyms and report why
> existing code does not already own this job. If there is an existing
> owner, consolidate instead of inventing another path.

When the agent says "deferred" / "punt" / "follow-up" / "out of scope
for now" without a destination:

> Stop. You said "deferred". Name the home: an existing issue/stack id,
> a new one you create right now, or an operator-OK'd drop. Plus one
> line on what's moving and why it's safe to move. No home = orphaned =
> not done — report it that way and we decide together.

---

## Why this exists (design notes — skip on first read)

- **Forward-pass-only blindness**: LLMs don't have a "wait, let me
  reconsider" — that's narrative theater. The only cure is forcing a
  literal re-read of the bytes. Pass 1 exists to make that
  unavoidable. The "≥1 thing you didn't notice" rule is the trip
  wire — zero findings means it didn't happen.
- **Smell-list rubber-stamping**: an open-ended list of smells
  invites "✅ checked all of them" with no evidence. Evidence-mode
  (cite `file:line` or state why N/A) breaks the rubber stamp
  without ballooning the list.
- **Tiered Core / Applies-if**: avoids forcing "N/A: money math"
  boilerplate on backend-only phases. Agent has to decide
  applicability and *say so*, which preserves the discipline.
- **In-place phase-doc updates, not new artifacts**: phase docs
  already have acceptance-criteria checkboxes. Filling those in
  with citations is *not* append-only sprawl — it's earning marks
  that were already there. No `checkpoints/` directory rotting
  forever.
- **The "pre-existing" rule is the most cost-effective rule in this
  doc**: it converts a vague rhetorical dodge into a falsifiable
  claim with mechanical reproduction. Worktree against
  `origin/main` is bulletproof where `git stash` is not (untracked
  files, pop conflicts, branch-vs-main confusion).
- **The deferral-destination rule is "pre-existing" for scope**:
  "deferred" is the scope-side equivalent of "already failing on
  main" — a word agents reach for to close a phase cleanly while
  quietly abandoning work. Forcing a named destination converts it
  from a vibe into a falsifiable claim: either there is an
  issue/stack/file home (TRACKED), or an operator said kill it
  (DROPPED), or it's orphaned and therefore NOT DONE. The category is
  the trip wire — "orphaned" exists precisely so undestined deferrals
  have nowhere to hide.
- **Verification evidence beats confident summaries**: "I verified"
  is cheap prose. Command, cwd, exit code, and relevant output are the
  minimum raw materials needed to trust the claim.
- **Contract drift is where partial fixes hide**: IPC names, event
  shapes, schemas, tool interfaces, prompts, routes, and serialized
  artifacts have producers and consumers. Changing one side is not an
  implementation; it is half a migration.
- **Vacuous tests are worse than no tests**: a test that passes when
  the implementation is replaced by a no-op creates false confidence.
  The no-op assertion question catches fixture theater quickly.
- **Compatibility shims need a real consumer**: agents preserve old
  paths reflexively because backwards compatibility sounds safe. If no
  shipped/stable consumer needs the old path, keeping it is usually
  legacy sprawl, not safety.
- **Relationship to `/fb:audit-code`**: this is fast defense-in-
  depth between phases. Audit-code is slow, durable, sprint-scale.
  Both exist; they don't replace each other.
