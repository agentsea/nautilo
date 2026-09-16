import { describe, expect, test } from "bun:test";

import {
  attachProtectedStenographerRecordsWithinTransaction,
  buildStenographerRecordPublication,
  createHmacRecordSemanticCommitmentPort,
  createHmacProtectedStenographerRecordCommitmentPort,
  encodeDurableRecordEnvelope,
} from "../../src/server";
import type {
  ConversationProductDatabaseRow,
  ConversationProductPostgresExecutor,
  ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";

const event = {
  descriptorCommitment: new Uint8Array(32).fill(0x44),
  eventId: "0198f40a-5058-7000-8000-000000000002",
  objectId: "journal-record-object-2",
  sourceBatchId: "0198f40a-5058-7000-8000-000000000030",
  batchLocalOrdinal: 0,
};

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function attachmentEvent(input: Readonly<{
  eventId?: string;
  objectId?: string;
  messageId?: number;
  batchLocalOrdinal?: number;
}> = {}) {
  return {
    eventId: input.eventId ?? "0198f40a-5058-7000-8000-000000000002",
    objectId: input.objectId ?? "journal-record-object-2",
    sequence: (input.batchLocalOrdinal ?? 0) + 1,
    kind: "decision" as const,
    supersedesEventId: null,
    resolvesEventId: null,
    sourceMessageIds: [input.messageId ?? 41],
    sourceBatchId: "0198f40a-5058-7000-8000-000000000030",
    batchLocalOrdinal: input.batchLocalOrdinal ?? 0,
    extractorVersion: "stenographer-v2",
    createdAt: "2026-08-14T10:00:00.000Z",
    requestCommitment: new Uint8Array(32).fill(9),
  };
}

function ordinaryOutput(value: ReturnType<typeof attachmentEvent>) {
  const messageId = value.sourceMessageIds[0]!;
  const publication = buildStenographerRecordPublication({
    eventId: value.eventId,
    roomId: "0198f40a-5058-7000-8000-000000000010",
    namespaceId: "0198f40a-5058-7000-8000-000000000020",
    kind: value.kind,
    statement: `Decision from Message ${messageId}`,
    sources: [{
      messageId,
      editRevision: 0,
      observedContentFingerprint: `sha256:message-${messageId}`,
    }],
    sourceBatchId: value.sourceBatchId,
    batchLocalOrdinal: value.batchLocalOrdinal,
    extractorVersion: value.extractorVersion,
    rebuildGeneration: 0,
    transition: { operation: "append" },
    publicationBindingRef:
      "journal:namespace:0198f40a-5058-7000-8000-000000000020:protected:v1",
  });
  return {
    objectId: value.objectId,
    plaintext: encodeDurableRecordEnvelope(publication.record),
  };
}

function recordingTransaction(queries: Array<Readonly<{
  statement: string;
  parameters?: readonly ConversationProductPostgresScalar[];
}>>): ConversationProductPostgresExecutor {
  return {
    async query<Row extends ConversationProductDatabaseRow>(
      statement: string,
      parameters?: readonly ConversationProductPostgresScalar[],
    ) {
      queries.push({
        statement,
        ...(parameters === undefined ? {} : { parameters }),
      });
      if (normalizedSql(statement).includes("insert into room_events")) {
        const id = parameters?.find((parameter) =>
          typeof parameter === "string"
          && parameter.startsWith("0198f40a-5058-7000-8000-")
        );
        return [{ id, record_id: id }] as unknown as Row[];
      }
      return [];
    },
  };
}

describe("protected Stenographer Record attachment", () => {
  test("derives a stable content-free replay commitment from opaque coordinates", () => {
    const port = createHmacProtectedStenographerRecordCommitmentPort(
      new Uint8Array(32).fill(0x77),
    );
    const first = port.commit(event);
    const replay = port.commit(event);
    const differentObject = port.commit({
      ...event,
      objectId: "journal-record-object-3",
    });

    expect(first).toHaveLength(32);
    expect(replay).toEqual(first);
    expect(differentObject).not.toEqual(first);
    expect(first).not.toEqual(event.descriptorCommitment);
  });

  test("admits protected observations and opaque source dependencies atomically", async () => {
    const queries: Readonly<{
      statement: string;
      parameters?: readonly ConversationProductPostgresScalar[];
    }>[] = [];
    const eventId = "0198f40a-5058-7000-8000-000000000002";
    const transaction: ConversationProductPostgresExecutor = {
      async query<Row extends ConversationProductDatabaseRow>(
        statement: string,
        parameters?: readonly ConversationProductPostgresScalar[],
      ) {
        queries.push({
          statement,
          ...(parameters === undefined ? {} : { parameters }),
        });
        if (normalizedSql(statement).includes("insert into room_events")) {
          return [{ id: eventId, record_id: eventId }] as unknown as Row[];
        }
        return [];
      },
    };
    expect(await attachProtectedStenographerRecordsWithinTransaction(
      transaction,
      {
        roomId: "0198f40a-5058-7000-8000-000000000010",
        namespaceId: "0198f40a-5058-7000-8000-000000000020",
        rebuildGeneration: 0,
        events: [{
          eventId,
          objectId: "journal-record-object-2",
          sequence: 1,
          kind: "decision",
          supersedesEventId: null,
          resolvesEventId: null,
          sourceMessageIds: [41],
          sourceBatchId: "0198f40a-5058-7000-8000-000000000030",
          batchLocalOrdinal: 0,
          extractorVersion: "stenographer-v2",
          createdAt: "2026-08-14T10:00:00.000Z",
          requestCommitment: new Uint8Array(32).fill(9),
        }],
        statusUpdates: [],
        semanticCommitments: createHmacRecordSemanticCommitmentPort(
          new Uint8Array(32).fill(10),
        ),
      },
    )).toEqual({ status: "attached" });
    const sourceIndex = queries.find((query) =>
      query.statement.includes("reflection_record_source_dependency_index")
    );
    expect(sourceIndex?.parameters?.[0]).toBeInstanceOf(Uint8Array);
    expect((sourceIndex?.parameters?.[0] as Uint8Array).byteLength).toBe(32);
    expect(queries.some((query) =>
      query.statement.includes("reflection_record_semantic_work_admissions")
    )).toBeTrue();
    expect(queries.some((query) =>
      normalizedSql(query.statement).includes("insert into reflection_record_semantic_work")
    )).toBeTrue();
    const roomEvent = queries.find((query) =>
      normalizedSql(query.statement).includes("insert into room_events")
    );
    expect(roomEvent?.parameters).toContain("{41}");
    const closure = queries.find(query => normalizedSql(query.statement).includes("insert into reflection_record_authority_closure"));
    expect(closure?.parameters).toContain(eventId);
    expect(closure?.parameters).toContain("0198f40a-5058-7000-8000-000000000020");
    expect(queries.some(query => normalizedSql(query.statement).includes("insert into reflection_record_authority_projections"))).toBeTrue();
  });

  test("attaches the exact canonical ordinary sibling without mutating borrowed bytes", async () => {
    const queries: Array<Readonly<{
      statement: string;
      parameters?: readonly ConversationProductPostgresScalar[];
    }>> = [];
    const attachedEvent = attachmentEvent();
    const output = ordinaryOutput(attachedEvent);
    const before = output.plaintext.slice();

    expect(await attachProtectedStenographerRecordsWithinTransaction(
      recordingTransaction(queries),
      {
        roomId: "0198f40a-5058-7000-8000-000000000010",
        namespaceId: "0198f40a-5058-7000-8000-000000000020",
        rebuildGeneration: 0,
        events: [attachedEvent],
        statusUpdates: [],
        ordinaryOutputs: [output],
      },
    )).toEqual({ status: "attached" });
    expect(output.plaintext).toEqual(before);
    const representations = queries.filter((query) =>
      normalizedSql(query.statement).includes(
        "insert into reflection_record_payload_representations",
      )
    );
    expect(representations).toHaveLength(2);
    expect(representations.some((query) =>
      query.parameters?.some((parameter) =>
        parameter instanceof Uint8Array
        && parameter.byteLength === before.byteLength
        && parameter.every((byte, index) => byte === before[index])
      )
    )).toBeTrue();
    const receipts = queries.filter((query) =>
      normalizedSql(query.statement).includes(
        "insert into reflection_record_publications",
      )
    );
    expect(receipts).toHaveLength(2);
    const ordinaryReceipt = receipts.find((query) =>
      query.parameters?.includes("ordinary")
    );
    const protectedReceipt = receipts.find((query) =>
      query.parameters?.includes("protected")
    );
    expect(ordinaryReceipt?.parameters).toEqual([
      `journal:${attachedEvent.sourceBatchId}:${attachedEvent.batchLocalOrdinal}:ordinary`,
      attachedEvent.eventId,
      "ordinary",
      1,
      1,
      attachedEvent.requestCommitment,
      "journal:namespace:0198f40a-5058-7000-8000-000000000020:ordinary:v1",
      null,
      "complete",
      0,
      attachedEvent.createdAt,
      attachedEvent.createdAt,
      attachedEvent.createdAt,
      attachedEvent.createdAt,
    ]);
    expect(protectedReceipt?.parameters).toEqual([
      `journal:${attachedEvent.sourceBatchId}:${attachedEvent.batchLocalOrdinal}`,
      attachedEvent.eventId,
      "protected",
      1,
      1,
      attachedEvent.requestCommitment,
      "journal:namespace:0198f40a-5058-7000-8000-000000000020:protected:v1",
      attachedEvent.objectId,
      "complete",
      0,
      attachedEvent.createdAt,
      attachedEvent.createdAt,
      attachedEvent.createdAt,
      attachedEvent.createdAt,
      attachedEvent.createdAt,
    ]);
  });

  test("rejects missing, swapped, and malformed ordinary outputs before SQL", async () => {
    const first = attachmentEvent();
    const second = attachmentEvent({
      eventId: "0198f40a-5058-7000-8000-000000000003",
      objectId: "journal-record-object-3",
      messageId: 42,
      batchLocalOrdinal: 1,
    });
    const base = {
      roomId: "0198f40a-5058-7000-8000-000000000010",
      namespaceId: "0198f40a-5058-7000-8000-000000000020",
      rebuildGeneration: 0,
      events: [first, second],
      statusUpdates: [],
    } as const;
    for (const ordinaryOutputs of [
      [ordinaryOutput(first)],
      [ordinaryOutput(second), ordinaryOutput(first)],
      [ordinaryOutput(first), {
        objectId: second.objectId,
        plaintext: new Uint8Array([0xff]),
      }],
    ]) {
      const queries: Array<Readonly<{ statement: string }>> = [];
      let rejected = false;
      try {
        await attachProtectedStenographerRecordsWithinTransaction(
          recordingTransaction(queries),
          { ...base, ordinaryOutputs },
        );
      } catch (error) {
        rejected = true;
        expect(error).toBeInstanceOf(Error);
      }
      expect(rejected).toBeTrue();
      expect(queries).toHaveLength(0);
    }
  });

  test("performs no ordinary writes when sibling outputs are absent", async () => {
    const queries: Array<Readonly<{
      statement: string;
      parameters?: readonly ConversationProductPostgresScalar[];
    }>> = [];
    expect(await attachProtectedStenographerRecordsWithinTransaction(
      recordingTransaction(queries),
      {
        roomId: "0198f40a-5058-7000-8000-000000000010",
        namespaceId: "0198f40a-5058-7000-8000-000000000020",
        rebuildGeneration: 0,
        events: [attachmentEvent()],
        statusUpdates: [],
      },
    )).toEqual({ status: "attached" });
    expect(queries.filter((query) =>
      normalizedSql(query.statement).includes(
        "insert into reflection_record_payload_representations",
      )
    )).toHaveLength(1);
    const receipts = queries.filter((query) =>
      normalizedSql(query.statement).includes(
        "insert into reflection_record_publications",
      )
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.parameters).toContain("protected");
    expect(receipts[0]?.parameters).not.toContain("ordinary");
    expect(receipts[0]?.parameters).toContain(
      `journal:${event.sourceBatchId}:${event.batchLocalOrdinal}`,
    );
  });
});
