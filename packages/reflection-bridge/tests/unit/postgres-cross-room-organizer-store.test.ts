import { describe, expect, test } from "bun:test";
import type { RecordEmbeddingV1 } from "@nautilo/reflection/search";

import {
  __crossRoomOrganizerStoreTesting,
  CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1,
  PostgresCrossRoomOrganizerStore,
  type CrossRoomMemoryCandidate,
  type CrossRoomRecordCandidate,
} from "../../src/server/postgres-cross-room-organizer-store";
import {
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
  type RecordProductPostgresScalar,
  verifyRecordProductPostgresHandle,
} from "../../src/server/product-postgres";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHANGED_NAMESPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECORD_NAMESPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RECORD_ACCESS_NAMESPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEMORY_NAMESPACE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MEMORY_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const CHANGED_BINDING =
  `journal:namespace:${CHANGED_NAMESPACE}:ordinary:v3`;
const RECORD_BINDING =
  `journal:namespace:${RECORD_NAMESPACE}:ordinary:v3`;

const EMBEDDING: RecordEmbeddingV1 = {
  provenance: {
    provider: "openrouter",
    canonicalModel: "openai/text-embedding-3-small",
    dimensions: 1_536,
    contractVersion: 1,
  },
  vector: Object.freeze(Array.from({ length: 1_536 }, () => Math.fround(0.25))),
};

type CapturedQuery = Readonly<{
  statement: string;
  parameters: readonly RecordProductPostgresScalar[];
}>;

async function fixture(
  responder: (
    statement: string,
    parameters: readonly RecordProductPostgresScalar[],
  ) => readonly RecordProductPostgresRow[] = () => [],
) {
  const queries: CapturedQuery[] = [];
  const connection: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(
      statement: string,
      parameters: readonly RecordProductPostgresScalar[] = [],
    ) {
      if (statement.startsWith("SELECT current_user")) {
        const identity: unknown = [{
          current_role: "nautilo",
          session_role: "nautilo",
        }];
        return identity as readonly Row[];
      }
      queries.push({ statement, parameters });
      return responder(statement, parameters) as readonly Row[];
    },
    async transaction<Result>(
      callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
    ) {
      return callback(connection);
    },
  };
  return {
    store: new PostgresCrossRoomOrganizerStore(
      await verifyRecordProductPostgresHandle(connection),
    ),
    queries,
  };
}

const base = {
  embedding: EMBEDDING,
  invocationAudience: {
    humanRefs: [ALICE, BOB],
    includesPublicBoundary: false,
  },
  selection: {
    selectedRepresentation: "ordinary",
    migrationGeneration: 3,
  },
  changedRecordRef: "record:changed",
  changedPublicationBindingRef: CHANGED_BINDING,
} as const;

function recordRow(
  recordId: string,
  score: number,
): RecordProductPostgresRow {
  return {
    record_id: recordId,
    structural_height: 1,
    processing_generation: 2,
    authority_projection_generation: 5,
    payload_representation_generation: 4,
    projection_generation: 3,
    publication_binding_ref: RECORD_BINDING,
    access_namespace_id: RECORD_ACCESS_NAMESPACE,
    human_actor_ids: [ALICE, BOB],
    includes_public_boundary: false,
    score,
    rows_considered: 3,
  };
}

function changedRow(): RecordProductPostgresRow {
  return {
    ...recordRow("record:changed", 1),
    publication_binding_ref: CHANGED_BINDING,
  };
}

function memoryRow(score: number): RecordProductPostgresRow {
  return {
    memory_id: MEMORY_ID,
    content_revision: 7,
    embedding_revision: 7,
    embedding_provider: EMBEDDING.provenance.provider,
    embedding_model: EMBEDDING.provenance.canonicalModel,
    embedding_dimensions: EMBEDDING.provenance.dimensions,
    embedding_contract_version: EMBEDDING.provenance.contractVersion,
    updated_at_coordinate: "2026-08-20T10:00:00.123456Z",
    authority_namespace_ids: [MEMORY_NAMESPACE],
    human_actor_ids: [ALICE],
    includes_public_boundary: false,
    read_namespace_id: MEMORY_NAMESPACE,
    score,
    rows_considered: 1,
    unsupported_authority_shapes: 2,
  };
}

