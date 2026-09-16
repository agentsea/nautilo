import { describe, expect, test } from "bun:test";
import { encodeRoomEventPayloadV1 } from "@nautilo/lattice-bridge";

import {
  PostgresProtectedLegacyStenographerConverter,
  type ProtectedLegacyStenographerAuthorityPort,
} from "../../src/server/postgres-protected-stenographer-converter";
import {
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
  type RecordProductPostgresScalar,
} from "../../src/server/product-postgres";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000002";
const EVENT_ID = "10000000-0000-4000-8000-000000000003";
const BATCH_ID = "10000000-0000-4000-8000-000000000004";
const LEASE_TOKEN = "10000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-08-14T10:00:00.000Z");

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

class ScriptedConnection implements RecordProductPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: readonly RecordProductPostgresScalar[][] = [];
  readonly #results: Array<readonly RecordProductPostgresRow[]>;

  constructor(results: readonly (readonly RecordProductPostgresRow[])[]) {
    this.#results = [...results];
  }

  query<Row extends RecordProductPostgresRow>(
    statement: string,
    parameters: readonly RecordProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    (this.parameters as RecordProductPostgresScalar[][]).push([...parameters]);
    return Promise.resolve((this.#results.shift() ?? []) as readonly Row[]);
  }

  transaction<Result>(
    callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

function claimRows(): readonly (readonly RecordProductPostgresRow[])[] {
  return [
    [],
    [{
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      rebuild_generation: 2,
      record_conversion_failure_count: 0,
    }],
    [{
      event_id: EVENT_ID,
      crypto_object_id: "legacy-journal-event-1",
      sequence: 1,
      kind: "decision",
      status: "active",
      supersedes_event_id: null,
      resolves_event_id: null,
      source_message_ids: [11],
      source_batch_id: BATCH_ID,
      batch_local_ordinal: 0,
      extractor_version: "m241-v1",
      created_at: NOW,
      predecessor_projection_kind: null,
    }],
    [{
      id: 11,
      edit_revision: 0,
      fingerprint: "message-fingerprint",
      crypto_object_id: "conversation-message-11",
    }],
    [{ room_id: ROOM_ID }],
  ];
}

async function setup(
  results: readonly (readonly RecordProductPostgresRow[])[],
  authority: ProtectedLegacyStenographerAuthorityPort,
) {
  const connection = new ScriptedConnection([
    [{ current_role: "nautilo", session_role: "nautilo" }],
    ...results,
  ]);
  const handle = await verifyRecordProductPostgresHandle(connection);
  return {
    connection,
    converter: new PostgresProtectedLegacyStenographerConverter({
      handle,
      authority,
      selection: {
        selectedRepresentation: "protected",
        migrationGeneration: 7,
      },
      leaseToken: () => LEASE_TOKEN,
    }),
  };
}

describe("protected legacy Stenographer conversion", () => {
  test("opens through authority, builds canonical Record bytes, then verifies and attaches", async () => {
    let transformed = false;
    const authority: ProtectedLegacyStenographerAuthorityPort = {
      async publishConvertedRecord(input) {
        const result = input.transform(encodeRoomEventPayloadV1({
          eventId: EVENT_ID,
          roomId: ROOM_ID,
          namespaceId: NAMESPACE_ID,
          sequence: 1,
          kind: "decision",
          statement: "Keep the exact protected statement.",
          supersedesEventId: null,
          resolvesEventId: null,
          sourceMessageIds: [11],
          sourceBatchId: BATCH_ID,
          batchLocalOrdinal: 0,
          extractorVersion: "m241-v1",
          createdAt: NOW.toISOString(),
        }));
        transformed = true;
        expect(input.recordId).toBe(EVENT_ID);
        expect(result.publication.record.recordRef).toBe(EVENT_ID);
        expect(result.publication.record.semantic.statement)
          .toBe("Keep the exact protected statement.");
        expect(result.publication.publicationBindingRef)
          .toBe(`journal:namespace:${NAMESPACE_ID}:protected:v7`);
        expect(result.canonicalRecordPayloadBytes.byteLength).toBeGreaterThan(0);
        return { status: "published" };
      },
    };
    const state = await setup([
      ...claimRows(),
      [],
      [{ record_id: EVENT_ID }],
      [{ id: EVENT_ID }],
      [],
      [{ room_id: ROOM_ID }],
    ], authority);

    expect(await state.converter.convertNextLegacyEvent({ now: NOW })).toEqual({
      roomId: ROOM_ID,
      converted: 1,
      pendingAuthority: false,
    });
    expect(transformed).toBe(true);
    expect(state.connection.statements.some((statement) =>
      statement.includes("representation = 'protected'")
      && statement.includes("publication.state = 'complete'")
    )).toBe(true);
    const attachmentIndex = state.connection.statements.findIndex((statement) => {
      const normalized = normalizedSql(statement);
      return normalized.startsWith("update room_events")
        && normalized.includes("projection_kind")
        && normalized.includes("crypto_object_id");
    });
    expect(attachmentIndex).toBeGreaterThan(-1);
    expect(state.connection.parameters[attachmentIndex]).toContain("native");
    expect(state.connection.parameters[attachmentIndex]).toContain(null);
    expect(state.connection.statements.join("\n"))
      .not.toContain("Keep the exact protected statement.");
  });

  test("keeps the legacy mapping readable and backs off without authority", async () => {
    const authority: ProtectedLegacyStenographerAuthorityPort = {
      publishConvertedRecord: () => Promise.resolve({
        status: "authorization_unavailable",
      }),
    };
    const state = await setup([
      ...claimRows(),
      [{ room_id: ROOM_ID }],
    ], authority);

    expect(await state.converter.convertNextLegacyEvent({ now: NOW })).toEqual({
      roomId: ROOM_ID,
      converted: 0,
      pendingAuthority: true,
    });
    expect(state.connection.statements.some((statement) =>
      statement.includes("record_conversion_last_error_code")
    )).toBe(true);
    expect(state.connection.statements.some((statement) => {
      const normalized = normalizedSql(statement);
      return normalized.startsWith("update room_events")
        && normalized.includes("projection_kind");
    })).toBe(false);
    const failureStatement = state.connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("record_conversion_last_error_code")
    );
    expect(state.connection.parameters[failureStatement]?.[0])
      .toEqual("2026-08-14T10:00:30.000Z");
  });
});
