import {
  PROTECTED_JOURNAL_MAX_EVENTS,
  type ProtectedJournalProductReadAuthorization,
  type ProtectedJournalProductReadBatch,
  type ProtectedJournalProductReadPort,
  type ProtectedJournalProductRecord,
} from "../../journal/protected-journal-reader.ts";
import type {
  RoomEventPayloadKindV1,
} from "../../journal/room-event-payload-v1.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const EVENT_KINDS = new Set<RoomEventPayloadKindV1>([
  "decision",
  "commitment",
  "goal",
  "state_change",
  "fact",
  "preference_or_norm",
  "open_question",
  "risk",
]);

export type ProtectedJournalProductReadOperation = Readonly<{
  readonly authorization: ProtectedJournalProductReadAuthorization;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly maximumEvents: number;
}>;

export type ProtectedJournalProductReadAuthority = Readonly<{
  readonly roomId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly expectedAccessRevision: number;
  readonly expectedPolicyRevision: number;
}>;

/**
 * The resolver owns validation of the opaque branded authorization. The
 * adapter additionally proves that its returned authority is for the exact
 * requested Room and Namespace before opening a product transaction.
 */
export type ResolveProtectedJournalProductReadAuthorization = (
  operation: ProtectedJournalProductReadOperation,
) =>
  | ProtectedJournalProductReadAuthority
  | null
  | Promise<ProtectedJournalProductReadAuthority | null>;

export interface PostgresProtectedJournalProductReadOptions {
  readonly product: ConversationProductPostgresHandle;
  readonly authorize: ResolveProtectedJournalProductReadAuthorization;
}

type EventRecord = Extract<
  ProtectedJournalProductRecord,
  Readonly<{ readonly kind: "event" }>
>;
type RollupRecord = Extract<
  ProtectedJournalProductRecord,
  Readonly<{ readonly kind: "rollup" }>
>;

function uuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function portable(label: string, value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || new TextEncoder().encode(value).length > 256
    || !PORTABLE_ID.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function counter(label: string, value: unknown, minimum = 0): number {
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < minimum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function nullableUuid(label: string, value: unknown): string | null {
  return value === null ? null : uuid(label, value);
}

function canonicalTimestamp(label: string, value: unknown): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactlyOne(
  label: string,
  rows: readonly ConversationProductDatabaseRow[],
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new TypeError(`${label} is duplicated`);
  return rows[0] ?? null;
}

function sourceIds(value: unknown): readonly number[] {
  if (typeof value !== "string" || value.length < 1 || value.length > 192) {
    throw new TypeError("protected journal source inventory is invalid");
  }
  const ids = value.split(",").map((entry) =>
    counter("protected journal source message", entry, 1)
  );
  if (
    ids.length > 16
    || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)
  ) {
    throw new TypeError("protected journal source inventory is invalid");
  }
  return Object.freeze(ids);
}

function eventKind(value: unknown): RoomEventPayloadKindV1 {
  if (
    typeof value !== "string"
    || !EVENT_KINDS.has(value as RoomEventPayloadKindV1)
  ) {
    throw new TypeError("protected journal event kind is invalid");
  }
  return value as RoomEventPayloadKindV1;
}

function eventStatus(
  value: unknown,
): EventRecord["status"] {
  if (
    value !== "active"
    && value !== "superseded"
    && value !== "resolved"
  ) {
    throw new TypeError("protected journal event status is invalid");
  }
  return value;
}

function eventRecord(
  row: ConversationProductDatabaseRow,
  expected: Readonly<{
    readonly roomId: string;
    readonly namespaceId: string;
    readonly rebuildGeneration: number;
  }>,
): EventRecord {
  const roomId = uuid("protected journal event Room", row["room_id"]);
  const namespaceId = uuid(
    "protected journal event Namespace",
    row["namespace_id"],
  );
  if (
    roomId !== expected.roomId
    || namespaceId !== expected.namespaceId
  ) {
    throw new TypeError(
      "protected journal event escaped its authorized coordinates",
    );
  }
  const supersedesEventId = nullableUuid(
    "protected journal superseded event",
    row["supersedes_event_id"],
  );
  const resolvesEventId = nullableUuid(
    "protected journal resolved event",
    row["resolves_event_id"],
  );
  if (supersedesEventId !== null && resolvesEventId !== null) {
    throw new TypeError(
      "protected journal event has conflicting transition links",
    );
  }
  const native = row["projection_kind"] === "native";
  if (!native && row["projection_kind"] !== "legacy") {
    throw new TypeError("protected journal projection kind is invalid");
  }
  const recordMetadata = native
    ? Object.freeze({
        lifecycle: row["record_lifecycle"] as
          | "current"
          | "stale"
          | "superseded"
          | "resolved"
          | "sunset",
        structuralHeight: counter(
          "protected journal Record height",
          row["record_structural_height"],
        ),
        processingGeneration: counter(
          "protected journal Record generation",
          row["record_processing_generation"],
          1,
        ),
      })
    : undefined;
  if (
    recordMetadata !== undefined
    && recordMetadata.lifecycle !== "current"
    && recordMetadata.lifecycle !== "stale"
    && recordMetadata.lifecycle !== "superseded"
    && recordMetadata.lifecycle !== "resolved"
    && recordMetadata.lifecycle !== "sunset"
  ) throw new TypeError("protected journal Record lifecycle is invalid");
  return Object.freeze({
    kind: "event",
    cryptoObjectId: portable(
      "protected journal event object",
      row["crypto_object_id"],
    ),
    rebuildGeneration: expected.rebuildGeneration,
    status: eventStatus(row["status"]),
    ...(native
      ? { payloadFormat: "record_v1" as const, recordMetadata: recordMetadata! }
      : {}),
    binding: Object.freeze({
      eventId: uuid("protected journal event", row["event_id"]),
      roomId,
      namespaceId,
      sequence: counter(
        "protected journal event sequence",
        row["sequence"],
        1,
      ),
      kind: eventKind(row["kind"]),
      supersedesEventId,
      resolvesEventId,
      sourceMessageIds: sourceIds(row["source_message_ids_csv"]),
      sourceBatchId: uuid(
        "protected journal source batch",
        row["source_batch_id"],
      ),
      batchLocalOrdinal: counter(
        "protected journal batch ordinal",
        row["batch_local_ordinal"],
      ),
      extractorVersion: portable(
        "protected journal extractor version",
        row["extractor_version"],
      ),
      createdAt: canonicalTimestamp(
        "protected journal event creation time",
        row["created_at"],
      ),
    }),
  });
}

function rollupRecord(
  row: ConversationProductDatabaseRow,
  expected: Readonly<{
    readonly roomId: string;
    readonly namespaceId: string;
    readonly rebuildGeneration: number;
  }>,
): RollupRecord {
  const roomId = uuid("protected journal rollup Room", row["room_id"]);
  const namespaceId = uuid(
    "protected journal rollup Namespace",
    row["namespace_id"],
  );
  if (
    roomId !== expected.roomId
    || namespaceId !== expected.namespaceId
  ) {
    throw new TypeError(
      "protected journal rollup escaped its authorized coordinates",
    );
  }
  return Object.freeze({
    kind: "rollup",
    cryptoObjectId: portable(
      "protected journal rollup object",
      row["crypto_object_id"],
    ),
    rebuildGeneration: expected.rebuildGeneration,
    binding: Object.freeze({
      rollupId: uuid("protected journal rollup", row["rollup_id"]),
      roomId,
      namespaceId,
      throughEventSequence: counter(
        "protected journal rollup sequence",
        row["through_event_sequence"],
        1,
      ),
      sourceEventCount: counter(
        "protected journal rollup source count",
        row["source_event_count"],
        1,
      ),
      modelId: portable(
        "protected journal rollup model",
        row["model_id"],
      ),
      compactorVersion: portable(
        "protected journal compactor version",
        row["compactor_version"],
      ),
      createdAt: canonicalTimestamp(
        "protected journal rollup creation time",
        row["created_at"],
      ),
    }),
  });
}

function validatedAuthority(
  authority: ProtectedJournalProductReadAuthority | null,
  expected: Readonly<{
    readonly roomId: string;
    readonly namespaceId: string;
  }>,
): ProtectedJournalProductReadAuthority {
  if (
    authority === null
    || authority.roomId !== expected.roomId
    || authority.namespaceId !== expected.namespaceId
  ) {
    throw new Error("Protected journal product authorization is unavailable");
  }
  uuid("protected journal authorized Room", authority.roomId);
  uuid("protected journal authorized Namespace", authority.namespaceId);
  portable("protected journal authorized Domain", authority.domainId);
  counter(
    "protected journal authorized access revision",
    authority.expectedAccessRevision,
  );
  counter(
    "protected journal authorized policy revision",
    authority.expectedPolicyRevision,
  );
  return Object.freeze({ ...authority });
}

function validateEvents(
  rows: readonly ConversationProductDatabaseRow[],
  expected: Readonly<{
    readonly roomId: string;
    readonly namespaceId: string;
    readonly rebuildGeneration: number;
    readonly maximumEvents: number;
    readonly throughSequence: number;
    readonly rollupObjectId: string | null;
  }>,
): readonly EventRecord[] {
  if (rows.length > expected.maximumEvents) {
    throw new RangeError("protected journal event bound was exceeded");
  }
  const records = rows.map((row) => eventRecord(row, expected));
  const eventIds = new Set<string>();
  const objectIds = new Set<string>(
    expected.rollupObjectId === null ? [] : [expected.rollupObjectId],
  );
  let previousSequence = expected.throughSequence;
  for (const record of records) {
    if (
      record.binding.sequence !== previousSequence + 1
      || eventIds.has(record.binding.eventId)
      || objectIds.has(record.cryptoObjectId)
    ) {
      throw new TypeError(
        "protected journal event ordering or identity is invalid",
      );
    }
    previousSequence = record.binding.sequence;
    eventIds.add(record.binding.eventId);
    objectIds.add(record.cryptoObjectId);
  }
  return Object.freeze(records);
}

const ROLLUP_PROJECTION = `
  SELECT rollup.id::text AS rollup_id,
         rollup.crypto_object_id,
         rollup.room_id::text AS room_id,
         room.namespace_id::text AS namespace_id,
         rollup.through_event_sequence::integer,
         rollup.source_event_count::integer,
         rollup.model_id,
         rollup.compactor_version,
         to_char(
           rollup.created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         ) AS created_at
    FROM room_event_rollups AS rollup
    JOIN rooms AS room ON room.id = rollup.room_id`;

export const PROTECTED_JOURNAL_EVENT_PROJECTION_SQL = `
  SELECT event.id::text AS event_id,
         COALESCE(event.crypto_object_id, representation.crypto_object_id)
           AS crypto_object_id,
         event.room_id::text AS room_id,
         room.namespace_id::text AS namespace_id,
         event.sequence::integer,
         event.kind,
         event.status,
         event.supersedes_event_id::text,
         event.resolves_event_id::text,
         array_to_string(
           event.source_message_ids,
           ','
         ) AS source_message_ids_csv,
         event.source_batch_id::text,
         event.batch_local_ordinal::integer,
         event.extractor_version,
         event.projection_kind,
         record.lifecycle AS record_lifecycle,
         record.structural_height AS record_structural_height,
         record.processing_generation AS record_processing_generation,
         to_char(
           event.created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         ) AS created_at
    FROM room_events AS event
    JOIN rooms AS room ON room.id = event.room_id
    LEFT JOIN reflection_records record
      ON event.projection_kind = 'native'
     AND record.record_id = event.record_id
    LEFT JOIN reflection_record_payload_representation_heads head
      ON event.projection_kind = 'native'
     AND head.record_id = event.record_id
     AND head.representation = 'protected'
    LEFT JOIN reflection_record_payload_representations representation
      ON representation.record_id = head.record_id
     AND representation.representation = head.representation
     AND representation.representation_generation =
           head.current_representation_generation`;

export function createPostgresProtectedJournalProductReadPort(
  options: PostgresProtectedJournalProductReadOptions,
): ProtectedJournalProductReadPort {
  assertVerifiedConversationProductPostgresHandle(options.product);
  if (typeof options.authorize !== "function") {
    throw new TypeError(
      "Protected journal product authorization resolver is required",
    );
  }

  const port: ProtectedJournalProductReadPort = {
    async readCurrent(input): Promise<
      ProtectedJournalProductReadBatch | null
    > {
      const roomId = uuid(
        "protected journal requested Room",
        input.roomId,
      );
      const namespaceId = uuid(
        "protected journal requested Namespace",
        input.namespaceId,
      );
      const maximumEvents = counter(
        "protected journal requested event bound",
        input.maximumEvents,
      );
      if (maximumEvents > PROTECTED_JOURNAL_MAX_EVENTS) {
        throw new RangeError(
          "protected journal requested event bound is excessive",
        );
      }
      const operation: ProtectedJournalProductReadOperation =
        Object.freeze({
          authorization: input.authorization,
          roomId,
          namespaceId,
          maximumEvents,
        });
      const authority = validatedAuthority(
        await options.authorize(operation),
        { roomId, namespaceId },
      );

      return options.product.transaction(async (
        transaction: ConversationProductPostgresTransaction,
      ) => {
        const state = exactlyOne(
          "protected journal state",
          await transaction.query(
            `SELECT room.id::text AS room_id,
                    room.namespace_id::text AS namespace_id,
                    journal.rebuild_generation::integer
               FROM room_journal_state AS journal
               JOIN rooms AS room ON room.id = journal.room_id
              WHERE journal.room_id = $1::uuid
                AND room.namespace_id = $2::uuid
                AND journal.rebuild_requested_at IS NULL
              LIMIT 2
              FOR SHARE OF journal`,
            [roomId, namespaceId],
          ),
        );
        if (state === null) return null;
        const stateRoomId = uuid(
          "protected journal state Room",
          state["room_id"],
        );
        const stateNamespaceId = uuid(
          "protected journal state Namespace",
          state["namespace_id"],
        );
        if (
          stateRoomId !== roomId
          || stateNamespaceId !== namespaceId
        ) {
          throw new TypeError(
            "protected journal state escaped its authorized coordinates",
          );
        }
        const rebuildGeneration = counter(
          "protected journal rebuild generation",
          state["rebuild_generation"],
        );
        const expected = Object.freeze({
          roomId,
          namespaceId,
          rebuildGeneration,
        });
        const rollupRow = exactlyOne(
          "protected journal latest rollup",
          await transaction.query(
            `${ROLLUP_PROJECTION}
              WHERE rollup.room_id = $1::uuid
                AND rollup.crypto_object_id IS NOT NULL
              ORDER BY rollup.through_event_sequence DESC,
                       rollup.created_at DESC,
                       rollup.id
              LIMIT 1`,
            [roomId],
          ),
        );
        const rollup = rollupRow === null
          ? null
          : rollupRecord(rollupRow, expected);
        const events = validateEvents(
          await transaction.query(
          `${PROTECTED_JOURNAL_EVENT_PROJECTION_SQL}
              WHERE event.room_id = $1::uuid
                AND (
                  (event.projection_kind = 'legacy'
                    AND event.crypto_object_id IS NOT NULL)
                  OR
                  (event.projection_kind = 'native'
                    AND representation.crypto_object_id IS NOT NULL)
                )
                AND event.sequence > $2::integer
              ORDER BY event.sequence, event.id
              LIMIT $3::integer`,
            [
              roomId,
              rollup?.binding.throughEventSequence ?? 0,
              maximumEvents,
            ],
          ),
          {
            ...expected,
            maximumEvents,
            throughSequence:
              rollup?.binding.throughEventSequence ?? 0,
            rollupObjectId: rollup?.cryptoObjectId ?? null,
          },
        );
        return Object.freeze({
          roomId,
          namespaceId,
          domainId: authority.domainId,
          rebuildGeneration,
          expectedAccessRevision: authority.expectedAccessRevision,
          expectedPolicyRevision: authority.expectedPolicyRevision,
          rollup,
          events,
        });
      }, { isolationLevel: "serializable" });
    },
  };
  return Object.freeze(port);
}
