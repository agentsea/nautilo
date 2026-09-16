#!/usr/bin/env bash
#
# D060 Sprint 1 G5.6 red-team test (ship plan v3 §11).
#
# Verifies that the four policy-affecting env vars deleted in Sprint 1
# have ZERO reads in the codebase — not deprecated, not silenced,
# GONE. Also verifies the ESLint rule that bans reintroduction fires
# as expected on a synthetic violation (defense-in-depth: even if a
# grep false-negatives, the lint rule catches it on the next commit).
#
# Exit codes:
#   0 — clean (no reads anywhere, lint rule works)
#   1 — at least one banned read found OR the lint rule didn\u0027t fire
#
# Usage: ops/security/red-team-env-var.sh
#
# Run this locally before cutting a release build and in CI to prevent
# regression.

set -uo pipefail

cd "$(dirname "$0")/../.."

# PR-017 nit — trap cleanup for all probe files. If the script is
# SIGINT'd mid-lint or mid-grep, the probes get removed before the
# next invocation sees them as stale source (which would produce
# confusing lint errors when a human re-runs from a fresh shell).
PROBE_PATHS=()
cleanup() {
  for p in "${PROBE_PATHS[@]-}"; do
    [[ -n "${p}" ]] && rm -f "${p}"
  done
}
trap cleanup EXIT INT TERM

BANNED_VARS=(
  "NAUTILO_SECURITY_LEVEL"
  "NAUTILO_SANDBOX_RELAY"
  "NAUTILO_DEPLOYMENT"
  "NAUTILO_TLS"
  # D120 Stack 1 — retired by A1.P1 / A1.P1b (DB-as-source-of-truth).
  # Production code reads owner / owner-actor / default-agent ids
  # from the bootstrap-state-cache (@nautilo/trust); reseating any
  # of these into a `process.env[...]` read regresses the cloud-mode
  # discipline (ephemeral filesystems, no per-instance config.env to
  # round-trip the value through).
  "NAUTILO_OWNER_ID"
  "NAUTILO_DEFAULT_AGENT_ID"
  "NAUTILO_OWNER_ACTOR_ID"
)

# Search scope: production source only. Test files + node_modules +
# docs + build output are excluded. The ship plan §11 "grep production
# bundle" intent is for shipped code, not scaffolding.
SEARCH_PATHS=(packages bin apps)
EXCLUDES=(
  --glob='!**/node_modules/**'
  --glob='!**/dist/**'
  --glob='!**/.turbo/**'
  --glob='!**/build/**'
  --glob='!**/tests/**'
  --glob='!**/*.test.ts'
  --glob='!**/__redteam_lint_probe__*'
)

fail=0
echo "=== G5.6 red-team grep ==="
for var in "${BANNED_VARS[@]}"; do
  echo -n "Checking for reads of ${var}... "
  # Search for `process.env[...]` or `process.env.` access patterns
  # in production source. Plain occurrences in comments / docs are
  # ignored by the limited pattern.
  matches=$(rg -n --no-heading "process\.env\[\"${var}\"\]|process\.env\.${var}\b" \
    "${SEARCH_PATHS[@]}" "${EXCLUDES[@]}" 2>/dev/null || true)
  if [[ -z "${matches}" ]]; then
    echo "CLEAN"
  else
    echo "FOUND"
    echo "${matches}"
    fail=1
  fi
done

echo ""
echo "=== G5.6 lint-rule self-test ==="
# PR-017 MINOR #4 — two-sided fixture: POSITIVE probe (policy-env
# var, MUST be flagged) + NEGATIVE probe (legitimate non-policy env
# var, MUST NOT be flagged). Without the negative side, a future
# over-broadening of the selector (e.g. "all process.env reads") would
# pass the one-sided self-test while breaking every legitimate env
# read in the tree — caught only at the next full `bun run lint` against
# the whole workspace. The red-team script is the fast pre-release
# gate; it must pin both directions.

POSITIVE_PROBE="packages/server/src/__redteam_positive_probe__.ts"
NEGATIVE_PROBE="packages/server/src/__redteam_negative_probe__.ts"
PROBE_PATHS=("${POSITIVE_PROBE}" "${NEGATIVE_PROBE}")

cat > "${POSITIVE_PROBE}" <<'PROBE'
// G5.6 red-team POSITIVE probe — DELETED by ops/security/red-team-env-var.sh
// after the lint-assertion runs. If you see this file committed,
// the red-team script failed mid-run; delete manually.
// MUST be flagged by no-policy-env-var.
export function positiveProbe(): string | undefined {
  return process.env["NAUTILO_SECURITY_LEVEL"];
}
PROBE

