import {
  PROTECTED_JOURNAL_MAX_CONTEXT_BYTES,
  PROTECTED_JOURNAL_MAX_EVENTS,
  type ProtectedAgentRuntimeForegroundEntrypointId,
  type ProtectedJournalAgentContentOpener,
  type ProtectedJournalOpenedRecord,
  type ProtectedJournalProductReadAuthorization,
  type ProtectedJournalProductReadBatch,
  type ProtectedJournalProductReadPort,
  type ProtectedJournalProductRecord,
} from "@nautilo/lattice-bridge";
import {
  assertStenographerRecordPayloadBinding,
  decodeDurableRecordEnvelope,
} from "@nautilo/reflection-bridge/server";
import { roomJournalContextByteLength } from "../context/room-journal-context-budget";

import type {
  ForegroundAuthorizationView,
} from "../protected-execution/foreground-authorization-session";
import type {
  EffectiveRoomEvent,
  RoomEventRollupView,
} from "./types";

class ProtectedJournalExecutionFailure extends Error {
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super("Protected journal execution failed", { cause });
    this.name = "ProtectedJournalExecutionFailure";
    this.cause = cause;
  }
}

function runtimeArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export type ProtectedForegroundJournal = Readonly<{
  readonly rollup: RoomEventRollupView | null;
  readonly events: readonly EffectiveRoomEvent[];
}>;

export type ProtectedJournalReadResult<Value> =
  | Readonly<{ readonly status: "executed"; readonly value: Value }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "authorization_unavailable"
      | "content_unavailable"
      | "content_invalid";
  }>;

export interface ProtectedJournalReaderOptions {
  readonly productReads: ProtectedJournalProductReadPort;
  readonly contentOpener: ProtectedJournalAgentContentOpener;
}

