import { describe, expect, test } from "bun:test";
import type {
  ProtectedJournalProductReadAuthorization,
  ProtectedJournalProductRecord,
} from "@nautilo/lattice-bridge";
import {
  createPostgresProtectedJournalProductReadPort,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
  type ResolveProtectedJournalProductReadAuthorization,
} from "@nautilo/lattice-bridge/server";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "domain-room-current";
const BATCH_ID = "30000000-0000-4000-8000-000000000001";
const ROLLUP_ID = "40000000-0000-4000-8000-000000000001";
const authorization =
  Object.freeze({}) as ProtectedJournalProductReadAuthorization;

type Query = Readonly<{
  readonly statement: string;
  readonly parameters: readonly ConversationProductPostgresScalar[];
}>;

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly queries: Query[] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  readonly #results: Array<readonly unknown[] | Error>;

  constructor(results: readonly (readonly unknown[] | Error)[]) {
    this.#results = [...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    const result = this.#results.shift();
    if (result === undefined) {
      return Promise.reject(new Error(`Unexpected SQL: ${statement}`));
    }
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result as readonly Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    this.isolationLevels.push(options.isolationLevel);
    return callback(this);
  }
}

function authority(
  overrides: Partial<Awaited<ReturnType<
    ResolveProtectedJournalProductReadAuthorization
  >>> = {},
): ResolveProtectedJournalProductReadAuthorization {
  return async () => ({
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    expectedAccessRevision: 7,
    expectedPolicyRevision: 11,
    ...overrides,
  });
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    room_id: ROOM_ID,
    namespace_id: NAMESPACE_ID,
    rebuild_generation: 3,
    ...overrides,
  };
}

function rollup(overrides: Record<string, unknown> = {}) {
  return {
    rollup_id: ROLLUP_ID,
    crypto_object_id: "journal/rollup/current",
    room_id: ROOM_ID,
    namespace_id: NAMESPACE_ID,
    through_event_sequence: 8,
    source_event_count: 8,
    model_id: "compact-model",
    compactor_version: "m241-v1",
    created_at: "2026-08-04T13:00:00.000Z",
    ...overrides,
  };
}

function event(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    event_id:
      `50000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    crypto_object_id: `journal/event/${sequence}`,
    room_id: ROOM_ID,
    namespace_id: NAMESPACE_ID,
    sequence,
    kind: "fact",
    status: "active",
    supersedes_event_id: null,
    resolves_event_id: null,
    source_message_ids_csv: String(sequence),
    source_batch_id: BATCH_ID,
    batch_local_ordinal: sequence - 9,
    extractor_version: "m241-v1",
    projection_kind: "legacy",
    record_lifecycle: null,
    record_structural_height: null,
    record_processing_generation: null,
    created_at: "2026-08-04T13:00:00.000Z",
    ...overrides,
  };
}

function expectedEvent(sequence: number): Extract<
  ProtectedJournalProductRecord,
  Readonly<{ readonly kind: "event" }>
> {
  return {
    kind: "event" as const,
    cryptoObjectId: `journal/event/${sequence}`,
    rebuildGeneration: 3,
    status: "active" as const,
    binding: {
      eventId:
        `50000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sequence,
      kind: "fact" as const,
      supersedesEventId: null,
      resolvesEventId: null,
      sourceMessageIds: [sequence],
      sourceBatchId: BATCH_ID,
      batchLocalOrdinal: sequence - 9,
      extractorVersion: "m241-v1",
      createdAt: "2026-08-04T13:00:00.000Z",
    },
  };
}

async function subject(input: {
  readonly rows: readonly (readonly unknown[] | Error)[];
  readonly authorize?: ResolveProtectedJournalProductReadAuthorization;
}) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }],
    ...input.rows,
  ]);
  const handle = await verifyConversationProductPostgresHandle(connection);
  return {
    connection,
    port: createPostgresProtectedJournalProductReadPort({
      product: handle,
      authorize: input.authorize ?? authority(),
    }),
  };
}

