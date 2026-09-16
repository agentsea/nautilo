import { describe, expect, test } from "bun:test";
import { stenographerOrdinaryOutputFingerprint } from "@nautilo/lattice-bridge";

import {
  PostgresOrdinaryStenographerRecordPublisher,
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
} from "../../src/server";

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function assignedParameter(
  statement: string,
  parameters: readonly unknown[],
  column: string,
): unknown {
  const match = normalizedSql(statement).match(
    new RegExp(`${column} = \\$([0-9]+)`, "u"),
  );
  expect(match, `${column} assignment`).not.toBeNull();
  return parameters[Number(match![1]) - 1];
}

describe("ordinary Stenographer native-Record publisher", () => {
  test.each(["date", "timestamp-string"])("commits fallback provenance from physical PostgreSQL output columns (%s)", async timestampShape => {
    const statements: string[] = [];
    const parametersByStatement = new Map<string, readonly unknown[]>();
    let transactionCount = 0;
    const execute = async <Row extends RecordProductPostgresRow>(
      statement: string,
      parameters: readonly unknown[] = [],
    ): Promise<readonly Row[]> => {
      statements.push(statement);
      parametersByStatement.set(statement, parameters);
      if (statement.includes("FROM room_journal_state state")) {
        return [{
          lease_token: "0198f40a-5058-7000-8000-000000000010",
          suspended_at: null,
          rebuild_generation: 0,
          namespace_id: "0198f40a-5058-7000-8000-000000000003",
          has_agent: true,
        }] as unknown as readonly Row[];
      }
      if (statement.includes("FROM sessions session") && statement.includes("message.edit_revision")) {
        return [{
          id: 41,
          edit_revision: 0,
          fingerprint: "message-fingerprint",
          content: "We selected PostgreSQL.",
        }] as unknown as readonly Row[];
      }
      if (statement.includes("maximum_sequence")) {
        return [{ maximum_sequence: 0 }] as unknown as readonly Row[];
      }
      if (statement.includes("gen_random_uuid")) {
        return [{
          event_id: "0198f40a-5058-7000-8000-000000000001",
        }] as unknown as readonly Row[];
      }
      if (
        normalizedSql(statement).includes("plaintext_payload_bytes")
        && normalizedSql(statement).includes(
          "reflection_record_payload_representations",
        )
      ) {
        return [{
          // Compiled offline queries return physical SQL column names; a
          // Drizzle selection-object key does not alias the PostgreSQL result.
          id: "0198f40a-5058-7000-8000-000000000001",
          created_at: timestampShape === "date" ? new Date("2026-08-14T10:00:00.000Z") : "2026-08-14 10:00:00+00",
          plaintext_payload_bytes: new Uint8Array([0x91, 0x92, 0x93]),
        }] as unknown as readonly Row[];
      }
      if (normalizedSql(statement).includes("update room_journal_batches")) {
        return [{
          id: "0198f40a-5058-7000-8000-000000000004",
        }] as unknown as readonly Row[];
      }
      return [];
    };
    const transactionExecutor: RecordProductPostgresExecutor = {
      query: execute,
    };
    const connection: RecordProductPostgresConnection = {
      query: <Row extends RecordProductPostgresRow>(statement: string) => {
        if (statement.startsWith("SELECT current_user")) {
          return Promise.resolve([{
            current_role: "nautilo",
            session_role: "nautilo",
          }] as unknown as readonly Row[]);
        }
        return execute<Row>(statement);
      },
      transaction: async (callback) => {
        transactionCount += 1;
        return callback(transactionExecutor);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const publisher = new PostgresOrdinaryStenographerRecordPublisher({
      handle,
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 7 },
      commitment: { commit: () => new Uint8Array(32).fill(0x42) },
    });

    expect(await publisher.publishExtraction({
      claim: {
        batchId: "0198f40a-5058-7000-8000-000000000004",
        roomId: "0198f40a-5058-7000-8000-000000000002",
        leaseToken: "0198f40a-5058-7000-8000-000000000010",
        lane: "live",
        fromMessageIdExclusive: 40,
        throughMessageIdInclusive: 41,
        rebuildGeneration: null,
      },
      transition: {
        statusUpdates: [],
        inserts: [{
          batchLocalOrdinal: 0,
          sequence: 1,
          kind: "decision",
          statement: "The Room selected PostgreSQL.",
          sourceMessageIds: [41],
          status: "active",
          supersedesEventId: null,
          resolvesEventId: null,
        }],
        foldedBatchLocalOrdinals: [],
        nextSequence: 2,
      },
      operationCount: 1,
      modelId: "openai:test-model",
      extractorVersion: "m219-v1",
      now: new Date("2026-08-14T10:00:00.000Z"),
      ordinaryFallbackReason: "device",
    })).toEqual({ published: true, eventsWritten: 1 });

    expect(transactionCount).toBe(1);
    expect(statements.some((statement) =>
      statement.includes("nautilo.stenographer_writer_version")
    )).toBeTrue();
    expect(statements.some((statement) =>
      normalizedSql(statement).includes("insert into reflection_records")
    )).toBeTrue();
    const projection = normalizedSql(statements.find((statement) =>
      normalizedSql(statement).includes("insert into room_events")
    ) ?? "");
    expect(projection).toContain("id, room_id, sequence, kind, statement, status");
    expect(projection).toContain("projection_kind, record_id, crypto_object_id");
    expect(statements.some((statement) =>
      normalizedSql(statement).includes("insert into room_journal_record_cutover")
    )).toBeTrue();
    expect(normalizedSql(statements.find((statement) =>
      normalizedSql(statement).includes("update room_journal_batches")
    ) ?? "")).toContain("observation_publication_version");
    const batchUpdate = statements.find((statement) =>
      normalizedSql(statement).includes("update room_journal_batches")
    )!;
    const batchParameters = parametersByStatement.get(batchUpdate)!;
    expect(assignedParameter(
      batchUpdate,
      batchParameters,
      "ordinary_fallback_reason",
    )).toBe("device");
    expect(assignedParameter(
      batchUpdate,
      batchParameters,
      "ordinary_fallback_rebuild_generation",
    )).toBe(0);
    expect(assignedParameter(
      batchUpdate,
      batchParameters,
      "ordinary_output_fingerprint",
    )).toEqual(stenographerOrdinaryOutputFingerprint({
      kind: "extraction",
      receiptId: "0198f40a-5058-7000-8000-000000000004",
      roomId: "0198f40a-5058-7000-8000-000000000002",
      namespaceId: "0198f40a-5058-7000-8000-000000000003",
      rebuildGeneration: 0,
      fallbackReason: "device",
      outputs: [{
        logicalId: "0198f40a-5058-7000-8000-000000000001",
        objectType: "nautilo.reflection.record.v1",
        createdAt: new Date("2026-08-14T10:00:00.000Z").getTime(),
        payloadBytes: new Uint8Array([0x91, 0x92, 0x93]),
      }],
    }));
    const cursorUpdate = statements.find((statement) =>
      statement.includes("FROM uncompacted work")
    );
    expect(cursorUpdate).toBeDefined();
    expect(parametersByStatement.get(cursorUpdate!)).toHaveLength(6);
    expect(cursorUpdate).toContain("$6");
    expect(cursorUpdate).not.toMatch(/\$[7-9]/);
  });

  test("refuses protected selection instead of silently writing plaintext", async () => {
    const handle = await verifyRecordProductPostgresHandle({
      query: <Row extends RecordProductPostgresRow>() => Promise.resolve([{
        current_role: "nautilo",
        session_role: "nautilo",
      }] as unknown as readonly Row[]),
      transaction: () => Promise.reject(new Error("not reached")),
    });
    expect(() => new PostgresOrdinaryStenographerRecordPublisher({
      handle,
      selection: { selectedRepresentation: "protected", migrationGeneration: 2 },
      commitment: { commit: () => new Uint8Array(32) },
    })).toThrow("canonical ordinary selection");
  });

  test("converts one bounded legacy page without invoking a model", async () => {
    const statements: string[] = [];
    const eventId = "0198f40a-5058-7000-8000-000000000001";
    const execute = async <Row extends RecordProductPostgresRow>(
      statement: string,
    ): Promise<readonly Row[]> => {
      statements.push(statement);
      if (statement.includes("state.record_conversion_status = 'pending'")) {
        return [{
          room_id: "0198f40a-5058-7000-8000-000000000002",
          rebuild_generation: 0,
          record_conversion_failure_count: 0,
          namespace_id: "0198f40a-5058-7000-8000-000000000003",
        }] as unknown as readonly Row[];
      }
      if (statement.includes("ORDER BY sequence, id")) {
        return [{ id: eventId }] as unknown as readonly Row[];
      }
      if (statement.includes("FROM room_events event") && statement.includes("event.statement")) {
        return [{
          id: eventId,
          kind: "decision",
          statement: "We selected PostgreSQL.",
          source_message_ids: [41],
          source_batch_id: "0198f40a-5058-7000-8000-000000000004",
          batch_local_ordinal: 0,
          extractor_version: "m219-v1",
          projection_kind: "legacy",
          crypto_object_id: null,
          supersedes_event_id: null,
          resolves_event_id: null,
          created_at: new Date("2026-08-14T10:00:00.000Z"),
        }] as unknown as readonly Row[];
      }
      if (statement.includes("FROM sessions session") && statement.includes("message.edit_revision")) {
        return [{
          id: 41,
          edit_revision: 0,
          fingerprint: "message-fingerprint",
          content: "We selected PostgreSQL.",
        }] as unknown as readonly Row[];
      }
      if (
        normalizedSql(statement).includes("update room_events")
        && normalizedSql(statement).includes("returning id")
      ) {
        return [{ id: eventId }] as unknown as readonly Row[];
      }
      if (normalizedSql(statement).includes("as has_remaining")) {
        return [{ has_remaining: false, converted_through: 1 }] as unknown as readonly Row[];
      }
      return [];
    };
    const connection: RecordProductPostgresConnection = {
      query: <Row extends RecordProductPostgresRow>(statement: string) =>
        statement.startsWith("SELECT current_user")
          ? Promise.resolve([{
              current_role: "nautilo",
              session_role: "nautilo",
            }] as unknown as readonly Row[])
          : execute<Row>(statement),
      transaction: (callback) => callback({ query: execute }),
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const publisher = new PostgresOrdinaryStenographerRecordPublisher({
      handle,
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      commitment: { commit: () => new Uint8Array(32).fill(0x42) },
    });

    expect(await publisher.convertNextLegacyPage({ limit: 20 })).toEqual({
      roomId: "0198f40a-5058-7000-8000-000000000002",
      converted: 1,
      completedRoom: true,
    });
    expect(statements.some((statement) =>
      normalizedSql(statement).includes("insert into reflection_records")
    )).toBeTrue();
    expect(statements.some((statement) =>
      normalizedSql(statement).includes("update room_events")
        && normalizedSql(statement).includes("returning id")
    )).toBeTrue();
  });
});
