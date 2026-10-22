import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createAgentMemoryProjectionContinuationCapsule,
  type AgentMemoryProjectionContinuationCapsule,
  ForegroundAgentEntityCryptoInvocation,
} from "@nautilo/lattice-bridge";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";

/** Encrypted checkpoint payload, not a second store or a reusable capability.
 * The Namespace gateway owns all key access and revocation checks. */
export function createForegroundMemoryProjectionCapsule(input: Readonly<{
  crypto: LatticeCrypto;
  entities: Pick<ForegroundAgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet">;
  namespaceId: string;
  envelope: NamespaceMemoryEnvelope;
  policyRevision: number;
  agentAuthorizationRevision: number;
}>): AgentMemoryProjectionContinuationCapsule {
  return createAgentMemoryProjectionContinuationCapsule({
    crypto: input.crypto,
    entities: input.entities,
    namespaceId: input.namespaceId,
    identity: Object.freeze({
      kind: "foreground_v1" as const,
      ownerId: input.envelope.ownerId,
      actorId: input.envelope.actorId,
      agentId: input.envelope.agentId,
      roomId: input.envelope.roomId,
      readableNamespaceIds: input.envelope.readableNamespaces,
      mutableNamespaceIds: input.envelope.mutableNamespaces,
      writableNamespaceIds: input.envelope.writableNamespaces,
      policyRevision: input.policyRevision,
      agentAuthorizationRevision: input.agentAuthorizationRevision,
    }),
  });
}
