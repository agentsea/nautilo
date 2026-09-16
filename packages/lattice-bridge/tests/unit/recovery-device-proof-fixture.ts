import {
  LatticeCrypto,
  answerRecoveryDeviceActivationChallenge,
  assessRecoveryDeviceReadiness,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  openHumanRecoveryArchive,
  prepareRecoveryDeviceActivationChallenge,
  publishHumanRecoveryArchive,
  sealNamespaceKeyring,
  unixTimestamp,
  verifyNamespaceBindingProof,
} from "@nautilo/lattice-crypto";
import {
  deviceTransferInventoryDigestV2,
  deviceTransferInventoryRevisionV2,
  pendingDeviceRevisionV2,
  recoveryKeyGenerationV2,
  serializeRecoveryDeviceActivationProofV2,
} from "@nautilo/lattice-crypto/wire";

export async function createRecoveryDeviceProofFixture() {
  const crypto = new LatticeCrypto();
  const issuerSigning = crypto.generateSigningKeyPair();
  const pendingSigning = crypto.generateSigningKeyPair();
  const pendingEncryption = await crypto.generateEncryptionKeyPair();
  const recovery = await crypto.createRecoveryKit();
  const recoveryEncryption = await crypto.deriveEncryptionKeyPair(
    recovery.secret,
  );
  const targetHumanId = humanId("human_alice");
  const issuerDeviceId = cryptoDeviceId("device_alice_current");
  const targetDeviceId = cryptoDeviceId("device_alice_recovered");
  const targetDomainId = cryptoDomainId("domain_ab");
  const targetNamespaceId = namespaceId("namespace_room");
  const pendingRevision = pendingDeviceRevisionV2(0);
  const recoveryGeneration = recoveryKeyGenerationV2(2);
  const inventoryRevision = deviceTransferInventoryRevisionV2(8);
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    targetNamespaceId,
  );
  const metadata = {
    domainId: targetDomainId,
    domainEpoch: domainEpoch(3),
    previousBindingHash: null,
    committerDeviceId: issuerDeviceId,
  } as const;
  const humanRoot = crypto.randomBytes(32);
  const aiRoot = crypto.randomBytes(32);
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: humanRoot,
    keyring: keyrings.human,
    metadata,
    committerSigningPrivateKey: issuerSigning.privateKey,
    resolveCurrentCommitter: () => issuerSigning.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: aiRoot,
    keyring: keyrings.ai,
    metadata,
    committerSigningPrivateKey: issuerSigning.privateKey,
    resolveCurrentCommitter: () => issuerSigning.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: issuerSigning.privateKey,
    resolveCurrentCommitter: () => issuerSigning.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: null,
    proof: [binding],
    resolveHistoricalCommitter: () => issuerSigning.publicKey,
  });
  const pendingDevice = Object.freeze({
    humanId: targetHumanId,
    deviceId: targetDeviceId,
    pendingDeviceRevision: pendingRevision,
    encryptionPublicKey: pendingEncryption.publicKey,
    signingPublicKey: pendingSigning.publicKey,
  });
  const trustedPending = Object.freeze({
    humanId: targetHumanId,
    deviceId: targetDeviceId,
    pendingDeviceRevision: pendingRevision,
    encryptionPublicKeyDigest: crypto.hash(pendingEncryption.publicKey),
    signingPublicKeyDigest: crypto.hash(pendingSigning.publicKey),
    status: "pending" as const,
  });
  const resolveTrustedPendingDevice = () => trustedPending;
  const resolveTrustedCurrentRecoveryKey = () => ({
    humanId: targetHumanId,
    recoveryKeyId: recovery.keyId,
    recoveryGeneration,
    publicKeyDigest: crypto.hash(recovery.publicKey),
  });
  const sources = [{
    authorizedHumanId: targetHumanId,
    trustedNamespaceHead: trustedHead,
    keyClass: "human" as const,
    currentKeyringEnvelope: humanEnvelope,
    currentDomainRoot: humanRoot,
    resolveHistoricalCommitter: () => issuerSigning.publicKey,
  }, {
    authorizedHumanId: targetHumanId,
    trustedNamespaceHead: trustedHead,
    keyClass: "ai" as const,
    currentKeyringEnvelope: aiEnvelope,
    currentDomainRoot: aiRoot,
    resolveHistoricalCommitter: () => issuerSigning.publicKey,
  }] as const;
  const inventory = sources.map(
    ({ authorizedHumanId, trustedNamespaceHead, keyClass }) => ({
      authorizedHumanId,
      trustedNamespaceHead,
      keyClass,
    }),
  );
  const inventoryDigest = deviceTransferInventoryDigestV2({
    humanId: targetHumanId,
    inventoryRevision,
    inventory,
  });
  const inventoryCommitment = Object.freeze({
    humanId: targetHumanId,
    inventoryRevision,
    inventoryCount: inventory.length,
    inventoryDigest,
  });
  const resolveTrustedInventoryCommitment = () => inventoryCommitment;
  const archive = await publishHumanRecoveryArchive({
    crypto,
    humanId: targetHumanId,
    recoveryKeyId: recovery.keyId,
    recoveryGeneration,
    recoveryPublicKey: recovery.publicKey,
    resolveTrustedCurrentRecoveryKey,
    issuerDeviceId,
    createdAt: unixTimestamp(10_000),
    sources,
    issuerSigningPrivateKey: issuerSigning.privateKey,
    resolveIssuerDevice: () => issuerSigning.publicKey,
  });
  const archiveHash = crypto.hash(archive.archiveBytes);
  const restoredKeyrings = await openHumanRecoveryArchive({
    crypto,
    archiveBytes: archive.archiveBytes,
    humanId: targetHumanId,
    currentRecoveryKeyId: recovery.keyId,
    currentRecoveryGeneration: recoveryGeneration,
    recoveryPrivateKey: recoveryEncryption.privateKey,
    resolveTrustedCurrentRecoveryKey,
    expectedInventory: inventory,
    resolveIssuerDevice: () => issuerSigning.publicKey,
  });
  const readinessEvidence = {
    hasAuthorizedDeviceTransferSource: false,
    recoveryCredential: {
      recoveryKeyId: recovery.keyId,
      recoveryGeneration,
    },
    archiveRecoveryKey: {
      recoveryKeyId: recovery.keyId,
      recoveryGeneration,
    },
    recoveryArchiveDigest: archiveHash,
    inventoryRevision,
    resolveTrustedInventoryCommitment,
    inventory,
    restoredKeyrings,
    liveDomains: [{
      domainId: targetDomainId,
      domainEpoch: domainEpoch(3),
      committerDeviceId: issuerDeviceId,
    }],
  } as const;
  const readiness = assessRecoveryDeviceReadiness({
    ...readinessEvidence,
    pendingDevice,
  });
  const challenge = await prepareRecoveryDeviceActivationChallenge({
    crypto,
    challengeId: "device_challenge_recovery",
    pendingDevice,
    resolveTrustedPendingDevice,
    recoveryKeyId: recovery.keyId,
    recoveryGeneration,
    recoveryPublicKey: recovery.publicKey,
    resolveTrustedCurrentRecoveryKey,
    recoveryArchiveDigest: archiveHash,
    inventoryRevision,
    resolveTrustedInventoryCommitment,
    issuedAt: unixTimestamp(10_000),
    expiresAt: unixTimestamp(310_000),
  });
  const proof = await answerRecoveryDeviceActivationChallenge({
    crypto,
    challengeBytes: challenge.challengeBytes,
    pendingDevice,
    resolveTrustedPendingDevice,
    recoveryPublicKey: recovery.publicKey,
    recoveryPrivateKey: recoveryEncryption.privateKey,
    resolveTrustedCurrentRecoveryKey,
    expectedRecoveryArchiveDigest: archiveHash,
    readiness,
    readinessEvidence,
    currentTime: unixTimestamp(20_000),
  });
  return {
    crypto,
    issuerSigning,
    pendingSigning,
    pendingEncryption,
    recovery,
    targetHumanId,
    issuerDeviceId,
    targetDeviceId,
    targetDomainId,
    targetNamespaceId,
    trustedHead,
    inventoryRevision,
    inventoryDigest,
    inventoryCount: inventory.length,
    archive,
    archiveHash,
    challenge,
    proof,
    proofBytes: serializeRecoveryDeviceActivationProofV2(proof),
  };
}
