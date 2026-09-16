import {describe, expect, test} from "bun:test";
import {drizzle} from "drizzle-orm/postgres-js";
import type {Sql} from "postgres";
import {
  attachPostgresForegroundJournalRepair, loadPostgresForegroundJournalRepairSources,
  loadPostgresForegroundRecordRepairSources, restorePostgresForegroundJournalOrdinary,
  validatePostgresForegroundJournalRepairSource,
} from "../../src/server/journal/postgres-foreground-journal-repair.ts";
import {
  bindConversationProductCanonicalTransactionRunner, verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow, type ConversationProductPostgresConnection,
  type ConversationProductPostgresScalar, type ConversationProductCanonicalTransactionConnection,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import {ForegroundProductChangedError} from "../../src/server/foreground-product-changed.ts";
import type {ForegroundJournalSelectedEvent} from "../../src/journal/foreground-journal-selection.ts";

const ROOM = "10000000-0000-4000-8000-000000000001";
const NS = "20000000-0000-4000-8000-000000000001";
const ACCESS_NS = "20000000-0000-4000-8000-000000000002";
const EVENT = "30000000-0000-4000-8000-000000000001";
const BATCH = "40000000-0000-4000-8000-000000000001";
const CREATED = "2026-09-10T10:00:00.000Z";
const OBJECT = "stenographer/record/1";

async function fixture(options: {ordinary?: boolean; protected?: boolean; reprojected?: boolean} = {}) {
  const state = {namespace_id: NS, rebuild_generation: 0, rebuild_requested_at: null as Date | null,
    rebuild_target_message_id: null as number | null};
  const event = {room_id: ROOM, sequence: 1, kind: "fact", status: "active", supersedes_event_id: null as string | null,
    resolves_event_id: null, source_message_ids: [7], source_batch_id: BATCH, batch_local_ordinal: 0,
    extractor_version: "stenographer-v1", projection_kind: "native", record_id: EVENT, crypto_object_id: null,
    statement: null, created_at: CREATED};
  const record = {lifecycle: "current", structural_height: 0, processing_generation: 1, disposition: "available",
    producer_policy_version: "stenographer-v1", payload_version: 1, created_at: CREATED};
  const generation = options.reprojected ? 2 : 1;
  const mapping = {representation_generation: generation, current_representation_generation: generation, crypto_object_id: OBJECT};
  let ordinary: Uint8Array | null = options.ordinary ? new Uint8Array([1, 2, 3]) : null;
  let protectedPresent = options.protected !== false;
  let complete = protectedPresent && !options.reprojected;
  let reconciled = options.reprojected === true;
  let reconciliationNamespaces: unknown = [ACCESS_NS];
  let reconciliationCount = 1;
  let reconciliationState = "complete";
  let reconciliationRetired = false;
  let reconciliationGeneration = generation;
  let reconciliationObjectId = OBJECT;
  let ordinaryComplete = options.ordinary === true;
  const calls: {sql: string; parameters: readonly unknown[]}[] = [];
  const query = (statement: string, parameters: readonly unknown[] = []): readonly Record<string, unknown>[] => {
    const sql = statement.replaceAll('"', "").toLowerCase();
    calls.push({sql, parameters});
    if (sql.includes("current_user")) return [{current_user: "nautilo", session_user: "nautilo"}];
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("from encryption_transition_policy")) return [{mode: "shadow_encryption", revision: 7}];
    if (sql.includes("from reflection_record_authority_reconciliations")) {
      const matches = reconciled
        && parameters.includes(reconciliationGeneration)
        && parameters.includes(reconciliationObjectId)
        && (!parameters.includes("complete") || reconciliationState === "complete")
        && (!sql.includes("target_crypto_retired_at is null") || !reconciliationRetired);
      return matches ? Array.from({length: reconciliationCount}, (_, index) => ({
        reconciliation_id: `reproject:${index + 2}`,
        target_access_namespace_ids: reconciliationNamespaces,
      })) : [];
    }
    if (sql.includes("reflection_record_authority_")) return [];
    if (sql.startsWith("insert into reflection_record_payload_representations")) {
      if (parameters.includes("ordinary")) ordinary = Uint8Array.from(parameters.find((value) => value instanceof Uint8Array) as Uint8Array);
      else protectedPresent = true;
      return [];
    }
    if (sql.startsWith("insert into reflection_record_payload_representation_heads")) return [];
    if (sql.startsWith("insert into reflection_record_publications")) {complete = true; return [];}
    if (sql.includes("from room_journal_state")) return [state];
    if (sql.includes("from room_events")) return [event];
    if (sql.includes("from reflection_record_publications")) return (parameters.includes("ordinary") ? ordinaryComplete : complete) ? [{publication_id: "journal:batch:0"}] : [];
    if (sql.includes("from reflection_record_payload_representations")
      || sql.includes("from reflection_record_payload_representation_heads")
      || (sql.includes("from reflection_records") && sql.includes("join reflection_record_payload"))) {
      if (parameters.includes("ordinary")) return ordinary === null ? [] : [{...record, ...mapping, plaintext_payload_bytes: ordinary}];
      return protectedPresent ? [{...mapping,
        publication_object_id: OBJECT, state: complete ? "complete" : "reserved",
        request_commitment: new Uint8Array(32), publication_binding_ref: "journal:namespace:protected:v1"}] : [];
    }
    if (sql.includes("from reflection_records")) return [record];
    throw new Error(`Unexpected SQL: ${statement}`);
  };
  const connection: ConversationProductPostgresConnection = {
    query: <Row extends ConversationProductDatabaseRow>(sql: string, parameters: readonly ConversationProductPostgresScalar[] = []) =>
      Promise.resolve(query(sql, parameters) as readonly Row[]),
    transaction: (use) => use(connection),
  };
  const product = await verifyConversationProductPostgresHandle(connection);
  const unsafe = (sql: string, parameters: readonly unknown[] = []) => {
    const result = query(sql, parameters);
    return Object.assign(Promise.resolve(result), {values: () => {
      const fields = sql.slice(sql.toLowerCase().indexOf("select ") + 7, sql.toLowerCase().indexOf(" from ")).split(", ");
      return Promise.resolve(result.map((row) => fields.map((field) => {
        const names = [...field.matchAll(/"([a-z_]+)"/gu)];
        return row[names.at(-1)?.[1] ?? field];
      })));
    }});
  };
  const client = Object.assign(() => undefined, {unsafe, options: {parsers: {}, serializers: {}}});
  const db = drizzle(client as unknown as Sql);
  const canonical = bindConversationProductCanonicalTransactionRunner(product, {
    transaction: (use) => use(db as unknown as Parameters<Parameters<ConversationProductCanonicalTransactionConnection["transaction"]>[0]>[0], connection),
  });
  const selected: ForegroundJournalSelectedEvent = {kind: "event", rebuildGeneration: 0, status: "active",
    binding: {eventId: EVENT, roomId: ROOM, namespaceId: NS, sequence: 1, kind: "fact", supersedesEventId: null,
      resolvesEventId: null, sourceMessageIds: [7], sourceBatchId: BATCH, batchLocalOrdinal: 0,
      extractorVersion: "stenographer-v1", createdAt: CREATED},
    payload: {kind: "reflection_record", recordId: EVENT, lifecycle: "current", structuralHeight: 0,
      processingGeneration: 1, ordinaryRepresentationGeneration: ordinary === null ? null : 1,
      protectedMapping: protectedPresent ? {status: "mapped", representationGeneration: generation, cryptoObjectId: OBJECT} : {status: "missing"}}};
  const snapshot = {roomId: ROOM, namespaceId: NS, rebuildGeneration: 0, rollup: null, events: [selected]};
  const load = async (representationMode: "ordinary-and-protected" | "protected-only" = "protected-only") =>
    (await loadPostgresForegroundJournalRepairSources({product, snapshot, representationMode}))[0]!;
  return {product, canonical, state, event, record, mapping, selected, snapshot, calls, load,
    incompleteReconciliation: () => {reconciled = false;},
    reconciliationNamespaces: (value: unknown) => {reconciliationNamespaces = value;},
    duplicateReconciliation: () => {reconciliationCount = 2;},
    retireReconciliation: () => {reconciliationRetired = true;},
    reconciliationState: (value: string) => {reconciliationState = value;},
    reconciliationGeneration: (value: number) => {reconciliationGeneration = value;},
    reconciliationObjectId: (value: string) => {reconciliationObjectId = value;},
    ordinary: () => ordinary, incomplete: () => {complete = false;},
    removeOrdinary: () => {ordinary = null;}, incompleteOrdinary: () => {ordinaryComplete = false;}};
}

