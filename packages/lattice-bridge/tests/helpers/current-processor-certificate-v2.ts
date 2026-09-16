import {
  createCurrentCommonProcessorObjectAccessManifest,
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  type CommonObjectAccessManifestUnsigned,
  type ObjectId,
} from "@nautilo/lattice-crypto";
import {
  encodeObjectAccessManifestV4,
  objectAccessManifestSigningBytesV4,
  signProcessorObjectBytesV1,
  type ObjectAccessManifestUnsignedV4,
} from "@nautilo/lattice-crypto/wire";
import {
  createBackgroundAuthorizationResponseV2,
  decodeBackgroundAuthorizationResponseV2,
  encodeBackgroundWorkDescriptorV2,
  verifyProcessorSignerAuthorizationV2,
  withOpenedBackgroundAuthorizationV2,
  type BackgroundAuthorizationIssuerV2,
  type BackgroundProcessorWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import { seededRng } from "@nautilo/lattice-crypto/testing";

export type CurrentProcessorManifestFixtureObjectV2 = Readonly<{
  objectId: ObjectId;
  payloadHash: Uint8Array;
  envelopeHash: Uint8Array;
  objectType?: "nautilo.reflection.record.v1" | "room_event_rollup";
  createdAt?: number;
}>;

export async function currentProcessorCertificateFixtureV2(input: Readonly<{
  objects: readonly CurrentProcessorManifestFixtureObjectV2[];
  seed?: number;
  now?: number;
  workKind?: "stenographer.historical" | "stenographer.output_repair";
}>) {
  const now = input.now ?? 1_800_000_000_000;
  const crypto = new LatticeCrypto(
    seededRng(input.seed ?? 317_500),
    {now: () => now},
  );
  const issuerKey = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const namespaceId = "namespace-current-certificate-v3";
  const domainId = "domain-current-certificate-v3";
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {
    formatVersion: 2,
    requestId: "request-current-certificate-v3",
    recipientGeneration: 4,
    workKind: input.workKind ?? "stenographer.historical",
    workId: "work-current-certificate-v3",
    anchorNamespaceId: namespaceId,
    anchorDomainId: domainId,
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
    operations: input.workKind === "stenographer.output_repair"
      ? (input.objects.length === 0 ? [] : ["encrypt"])
      : ["decrypt", "encrypt"],
    purpose: input.workKind === "stenographer.output_repair" ? "journal.repair" : "journal.extract",
    authority: {
      serverId: "server-current-certificate-v3",
      roomId: "room-current-certificate-v3",
      namespaceId,
      namespaceAccessRevision: 8,
      namespaceKeyGeneration: 3,
      namespaceHeadDigest: new Uint8Array(32).fill(0x21),
      domainId,
      domainKeyGeneration: 4,
      domainAuthorizationRevision: 12,
      domainHeadDigest: new Uint8Array(32).fill(0x22),
      bundleRevision: 13,
      bundleDigest: new Uint8Array(32).fill(0x23),
    },
    policyRevision: 9,
    source: {kind: "stenographer_work", startSequence: 40, endSequence: 44, rebuildGeneration: 7,
      fingerprint: new Uint8Array(32).fill(0x41)},
    inputBindings: input.workKind === "stenographer.output_repair" ? [] : [{objectId: "message:current-certificate-v3", namespaceId}],
    outputSlots: input.objects.map((object, index) => ({
      objectId: object.objectId,
      objectType: object.objectType ?? "nautilo.reflection.record.v1",
      createdAt: object.createdAt ?? now + index,
      namespaceIds: [namespaceId],
    })),
    maximumPlaintextBytes: 64 * 1_024,
    maximumCiphertextBytes: 96 * 1_024,
    recipientKeyId: "recipient-key-current-certificate-v3",
    recipientPublicKey: recipient.publicKey,
    issuedAt: now,
    notBefore: now,
    expiresAt: now + 300_000,
    idempotencyId: "idempotency-current-certificate-v3",
  };
  const issuer: BackgroundAuthorizationIssuerV2 = {
    humanId: "human-current-certificate-v3",
    deviceId: "device-current-certificate-v3",
    deviceGeneration: 5,
    serverInstanceId: "server-instance-current-certificate-v3",
    lineageGeneration: 6,
    epoch: 7,
    securityRevision: 11,
    headDigest: new Uint8Array(32).fill(0x31),
    signingPublicKeyHash: crypto.hash(issuerKey.publicKey),
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: "certificate-current-v3",
    descriptorBytes,
    issuer,
    issuerSigningPrivateKey: issuerKey.privateKey,
    domainKey: new Uint8Array(32).fill(0x51),
  });
  const {credentialBytes, signerAuthorizationBytes} =
    decodeBackgroundAuthorizationResponseV2(responseBytes);
  const certificate = verifyProcessorSignerAuthorizationV2(crypto, {
    authorizationBytes: signerAuthorizationBytes,
    issuerSigningPublicKey: issuerKey.publicKey,
  });
  const manifests = await withOpenedBackgroundAuthorizationV2(crypto, {
    responseBytes,
    recipientPrivateKey: recipient.privateKey,
    now: () => now + 1,
    resolveCurrentIssuer: () => issuerKey.publicKey,
    use: ({verified, signerPrivateKey}) => input.objects.map((object) => {
      const common = {
        objectId: object.objectId,
        payloadHash: object.payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [object.envelopeHash],
        signer: verified.signer,
        signerAuthorizationHash: verified.signerAuthorizationHash,
        hostAuthorizationRevision: authorizationRevision(
          issuer.securityRevision,
        ),
      } satisfies CommonObjectAccessManifestUnsigned;
      const signing = {signerPrivateKey, signerAuthorizationBytes,
        issuerSigningPublicKey: issuerKey.publicKey, now: now + 1};
      const v5 = createCurrentCommonProcessorObjectAccessManifest(crypto, common, signing);
      const v5Bytes = v5.bytes;
      const v5Tombstone = createCurrentCommonProcessorObjectAccessManifest(crypto, {...common,
        accessRevision: accessRevision(1), previousManifestHash: v5.hash, envelopeHashes: []}, signing);

      const legacy = common satisfies ObjectAccessManifestUnsignedV4;
      const v4SigningBytes = objectAccessManifestSigningBytesV4(legacy);
      const v4Signature = signProcessorObjectBytesV1(crypto, {
        principal: verified.signer,
        signerPrivateKey,
        message: v4SigningBytes,
      });
      v4SigningBytes.fill(0);
      const v4Bytes = encodeObjectAccessManifestV4({
        ...legacy,
        formatVersion: 4,
        signature: v4Signature,
      });
      v4Signature.fill(0);
      const tombstoneUnsigned: ObjectAccessManifestUnsignedV4 = {
        ...legacy,
        accessRevision: accessRevision(1),
        previousManifestHash: crypto.hash(v4Bytes),
        envelopeHashes: [],
      };
      const tombstoneSigningBytes = objectAccessManifestSigningBytesV4(
        tombstoneUnsigned,
      );
      const tombstoneSignature = signProcessorObjectBytesV1(crypto, {
        principal: verified.signer,
        signerPrivateKey,
        message: tombstoneSigningBytes,
      });
      tombstoneSigningBytes.fill(0);
      const tombstoneBytes = encodeObjectAccessManifestV4({
        ...tombstoneUnsigned,
        formatVersion: 4,
        signature: tombstoneSignature,
      });
      tombstoneSignature.fill(0);
      return Object.freeze({
        objectId: object.objectId,
        v5Bytes,
        v5Hash: crypto.hash(v5Bytes),
        v5TombstoneBytes: v5Tombstone.bytes,
        v5TombstoneHash: v5Tombstone.hash,
        v4Bytes,
        v4Hash: crypto.hash(v4Bytes),
        tombstoneBytes,
        tombstoneHash: crypto.hash(tombstoneBytes),
      });
    }),
  });
  const authorizationHash = crypto.hash(signerAuthorizationBytes);
  const descriptorHash = crypto.hash(descriptorBytes);
  return {
    crypto,
    descriptor,
    issuer,
    manifests,
    authorizationBytes: signerAuthorizationBytes,
    authorizationHash,
    authorizationRow: {
      authorization_id: certificate.credentialId,
      format_version: 2,
      request_id: descriptor.requestId,
      recipient_generation: descriptor.recipientGeneration,
      processor_kind: descriptor.subject.processorKind,
      processor_version: descriptor.subject.processorVersion,
      work_id: descriptor.workId,
      namespace_id: descriptor.authority.namespaceId,
      domain_id: descriptor.authority.domainId,
      domain_epoch: null,
      namespace_access_revision: descriptor.authority.namespaceAccessRevision,
      policy_revision: descriptor.policyRevision,
      processor_authorization_revision: null,
      issuing_human_id: issuer.humanId,
      issuing_device_id: issuer.deviceId,
      issuing_device_authorization_revision: issuer.securityRevision,
      issuer_signing_public_key_hash: issuer.signingPublicKeyHash,
      signer_key_id: certificate.signer.signerKeyId,
      signer_public_key: certificate.signerPublicKey,
      work_descriptor_hash: descriptorHash,
      work_descriptor_bytes: descriptorBytes,
      authorization_hash: authorizationHash,
      credential_hash: crypto.hash(credentialBytes),
      authorization_bytes: signerAuthorizationBytes,
      issued_at: new Date(descriptor.issuedAt),
      expires_at: new Date(descriptor.expiresAt),
      created_at: new Date(now + 1),
    },
    deviceRow: {
      device_id: issuer.deviceId,
      human_id: issuer.humanId,
      device_generation: issuer.deviceGeneration,
      signing_public_key: issuerKey.publicKey,
      state: "revoked",
    },
  };
}
