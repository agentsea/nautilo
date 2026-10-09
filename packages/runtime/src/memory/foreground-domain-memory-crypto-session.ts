import {
  createForegroundAgentObjectRepairer,
  type AgentObjectProtectionResult,
  type AgentObjectProtectionSource,
  type AgentObjectProtector,
  type AtomicMemoryCryptoCompletionPort,
  type ForegroundAgentEntityCryptoInvocation,
  type MemoryPayloadV1,
  type PreparedDeviceWrappedAgentObject,
  type PreparedMemoryCryptoRevision,
  type ProtectedAgentMemoryCryptoSessionPort,
  type VerifiedForegroundAgentObject,
} from "@nautilo/lattice-bridge";
import type { AgentRuntimeKeyGeneration, LatticeCrypto } from
  "@nautilo/lattice-crypto";

import { createDomainMemoryCryptoSession } from
  "./domain-memory-crypto-session";

type EntrypointId = Parameters<
  ProtectedAgentMemoryCryptoSessionPort["openMany"]
>[0]["entrypointId"];

/** Foreground publication adapter for the neutral Domain Memory session. */
export function createForegroundDomainMemoryCryptoSession(input: Readonly<{
  subjectUserId: string;
  agentId: string;
  entrypointId: EntrypointId;
  crypto: LatticeCrypto;
  entities: Pick<
    ForegroundAgentEntityCryptoInvocation,
    "signal" | "use" | "useCurrentSet"
  >;
  publication: Readonly<{
    /** Accepted foreground invocation authorizing the cryptographic write. */
    authorizationOperationId: string;
    grantId: string;
    grantDigest: Uint8Array;
    recipientKeyId: string;
    runtime: AgentRuntimeKeyGeneration;
    signerKeyId: string;
    signerPublicKey: Uint8Array;
    agentAuthorizationRevision: number;
  }>;
  persist(prepared: PreparedDeviceWrappedAgentObject): Promise<
    "created" | "duplicate" | "stale"
  >;
  read(request: Readonly<{
    objectId: string;
    expectedObjectType: string;
    expectedAccessRevision?: number;
    expectedNamespaceIds: readonly string[];
  }>): Promise<VerifiedForegroundAgentObject | null>;
}>): Readonly<{
  session: ProtectedAgentMemoryCryptoSessionPort;
  completion: Pick<AtomicMemoryCryptoCompletionPort, "complete">;
  /** Transient verified bytes for the policy-permitted ordinary Shadow sibling. */
  readPreparedPayload(revision: PreparedMemoryCryptoRevision): MemoryPayloadV1;
}> {
  const objects: AgentObjectProtector = Object.freeze({
    protect: <Value>(request: Readonly<{
      operationId: string;
      source: AgentObjectProtectionSource;
      decode(plaintextBytes: Uint8Array): Value;
    }>): Promise<AgentObjectProtectionResult<Value>> =>
      createForegroundAgentObjectRepairer({
        crypto: input.crypto,
        entities: input.entities,
        publication: {
          operationId: request.operationId,
          grantId: input.publication.grantId,
          grantDigest: input.publication.grantDigest,
          recipientKeyId: input.publication.recipientKeyId,
          runtime: input.publication.runtime,
          signerKeyId: input.publication.signerKeyId,
          signerPublicKey: input.publication.signerPublicKey,
          agentAuthorizationRevision:
            input.publication.agentAuthorizationRevision,
        },
        persist: input.persist,
        read: input.read,
      }).protect<Value>({
        source: request.source,
        decode: request.decode,
      }),
  });

  return createDomainMemoryCryptoSession({
    subjectUserId: input.subjectUserId,
    agentId: input.agentId,
    entrypointId: input.entrypointId,
    entities: input.entities,
    objects,
    prepareOperationId: input.publication.authorizationOperationId,
  });
}
