import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import type {
  RankedRecordCoordinate,
  RecordEmbeddingV1,
} from "@nautilo/reflection/search";

import { PostgresProtectedOrganizerMetadata } from
  "../../src/server/reflection/protected-organizer-metadata.ts";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_ID = "22222222-2222-4222-8222-222222222222";
const MEMORY_ID = "33333333-3333-4333-8333-333333333333";

const coordinate: RankedRecordCoordinate = {
  recordRef: "record:selected",
  score: Math.fround(0.8),
  structuralHeight: 0,
  recordProcessingGeneration: 2,
  projectionGeneration: 3,
  payloadRepresentationGeneration: 4,
  authorityProjectionGeneration: 5,
};

const embedding: RecordEmbeddingV1 = {
  provenance: {
    provider: "openai",
    canonicalModel: "text-embedding-3-small",
    dimensions: 1_536,
    contractVersion: 1,
  },
  vector: Object.freeze(Array.from(
    { length: 1_536 },
    () => Math.fround(0.25),
  )),
};

function metadata(rows: readonly Record<string, unknown>[], statements: string[]) {
  return new PostgresProtectedOrganizerMetadata({
    product: {
      query: async (statement: string) => {
        statements.push(statement);
        return rows;
      },
    } as unknown as Pick<PostgresJsBridgeConnection, "query">,
    rooms: {
      resolveRoom: async () => ({ roomId: ROOM_ID, namespaceId: NAMESPACE_ID }),
    },
  });
}

