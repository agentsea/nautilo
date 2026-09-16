import {validatePostgresStenographerOutputRepairPlan, withPostgresStenographerOutputRepairSources} from "../../src/server/journal/postgres-stenographer-output-repair.ts";
import {describe, expect, test} from "bun:test";
import {stenographerOrdinaryOutputFingerprint} from
  "@nautilo/lattice-crypto/background";

import {
  buildStenographerOutputRepairPlan,
  listPostgresStenographerFallbackCandidates,
  selectPostgresStenographerFallback,
  type PostgresStenographerFallbackCandidateCursor,
} from
  "../../src/server/journal/postgres-stenographer-fallback-selection.ts";
import {ClassifiedDataOperationError} from
  "../../src/transition/encryption-data-operation-owner.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const ROOM = "10000000-0000-4000-8000-000000000001";
const NAMESPACE = "20000000-0000-4000-8000-000000000001";
const BATCH = "30000000-0000-4000-8000-000000000001";
const BATCH_TWO = "30000000-0000-4000-8000-000000000002";
const EVENT_ONE = "40000000-0000-4000-8000-000000000001";
const EVENT_TWO = "40000000-0000-4000-8000-000000000002";
const ROLLUP = "50000000-0000-4000-8000-000000000001";
const COMPLETED = "2026-09-10T10:00:00.000Z";
const FIRST_CREATED = "2026-09-10T09:00:00.000Z";
const SECOND_CREATED = "2026-09-10T09:01:00.000Z";

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly statements: string[] = [];
  readonly #results: Array<readonly unknown[]>;

  constructor(results: readonly (readonly unknown[])[]) {
    this.#results = [[{current_user: "nautilo", session_user: "nautilo"}], ...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    _parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    const result = this.#results.shift();
    if (result === undefined) return Promise.reject(new Error("Unexpected SQL"));
    return Promise.resolve(result as readonly Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    _options: Readonly<{isolationLevel: ConversationProductPostgresIsolationLevel}>,
  ): Promise<Result> {
    return callback(this);
  }
}

function extractionReceipt(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH,
    room_id: ROOM,
    namespace_id: NAMESPACE,
    status: "completed",
    observation_publication_version: 2,
    operation_count: 3,
    extractor_version: "m219-v1",
    ordinary_fallback_reason: "device",
    ordinary_fallback_rebuild_generation: 4,
    ordinary_output_fingerprint: new Uint8Array(32).fill(7),
    completed_at: COMPLETED,
    ...overrides,
  };
}

function scope(overrides: Record<string, unknown> = {}) {
  return {
    namespace_id: NAMESPACE,
    rebuild_generation: 4,
    rebuild_requested_at: null,
    rebuild_target_message_id: null,
    ...overrides,
  };
}

function event(id: string, ordinal: number, sequence: number,
  overrides: Record<string, unknown> = {}) {
  const createdAt = id === EVENT_ONE ? FIRST_CREATED : SECOND_CREATED;
  return {
    event_id: id,
    room_id: ROOM,
    sequence,
    kind: "fact",
    status: id === EVENT_ONE ? "superseded" : "active",
    supersedes_event_id: null,
    resolves_event_id: null,
    source_message_ids: [7 + ordinal],
    source_batch_id: BATCH,
    batch_local_ordinal: ordinal,
    extractor_version: "m219-v1",
    projection_kind: "native",
    record_id: id,
    event_crypto_object_id: null,
    created_at: createdAt,
    record_lifecycle: id === EVENT_ONE ? "superseded" : "current",
    record_structural_height: 0,
    record_processing_generation: 2,
    record_producer_policy_version: "m219-v1",
    record_payload_version: 1,
    record_disposition: "available",
    record_created_at: createdAt,
    ordinary_created_at: createdAt,
    ordinary_head_generation: 2,
    ordinary_representation_generation: 2,
    ordinary_representation_payload_version: 1,
    ordinary_representation_crypto_object_id: null,
    ordinary_publication_id: `ordinary:${id}`,
    protected_head_generation: ordinal === 0 ? 3 : null,
    protected_representation_generation: ordinal === 0 ? 3 : null,
    protected_representation_payload_version: ordinal === 0 ? 1 : null,
    protected_record_crypto_object_id: ordinal === 0 ? `record/${id}` : null,
    protected_publication_id: ordinal === 0 ? `protected:${id}` : null,
    ...overrides,
  };
}

