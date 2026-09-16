import type {DurableSleepClaim, DurableSleepReadinessResult} from "@nautilo/reflection/durable";
import {decodeRecordPayloadV1, type RecordPayloadV1} from "@nautilo/reflection/payload";
import {
  RECORD_SEARCH_POLICY_V1, assertRecordEmbeddingProvenanceV1, assertRecordEmbeddingRequest,
  validateRecordSearchProjectionV1,
  type RecordEmbeddingPort, type RecordEmbeddingProvenanceV1, type RecordSearchProjectionV1,
} from "@nautilo/reflection/search";
import type {BackgroundReflectionSemanticInputBindingV2} from "@nautilo/lattice-crypto/background";
import {ClassifiedDataOperationError} from "../../transition/encryption-data-operation-owner.ts";
import type {CurrentProcessorHeldAuthority} from "../storage/postgres-current-processor-transform-object-port.ts";
import type {ReflectionSemanticOperationPort} from "./semantic-operation.ts";

/** Metadata only; confidential payload and vectors are never accepted from this resolver. */
export interface ProtectedReflectionSearchMetadata {
  readonly recordRef: string;
  readonly processingGeneration: number;
  readonly representationGeneration: number;
  readonly producerPolicyVersion: string;
  readonly lifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset";
  readonly inputBinding: BackgroundReflectionSemanticInputBindingV2;
  readonly expectedEmbeddingProvenance: RecordEmbeddingProvenanceV1;
  readonly currentProjection: Readonly<{
    recordRef: string; recordProcessingGeneration: number; projectionVersion: number; projectionGeneration: number;
    embeddingProvider: string; embeddingCanonicalModel: string; embeddingDimensions: number; embeddingContractVersion: number;
  }> | null;
}

export interface ProtectedReflectionSearchProjectionPorts {
  readonly operation: ReflectionSemanticOperationPort;
  readonly embedding: RecordEmbeddingPort;
  /** Resolves currently eligible protected metadata, including the exact selected Namespace. */
  readonly resolveMetadata: (claim: DurableSleepClaim, signal?: AbortSignal) => Promise<ProtectedReflectionSearchMetadata | null>;
  /** Uses the existing search store within this held product transaction and the exact live claim/source fence. */
  readonly publish: (input: Readonly<{
    claim: DurableSleepClaim; metadata: ProtectedReflectionSearchMetadata; projection: RecordSearchProjectionV1;
    expectedProjectionGeneration: number | null; held: CurrentProcessorHeldAuthority;
    authorizeCommit: () => Promise<number>; signal: AbortSignal;
  }>) => Promise<"published" | "replayed" | "replaced" | "record_unavailable" | "stale" | "conflict">;
  /** Reuses the caller's reviewed durable eligibility schedule. */
  readonly nextRetryAt: () => number;
}

class EmbeddingWait extends Error {}
const stale = () => new ClassifiedDataOperationError("stale", "Protected Reflection search metadata changed");
const integrity = () => new ClassifiedDataOperationError("integrity", "Protected Reflection search input or embedding is invalid");

function currentProjectionMatches(metadata: ProtectedReflectionSearchMetadata): boolean {
  const projection = metadata.currentProjection;
  const expected = metadata.expectedEmbeddingProvenance;
  return projection !== null && projection.recordRef === metadata.recordRef
    && Number.isSafeInteger(projection.projectionGeneration) && projection.projectionGeneration > 0
    && projection.recordProcessingGeneration === metadata.processingGeneration
    && projection.projectionVersion === RECORD_SEARCH_POLICY_V1.projectionVersion
    && projection.embeddingProvider === expected.provider && projection.embeddingCanonicalModel === expected.canonicalModel
    && projection.embeddingDimensions === expected.dimensions && projection.embeddingContractVersion === expected.contractVersion;
}

function sourceCoordinate(metadata: ProtectedReflectionSearchMetadata): string {
  return JSON.stringify([metadata.recordRef, metadata.processingGeneration, metadata.representationGeneration, metadata.producerPolicyVersion,
    metadata.lifecycle, metadata.inputBinding.objectId, metadata.inputBinding.namespaceId, metadata.inputBinding.objectType,
    metadata.expectedEmbeddingProvenance.provider, metadata.expectedEmbeddingProvenance.canonicalModel,
    metadata.expectedEmbeddingProvenance.dimensions, metadata.expectedEmbeddingProvenance.contractVersion]);
}

