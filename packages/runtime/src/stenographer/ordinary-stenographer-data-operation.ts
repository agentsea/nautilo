import { getSharedDirectDb, type DirectDatabase } from "@nautilo/db";
import { error as logError, log, warn } from "@nautilo/logger";
import type {
  StenographerCompactionAdapterInput,
  StenographerExtractionAdapterInput,
  StenographerIntentAdapter,
  StenographerLegacyConversionAdapterInput,
  StenographerOperationOutcome,
  StenographerPublicationContext,
  StenographerRebuildAdapterInput,
} from "@nautilo/lattice-bridge/server";

import {
  claimJournalRebuildExtraction,
  failCompaction,
  failExtraction,
  prepareNextJournalRebuild,
  publishCompaction,
  tryClaimCompactionRoom,
  tryClaimRoom,
  type CompactionClaim,
  type ExtractionClaim,
  type StenographerErrorCode,
} from "./repository";
import {
  createRoomSideModelInvoker,
  mapModelFailure,
} from "./model-invoker";
import {
  runCompactionModel,
  runExtractionModel,
} from "./semantic-adapter";
import type { StenographerOperation } from "./types";

type Logger = Readonly<{
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}>;

type ExtractionPublisher = (input: Readonly<{
  claim: ExtractionClaim;
  operations: readonly StenographerOperation[];
  modelId: string | null;
  now?: Date;
  db?: DirectDatabase;
  ordinaryFallbackReason?: "device" | "authority";
}>) => Promise<{ published: boolean; eventsWritten: number }>;

type LegacyConverter = (input: Readonly<{ now: Date }>) => Promise<Readonly<{
  roomId: string | null;
  converted: number;
  completedRoom: boolean;
}>>;

export interface OrdinaryStenographerIntentAdapterOptions {
  readonly publishExtraction: ExtractionPublisher;
  readonly convertNextLegacy?: LegacyConverter;
  readonly db?: DirectDatabase;
  readonly claimExtraction?: (input: Readonly<{
    roomId: string;
    lane: "live" | "historical" | "rebuild";
    now: Date;
  }>) => Promise<ExtractionClaim | null>;
  readonly claimCompaction?: (input: Readonly<{
    roomId: string;
    now: Date;
  }>) => Promise<CompactionClaim | null>;
  readonly prepareNextRebuild?: (input: Readonly<{
    now: Date;
  }>) => Promise<string | null>;
  readonly publishCompaction?: typeof publishCompaction;
  readonly failExtraction?: typeof failExtraction;
  readonly failCompaction?: typeof failCompaction;
  readonly createInvoker?: typeof createRoomSideModelInvoker;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

const JOURNAL_TRANSITION_FAILURE_DETAILS: ReadonlyMap<string, string> = new Map([
  ["journal transition rejected: invalid_existing_graph", "journal_transition_invalid_existing_graph"],
  ["journal transition rejected: target_not_found", "journal_transition_target_not_found"],
  ["journal transition rejected: target_cross_room", "journal_transition_target_cross_room"],
  ["journal transition rejected: target_not_active", "journal_transition_target_not_active"],
  ["Stenographer source changed before native publication", "native_source_changed"],
  ["Stenographer event identity allocation failed", "event_identity_allocation_failed"],
  ["Stenographer source binding is unavailable", "source_binding_unavailable"],
  ["Stenographer transition target changed before attach", "transition_target_changed_before_attach"],
  ["Stenographer transition sequence changed before publish", "transition_sequence_changed"],
  ["Stenographer transition target changed before publish", "transition_target_changed_before_publish"],
  ["Stenographer predecessor is unavailable", "predecessor_unavailable"],
  ["Protected legacy predecessor cannot enter ordinary publication", "protected_predecessor_unavailable"],
  ["Legacy Stenographer predecessor chain exceeds conversion bound", "legacy_predecessor_capacity_exceeded"],
  ["Legacy Stenographer sources are invalid", "legacy_sources_invalid"],
  ["Legacy Stenographer source is invalid", "legacy_source_invalid"],
  ["Legacy Stenographer source is unavailable", "legacy_source_unavailable"],
  ["Legacy Stenographer projection attach conflicted", "legacy_projection_attach_conflicted"],
  ["Invalid Stenographer row", "invalid_stenographer_row"],
  ["Invalid Stenographer counter", "invalid_stenographer_counter"],
  ["typed Record product query emitted an unsupported parameter", "unsupported_record_product_parameter"],
  ["Invalid Record product row", "invalid_record_product_row"],
  ["Invalid Record product counter", "invalid_record_product_counter"],
  ["Invalid Record product bytes", "invalid_record_product_bytes"],
  ["Invalid Record lifecycle row", "invalid_record_lifecycle_row"],
  ["Invalid Journal event row", "invalid_journal_event_row"],
  ["Invalid Journal event link", "invalid_journal_event_link"],
  ["Invalid Journal event sequence", "invalid_journal_event_sequence"],
  ["Invalid Journal event sources", "invalid_journal_event_sources"],
  ["Invalid Journal event source", "invalid_journal_event_source"],
  ["Invalid Journal projection kind", "invalid_journal_projection_kind"],
  ["Stenographer Record payload binding is invalid", "journal_payload_binding_invalid"],
] as const);

const RECORD_PUBLICATION_REJECTION_DETAILS = new Set([
  "invalid_publication",
  "publication_binding_invalid",
  "idempotency_conflict",
  "structural_conflict",
  "blocked",
  "purged",
]);

function publicationRejectionDetail(message: string): string | null {
  const prefix = "Stenographer Record publication rejected: ";
  if (!message.startsWith(prefix)) return null;
  const reason = message.slice(prefix.length);
  return RECORD_PUBLICATION_REJECTION_DETAILS.has(reason)
    ? `record_publication_${reason}`
    : "record_publication_rejected";
}

function publicationFailureDetail(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) break;
    const detail = JOURNAL_TRANSITION_FAILURE_DETAILS.get(current.message)
      ?? publicationRejectionDetail(current.message)
      ?? (current instanceof TypeError
        ? "extraction_publication_type_error"
        : null)
      ?? (current instanceof RangeError
        ? "extraction_publication_range_error"
        : null);
    if (detail !== null && detail !== undefined) return detail;
    current = current.cause;
  }
  return "extraction_publication_failed";
}