function protectedMemoryRow(score: number): RecordProductPostgresRow {
  return {
    ...memoryRow(score),
    crypto_object_id: "memory:v1:protected-object",
    crypto_access_revision: 4,
  };
}

describe("bounded cross-Room Organizer PostgreSQL store", () => {
  test("materializes authority, heads, and provenance before vector distance", () => {
    const recordSql = __crossRoomOrganizerStoreTesting.recordRankSql();
    const recordAuthority = recordSql.slice(
      recordSql.indexOf("authority_first AS MATERIALIZED"),
      recordSql.indexOf("provenance_first AS MATERIALIZED"),
    );
    const recordProvenance = recordSql.slice(
      recordSql.indexOf("provenance_first AS MATERIALIZED"),
      recordSql.indexOf("ranked AS MATERIALIZED"),
    );
    expect(recordAuthority).not.toContain("<=>");
    expect(recordProvenance).not.toContain("<=>");
    expect(recordAuthority).toContain("record.disposition = 'available'");
    expect(recordAuthority).toContain("record.lifecycle = 'current'");
    expect(recordAuthority).toContain("authority.processing_state = 'current'");
    expect(recordAuthority).toContain("publication.state = 'complete'");
    expect(recordAuthority).toContain("publication.publication_binding_ref <> $10");
    expect(recordAuthority).toContain("reflection_record_authority_blocks");
    expect(recordAuthority).toContain("SELECT count(*)");
    expect(recordProvenance).toContain("projection.embedding_provider = $2");

    const memorySql = __crossRoomOrganizerStoreTesting.memoryRankSql();
    const memoryAuthority = memorySql.slice(
      memorySql.indexOf("memory_base AS MATERIALIZED"),
      memorySql.indexOf("ranked AS MATERIALIZED"),
    );
    expect(memoryAuthority).not.toContain("<=>");
    expect(memorySql).not.toMatch(/\bmemory\.content\b/u);
    expect(memorySql).toContain("memory_namespaces AS edge");
    expect(memorySql).toContain("scope_origin_namespace_id");
    expect(memorySql).toContain("SELECT DISTINCT memory_id, human_actor_ids");
    expect(memorySql).toContain("candidate.human_actor_ids <@ wider.human_actor_ids");
    expect(memorySql).toContain("memory.embedding_provider");
    expect(memorySql).toContain("memory.embedding_model");
    expect(memorySql).not.toContain("min(mapped.namespace_id)");
    expect(memorySql).toContain("ORDER BY mapped.namespace_id");
    expect(memorySql).toContain("LIMIT 1");
    expect(memorySql).toContain("NOT ($6::uuid = ANY(attachments.authority_namespace_ids))");
    expect(memorySql).toContain(") = 1");
    expect(memorySql).not.toContain("crypto_mapping_state");

    const recordFenceSql = __crossRoomOrganizerStoreTesting.recordFenceSql();
    const memoryFenceSql = __crossRoomOrganizerStoreTesting.memoryFenceSql();
    expect(recordFenceSql).toContain("($8::text)::jsonb");
    expect(memoryFenceSql).toContain("($5::text)::jsonb");
    expect(memoryFenceSql).toContain("($7::text)::jsonb");
  });

  test("merges separate Record and Memory ranks with stable bound two", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("SELECT * FROM provenance_first LIMIT 2")) {
        return [changedRow()];
      }
      if (statement.includes("provenance_first AS MATERIALIZED")) {
        return [
          recordRow("record:lower", 0.81),
          recordRow("record:redundant", 0.95),
        ];
      }
      if (statement.includes("scope_state AS MATERIALIZED")) {
        return [memoryRow(0.9)];
      }
      if (statement.includes("graph_walk")) {
        return [
          {
            traversal_work: 4,
            overflowed: false,
            redundant_record_id: "record:redundant",
          },
        ];
      }
      return [];
    });
    const result = await value.store.discover(base);
    expect(result).toEqual({
      status: "available",
      changed: {
        kind: "record",
        recordRef: "record:changed",
        structuralHeight: 1,
        recordProcessingGeneration: 2,
        searchProjectionGeneration: 3,
        payloadRepresentationGeneration: 4,
        authorityProjectionGeneration: 5,
        audience: {
          humanRefs: [ALICE, BOB],
          includesPublicBoundary: false,
        },
        authorityAccessNamespaceRef: RECORD_ACCESS_NAMESPACE,
        readNamespaceRef: CHANGED_NAMESPACE,
        readBindingRef: CHANGED_BINDING,
      },
      candidates: [
        {
          kind: "memory",
          memoryRef: MEMORY_ID,
          logicalSourceRef: `memory:${MEMORY_ID}`,
          score: Math.fround(0.9),
          contentRevision: 7,
          embeddingRevision: 7,
          embeddingProvenance: EMBEDDING.provenance,
          updatedAtCoordinate: "2026-08-20T10:00:00.123456Z",
          audience: {
            humanRefs: [ALICE],
            includesPublicBoundary: false,
          },
          authorityNamespaceRefs: [MEMORY_NAMESPACE],
          readNamespaceRef: MEMORY_NAMESPACE,
          readBindingRef:
            `journal:namespace:${MEMORY_NAMESPACE}:ordinary:v3`,
        },
        {
          kind: "record",
          recordRef: "record:lower",
          score: Math.fround(0.81),
          structuralHeight: 1,
          recordProcessingGeneration: 2,
          searchProjectionGeneration: 3,
          payloadRepresentationGeneration: 4,
          authorityProjectionGeneration: 5,
          audience: {
            humanRefs: [ALICE, BOB],
            includesPublicBoundary: false,
          },
          authorityAccessNamespaceRef: RECORD_ACCESS_NAMESPACE,
          readNamespaceRef: RECORD_NAMESPACE,
          readBindingRef: RECORD_BINDING,
        },
      ],
      metrics: {
        recordRowsConsidered: 3,
        memoryRowsConsidered: 1,
        rowsSelected: 2,
        unsupportedAuthorityShapes: 2,
        authorityParentsResolved: 0,
        authorityParentsSkipped: 0,
        topologyWork: 4,
      },
    });
    expect(result.status === "available" && result.candidates).toHaveLength(
      CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.crossRoomBound,
    );

    const statements = value.queries.map((query) => query.statement);
    expect(statements.filter((statement) => statement.includes("<=>"))).toHaveLength(2);
    const memoryQuery = value.queries.find((query) =>
      query.statement.includes("scope_state AS MATERIALIZED")
    );
    expect(memoryQuery?.parameters[5]).toBe(CHANGED_NAMESPACE);
    expect(memoryQuery?.parameters[9]).toBe(16);
  });

  test("normalizes ranked Records to the highest eligible current parent", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("SELECT * FROM provenance_first LIMIT 2")) {
        return [changedRow()];
      }
      if (statement.includes("provenance_first AS MATERIALIZED")) {
        return [recordRow("record:leaf", 0.92)];
      }
      if (statement.includes("scope_state AS MATERIALIZED")) return [];
      if (statement.includes("graph_walk")) {
        return [{ traversal_work: 1, overflowed: false, redundant_record_id: null }];
      }
      if (statement.includes("parent_walk(")) {
        return [
          {
            root_record_id: "record:leaf", child_record_id: null,
            parent_record_id: "record:leaf", depth: 0, cycle: false,
            score: 0.92, structural_height: null, processing_generation: null,
            authority_projection_generation: null,
            payload_representation_generation: null, projection_generation: null,
            publication_binding_ref: null, access_namespace_id: null,
            human_actor_ids: null, includes_public_boundary: null,
            current_parent_count: 1,
          },
          {
            ...recordRow("record:p", 0.92),
            root_record_id: "record:leaf", child_record_id: "record:leaf",
            parent_record_id: "record:p", depth: 1, cycle: false,
            current_parent_count: 1,
          },
          {
            ...recordRow("record:q", 0.92),
            structural_height: 2,
            root_record_id: "record:leaf", child_record_id: "record:p",
            parent_record_id: "record:q", depth: 2, cycle: false,
            current_parent_count: 0,
          },
        ];
      }
      return [];
    });
    const result = await value.store.discover(base);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      kind: "record",
      recordRef: "record:q",
      structuralHeight: 2,
      score: Math.fround(0.92),
    });
    expect(result.metrics.topologyWork).toBe(3);
  });

  test("resolves a same-binding seed to its eligible cross-binding parent", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("SELECT * FROM provenance_first LIMIT 2")) {
        return [changedRow()];
      }
      if (statement.includes("provenance_first AS MATERIALIZED")) return [];
      if (statement.includes("scope_state AS MATERIALIZED")) return [];
      if (statement.includes("graph_walk")) {
        return [{ traversal_work: 1, overflowed: false, redundant_record_id: null }];
      }
      if (statement.includes("parent_walk(")) {
        return [
          {
            root_record_id: "record:same-room-leaf", child_record_id: null,
            parent_record_id: "record:same-room-leaf", depth: 0, cycle: false,
            score: 0.94, structural_height: null, processing_generation: null,
            authority_projection_generation: null,
            payload_representation_generation: null, projection_generation: null,
            publication_binding_ref: null, access_namespace_id: null,
            human_actor_ids: null, includes_public_boundary: null,
            current_parent_count: 1,
          },
          {
            ...recordRow("record:cross-room-parent", 0.94),
            root_record_id: "record:same-room-leaf",
            child_record_id: "record:same-room-leaf",
            parent_record_id: "record:cross-room-parent", depth: 1,
            cycle: false, current_parent_count: 0,
          },
        ];
      }
      return [];
    });
    const result = await value.store.discover({
      ...base,
      authorityParentSeeds: [{ recordRef: "record:same-room-leaf", score: 0.94 }],
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      kind: "record",
      recordRef: "record:cross-room-parent",
      readBindingRef: RECORD_BINDING,
      score: Math.fround(0.94),
    });
    expect(result.metrics).toMatchObject({
      authorityParentsResolved: 1,
      authorityParentsSkipped: 0,
    });
  });

  test("fails closed when a ranked Record has two eligible current parents", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("SELECT * FROM provenance_first LIMIT 2")) {
        return [changedRow()];
      }
      if (statement.includes("provenance_first AS MATERIALIZED")) {
        return [recordRow("record:leaf", 0.92)];
      }
      if (statement.includes("scope_state AS MATERIALIZED")) return [];
      if (statement.includes("graph_walk")) {
        return [{ traversal_work: 1, overflowed: false, redundant_record_id: null }];
      }
      if (statement.includes("parent_walk(")) {
        return [
          {
            root_record_id: "record:leaf", child_record_id: null,
            parent_record_id: "record:leaf", depth: 0, cycle: false,
            current_parent_count: 2,
          },
          {
            ...recordRow("record:p1", 0.92),
            root_record_id: "record:leaf", child_record_id: "record:leaf",
            parent_record_id: "record:p1", depth: 1, cycle: false,
            current_parent_count: 0,
          },
          {
            ...recordRow("record:p2", 0.92),
            root_record_id: "record:leaf", child_record_id: "record:leaf",
            parent_record_id: "record:p2", depth: 1, cycle: false,
            current_parent_count: 0,
          },
        ];
      }
      return [];
    });
    expect(await value.store.discover(base)).toEqual({
      status: "unavailable",
      reason: "topology_capacity_exceeded",
    });
  });

  test("skips only the neighbor whose current parent is not authority-qualified", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("SELECT * FROM provenance_first LIMIT 2")) {
        return [changedRow()];
      }
      if (statement.includes("provenance_first AS MATERIALIZED")) {
        return [recordRow("record:leaf", 0.92)];
      }
      if (statement.includes("scope_state AS MATERIALIZED")) return [];
      if (statement.includes("graph_walk")) {
        return [{ traversal_work: 1, overflowed: false, redundant_record_id: null }];
      }
      if (statement.includes("parent_walk(")) {
        return [{
          root_record_id: "record:leaf", child_record_id: null,
          parent_record_id: "record:leaf", depth: 0, cycle: false,
          score: 0.92, structural_height: null, processing_generation: null,
          authority_projection_generation: null,
          payload_representation_generation: null, projection_generation: null,
          publication_binding_ref: null, access_namespace_id: null,
          human_actor_ids: null, includes_public_boundary: null,
          current_parent_count: 1,
        }];
      }
      return [];
    });
    const result = await value.store.discover(base);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.candidates).toEqual([]);
    expect(result.metrics.authorityParentsSkipped).toBe(1);
  });

  test("discovers protected authored Memories from current mapped receipts", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("SELECT * FROM provenance_first LIMIT 2")) {
        return [{
            ...changedRow(),
            publication_binding_ref:
              `journal:namespace:${CHANGED_NAMESPACE}:protected:v4`,
          }];
      }
      if (statement.includes("scope_state AS MATERIALIZED")) {
        return [protectedMemoryRow(0.9)];
      }
      if (statement.includes("graph_seed") || statement.startsWith("SELECT 0::integer")) {
        return [{ traversal_work: 1, overflowed: false, redundant_record_id: null }];
      }
      return [];
    });
    const result = await value.store.discover({
      ...base,
      selection: {
        selectedRepresentation: "protected",
        migrationGeneration: 4,
      },
      changedPublicationBindingRef:
        `journal:namespace:${CHANGED_NAMESPACE}:protected:v4`,
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.candidates).toEqual([expect.objectContaining({
      kind: "memory",
      memoryRef: MEMORY_ID,
      readBindingRef:
        `journal:namespace:${MEMORY_NAMESPACE}:protected:v4`,
      protectedCryptoObjectId: "memory:v1:protected-object",
      protectedCryptoAccessRevision: 4,
    })]);
    const memoryQuery = value.queries.find((query) =>
      query.statement.includes("scope_state AS MATERIALIZED")
    );
    expect(memoryQuery?.statement).not.toMatch(/\bmemory\.content\b/u);
    expect(memoryQuery?.statement).toContain("memory.crypto_mapping_state = 'verified'");
    expect(memoryQuery?.statement).toContain("memory_crypto_revisions AS crypto_revision");
    expect(memoryQuery?.statement).toContain("crypto_revision.completion = 'complete'");
    expect(memoryQuery?.statement).toContain("crypto_revision.disposition = 'mapped'");
    const protectedAuthority = memoryQuery?.statement.slice(
      memoryQuery.statement.indexOf("authority_first AS MATERIALIZED"),
      memoryQuery.statement.indexOf("ranked AS MATERIALIZED"),
    );
    expect(protectedAuthority).toContain("memory.crypto_object_id");
    expect(protectedAuthority).toContain("memory.crypto_access_revision");
  });

  test("protected Record discovery and fences use origin plus exact current-head proof", () => {
    const protectedSelection = {
      selectedRepresentation: "protected",
      migrationGeneration: 4,
    } as const;
    const statements = [
      __crossRoomOrganizerStoreTesting.changedCoordinateSql(protectedSelection),
      __crossRoomOrganizerStoreTesting.recordRankSql(protectedSelection),
      __crossRoomOrganizerStoreTesting.currentParentPathsSql(protectedSelection),
      __crossRoomOrganizerStoreTesting.recordFenceSql(protectedSelection),
    ];
    for (const statement of statements) {
      expect(statement).toContain("reflection_record_payload_representations AS current_payload");
      expect(statement).toContain("ORDER BY origin.created_at, origin.publication_id");
      expect(statement).toContain("AS current_proof");
      expect(statement).toContain("native_receipt.target_crypto_object_id = current_payload.crypto_object_id");
      expect(statement).toContain("native_receipt.state = 'complete'");
    }
    expect(statements[0]).toContain("publication.publication_binding_ref = $8");
    expect(statements[1]).toContain("publication.publication_binding_ref <> $10");
    expect(statements[2]).toContain(") AS publication ON true");
    expect(statements[3]).toContain(
      "publication.publication_binding_ref = requested.binding_ref",
    );
  });

  test("fences exact Record generations and complete Memory attachments", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("reflection_record_payload_representation_heads")) {
        return [{ matched_count: 2 }];
      }
      if (statement.includes("current_required AS")) {
        return [{ matched_count: 1 }];
      }
      return [];
    });
    const record: CrossRoomRecordCandidate = {
      kind: "record",
      recordRef: "record:candidate",
      score: Math.fround(0.8),
      structuralHeight: 1,
      recordProcessingGeneration: 2,
      searchProjectionGeneration: 3,
      payloadRepresentationGeneration: 4,
      authorityProjectionGeneration: 5,
      authorityAccessNamespaceRef: RECORD_ACCESS_NAMESPACE,
      audience: { humanRefs: [ALICE, BOB], includesPublicBoundary: false },
      readNamespaceRef: RECORD_NAMESPACE,
      readBindingRef: RECORD_BINDING,
    };
    const memory: CrossRoomMemoryCandidate = {
      kind: "memory",
      memoryRef: MEMORY_ID,
      logicalSourceRef: `memory:${MEMORY_ID}`,
      score: Math.fround(0.9),
      contentRevision: 7,
      embeddingRevision: 7,
      embeddingProvenance: EMBEDDING.provenance,
      updatedAtCoordinate: "2026-08-20T10:00:00.123456Z",
      authorityNamespaceRefs: [MEMORY_NAMESPACE],
      audience: { humanRefs: [ALICE], includesPublicBoundary: false },
      readNamespaceRef: MEMORY_NAMESPACE,
      readBindingRef: `journal:namespace:${MEMORY_NAMESPACE}:ordinary:v3`,
    };
    expect(await value.store.fence({
      selection: base.selection,
      changed: {
        ...record,
        recordRef: "record:changed",
        readNamespaceRef: CHANGED_NAMESPACE,
        readBindingRef: CHANGED_BINDING,
      },
      candidates: [record, memory],
    })).toEqual({ status: "current" });

    const recordFence = value.queries.find((query) =>
      query.statement.includes("reflection_record_payload_representation_heads")
    );
    expect(recordFence?.statement).toContain("($8::text)::jsonb");
    expect(recordFence?.statement).toContain("publication.publication_binding_ref");
    expect(recordFence?.statement).toContain("alternative.access_namespace_id");
    expect(recordFence?.parameters[7]).toBe(
      JSON.stringify([[ALICE, BOB], [ALICE, BOB]]),
    );

    const memoryFence = value.queries.find((query) =>
      query.statement.includes("current_required AS")
    );
    expect(memoryFence?.statement).toContain("attachment.authority_namespace_ids");
    expect(memoryFence?.statement).toContain("memory.updated_at");
    expect(memoryFence?.parameters[4]).toBe(
      JSON.stringify([[MEMORY_NAMESPACE]]),
    );
  });

  test("returns stale when any exact fence coordinate no longer matches", async () => {
    const value = await fixture((statement) =>
      statement.includes("reflection_record_payload_representation_heads")
        ? [{ matched_count: 0 }]
        : []
    );
    const record = {
      kind: "record" as const,
      recordRef: "record:candidate",
      score: Math.fround(0.8),
      structuralHeight: 1,
      recordProcessingGeneration: 2,
      searchProjectionGeneration: 3,
      payloadRepresentationGeneration: 4,
      authorityProjectionGeneration: 5,
      authorityAccessNamespaceRef: RECORD_ACCESS_NAMESPACE,
      audience: { humanRefs: [ALICE], includesPublicBoundary: false },
      readNamespaceRef: RECORD_NAMESPACE,
      readBindingRef: RECORD_BINDING,
    };
    expect(await value.store.fence({
      selection: base.selection,
      candidates: [record],
    })).toEqual({ status: "stale" });
  });

  test("publication fence uses the held executor and observes its current coordinates", async () => {
    const value = await fixture(() => { throw new Error("must not open another snapshot"); });
    let matched = 1;
    const heldQueries: string[] = [];
    const held: RecordProductPostgresExecutor = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        heldQueries.push(statement);
        return [{matched_count: matched}] as unknown as readonly Row[];
      },
    };
    const changed = {
      kind: "record" as const, structuralHeight: 0,
      recordRef: "record:changed", recordProcessingGeneration: 2,
      searchProjectionGeneration: 3, payloadRepresentationGeneration: 4,
      authorityProjectionGeneration: 5, authorityAccessNamespaceRef: RECORD_ACCESS_NAMESPACE,
      audience: {humanRefs: [ALICE], includesPublicBoundary: false},
      readNamespaceRef: RECORD_NAMESPACE, readBindingRef: RECORD_BINDING,
    };
    expect(await value.store.fence({selection: base.selection, changed, candidates: []}, held))
      .toEqual({status: "current"});
    matched = 0;
    expect(await value.store.fence({selection: base.selection, changed, candidates: []}, held))
      .toEqual({status: "stale"});
    expect(heldQueries).toHaveLength(6);
    expect(heldQueries.filter(statement => statement.includes("statement_timeout"))).toHaveLength(2);
    expect(heldQueries.every(statement => !statement.includes("SET TRANSACTION"))).toBe(true);
    expect(value.queries).toHaveLength(0);
  });

  test("fences protected Memory mapping identity and access revision", async () => {
    const value = await fixture((statement) =>
      statement.includes("current_required AS")
        ? [{ matched_count: 1 }]
        : []
    );
    const memory: CrossRoomMemoryCandidate = {
      kind: "memory",
      memoryRef: MEMORY_ID,
      logicalSourceRef: `memory:${MEMORY_ID}`,
      score: Math.fround(0.9),
      contentRevision: 7,
      embeddingRevision: 7,
      embeddingProvenance: EMBEDDING.provenance,
      updatedAtCoordinate: "2026-08-20T10:00:00.123456Z",
      authorityNamespaceRefs: [MEMORY_NAMESPACE],
      audience: { humanRefs: [ALICE], includesPublicBoundary: false },
      readNamespaceRef: MEMORY_NAMESPACE,
      readBindingRef: `journal:namespace:${MEMORY_NAMESPACE}:protected:v4`,
      protectedCryptoObjectId: "memory:v1:protected-object",
      protectedCryptoAccessRevision: 4,
    };
    expect(await value.store.fence({
      selection: {
        selectedRepresentation: "protected",
        migrationGeneration: 4,
      },
      candidates: [memory],
    })).toEqual({ status: "current" });
    const query = value.queries.find((entry) =>
      entry.statement.includes("current_required AS")
    );
    expect(query?.statement).toContain(
      "memory.crypto_object_id = requested.protected_crypto_object_id",
    );
    expect(query?.statement).toContain("memory.crypto_mapping_state = 'verified'");
    expect(query?.statement).toContain("memory_crypto_revisions AS crypto_revision");
    expect(query?.parameters[12]).toEqual(["memory:v1:protected-object"]);
    expect(query?.parameters[13]).toEqual([4]);
  });

  test("maps statement cancellation and bounded topology overflow", async () => {
    const timeout = await fixture((statement) => {
      if (statement.includes("SELECT * FROM provenance_first LIMIT 2")) {
        return [changedRow()];
      }
      if (statement.includes("provenance_first AS MATERIALIZED")) {
        throw Object.assign(new Error("cancelled"), { code: "57014" });
      }
      return [];
    });
    expect(await timeout.store.discover(base)).toEqual({
      status: "unavailable",
      reason: "timeout",
    });

    const overflow = await fixture((statement) => {
      if (statement.includes("SELECT * FROM provenance_first LIMIT 2")) {
        return [changedRow()];
      }
      if (statement.includes("provenance_first AS MATERIALIZED")) {
        return [recordRow("record:candidate", 0.9)];
      }
      if (statement.includes("graph_walk")) {
        return [{
          traversal_work:
            CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum + 1,
          overflowed: true,
          redundant_record_id: null,
        }];
      }
      return [];
    });
    expect(await overflow.store.discover(base)).toEqual({
      status: "unavailable",
      reason: "topology_capacity_exceeded",
    });
  });
});
