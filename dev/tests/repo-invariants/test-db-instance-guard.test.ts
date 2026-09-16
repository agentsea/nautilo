/**
 * ISSUE-D202 — repo invariant: live-DB tests must not pollute `(default)`.
 *
 * Every test file that mutates a real Postgres (calls `createDirectDb`,
 * `ensureDatabase`, an agent-role direct connection, or the server
 * `setupOwnerAppFixture`) MUST:
 *
 *   1. Route itself at the disposable scratch instance and refuse the
 *      protected `(default)` — either by calling `bootstrapTestDbInstance`
 *      / `assertFixtureDbMutationAllowed` (from `@nautilo/db/testing`), or
 *      by going through `setupOwnerAppFixture` (which guards internally).
 *   2. NOT hardcode the protected `(default)` Postgres host port `5434`.
 *      `createDirectDb()` routes by `NAUTILO_INSTANCE_ID`, so any
 *      `localhost:5434` / `db.localtest.me:5434` / `:5434/nautilo`
 *      literal in a live-DB test is either dead (misleading) or an active
 *      footgun pointing writes at the operator's dogfood DB.
 *
 * This is the always-on backstop for the D202 guard: it fails CI when a
 * NEW live-DB test is added without the guard, so the `st-rm-*`-style
 * default-DB pollution cannot regress.
 *
 * To exempt a file (it tests the bootstrap/connection machinery itself),
 * add it to `EXEMPT` below WITH a reason.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const SCAN_ROOTS = ["packages", "bin"] as const;
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git"]);

/**
 * Live-DB markers: presence means the file mutates a real Postgres.
 * `db.localtest.me` proxy host is intentionally NOT a marker — only the
 * write/bootstrap entry points are.
 */
const LIVE_DB_MARKERS = [
  /\bcreateDirectDb\b/,
  /\bensureDatabase\b/,
  /\bsetupOwnerAppFixture\b/,
  /\bresolveDirectAgentDatabaseConnectionString\b/,
  /\bcreateDirectAgentDb\b/,
];

const GUARD_MARKERS = [
  /\bbootstrapTestDbInstance\b/,
  /\bassertFixtureDbMutationAllowed\b/,
  /\bsetupOwnerAppFixture\b/,
];

/** Hardcoded protected-default Postgres host port. */
const HARDCODED_DEFAULT_PORT =
  /(?:localhost|db\.localtest\.me|127\.0\.0\.1):5434\b|:5434\/nautilo/;

/**
 * Files that legitimately reference the machinery they test. Each entry
 * is a repo-relative path and a one-line reason.
 */