function exactOwnDataFields(
  label: string,
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Reflect.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} is malformed`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new TypeError(`${label} has a non-data field`);
    }
  }
}

function validateRecordShape(
  value: unknown,
): asserts value is ProtectedJournalProductRecord {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("protected journal record is malformed");
  }
  const kind = (value as Readonly<{ readonly kind?: unknown }>).kind;
  if (kind === "event") {
    const record = value as Extract<
      ProtectedJournalProductRecord,
      Readonly<{ readonly kind: "event" }>
    >;
    exactOwnDataFields("protected journal event record", record, [
      "kind",
      "cryptoObjectId",
      "rebuildGeneration",
      "status",
      "binding",
      ...(record.payloadFormat === "record_v1"
        ? ["payloadFormat", "recordMetadata"]
        : []),
    ]);
    if (
      record.status !== "active"
      && record.status !== "superseded"
      && record.status !== "resolved"
    ) {
      throw new TypeError("protected journal event status is invalid");
    }
    exactOwnDataFields("protected journal event binding", record.binding, [
      "eventId",
      "roomId",
      "namespaceId",
      "sequence",
      "kind",
      "supersedesEventId",
      "resolvesEventId",
      "sourceMessageIds",
      "sourceBatchId",
      "batchLocalOrdinal",
      "extractorVersion",
      "createdAt",
    ]);
    if (record.payloadFormat === "record_v1") {
      if (record.recordMetadata === undefined) {
        throw new TypeError("protected Journal Record metadata is missing");
      }
      exactOwnDataFields(
        "protected journal Record metadata",
        record.recordMetadata,
        ["lifecycle", "structuralHeight", "processingGeneration"],
      );
    }
  } else if (kind === "rollup") {
    const record = value as Extract<
      ProtectedJournalProductRecord,
      Readonly<{ readonly kind: "rollup" }>
    >;
    exactOwnDataFields("protected journal rollup record", record, [
      "kind",
      "cryptoObjectId",
      "rebuildGeneration",
      "binding",
    ]);
    exactOwnDataFields("protected journal rollup binding", record.binding, [
      "rollupId",
      "roomId",
      "namespaceId",
      "throughEventSequence",
      "sourceEventCount",
      "modelId",
      "compactorVersion",
      "createdAt",
    ]);
  } else {
    throw new TypeError("protected journal record kind is invalid");
  }
  const record = value as ProtectedJournalProductRecord;
  if (
    typeof record.cryptoObjectId !== "string"
    || record.cryptoObjectId.length < 1
    || !Number.isSafeInteger(record.rebuildGeneration)
    || record.rebuildGeneration < 0
  ) {
    throw new TypeError("protected journal record coordinate is invalid");
  }
}

function validateBatch(
  batch: ProtectedJournalProductReadBatch,
  expected: Readonly<{
    roomId: string;
    namespaceId: string;
    maximumEvents: number;
  }>,
): readonly ProtectedJournalProductRecord[] {
  exactOwnDataFields("protected journal batch", batch, [
    "roomId",
    "namespaceId",
    "domainId",
    "rebuildGeneration",
    "expectedAccessRevision",
    "expectedPolicyRevision",
    "rollup",
    "events",
  ]);
  if (
    batch.roomId !== expected.roomId
    || batch.namespaceId !== expected.namespaceId
    || typeof batch.domainId !== "string"
    || batch.domainId.length < 1
    || !Number.isSafeInteger(batch.rebuildGeneration)
    || batch.rebuildGeneration < 0
    || !Number.isSafeInteger(batch.expectedAccessRevision)
    || batch.expectedAccessRevision < 0
    || !Number.isSafeInteger(batch.expectedPolicyRevision)
    || batch.expectedPolicyRevision < 0
  ) {
    throw new TypeError("protected journal batch coordinate is invalid");
  }
  const eventCandidates: unknown = batch.events;
  if (
    !runtimeArray(eventCandidates)
    || eventCandidates.length > expected.maximumEvents
  ) {
    throw new TypeError("protected journal batch event inventory is invalid");
  }
  const seenObjects = new Set<string>();
  const checkedEvents: Array<Extract<
    ProtectedJournalProductRecord,
    Readonly<{ readonly kind: "event" }>
  >> = [];
  let through = 0;
  if (batch.rollup !== null) {
    validateRecordShape(batch.rollup);
    if (
      batch.rollup.kind !== "rollup"
      || batch.rollup.binding.roomId !== batch.roomId
      || batch.rollup.binding.namespaceId !== batch.namespaceId
      || batch.rollup.rebuildGeneration !== batch.rebuildGeneration
    ) {
      throw new TypeError("protected journal rollup coordinate is invalid");
    }
    through = batch.rollup.binding.throughEventSequence;
    seenObjects.add(batch.rollup.cryptoObjectId);
  }
  let previousSequence = through;
  for (const candidate of eventCandidates) {
    validateRecordShape(candidate);
    const event = candidate;
    if (
      event.kind !== "event"
      || event.binding.roomId !== batch.roomId
      || event.binding.namespaceId !== batch.namespaceId
      || event.rebuildGeneration !== batch.rebuildGeneration
      || event.binding.sequence !== previousSequence + 1
      || seenObjects.has(event.cryptoObjectId)
    ) {
      throw new TypeError("protected journal event coordinate is invalid");
    }
    previousSequence = event.binding.sequence;
    seenObjects.add(event.cryptoObjectId);
    checkedEvents.push(event);
  }
  return Object.freeze([
    ...(batch.rollup === null ? [] : [batch.rollup]),
    ...checkedEvents,
  ]);
}

function journalFromOpened(
  opened: readonly ProtectedJournalOpenedRecord[],
  records: readonly ProtectedJournalProductRecord[],
  maximumContextBytes: number,
): ProtectedForegroundJournal {
  const openedCandidates: unknown = opened;
  if (
    !runtimeArray(openedCandidates)
    || openedCandidates.length !== records.length
  ) {
    throw new TypeError("protected journal opened batch is invalid");
  }
  let rollup: RoomEventRollupView | null = null;
  const decodedEvents: Array<Readonly<{
    readonly record: Extract<
      ProtectedJournalProductRecord,
      Readonly<{ readonly kind: "event" }>
    >;
    readonly payload: import("@nautilo/lattice-bridge").RoomEventPayloadV1;
  }>> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const candidate = openedCandidates[index];
    if (
      typeof candidate !== "object"
      || candidate === null
      || (
        (candidate as Readonly<{ readonly kind?: unknown }>).kind !== "event"
        && (candidate as Readonly<{ readonly kind?: unknown }>).kind
          !== "rollup"
      )
    ) {
      throw new TypeError("protected journal opened record is invalid");
    }
    const item = candidate as ProtectedJournalOpenedRecord;
    if (
      item.kind !== record.kind
      || item.cryptoObjectId !== record.cryptoObjectId
    ) {
      throw new TypeError("protected journal opened ordering is invalid");
    }
    if (item.kind === "rollup") {
      if (rollup !== null) {
        throw new TypeError("protected journal contains multiple rollups");
      }
      rollup = Object.freeze({
        throughEventSequence: item.payload.throughEventSequence,
        content: item.payload.content,
        sourceEventCount: item.payload.sourceEventCount,
      });
    } else {
      if (record.kind !== "event") {
        throw new TypeError("protected journal event record is invalid");
      }
      if ("payloadFormat" in item) {
        if (
          item.payloadFormat !== "record_v1"
          || record.payloadFormat !== "record_v1"
          || record.recordMetadata === undefined
        ) {
          throw new TypeError("protected Journal Record format is invalid");
        }
        const envelope = decodeDurableRecordEnvelope({
          recordRef: record.binding.eventId,
          lifecycle: record.recordMetadata.lifecycle,
          structuralHeight: record.recordMetadata.structuralHeight,
          processingGeneration: record.recordMetadata.processingGeneration,
          payloadBytes: item.recordPayloadBytes,
        });
        assertStenographerRecordPayloadBinding(envelope, {
          eventId: record.binding.eventId,
          roomId: record.binding.roomId,
          namespaceId: record.binding.namespaceId,
          kind: record.binding.kind,
          status: record.status,
          sourceMessageIds: record.binding.sourceMessageIds,
          extractorVersion: record.binding.extractorVersion,
          publicationGeneration: record.rebuildGeneration + 1,
        });
        decodedEvents.push(Object.freeze({
          record,
          payload: {
            eventId: record.binding.eventId,
            roomId: record.binding.roomId,
            namespaceId: record.binding.namespaceId,
            sequence: record.binding.sequence,
            kind: record.binding.kind,
            statement: envelope.semantic.statement,
            supersedesEventId: record.binding.supersedesEventId,
            resolvesEventId: record.binding.resolvesEventId,
            sourceMessageIds: record.binding.sourceMessageIds,
            sourceBatchId: record.binding.sourceBatchId,
            batchLocalOrdinal: record.binding.batchLocalOrdinal,
            extractorVersion: record.binding.extractorVersion,
            createdAt: record.binding.createdAt,
          },
        }));
      } else {
        decodedEvents.push(Object.freeze({ record, payload: item.payload }));
      }
    }
  }
  const derivedStatus = new Map(
    decodedEvents.map(({ payload }) => [
      payload.eventId,
      "active" as "active" | "superseded" | "resolved",
    ]),
  );
  for (const { payload } of decodedEvents) {
    const target = payload.supersedesEventId
      ?? payload.resolvesEventId;
    if (target === null || !derivedStatus.has(target)) continue;
    if (derivedStatus.get(target) !== "active") {
      throw new TypeError(
        "protected journal contains two transitions for one event",
      );
    }
    derivedStatus.set(
      target,
      payload.supersedesEventId === null
        ? "resolved"
        : "superseded",
    );
  }
  const events: EffectiveRoomEvent[] = [];
  for (const { record, payload } of decodedEvents) {
    const status = derivedStatus.get(payload.eventId)!;
    if (record.status !== status) {
      throw new TypeError(
        "protected journal product status does not match signed transitions",
      );
    }
    if (status !== "active") continue;
    events.push(Object.freeze({
      id: payload.eventId,
      roomId: payload.roomId,
      sequence: payload.sequence,
      kind: payload.kind,
      statement: payload.statement,
      status,
      supersedesEventId: payload.supersedesEventId,
      resolvesEventId: payload.resolvesEventId,
    }));
  }
  if (
    roomJournalContextByteLength({ rollup, events }) > maximumContextBytes
  ) {
    throw new RangeError("protected journal context budget was exceeded");
  }
  return Object.freeze({ rollup, events: Object.freeze(events) });
}

/**
 * Creates a dormant foreground-only journal reader. It never reads plaintext
 * product fields and has no legacy fallback: selected protected mode succeeds
 * only when every mapped object opens under the current Agent session.
 */
export function createProtectedForegroundJournalReader(
  options: ProtectedJournalReaderOptions,
): Readonly<{
  withCurrentJournal: <Value>(input: Readonly<{
    readonly roomId: string;
    readonly namespaceId: string;
    readonly maximumEvents: number;
    readonly maximumContextBytes: number;
    readonly productReadAuthorization:
      ProtectedJournalProductReadAuthorization;
    readonly authorization: ForegroundAuthorizationView;
    readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    readonly signal?: AbortSignal;
    readonly execute: (
      journal: ProtectedForegroundJournal,
    ) => Value | PromiseLike<Value>;
  }>) => Promise<ProtectedJournalReadResult<Value>>;
}> {
  return Object.freeze({
    withCurrentJournal: async <Value>(input: Readonly<{
      readonly roomId: string;
      readonly namespaceId: string;
      readonly maximumEvents: number;
      readonly maximumContextBytes: number;
      readonly productReadAuthorization:
        ProtectedJournalProductReadAuthorization;
      readonly authorization: ForegroundAuthorizationView;
      readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
      readonly signal?: AbortSignal;
      readonly execute: (
        journal: ProtectedForegroundJournal,
      ) => Value | PromiseLike<Value>;
    }>): Promise<ProtectedJournalReadResult<Value>> => {
      if (
        !Number.isSafeInteger(input.maximumEvents)
        || input.maximumEvents < 0
        || input.maximumEvents > PROTECTED_JOURNAL_MAX_EVENTS
        || !Number.isSafeInteger(input.maximumContextBytes)
        || input.maximumContextBytes < 1
        || input.maximumContextBytes > PROTECTED_JOURNAL_MAX_CONTEXT_BYTES
        || input.signal?.aborted === true
      ) {
        return Object.freeze({
          status: "unavailable",
          reason: "content_invalid",
        });
      }
      let batch;
      try {
        batch = await options.productReads.readCurrent({
          authorization: input.productReadAuthorization,
          roomId: input.roomId,
          namespaceId: input.namespaceId,
          maximumEvents: input.maximumEvents,
        });
      } catch {
        return Object.freeze({
          status: "unavailable",
          reason: "content_unavailable",
        });
      }
      if (batch === null) {
        return Object.freeze({
          status: "unavailable",
          reason: "content_unavailable",
        });
      }
      let records: readonly ProtectedJournalProductRecord[];
      try {
        records = validateBatch(batch, input);
      } catch {
        return Object.freeze({
          status: "unavailable",
          reason: "content_invalid",
        });
      }

      let callbackLive = true;
      let callbackCalls = 0;
      try {
        const result = await options.contentOpener.openBatch<
          ProtectedJournalReadResult<Value>
        >({
          authorizationSession: input.authorization,
          entrypointId: input.entrypointId,
          namespaceId: batch.namespaceId,
          domainId: batch.domainId,
          rebuildGeneration: batch.rebuildGeneration,
          expectedAccessRevision: batch.expectedAccessRevision,
          expectedPolicyRevision: batch.expectedPolicyRevision,
          records,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          execute: async (opened) => {
            if (!callbackLive || callbackCalls !== 0) {
              return Object.freeze({
                status: "unavailable" as const,
                reason: "content_invalid" as const,
              });
            }
            callbackCalls += 1;
            try {
              const journal = journalFromOpened(
                opened,
                records,
                input.maximumContextBytes,
              );
              try {
                return Object.freeze({
                  status: "executed" as const,
                  value: await input.execute(journal),
                });
              } catch (cause) {
                throw new ProtectedJournalExecutionFailure(cause);
              }
            } catch (cause) {
              if (cause instanceof ProtectedJournalExecutionFailure) {
                throw cause;
              }
              return Object.freeze({
                status: "unavailable" as const,
                reason: "content_invalid" as const,
              });
            }
          },
        });
        callbackLive = false;
        if (result.status === "unavailable") return result;
        if (callbackCalls !== 1) {
          return Object.freeze({
            status: "unavailable",
            reason: "content_invalid",
          });
        }
        return result.value;
      } catch (cause) {
        callbackLive = false;
        if (cause instanceof ProtectedJournalExecutionFailure) {
          throw cause.cause;
        }
        return Object.freeze({
          status: "unavailable",
          reason: "content_invalid",
        });
      }
    },
  });
}
