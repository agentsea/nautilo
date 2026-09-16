#!/usr/bin/env bash
#
# guard-staged-migrations.sh — lefthook pre-commit guard for Drizzle migrations.
#
# Runs ONLY when staged files touch packages/db/src/migrations/**. It is a
# local git hook (NOT a CI step): it blocks a bad commit early and prints how
# to fix it. Bypassable with `git commit --no-verify` (which the Cursor hook
# flags). Wired in lefthook.yml; reads the index (optional explicit path args).
#
# Hard-fails (block the commit) on:
#   - editing the SQL body of an already-committed migration (immutable)
#   - drizzle-kit check failing (journal/snapshot collision or bad ordering)
#   - a checked-in handwritten migration security contract failing
# Warns (does NOT block) on:
#   - destructive DDL (DROP/TRUNCATE) added to a migration without an explicit
#     `-- guard:allow-destructive` marker
#
# `when` monotonicity is intentionally NOT enforced — the live _journal.json
# is non-monotonic by design; drizzle-kit check is the authority.

set -uo pipefail

MIG_DIR="packages/db/src/migrations"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 0

# Collect staged migration files (from args, fall back to git).
staged=()
if [ "$#" -gt 0 ]; then
  for f in "$@"; do
    case "$f" in "$MIG_DIR"/*) staged+=("$f") ;; esac
  done
else
  while IFS= read -r f; do
    [ -n "$f" ] && staged+=("$f")
  done < <(git diff --cached --name-only -- "$MIG_DIR" 2>/dev/null)
fi

[ "${#staged[@]}" -eq 0 ] && exit 0

echo "[drizzle-guard] migration changes staged — running safety checks…"
fail=0

# 1) Block edits to the SQL body of an already-committed migration.
#    M = modified (existed in HEAD). Renames (rename-not-regen) show as A/D,
#    not M, so the legitimate rename workflow is allowed.
while IFS=$'\t' read -r status path; do
  [ -z "${path:-}" ] && continue
  case "$path" in
    "$MIG_DIR"/*.sql)
      if [ "$status" = "M" ]; then
        # Exact, reviewed privacy redactions preserve executable SQL and
        # statement boundaries. All other edits remain immutable.
        if command -v bun >/dev/null 2>&1 && bun dev/tools/db-migration-safety/check-comment-redaction.ts "$path"; then
          echo "  ✓ recorded comment-only privacy redaction: $path"
          continue
        fi
        # Importing main's exact recorded rewrite is not a new local edit.
        # The checker binds approval and SQL bytes to the incoming main parent.
        if command -v bun >/dev/null 2>&1 && bun bin/nautilo-dev/src/lib/recorded-main-merge-migration.ts "$path"; then
          echo "  ✓ recorded migration rewrite imported unchanged from main: $path"
          continue
        fi
        echo "  ✗ BLOCKED: you modified an already-committed migration's SQL body:" >&2
        echo "      $path" >&2
        echo "    Applied migrations are immutable. Create a NEW migration instead" >&2
        echo "    (db:generate --name <suffix>), or if mid-rebase use the rename-not-" >&2
        echo "    regen workflow. See the drizzle-migration-safety skill." >&2
        fail=1
      fi
      ;;
  esac
done < <(git diff --cached --name-status -- "$MIG_DIR" 2>/dev/null)

# 2) Authoritative consistency check (offline, ~1s, no DB connection).
if command -v bun >/dev/null 2>&1; then
  if ! check_out="$(bun run --cwd packages/db db:check 2>&1)"; then
    echo "  ✗ BLOCKED: drizzle-kit check failed (journal/snapshot collision or" >&2
    echo "    bad ordering). Fix the migration metadata before committing:" >&2
    printf '%s\n' "$check_out" | sed 's/^/      /' >&2
    fail=1
  fi

  # Drizzle snapshots intentionally do not model functions, triggers, grants,
  # or RLS policies. Feature-specific contracts make those invisible parts of
  # the migration chain explicit and run in CI with the normal unit suite too.
  shopt -s nullglob
  security_contracts=(packages/db/tests/unit/*-migration-security-contract.test.ts)
  shopt -u nullglob
  if [ "${#security_contracts[@]}" -gt 0 ] && ! contract_out="$(bun test "${security_contracts[@]}" 2>&1)"; then
    echo "  ✗ BLOCKED: handwritten migration security contract failed:" >&2
    printf '%s\n' "$contract_out" | sed 's/^/      /' >&2
    fail=1
  fi
else
  echo "  ! bun not found on PATH — skipped drizzle-kit check." >&2
fi

# 3) Warn (do not block) on destructive DDL added without an explicit marker.
for f in "${staged[@]}"; do
  case "$f" in "$MIG_DIR"/*.sql) ;; *) continue ;; esac
  # Added lines only. Use literal '+' (BRE) so this is portable to BSD/macOS
  # grep, which rejects '^\+' as an invalid repetition operator.
  added="$(git diff --cached -- "$f" 2>/dev/null | grep '^+' | grep -v '^+++')"
  if printf '%s' "$added" | grep -qiE 'drop[[:space:]]+(table|column|schema|database)|truncate'; then
    if ! printf '%s' "$added" | grep -qi 'guard:allow-destructive'; then
      echo "  ⚠ WARNING: destructive DDL (DROP/TRUNCATE) added in $f" >&2
      echo "    Back up first. If intentional, add a comment line containing" >&2
      echo "    'guard:allow-destructive' to silence this warning." >&2
    fi
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "[drizzle-guard] commit blocked. (Override only if you are certain:" >&2
  echo "                git commit --no-verify — the Cursor hook will flag it.)" >&2
  exit 1
fi

echo "[drizzle-guard] OK."
exit 0