async function run(
  kind: "extraction" | "compaction",
  id: string,
  results: readonly (readonly unknown[])[],
) {
  const connection = new ScriptedConnection(results);
  const product = await verifyConversationProductPostgresHandle(connection);
  const result = await selectPostgresStenographerFallback({
    product,
    receipt: {kind, id},
  });
  return {connection, result};
}

async function list(
  limit: number,
  results: readonly (readonly unknown[])[],
  after?: PostgresStenographerFallbackCandidateCursor,
) {
  const connection = new ScriptedConnection(results);
  const product = await verifyConversationProductPostgresHandle(connection);
  const result = await listPostgresStenographerFallbackCandidates({
    product,
    limit,
    ...(after === undefined ? {} : {after}),
  });
  return {connection, result};
}

async function integrityFailure(work: Promise<unknown>, message: string) {
  const error = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ClassifiedDataOperationError);
  expect((error as ClassifiedDataOperationError).failureClass).toBe("integrity");
  expect((error as Error).message).toContain(message);
}

describe("Postgres Stenographer fallback selection", () => {
  test("pages repairable metadata across extraction and compaction without selecting bodies", async () => {
    const {connection, result} = await list(2, [[
      {
        id: BATCH,
        room_id: ROOM,
        namespace_id: NAMESPACE,
        ordinary_fallback_rebuild_generation: 4,
        completed_at: "2026-09-10T08:59:00.000Z",
      },
      {
        id: BATCH_TWO,
        room_id: ROOM,
        namespace_id: NAMESPACE,
        ordinary_fallback_rebuild_generation: 4,
        completed_at: "2026-09-10T09:02:00.000Z",
      },
    ], [{
      id: ROLLUP,
      room_id: ROOM,
      namespace_id: NAMESPACE,
      ordinary_fallback_rebuild_generation: 4,
      created_at: "2026-09-10T09:00:00.000Z",
    }]]);

    expect(result.candidates.map(({kind, id}) => ({kind, id}))).toEqual([
      {kind: "extraction", id: BATCH},
      {kind: "compaction", id: ROLLUP},
    ]);
    expect(result.continuation).toEqual({
      createdAt: Date.parse("2026-09-10T09:00:00.000Z"),
      kind: "compaction",
      id: ROLLUP,
    });
    const sql = connection.statements.join("\n").toLowerCase();
    expect(sql).toContain("room_journal_batches");
    expect(sql).toContain("room_event_rollups");
    expect(sql).toContain("ordinary_fallback_rebuild_generation");
    expect(sql).toContain("rebuild_generation");
    expect(sql).toContain("room_members");
    expect(sql).toContain("actors");
    expect(sql).toContain("suspended_at");
    expect(sql).toContain("projection_kind");
    expect(sql).toContain("reflection_record_payload_representation_heads");
    expect(sql).not.toContain("plaintext_payload_bytes");
    expect(sql).not.toContain("payload_bytes");
    expect(sql).not.toContain("content");
  });

  test("continues strictly after the merged cursor so an empty batch cannot block later work", async () => {
    const after = {
      createdAt: Date.parse("2026-09-10T09:00:00.000Z"),
      kind: "extraction" as const,
      id: BATCH,
    };
    const {connection, result} = await list(2, [[{
      id: BATCH_TWO,
      room_id: ROOM,
      namespace_id: NAMESPACE,
      ordinary_fallback_rebuild_generation: 4,
      completed_at: "2026-09-10T09:02:00.000Z",
    }], [{
      id: ROLLUP,
      room_id: ROOM,
      namespace_id: NAMESPACE,
      ordinary_fallback_rebuild_generation: 4,
      created_at: "2026-09-10T09:00:00.000Z",
    }]], after);

    expect(result).toEqual({
      candidates: [
        expect.objectContaining({kind: "compaction", id: ROLLUP}),
        expect.objectContaining({kind: "extraction", id: BATCH_TWO}),
      ],
      continuation: null,
    });
    expect(connection.statements.slice(1).every(statement =>
      statement.includes("room_journal_state")
      && statement.includes("rebuild_requested_at")
      && statement.includes("rebuild_target_message_id")
    )).toBe(true);
  });

  test("selects every native output from an old completed batch without a status or prompt-window filter", async () => {
    const {connection, result} = await run("extraction", BATCH, [
      [extractionReceipt()],
      [scope()],
      [event(EVENT_ONE, 0, 21), event(EVENT_TWO, 2, 22)],
    ]);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready selection");
    expect(result.receipt).toMatchObject({
      kind: "extraction",
      id: BATCH,
      roomId: ROOM,
      namespaceId: NAMESPACE,
      rebuildGeneration: 4,
      fallbackReason: "device",
      createdAt: Date.parse(COMPLETED),
    });
    expect(result.snapshot.rollup).toBeNull();
    expect(result.snapshot.events.map((selected) => ({
      id: selected.binding.eventId,
      ordinal: selected.binding.batchLocalOrdinal,
      sequence: selected.binding.sequence,
      status: selected.status,
    }))).toEqual([
      {id: EVENT_ONE, ordinal: 0, sequence: 21, status: "superseded"},
      {id: EVENT_TWO, ordinal: 2, sequence: 22, status: "active"},
    ]);
    expect(result.snapshot.events[0]?.payload).toMatchObject({
      kind: "reflection_record",
      ordinaryRepresentationGeneration: 2,
      protectedMapping: {
        status: "mapped",
        representationGeneration: 3,
        cryptoObjectId: `record/${EVENT_ONE}`,
      },
    });
    expect(result.snapshot.events[1]?.payload).toMatchObject({
      kind: "reflection_record",
      protectedMapping: {status: "missing"},
    });
    const sql = connection.statements.join("\n").toLowerCase();
    expect(sql).not.toContain("statement");
    expect(sql).not.toContain("plaintext_payload_bytes");
    expect(sql).not.toContain("payload_bytes");
    expect(sql).not.toContain("room_events.status =");
  });

  test("authenticates a completed zero-output receipt instead of trusting an empty row set", async () => {
    const expected = stenographerOrdinaryOutputFingerprint({
      kind: "extraction",
      receiptId: BATCH,
      roomId: ROOM,
      namespaceId: NAMESPACE,
      rebuildGeneration: 4,
      fallbackReason: "authority",
      outputs: [],
    });
    try {
      const {result} = await run("extraction", BATCH, [
        [extractionReceipt({
          operation_count: 2,
          ordinary_fallback_reason: "authority",
          ordinary_output_fingerprint: expected,
        })],
        [scope()],
        [],
      ]);
      expect(result).toMatchObject({status: "ready", snapshot: {events: []}});
      if (result.status !== "ready") throw new Error("Expected ready selection");
      let allocations = 0;
      expect(buildStenographerOutputRepairPlan({
        selection: result,
        objectIdForMissing: () => {
          allocations += 1;
          return "must-not-be-allocated";
        },
      })).toBeNull();
      expect(allocations).toBe(0);

      const corrupted = Uint8Array.from(expected);
      corrupted[0] = corrupted[0]! ^ 1;
      await integrityFailure(run("extraction", BATCH, [
        [extractionReceipt({
          operation_count: 0,
          ordinary_fallback_reason: "authority",
          ordinary_output_fingerprint: corrupted,
        })],
        [scope()],
        [],
      ]), "fingerprint");
    } finally {
      expected.fill(0);
    }
  });

  test("returns missing or stale for an absent receipt and a changed rebuild scope", async () => {
    expect((await run("extraction", BATCH, [[]])).result).toEqual({status: "missing"});
    const {result} = await run("extraction", BATCH, [
      [extractionReceipt()],
      [scope({rebuild_generation: 5})],
    ]);
    expect(result).toEqual({status: "stale"});
  });

  test("rejects incoherent provenance, legacy output, and incomplete current protected mappings", async () => {
    await integrityFailure(run("extraction", BATCH, [[extractionReceipt({
      ordinary_output_fingerprint: null,
    })]]), "incoherent");

    await integrityFailure(run("extraction", BATCH, [
      [extractionReceipt({operation_count: 1})],
      [scope()],
      [event(EVENT_ONE, 0, 21, {projection_kind: "legacy", record_id: null})],
    ]), "native Record");

    await integrityFailure(run("extraction", BATCH, [
      [extractionReceipt({operation_count: 1})],
      [scope()],
      [event(EVENT_ONE, 0, 21, {protected_publication_id: null})],
    ]), "protected publication");
  });

  test("selects one exact compaction receipt and its current Room mapping without content", async () => {
    const row = {
      id: ROLLUP,
      room_id: ROOM,
      namespace_id: NAMESPACE,
      through_event_sequence: 19,
      source_event_count: 11,
      model_id: "model/one",
      compactor_version: "m219-v1",
      crypto_object_id: "rollup/object/one",
      ordinary_fallback_reason: "authority",
      ordinary_fallback_rebuild_generation: 4,
      ordinary_output_fingerprint: new Uint8Array(32).fill(5),
      created_at: COMPLETED,
    };
    const {connection, result} = await run("compaction", ROLLUP, [
      [row],
      [scope()],
    ]);
    expect(result).toMatchObject({
      status: "ready",
      receipt: {kind: "compaction", id: ROLLUP, createdAt: Date.parse(COMPLETED)},
      snapshot: {
        events: [],
        rollup: {
          binding: {rollupId: ROLLUP, throughEventSequence: 19},
          protectedMapping: {status: "mapped", cryptoObjectId: "rollup/object/one"},
        },
      },
    });
    expect(connection.statements.join("\n").toLowerCase()).not.toContain("content");
  });

  test("builds missing compaction metadata from its selected binding", async () => {
    const {result} = await run("compaction", ROLLUP, [[{
      id: ROLLUP,
      room_id: ROOM,
      namespace_id: NAMESPACE,
      through_event_sequence: 19,
      source_event_count: 11,
      model_id: "model/one",
      compactor_version: "m219-v1",
      crypto_object_id: null,
      ordinary_fallback_reason: "authority",
      ordinary_fallback_rebuild_generation: 4,
      ordinary_output_fingerprint: new Uint8Array(32).fill(5),
      created_at: COMPLETED,
    }], [scope()]]);
    if (result.status !== "ready") throw new Error("Expected ready selection");
    const plan = buildStenographerOutputRepairPlan({
      selection: result,
      objectIdForMissing: (logicalId, index) => `repair/${index}/${logicalId}`,
    });
    expect(plan?.binding.outputs).toEqual([expect.objectContaining({
      logicalId: ROLLUP,
      objectId: `repair/0/${ROLLUP}`,
      objectType: "room_event_rollup",
      createdAt: Date.parse(COMPLETED),
      disposition: "create",
      representationGeneration: 4,
      ordinaryRepresentationGeneration: null,
    })]);
  });

  test("builds and codec-validates existing and missing repair output metadata", async () => {
    const {result} = await run("extraction", BATCH, [
      [extractionReceipt()],
      [scope()],
      [event(EVENT_ONE, 0, 21), event(EVENT_TWO, 2, 22)],
    ]);
    if (result.status !== "ready") throw new Error("Expected ready selection");
    const plan = buildStenographerOutputRepairPlan({
      selection: result,
      objectIdForMissing: (logicalId, index) => `repair/${index}/${logicalId}`,
    });
    expect(plan?.binding.outputs).toEqual([
      expect.objectContaining({
        logicalId: EVENT_ONE,
        objectId: `record/${EVENT_ONE}`,
        disposition: "existing",
        representationGeneration: 3,
        ordinaryRepresentationGeneration: 2,
        createdAt: Date.parse(FIRST_CREATED),
      }),
      expect.objectContaining({
        logicalId: EVENT_TWO,
        objectId: `repair/1/${EVENT_TWO}`,
        disposition: "create",
        representationGeneration: 1,
        ordinaryRepresentationGeneration: 2,
        createdAt: Date.parse(SECOND_CREATED),
      }),
    ]);
  });
});