const PUBLICATION_FAILURE_ORIGINS = [
  "postgres-ordinary-stenographer-journal",
  "record-mapping",
  "record-payload-v1",
  "stenographer-record-publication",
  "event-transition-planner",
  "postgres-ordinary-stenographer-publisher",
  "postgres-record-product-store",
  "product-postgres",
] as const;

function publicationFailureOrigin(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== "string") {
    return "unknown";
  }
  return PUBLICATION_FAILURE_ORIGINS.find((origin) =>
    error.stack?.includes(origin)
  ) ?? "other";
}

function publicationDatabaseCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    if ("code" in current && typeof current.code === "string") {
      return /^[0-9A-Z]{5}$/.test(current.code) ? current.code : null;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return null;
}

function operationCounts(
  operations: readonly StenographerOperation[],
): Record<"append" | "supersede" | "resolve", number> {
  const counts = { append: 0, supersede: 0, resolve: 0 };
  for (const operation of operations) counts[operation.op] += 1;
  return counts;
}

function outcome(
  status: "completed" | "failed" | "cancelled",
  metrics?: Readonly<Record<string, number | string>>,
): StenographerOperationOutcome {
  return status === "completed" && metrics !== undefined
    ? Object.freeze({ status, processed: true as const, metrics })
    : Object.freeze({ status, processed: true as const });
}

const unavailable = (): StenographerOperationOutcome =>
  Object.freeze({ status: "unavailable", processed: false });