describe("protected Organizer metadata", () => {
  test("resolves the changed protected Record before a ranked coordinate exists", async () => {
    const statements: string[] = [];
    const result = await metadata([{
      record_id: coordinate.recordRef,
      structural_height: coordinate.structuralHeight,
      processing_generation: coordinate.recordProcessingGeneration,
      producer_policy_version: "candidate-policy-v1",
      lifecycle: "current",
      disposition: "available",
      representation_generation: coordinate.payloadRepresentationGeneration,
      crypto_object_id: "object:record:selected",
      projection_generation: coordinate.authorityProjectionGeneration,
      processing_state: "current",
      access_namespace_id: NAMESPACE_ID,
    }], statements).resolveRecord({
      recordRef: coordinate.recordRef,
      namespaceId: NAMESPACE_ID,
    });

    expect(result).toEqual({
      recordRef: coordinate.recordRef,
      structuralHeight: coordinate.structuralHeight,
      processingGeneration: coordinate.recordProcessingGeneration,
      representationGeneration: coordinate.payloadRepresentationGeneration,
      authorityProjectionGeneration: coordinate.authorityProjectionGeneration,
      producerPolicyVersion: "candidate-policy-v1",
      lifecycle: "current",
      authorityNamespaceId: NAMESPACE_ID,
      inputBinding: {
        objectId: "object:record:selected",
        namespaceId: NAMESPACE_ID,
        objectType: "nautilo.reflection.record.v1",
      },
    });
    expect(statements[0]).toContain("reflection_record_payload_representations");
    expect(statements[0]).not.toContain("plaintext_payload_bytes");
  });

  test("enforces ranked candidate coordinates and rejects ambiguity", async () => {
    const current = {
      record_id: coordinate.recordRef,
      structural_height: coordinate.structuralHeight,
      processing_generation: coordinate.recordProcessingGeneration,
      producer_policy_version: "candidate-policy-v1",
      lifecycle: "current",
      disposition: "available",
      representation_generation: coordinate.payloadRepresentationGeneration,
      crypto_object_id: "object:record:selected",
      projection_generation: coordinate.authorityProjectionGeneration,
      processing_state: "current",
      access_namespace_id: NAMESPACE_ID,
    };
    expect(await metadata([current], []).resolveRecord({
      recordRef: coordinate.recordRef,
      namespaceId: NAMESPACE_ID,
      expected: coordinate,
    })).not.toBeNull();
    expect(await metadata([{
      ...current,
      processing_generation: coordinate.recordProcessingGeneration + 1,
    }], []).resolveRecord({
      recordRef: coordinate.recordRef,
      namespaceId: NAMESPACE_ID,
      expected: coordinate,
    })).toBeNull();
    expect(await metadata([current, current], []).resolveRecord({
      recordRef: coordinate.recordRef,
      namespaceId: NAMESPACE_ID,
      expected: coordinate,
    })).toBeNull();
  });

  test("admits a stale Record only when the caller explicitly allows it", async () => {
    const stale = {
      record_id: coordinate.recordRef,
      structural_height: coordinate.structuralHeight,
      processing_generation: coordinate.recordProcessingGeneration,
      producer_policy_version: "candidate-policy-v1",
      lifecycle: "stale",
      disposition: "available",
      representation_generation: coordinate.payloadRepresentationGeneration,
      crypto_object_id: "object:record:selected",
      projection_generation: coordinate.authorityProjectionGeneration,
      processing_state: "current",
      access_namespace_id: NAMESPACE_ID,
    };
    expect(await metadata([stale], []).resolveRecord({
      recordRef: coordinate.recordRef,
      namespaceId: NAMESPACE_ID,
    })).toBeNull();
    const staleResult = await metadata([stale], []).resolveRecord({
      recordRef: coordinate.recordRef,
      namespaceId: NAMESPACE_ID,
      expected: coordinate,
      allowStale: true,
    });
    expect(staleResult?.recordRef).toBe(coordinate.recordRef);
    expect(staleResult?.lifecycle).toBe("stale");
  });

  test("ranks current protected Memory coordinates without selecting content", async () => {
    const statements: string[] = [];
    const result = await metadata([{
      id: MEMORY_ID,
      content_revision: 7,
      crypto_access_revision: 3,
      crypto_object_id: `memory:${MEMORY_ID}:7`,
      score: 0.75,
    }], statements).searchMemories({
      roomAnchorRef: ROOM_ID,
      embedding,
      limit: 4,
    });

    expect(result).toEqual({
      status: "available",
      candidates: [{
        score: Math.fround(0.75),
        memoryRef: MEMORY_ID,
        logicalSourceRef: `memory:${MEMORY_ID}`,
        contentRevision: 7,
        cryptoAccessRevision: 3,
        inputBinding: {
          objectId: `memory:${MEMORY_ID}:7`,
          namespaceId: NAMESPACE_ID,
          objectType: "nautilo-memory-v1",
        },
      }],
    });
    const statement = statements[0]!;
    expect(statement).toContain("memory_namespaces");
    expect(statement).toContain("embedding_revision");
    expect(statement).toContain("crypto_mapping_state");
    expect(statement).not.toMatch(/"content"(?:\s|,)/u);
  });

  test("rereads exact current protected Memory metadata without a score", async () => {
    const statements: string[] = [];
    const result = await metadata([{
      id: MEMORY_ID,
      content_revision: 7,
      crypto_access_revision: 3,
      crypto_object_id: `memory:${MEMORY_ID}:7`,
    }], statements).resolveMemory({
      memoryRef: MEMORY_ID,
      namespaceId: NAMESPACE_ID,
    });

    expect(result).toEqual({
      memoryRef: MEMORY_ID,
      logicalSourceRef: `memory:${MEMORY_ID}`,
      contentRevision: 7,
      cryptoAccessRevision: 3,
      inputBinding: {
        objectId: `memory:${MEMORY_ID}:7`,
        namespaceId: NAMESPACE_ID,
        objectType: "nautilo-memory-v1",
      },
    });
    expect(result).not.toHaveProperty("score");
    const statement = statements[0]!;
    expect(statement).toContain("memory_namespaces");
    expect(statement).toContain("crypto_mapping_state");
    expect(statement).toContain("tier");
    expect(statement).not.toMatch(/"content"(?:\s|,)/u);
    expect(statement).not.toContain("embedding");
  });

  test("distinguishes lost or changed Memory dependencies from mapping waits", async () => {
    const statements: string[] = [];
    const current = {
      id: MEMORY_ID,
      tier: 2,
      content_revision: 7,
      crypto_access_revision: 3,
      crypto_object_id: `memory:${MEMORY_ID}:7`,
      crypto_mapping_state: "verified",
    };
    expect(await metadata([current], statements).resolveMemoryDependency({
      memoryRef: MEMORY_ID,
      namespaceId: NAMESPACE_ID,
      observedRevision: "7",
    })).toEqual({
      status: "available",
      metadata: {
        memoryRef: MEMORY_ID,
        logicalSourceRef: `memory:${MEMORY_ID}`,
        contentRevision: 7,
        cryptoAccessRevision: 3,
        inputBinding: {
          objectId: `memory:${MEMORY_ID}:7`,
          namespaceId: NAMESPACE_ID,
          objectType: "nautilo-memory-v1",
        },
      },
    });
    expect(statements[0]).toContain("memory_namespaces");
    expect(statements[0]).not.toContain('"crypto_mapping_state" =');
    expect(statements[0]).not.toMatch(/"tier"\s*<=/u);
    expect(statements[0]).not.toMatch(/"content"(?:\s|,)/u);
    expect(await metadata([{...current, content_revision: 8}], [])
      .resolveMemoryDependency({memoryRef: MEMORY_ID,
        namespaceId: NAMESPACE_ID, observedRevision: "7"}))
      .toEqual({status: "changed"});
    for (const cryptoMappingState of ["unmapped", "stale"] as const) {
      expect(await metadata([{...current,
        crypto_object_id: cryptoMappingState === "unmapped" ? null : current.crypto_object_id,
        crypto_mapping_state: cryptoMappingState}], [])
        .resolveMemoryDependency({memoryRef: MEMORY_ID,
          namespaceId: NAMESPACE_ID, observedRevision: "7"}))
        .toEqual({status: "waiting"});
    }
    expect(await metadata([{...current, tier: 3}], [])
      .resolveMemoryDependency({memoryRef: MEMORY_ID,
        namespaceId: NAMESPACE_ID, observedRevision: "7"}))
      .toEqual({status: "missing"});
    expect(await metadata([], []).resolveMemoryDependency({
      memoryRef: MEMORY_ID,
      namespaceId: NAMESPACE_ID,
      observedRevision: "7",
    })).toEqual({status: "missing"});
  });

  test("rejects malformed or ambiguous Memory dependency metadata", async () => {
    const current = {
      id: MEMORY_ID,
      tier: 2,
      content_revision: 7,
      crypto_access_revision: 3,
      crypto_object_id: `memory:${MEMORY_ID}:7`,
      crypto_mapping_state: "verified",
    };
    expect(await metadata([current], []).resolveMemoryDependency({
      memoryRef: MEMORY_ID,
      namespaceId: NAMESPACE_ID,
      observedRevision: "invalid",
    })).toEqual({status: "unavailable"});
    expect(await metadata([current, current], []).resolveMemoryDependency({
      memoryRef: MEMORY_ID,
      namespaceId: NAMESPACE_ID,
      observedRevision: "7",
    })).toEqual({status: "unavailable"});
    expect(await metadata([{...current, crypto_object_id: null}], [])
      .resolveMemoryDependency({memoryRef: MEMORY_ID,
        namespaceId: NAMESPACE_ID, observedRevision: "7"}))
      .toEqual({status: "unavailable"});
  });

  test("rejects unavailable or invalid exact protected Memory metadata", async () => {
    expect(await metadata([], []).resolveMemory({
      memoryRef: MEMORY_ID,
      namespaceId: NAMESPACE_ID,
    })).toBeNull();
    expect(await metadata([{
      id: MEMORY_ID,
      content_revision: 0,
      crypto_access_revision: 3,
      crypto_object_id: `memory:${MEMORY_ID}:7`,
    }], []).resolveMemory({
      memoryRef: MEMORY_ID,
      namespaceId: NAMESPACE_ID,
    })).toBeNull();
    expect(await metadata([{
      id: MEMORY_ID,
      content_revision: 7,
      crypto_access_revision: -1,
      crypto_object_id: `memory:${MEMORY_ID}:7`,
    }], []).resolveMemory({
      memoryRef: MEMORY_ID,
      namespaceId: NAMESPACE_ID,
    })).toBeNull();
  });

  test("resolves an exact protected Memory object binding", async () => {
    const objectId = `memory:${MEMORY_ID}:7`;
    const statements: string[] = [];
    const result = await metadata([{
      id: MEMORY_ID,
      content_revision: 7,
      crypto_access_revision: 3,
      crypto_object_id: objectId,
    }], statements).resolveMemoryObject({
      objectId,
      namespaceId: NAMESPACE_ID,
    });

    expect(result).toEqual({
      memoryRef: MEMORY_ID,
      logicalSourceRef: `memory:${MEMORY_ID}`,
      contentRevision: 7,
      cryptoAccessRevision: 3,
      inputBinding: {
        objectId,
        namespaceId: NAMESPACE_ID,
        objectType: "nautilo-memory-v1",
      },
    });
    expect(statements[0]).toContain("crypto_object_id");
    expect(await metadata([{
      id: MEMORY_ID,
      content_revision: 7,
      crypto_access_revision: 3,
      crypto_object_id: "memory:different:7",
    }], []).resolveMemoryObject({
      objectId,
      namespaceId: NAMESPACE_ID,
    })).toBeNull();
  });

  test("rejects unsupported provider metadata before querying", async () => {
    const statements: string[] = [];
    const result = await metadata([], statements).searchMemories({
      roomAnchorRef: ROOM_ID,
      embedding: {
        ...embedding,
        provenance: { ...embedding.provenance, provider: "deterministic" },
      },
      limit: 4,
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(statements).toEqual([]);
  });
});