describe("repair authority after atomic attachment", () => {
  test.each(["missing", "complete", "substituted", "partial"] as const)("accepts only the original or exact complete Record inventory (%s)", async status => {
    const selection = await run("extraction", BATCH, [[extractionReceipt()], [scope()],
      [event(EVENT_ONE, 0, 21), event(EVENT_TWO, 2, 22)]]);
    if (selection.result.status !== "ready") throw new Error("Expected exact selection");
    const plan = buildStenographerOutputRepairPlan({selection: selection.result, objectIdForMissing: id => `repair/${id}`});
    if (plan === null) throw new Error("Expected nonempty repair");
    const second = status === "missing" ? event(EVENT_TWO, 2, 22) : event(EVENT_TWO, 2, 22, {
      protected_head_generation: 1, protected_representation_generation: 1, protected_representation_payload_version: 1,
      protected_record_crypto_object_id: status === "substituted" ? "other-output" : `repair/${EVENT_TWO}`,
      protected_publication_id: "repair-publication"});
    const first = status === "partial" ? event(EVENT_ONE, 0, 21, {protected_head_generation: null,
      protected_representation_generation: null, protected_representation_payload_version: null,
      protected_record_crypto_object_id: null, protected_publication_id: null}) : event(EVENT_ONE, 0, 21);
    const connection = new ScriptedConnection([[{mode: "shadow_encryption"}], [{room_id: ROOM}],
      [extractionReceipt()], [scope()], [first, second]]);
    await verifyConversationProductPostgresHandle(connection);
    expect(await validatePostgresStenographerOutputRepairPlan({transaction: connection, plan}))
      .toBe(status === "missing" || status === "complete");
    expect(connection.statements.join(" ")).not.toContain("plaintext_payload_bytes");
  });
});