function safeLogger(logger?: Logger): Logger {
  const target = logger ?? {
    info: (message: string, fields?: Record<string, unknown>) => log(message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => warn(message, fields),
    error: (message: string, fields?: Record<string, unknown>) => logError(message, fields),
  };
  return {
    info: (message, fields) => {
      try { target.info(message, fields); } catch { /* diagnostic only */ }
    },
    warn: (message, fields) => {
      try { target.warn(message, fields); } catch { /* diagnostic only */ }
    },
    error: (message, fields) => {
      try { target.error(message, fields); } catch { /* diagnostic only */ }
    },
  };
}

/** Existing ordinary Stenographer behind the Lattice intent boundary. */
export function createOrdinaryStenographerIntentAdapter(
  options: OrdinaryStenographerIntentAdapterOptions,
): StenographerIntentAdapter {
  const logger = safeLogger(options.logger);
  const db = () => options.db ?? getSharedDirectDb();
  const currentTime = (fallback: Date) => options.now?.() ?? new Date(fallback);
  const claimExtraction = options.claimExtraction ?? (async (input) =>
    input.lane === "rebuild"
      ? claimJournalRebuildExtraction(input.roomId, {
        now: input.now,
        db: db(),
      })
      : tryClaimRoom(db(), input.roomId, input.now, undefined, input.lane));
  const claimCompaction = options.claimCompaction ?? ((input) =>
    tryClaimCompactionRoom(db(), input.roomId, input.now));
  const prepareRebuild = options.prepareNextRebuild ?? ((input) =>
    prepareNextJournalRebuild({ now: input.now, db: db() }));
  const failExtractionWork = options.failExtraction ?? failExtraction;
  const failCompactionWork = options.failCompaction ?? failCompaction;
  const publishCompactionWork = options.publishCompaction ?? publishCompaction;
  const invoker = options.createInvoker ?? createRoomSideModelInvoker;

  return Object.freeze({
    async prepareExtraction(input: StenographerExtractionAdapterInput) {
      const claim = await claimExtraction(input);
      if (claim === null) {
        return { publish: () => Promise.resolve(unavailable()) };
      }
      const modelId = input.modelId;
      if (claim.plan.trigger === "skip_excluded") {
        return {
          publish: async (context: StenographerPublicationContext) => {
            try {
              const published = await options.publishExtraction({
                claim,
                operations: [],
                modelId: null,
                now: currentTime(input.now),
                ...(context.ordinaryFallbackReason === undefined
                  ? {}
                  : { ordinaryFallbackReason: context.ordinaryFallbackReason }),
              });
              if (!published.published) {
                logger.warn("[stenographer] lease lost before excluded-range skip", {
                  stage: "extraction",
                });
                return unavailable();
              }
              return outcome("completed", {
                lane: claim.lane,
                trigger: claim.plan.trigger,
                sourceRows: 0,
                conversationalMessages: 0,
                operations: 0,
                eventsWritten: published.eventsWritten,
              });
            } catch (error) {
              logger.warn("[stenographer] extraction publication failed", {
                stage: "extraction",
                failureDetail: publicationFailureDetail(error),
                failureOrigin: publicationFailureOrigin(error),
                databaseCode: publicationDatabaseCode(error),
                operationCounts: operationCounts([]),
              });
              await failExtractionWork({
                claim,
                errorCode: "persistence",
                modelId: null,
                now: currentTime(input.now),
                ...(options.db === undefined ? {} : { db: options.db }),
              });
              return outcome(input.signal.aborted ? "cancelled" : "failed");
            }
          },
        };
      }

      try {
        const rawInvoke = invoker({
          modelId,
          userId: claim.ownerId,
          roomId: claim.roomId,
          laneKey: `room:${claim.roomId}:stenographer`,
          callType: "room_stenographer",
          operationId: claim.batchId,
        });
        const result = await runExtractionModel({
          claim,
          invoke: (prompt) => rawInvoke(prompt, input.signal),
        });
        if (!result.ok) {
          await failExtractionWork({
            claim,
            errorCode: result.errorCode,
            modelId,
            now: currentTime(input.now),
            ...(options.db === undefined ? {} : { db: options.db }),
          });
          return { publish: () => Promise.resolve(
            outcome(input.signal.aborted ? "cancelled" : "failed"),
          ) };
        }
        return {
          publish: async (context: StenographerPublicationContext) => {
            try {
              const published = await options.publishExtraction({
                claim,
                operations: result.output.operations,
                modelId,
                now: currentTime(input.now),
                ...(context.ordinaryFallbackReason === undefined
                  ? {}
                  : { ordinaryFallbackReason: context.ordinaryFallbackReason }),
              });
              if (!published.published) {
                logger.warn("[stenographer] lease lost before publish", {
                  stage: "extraction",
                });
                return unavailable();
              }
              const metrics = {
                lane: claim.lane,
                trigger: claim.plan.trigger,
                sourceRows: claim.plan.sourceRows.length,
                conversationalMessages: claim.plan.conversationalMessageCount,
                operations: result.output.operations.length,
                eventsWritten: published.eventsWritten,
                modelId,
              };
              logger.info("[stenographer] extraction completed", metrics);
              return outcome("completed", metrics);
            } catch (error) {
              logger.warn("[stenographer] extraction publication failed", {
                stage: "extraction",
                failureDetail: publicationFailureDetail(error),
                failureOrigin: publicationFailureOrigin(error),
                databaseCode: publicationDatabaseCode(error),
                operationCounts: operationCounts(result.output.operations),
              });
              await failExtractionWork({
                claim,
                errorCode: "persistence",
                modelId,
                now: currentTime(input.now),
                ...(options.db === undefined ? {} : { db: options.db }),
              });
              return outcome(input.signal.aborted ? "cancelled" : "failed");
            }
          },
        };
      } catch (error) {
        await failExtractionWork({
          claim,
          errorCode: mapModelFailure(error) as StenographerErrorCode,
          modelId,
          now: currentTime(input.now),
          ...(options.db === undefined ? {} : { db: options.db }),
        });
        return { publish: () => Promise.resolve(
          outcome(input.signal.aborted ? "cancelled" : "failed"),
        ) };
      }
    },

    async prepareCompaction(input: StenographerCompactionAdapterInput) {
      const claim = await claimCompaction(input);
      if (claim === null) {
        return { publish: () => Promise.resolve(unavailable()) };
      }
      const modelId = input.modelId;
      try {
        const rawInvoke = invoker({
          modelId,
          userId: claim.ownerId,
          roomId: claim.roomId,
          laneKey: `room:${claim.roomId}:event-compaction`,
          callType: "room_event_compaction",
          operationId: claim.modelOperationId,
        });
        const result = await runCompactionModel({
          claim,
          invoke: (prompt) => rawInvoke(prompt, input.signal),
        });
        if (!result.ok) {
          await failCompactionWork({
            claim,
            errorCode: result.errorCode,
            modelId,
            now: currentTime(input.now),
            ...(options.db === undefined ? {} : { db: options.db }),
          });
          return { publish: () => Promise.resolve(
            outcome(input.signal.aborted ? "cancelled" : "failed"),
          ) };
        }
        return {
          publish: async (context: StenographerPublicationContext) => {
            try {
              const published = await publishCompactionWork({
                claim,
                content: result.content,
                modelId,
                now: currentTime(input.now),
                ...(context.ordinaryFallbackReason === undefined
                  ? {}
                  : { ordinaryFallbackReason: context.ordinaryFallbackReason }),
                ...(options.db === undefined ? {} : { db: options.db }),
              });
              if (!published) {
                logger.warn("[stenographer] compaction lease/candidate changed", {
                  stage: "compaction",
                });
                return unavailable();
              }
              const metrics = {
                selectedEvents: claim.plan.selectedEvents.length,
                throughEventSequence: claim.plan.throughEventSequence,
                modelId,
              };
              logger.info("[stenographer] compaction completed", metrics);
              return outcome("completed", metrics);
            } catch {
              logger.warn("[stenographer] compaction publication failed", {
                stage: "compaction",
                failureDetail: "compaction_publication_failed",
              });
              await failCompactionWork({
                claim,
                errorCode: "persistence",
                modelId,
                now: currentTime(input.now),
                ...(options.db === undefined ? {} : { db: options.db }),
              });
              return outcome(input.signal.aborted ? "cancelled" : "failed");
            }
          },
        };
      } catch (error) {
        await failCompactionWork({
          claim,
          errorCode: mapModelFailure(error) as StenographerErrorCode,
          modelId,
          now: currentTime(input.now),
          ...(options.db === undefined ? {} : { db: options.db }),
        });
        return { publish: () => Promise.resolve(
          outcome(input.signal.aborted ? "cancelled" : "failed"),
        ) };
      }
    },

    prepareNextRebuild(input: StenographerRebuildAdapterInput) {
      return Promise.resolve({
        publish: async () => {
          const roomId = await prepareRebuild({ now: input.now });
          return roomId === null
            ? unavailable()
            : Object.freeze({
              status: "prepared_rebuild" as const,
              processed: true as const,
              roomId,
            });
        },
      });
    },

    prepareLegacyConversion(
      input: StenographerLegacyConversionAdapterInput,
    ) {
      return Promise.resolve({
        publish: async () => {
          if (options.convertNextLegacy === undefined) return unavailable();
          const conversion = await options.convertNextLegacy({
            now: currentTime(input.now),
          });
          return conversion.roomId === null
            ? unavailable()
            : outcome("completed", {
              converted: conversion.converted,
              completedRoom: conversion.completedRoom ? 1 : 0,
            });
        },
      });
    },
  });
}
