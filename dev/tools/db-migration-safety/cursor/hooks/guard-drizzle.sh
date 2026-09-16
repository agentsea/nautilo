#!/usr/bin/env bash
#
# guard-drizzle.sh — Cursor beforeShellExecution hook.
#
# Deterministic runtime guard. Reads the hook JSON on stdin, inspects the
# shell command the agent is about to run, and asks for human approval before
# anything destructive or off-workflow for Nautilo executes.
#
# Canonical source: nautilo/dev/tools/db-migration-safety/cursor/hooks/guard-drizzle.sh
# Deployed (raw, no banner — this is a script) to <workspace>/.cursor/hooks/.
#
# Output contract (beforeShellExecution): JSON with "permission"
# ("allow" | "ask" | "deny") plus optional user_message / agent_message.
# We use "ask" so you stay in control and never get hard-locked out.
# On any internal error we fail OPEN (allow) so the guard can never wedge the
# session — the lefthook pre-commit guard is the durable backstop.

set -u

input="$(cat 2>/dev/null || true)"

# --- extract the command string (jq if present, else python3, else grep) ---
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.command // .tool_input.command // empty' 2>/dev/null || true)"
fi
if [ -z "$cmd" ] && command -v python3 >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
print(d.get("command") or (d.get("tool_input") or {}).get("command") or "")' 2>/dev/null || true)"
fi

allow() { printf '{ "permission": "allow" }\n'; exit 0; }

[ -z "$cmd" ] && allow

reason=""
add() { reason="${reason:+$reason; }$1"; }

# Lowercased copy for case-insensitive matching of SQL keywords / flags.
lc="$(printf '%s' "$cmd" | tr '[:upper:]' '[:lower:]')"

# 1) off-workflow: drizzle-kit push / db:push (bypasses migration files)
case "$lc" in
  *drizzle-kit\ push*|*drizzle-kit"  "push*) add "drizzle-kit push bypasses migration files (Nautilo uses generate+migrate)" ;;
esac
case "$lc" in
  *db:push*) add "db:push runs drizzle-kit push (off-workflow; can drop schema with no record)" ;;
esac

# Context predicates — reused by blocks 2 and 3. Without these gates, innocent
# commands get flagged: Turbo/lint/typecheck use `--force` as "ignore cache"
# (see dev/scripts/ci-gates.sh), unrelated to `git push --force` or
# `drizzle-kit push --force`.
is_db_context=0
case "$lc" in
  *psql*|*pg_dump*|*pg_restore*|*pgcli*|*mysql*|*mariadb*|*sqlite3*|*cockroach*|\
  *drizzle*|*db:migrate*|*db:push*|*db:generate*|*db:execute*|*db:check*|*db:studio*|\
  *--cwd\ packages/db*|*.sql*)
    is_db_context=1 ;;
esac

is_git_context=0
case "$lc" in
  *git\ push*|*git\ rebase*|*git\ commit*|*git\ merge*|*git\ am*|*git\ cherry-pick*)
    is_git_context=1 ;;
esac

# 2) dangerous force/yes/no-verify flags — ONLY in git or db context.
if [ "$is_git_context" -eq 1 ]; then
  case "$lc" in
    *--force-with-lease*) : ;;  # safe rebase push; not flagged on its own
    *--force*) add "--force flag on git command" ;;
  esac
  case "$lc" in
    *--no-verify*) add "--no-verify bypasses the pre-commit migration guard" ;;
  esac
fi
if [ "$is_db_context" -eq 1 ]; then
  case "$lc" in
    *--force*) add "--force on db/migration command" ;;
  esac
  case "$lc" in
    *drizzle*--yes*|*migrate*--yes*|*db:*--yes*) add "auto-confirm (--yes) on a db/migration command" ;;
  esac
fi

# 3) destructive SQL DDL/DML — ONLY in a real DB/SQL context.
#
# Without the context gate, the bare words "truncate" / "drop" / "delete"
# match unrelated commands: the unix `truncate -s 0 file`, a `git commit`
# whose message describes truncated output, a `--drop` flag, etc. SQL is
# only executed in Nautilo through a DB client (psql/…), drizzle-kit, the
# `db:*` scripts, or a `.sql` file being run/piped — so we require one of
# those tokens before treating DROP/TRUNCATE/DELETE as destructive SQL.
# Real destructive vectors keep firing: `drizzle-kit push --force` is still
# caught by blocks 1+2 regardless of this gate.

if [ "$is_db_context" -eq 1 ]; then
  case "$lc" in
    *drop\ table*|*drop\ schema*|*drop\ database*) add "DROP TABLE/SCHEMA/DATABASE" ;;
  esac
  case "$lc" in
    *truncate*) add "TRUNCATE" ;;
  esac
  # DELETE FROM without a WHERE (best-effort): has "delete from" but no "where"
  case "$lc" in
    *delete\ from*)
      case "$lc" in
        *where*) : ;;
        *) add "DELETE without WHERE" ;;
      esac
      ;;
  esac
fi

if [ -n "$reason" ]; then
  esc_cmd="$(printf '%s' "$cmd" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null || printf '%s' "$cmd")"
  esc_reason="$(printf '%s' "$reason" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null || printf '%s' "$reason")"
  printf '{ "permission": "ask", "user_message": "Drizzle/DB safety guard flagged this command (%s). Review before allowing.", "agent_message": "Blocked pending approval: %s. This is off-workflow or destructive for Nautilo (generate+migrate only; never push/--force/DROP without explicit human sign-off)." }\n' \
    "$esc_reason" "$esc_reason"
  exit 0
fi

allow
