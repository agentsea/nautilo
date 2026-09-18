import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  backgroundWorkDescriptorDigestV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";

import {
  BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
  fulfillProcessorBackgroundAuthorizationRequest,
  verifyCurrentBackgroundAuthorizationDeviceResponse,
  type BackgroundAuthorizationDeviceAuthority,
  type BackgroundAuthorizationDeviceRequest,
  type ExpectedProcessorBackgroundAuthorizationResponse,
} from "../../src/index.ts";

const NOW = 1_950_000_000_000;

function deterministicCrypto(seed = 1): LatticeCrypto {
  let next = seed;
  return new LatticeCrypto(
    {
      bytes: (length) => {
        const output = new Uint8Array(length);
        for (let index = 0; index < length; index += 1) {
          output[index] = next++ & 0xff;
        }
        return output;
      },
    },
    { now: () => NOW },
  );
}

async function descriptor(
  crypto: LatticeCrypto,
): Promise<BackgroundWorkDescriptorV1> {
  const recipient = await crypto.generateEncryptionKeyPair();
  recipient.privateKey.fill(0);
  const common = {
    formatVersion: 1 as const,
    requestId: "response-processor-request",
    recipientGeneration: 3,
    workId: "processor-work",
    namespaceId: namespaceId("namespace-room-1"),
    domainId: cryptoDomainId("domain-room-1"),
    source: {
      kind: "synthetic_payload" as const,
      generation: 1,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputObjectIds: [objectId("processor-input-1")],
    outputObjectIds: [],
    outputObjectMetadata: [],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 0,
    maximumPlaintextBytes: 32 * 1_024,
    maximumCiphertextBytes: 64 * 1_024,
    expectedDomainEpoch: domainEpoch(7),
    expectedNamespaceAccessRevision: accessRevision(11),
    expectedPolicyRevision: authorizationRevision(13),
    recipientKeyId: "processor-recipient-key-3",
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
    idempotencyId: "processor-idempotency-1",
  };
  const outputId = objectId("journal-event-1");
  return {
    ...common,
    workKind: "stenographer.extraction",
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
      startSequence: 41,
      endSequence: 42,
      rebuildGeneration: 2,
      fingerprint: new Uint8Array(32).fill(0x42),
    },
    outputObjectIds: [outputId],
    outputObjectMetadata: [{
      objectId: outputId,
      objectType: "room_event",
      createdAt: unixTimestamp(NOW),
    }],
    maximumOutputObjectCount: 1,
  };
}

function request(
  crypto: LatticeCrypto,
  work: BackgroundWorkDescriptorV1,
): BackgroundAuthorizationDeviceRequest {
  return {
    formatVersion: 1,
    descriptorBytes: encodeBackgroundWorkDescriptorV1(work),
    descriptorHash: backgroundWorkDescriptorDigestV1(crypto, work),
  };
}

function expectedProcessor(
  crypto: LatticeCrypto,
  work: BackgroundWorkDescriptorV1,
): ExpectedProcessorBackgroundAuthorizationResponse {
  return {
    kind: "processor",
    requestId: work.requestId,
    recipientGeneration: work.recipientGeneration,
    descriptorHash: backgroundWorkDescriptorDigestV1(crypto, work),
    recipientKeyId: work.recipientKeyId,
    recipientPublicKey: work.recipientPublicKey,
  };
}

function processorAuthority(
  crypto: LatticeCrypto,
  work: BackgroundWorkDescriptorV1,
): BackgroundAuthorizationDeviceAuthority {
  const issuer = crypto.generateSigningKeyPair();
  return {
    humanId: humanId("human-alice"),
    humanState: "active",
    deviceId: cryptoDeviceId("device-alice-browser"),
    deviceHumanId: humanId("human-alice"),
    deviceState: "active",
    deviceAuthorizationRevision: authorizationRevision(17),
    deviceSigningPublicKey: issuer.publicKey,
    deviceSigningPrivateKey: issuer.privateKey,
    namespaceId: work.namespaceId,
    namespaceState: "active",
    membershipHumanId: humanId("human-alice"),
    membershipState: "active",
    namespaceAccessRevision: work.expectedNamespaceAccessRevision,
    policyRevision: work.expectedPolicyRevision,
    domainId: work.domainId,
    domainState: "active",
    domainEpoch: work.expectedDomainEpoch,
    processorKind: "stenographer",
    processorVersion: 1,
    processorState: "active",
    processorAuthorizationRevision: authorizationRevision(19),
    aiRoot: new Uint8Array(32).fill(0xa7),
  };
}

