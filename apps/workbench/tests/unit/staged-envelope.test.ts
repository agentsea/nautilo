import { describe, test, expect } from "bun:test";
import {
  parseAppliedEnvelope,
  parseStagedEnvelope,
} from "../../src/lib/staged-envelope";

const SAMPLE_UNIFIED_DIFF = [
  "Index: /tmp/x.md",
  "===================================================================",
  "--- /tmp/x.md",
  "+++ /tmp/x.md",
  "@@ -1,3 +1,3 @@",
  " line1",
  "-old line 2",
  "+new line 2",
  " line3",
  "",
].join("\n");

function makeAppliedEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    applied: true,
    revisionId: "rev-123",
    path: "/tmp/x.md",
    zone: "absolute",
    command: "str_replace",
    stats: { additions: 1, deletions: 1 },
    summary: "Applied: str_replace 1 occurrence",
    unifiedDiff: SAMPLE_UNIFIED_DIFF,
    ...overrides,
  });
}

function makeStagedEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    staged: true,
    patchId: "t-1:abc12345",
    path: "/tmp/x.md",
    zone: "absolute",
    command: "str_replace",
    stats: { additions: 1, deletions: 1 },
    summary: "Staged: str_replace 1 occurrence",
    unifiedDiff: SAMPLE_UNIFIED_DIFF,
    ...overrides,
  });
}

describe("parseAppliedEnvelope", () => {
  test("accepts a well-formed applied result", () => {
    const env = parseAppliedEnvelope(makeAppliedEnvelope());
    expect(env).not.toBeNull();
    expect(env?.applied).toBe(true);
    expect(env?.revisionId).toBe("rev-123");
    expect(env?.path).toBe("/tmp/x.md");
  });

  test("rejects staged:true envelopes", () => {
    expect(parseAppliedEnvelope(makeStagedEnvelope())).toBeNull();
  });

  test("rejects incomplete applied envelopes", () => {
    expect(
      parseAppliedEnvelope(
        JSON.stringify({ applied: true, path: "/tmp/x.md" }),
      ),
    ).toBeNull();
  });
});

describe("parseStagedEnvelope", () => {
  test("accepts a well-formed staged result", () => {
    const env = parseStagedEnvelope(makeStagedEnvelope());
    expect(env).not.toBeNull();
    expect(env?.staged).toBe(true);
    expect(env?.patchId).toBe("t-1:abc12345");
  });

  test("rejects applied:true envelopes", () => {
    expect(parseStagedEnvelope(makeAppliedEnvelope())).toBeNull();
  });
});
