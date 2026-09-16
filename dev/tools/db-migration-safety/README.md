# db-migration-safety

Deterministic guardrails so agents (and humans) stop corrupting Drizzle
migrations by hand-renumbering, editing applied migrations, or running
destructive/off-workflow commands like `drizzle-kit push --force`.

The public-source privacy cleanup records exact standalone-comment redactions
in `comment-redactions.json`. The hook allows only those complete
before/after SHA-256 pairs at their recorded paths. Executable SQL and Drizzle
statement breakpoints remain unchanged; this is not permission for future
comment or SQL edits. Drizzle hashes whole files, so fresh installations record
the new hashes while already-applied migration records keep their old hashes.
The PostgreSQL migrator selects unapplied migrations by journal timestamp;
neither journal timestamps nor snapshot files change in this cleanup.

The skill alone is advisory — a model can ignore it. This bundle pairs the
skill with two layers of **enforcement that fire regardless of what the model
decides**.

## Three layers

1. **lefthook pre-commit guard** (`guard-staged-migrations.sh`)
   Version-controlled, runs on every commit in every worktree (agent or
   human). When staged files touch `packages/db/src/migrations/**` it:
   - runs `drizzle-kit check` (collision / ordering validator);
   - blocks edits to the SQL body of an already-committed migration;
   - warns on destructive DDL (`DROP` / `TRUNCATE`) unless explicitly marked.
   Wired in `lefthook.yml`. Bypassable only with `git commit --no-verify`
   (which the Cursor hook flags).

2. **Cursor `beforeShellExecution` hook** (`cursor/hooks/guard-drizzle.sh`)
   Agent runtime guard. Intercepts dangerous shell commands *before* they run
   (`drizzle-kit push`, `db:push`, `--force` / `--yes` / `--no-verify`,
   `DROP` / `TRUNCATE` / unscoped `DELETE`) and surfaces them for human
   approval. Deterministic; the agent cannot `--no-verify` past it.

3. **Skill** (`cursor/skills/drizzle-migration-safety/SKILL.md`)
   The "why" + the conflict workflow. Lowest enforcement, still the reference.

## Editing

These are the **canonical** sources. Edit here, then:

```bash
bash dev/tools/db-migration-safety/install.sh   # this bundle only
# or
bash dev/tools/install-all.sh                   # all bundles
```

Deploy writes stamped copies into the containing `.cursor/` workspace root.
`hooks.json` and `hooks/*.sh` are copied raw (no markdown banner — they are
JSON / shell). `SKILL.md` gets the standard "deployed copy — do not edit"
banner.

## Why `when` monotonicity is NOT enforced

The live `_journal.json` intentionally has non-monotonic `when` timestamps
(hand-authored migrations reuse/round timestamps). `drizzle-kit check` is the
authoritative validator for journal consistency, so the guard defers to it
rather than imposing a stricter rule that would false-positive on the real
tree.
