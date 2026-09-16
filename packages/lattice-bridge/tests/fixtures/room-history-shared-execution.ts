import {
  accessRevision, agentId, agentRuntimeGeneration, authorizationRevision,
  cryptoDeviceId, deriveAgentRuntimeObjectSignerPublic, humanId,
  namespaceGeneration, namespaceId, unixTimestamp, type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { encodeLiveShadowMessagePlanV4 } from "@nautilo/lattice-crypto/wire";

export function sharedHistoryExecution(crypto: LatticeCrypto, input: Readonly<{
  operationId: string; sessionId: string; roomId: string; namespaceId: string;
  humanId: string; deviceId: string; agentId: string; createdAt: number;
  generation: number; accessRevision: number;
  headDigest: Uint8Array; publicationDigest: Uint8Array;
  publicationSetDigest: Uint8Array; audienceFingerprint: Uint8Array;
}>) {
  const runtime = { agentId: agentId(input.agentId), keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(4), key: new Uint8Array(32).fill(0x37) };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const digest = new Uint8Array(32).fill(0x39);
  const plan = {
    formatVersion: 4 as const, purpose: "message.live_shadow_plan" as const,
    operationId: input.operationId, policyRevision: 3,
    sessionId: input.sessionId, roomId: input.roomId, humanMessageId: 1,
    revision: 0 as const, createdAt: unixTimestamp(input.createdAt),
    subjectHumanId: humanId(input.humanId), committerDeviceId: cryptoDeviceId(input.deviceId),
    committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: authorizationRevision(7),
    recipientAgentId: runtime.agentId, agentAuthorizationRevision: authorizationRevision(9),
    agentRuntimeGeneration: runtime.generation, agentSignerKeyId: signer.principal.signerKeyId,
    agentSignerPublicKey: signer.publicKey, namespaceId: namespaceId(input.namespaceId),
    namespaceAccessRevision: accessRevision(input.accessRevision),
    namespaceKeyGeneration: namespaceGeneration(input.generation),
    namespaceHeadDigest: input.headDigest, namespacePublicationDigest: input.publicationDigest,
    namespacePublicationSetDigest: input.publicationSetDigest,
    namespaceAudienceFingerprint: input.audienceFingerprint,
    grantDomainId: "history-grant-domain", grantDomainParticipantDigest: digest,
    grantDomainKeyGeneration: 1, grantDomainHeadDigest: digest,
    grantDomainPublicationDigest: digest, grantDomainAuthorizationRevision: authorizationRevision(1),
    namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(1),
    namespaceBundleRevision: 1, namespaceBundleDigest: digest,
    authorization: { disposition: "authorization_reusable" as const,
      sessionReference: "history-foreground-session", authorizationDigest: digest },
    attemptCoordinate: "history-execution-attempt", issuedAt: unixTimestamp(input.createdAt),
    deadlineAt: unixTimestamp(input.createdAt + 30_000),
  };
  const planBytes = encodeLiveShadowMessagePlanV4(plan);
  return { runtime, signer, plan, planBytes, planDigest: crypto.hash(planBytes),
    row: {
      shared_agent_shadow_execution_id: input.operationId,
      execution_session_id: input.sessionId, execution_room_id: input.roomId,
      execution_agent_id: input.agentId, execution_plan_bytes: planBytes,
      execution_plan_digest: crypto.hash(planBytes), execution_runtime_generation: runtime.generation,
      execution_signer_key_id: signer.principal.signerKeyId,
      execution_signer_public_key: signer.publicKey,
      execution_authorized_at: new Date(input.createdAt), execution_authorization_digest: digest,
    } };
}
