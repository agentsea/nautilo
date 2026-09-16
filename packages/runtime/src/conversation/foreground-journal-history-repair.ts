import {
  PROTECTED_JOURNAL_MAX_CONTEXT_BYTES,
  assertRoomEventPayloadBindingV1,
  assertRoomEventRollupPayloadBindingV1,
  createForegroundAgentObjectRepairer,
  decodeRoomEventPayloadV1,
  decodeRoomEventRollupPayloadV1,
  type ForegroundAgentEntityCryptoInvocation,
  type ForegroundJournalHistoryResult,
  type ForegroundJournalSelectionPort,
  type PreparedDeviceWrappedAgentObject,
  type VerifiedForegroundAgentObject,
} from "@nautilo/lattice-bridge";
import {
  FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
  isForegroundAuthorityConvergingError,
  isForegroundProductChangedError,
  type ForegroundJournalRepairSource,
} from "@nautilo/lattice-bridge/server";
import type {
  AgentRuntimeKeyGeneration,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { decodeRecordPayloadV1, encodeRecordPayloadV1 } from "@nautilo/reflection-bridge";
import {decodeDurableRecordEnvelope, assertStenographerRecordPayloadBinding} from "@nautilo/reflection-bridge/server";

import type { RoomJournalContext } from "../context/build-transcript-context";
import { roomJournalContextByteLength } from "../context/room-journal-context-budget";
import { deterministicForegroundRecordObjectId } from
  "./foreground-record-history-repair";

export type { ForegroundJournalHistoryResult };

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function deterministicObjectId(
  crypto: LatticeCrypto,
  source: ForegroundJournalRepairSource,
  rebuildGeneration: number,
): string {
  if (source.existingObjectId !== null) return source.existingObjectId;
  if (source.objectType === FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE) {
    const selected = source.selection;
    if (
      selected.kind !== "event"
      || selected.payload.kind !== "reflection_record"
      || source.ordinaryRepresentationGeneration === null
      || (source.authorityKind !== "journal_source" && source.authorityProjectionGeneration === null)
    ) throw new TypeError("Native Journal Record identity is incomplete");
    if (source.authorityKind === "journal_source") {
      const coordinates = new TextEncoder().encode(JSON.stringify([
        "nautilo/foreground-journal-record-repair/v1", source.logicalId,
        selected.binding.roomId, selected.binding.namespaceId, rebuildGeneration,
        source.representationGeneration, source.ordinaryRepresentationGeneration,
        selected.payload.lifecycle, selected.payload.structuralHeight,
        selected.payload.processingGeneration,
      ]));
      try {return `foreground-journal-record-v1:${hex(crypto.hash(coordinates))}`;}
      finally {coordinates.fill(0);}
    }
    return deterministicForegroundRecordObjectId(crypto, {
      recordRef: source.logicalId,
      representationGeneration: source.representationGeneration,
      ordinaryRepresentationGeneration:
        source.ordinaryRepresentationGeneration,
      authorityProjectionGeneration: source.authorityProjectionGeneration!,
      lifecycle: selected.payload.lifecycle,
      structuralHeight: selected.payload.structuralHeight,
      processingGeneration: selected.payload.processingGeneration,
      accessNamespaceIds: source.accessNamespaceIds,
    });
  }
  const coordinates = new TextEncoder().encode(
    `nautilo/foreground-journal-repair/v1\n${source.objectType}\n${source.logicalId}\n${rebuildGeneration}`,
  );
  try {
    const digest = crypto.hash(coordinates);
    try {
      return `foreground-journal-v1:${hex(digest)}`;
    } finally {
      digest.fill(0);
    }
  } finally {
    coordinates.fill(0);
  }
}

function repairCommitment(input: Readonly<{
  crypto: LatticeCrypto;
  logicalId: string;
  objectId: string;
  plaintextBytes: Uint8Array;
}>): Uint8Array {
  const coordinates = new TextEncoder().encode(
    `nautilo.foreground-record-repair.v1\0${input.logicalId}\0${input.objectId}\0`,
  );
  const bytes = new Uint8Array(
    coordinates.length + input.plaintextBytes.length,
  );
  bytes.set(coordinates);
  bytes.set(input.plaintextBytes, coordinates.length);
  try {
    return input.crypto.hash(bytes);
  } finally {
    coordinates.fill(0);
    bytes.fill(0);
  }
}

/** Journal/Reflection product adapter over the one generic entity repairer. */
export function createForegroundJournalHistoryRepairer(input: Readonly<{
  crypto: LatticeCrypto;
  entities: Pick<
    ForegroundAgentEntityCryptoInvocation,
    "signal" | "use" | "useCurrentSet"
  >;
  room: Readonly<{ roomId: string; namespaceId: string }>;
  sourceRepresentationMode?: "ordinary-and-protected" | "protected-only";
  publication: Readonly<{
    operationId: string;
    grantId: string;
    grantDigest: Uint8Array;
    recipientKeyId: string;
    runtime: AgentRuntimeKeyGeneration;
    signerKeyId: string;
    signerPublicKey: Uint8Array;
    agentAuthorizationRevision: number;
    policyRevision?: number;
  }>;
  selection: ForegroundJournalSelectionPort;
  loadSources(snapshot: NonNullable<
    Awaited<ReturnType<ForegroundJournalSelectionPort["selectCurrent"]>>
  >, representationMode?: "ordinary-and-protected" | "protected-only"):
    Promise<readonly ForegroundJournalRepairSource[]>;
  persist(prepared: PreparedDeviceWrappedAgentObject): Promise<
    "created" | "duplicate" | "stale"
  >;
  read(request: Readonly<{
    objectId: string;
    expectedObjectType: string;
    expectedAccessRevision?: number;
    expectedNamespaceIds: readonly string[];
  }>): Promise<VerifiedForegroundAgentObject | null>;
  validateExisting(request: Readonly<{
    source: ForegroundJournalRepairSource;
    objectId: string;
  }>): Promise<boolean>;
  attach(request: Readonly<{
    source: ForegroundJournalRepairSource;
    objectId: string;
    publicationId: string;
    requestCommitment: Uint8Array;
    publicationBindingRef: string;
  }>): Promise<"attached" | "replayed" | "conflict">;
  restoreOrdinary?(request: Readonly<{
    source: ForegroundJournalRepairSource;
    objectId: string;
    ordinaryText?: string;
    payloadBytes?: Uint8Array;
    expectedPolicyRevision: number;
  }>): Promise<"restored" | "replayed" | "conflict">;
}>): Readonly<{
  protect(request: Readonly<{
    maximumEvents: number;
    signal?: AbortSignal;
  }>): Promise<ForegroundJournalHistoryResult>;
}> {
  const objects = createForegroundAgentObjectRepairer({
    crypto: input.crypto,
    entities: input.entities,
    publication: input.publication,
    persist: input.persist,
    read: input.read,
  });
  return Object.freeze({
    protect: async (request) => {
      const cancelled = (): boolean => request.signal?.aborted ?? false;
      if (cancelled()) return Object.freeze({
        status: "waiting_for_authority" as const,
        reason: "cancelled",
      });
      let sources: readonly ForegroundJournalRepairSource[] = [];
      let selectedCount = 0;
      try {
        const snapshot = await input.selection.selectCurrent({
          roomId: input.room.roomId,
          namespaceId: input.room.namespaceId,
          maximumEvents: request.maximumEvents,
        });
        if (cancelled()) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "cancelled",
          selectedCount,
        });
        if (snapshot === null) return Object.freeze({
          status: "verified" as const,
          journal: { rollup: null, events: [] },
          provenance: "existing" as const,
          repairedCount: 0,
          includesReflectionRecord: false,
          verification: "independent_parity" as const,
          ordinaryRestoredCount: 0,
        });
        selectedCount = snapshot.events.length
          + (snapshot.rollup === null ? 0 : 1);
        sources = await input.loadSources(
          snapshot,
          input.sourceRepresentationMode ?? "ordinary-and-protected",
        );
        if (cancelled()) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "cancelled",
          selectedCount,
        });
        if (sources.length !== selectedCount) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "journal_product_changed",
          selectedCount,
        });
        if (
          input.sourceRepresentationMode === "protected-only"
          && sources.some((source) => source.plaintextBytes !== null)
        ) return Object.freeze({
          status: "failed" as const,
          reason: "ordinary_source_forbidden",
          selectedCount,
        });
        if (sources.some((source) =>
          source.selection.kind === "event"
          && source.selection.payload.kind === "legacy_event"
          && source.existingObjectId === null
        )) return Object.freeze({
          status: "unsupported" as const,
          reason: "legacy_journal_protected_representation_unavailable",
          selectedCount,
        });
        let repairedCount = 0;
        let ordinaryRestoredCount = 0;
        let independentlyComparedCount = 0;
        let rollup: RoomJournalContext["rollup"] = null;
        const events: RoomJournalContext["events"] = [];
        for (const source of sources) {
          if (cancelled()) return Object.freeze({
            status: "waiting_for_authority" as const,
            reason: "cancelled",
            selectedCount,
          });
          const protectedObject = await objects.protect({
            source: {
              objectId: deterministicObjectId(
                input.crypto,
                source,
                snapshot.rebuildGeneration,
              ),
              objectType: source.objectType,
              existingObjectId: source.existingObjectId,
              createdAt: source.createdAt,
              namespaceIds: source.accessNamespaceIds,
              plaintextBytes: source.plaintextBytes,
            },
            decode: (bytes) => {
              if (source.selection.kind === "rollup") {
                const payload = decodeRoomEventRollupPayloadV1(bytes);
                assertRoomEventRollupPayloadBindingV1(
                  payload,
                  source.selection.binding,
                );
                return Object.freeze({ kind: "rollup" as const, payload });
              }
              if (source.selection.payload.kind === "legacy_event") {
                const payload = decodeRoomEventPayloadV1(bytes);
                assertRoomEventPayloadBindingV1(
                  payload,
                  source.selection.binding,
                );
                return Object.freeze({ kind: "event" as const, payload });
              }
              if (source.authorityKind === "journal_source") {
                const selected = source.selection;
                if (selected.payload.kind !== "reflection_record") {
                  throw new Error("Native Journal source must select a Record payload");
                }
                const envelope = decodeDurableRecordEnvelope({
                  recordRef: selected.payload.recordId, lifecycle: selected.payload.lifecycle,
                  structuralHeight: selected.payload.structuralHeight,
                  processingGeneration: selected.payload.processingGeneration, payloadBytes: bytes,
                });
                assertStenographerRecordPayloadBinding(envelope, {
                  eventId: selected.binding.eventId, roomId: selected.binding.roomId,
                  namespaceId: selected.binding.namespaceId, kind: selected.binding.kind,
                  status: selected.status, sourceMessageIds: selected.binding.sourceMessageIds,
                  extractorVersion: selected.binding.extractorVersion,
                  publicationGeneration: selected.rebuildGeneration + 1,
                });
                return Object.freeze({
                  kind: "record" as const,
                  payload: decodeRecordPayloadV1(bytes),
                });
              }
              return Object.freeze({
                kind: "record" as const,
                payload: decodeRecordPayloadV1(bytes),
              });
            },
          });
          if (protectedObject.status !== "verified") return Object.freeze({
            status: protectedObject.status,
            reason: protectedObject.reason,
            selectedCount,
          });
          if (cancelled()) return Object.freeze({
            status: "waiting_for_authority" as const,
            reason: "cancelled",
            selectedCount,
          });
          if (
            source.existingObjectId !== null
            && !await input.validateExisting({
              source,
              objectId: protectedObject.objectId,
            })
          ) return Object.freeze({
            status: "waiting_for_authority" as const,
            reason: "journal_product_changed",
            selectedCount,
          });
          if (source.existingObjectId === null) {
            if (source.plaintextBytes === null) return Object.freeze({
              status: "failed" as const,
              reason: "protected_representation_missing",
              selectedCount,
            });
            const commitment = repairCommitment({
              crypto: input.crypto,
              logicalId: source.logicalId,
              objectId: protectedObject.objectId,
              plaintextBytes: source.plaintextBytes,
            });
            try {
              const attached = await input.attach({
                source,
                objectId: protectedObject.objectId,
                publicationId:
                  `foreground-record-repair:${base64url(commitment)}`,
                requestCommitment: commitment,
                publicationBindingRef:
                  source.authorityProjectionGeneration === null
                    ? `foreground:${snapshot.namespaceId}:protected:v1`
                    : `foreground:record-authority:${source.logicalId}:${source.authorityProjectionGeneration}:protected:v1`,
              });
              if (attached === "conflict") return Object.freeze({
                status: "waiting_for_authority" as const,
                reason: "journal_product_changed",
                selectedCount,
              });
              repairedCount += 1;
            } finally {
              commitment.fill(0);
            }
          }
          if (source.plaintextBytes !== null && source.existingObjectId !== null) {
            independentlyComparedCount += 1;
          }
          if (
            source.plaintextBytes === null && source.existingObjectId !== null
            && input.restoreOrdinary !== undefined
            && input.publication.policyRevision !== undefined
            && input.sourceRepresentationMode !== "protected-only"
          ) {
            const recordBytes = protectedObject.value.kind === "record"
              ? encodeRecordPayloadV1(protectedObject.value.payload)
              : undefined;
            try {
              const restored = await input.restoreOrdinary({
                source,
                objectId: protectedObject.objectId,
                ...(recordBytes === undefined
                  ? { ordinaryText: protectedObject.value.kind === "rollup"
                    ? protectedObject.value.payload.content
                    : protectedObject.value.payload.statement }
                  : { payloadBytes: recordBytes }),
                expectedPolicyRevision: input.publication.policyRevision,
              });
              if (restored === "conflict") return Object.freeze({
                status: "waiting_for_authority" as const,
                reason: "journal_product_changed",
                selectedCount,
              });
              ordinaryRestoredCount += 1;
            } finally { recordBytes?.fill(0); }
          }
          const selected = source.selection;
          if (protectedObject.value.kind === "rollup") {
            rollup = Object.freeze({
              throughEventSequence:
                protectedObject.value.payload.throughEventSequence,
              content: protectedObject.value.payload.content,
            });
          } else {
            if (selected.kind !== "event") {
              throw new TypeError("Journal event selection is invalid");
            }
            events.push(Object.freeze({
              id: selected.binding.eventId,
              roomId: selected.binding.roomId,
              sequence: selected.binding.sequence,
              kind: selected.binding.kind,
              statement: protectedObject.value.payload.statement,
              status: selected.status,
              supersedesEventId: selected.binding.supersedesEventId,
              resolvesEventId: selected.binding.resolvesEventId,
            }));
          }
        }
        if (roomJournalContextByteLength({ rollup, events }) > PROTECTED_JOURNAL_MAX_CONTEXT_BYTES) {
          return Object.freeze({
            status: "failed" as const,
            reason: "journal_selection_oversized",
            selectedCount,
          });
        }
        return Object.freeze({
          status: "verified" as const,
          journal: { rollup, events },
          provenance: repairedCount > 0
            ? "repaired" as const
            : "existing" as const,
          repairedCount,
          includesReflectionRecord: sources.some(
            (source) =>
              source.objectType === FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
          ),
          verification: independentlyComparedCount === sources.length
            ? "independent_parity" as const : "authenticated" as const,
          ordinaryRestoredCount,
        });
      } catch (error) {
        if (
          isForegroundAuthorityConvergingError(error)
          || isForegroundProductChangedError(error)
        ) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: isForegroundAuthorityConvergingError(error)
            ? "journal_authority_converging"
            : "journal_product_changed",
          selectedCount,
        });
        return Object.freeze({
          status: "failed" as const,
          reason: "journal_repair_failed",
          selectedCount,
        });
      } finally {
        sources.forEach((source) => source.plaintextBytes?.fill(0));
      }
    },
  });
}