cat > "${NEGATIVE_PROBE}" <<'PROBE'
// G5.6 red-team NEGATIVE probe — DELETED by ops/security/red-team-env-var.sh
// after the lint-assertion runs. MUST NOT be flagged — the rule must
// allow legitimate non-policy env var reads (NAUTILO_PORT is a well-
// known benign example used elsewhere in bin/nautilo-server).
export function negativeProbe(): string | undefined {
  return process.env["NAUTILO_PORT"];
}
PROBE

probe_output=$(bun run --filter @nautilo/server lint 2>&1 || true)
rm -f "${POSITIVE_PROBE}" "${NEGATIVE_PROBE}"
PROBE_PATHS=()

# Positive assertion: rule MUST fire on the NAUTILO_SECURITY_LEVEL
# read inside the positive probe. ESLint emits the filename on one
# line and the error on the next, so we use `grep -A 5` to grab the
# few lines after the positive probe's path header and check that
# `no-policy-env-var` appears in that window.
positive_context=$(echo "${probe_output}" | grep -A 5 "__redteam_positive_probe__" || true)
if echo "${positive_context}" | grep -q "no-policy-env-var"; then
  echo "Lint rule fires on synthetic violation (positive probe): OK"
else
  echo "Lint rule did NOT fire on synthetic violation — ESLint config drift."
  echo "---"
  echo "${probe_output}" | tail -20
  echo "---"
  fail=1
fi

# Negative assertion: rule MUST NOT fire on the NAUTILO_PORT read.
# Same windowed-grep pattern — look for no-policy-env-var anywhere
# in the few lines following the negative probe's path header. Any
# match means the selector has over-broadened and is flagging
# legitimate env reads (which would break every legitimate
# NAUTILO_* env read elsewhere in the tree).
negative_context=$(echo "${probe_output}" | grep -A 5 "__redteam_negative_probe__" || true)
if echo "${negative_context}" | grep -q "no-policy-env-var"; then
  echo "Lint rule FALSE-POSITIVE on negative probe — selector has over-broadened."
  echo "---"
  echo "${negative_context}" | head -10
  echo "---"
  fail=1
else
  echo "Lint rule silent on legitimate env var (negative probe): OK"
fi

echo ""
echo "=== D120 Stack 1 user-data dir hygiene ==="
#
# Extension 1 (above) is the SOURCE-CODE defense — "don't re-introduce
# the read". This section is the RUNTIME defense — "don't re-introduce
# the write". After A1+A1.5 land, no per-instance config.env should
# carry the retired identity vars (DB is the source of truth, env is
# read-only in cloud mode). Operator reading these values from a
# config.env after a successful claim+restart is exactly the F-1
# regression we're closing.
#
# NAUTILO_USER_DATA_DIR override lets CI / containers point at a tmp
# dir; default scans the operator's home for ~/.nautilo*/.

USER_DATA_BANNED_VARS=(
  "NAUTILO_OWNER_ID"
  "NAUTILO_DEFAULT_AGENT_ID"
  "NAUTILO_OWNER_ACTOR_ID"
)

USER_DATA_ROOT="${NAUTILO_USER_DATA_DIR:-${HOME}}"

scanned_any=0
shopt -s nullglob
# M091: scan both filenames during the deprecation window
for suffix in config.env instance.env; do
  for cfg in "${USER_DATA_ROOT}/.nautilo"*/${suffix}; do
  scanned_any=1
  echo -n "Checking ${cfg}... "
  cfg_violations=()
  for var in "${USER_DATA_BANNED_VARS[@]}"; do
    if grep -E "^${var}=" "${cfg}" >/dev/null 2>&1; then
      cfg_violations+=("${var}")
    fi
  done
  if [[ ${#cfg_violations[@]} -eq 0 ]]; then
    echo "CLEAN"
  else
    echo "FOUND: ${cfg_violations[*]}"
    fail=1
  fi
  done
done

# Stale post-claim files. claim-invite.txt should auto-delete on a
# successful claim (D119 §6); we can't probe setupState from this
# script, so warn rather than fail. owner-bootstrap.txt is A6-only
# territory (not Stack 1 — pre-claim only), so it gets the same
# soft warning treatment.
for stale in "${USER_DATA_ROOT}/.nautilo"*/claim-invite.txt; do
  scanned_any=1
  echo "WARN: stale ${stale} — should auto-delete on successful claim (D119 §6)"
done
shopt -u nullglob

if [[ ${scanned_any} -eq 0 ]]; then
  echo "(no ~/.nautilo*/ user-data dirs found under ${USER_DATA_ROOT}; skipping runtime hygiene check)"
fi

echo ""
if [[ ${fail} -eq 0 ]]; then
  echo "=== RED-TEAM PASS ==="
  exit 0
else
  echo "=== RED-TEAM FAIL ==="
  exit 1
fi
