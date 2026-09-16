/**
 * D448 fixture safety: no D448 test or fixture may opt into the protected
 * local `nautilo` database.
 *
 * This is deliberately narrower than the general D202 live-DB invariant:
 * it scans only D448 sources beneath package/application test trees and
 * turns the D448 promise (fixtures use `test-cruft`) into an explicit CI
 * rule. Runtime `bootstrapTestDbInstance()` remains the authoritative
 * guard; this rule prevents a D448 source from bypassing it by selecting the
 * default instance or enabling the exceptional override.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const SCAN_ROOTS = ["packages", "apps"] as const;
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);

const LIVE_DB_MARKERS = [
  /\bcreateDirectDb\b/,
  /\bensureDatabase\b/,
  /\bsetupOwnerAppFixture\b/,
  /\bresolveDirectAgentDatabaseConnectionString\b/,
  /\bcreateDirectAgentDb\b/,
];

// setupOwnerAppFixture bootstraps through the same protected test-db helper.
const SAFE_BOOTSTRAP_MARKERS = [/\bbootstrapTestDbInstance\b/, /\bsetupOwnerAppFixture\b/];

const DEFAULT_INSTANCE_SELECTION =
  /(?:\bNAUTILO_INSTANCE_ID\b|\benv\s*\[\s*["']NAUTILO_INSTANCE_ID["']\s*\])\s*=\s*["'](?:nautilo|default|\(default\))["']/i;
const DEFAULT_DB_OVERRIDE = /\bALLOW_DEFAULT_DB_TESTS\b/;
const DEFAULT_DATABASE_URL =
  /(?:localhost|127\.0\.0\.1|db\.localtest\.me):5434\b|postgres(?:ql)?:\/\/[^\s"'`]*:5434(?:\/|\b)|:5434\/nautilo\b/i;

type ViolationCode =
  | "protected_instance_selected"
  | "default_db_override"
  | "protected_database_url"
  | "missing_bootstrap";

type Violation = { file: string; code: ViolationCode };

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
    const status = statSync(full);
    if (status.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

function isD448TestOrFixture(absPath: string): boolean {
  const parts = relative(repoRoot, absPath).split(sep);
  const testsIndex = parts.indexOf("tests");
  if (testsIndex < 0 || !SOURCE_EXTENSIONS.has(extname(absPath))) return false;
  return parts.slice(testsIndex + 1).some((part) => /^d448(?:\b|[-_.])/i.test(part));
}

function collectD448Sources(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root), files);
  return files.filter(isD448TestOrFixture).sort();
}

function usesLiveDb(body: string): boolean {
  return LIVE_DB_MARKERS.some((marker) => marker.test(body));
}

function hasSafeBootstrap(body: string): boolean {
  return SAFE_BOOTSTRAP_MARKERS.some((marker) => marker.test(body));
}

function auditSource(file: string, body: string): Violation[] {
  const violations: Violation[] = [];
  if (DEFAULT_INSTANCE_SELECTION.test(body)) {
    violations.push({ file, code: "protected_instance_selected" });
  }
  if (DEFAULT_DB_OVERRIDE.test(body)) {
    violations.push({ file, code: "default_db_override" });
  }
  if (DEFAULT_DATABASE_URL.test(body)) {
    violations.push({ file, code: "protected_database_url" });
  }
  if (usesLiveDb(body) && !hasSafeBootstrap(body)) {
    violations.push({ file, code: "missing_bootstrap" });
  }
  return violations;
}

function auditFile(absPath: string): Violation[] {
  return auditSource(relative(repoRoot, absPath), readFileSync(absPath, "utf8"));
}

describe("D448 — fixtures never target the protected nautilo database", () => {
  test("D448 test and fixture sources select only the disposable test database", () => {
    const files = collectD448Sources();
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(auditFile);
    if (violations.length > 0) {
      const report = violations
        .map((violation) => `  - ${violation.file}: ${violation.code}`)
        .join("\n");
      throw new Error(
        [
          `Found ${violations.length} D448 protected-database fixture violation(s).`,
          report,
          "Use bootstrapTestDbInstance() (or setupOwnerAppFixture), leave NAUTILO_INSTANCE_ID unset so it selects test-cruft, and never set ALLOW_DEFAULT_DB_TESTS.",
        ].join("\n"),
      );
    }
    expect(violations).toEqual([]);
  });

  test("rejects each direct bypass in isolated synthetic sources", () => {
    expect(auditSource("synthetic/d448-default-instance.test.ts", 'process.env.NAUTILO_INSTANCE_ID = "nautilo"')).toEqual([
      { file: "synthetic/d448-default-instance.test.ts", code: "protected_instance_selected" },
    ]);
    expect(
      auditSource(
        "synthetic/d448-bracket-default-instance.test.ts",
        "process.env[\"NAUTILO_INSTANCE_ID\"] = 'nautilo'",
      ),
    ).toEqual([
      { file: "synthetic/d448-bracket-default-instance.test.ts", code: "protected_instance_selected" },
    ]);
    expect(
      auditSource(
        "synthetic/d448-single-quote-bracket-default-instance.test.ts",
        "process.env['NAUTILO_INSTANCE_ID'] = \"default\"",
      ),
    ).toEqual([
      {
        file: "synthetic/d448-single-quote-bracket-default-instance.test.ts",
        code: "protected_instance_selected",
      },
    ]);
    expect(auditSource("synthetic/d448-default-override.test.ts", "process.env.ALLOW_DEFAULT_DB_TESTS = '1'")).toEqual([
      { file: "synthetic/d448-default-override.test.ts", code: "default_db_override" },
    ]);
    expect(auditSource("synthetic/d448-default-url.test.ts", 'const url = "postgres://localhost:5434/nautilo"')).toEqual([
      { file: "synthetic/d448-default-url.test.ts", code: "protected_database_url" },
    ]);
    expect(auditSource("synthetic/d448-missing-bootstrap.test.ts", "createDirectDb()\nensureDatabase()")).toEqual([
      { file: "synthetic/d448-missing-bootstrap.test.ts", code: "missing_bootstrap" },
    ]);
    expect(auditSource("synthetic/d448-safe.test.ts", "bootstrapTestDbInstance()\ncreateDirectDb()")).toEqual([]);
  });
});