async function denied(work: Promise<unknown>) {
  const result = await work.catch((error: unknown) => {
    if (!(error instanceof ForegroundProductChangedError)) throw error;
    return false;
  });
  expect(result === false || result === "conflict").toBe(true);
}

async function failure(work: Promise<unknown>, message: string) {
  const result: unknown = await work.then(() => null, (error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  if (result instanceof Error) expect(result.message).toContain(message);
}

describe("native Journal source authority", () => {
  test("reads a reprojected native source using its exact crypto Namespace while retaining Room admission", async () => {
    const f = await fixture({reprojected: true});
    const source = await f.load();
    expect(source.selection.binding.namespaceId).toBe(NS);
    expect(source.authorityKind).toBe("journal_source");
    expect(source.authorityProjectionGeneration).toBeNull();
    expect(source.accessNamespaceIds).toEqual([ACCESS_NS]);
    expect(await validatePostgresForegroundJournalRepairSource({product: f.product, source, objectId: OBJECT})).toBe(true);
    expect(f.calls.some(({sql}) => sql.includes("reflection_record_authority_projections"))).toBe(false);
    await denied(validatePostgresForegroundJournalRepairSource({product: f.product,
      source: {...source, accessNamespaceIds: [NS]}, objectId: OBJECT}));
    f.state.namespace_id = "changed-room";
    await denied(validatePostgresForegroundJournalRepairSource({product: f.product, source, objectId: OBJECT}));
  });
  test("selects one exact unretired reconciliation for the current protected head", async () => {
    const f = await fixture({reprojected: true});
    await f.load();
    const calls = f.calls.filter(({sql}) => sql.includes("from reflection_record_authority_reconciliations"));
    expect(calls.length).toBe(1);
    expect(calls[0]!.parameters.slice(0, 4)).toEqual([EVENT, 2, OBJECT, "complete"]);
    expect(calls[0]!.parameters.at(-1)).toBe(2);
    expect(calls[0]!.sql).toContain("target_crypto_retired_at is null");
  });
  for (const [name, namespaces] of [
    ["missing", null],
    ["empty", []],
    ["empty member", [""]],
    ["duplicate", [ACCESS_NS, ACCESS_NS]],
    ["unsorted", [ACCESS_NS, NS]],
  ] as const) {
    test(`rejects a reprojected Journal reconciliation with ${name} Namespaces`, async () => {
      const f = await fixture({reprojected: true});
      f.reconciliationNamespaces(namespaces);
      await failure(f.load(), "reconciliation binding is incomplete");
    });
  }
  test("rejects multiple matching complete reconciliations", async () => {
    const f = await fixture({reprojected: true});
    f.duplicateReconciliation();
    await failure(f.load(), "reconciliation binding is ambiguous");
  });
  for (const state of ["crypto_complete", "attached"] as const) {
    test(`does not accept a ${state} reconciliation as complete`, async () => {
      const f = await fixture({reprojected: true});
      f.reconciliationState(state);
      await failure(f.load(), "protected publication is incomplete");
    });
  }
  test("does not accept a retired complete reconciliation", async () => {
    const f = await fixture({reprojected: true});
    f.retireReconciliation();
    await failure(f.load(), "protected publication is incomplete");
  });
  for (const change of ["namespaces", "head", "generation", "receipt generation", "receipt object", "receipt missing"] as const) {
    test(`rejects reprojected ${change} changes after load`, async () => {
      const f = await fixture({reprojected: true});
      const source = await f.load();
      if (change === "namespaces") f.reconciliationNamespaces([NS]);
      if (change === "head") f.mapping.crypto_object_id = "different-object";
      if (change === "generation") f.mapping.representation_generation++;
      if (change === "receipt generation") f.reconciliationGeneration(3);
      if (change === "receipt object") f.reconciliationObjectId("different-object");
      if (change === "receipt missing") f.incompleteReconciliation();
      await denied(validatePostgresForegroundJournalRepairSource({product: f.product, source, objectId: OBJECT}));
    });
  }
  test("rejects a reprojected Journal head without its exact complete reconciliation", async () => {
    const f = await fixture({reprojected: true});
    f.incompleteReconciliation();
    await failure(f.load(), "protected publication is incomplete");
  });
  test("does not invent an ordinary generation when Shadow reopens a protected-only Record", async () => {
    const f = await fixture();
    const source = await f.load("ordinary-and-protected");
    expect(source.existingObjectId).toBe(OBJECT);
    expect(source.ordinaryRepresentationGeneration).toBeNull();
    expect(source.plaintextBytes).toBeNull();
  });
  test("uses only the source Namespace and revalidates without a generic Record projection", async () => {
    const f = await fixture(); const source = await f.load();
    expect(source.authorityKind).toBe("journal_source");
    expect(source.authorityProjectionGeneration).toBeNull();
    expect(source.accessNamespaceIds).toEqual([NS]);
    expect(source.ordinaryRepresentationGeneration).toBeNull();
    expect(await validatePostgresForegroundJournalRepairSource({product: f.product, source, objectId: OBJECT})).toBe(true);
    expect(f.calls.some(({sql}) => sql.includes("reflection_record_authority_"))).toBe(false);
    expect(f.calls.some(({sql}) => sql.includes("for share"))).toBe(true);
  });
  test("standalone Record loading still requires its generic projection", async () => {
    const f = await fixture();
    await failure(loadPostgresForegroundRecordRepairSources({product: f.product, records: [{recordRef: EVENT,
      lifecycle: "current", structuralHeight: 0}], representationMode: "protected-only"}), "authority");
    expect(f.calls.some(({sql}) => sql.includes("reflection_record_authority_projections"))).toBe(true);
  });
  for (const change of ["namespace", "rebuild", "pending", "target", "sequence", "status", "source", "record", "head", "generation", "receipt"] as const) {
    test(`rejects ${change} changes after load`, async () => {
      const f = await fixture(); const source = await f.load();
      if (change === "namespace") f.state.namespace_id = "other";
      if (change === "rebuild") f.state.rebuild_generation++;
      if (change === "pending") f.state.rebuild_requested_at = new Date();
      if (change === "target") f.state.rebuild_target_message_id = 99;
      if (change === "sequence") f.event.sequence++;
      if (change === "status") f.event.status = "resolved";
      if (change === "source") f.event.source_message_ids = [8];
      if (change === "record") f.record.processing_generation++;
      if (change === "head") f.mapping.crypto_object_id = "different-object";
      if (change === "generation") f.mapping.representation_generation++;
      if (change === "receipt") f.incomplete();
      await denied(validatePostgresForegroundJournalRepairSource({product: f.product, source, objectId: OBJECT}));
    });
  }
  test("refuses stale Room or mapping during load", async () => {
    const f = await fixture(); f.state.namespace_id = "other";
    await failure(f.load(), "Room");
    f.state.namespace_id = NS; f.mapping.representation_generation++;
    await failure(f.load(), "head");
  });
  test("restores ordinary sibling with the same Journal source checks and no projection", async () => {
    const f = await fixture(); const source = await f.load("ordinary-and-protected");
    expect(source.plaintextBytes).toBeNull();
    const bytes = new Uint8Array([4, 5, 6]);
    expect(await restorePostgresForegroundJournalOrdinary({canonical: f.canonical, source, objectId: OBJECT,
      payloadBytes: bytes, expectedPolicyRevision: 7})).toBe("restored");
    expect(f.ordinary()).toEqual(bytes);
    expect(f.calls.some(({sql}) => sql.includes("reflection_record_authority_"))).toBe(false);
  });
  test("restore rejects exact event lineage changes before any ordinary write", async () => {
    const f = await fixture(); const source = await f.load("ordinary-and-protected");
    f.event.source_batch_id = "other-batch";
    await denied(restorePostgresForegroundJournalOrdinary({canonical: f.canonical, source, objectId: OBJECT,
      payloadBytes: new Uint8Array([4]), expectedPolicyRevision: 7}));
    expect(f.ordinary()).toBeNull();
  });
  test("attaches repaired native output without generic authority, retaining ordinary bytes", async () => {
    const f = await fixture({ordinary: true, protected: false}); const source = await f.load("ordinary-and-protected");
    expect(await attachPostgresForegroundJournalRepair({product: f.product, source, objectId: OBJECT,
      publicationId: "repair:one", requestCommitment: new Uint8Array(32), publicationBindingRef: "journal:namespace:protected:v1"})).toBe("attached");
    expect(f.ordinary()).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.calls.some(({sql}) => sql.includes("reflection_record_authority_"))).toBe(false);
  });
  for (const change of ["namespace", "rebuild", "head", "receipt", "producer", "time", "predecessor"] as const) {
    test(`ordinary restore rejects ${change} changes with no write`, async () => {
      const f = await fixture(); const source = await f.load("ordinary-and-protected");
      if (change === "namespace") f.state.namespace_id = "other";
      if (change === "rebuild") f.state.rebuild_generation++;
      if (change === "head") f.mapping.crypto_object_id = "other-object";
      if (change === "receipt") f.incomplete();
      if (change === "producer") f.record.producer_policy_version = "other-producer";
      if (change === "time") f.event.created_at = "2026-09-10T11:00:00.000Z";
      if (change === "predecessor") f.event.supersedes_event_id = "other-event";
      await denied(restorePostgresForegroundJournalOrdinary({canonical: f.canonical, source, objectId: OBJECT,
        payloadBytes: new Uint8Array([4]), expectedPolicyRevision: 7}));
      expect(f.ordinary()).toBeNull();
      expect(f.calls.some(({sql}) => sql.startsWith("insert"))).toBe(false);
    });
  }
  test("does not treat a forged source namespace list as Journal authority", async () => {
    const f = await fixture(); const source = await f.load();
    await denied(validatePostgresForegroundJournalRepairSource({product: f.product,
      source: {...source, accessNamespaceIds: ["unrelated-namespace"]}, objectId: OBJECT}));
  });
  test("rejects a removed selected ordinary head rather than silently changing representation", async () => {
    const f = await fixture({ordinary: true}); f.removeOrdinary();
    await failure(f.load("ordinary-and-protected"), "plaintext changed");
  });
  test("requires a complete ordinary publication before creating its first protected sibling", async () => {
    const f = await fixture({ordinary: true, protected: false}); f.incompleteOrdinary();
    await failure(f.load("ordinary-and-protected"), "ordinary publication is incomplete");
  });
  test("repair attach rejects a changed source range", async () => {
    const f = await fixture({ordinary: true, protected: false}); const source = await f.load("ordinary-and-protected");
    f.event.source_message_ids = [7, 8];
    await denied(attachPostgresForegroundJournalRepair({product: f.product, source, objectId: OBJECT,
      publicationId: "repair:one", requestCommitment: new Uint8Array(32), publicationBindingRef: "journal:namespace:protected:v1"}));
    expect(f.calls.some(({sql}) => sql.startsWith("insert"))).toBe(false);
  });
});
