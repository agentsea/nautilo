import { describe, expect, test } from "bun:test";
import type {
  RankedRecordCoordinate,
  RecordEmbeddingV1,
} from "@nautilo/reflection/search";

import {
  PostgresSameRoomOrganizerStore,
  SAME_ROOM_ORGANIZER_QUERY_POLICY_V1,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
  type RecordProductPostgresScalar,
  verifyRecordProductPostgresHandle,
} from "../../src/server";

const HUMAN = "11111111-1111-4111-8111-111111111111";

const EMBEDDING: RecordEmbeddingV1 = {
  provenance: {
    provider: "deterministic",
    canonicalModel: "v1",
    dimensions: 1_536,
    contractVersion: 1,
  },
  vector: Object.freeze(Array.from({ length: 1_536 }, () => Math.fround(0.25))),
};

function coordinate(recordRef = "record:candidate"): RankedRecordCoordinate {
  return {
    recordRef,
    score: Math.fround(0.9),
    structuralHeight: 1,
    recordProcessingGeneration: 2,
    projectionGeneration: 3,
    payloadRepresentationGeneration: 4,
    authorityProjectionGeneration: 5,
  };
}

async function fixture(
  responder: (
    statement: string,
    parameters: readonly RecordProductPostgresScalar[],
  ) => readonly RecordProductPostgresRow[] = () => [],
) {
  const queries: Array<Readonly<{
    statement: string;
    parameters: readonly RecordProductPostgresScalar[];
  }>> = [];
  const connection: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(
      statement: string,
      parameters: readonly RecordProductPostgresScalar[] = [],
    ) {
      if (statement.startsWith("SELECT current_user")) {
        return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as readonly Row[];
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
    store: new PostgresSameRoomOrganizerStore(
      await verifyRecordProductPostgresHandle(connection),
    ),
    queries,
  };
}

const base = {
  embedding: EMBEDDING,
  invocationAudience: {
    humanRefs: [HUMAN],
    includesPublicBoundary: false,
  },
  selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
  publicationBindingRef: "binding:room-one",
  changedRecordRef: "record:changed",
  intent: "attachment",
} as const;

describe("exact-Room Organizer PostgreSQL store", () => {
  test("filters exact selected current heads before vector ranking", async () => {
    const value = await fixture((statement) =>
      statement.includes("compatible_projections AS MATERIALIZED")
        ? [{
            record_id: "record:candidate",
            structural_height: 1,
            processing_generation: 2,
            authority_projection_generation: 5,
            payload_representation_generation: 4,
            projection_generation: 3,
            score: 0.9,
            rows_considered: 1,
          }]
        : []
    );
    const result = await value.store.rank({
      ...base,
      intent: "attachment",
      limit: 16,
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.coordinates).toEqual([coordinate()]);

    const sql = value.queries[3]!.statement;
    const eligible = sql.slice(
      sql.indexOf("eligible_exact_room AS MATERIALIZED"),
      sql.indexOf("compatible_projections AS MATERIALIZED"),
    );
    expect(eligible).not.toContain("<=>");
    expect(eligible).not.toContain("search_projection.embedding");
    expect(sql).toContain("publication.publication_binding_ref = $9");
    expect(sql).toContain("publication.state = 'complete'");
    expect(sql).toContain("record.lifecycle = 'current'");
    expect(sql).toContain("authority.processing_state = 'current'");
    expect(sql).toContain("successor.predecessor_record_id = record.record_id");
    expect(sql).toContain("record.record_id <> $10");
    expect(sql).toContain("score >= $12::real");
    expect(sql).toContain("ORDER BY score DESC, structural_height DESC, record_id ASC");
    expect(value.queries[3]!.parameters[7]).toBe("ordinary");
    expect(value.queries[3]!.parameters[8]).toBe("binding:room-one");
    expect(value.queries[3]!.parameters[12]).toBe(16);
  });

  test("promotion ranking excludes leaves inside the pre-vector eligible set", async () => {
    const value = await fixture();
    await value.store.rank({ ...base, intent: "promotion", limit: 8 });
    const sql = value.queries[3]!.statement;
    expect(sql).toContain("NOT $11::boolean");
    expect(sql).toContain("record.structural_height > 0");
    expect(sql).toContain("record.created_at <= now()");
    expect(value.queries[3]!.parameters[10]).toBe(true);
    expect(value.queries[3]!.parameters[12]).toBe(8);
    expect(value.queries[3]!.parameters[13]).toBe(5 * 60 * 1_000);
  });

  test("loads bounded topology and exact-Room parent coordinates before normalization", async () => {
    const value = await fixture((statement) => {
      if (!statement.includes("graph_walk")) return [];
      return [
        {
          row_kind: "state",
          record_id: null,
          structural_height: null,
          processing_generation: null,
          authority_projection_generation: null,
          payload_representation_generation: null,
          projection_generation: null,
          score: null,
          traversal_work: 3,
          direct_parent_count: 1,
          overflowed: false,
        },
        {
          row_kind: "parent",
          record_id: "record:parent",
          structural_height: 1,
          processing_generation: 2,
          authority_projection_generation: 5,
          payload_representation_generation: 4,
          projection_generation: 3,
          score: 0,
          traversal_work: null,
          direct_parent_count: null,
          overflowed: null,
        },
        {
          row_kind: "redundant",
          record_id: "record:child",
          structural_height: null,
          processing_generation: null,
          authority_projection_generation: null,
          payload_representation_generation: null,
          projection_generation: null,
          score: null,
          traversal_work: null,
          direct_parent_count: null,
          overflowed: null,
        },
      ];
    });
    const result = await value.store.topology({
      ...base,
      rankedCoordinates: [
        coordinate("record:parent"),
        coordinate("record:child"),
      ],
    });
    expect(result).toEqual({
      status: "available",
      topology: {
        directParents: [{ ...coordinate("record:parent"), score: 0 }],
        redundantRecordRefs: ["record:child"],
        traversalWork: 3,
        normalizedCoordinates: [],
        normalizedRecordRefs: new Map([
          ["record:changed", "record:changed"],
          ["record:parent", "record:parent"],
          ["record:child", "record:child"],
        ]),
        authorityParentRecordRefs: [],
        changedAlreadyParented: false,
      },
    });
    const sql = value.queries[2]!.statement;
    expect(sql).toContain("WITH RECURSIVE candidate_input");
    expect(sql).toContain("graph_seed(root_record_id, node_record_id, path)");
    expect(sql).toContain("SELECT $6::text, $6::text, ARRAY[$6::text]::text[]");
    expect(sql).toContain("reflection_record_dependencies AS dependency");
    expect(sql).toContain("direct_dependency.child_record_id = $6");
    const directParents = sql.slice(
      sql.indexOf("direct_parents AS MATERIALIZED"),
      sql.indexOf("graph_walk("),
    );
    expect(directParents).toContain(
      `LIMIT ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.directParentMaximum + 1}`,
    );
    expect(directParents).toContain(
      "ORDER BY direct_dependency.parent_record_id ASC",
    );
    const boundedWalk = sql.slice(
      sql.indexOf("bounded_walk AS MATERIALIZED"),
      sql.indexOf("topology_state AS"),
    );
    expect(boundedWalk).toContain(
      `LIMIT ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum + 1}`,
    );
    expect(boundedWalk).not.toContain("row_number");
    expect(boundedWalk).not.toContain("ORDER BY");
    expect(sql.replace(/\s+/gu, " ")).toContain(
      `count(*) > ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum}`,
    );
    expect(sql.replace(/\s+/gu, " ")).toContain(
      `(SELECT count(*) FROM direct_parents) > ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.directParentMaximum}`,
    );
    const redundant = sql.slice(
      sql.indexOf("redundant AS"),
      sql.indexOf("SELECT 'state'::text"),
    ).replace(/\s+/gu, " ");
    expect(redundant).toContain(
      "changed_walk.node_record_id = candidate_walk.node_record_id",
    );
    expect(redundant).toContain("changed_walk.root_record_id = $6");
    expect(redundant).toContain("candidate_walk.node_record_id = $6");
    expect(redundant).toContain("WHERE $7::boolean");
    expect(value.queries[2]!.parameters[6]).toBe(false);
  });

  test("normalizes an eligible leaf through a bounded current-parent chain", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("parent_walk(")) {
        return [
          {
            root_record_id: "record:changed", child_record_id: null,
            parent_record_id: "record:changed", depth: 0, cycle: false,
            structural_height: null, processing_generation: null,
            authority_projection_generation: null,
            payload_representation_generation: null, projection_generation: null,
            current_parent_count: 0,
          },
          {
            root_record_id: "record:leaf", child_record_id: null,
            parent_record_id: "record:leaf", depth: 0, cycle: false,
            structural_height: null, processing_generation: null,
            authority_projection_generation: null,
            payload_representation_generation: null, projection_generation: null,
            current_parent_count: 1,
          },
          {
            root_record_id: "record:leaf", child_record_id: "record:leaf",
            parent_record_id: "record:p", depth: 1, cycle: false,
            structural_height: 1, processing_generation: 2,
            authority_projection_generation: 5,
            payload_representation_generation: 4, projection_generation: 3,
            current_parent_count: 1,
          },
          {
            root_record_id: "record:leaf", child_record_id: "record:p",
            parent_record_id: "record:q", depth: 2, cycle: false,
            structural_height: 2, processing_generation: 2,
            authority_projection_generation: 5,
            payload_representation_generation: 4, projection_generation: 3,
            current_parent_count: 0,
          },
        ];
      }
      return statement.includes("graph_walk")
        ? [{
            row_kind: "state", record_id: null, structural_height: null,
            processing_generation: null, authority_projection_generation: null,
            payload_representation_generation: null, projection_generation: null,
            score: null, traversal_work: 2, direct_parent_count: 0, overflowed: false,
          }]
        : [];
    });
    const result = await value.store.topology({
      ...base,
      rankedCoordinates: [coordinate("record:leaf")],
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.topology.normalizedRecordRefs).toEqual(new Map([
      ["record:changed", "record:changed"],
      ["record:leaf", "record:q"],
    ]));
    expect(result.topology.normalizedCoordinates.map((entry) => entry.recordRef))
      .toEqual(["record:p", "record:q"]);
    expect(result.topology.traversalWork).toBe(4);
  });

  test("fails closed when an eligible Record has two current parents", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("parent_walk(")) {
        return [
          {
            root_record_id: "record:changed", child_record_id: null,
            parent_record_id: "record:changed", depth: 0, cycle: false,
            structural_height: null, processing_generation: null,
            authority_projection_generation: null,
            payload_representation_generation: null, projection_generation: null,
            current_parent_count: 0,
          },
          {
            root_record_id: "record:leaf", child_record_id: null,
            parent_record_id: "record:leaf", depth: 0, cycle: false,
            structural_height: null, processing_generation: null,
            authority_projection_generation: null,
            payload_representation_generation: null, projection_generation: null,
            current_parent_count: 2,
          },
          {
            root_record_id: "record:leaf", child_record_id: "record:leaf",
            parent_record_id: "record:p1", depth: 1, cycle: false,
            structural_height: 1, processing_generation: 1,
            authority_projection_generation: 1,
            payload_representation_generation: 1, projection_generation: 1,
            current_parent_count: 0,
          },
          {
            root_record_id: "record:leaf", child_record_id: "record:leaf",
            parent_record_id: "record:p2", depth: 1, cycle: false,
            structural_height: 1, processing_generation: 1,
            authority_projection_generation: 1,
            payload_representation_generation: 1, projection_generation: 1,
            current_parent_count: 0,
          },
        ];
      }
      return statement.includes("graph_walk")
        ? [{
            row_kind: "state", record_id: null, structural_height: null,
            processing_generation: null, authority_projection_generation: null,
            payload_representation_generation: null, projection_generation: null,
            score: null, traversal_work: 2, direct_parent_count: 0, overflowed: false,
          }]
        : [];
    });
    expect(await value.store.topology({
      ...base,
      rankedCoordinates: [coordinate("record:leaf")],
    })).toEqual({ status: "unavailable", reason: "topology_capacity_exceeded" });
  });

  test("delegates a unique current parent outside the exact binding", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("parent_walk(")) {
        return [{
          root_record_id: "record:changed", child_record_id: null,
          parent_record_id: "record:changed", depth: 0, cycle: false,
          structural_height: null, processing_generation: null,
          authority_projection_generation: null,
          payload_representation_generation: null, projection_generation: null,
          current_parent_count: 1,
        }];
      }
      return statement.includes("graph_walk")
        ? [{
            row_kind: "state", record_id: null, structural_height: null,
            processing_generation: null, authority_projection_generation: null,
            payload_representation_generation: null, projection_generation: null,
            score: null, traversal_work: 1, direct_parent_count: 0, overflowed: false,
          }]
        : [];
    });
    expect(await value.store.topology({
      ...base,
      rankedCoordinates: [],
    })).toEqual({
      status: "available",
      topology: {
        directParents: [],
        redundantRecordRefs: [],
        traversalWork: 1,
        normalizedCoordinates: [],
        normalizedRecordRefs: new Map([["record:changed", "record:changed"]]),
        authorityParentRecordRefs: ["record:changed"],
        changedAlreadyParented: true,
      },
    });
  });

  test("rejects topology overflow instead of returning a partial graph", async () => {
    const value = await fixture((statement) =>
      statement.includes("graph_walk")
        ? [{
            row_kind: "state",
            record_id: null,
            structural_height: null,
            processing_generation: null,
            authority_projection_generation: null,
            payload_representation_generation: null,
            projection_generation: null,
            score: null,
            traversal_work:
              SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum + 1,
            direct_parent_count: 0,
            overflowed: true,
          }]
        : []
    );
    expect(await value.store.topology({
      ...base,
      rankedCoordinates: [coordinate()],
    })).toEqual({ status: "unavailable", reason: "topology_capacity_exceeded" });
  });

  test("rejects direct-parent overflow instead of materializing it for adapter slicing", async () => {
    const value = await fixture((statement) =>
      statement.includes("graph_walk")
        ? [{
            row_kind: "state",
            record_id: null,
            structural_height: null,
            processing_generation: null,
            authority_projection_generation: null,
            payload_representation_generation: null,
            projection_generation: null,
            score: null,
            traversal_work: 1,
            direct_parent_count:
              SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.directParentMaximum + 1,
            overflowed: true,
          }]
        : []
    );
    expect(await value.store.topology({
      ...base,
      rankedCoordinates: [coordinate()],
    })).toEqual({ status: "unavailable", reason: "topology_capacity_exceeded" });
  });

  test("fences all selected generations, binding, representation, and authority at once", async () => {
    const value = await fixture((statement) =>
      statement.includes("WITH requested AS") ? [{ matched_count: 1 }] : []
    );
    expect(await value.store.fence({
      invocationAudience: base.invocationAudience,
      selection: { selectedRepresentation: "protected", migrationGeneration: 9 },
      publicationBindingRef: base.publicationBindingRef,
      coordinates: [coordinate()],
    })).toEqual({ status: "current" });
    const sql = value.queries[2]!.statement;
    expect(sql).toContain("WITH requested AS");
    expect(sql).toContain("publication.publication_binding_ref = $9");
    expect(sql).toContain("record.processing_generation");
    expect(sql).toContain("authority.projection_generation");
    expect(sql).toContain("representation_head.current_representation_generation");
    expect(sql).toContain("search_projection.projection_generation");
    expect(value.queries[2]!.parameters[7]).toBe("protected");
  });

  test("protected ranking, topology, and opening fence share origin provenance plus exact current-head evidence", async () => {
    const value = await fixture(statement => {
      if (statement.includes("graph_walk")) return [{row_kind: "state", traversal_work: 0, direct_parent_count: 0, overflowed: false}];
      if (statement.includes("WITH requested AS")) return [{matched_count: 1}];
      return [];
    });
    const protectedBase = {...base, selection: {selectedRepresentation: "protected", migrationGeneration: 9} as const};
    await value.store.rank(protectedBase);
    expect((await value.store.topology({...protectedBase, rankedCoordinates: [coordinate()]})).status).toBe("available");
    expect(await value.store.fence({...protectedBase, coordinates: [coordinate()]})).toEqual({status: "current"});
    const reads = value.queries.filter(query => query.statement.includes("AS current_proof"));
    expect(reads).toHaveLength(4);
    for (const {statement, parameters} of reads) {
      const sql = statement.replace(/\s+/gu, " ");
      // Cohort provenance stays on the earliest logical publication, including
      // cross-representation siblings, independently of the live payload head.
      expect(sql).toContain("ORDER BY origin.created_at, origin.publication_id LIMIT 1");
      expect(sql).toContain("origin_sibling.created_at = publication.created_at");
      expect(sql).toContain("coalesce(origin_sibling.origin_publication_binding_ref, origin_sibling.publication_binding_ref) !~*");
      expect(sql).toContain("coalesce(origin.origin_publication_binding_ref, origin.publication_binding_ref) AS publication_binding_ref");
      expect(sql).toContain("publication.publication_binding_ref ~*");
      expect(sql).not.toContain("origin.representation =");
      expect(sql).not.toContain("origin.representation_generation =");
      // An arbitrary unreceipted head does not qualify. The fallback is the
      // canonical native authority receipt for this exact object/generation.
      expect(sql).toContain("current_proof.publication_count = 1 OR ( current_proof.publication_count = 0");
      expect(sql).toContain("native_receipt.expected_projection_generation = authority.projection_generation - 1");
      expect(sql).toContain("native_receipt.source_change_generation = authority.source_change_generation");
      expect(sql).toContain("native_receipt.target_representation_generation = representation_head.current_representation_generation");
      expect(sql).toContain("native_receipt.target_crypto_object_id = current_payload.crypto_object_id");
      expect(sql).toContain("native_receipt.state = 'complete' LIMIT 2");
      expect(sql).toContain("AS native_receipts) = 1");
      expect(sql).toContain("authority.processing_state = 'current'");
      expect(sql).toContain("record.lifecycle = 'current'");
      const parameter = /publication.publication_binding_ref = \$(\d+)/u.exec(statement);
      expect(parameters[Number(parameter![1]) - 1]).toBe(base.publicationBindingRef);
    }
  });

  test("protected opening rejects a current-head or authority receipt change after ranking", async () => {
    const value = await fixture(statement => statement.includes("WITH requested AS") ? [{matched_count: 0}] : []);
    expect(await value.store.fence({...base, selection: {selectedRepresentation: "protected", migrationGeneration: 9},
      coordinates: [coordinate()]})).toEqual({status: "stale"});
    const sql = value.queries.find(query => query.statement.includes("WITH requested AS"))!.statement.replace(/\s+/gu, " ");
    expect(sql).toContain("record.processing_generation = requested.processing_generation");
    expect(sql).toContain("authority.projection_generation = requested.authority_projection_generation");
    expect(sql).toContain("representation_head.current_representation_generation = requested.payload_representation_generation");
    expect(sql).toContain("search_projection.projection_generation = requested.projection_generation");
  });

  test("maps statement cancellation to a typed whole-operation timeout", async () => {
    const value = await fixture((statement) => {
      if (statement.includes("compatible_projections AS MATERIALIZED")) {
        throw Object.assign(new Error("cancelled"), { code: "57014" });
      }
      return [];
    });
    expect(await value.store.rank({
      ...base,
      intent: "attachment",
      limit: 32,
    })).toEqual({ status: "unavailable", reason: "timeout" });
  });
});
