/**
 * D425 Wave 1B — pure unit tests for the private-memory migration
 * primitives that do not touch Postgres: the eligibility evaluator
 * (`evaluatePrivateMemoryEligibility`) and the record encoder
 * (`encodePrivateMemoryRecord`). The transaction-aware DB behavior
 * (fetcher + insert + rollback) is covered by
 * `profile-migration-memory-primitives.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  encodePrivateMemoryRecord,
  evaluatePrivateMemoryEligibility,
  fingerprintPrivateMemoryRecord,
  insertPrivateMemoryInTx,
  type PrivateMemoryNamespaceEdge,
  type PrivateMemoryScopeEdge,
  type ProfileMigrationTx,
} from "../../src/utils/profile-migration-memory-primitives";

const OWNER = "owner-user-id";
const AGENT = "personal-agent-id";
const OWNER_ACTOR = "owner-human-actor-id";

function insertRecorder(): {
  tx: ProfileMigrationTx;
  values: Array<Record<string, unknown>>;
} {
  const values: Array<Record<string, unknown>> = [];
  const tx = {
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        values.push(value);
        return values.length === 1
          ? { returning: async () => [{ id: "memory-1" }] }
          : { onConflictDoNothing: async () => undefined };
      },
    }),
  } as unknown as ProfileMigrationTx;
  return { tx, values };
}

describe("profile import embedding persistence", () => {
  test("writes the complete actual embedding tuple at fresh revision zero", async () => {
    const fixture = insertRecorder();
    const vector = new Array(1536).fill(0);
    vector[0] = 0.25;

    await insertPrivateMemoryInTx(fixture.tx, {
      content: "portable memory",
      targetNamespaceId: "namespace-1",
      embedding: {
        vector,
        provider: "venice",
        canonicalModel: "text-embedding-3-small",
        dimensions: 1536,
        contractVersion: 1,
      },
    });

    expect(fixture.values[0]).toMatchObject({
      contentRevision: 0,
      embedding: vector,
      embeddingRevision: 0,
      embeddingProvider: "venice",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      embeddingContractVersion: 1,
    });
  });

  test("writes a wholly null embedding tuple when re-embedding is omitted", async () => {
    const fixture = insertRecorder();

    await insertPrivateMemoryInTx(fixture.tx, {
      content: "portable memory without vector",
      targetNamespaceId: "namespace-1",
      embedding: null,
    });

    expect(fixture.values[0]).toMatchObject({
      contentRevision: 0,
      embedding: null,
      embeddingRevision: null,
      embeddingProvider: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embeddingContractVersion: null,
    });
  });
});

function nsEdge(
  namespaceId: string,
  humanActorIds: readonly string[] | null,
  roomId: string | null = "room-" + namespaceId,
): PrivateMemoryNamespaceEdge {
  return { namespaceId, roomId, humanActorIds };
}

function scopeEdge(
  scopeId: string,
  parentAgentId: string | null,
  speakerUserId: string | null,
): PrivateMemoryScopeEdge {
  return { scopeId, parentAgentId, speakerUserId };
}

describe("D425 evaluatePrivateMemoryEligibility — edge rules", () => {
  test("rejects a memory with no edges (not provably private)", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [],
      scopeEdges: [],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("no_edges");
    expect(res.namespaceEdgeCount).toBe(0);
    expect(res.scopeEdgeCount).toBe(0);
  });

  test("accepts a memory with a single own-private-namespace edge", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", [OWNER_ACTOR])],
      scopeEdges: [],
    });
    expect(res.eligible).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.namespaceEdgeCount).toBe(1);
  });

  test("accepts a memory with multiple own-private-namespace edges", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [
        nsEdge("ns1", [OWNER_ACTOR]),
        nsEdge("ns2", [OWNER_ACTOR]),
      ],
      scopeEdges: [],
    });
    expect(res.eligible).toBe(true);
    expect(res.namespaceEdgeCount).toBe(2);
  });

  test("accepts a memory with a single own-scope edge (no namespace edges)", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [],
      scopeEdges: [scopeEdge("sc1", AGENT, OWNER)],
    });
    expect(res.eligible).toBe(true);
    expect(res.scopeEdgeCount).toBe(1);
  });

  test("accepts a memory with both own-private-namespace AND own-scope edges", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", [OWNER_ACTOR])],
      scopeEdges: [scopeEdge("sc1", AGENT, OWNER)],
    });
    expect(res.eligible).toBe(true);
  });
});

describe("D567 fingerprintPrivateMemoryRecord — exact canonical portable identity", () => {
  test("is deterministic across Date/string representations of one portable record", () => {
    const date = new Date("2026-08-31T10:20:30.000Z");
    const fromDate = fingerprintPrivateMemoryRecord({
      type: "fact",
      content: "Use the blue notebook",
      createdAt: date,
    });
    const fromPortableRecord = fingerprintPrivateMemoryRecord({
      recordKind: "memory",
      scope: "private",
      type: "fact",
      content: "Use the blue notebook",
      createdAt: date.toISOString(),
    });
    expect(fromDate).toBe(fromPortableRecord);
    expect(fromDate).toMatch(/^[a-f0-9]{64}$/);
  });

  test("does not fuzzy-match canonically distinct records", () => {
    const base = {
      type: "fact",
      content: "I prefer tea",
      createdAt: "2026-08-31T10:20:30.000Z",
    };
    const fingerprint = fingerprintPrivateMemoryRecord(base);
    expect(fingerprintPrivateMemoryRecord({ ...base, content: "I prefer coffee" }))
      .not.toBe(fingerprint);
    expect(fingerprintPrivateMemoryRecord({ ...base, type: "episodic" }))
      .not.toBe(fingerprint);
    expect(fingerprintPrivateMemoryRecord({ ...base, createdAt: null }))
      .not.toBe(fingerprint);
  });
});

describe("D425 evaluatePrivateMemoryEligibility — shared / foreign edges reject the whole memory", () => {
  test("a namespace edge whose Room has TWO humans rejects (shared room)", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [
        nsEdge("ns1", [OWNER_ACTOR]),
        nsEdge("ns2", [OWNER_ACTOR, "other-human"]),
      ],
      scopeEdges: [],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("a namespace edge whose Room has a different single human rejects (foreign room)", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", ["someone-else"])],
      scopeEdges: [],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("a namespace edge with no owning Room rejects (orphan namespace)", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", null, null)],
      scopeEdges: [],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_no_room");
  });

  test("a namespace edge whose Room has zero humans rejects", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", [])],
      scopeEdges: [],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("a scope edge owned by a different agent rejects (foreign scope)", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [],
      scopeEdges: [scopeEdge("sc1", "other-agent", OWNER)],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("scope_shared_or_foreign");
  });

  test("a scope edge owned by a different speaker user rejects (foreign scope)", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [],
      scopeEdges: [scopeEdge("sc1", AGENT, "other-user")],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("scope_shared_or_foreign");
  });

  test("a scope edge with null owner fields rejects", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [],
      scopeEdges: [scopeEdge("sc1", null, null)],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("scope_shared_or_foreign");
  });

  test("one foreign namespace edge rejects even when other edges are own-private", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [
        nsEdge("ns1", [OWNER_ACTOR]),
        nsEdge("ns2", [OWNER_ACTOR, "stranger"]),
      ],
      scopeEdges: [scopeEdge("sc1", AGENT, OWNER)],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("one foreign scope edge rejects even when namespace edges are own-private", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: OWNER_ACTOR,
      namespaceEdges: [nsEdge("ns1", [OWNER_ACTOR])],
      scopeEdges: [
        scopeEdge("sc1", AGENT, OWNER),
        scopeEdge("sc2", "other-agent", "other-user"),
      ],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("scope_shared_or_foreign");
  });
});

describe("D425 evaluatePrivateMemoryEligibility — owner human actor resolution", () => {
  test("null owner human actor rejects (owner unresolved) even with own-private edges", () => {
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: null,
      namespaceEdges: [nsEdge("ns1", [OWNER_ACTOR])],
      scopeEdges: [],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("owner_human_actor_unresolved");
  });

  test("null owner human actor rejects BEFORE the no-edges gate is bypassed", () => {
    // no_edges has priority over owner resolution.
    const res = evaluatePrivateMemoryEligibility({
      memoryId: "m",
      ownerUserId: OWNER,
      personalAgentId: AGENT,
      ownerHumanActorId: null,
      namespaceEdges: [],
      scopeEdges: [],
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("no_edges");
  });
});

describe("D425 encodePrivateMemoryRecord — contract projection", () => {
  test("projects a Date createdAt to an ISO string and keeps only contract fields", () => {
    const rec = encodePrivateMemoryRecord({
      type: "preference",
      content: "likes tea",
      createdAt: new Date("2026-07-14T10:00:00.000Z"),
    });
    expect(rec).toEqual({
      recordKind: "memory",
      scope: "private",
      type: "preference",
      content: "likes tea",
      createdAt: "2026-07-14T10:00:00.000Z",
    });
  });

  test("passes a string createdAt through unchanged", () => {
    const rec = encodePrivateMemoryRecord({
      type: "general",
      content: "x",
      createdAt: "2026-07-14T10:00:00.000Z",
    });
    expect(rec.createdAt).toBe("2026-07-14T10:00:00.000Z");
    expect(rec.recordKind).toBe("memory");
    expect(rec.scope).toBe("private");
  });

  test("null createdAt stays null", () => {
    const rec = encodePrivateMemoryRecord({ type: "general", content: "x", createdAt: null });
    expect(rec.createdAt).toBeNull();
  });

  test("an invalid Date createdAt normalizes to null (no crash)", () => {
    const rec = encodePrivateMemoryRecord({
      type: "general",
      content: "x",
      createdAt: new Date("not-a-date"),
    });
    expect(rec.createdAt).toBeNull();
  });

  test("a blank-string createdAt normalizes to null", () => {
    const rec = encodePrivateMemoryRecord({ type: "general", content: "x", createdAt: "   " });
    expect(rec.createdAt).toBeNull();
  });

  test("preserves bounded type but carries NO id / embedding / tier / importance", () => {
    const rec = encodePrivateMemoryRecord({
      type: "episodic",
      content: "x",
      createdAt: new Date("2026-07-14T10:00:00.000Z"),
    });
    const keys = Object.keys(rec).sort();
    expect(keys).toEqual(["content", "createdAt", "recordKind", "scope", "type"]);
    expect(rec.type).toBe("episodic");
  });

  test("rejects empty and over-256-byte UTF-8 types", () => {
    expect(() => encodePrivateMemoryRecord({
      type: "",
      content: "x",
      createdAt: null,
    })).toThrow("type must be 1-256 UTF-8 bytes");
    expect(() => encodePrivateMemoryRecord({
      type: "é".repeat(129),
      content: "x",
      createdAt: null,
    })).toThrow("type must be 1-256 UTF-8 bytes");
  });

  test("accepts a type exactly 256 UTF-8 bytes long", () => {
    const type = "é".repeat(128);
    expect(encodePrivateMemoryRecord({ type, content: "x", createdAt: null }).type).toBe(type);
  });
});
