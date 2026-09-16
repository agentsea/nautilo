import { describe, expect, test } from "bun:test";
import {
  createPostgresForegroundJournalSelectionPort,
  loadPostgresForegroundJournalRepairSources,
  validatePostgresForegroundJournalRepairSource,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const BATCH_ID = "40000000-0000-4000-8000-000000000001";

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly #results: Array<readonly unknown[]>;

  constructor(results: readonly (readonly unknown[])[]) {
    this.#results = [...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    _statement: string,
    _parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    const result = this.#results.shift();
    if (result === undefined) return Promise.reject(new Error("Unexpected SQL"));
    return Promise.resolve(result as readonly Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    _options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    return callback(this);
  }
}

function nativeEvent(ordinaryRepresentationGeneration: number | null) {
  return {
    event_id: EVENT_ID,
    event_crypto_object_id: null,
    crypto_object_id: null,
    room_id: ROOM_ID,
    sequence: 1,
    kind: "fact",
    status: "active",
    supersedes_event_id: null,
    resolves_event_id: null,
    source_message_ids: [7],
    source_batch_id: BATCH_ID,
    batch_local_ordinal: 0,
    extractor_version: "stenographer-v1",
    projection_kind: "native",
    record_id: EVENT_ID,
    record_lifecycle: "current",
    record_structural_height: 0,
    record_processing_generation: 1,
    ordinary_representation_generation: ordinaryRepresentationGeneration,
    protected_representation_generation: 1,
    protected_record_crypto_object_id: "stenographer/record/1",
    created_at: "2026-09-10T10:00:00.000Z",
  };
}

function record() {
  return {
    lifecycle: "current",
    structural_height: 0,
    processing_generation: 1,
    disposition: "available",
    producer_policy_version: "stenographer-v1",
    payload_version: 1,
    created_at: "2026-09-10T10:00:00.000Z",
  };
}

function journalScope() {
  return {namespace_id: NAMESPACE_ID, rebuild_generation: 0,
    rebuild_requested_at: null, rebuild_target_message_id: null};
}

function authorityRows(): readonly (readonly unknown[])[] {
  return [
    [journalScope()],
    [record()],
    [{
      representation_generation: 1,
      crypto_object_id: "stenographer/record/1",
    }],
    [{ publication_id: "journal:batch:0" }],
  ];
}

async function select(ordinaryRepresentationGeneration: number | null) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }],
    [{ namespace_id: NAMESPACE_ID, rebuild_generation: 0 }],
    [],
    [nativeEvent(ordinaryRepresentationGeneration)],
  ]);
  const product = await verifyConversationProductPostgresHandle(connection);
  return createPostgresForegroundJournalSelectionPort({ product }).selectCurrent({
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    maximumEvents: 1,
  });
}

describe("Postgres foreground Journal selection", () => {
  test("preserves an absent ordinary Record head as null", async () => {
    const snapshot = await select(null);

    expect(snapshot?.events[0]?.payload).toMatchObject({
      kind: "reflection_record",
      ordinaryRepresentationGeneration: null,
      protectedMapping: {
        status: "mapped",
        representationGeneration: 1,
        cryptoObjectId: "stenographer/record/1",
      },
    });
  });

  test("retains an existing ordinary Record generation", async () => {
    const snapshot = await select(3);

    expect(snapshot?.events[0]?.payload).toMatchObject({
      kind: "reflection_record",
      ordinaryRepresentationGeneration: 3,
    });
  });

  test("loads and revalidates a protected-only Record without inventing an ordinary generation", async () => {
    const snapshot = await select(null);
    expect(snapshot).not.toBeNull();
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [journalScope()],
      [nativeEvent(null)],
      [record()],
      ...authorityRows(),
      [journalScope()],
      [nativeEvent(null)],
      [journalScope()],
      [nativeEvent(null)],
      ...authorityRows(),
    ]);
    const product = await verifyConversationProductPostgresHandle(connection);

    const [source] = await loadPostgresForegroundJournalRepairSources({
      product,
      snapshot: snapshot!,
      representationMode: "protected-only",
    });

    expect(source?.ordinaryRepresentationGeneration).toBeNull();
    expect(source?.authorityKind).toBe("journal_source");
    expect(source?.authorityProjectionGeneration).toBeNull();
    expect(source?.accessNamespaceIds).toEqual([NAMESPACE_ID]);
    expect(await validatePostgresForegroundJournalRepairSource({
      product,
      source: source!,
      objectId: "stenographer/record/1",
    })).toBe(true);
  });
});
