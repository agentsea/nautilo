import { describe, expect, test } from "bun:test";

import {
  assertStenographerRecordPayloadBinding,
  buildStenographerRecordPublication,
  encodeDurableRecordEnvelope,
} from "../../src/server";

const base = Object.freeze({
  eventId: "0198f40a-5058-7000-8000-000000000001",
  roomId: "0198f40a-5058-7000-8000-000000000002",
  namespaceId: "0198f40a-5058-7000-8000-000000000003",
  kind: "decision" as const,
  statement: "The Room selected PostgreSQL.",
  sources: [{
    messageId: 41,
    editRevision: 3,
    observedContentFingerprint: "sha256:source-message-41-r3",
  }],
  sourceBatchId: "0198f40a-5058-7000-8000-000000000004",
  batchLocalOrdinal: 0,
  extractorVersion: "m219-v1",
  rebuildGeneration: 2,
  transition: { operation: "append" as const },
  publicationBindingRef: "binding:room-alpha-r7",
});

describe("Stenographer Record publication mapping", () => {
  test("preserves event identity and exact Message/Room authority", () => {
    const publication = buildStenographerRecordPublication(base);
    expect(publication.record.recordRef).toBe(base.eventId);
    expect(publication.record.structuralHeight).toBe(0);
    expect(publication.record.processingGeneration).toBe(3);
    expect(publication.record.semantic).toMatchObject({
      sourceOwnedKind: "journal_event:decision",
      observedLogicalObjectRef: base.eventId,
      observedRevision: "3",
      anchors: [{ kind: "room", anchorRef: base.roomId, role: "origin" }],
      terminalAuthorityLeafHandles: [base.namespaceId],
      sourceDependencies: [{
        sourceKind: "message",
        logicalSourceRef: "message:41",
        observedRevision: "3",
        observedContentFingerprint: "sha256:source-message-41-r3",
        terminalAuthorityLeafHandle: base.namespaceId,
        authorityBearing: true,
      }],
    });
    expect(publication.idempotencyKey).toBe(
      `journal:${base.sourceBatchId}:0`,
    );
  });

  test("is deterministic across source order and independent of repository mode", () => {
    const sourceTwo = {
      messageId: 43,
      editRevision: 0,
      observedContentFingerprint: "sha256:source-message-43-r0",
    };
    const left = buildStenographerRecordPublication({
      ...base,
      sources: [sourceTwo, ...base.sources],
    });
    const right = buildStenographerRecordPublication({
      ...base,
      sources: [...base.sources, sourceTwo],
    });
    expect(encodeDurableRecordEnvelope(left.record)).toEqual(
      encodeDurableRecordEnvelope(right.record),
    );
  });

  test("maps successor operations without changing the new Record lifecycle", () => {
    const publication = buildStenographerRecordPublication({
      ...base,
      transition: {
        operation: "resolve",
        predecessorEventId: "0198f40a-5058-7000-8000-000000000005",
      },
    });
    expect(publication.record.lifecycle).toBe("current");
    expect(publication.predecessor).toEqual({
      recordRef: "0198f40a-5058-7000-8000-000000000005",
      relation: "resolves",
    });
  });

  test("authenticates every source-owned coordinate on protected reopen", () => {
    const record = buildStenographerRecordPublication(base).record;
    const binding = {
      eventId: base.eventId,
      roomId: base.roomId,
      namespaceId: base.namespaceId,
      kind: base.kind,
      status: "active" as const,
      sourceMessageIds: [41],
      extractorVersion: base.extractorVersion,
      publicationGeneration: base.rebuildGeneration + 1,
    };
    expect(() => assertStenographerRecordPayloadBinding(record, binding))
      .not.toThrow();
    expect(() => assertStenographerRecordPayloadBinding(record, {
      ...binding,
      sourceMessageIds: [42],
    })).toThrow("payload binding is invalid");
    expect(() => assertStenographerRecordPayloadBinding({
      ...record,
      semantic: {
        ...record.semantic,
        anchors: [{ kind: "room", anchorRef: "substituted-room", role: "origin" }],
      },
    }, binding)).toThrow("payload binding is invalid");
  });

  test("accepts only current-to-terminal lifecycle lag during bounded legacy conversion", () => {
    const record = buildStenographerRecordPublication(base).record;
    const terminalBinding = {
      eventId: base.eventId,
      roomId: base.roomId,
      namespaceId: base.namespaceId,
      kind: base.kind,
      status: "resolved" as const,
      sourceMessageIds: [41],
      extractorVersion: base.extractorVersion,
      publicationGeneration: base.rebuildGeneration + 1,
    };
    expect(() => assertStenographerRecordPayloadBinding(
      record,
      terminalBinding,
    )).not.toThrow();
    expect(() => assertStenographerRecordPayloadBinding({
      ...record,
      lifecycle: "superseded",
    }, terminalBinding)).toThrow("payload binding is invalid");
  });

  test("accepts lifecycle processing after immutable publication generation", () => {
    const record = buildStenographerRecordPublication(base).record;
    const binding = {
      eventId: base.eventId,
      roomId: base.roomId,
      namespaceId: base.namespaceId,
      kind: base.kind,
      status: "resolved" as const,
      sourceMessageIds: [41],
      extractorVersion: base.extractorVersion,
    };

    expect(() => assertStenographerRecordPayloadBinding({
      ...record,
      lifecycle: "resolved",
      processingGeneration: record.processingGeneration + 1,
    }, binding)).not.toThrow();
    expect(() => assertStenographerRecordPayloadBinding({
      ...record,
      processingGeneration: record.processingGeneration - 1,
    }, binding)).toThrow("payload binding is invalid");
    expect(() => assertStenographerRecordPayloadBinding({
      ...record,
      semantic: {
        ...record.semantic,
        observedRevision: "03",
      },
    }, binding)).toThrow("payload binding is invalid");
  });
});