const EXEMPT: Record<string, string> = {
  // Pure resolver/unit tests — reference a marker symbol but never open a
  // real Postgres connection.
  "packages/db/tests/unit/agent-database-exports.test.ts":
    "pure resolver unit test (env-override branch); no DB connection",
  "packages/db/tests/unit/ensure-database-container-branch.test.ts":
    "asserts ensureDatabase() throws without DB_DIRECT_CONNECTION; no default-DB write",
  "packages/db/tests/unit/shared-direct-pools.test.ts":
    "mock.module(postgres); shared-pool unit test never opens a real connection",
  "packages/db/tests/unit/m212-no-adhoc-pool-construction.test.ts":
    "RuleTester source fixtures reference pool factories; no DB connection",
  "packages/db/tests/unit/m212-phase4-db-utils-pool-consolidation.test.ts":
    "static source guard for shared-pool migration; no DB connection",
  "packages/runtime/tests/unit/m212-phase4-runtime-boot-pool-consolidation.test.ts":
    "static source guard for shared-pool migration; no DB connection",
  "packages/trust/tests/unit/m212-phase4-trust-pool-consolidation.test.ts":
    "static source guard for shared-pool migration; no DB connection",
  "packages/trust/tests/unit/agent-ownership-lookup.test.ts":
    "asserts short-circuit before createDirectDb (token only in comment); no real DB",
  // `mock.module("@nautilo/db")` isolated unit tests — createDirectDb is a
  // mock, not a real connection.
  "packages/agent/tests/unit-isolated/artifact-store-trust-context.test.ts":
    "mock.module(@nautilo/db); createDirectDb is mocked",
  "packages/agent/tests/unit-isolated/memory-store-junction-m076.test.ts":
    "mock.module(@nautilo/db); createDirectDb is mocked",
  "packages/agent/tests/unit-isolated/scope-memory-store-trust-context.test.ts":
    "mock.module(@nautilo/db); createDirectDb is mocked",
  "packages/agent/tests/unit-isolated/trust-agent-db.test.ts":
    "mock.module(@nautilo/db); createDirectDb is mocked",
  "packages/trust/tests/unit-isolated/agent-scopes-queries.test.ts":
    "mock.module(@nautilo/db); createDirectDb is mocked",
  "packages/trust/tests/unit-isolated/memory-access-helpers.test.ts":
    "mock.module(@nautilo/db); createDirectDb is mocked (M173 helper unit test)",
  "packages/server/tests/unit-isolated/rooms-routes.test.ts":
    "mock.module(@nautilo/db); createDirectDb is mocked for D287/D194 archive+visibility route tests",
  "packages/server/tests/unit-isolated/redeem-invite-bootstrap-used.test.ts":
    "local fake createDirectDb + mock.module(@nautilo/db); no real DB",
  // Stack 198 — pure cleanup helper / pre-DB validation tests; createDirectDb
  // appears only in comments documenting why the seam is not injectable.
  "bin/nautilo-dev/tests/unit/cleanup-deletion-order.test.ts":
    "pure cleanupDeletionOrder helper; no DB connection",
  "bin/nautilo-dev/tests/unit/cleanup-destructive-seatbelt.test.ts":
    "pure destructiveSeatbeltSql helper; no DB connection",
  "bin/nautilo-dev/tests/unit/cleanup-test-cruft-explicit-ids.test.ts":
    "pre-DB validation only (returns before createDirectDb); no DB connection",
  "bin/nautilo-dev/tests/unit/cleanup-test-cruft-plan-out.test.ts":
    "pre-DB validation + atomicWritePlanFile; no DB connection",
  // Stack 198 — exercises setupTestDb routing with mocked ensureDatabase; 5434
  // literals are stale-override fixtures cleared by bootstrapTestDbInstance.
  "packages/runtime/tests/unit-isolated/setup-test-db-routing.test.ts":
    "mock.module ensureDatabase; bootstrapTestDbInstance routing guard unit test",
};

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

function collectTestFiles(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(join(repoRoot, root), out);
  }
  return out.sort();
}

function isLiveDbFile(body: string): boolean {
  return LIVE_DB_MARKERS.some((re) => re.test(body));
}

function hasGuard(body: string): boolean {
  return GUARD_MARKERS.some((re) => re.test(body));
}

type Violation = { file: string; code: "missing_guard" | "hardcoded_default_port" };

function auditFile(absPath: string): Violation[] {
  const rel = relative(repoRoot, absPath);
  if (rel in EXEMPT) return [];
  const body = readFileSync(absPath, "utf8");
  if (!isLiveDbFile(body)) return [];

  const violations: Violation[] = [];
  if (!hasGuard(body)) {
    violations.push({ file: rel, code: "missing_guard" });
  }
  if (HARDCODED_DEFAULT_PORT.test(body)) {
    violations.push({ file: rel, code: "hardcoded_default_port" });
  }
  return violations;
}

describe("D202 — live-DB tests are routed off the protected default", () => {
  test("every live-DB test guards its instance and avoids the default port", () => {
    const files = collectTestFiles();
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(auditFile);

    if (violations.length > 0) {
      const byCode = (code: Violation["code"]) =>
        violations
          .filter((v) => v.code === code)
          .map((v) => `  - ${v.file}`)
          .sort()
          .join("\n");
      const report = [
        `Found ${violations.length} D202 live-DB guard violation(s).`,
        "",
        "Missing instance guard (add `bootstrapTestDbInstance()` from",
        "`@nautilo/db/testing` as the first line of beforeAll, or use",
        "`setupOwnerAppFixture`):",
        byCode("missing_guard") || "  (none)",
        "",
        "Hardcoded protected-default port 5434 (remove it — `createDirectDb`",
        "routes by NAUTILO_INSTANCE_ID, which `bootstrapTestDbInstance`",
        "defaults to test-cruft):",
        byCode("hardcoded_default_port") || "  (none)",
      ].join("\n");
      throw new Error(report);
    }

    expect(violations).toEqual([]);
  });
});