describe("current background authorization response verifier", () => {
  test("accepts one exact processor response and returns only durable public evidence", async () => {
    const crypto = deterministicCrypto();
    const work = await descriptor(crypto);
    const authority = processorAuthority(crypto, work);
    const fulfillment =
      await fulfillProcessorBackgroundAuthorizationRequest({
        crypto,
        request: request(crypto, work),
        resolveCurrentAuthority: () => authority,
      });

    const verified =
      await verifyCurrentBackgroundAuthorizationDeviceResponse({
        crypto,
        expected: expectedProcessor(crypto, work),
        responseBytes: fulfillment.responseBytes,
        signerAuthorizationBytes:
          fulfillment.signerAuthorizationBytes,
        now: NOW,
        resolveCurrentIssuingDevicePublicKey: () =>
          authority.deviceSigningPublicKey,
      });

    expect(verified).toMatchObject({
      kind: "processor",
      requestId: work.requestId,
      recipientGeneration: work.recipientGeneration,
      recipientKeyId: work.recipientKeyId,
      issuingHumanId: authority.humanId,
      issuingDeviceId: authority.deviceId,
      issuingDeviceAuthorizationRevision:
        authority.deviceAuthorizationRevision,
      namespaceId: work.namespaceId,
      domainId: work.domainId,
      workId: work.workId,
      workKind: work.workKind,
      purpose: work.purpose,
      subject: work.subject,
      domainEpoch: work.expectedDomainEpoch,
      namespaceAccessRevision:
        work.expectedNamespaceAccessRevision,
      policyRevision: work.expectedPolicyRevision,
      issuedAt: work.issuedAt,
      expiresAt: work.expiresAt,
    });
    expect(typeof verified.credentialId).toBe("string");
    expect(verified.responseHash).toEqual(fulfillment.responseHash);
    expect(verified.credentialHash)
      .toEqual(fulfillment.credentialHash);
    expect(verified.signerAuthorization.authorizationHash)
      .toEqual(fulfillment.signerAuthorizationHash);
    expect(verified.signerAuthorization.authorizationBytes)
      .toEqual(fulfillment.signerAuthorizationBytes);
    expect(Object.keys(verified).sort()).toEqual([
      "credentialHash",
      "credentialId",
      "descriptorHash",
      "domainEpoch",
      "domainId",
      "expiresAt",
      "issuedAt",
      "issuerSigningPublicKeyHash",
      "issuingDeviceAuthorizationRevision",
      "issuingDeviceId",
      "issuingHumanId",
      "kind",
      "namespaceAccessRevision",
      "namespaceId",
      "notBefore",
      "policyRevision",
      "purpose",
      "recipientGeneration",
      "recipientKeyId",
      "recipientPublicKey",
      "requestId",
      "responseBytes",
      "responseHash",
      "signerAuthorization",
      "subject",
      "workId",
      "workKind",
    ]);
    expect(JSON.stringify(verified)).not.toContain("aiRoot");
    expect(JSON.stringify(verified)).not.toContain("privateKey");
    expect(JSON.stringify(verified)).not.toContain("encryptedSecret");
  });

  test("fails closed on request substitution, stale authority, and signer tampering", async () => {
    const crypto = deterministicCrypto(3);
    const processorWork = await descriptor(crypto);
    const processor = processorAuthority(crypto, processorWork);
    const processorFulfillment =
      await fulfillProcessorBackgroundAuthorizationRequest({
        crypto,
        request: request(crypto, processorWork),
        resolveCurrentAuthority: () => processor,
      });
    expect(verifyCurrentBackgroundAuthorizationDeviceResponse({
      crypto,
      expected: {
        ...expectedProcessor(crypto, processorWork),
        requestId: "substituted-request",
      },
      responseBytes: processorFulfillment.responseBytes,
      signerAuthorizationBytes:
        processorFulfillment.signerAuthorizationBytes,
      now: NOW,
      resolveCurrentIssuingDevicePublicKey: () =>
        processor.deviceSigningPublicKey,
    })).rejects.toThrow("durable request");

    expect(verifyCurrentBackgroundAuthorizationDeviceResponse({
      crypto,
      expected: expectedProcessor(crypto, processorWork),
      responseBytes: processorFulfillment.responseBytes,
      signerAuthorizationBytes:
        processorFulfillment.signerAuthorizationBytes,
      now: NOW,
      resolveCurrentIssuingDevicePublicKey: () => null,
    })).rejects.toThrow();

    const tampered = Uint8Array.from(
      processorFulfillment.signerAuthorizationBytes,
    );
    tampered[tampered.length - 1] =
      (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(verifyCurrentBackgroundAuthorizationDeviceResponse({
      crypto,
      expected: expectedProcessor(crypto, processorWork),
      responseBytes: processorFulfillment.responseBytes,
      signerAuthorizationBytes: tampered,
      now: NOW,
      resolveCurrentIssuingDevicePublicKey: () =>
        processor.deviceSigningPublicKey,
    })).rejects.toThrow();
  });
});