describe("Postgres protected journal product reads", () => {
  test("selects native events only through their protected Record head", async () => {
    const postgres = await subject({
      rows: [[state()], [rollup()], [event(9, {
        crypto_object_id: "record/event/9",
        projection_kind: "native",
        record_lifecycle: "current",
        record_structural_height: 0,
        record_processing_generation: 4,
      })]],
    });

    const batch = await postgres.port.readCurrent({
      authorization,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      maximumEvents: 1,
    });

    expect(batch?.events).toEqual([{
      ...expectedEvent(9),
      cryptoObjectId: "record/event/9",
      payloadFormat: "record_v1",
      recordMetadata: {
        lifecycle: "current",
        structuralHeight: 0,
        processingGeneration: 4,
      },
    }]);
    const eventQuery = postgres.connection.queries.at(-1)?.statement ?? "";
    expect(eventQuery).toContain(
      "COALESCE(event.crypto_object_id, representation.crypto_object_id)",
    );
    expect(eventQuery).toContain("head.representation = 'protected'");
    expect(eventQuery).not.toContain("plaintext_payload_bytes");
  });

  test("returns the exact current mapped rollup and bounded ordered event bindings without plaintext projection", async () => {
    const postgres = await subject({
      rows: [[state()], [rollup()], [event(9), event(10)]],
    });

    const batch = await postgres.port.readCurrent({
      authorization,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      maximumEvents: 2,
    });

    expect(batch).toEqual({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      rebuildGeneration: 3,
      expectedAccessRevision: 7,
      expectedPolicyRevision: 11,
      rollup: {
        kind: "rollup",
        cryptoObjectId: "journal/rollup/current",
        rebuildGeneration: 3,
        binding: {
          rollupId: ROLLUP_ID,
          roomId: ROOM_ID,
          namespaceId: NAMESPACE_ID,
          throughEventSequence: 8,
          sourceEventCount: 8,
          modelId: "compact-model",
          compactorVersion: "m241-v1",
          createdAt: "2026-08-04T13:00:00.000Z",
        },
      },
      events: [expectedEvent(9), expectedEvent(10)],
    });
    expect(postgres.connection.isolationLevels).toEqual(["serializable"]);
    const statements = postgres.connection.queries.slice(1).map(
      (query) => query.statement,
    );
    for (const statement of statements) {
      expect(statement).not.toMatch(
        /\b(statement|content|ciphertext|manifest|envelope|key_material)\b/iu,
      );
    }
    expect(statements[0]).toContain("rebuild_requested_at IS NULL");
    expect(statements[1]).toContain("crypto_object_id IS NOT NULL");
    expect(statements[2]).toContain("crypto_object_id IS NOT NULL");
    expect(statements[2]).toContain("LIMIT $3::integer");
  });

  test("fails closed before SQL when opaque authorization is denied or substituted", async () => {
    const denied = await subject({
      rows: [],
      authorize: async () => null,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matcher
    await expect(denied.port.readCurrent({
      authorization,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      maximumEvents: 10,
    })).rejects.toThrow("authorization");
    expect(denied.connection.queries).toHaveLength(1);

    const substituted = await subject({
      rows: [],
      authorize: authority({
        namespaceId: "20000000-0000-4000-8000-000000000099",
      }),
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matcher
    await expect(substituted.port.readCurrent({
      authorization,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      maximumEvents: 10,
    })).rejects.toThrow("authorization");
    expect(substituted.connection.queries).toHaveLength(1);
  });

  test("rejects row-coordinate substitution, duplicate identities, gaps, and results exceeding the requested bound", async () => {
    const cases: readonly (readonly unknown[])[] = [
      [event(9, {
        room_id: "10000000-0000-4000-8000-000000000099",
      })],
      [
        event(9),
        event(10, { crypto_object_id: "journal/event/9" }),
      ],
      [event(10)],
      [event(9), event(10)],
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const postgres = await subject({
        rows: [[state()], [rollup()], cases[index]!],
      });
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matcher
      await expect(postgres.port.readCurrent({
        authorization,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        maximumEvents: index === cases.length - 1 ? 1 : 2,
      })).rejects.toThrow();
    }
  });

  test("returns null when no current non-rebuilding journal state exists and rejects an unverified handle", async () => {
    const absent = await subject({ rows: [[]] });
    expect(await absent.port.readCurrent({
      authorization,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      maximumEvents: 0,
    })).toBeNull();
    expect(absent.connection.queries).toHaveLength(2);

    expect(() =>
      createPostgresProtectedJournalProductReadPort({
        product: {} as never,
        authorize: authority(),
      })
    ).toThrow("verified");
  });
});
