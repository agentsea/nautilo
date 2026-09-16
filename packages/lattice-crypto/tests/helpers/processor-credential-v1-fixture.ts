import {
  createProcessorObjectSignerPublicV1,
} from "../../src/background/processor-object-signer-v1.ts";
import {
  createProcessorCredentialV1,
  type CreatedProcessorCredentialV1,
} from "../../src/background/processor-credential-v1.ts";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
  backgroundWorkDescriptorDigestV1,
  type BackgroundWorkDescriptorV1,
} from "../../src/background/work-descriptor-v1.ts";
import {
  LatticeCrypto,
  seededRng,
  type KeyPair,
} from "../../src/crypto/index.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

export const PROCESSOR_CREDENTIAL_FIXTURE_NOW = 2_000_000;

export interface ProcessorCredentialFixtureV1 {
  readonly crypto: LatticeCrypto;
  readonly descriptor: BackgroundWorkDescriptorV1;
  readonly issuer: KeyPair;
  readonly recipient: KeyPair;
  readonly processorSigner: KeyPair;
  readonly aiRoot: Uint8Array;
  readonly created: CreatedProcessorCredentialV1;
}

export async function createProcessorCredentialFixtureV1(
  seed = 24_200,
): Promise<ProcessorCredentialFixtureV1> {
  const crypto = new LatticeCrypto(seededRng(seed));
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const processorSigner = crypto.generateSigningKeyPair();
  const aiRoot = new Uint8Array(32).fill(seed & 0xff);
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
    requestId: `processor-request-${seed}`,
    recipientGeneration: seed,
    workKind: "stenographer.extraction",
    workId: `stenographer-batch-${seed}`,
    namespaceId: namespaceId(`namespace-${seed}`),
    domainId: cryptoDomainId(`domain-${seed}`),
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(19),
    },
    purpose: "journal.extract",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "journal_range",
      startSequence: seed,
      endSequence: seed + 1,
      rebuildGeneration: 3,
      fingerprint: new Uint8Array(32).fill((seed + 1) & 0xff),
    },
    inputObjectIds: [
      objectId(`input-${seed}-000`),
      objectId(`input-${seed}-001`),
    ],
    outputObjectIds: [objectId(`output-${seed}-000`)],
    outputObjectMetadata: [{
      objectId: objectId(`output-${seed}-000`),
      objectType: "journal.rollup",
      createdAt: unixTimestamp(PROCESSOR_CREDENTIAL_FIXTURE_NOW),
    }],
    maximumInputObjectCount: 2,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 128 * 1024,
    maximumCiphertextBytes: 160 * 1024,
    expectedDomainEpoch: domainEpoch(7),
    expectedNamespaceAccessRevision: accessRevision(11),
    expectedPolicyRevision: authorizationRevision(13),
    recipientKeyId: `recipient-key-${seed}`,
    recipientPublicKey: recipient.publicKey,
    issuedAt: PROCESSOR_CREDENTIAL_FIXTURE_NOW,
    notBefore: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
    expiresAt: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 5 * 60 * 1_000,
    idempotencyId: `stenographer-batch-${seed}-generation-3`,
  };
  const signer = createProcessorObjectSignerPublicV1(crypto, {
    processorKind: "stenographer",
    processorVersion: 1,
    signerAuthorizationId: `processor-signer-auth-${seed}`,
    workDescriptorHash:
      backgroundWorkDescriptorDigestV1(crypto, descriptor),
    signerPrivateKey: processorSigner.privateKey,
  });
  const created = await createProcessorCredentialV1(crypto, {
    id: `processor-credential-${seed}`,
    workDescriptor: descriptor,
    issuingHumanId: humanId(`human-${seed}`),
    issuingDeviceId: cryptoDeviceId(`device-${seed}`),
    issuingDeviceAuthorizationRevision: authorizationRevision(17),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    signer: signer.principal,
    signerPublicKey: signer.publicKey,
    signerPrivateKey: processorSigner.privateKey,
    aiRoot,
  });
  if (
    recipient.publicKey.length !== V2_LIMITS.hpkePublicKeyBytes
    || recipient.privateKey.length !== V2_LIMITS.hpkePrivateKeyBytes
  ) {
    throw new Error("processor credential fixture recipient is malformed");
  }
  return {
    crypto,
    descriptor,
    issuer,
    recipient,
    processorSigner,
    aiRoot,
    created,
  };
}