describe("native repair payload timestamps", () => {
  const payloadCreated = "2026-09-10T09:01:07.017Z";
  const bytes = new Uint8Array([1, 2, 3]);
  const fingerprint = stenographerOrdinaryOutputFingerprint({kind: "extraction", receiptId: BATCH,
    roomId: ROOM, namespaceId: NAMESPACE, rebuildGeneration: 4, fallbackReason: "device", outputs: [{
      logicalId: EVENT_TWO, objectType: "nautilo.reflection.record.v1", createdAt: Date.parse(SECOND_CREATED), payloadBytes: bytes}]});
  const native = (createdAt = payloadCreated) => event(EVENT_TWO, 1, 22, {record_created_at: payloadCreated, ordinary_created_at: createdAt});
  const receipt = () => extractionReceipt({ordinary_output_fingerprint: fingerprint});
  const planFor = async () => {
    const {result} = await run("extraction", BATCH, [[receipt()], [scope()], [native()]]);
    if (result.status !== "ready") throw new Error("Expected native fallback");
    const plan = buildStenographerOutputRepairPlan({selection: result, objectIdForMissing: id => `repair/${id}`});
    if (plan === null) throw new Error("Expected missing native output");
    return plan;
  };

  test.each([payloadCreated, "2026-09-10T09:01:08.017Z"])("current metadata binds canonical payload time independently from event time (%s)", async currentTime => {
    const plan = await planFor();
    expect(plan.binding.outputs[0]!.createdAt).toBe(Date.parse(payloadCreated));
    expect(plan.snapshot.events[0]!.binding.createdAt).toBe(SECOND_CREATED);
    const connection = new ScriptedConnection([[{mode: "shadow_encryption"}], [{room_id: ROOM}],
      [receipt()], [scope()], [native(currentTime)]]);
    await verifyConversationProductPostgresHandle(connection);
    expect(await validatePostgresStenographerOutputRepairPlan({transaction: connection, plan})).toBe(currentTime === payloadCreated);
  });

  test("the claimed source loader preserves the historical receipt hash while encrypting the canonical payload time", async () => {
    const plan = await planFor();
    const connection = new ScriptedConnection([
      [scope()],
      [{...native(), statement: null, crypto_object_id: null}],
      [{plaintext_payload_bytes: bytes, created_at: payloadCreated, lifecycle: "current", structural_height: 0,
        processing_generation: 2, disposition: "available", current_representation_generation: 2}],
      [scope()],
      [{lifecycle: "current", structural_height: 0, processing_generation: 2, producer_policy_version: "m219-v1", payload_version: 1, disposition: "available"}],
      [], [{publication_id: "ordinary:published"}],
    ]);
    await verifyConversationProductPostgresHandle(connection);
    let opened = 0;
    await withPostgresStenographerOutputRepairSources({transaction: connection, plan, signal: new AbortController().signal,
      use: sources => {
        opened++;
        expect(sources[0]!.createdAt).toBe(Date.parse(payloadCreated));
        expect(sources[0]!.fingerprintCreatedAt).toBe(Date.parse(SECOND_CREATED));
        expect(sources[0]!.plaintextBytes).toEqual(bytes);
        expect(plan.binding.receipt.ordinaryOutputFingerprint).toEqual(fingerprint);
        return Promise.resolve();
      }});
    expect(opened).toBe(1);
    expect(connection.statements.some(statement => /^\s*(?:insert|update|delete)\b/iu.test(statement))).toBe(false);
  });
});