/** Search embedding borrows one exact Record payload only inside the named Lattice gate. */
export function createProtectedReflectionSearchProjection(ports: ProtectedReflectionSearchProjectionPorts) {
  return Object.freeze({
    async ensureSearchProjection(claim: DurableSleepClaim, signal?: AbortSignal): Promise<DurableSleepReadinessResult> {
      signal?.throwIfAborted();
      if (claim.stage !== "search_projection") throw stale();
      const resolved = await ports.resolveMetadata(claim, signal);
      signal?.throwIfAborted();
      if (resolved === null) return {status: "unavailable", failureCode: "record_unavailable"};
      const metadata = structuredClone(resolved);
      if (metadata.recordRef !== claim.recordRef || metadata.lifecycle !== "current"
        || !Number.isSafeInteger(metadata.processingGeneration) || metadata.processingGeneration < 1
        || !Number.isSafeInteger(metadata.representationGeneration) || metadata.representationGeneration < 1
        || metadata.inputBinding.objectType !== "nautilo.reflection.record.v1") throw stale();
      try {assertRecordEmbeddingProvenanceV1(metadata.expectedEmbeddingProvenance);} catch {throw integrity();}
      if (currentProjectionMatches(metadata)) return {status: "ready"};
      const initialCoordinate = sourceCoordinate(metadata);
      const expectedProjectionGeneration = metadata.currentProjection?.projectionGeneration ?? null;
      let closed = false, executed = false, attached = false;
      let projection: RecordSearchProjectionV1 | undefined;
      let vector: number[] | undefined;
      const wipe = () => {vector?.fill(0); vector = undefined; projection = undefined;};
      const active = (currentSignal?: AbortSignal) => {
        signal?.throwIfAborted(); currentSignal?.throwIfAborted();
        if (closed) throw new ClassifiedDataOperationError("cancelled", "Protected Reflection search attempt is closed");
      };
      const verifyMetadata = async (currentSignal: AbortSignal) => {
        active(currentSignal);
        const current = await ports.resolveMetadata(claim, currentSignal);
        active(currentSignal);
        if (current === null || sourceCoordinate(current) !== initialCoordinate
          || (current.currentProjection?.projectionGeneration ?? null) !== expectedProjectionGeneration) throw stale();
      };
      const decode = (bytes: Uint8Array): RecordPayloadV1 => {
        try {
          const payload = decodeRecordPayloadV1(bytes);
          if (payload.producer.policyVersion !== metadata.producerPolicyVersion) throw integrity();
          return payload;
        } catch {throw integrity();}
      };
      const waiting = (): DurableSleepReadinessResult => {
        const retryAt = ports.nextRetryAt();
        if (!Number.isSafeInteger(retryAt) || retryAt <= 0) throw new TypeError("Reflection retry eligibility must be a positive timestamp");
        return {status: "waiting", retryAt};
      };
      signal?.addEventListener("abort", wipe, {once: true});
      try {
        const result = await ports.operation.runSemantic({workKind: "reflection.search_projection",
          coordinates: {recordRef: claim.recordRef, claimGeneration: claim.generation, inputBindings: [metadata.inputBinding], outputNamespaceIds: []},
          ...(signal === undefined ? {} : {signal}),
          validateInput: async input => {
            await verifyMetadata(input.signal);
            if (input.objectId !== metadata.inputBinding.objectId || input.namespaceId !== metadata.inputBinding.namespaceId
              || input.objectType !== metadata.inputBinding.objectType) throw integrity();
            decode(input.plaintext);
          },
          validateOutput: () => Promise.reject(integrity()),
          execute: async (inputs, outputObjectId, executionSignal) => {
            active(executionSignal);
            if (executed || inputs.length !== 1 || outputObjectId !== undefined) throw integrity();
            executed = true;
            const input = inputs[0]!;
            if (input.objectId !== metadata.inputBinding.objectId || input.namespaceId !== metadata.inputBinding.namespaceId
              || input.objectType !== metadata.inputBinding.objectType) throw integrity();
            await verifyMetadata(executionSignal);
            const payload = decode(input.plaintext);
            const request = {purpose: "record.statement_embedding" as const, plaintext: payload.statement, signal: executionSignal};
            try {assertRecordEmbeddingRequest(request);} catch {throw integrity();}
            const embedded = await ports.embedding.embed(request);
            active(executionSignal);
            if (embedded.status === "unavailable") {
              if (embedded.reason === "provider_unavailable") throw new EmbeddingWait();
              if (embedded.reason === "cancelled") throw new ClassifiedDataOperationError("cancelled", "Protected Reflection embedding cancelled");
              throw integrity();
            }
            vector = Array.from(embedded.embedding.vector);
            projection = {recordRef: claim.recordRef, recordProcessingGeneration: metadata.processingGeneration,
              projectionVersion: RECORD_SEARCH_POLICY_V1.projectionVersion, projectionGeneration: (expectedProjectionGeneration ?? 0) + 1,
              embedding: {provenance: {...embedded.embedding.provenance}, vector}};
            try {validateRecordSearchProjectionV1(projection);} catch {throw integrity();}
            await verifyMetadata(executionSignal);
            return null;
          },
          attach: async request => {
            active(request.signal);
            if (attached || request.output !== null || projection === undefined) throw integrity();
            await verifyMetadata(request.signal);
            let authorized = false;
            let authorizationFailure: Error | undefined;
            const result = await ports.publish({claim, metadata, projection, expectedProjectionGeneration, held: request.held, signal: request.signal,
              authorizeCommit: async () => {
                active(request.signal);
                if (authorized) {authorizationFailure = integrity(); throw authorizationFailure;} authorized = true;
                return request.authorizeCommit();
              }});
            active(request.signal);
            if (authorizationFailure !== undefined) throw authorizationFailure;
            if (!authorized) throw integrity();
            if (result !== "published" && result !== "replayed" && result !== "replaced") throw stale();
            attached = true;
          },
        });
        active();
        if (result.status === "waiting") {if (executed || attached) throw integrity(); return waiting();}
        if (result.status === "executed" && attached) return {status: "ready"};
        if (result.status === "reconciliation_required") {
          const current = await ports.resolveMetadata(claim, signal);
          active();
          if (current !== null && sourceCoordinate(current) === initialCoordinate && currentProjectionMatches(current)) return {status: "ready"};
          return {status: "unavailable", failureCode: "projection_unavailable"};
        }
        throw integrity();
      } catch (error) {
        if (error instanceof EmbeddingWait) {active(); return waiting();}
        throw error;
      } finally {
        closed = true; wipe(); signal?.removeEventListener("abort", wipe);
      }
    },
  });
}
