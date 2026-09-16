/**
 * M212 Phase 4 — static guard for `packages/trust/src/queries.ts`.
 * Asserts the runtime trust query module uses shared role-correct pools and
 * does not construct or tear down per-call postgres-js handles.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const QUERIES_SOURCE = readFileSync(
  join(import.meta.dir, "../../src/queries.ts"),
  "utf8",
);

/** Strip block and line comments so comment-only mentions do not false-positive. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("queries.ts uses shared direct pools (M212 Phase 4)", () => {
  const executable = stripComments(QUERIES_SOURCE);

  it("does not import or call per-call direct pool factories", () => {
    expect(executable).not.toMatch(/\bcreateDirectDb\b/);
    expect(executable).not.toMatch(/\bcreateDirectAgentDb\b/);
  });

  it("uses role-correct shared accessors", () => {
    expect(executable).toMatch(/\bgetSharedDirectDb\s*\(/);
    expect(executable).toMatch(/\bgetSharedDirectAgentDb\s*\(/);
  });

  it("does not end shared local handles acquired in this module", () => {
    expect(executable).not.toMatch(/\bawait\s+db\.end\s*\(/);
    expect(executable).not.toMatch(/\bawait\s+scopeDb\.end\s*\(/);
  });
});
