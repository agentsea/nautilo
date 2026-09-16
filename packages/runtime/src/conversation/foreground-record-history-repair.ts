import {
  createForegroundAgentObjectRepairer,
  type ForegroundAgentEntityCryptoInvocation,
  type ForegroundRecordContextItem,
  type ForegroundRecordHistoryResult,
  type ForegroundRecordSourceSelection,
  type PreparedDeviceWrappedAgentObject,
  type VerifiedForegroundAgentObject,
} from "@nautilo/lattice-bridge";
import {
  FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
  isForegroundAuthorityConvergingError,
  isForegroundProductChangedError,
  type ForegroundRecordRepairSource,
} from "@nautilo/lattice-bridge/server";
import type {
  AgentRuntimeKeyGeneration,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { decodeRecordPayloadV1, encodeRecordPayloadV1 } from "@nautilo/reflection-bridge";

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function deterministicForegroundRecordObjectId(
  crypto: LatticeCrypto,
  source: Readonly<{
    recordRef: string;
    representationGeneration: number;
    ordinaryRepresentationGeneration: number;
    authorityProjectionGeneration: number;
    lifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset";
    structuralHeight: number;
    processingGeneration: number;
    accessNamespaceIds: readonly string[];
  }>,
): string {
  const coordinates = new TextEncoder().encode(JSON.stringify([
    "nautilo-reflection-record-v2",
    source.recordRef,
    source.representationGeneration,
    source.ordinaryRepresentationGeneration,
    source.authorityProjectionGeneration,
    source.lifecycle,
    source.structuralHeight,
    source.processingGeneration,
    source.accessNamespaceIds,
  ]));
  try {
    const digest = crypto.hash(coordinates);
    try {
      return `reflection-record-v2:${hex(digest)}`;
    } finally {
      digest.fill(0);
    }
  } finally {
    coordinates.fill(0);
  }
}

function repairCommitment(input: Readonly<{
  crypto: LatticeCrypto;
  source: ForegroundRecordRepairSource;
  objectId: string;
}>): Uint8Array {
  if (input.source.plaintextBytes === null) {
    throw new TypeError("Record ordinary source is unavailable");
  }
  const coordinates = new TextEncoder().encode(
    `nautilo.foreground-record-repair.v1\0${input.source.recordRef}\0${input.objectId}\0`,
  );
  const bytes = new Uint8Array(
    coordinates.length + input.source.plaintextBytes.length,
  );
  bytes.set(coordinates);
  bytes.set(input.source.plaintextBytes, coordinates.length);
  try {
    return input.crypto.hash(bytes);
  } finally {
    coordinates.fill(0);
    bytes.fill(0);
  }
}

/** Protect and reopen the exact Reflection Records selected for one prompt. */
export function createForegroundRecordHistoryRepairer(input: Readonly<{
  crypto: LatticeCrypto;
  entities: Pick<
    ForegroundAgentEntityCryptoInvocation,
    "signal" | "use" | "useCurrentSet"
  >;
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
  sourceRepresentationMode?: "ordinary-and-protected" | "protected-only";
  loadSources(
    records: readonly ForegroundRecordSourceSelection[],
    representationMode?: "ordinary-and-protected" | "protected-only",
  ): Promise<readonly ForegroundRecordRepairSource[]>;
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
    source: ForegroundRecordRepairSource;
    objectId: string;
  }>): Promise<boolean>;
  attach(request: Readonly<{
    source: ForegroundRecordRepairSource;
    objectId: string;
    publicationId: string;
    requestCommitment: Uint8Array;
    publicationBindingRef: string;
  }>): Promise<"attached" | "replayed" | "conflict">;
  restoreOrdinary?(request: Readonly<{
    source: ForegroundRecordRepairSource;
    objectId: string;
    payloadBytes: Uint8Array;
    expectedPolicyRevision: number;
  }>): Promise<"restored" | "replayed" | "conflict">;
}>): Readonly<{
  protect(request: Readonly<{
    records: readonly ForegroundRecordSourceSelection[];
    signal?: AbortSignal;
  }>): Promise<ForegroundRecordHistoryResult>;
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
      let sources: readonly ForegroundRecordRepairSource[] = [];
      try {
        sources = await input.loadSources(
          request.records,
          input.sourceRepresentationMode ?? "ordinary-and-protected",
        );
        if (cancelled()) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "cancelled",
        });
        if (
          sources.length !== request.records.length
          || sources.some((source, index) =>
            source.recordRef !== request.records[index]?.recordRef
          )
        ) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "record_product_changed",
        });
        if (
          input.sourceRepresentationMode === "protected-only"
          && sources.some((source) => source.plaintextBytes !== null)
        ) return Object.freeze({
          status: "failed" as const,
          reason: "ordinary_source_forbidden",
        });
        const records: ForegroundRecordContextItem[] = [];
        let repairedCount = 0;
        let ordinaryRestoredCount = 0;
        let independentlyComparedCount = 0;
        for (const source of sources) {
          if (cancelled()) return Object.freeze({
            status: "waiting_for_authority" as const,
            reason: "cancelled",
          });
          const protectedObject = await objects.protect({
            source: {
              objectId: deterministicForegroundRecordObjectId(
                input.crypto,
                source,
              ),
              objectType: FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
              existingObjectId: source.existingObjectId,
              createdAt: source.createdAt,
              namespaceIds: source.accessNamespaceIds,
              plaintextBytes: source.plaintextBytes,
            },
            decode: (bytes) => decodeRecordPayloadV1(bytes),
          });
          if (protectedObject.status !== "verified") return Object.freeze({
            status: protectedObject.status,
            reason: protectedObject.reason,
          });
          if (cancelled()) return Object.freeze({
            status: "waiting_for_authority" as const,
            reason: "cancelled",
          });
          if (
            source.expectedStatement !== null
            && protectedObject.value.statement !== source.expectedStatement
          ) {
            return Object.freeze({
              status: "failed" as const,
              reason: "record_statement_parity_mismatch",
            });
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
            const bytes = encodeRecordPayloadV1(protectedObject.value);
            try {
              const restored = await input.restoreOrdinary({
                source, objectId: protectedObject.objectId,
                payloadBytes: bytes,
                expectedPolicyRevision: input.publication.policyRevision,
              });
              if (restored === "conflict") return Object.freeze({
                status: "waiting_for_authority" as const,
                reason: "record_product_changed",
              });
              ordinaryRestoredCount += 1;
            } finally { bytes.fill(0); }
          }
          if (
            source.existingObjectId !== null
            && !await input.validateExisting({
              source,
              objectId: protectedObject.objectId,
            })
          ) return Object.freeze({
            status: "waiting_for_authority" as const,
            reason: "record_product_changed",
          });
          if (source.existingObjectId === null) {
            if (source.plaintextBytes === null) return Object.freeze({
              status: "failed" as const,
              reason: "protected_representation_missing",
            });
            const commitment = repairCommitment({
              crypto: input.crypto,
              source,
              objectId: protectedObject.objectId,
            });
            try {
              const attached = await input.attach({
                source,
                objectId: protectedObject.objectId,
                publicationId:
                  `foreground-record-repair:${base64url(commitment)}`,
                requestCommitment: commitment,
                publicationBindingRef:
                  `foreground:record-authority:${source.recordRef}:${source.authorityProjectionGeneration}:protected:v1`,
              });
              if (attached === "conflict") return Object.freeze({
                status: "waiting_for_authority" as const,
                reason: "record_product_changed",
              });
              repairedCount += 1;
            } finally {
              commitment.fill(0);
            }
          }
          records.push(Object.freeze({
            recordRef: source.recordRef,
            statement: protectedObject.value.statement,
            lifecycle: source.lifecycle,
            structuralHeight: source.structuralHeight,
          }));
        }
        return Object.freeze({
          status: "verified" as const,
          records: Object.freeze(records),
          provenance: repairedCount > 0
            ? "repaired" as const
            : "existing" as const,
          repairedCount,
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
            ? "record_authority_converging"
            : "record_product_changed",
        });
        return Object.freeze({
          status: "failed" as const,
          reason: "record_repair_failed",
        });
      } finally {
        sources.forEach((source) => source.plaintextBytes?.fill(0));
      }
    },
  });
}
