---
name: drizzle-migration-safety
description: Nautilo-specific Drizzle migration safety workflow. Use when editing packages/db schema or migrations, resolving Drizzle migration conflicts, touching _journal.json or *_snapshot.json, running db:migrate/db:generate, or rebasing branches with packages/db/src/migrations conflicts.
---

# Drizzle Migration Safety

Use this skill before touching Nautilo Drizzle migrations or migration metadata.

Two deterministic guards back this skill up (a lefthook pre-commit check and a
Cursor `beforeShellExecution` hook). They will block the worst mistakes even if
this prose is ignored — but they are a backstop, not an excuse to skip the
workflow. Source: `nautilo/dev/tools/db-migration-safety/`.

## Forbidden Without Explicit Human Approval

NEVER run these. They are off-workflow for Nautilo (we use `generate` +
`migrate`, never `push`) or destructive:

- `drizzle-kit push` / `bun db:push` — bypasses migration files entirely
  (introspect live DB → diff → apply). Can drop columns/tables with no record.
- ANY `--force`, `--yes`, `--no-verify` on a drizzle/db/git command.
  (`drizzle-kit push --force` is what wiped a production DB in a public
  Claude Code incident.)
- `DROP TABLE|SCHEMA|DATABASE`, `TRUNCATE`, `DELETE` without a `WHERE`.
- Editing or deleting the SQL body of an ALREADY-APPLIED migration.
- Mutating `drizzle.__drizzle_migrations` without explicit user approval.

Destructive DDL inside a NEW migration (e.g. `DROP COLUMN` for a real schema
change) is allowed — back up first, and call it out in the PR.

## How drizzle-kit actually tracks state (read before repairing anything)

- `drizzle-kit generate` diffs your TS schema against the **last meta
  snapshot** (NOT the live DB), writes `NNNN_<tag>.sql`, a
  `meta/NNNN_snapshot.json` (chained to the previous via `prevId`), and a new
  `_journal.json` entry `{idx, when, tag}`. Always pass `--name` so filenames
  are deterministic and conflicts surface loudly.
- `drizzle-kit migrate` reads all `.sql` files, reads the DB's
  `drizzle.__drizzle_migrations` table (`id, hash, created_at`), and applies
  the ones not yet recorded. `created_at` mirrors the journal `when`.
- **This is why renumbering is dangerous:** if you rename an already-applied
  migration to a new number/`when`, `migrate` either re-applies it (→
  `42P07 relation already exists`) or skips it by position. The repo can look
  correct while the local DB history is wrong.

These four files are ONE system: the `.sql`, `_journal.json`,
`*_snapshot.json`, and the DB's `drizzle.__drizzle_migrations` table. Never
resolve migration conflicts as ordinary text conflicts.

## Conflict Workflow

### Default (preferred): regenerate on top of the parent

This is Drizzle's own recommended resolution and the safe default when the
incoming migration has NOT been applied to a local DB you care about:

1. Take the parent branch (`origin/main`) `migrations/` as the source of truth.
2. Discard your generated migration files + meta on your side.
3. Re-run `db:generate --name <suffix>` on top of merged main → one clean
   migration, correctly chained, no metadata surgery.
4. `db:migrate` locally to verify, then `db:check`.

`/sprint-sync`'s backup → restore-base → regenerate → diff-vs-intent path
automates this. Halt if regenerated SQL is empty or materially different from
the backed-up intent.

### Exception: rename (do NOT regenerate) when already applied locally

ONLY when the incoming migration is already applied to a local DB you will not
reset — because regenerating DDL on top of already-applied schema corrupts it:

- Rename the incoming SQL to the next free migration number.
- Do NOT alter the SQL body.
- Update `_journal.json` (keep `idx` strictly increasing and contiguous;
  `when` does not need to be globally monotonic — the repo's isn't — but the
  renamed entry should sit at the new `idx`).
- Chain the renamed snapshot after the current main snapshot (`prevId`).
- Then inspect/repair the local `drizzle.__drizzle_migrations` row separately
  before running `db:migrate` again.

If you cannot tell whether it was applied locally: STOP and ask. No default,
no guessing.

## Repair helpers are scoped — never run blind

`packages/db` repair helpers (e.g. `repair-migration-meta-snapshots.mjs`) are
scoped to specific known migrations and will churn unrelated snapshots if used
on the wrong case. Read the helper's source/docs first.

## Validate before continuing

- `bun --cwd packages/db run db:check` succeeds (authoritative collision /
  ordering validator — trust it over hand-eyeballing).
- No conflict markers in `packages/db/src/migrations` or `.../meta`.
- `python3 -m json.tool` succeeds on edited JSON metadata.
- `_journal.json` `idx` is strictly increasing and contiguous; tags unique.
- New snapshot `prevId` points to the previous snapshot `id`.
- Run focused DB typecheck/tests.

## Local DB Warning

Repo state can be correct while the local DB migration history is wrong. If a
migration was applied under an old number/timestamp before a rebase, future
`db:migrate` may try to re-apply the renamed SQL and fail. Repair the local
`drizzle.__drizzle_migrations` row or reset/restore the local DB intentionally.

Do not mutate local DB migration history without explicit user approval.
