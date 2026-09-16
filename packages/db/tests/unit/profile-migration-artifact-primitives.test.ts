/**
 * D425 Wave 3 — pure unit tests for the private-artifact migration
 * primitives that do not touch Postgres: the eligibility evaluator
 * (`evaluatePrivateArtifactEligibility`), the portable projection
 * (`encodePortableArtifact`), and the path / bytesEntry / sha256
 * validators. The transaction-aware DB behavior (fetcher + insert +
 * rollback) is covered by
 * `profile-migration-artifact-primitives.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  encodePortableArtifact,
  evaluatePrivateArtifactEligibility,
  isValidArtifactBytesEntry,
  isValidArtifactSha256,
  isValidPortableArtifactPath,
  validatePortableArtifactInput,
  type PrivateArtifactNamespaceEdge,
} from "../../src/utils/profile-migration-artifact-primitives";

const OWNER = "owner-user-id";
const OWNER_ACTOR = "owner-human-actor-id";
const SHA = "0".repeat(64);

function nsEdge(
  namespaceId: string,
  humanActorIds: readonly string[] | null,
  roomId: string | null = "room-" + namespaceId,
): PrivateArtifactNamespaceEdge {
  return { namespaceId, roomId, humanActorIds };
}

describe("D425 evaluatePrivateArtifactEligibility — edge rules", () => {
  test("rejects an artifact with no edges (not provably private)", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("no_edges");
    expect(res.namespaceEdgeCount).toBe(0);
  });

  test("accepts an artifact with a single own-private-namespace edge", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", [OWNER_ACTOR])],
    });
    expect(res.eligible).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.namespaceEdgeCount).toBe(1);
  });

  test("accepts an artifact with multiple own-private-namespace edges", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [
        nsEdge("ns1", [OWNER_ACTOR]),
        nsEdge("ns2", [OWNER_ACTOR]),
      ],
    });
    expect(res.eligible).toBe(true);
    expect(res.namespaceEdgeCount).toBe(2);
  });
});

describe("D425 evaluatePrivateArtifactEligibility — shared / foreign / no-room reject the whole artifact", () => {
  test("a namespace edge whose Room has TWO humans rejects (shared room)", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [
        nsEdge("ns1", [OWNER_ACTOR]),
        nsEdge("ns2", [OWNER_ACTOR, "other-human"]),
      ],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("a namespace edge whose Room has a different single human rejects (foreign room)", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", ["someone-else"])],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("a namespace edge with no owning Room rejects (orphan namespace)", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", null, null)],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_no_room");
  });

  test("a namespace edge whose Room has zero humans rejects", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", [])],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("one foreign namespace edge rejects even when other edges are own-private", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [
        nsEdge("ns1", [OWNER_ACTOR]),
        nsEdge("ns2", [OWNER_ACTOR, "stranger"]),
      ],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });
});

describe("D425 evaluatePrivateArtifactEligibility — owner human actor resolution", () => {
  test("null owner human actor rejects (owner unresolved) even with own-private edges", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: null,
      namespaceEdges: [nsEdge("ns1", [OWNER_ACTOR])],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("owner_human_actor_unresolved");
  });

  test("null owner human actor: no_edges has priority over owner resolution", () => {
    const res = evaluatePrivateArtifactEligibility({
      artifactInternalId: "a",
      ownerUserId: OWNER,
      ownerHumanActorId: null,
      namespaceEdges: [],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("no_edges");
  });
});

describe("D425 isValidPortableArtifactPath — safe logical path", () => {
  test("accepts a simple relative path", () => {
    expect(isValidPortableArtifactPath("notes/idea.md")).toBe(true);
  });

  test("accepts a single-segment path", () => {
    expect(isValidPortableArtifactPath("idea.md")).toBe(true);
  });

  test("rejects an empty path", () => {
    expect(isValidPortableArtifactPath("")).toBe(false);
  });

  test("rejects a leading slash (absolute path)", () => {
    expect(isValidPortableArtifactPath("/notes/idea.md")).toBe(false);
  });

  test("rejects a parent-dir traversal segment", () => {
    expect(isValidPortableArtifactPath("a/../b")).toBe(false);
    expect(isValidPortableArtifactPath("../secret")).toBe(false);
  });

  test("rejects a single-dot segment", () => {
    expect(isValidPortableArtifactPath("a/./b")).toBe(false);
  });

  test("rejects a double slash (empty segment)", () => {
    expect(isValidPortableArtifactPath("a//b")).toBe(false);
  });

  test("rejects a trailing slash", () => {
    expect(isValidPortableArtifactPath("a/b/")).toBe(false);
  });

  test("rejects a backslash", () => {
    expect(isValidPortableArtifactPath("a\\b")).toBe(false);
  });

  test("rejects a colon (Windows drive / ADS)", () => {
    expect(isValidPortableArtifactPath("a:b")).toBe(false);
  });

  test("rejects leading/trailing whitespace", () => {
    expect(isValidPortableArtifactPath(" a/b")).toBe(false);
    expect(isValidPortableArtifactPath("a/b ")).toBe(false);
  });

  test("rejects a NUL / control char", () => {
    expect(isValidPortableArtifactPath("a\x00b")).toBe(false);
    expect(isValidPortableArtifactPath("a\nb")).toBe(false);
  });

  test("rejects a non-string", () => {
    expect(isValidPortableArtifactPath(123)).toBe(false);
    expect(isValidPortableArtifactPath(null)).toBe(false);
  });
});

describe("D425 isValidArtifactBytesEntry — exact media/artifacts/<id>.bin grammar", () => {
  test("accepts the canonical shape", () => {
    expect(isValidArtifactBytesEntry("media/artifacts/abc123.bin")).toBe(true);
    expect(isValidArtifactBytesEntry("media/artifacts/A-B_C123.bin")).toBe(true);
  });

  test("rejects a missing media/ prefix", () => {
    expect(isValidArtifactBytesEntry("artifacts/abc.bin")).toBe(false);
  });

  test("rejects a wrong directory", () => {
    expect(isValidArtifactBytesEntry("media/avatar/abc.bin")).toBe(false);
  });

  test("rejects a missing .bin suffix", () => {
    expect(isValidArtifactBytesEntry("media/artifacts/abc")).toBe(false);
    expect(isValidArtifactBytesEntry("media/artifacts/abc.txt")).toBe(false);
  });

  test("rejects a traversal char in the opaque id", () => {
    expect(isValidArtifactBytesEntry("media/artifacts/../x.bin")).toBe(false);
    expect(isValidArtifactBytesEntry("media/artifacts/a/b.bin")).toBe(false);
  });

  test("rejects an empty opaque id", () => {
    expect(isValidArtifactBytesEntry("media/artifacts/.bin")).toBe(false);
  });

  test("rejects a non-string", () => {
    expect(isValidArtifactBytesEntry(123)).toBe(false);
  });
});

describe("D425 isValidArtifactSha256 — 64-char hex", () => {
  test("accepts 64 lowercase hex chars", () => {
    expect(isValidArtifactSha256(SHA)).toBe(true);
  });

  test("rejects uppercase hex", () => {
    expect(isValidArtifactSha256("A".repeat(64))).toBe(false);
  });

  test("rejects wrong length", () => {
    expect(isValidArtifactSha256("0".repeat(63))).toBe(false);
    expect(isValidArtifactSha256("0".repeat(65))).toBe(false);
  });

  test("rejects non-hex", () => {
    expect(isValidArtifactSha256("g".repeat(64))).toBe(false);
  });
});

describe("D425 validatePortableArtifactInput + encodePortableArtifact — contract projection", () => {
  const good = {
    path: "notes/idea.md",
    mimeType: "text/markdown",
    size: 42,
    sha256: SHA,
    bytesEntry: "media/artifacts/abc123.bin",
  };

  test("validates a well-formed input and encodes the contract record", () => {
    const res = encodePortableArtifact(good);
    if (!res.ok) throw new Error("expected ok");
    expect(res.artifact).toEqual({
      recordKind: "artifact",
      path: "notes/idea.md",
      mimeType: "text/markdown",
      size: 42,
      sha256: SHA,
      bytesEntry: "media/artifacts/abc123.bin",
    });
  });

  test("encoded record carries NO id / storageUri / revision (contract-only)", () => {
    const res = encodePortableArtifact(good);
    if (!res.ok) throw new Error("expected ok");
    const keys = Object.keys(res.artifact).sort();
    expect(keys).toEqual(
      ["bytesEntry", "mimeType", "path", "recordKind", "sha256", "size"],
    );
  });

  test("collects ALL field errors, not just the first", () => {
    const res = validatePortableArtifactInput({
      path: "/bad",
      mimeType: "",
      size: -1,
      sha256: "x",
      bytesEntry: "nope",
    });
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual([
      "path_invalid",
      "mimeType_invalid",
      "size_invalid",
      "sha256_invalid",
      "bytesEntry_invalid",
    ]);
  });

  test("encode refuses an invalid path (does not broaden arbitrary input)", () => {
    const res = encodePortableArtifact({ ...good, path: "../etc/secret" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain("path_invalid");
  });

  test("encode refuses an invalid bytesEntry", () => {
    const res = encodePortableArtifact({ ...good, bytesEntry: "etc/secret.bin" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain("bytesEntry_invalid");
  });

  test("encode refuses a negative size", () => {
    const res = encodePortableArtifact({ ...good, size: -5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain("size_invalid");
  });
});
