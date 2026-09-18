import { describe, expect, test } from "bun:test";
import { LatticeCrypto, accessRevision, authorizationRevision, cryptoDeviceId,
  cryptoDomainId, domainEpoch, humanId, namespaceId, objectId, unixTimestamp }
  from "@nautilo/lattice-crypto";
import { backgroundWorkDescriptorDigestV1, encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1 } from "@nautilo/lattice-crypto/wire";
import { BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
  fulfillProcessorBackgroundAuthorizationRequest,
  verifyCurrentBackgroundAuthorizationDeviceResponse,
  type BackgroundAuthorizationDeviceAuthority,
  type ExpectedProcessorBackgroundAuthorizationResponse } from "../../src/index.ts";

const NOW = 1_970_000_000_000;
const MAX_SEED = 12;

function cryptoFor(seed: number): LatticeCrypto {
  let state = seed >>> 0;
  return new LatticeCrypto({ bytes: (length) => {
    const output = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      output[index] = state & 0xff;
    }
    return output;
  } }, { now: () => NOW });
}

function selectedSeeds(): readonly number[] {
  const raw = process.env["M241_BACKGROUND_RESPONSE_VERIFIER_PROPERTY_SEED"];
  if (raw === undefined) return Array.from({ length: MAX_SEED }, (_, i) => i + 1);
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError("invalid response verifier property seed");
  }
  return [seed];
}

function changedBytes(bytes: Uint8Array): Uint8Array {
  const changed = Uint8Array.from(bytes);
  changed[0] = changed[0]! ^ 1;
  return changed;
}

async function fixture(seed: number) {
  const crypto = cryptoFor(90_000 + seed);
  const recipient = await crypto.generateEncryptionKeyPair();
  recipient.privateKey.fill(0);
  const signer = crypto.generateSigningKeyPair();
  const outputId = objectId(`journal-event-${seed}`);
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: 1, requestId: `processor-request-${seed}`,
    recipientGeneration: seed, workKind: "stenographer.extraction",
    workId: `batch-${seed}`, namespaceId: namespaceId(`namespace-${seed}`),
    domainId: cryptoDomainId(`domain-${seed}`),
    subject: { kind: "processor", processorKind: "stenographer",
      processorVersion: 1, authorizationRevision: authorizationRevision(seed + 7) },
    purpose: "journal.extract", operations: ["decrypt", "encrypt"],
    source: { kind: "journal_range", startSequence: seed,
      endSequence: seed + 2, rebuildGeneration: 0,
      fingerprint: new Uint8Array(32).fill(seed + 1) },
    inputObjectIds: [objectId(`message-${seed}`)], outputObjectIds: [outputId],
    outputObjectMetadata: [{ objectId: outputId, objectType: "room_event",
      createdAt: unixTimestamp(NOW) }],
    maximumInputObjectCount: 1, maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 64 * 1_024, maximumCiphertextBytes: 96 * 1_024,
    expectedDomainEpoch: domainEpoch(seed + 4),
    expectedNamespaceAccessRevision: accessRevision(seed + 5),
    expectedPolicyRevision: authorizationRevision(seed + 6),
    recipientKeyId: `processor-recipient-${seed}`,
    recipientPublicKey: recipient.publicKey, issuedAt: NOW, notBefore: NOW,
    expiresAt: NOW + BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
    idempotencyId: `processor-attempt-${seed}`,
  };
  const authority: BackgroundAuthorizationDeviceAuthority = {
    humanId: humanId(`human-${seed}`), humanState: "active",
    deviceId: cryptoDeviceId(`device-${seed}`),
    deviceHumanId: humanId(`human-${seed}`), deviceState: "active",
    deviceAuthorizationRevision: authorizationRevision(seed + 8),
    deviceSigningPublicKey: signer.publicKey, deviceSigningPrivateKey: signer.privateKey,
    namespaceId: descriptor.namespaceId, namespaceState: "active",
    membershipHumanId: humanId(`human-${seed}`), membershipState: "active",
    namespaceAccessRevision: descriptor.expectedNamespaceAccessRevision,
    policyRevision: descriptor.expectedPolicyRevision,
    domainId: descriptor.domainId, domainState: "active",
    domainEpoch: descriptor.expectedDomainEpoch, processorKind: "stenographer",
    processorVersion: 1, processorState: "active",
    processorAuthorizationRevision: authorizationRevision(seed + 7),
    aiRoot: new Uint8Array(32).fill(0xb1),
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const descriptorHash = backgroundWorkDescriptorDigestV1(crypto, descriptor);
  const fulfillment = await fulfillProcessorBackgroundAuthorizationRequest({
    crypto, request: { formatVersion: 1, descriptorBytes, descriptorHash },
    resolveCurrentAuthority: () => authority,
  });
  const expected: ExpectedProcessorBackgroundAuthorizationResponse = {
    kind: "processor", requestId: descriptor.requestId,
    recipientGeneration: descriptor.recipientGeneration, descriptorHash,
    recipientKeyId: descriptor.recipientKeyId,
    recipientPublicKey: descriptor.recipientPublicKey,
  };
  return { authority, crypto, expected, fulfillment };
}

describe("processor background response verifier properties", () => {
  test("rejects every substituted durable request coordinate", async () => {
    for (const seed of selectedSeeds()) {
      const state = await fixture(seed);
      const otherRecipient = await state.crypto.generateEncryptionKeyPair();
      otherRecipient.privateKey.fill(0);
      const substitutions = [
        { ...state.expected, requestId: `other-request-${seed}` },
        { ...state.expected, recipientGeneration: seed + 1 },
        { ...state.expected, descriptorHash: changedBytes(state.expected.descriptorHash) },
        { ...state.expected, recipientKeyId: `other-recipient-${seed}` },
        { ...state.expected, recipientPublicKey: otherRecipient.publicKey },
      ] satisfies readonly ExpectedProcessorBackgroundAuthorizationResponse[];
      for (const expected of substitutions) {
        expect(verifyCurrentBackgroundAuthorizationDeviceResponse({
          crypto: state.crypto, expected,
          responseBytes: state.fulfillment.responseBytes,
          signerAuthorizationBytes: state.fulfillment.signerAuthorizationBytes,
          now: NOW,
          resolveCurrentIssuingDevicePublicKey: () =>
            state.authority.deviceSigningPublicKey,
        })).rejects.toThrow();
      }
    }
  });
});
