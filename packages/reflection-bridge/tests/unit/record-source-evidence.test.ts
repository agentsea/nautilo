import { describe, expect, test } from "bun:test";

import { ExactRecordSourceEvidenceReader } from "../../src/server/record-source-evidence";

const dependency = {
  sourceKind: "memory",
  logicalSourceRef: "memory:logical",
  observedRevision: "3",
  observedContentFingerprint: "sha256:fingerprint",
  terminalAuthorityLeafHandle: "namespace-authority",
  authorityBearing: true,
} as const;

describe("exact Record source evidence", () => {
  test("returns a currently revalidated body", async () => {
    const reader = new ExactRecordSourceEvidenceReader({
      source: { async readExact() { return { status: "available", kind: "memory", content: "Use Postgres." }; } },
      invalidation: { async admit() { throw new Error("unexpected invalidation"); } },
    });
    expect(await reader.read({
      sourceDependency: dependency,
      evidenceBindingRef: "binding",
      returnedBytesRemaining: 1_024,
    })).toEqual({
      status: "available",
      evidence: {
        evidenceRef: "exact-memory-evidence",
        kind: "memory",
        content: "Use Postgres.",
        returnedUtf8Bytes: 13,
      },
    });
  });

  test("withholds changed bytes and schedules invalidation", async () => {
    const admitted: unknown[] = [];
    const reader = new ExactRecordSourceEvidenceReader({
      source: { async readExact() { return { status: "changed" }; } },
      invalidation: { async admit(input) { admitted.push(input); } },
    });
    expect(await reader.read({
      sourceDependency: dependency,
      evidenceBindingRef: "binding",
      returnedBytesRemaining: 1_024,
    })).toEqual({ status: "unavailable", reason: "source_changed" });
    expect(admitted).toEqual([{ dependency, reason: "changed" }]);
  });
});
