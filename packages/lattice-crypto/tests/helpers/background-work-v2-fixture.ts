import type { BackgroundProcessorWorkDescriptorV2 } from "../../src/background/work-descriptor-v2.ts";

export function backgroundProcessorWorkV2Fixture(recipientPublicKey: Uint8Array): BackgroundProcessorWorkDescriptorV2 {
  return {
    formatVersion: 2, requestId: "request-1", recipientGeneration: 0,
    workKind: "stenographer.extraction", workId: "work-1",
    anchorNamespaceId: "namespace-1", anchorDomainId: "domain-1", operations: ["decrypt", "encrypt"],
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1}, purpose: "journal.extract",
    authority: {
      serverId: "server-1", roomId: "room-1", namespaceId: "namespace-1",
      namespaceAccessRevision: 2, namespaceKeyGeneration: 1,
      namespaceHeadDigest: new Uint8Array(32).fill(1), domainId: "domain-1",
      domainKeyGeneration: 3, domainAuthorizationRevision: 4,
      domainHeadDigest: new Uint8Array(32).fill(2), bundleRevision: 5,
      bundleDigest: new Uint8Array(32).fill(3),
    },
    policyRevision: 6,
    source: {kind: "stenographer_work", startSequence: 10, endSequence: 12, rebuildGeneration: 0,
      fingerprint: new Uint8Array(32).fill(4)},
    inputBindings: ["message-10", "message-12"].map(objectId => ({objectId, namespaceId: "namespace-1"})),
    outputSlots: [{objectId: "record-1", objectType: "nautilo.reflection.record.v1", createdAt: 1_700_000_000_000, namespaceIds: ["namespace-1"]}],
    maximumPlaintextBytes: 512 * 1_024, maximumCiphertextBytes: 1_024 * 1_024 + 40,
    recipientKeyId: "recipient-1", recipientPublicKey,
    issuedAt: 1_700_000_000_000, notBefore: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000, idempotencyId: "idempotency-1",
  };
}
