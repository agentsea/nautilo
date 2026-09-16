import {
  LatticeCrypto,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
  prepareHumanNamespaceRebind,
  sealNamespaceKeyring,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  createHumanMembershipRebindSubmission,
} from "../../src/delivery/human-membership-rebind-submission.ts";

export const SOURCE_DOMAIN = "domain_alice_bob";
export const TARGET_ADD_DOMAIN = "domain_alice_bob_charlie";
export const TARGET_REMOVE_DOMAIN = "domain_alice_charlie";
export const OPERATION = "membership_operation_1";
export const COMMITTER_DEVICE = "device_alice_browser";
export const COMMITTER_HUMAN = "human_alice";

export function rebindDigest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export function createHumanMembershipRebindFixture(
  reason: "human_add" | "human_remove" = "human_add",
) {
  const crypto = new LatticeCrypto(
    seededRng(reason === "human_add" ? 2321 : 2322),
  );
  const signing = crypto.generateSigningKeyPair();
  const sourceHumanRoot = rebindDigest(0x11);
  const sourceAiRoot = rebindDigest(0x12);
  const targetHumanRoot = rebindDigest(0x21);
  const targetAiRoot = rebindDigest(0x22);
  const deviceId = cryptoDeviceId(COMMITTER_DEVICE);
  const sourceDomainId = cryptoDomainId(SOURCE_DOMAIN);
  const targetDomainId = cryptoDomainId(
    reason === "human_add" ? TARGET_ADD_DOMAIN : TARGET_REMOVE_DOMAIN,
  );
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    namespaceId("namespace_room_1"),
  );
  const metadata = {
    domainId: sourceDomainId,
    domainEpoch: domainEpoch(4),
    previousBindingHash: null,
    committerDeviceId: deviceId,
  } as const;
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: sourceHumanRoot,
    keyring: keyrings.human,
    metadata,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: sourceAiRoot,
    keyring: keyrings.ai,
    metadata,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const currentBinding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const prepared = prepareHumanNamespaceRebind({
    crypto,
    reason,
    current: {
      anchor: null,
      proof: [currentBinding],
      humanEnvelope,
      aiEnvelope,
      oldHumanDomainRoot: sourceHumanRoot,
      oldAiDomainRoot: sourceAiRoot,
    },
    target: {
      domainId: targetDomainId,
      domainEpoch: domainEpoch(7),
      humanDomainRoot: targetHumanRoot,
      aiDomainRoot: targetAiRoot,
    },
    committer: {
      deviceId,
      signingPrivateKey: signing.privateKey,
    },
    resolveHistoricalCommitter: () => signing.publicKey,
    resolveSourceCommitter: () => signing.publicKey,
    resolveTargetCommitter: () => signing.publicKey,
  });
  const oldParticipantDigest = rebindDigest(
    reason === "human_add" ? 0x31 : 0x32,
  );
  const newParticipantDigest = rebindDigest(
    reason === "human_add" ? 0x32 : 0x33,
  );
  const submission = createHumanMembershipRebindSubmission({
    crypto,
    operationId: OPERATION,
    sourceDomainId,
    oldParticipantDigest,
    newParticipantDigest,
    prepared,
    committer: {
      deviceId,
      humanId: COMMITTER_HUMAN,
      signingPrivateKey: signing.privateKey,
    },
  });
  const expected = {
    operationId: OPERATION,
    kind: reason,
    sourceDomainId: SOURCE_DOMAIN,
    targetDomainId: String(targetDomainId),
    oldParticipantDigest,
    newParticipantDigest,
    expectedHead: prepared.expectedHead,
  } as const;
  const activeCommitter = () => ({
    state: "active" as const,
    deviceId: COMMITTER_DEVICE,
    humanId: COMMITTER_HUMAN,
    signingPublicKey: signing.publicKey,
  });
  return {
    activeCommitter,
    crypto,
    expected,
    keyrings,
    prepared,
    signing,
    sourceAiRoot,
    sourceHumanRoot,
    submission,
    targetAiRoot,
    targetHumanRoot,
  };
}
