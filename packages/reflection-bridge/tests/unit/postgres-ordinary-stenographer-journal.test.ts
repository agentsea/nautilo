import { describe, expect, test } from "bun:test";

import {
  buildStenographerRecordPublication,
  encodeDurableRecordEnvelope,
  readOrdinaryStenographerJournalEvents,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
} from "../../src/server";

describe("ordinary mixed Stenographer Journal reader", () => {
  test("returns legacy and native statements once in Room sequence", async () => {
    const publication = buildStenographerRecordPublication({
      eventId: "0198f40a-5058-7000-8000-000000000002",
      roomId: "0198f40a-5058-7000-8000-000000000010",
      namespaceId: "0198f40a-5058-7000-8000-000000000020",
      kind: "fact",
      statement: "The native observation.",
      sources: [{
        messageId: 2,
        editRevision: 0,
        observedContentFingerprint: "sha256:source",
      }],
      sourceBatchId: "0198f40a-5058-7000-8000-000000000030",
      batchLocalOrdinal: 0,
      extractorVersion: "m219-v1",
      rebuildGeneration: 0,
      transition: { operation: "append" },
      publicationBindingRef: "binding",
    });
    const executor: RecordProductPostgresExecutor = {
      query: <Row extends RecordProductPostgresRow>() => Promise.resolve([
        {
          id: "0198f40a-5058-7000-8000-000000000001",
          room_id: "0198f40a-5058-7000-8000-000000000010",
          sequence: 1,
          kind: "decision",
          statement: "The legacy observation.",
          status: "active",
          supersedes_event_id: null,
          resolves_event_id: null,
          source_message_ids: [1],
          extractor_version: "m219-v1",
          projection_kind: "legacy",
          record_id: null,
          namespace_id: "0198f40a-5058-7000-8000-000000000020",
          record_lifecycle: null,
          structural_height: null,
          processing_generation: null,
          plaintext_payload_bytes: null,
        },
        {
          id: publication.record.recordRef,
          room_id: "0198f40a-5058-7000-8000-000000000010",
          sequence: 2,
          kind: "fact",
          statement: null,
          status: "active",
          supersedes_event_id: null,
          resolves_event_id: null,
          source_message_ids: [2],
          extractor_version: "m219-v1",
          projection_kind: "native",
          record_id: publication.record.recordRef,
          namespace_id: "0198f40a-5058-7000-8000-000000000020",
          record_lifecycle: "current",
          structural_height: 0,
          processing_generation: 1,
          plaintext_payload_bytes: encodeDurableRecordEnvelope(publication.record),
        },
      ] as unknown as readonly Row[]),
    };

    const events = await readOrdinaryStenographerJournalEvents(executor, {
      roomId: "0198f40a-5058-7000-8000-000000000010",
    });
    expect(events.map((event) => event.statement)).toEqual([
      "The legacy observation.",
      "The native observation.",
    ]);
  });

  test("opens a terminal native event after its processing generation advances", async () => {
    const publication = buildStenographerRecordPublication({
      eventId: "0198f40a-5058-7000-8000-000000000012",
      roomId: "0198f40a-5058-7000-8000-000000000010",
      namespaceId: "0198f40a-5058-7000-8000-000000000020",
      kind: "fact",
      statement: "The historical observation.",
      sources: [{
        messageId: 2,
        editRevision: 0,
        observedContentFingerprint: "sha256:source",
      }],
      sourceBatchId: "0198f40a-5058-7000-8000-000000000030",
      batchLocalOrdinal: 0,
      extractorVersion: "m219-v1",
      rebuildGeneration: 0,
      transition: { operation: "append" },
      publicationBindingRef: "binding",
    });
    const executor: RecordProductPostgresExecutor = {
      query: <Row extends RecordProductPostgresRow>() => Promise.resolve([{
        id: publication.record.recordRef,
        room_id: "0198f40a-5058-7000-8000-000000000010",
        sequence: 2,
        kind: "fact",
        statement: null,
        status: "resolved",
        supersedes_event_id: null,
        resolves_event_id: null,
        source_message_ids: [2],
        extractor_version: "m219-v1",
        projection_kind: "native",
        record_id: publication.record.recordRef,
        namespace_id: "0198f40a-5058-7000-8000-000000000020",
        record_lifecycle: "resolved",
        structural_height: 0,
        processing_generation: 2,
        plaintext_payload_bytes: encodeDurableRecordEnvelope(publication.record),
      }] as unknown as readonly Row[]),
    };

    const events = await readOrdinaryStenographerJournalEvents(executor, {
      roomId: "0198f40a-5058-7000-8000-000000000010",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.statement).toBe("The historical observation.");
  });

  test("rejects a native payload substituted from another Room binding", async () => {
    const publication = buildStenographerRecordPublication({
      eventId: "0198f40a-5058-7000-8000-000000000002",
      roomId: "0198f40a-5058-7000-8000-000000000099",
      namespaceId: "0198f40a-5058-7000-8000-000000000020",
      kind: "fact",
      statement: "Substituted observation.",
      sources: [{
        messageId: 2,
        editRevision: 0,
        observedContentFingerprint: "sha256:source",
      }],
      sourceBatchId: "0198f40a-5058-7000-8000-000000000030",
      batchLocalOrdinal: 0,
      extractorVersion: "m219-v1",
      rebuildGeneration: 0,
      transition: { operation: "append" },
      publicationBindingRef: "binding",
    });
    const executor: RecordProductPostgresExecutor = {
      query: <Row extends RecordProductPostgresRow>() => Promise.resolve([{
        id: publication.record.recordRef,
        room_id: "0198f40a-5058-7000-8000-000000000010",
        sequence: 2,
        kind: "fact",
        statement: null,
        status: "active",
        supersedes_event_id: null,
        resolves_event_id: null,
        source_message_ids: [2],
        extractor_version: "m219-v1",
        projection_kind: "native",
        record_id: publication.record.recordRef,
        namespace_id: "0198f40a-5058-7000-8000-000000000020",
        record_lifecycle: "current",
        structural_height: 0,
        processing_generation: 1,
        plaintext_payload_bytes: encodeDurableRecordEnvelope(publication.record),
      }] as unknown as readonly Row[]),
    };

    let failure: unknown;
    try {
      await readOrdinaryStenographerJournalEvents(executor, {
        roomId: "0198f40a-5058-7000-8000-000000000010",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe(
      "Stenographer Record payload binding is invalid",
    );
  });
});
