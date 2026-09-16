/**
 * D266 Wave 3 — unit tests for the pure canonical plan fingerprint and
 * fixture-manifest structural validation helpers in
 * `cleanup-test-cruft-classification.ts`. No DB, no filesystem — these
 * exercise the deterministic SHA-256 over the canonical plan surface and
 * the manifest validator's accept / reject boundaries.
 */
import { describe, expect, test } from "bun:test";
import {
  buildCanonicalPlanObject,
  canonicalJsonString,
  computePlanFingerprint,
  isExactUuid,
  isSha256Hex,
  validateCleanupPlanManifest,
  type CanonicalPlanFingerprintInput,
  type FingerprintCandidateEntry,
  type FingerprintKeepEntry,
} from "../../src/commands/cleanup-test-cruft-classification";

const CMD = "dev:cleanup-test-cruft";

function keep(id: string, handle: string | null, createdAt: string): FingerprintKeepEntry {
  return { id, handle, name: null, createdAt };
}

function cand(id: string, identityClass: FingerprintCandidateEntry["identityClass"]): FingerprintCandidateEntry {
  return { id, identityClass };
}

function baseInput(over: Partial<CanonicalPlanFingerprintInput> = {}): CanonicalPlanFingerprintInput {
  return {
    command: CMD,
    keepSet: [keep("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "alex", "2025-12-01T00:00:00.000Z")],
    deletionCap: 1000,
    automaticCandidates: [cand("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ordinary-authenticated")],
    protectedRefusals: [
      cand("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "unknown-credentialless"),
      cand("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "half-redeemed"),
    ],
    protectedIdentities: [
      cand("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "unknown-credentialless"),
      cand("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "half-redeemed"),
    ],
    orphanAgentsToDelete: [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", handle: "undo-turn-e2e-1" }],
    ...over,
  };
}

describe("canonicalJsonString", () => {
  test("sorts object keys recursively", () => {
    expect(canonicalJsonString({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("preserves array order", () => {
    expect(canonicalJsonString([3, 1, 2])).toBe("[3,1,2]");
  });

  test("stable for nested objects regardless of key order", () => {
    expect(canonicalJsonString({ outer: { z: 1, a: 2 } })).toBe(
      canonicalJsonString({ outer: { a: 2, z: 1 } }),
    );
  });
});

describe("buildCanonicalPlanObject", () => {
  test("re-sorts arrays by id so caller order cannot perturb the hash", () => {
    const a = buildCanonicalPlanObject({
      ...baseInput(),
      automaticCandidates: [
        cand("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ordinary-authenticated"),
        cand("11111111-1111-4111-8111-111111111111", "ordinary-authenticated"),
      ],
    });
    const b = buildCanonicalPlanObject({
      ...baseInput(),
      automaticCandidates: [
        cand("11111111-1111-4111-8111-111111111111", "ordinary-authenticated"),
        cand("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ordinary-authenticated"),
      ],
    });
    expect(a).toEqual(b);
    expect((a as { automaticCandidates: { id: string }[] }).automaticCandidates[0]!.id).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  test("keeps bootstrap-seed inside protectedRefusals but out of protectedIdentities", () => {
    const obj = buildCanonicalPlanObject({
      ...baseInput(),
      protectedRefusals: [
        cand("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "unknown-credentialless"),
        cand("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "half-redeemed"),
        cand("seed0000-0000-4000-8000-000000000000", "bootstrap-seed"),
      ],
      protectedIdentities: [
        cand("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "unknown-credentialless"),
        cand("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "half-redeemed"),
      ],
    }) as { protectedRefusals: { cls: string }[]; protectedIdentities: { cls: string }[] };
    expect(obj.protectedRefusals.map((e) => e.cls)).toContain("bootstrap-seed");
    expect(obj.protectedIdentities.map((e) => e.cls)).not.toContain("bootstrap-seed");
  });
});

describe("computePlanFingerprint", () => {
  test("returns a 64-char lowercase hex SHA-256", () => {
    const fp = computePlanFingerprint(baseInput());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(isSha256Hex(fp)).toBe(true);
  });

  test("is stable for semantically identical input", () => {
    expect(computePlanFingerprint(baseInput())).toBe(computePlanFingerprint(baseInput()));
  });

  test("is order-independent for keep-set / candidate arrays", () => {
    const inputA = baseInput();
    const inputB: CanonicalPlanFingerprintInput = {
      ...baseInput(),
      keepSet: [...inputA.keepSet].reverse(),
      protectedRefusals: [...inputA.protectedRefusals].reverse(),
      protectedIdentities: [...inputA.protectedIdentities].reverse(),
    };
    expect(computePlanFingerprint(inputA)).toBe(computePlanFingerprint(inputB));
  });

  test("changes when a reviewed deletion target (automatic candidate) changes", () => {
    const a = computePlanFingerprint(baseInput());
    const b = computePlanFingerprint({
      ...baseInput(),
      automaticCandidates: [
        ...baseInput().automaticCandidates,
        cand("22222222-2222-4222-8222-222222222222", "ordinary-authenticated"),
      ],
    });
    expect(a).not.toBe(b);
  });

  test("changes when a protected identity is added", () => {
    const a = computePlanFingerprint(baseInput());
    const added = cand("33333333-3333-4333-8333-333333333333", "half-redeemed");
    const b = computePlanFingerprint({
      ...baseInput(),
      protectedRefusals: [...baseInput().protectedRefusals, added],
      protectedIdentities: [...baseInput().protectedIdentities, added],
    });
    expect(a).not.toBe(b);
  });

  test("changes when the keep set changes", () => {
    const a = computePlanFingerprint(baseInput());
    const b = computePlanFingerprint({
      ...baseInput(),
      keepSet: [keep("ffffffff-ffff-4fff-8fff-ffffffffffff", "taylor", "2026-01-01T00:00:00.000Z")],
    });
    expect(a).not.toBe(b);
  });

  test("changes when the deletion cap changes", () => {
    const a = computePlanFingerprint(baseInput());
    const b = computePlanFingerprint({ ...baseInput(), deletionCap: 500 });
    expect(a).not.toBe(b);
  });

  test("does NOT change when only the override-eligible set order changes", () => {
    const a = computePlanFingerprint(baseInput());
    const b = computePlanFingerprint({
      ...baseInput(),
      protectedIdentities: [...baseInput().protectedIdentities].sort((x, y) =>
        x.id < y.id ? 1 : -1,
      ),
    });
    expect(a).toBe(b);
  });
});

describe("validateCleanupPlanManifest", () => {
  function okManifest(over: Record<string, unknown> = {}): unknown {
    return {
      command: CMD,
      mode: "plan-json",
      readOnly: true,
      applyWouldRun: false,
      planFingerprint: computePlanFingerprint(baseInput()),
      protectedIdentities: [
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ],
      deletionCap: 1000,
      keepSet: [],
      candidates: {
        protectedRefusals: [
          { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", identityClass: "unknown-credentialless" },
        ],
      },
      ...over,
    };
  }

  test("accepts a well-formed manifest", () => {
    const r = validateCleanupPlanManifest(okManifest(), CMD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.protectedIdentities).toEqual([
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ]);
      expect(isSha256Hex(r.planFingerprint)).toBe(true);
    }
  });

  test("accepts a manifest without protectedIdentities (defaults to empty)", () => {
    const r = validateCleanupPlanManifest(
      okManifest({ protectedIdentities: undefined }),
      CMD,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.protectedIdentities).toEqual([]);
  });

  test("rejects a non-object manifest", () => {
    expect(validateCleanupPlanManifest("nope", CMD).ok).toBe(false);
    expect(validateCleanupPlanManifest(null, CMD).ok).toBe(false);
    expect(validateCleanupPlanManifest([], CMD).ok).toBe(false);
  });

  test("rejects a command mismatch", () => {
    const r = validateCleanupPlanManifest(okManifest({ command: "dev:other" }), CMD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("command mismatch");
  });

  test("rejects a missing / malformed planFingerprint", () => {
    expect(validateCleanupPlanManifest(okManifest({ planFingerprint: "abc" }), CMD).ok).toBe(false);
    expect(validateCleanupPlanManifest(okManifest({ planFingerprint: undefined }), CMD).ok).toBe(false);
    expect(
      validateCleanupPlanManifest(
        okManifest({ planFingerprint: "A".repeat(64) }),
        CMD,
      ).ok,
    ).toBe(false);
  });

  test("rejects a non-positive deletionCap", () => {
    expect(validateCleanupPlanManifest(okManifest({ deletionCap: 0 }), CMD).ok).toBe(false);
    expect(validateCleanupPlanManifest(okManifest({ deletionCap: -1 }), CMD).ok).toBe(false);
    expect(validateCleanupPlanManifest(okManifest({ deletionCap: 1.5 }), CMD).ok).toBe(false);
  });

  test("rejects protectedIdentities that are not exact UUIDs (prefix / wildcard)", () => {
    const r = validateCleanupPlanManifest(
      okManifest({ protectedIdentities: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "d386-*"] }),
      CMD,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("exact UUIDs");
  });

  test("rejects a non-array candidates.protectedRefusals", () => {
    const r = validateCleanupPlanManifest(
      okManifest({ candidates: { protectedRefusals: "nope" } }),
      CMD,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("protectedRefusals is not an array");
  });

  test("rejects candidates.protectedRefusals entries without a string id", () => {
    const r = validateCleanupPlanManifest(
      okManifest({ candidates: { protectedRefusals: [{ identityClass: "half-redeemed" }] } }),
      CMD,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("must be {id: string");
  });
});

describe("isSha256Hex / isExactUuid guards", () => {
  test("isSha256Hex accepts only 64-char lowercase hex", () => {
    expect(isSha256Hex("0".repeat(64))).toBe(true);
    expect(isSha256Hex("f".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("0".repeat(63))).toBe(false);
    expect(isSha256Hex(undefined)).toBe(false);
  });

  test("isExactUuid accepts only exact UUIDs (no prefixes / wildcards)", () => {
    expect(isExactUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isExactUuid("d386-*")).toBe(false);
    expect(isExactUuid("authrx")).toBe(false);
    expect(isExactUuid(null)).toBe(false);
  });
});
