#!/usr/bin/env bash
# Shared commands used by GitHub Actions, lefthook, and `bun run ci:local`.
# The ordinary gates define the PR lint/typecheck/unit-test verdict. Encryption
# assurance is scheduled separately from those gates and is not part of `all`.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dev/scripts/ci-gates.sh <gate>

Gates:
  lint-eslint      Run affected ESLint via Turbo
  test-invariants Run repo invariant tests
  query-inventory  Reject unreviewed direct-query inventory changes
  lint-unused      Run Knip
  typecheck        Run affected TypeScript checks via Turbo
  unit             Run affected unit tests via Turbo
  encryption-indicators Run Wave 0 check, decision coverage, integration, and property indicators
  encryption-assurance Run Wave 0 indicators followed by mutation assurance
  lint             Run lint-eslint, repository invariants, query inventory, and lint-unused
  all              Run lint, typecheck, unit
EOF
}

run_cmd() {
  local gate="$1"
  shift
  echo "=== ci gate: ${gate} ==="
  echo "+ $*"
  if "$@"; then
    return 0
  else
    local status=$?
    echo "ERROR: ci gate failed: ${gate}" >&2
    echo "  Re-run: bash dev/scripts/ci-gates.sh ${gate}" >&2
    exit "$status"
  fi
}

run_gate() {
  case "${1:-}" in
    lint-eslint)
      run_cmd lint-eslint bun run lint -- --affected
      run_cmd board-build bunx turbo run build --filter=@nautilo/office-board...
      run_cmd lint-board bun run --cwd packages/first-party-apps/board lint
      ;;
    test-invariants)
      run_cmd test-invariants bun run test:invariants
      ;;
    query-inventory)
      run_cmd query-inventory bun run db:query-inventory:check
      ;;
    lint-unused)
      run_cmd lint-unused bun run lint:unused
      ;;
    typecheck)
      # Match the CI typecheck step for local gates and their mini-app checks.
      export NODE_OPTIONS=--max-old-space-size=5120
      export TURBO_CONCURRENCY="${TURBO_CONCURRENCY:-1}"
      run_cmd typecheck bun run typecheck -- --affected
      # First-party mini-apps are sandbox bundles outside Turbo's workspace glob.
      # Keep Video's editor and behavioral fixtures in the qualification gate.
      run_cmd typecheck-video bun run --cwd packages/first-party-apps/video typecheck
      # Slides imports its prepared engine from an ignored app-local directory.
      run_cmd slides-prepare bun run slides:prepare
      run_cmd typecheck-slides bun run --cwd packages/first-party-apps/presentation typecheck
      run_cmd board-build bunx turbo run build --filter=@nautilo/office-board...
      run_cmd typecheck-board bun run --cwd packages/first-party-apps/board typecheck
      ;;
    unit)
      # Root-owned changes make Turbo select the orchestration workspace (`//`).
      # Invoke Turbo directly and exclude that non-test root exactly once. The
      # transit dependency in turbo.json makes upstream source part of each
      # package's test hash, so cache reuse remains cross-package correct.
      run_cmd unit bunx turbo run test:unit --affected --filter='!//'
      run_cmd slides-prepare bun run slides:prepare
      run_cmd unit-slides bun test packages/first-party-apps/presentation/src
      run_cmd board-build bunx turbo run build --filter=@nautilo/office-board...
      run_cmd unit-board bun test packages/first-party-apps/board/src
      run_cmd schema-board bun run --cwd packages/first-party-apps/board schema:check
      ;;
    encryption-indicators)
      run_cmd encryption-check bun run encryption:check
      run_cmd encryption-decision-coverage bun run --cwd packages/encryption-invariants test:coverage
      run_cmd encryption-integration bun run --cwd packages/encryption-invariants test:integration
      run_cmd encryption-property bun run --cwd packages/encryption-invariants test:property
      ;;
    encryption-assurance)
      run_gate encryption-indicators
      run_cmd encryption-mutation bun run --cwd packages/encryption-invariants test:mutation
      ;;
    lint)
      run_gate lint-eslint
      run_gate test-invariants
      run_gate query-inventory
      run_gate lint-unused
      ;;
    all)
      run_gate lint
      run_gate typecheck
      run_gate unit
      ;;
    ""|help|--help|-h)
      usage
      ;;
    *)
      echo "Unknown CI gate: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
}

run_gate "${1:-}"
