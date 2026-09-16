/**
 * ISSUE-M212 Phase 5 — repo invariant for the pool-construction allowlist.
 *
 * Ensures every allowlisted path exists, carries a non-empty reason, and that
 * no runtime request/boot path under packages/{trust,server,runtime}/src is
 * allowlisted.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FORBIDDEN_ALLOWLIST_PREFIXES,
  REPO_ROOT,
  loadAllowlistDocument,
  normalizeRepoRelativePath,
  validateAllowlistDocument,
} from "../../../packages/db/eslint/load-allowlist.mjs";

const allowlistPath = join(
  REPO_ROOT,
  "packages/db/eslint/m212-pool-construction-allowlist.json",
);

describe("M212 Phase 5 — pool-construction allowlist invariants", () => {
  test("every entry exists, has a reason, and no runtime request path is allowlisted", () => {
    const raw = readFileSync(allowlistPath, "utf8");
    const doc = loadAllowlistDocument(allowlistPath);

    expect(doc.entries.length).toBeGreaterThan(0);

    const structuralErrors = validateAllowlistDocument(doc, { checkPathsExist: false });
    expect(structuralErrors).toEqual([]);

    const missingPaths: string[] = [];
    const emptyReasons: string[] = [];
    const forbiddenPaths: string[] = [];

    for (const entry of doc.entries) {
      const rel = normalizeRepoRelativePath(entry.path);
      const abs = join(REPO_ROOT, rel);

      if (!existsSync(abs)) {
        missingPaths.push(rel);
      }
      if (!entry.reason?.trim()) {
        emptyReasons.push(rel);
      }
      if (FORBIDDEN_ALLOWLIST_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
        forbiddenPaths.push(rel);
      }
    }

    if (missingPaths.length > 0 || emptyReasons.length > 0 || forbiddenPaths.length > 0) {
      throw new Error(
        [
          "M212 pool-construction allowlist invariant failed.",
          "",
          missingPaths.length
            ? `Missing paths (${missingPaths.length}):\n${missingPaths.map((p) => `  - ${p}`).join("\n")}`
            : "Missing paths: (none)",
          "",
          emptyReasons.length
            ? `Empty reasons (${emptyReasons.length}):\n${emptyReasons.map((p) => `  - ${p}`).join("\n")}`
            : "Empty reasons: (none)",
          "",
          forbiddenPaths.length
            ? `Forbidden runtime request paths (${forbiddenPaths.length}):\n${forbiddenPaths.map((p) => `  - ${p}`).join("\n")}`
            : "Forbidden runtime request paths: (none)",
          "",
          `Allowlist file: ${allowlistPath}`,
          `Document bytes: ${raw.length}`,
        ].join("\n"),
      );
    }

    expect(missingPaths).toEqual([]);
    expect(emptyReasons).toEqual([]);
    expect(forbiddenPaths).toEqual([]);
  });
});
