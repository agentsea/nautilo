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
  BackgroundAuthorizationDeviceResponderError,
  fulfillProcessorBackgroundAuthorizationRequest,
  type BackgroundAuthorizationDeviceAuthority,
} from "../../src/index.ts";

const NOW = 1_900_000_000_000;

function cryptoFor(seed: number): LatticeCrypto {
  let state = seed >>> 0;
  return new LatticeCrypto(
    {
      bytes: (length) => {
        const output = new Uint8Array(length);
        for (let index = 0; index < length; index += 1) {
          state = (
            Math.imul(state, 1_664_525) + 1_013_904_223
          ) >>> 0;
          output[index] = state & 0xff;
        }
        return output;
      },
    },
    { now: () => NOW },
  );
}

async function fixture(seed: number) {
  const crypto = cryptoFor(seed);
  const recipient = await crypto.generateEncryptionKeyPair();
  recipient.privateKey.fill(0);
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: 1,
    requestId: `request-${seed}`,
    recipientGeneration: seed,
    workKind: "stenographer.extraction",
    workId: `batch-${seed}`,
    namespaceId: namespaceId(`namespace-${seed}`),
    domainId: cryptoDomainId(`domain-${seed}`),
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(seed + 4),
    },
    purpose: "journal.extract",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "journal_range",
      startSequence: seed,
      endSequence: seed + 4,
      rebuildGeneration: 1,
      fingerprint: crypto.hash(
        new TextEncoder().encode(`source-${seed}`),
      ),
    },
    inputObjectIds: [objectId(`input-${seed}`)],
    outputObjectIds: [objectId(`output-${seed}`)],
    outputObjectMetadata: [{
      objectId: objectId(`output-${seed}`),
      objectType: "room_event",
      createdAt: unixTimestamp(NOW),
    }],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 128 * 1024,
    maximumCiphertextBytes: 256 * 1024,
    expectedDomainEpoch: domainEpoch(seed),
    expectedNamespaceAccessRevision: accessRevision(seed + 1),
    expectedPolicyRevision: authorizationRevision(seed + 2),
    recipientKeyId: `recipient-${seed}`,
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
    idempotencyId: `idempotency-${seed}`,
  };
  const signer = crypto.generateSigningKeyPair();
  const authority: BackgroundAuthorizationDeviceAuthority = {
    humanId: humanId(`human-${seed}`),
    humanState: "active",
    deviceId: cryptoDeviceId(`device-${seed}`),
    deviceHumanId: humanId(`human-${seed}`),
    deviceState: "active",
    deviceAuthorizationRevision: authorizationRevision(seed + 3),
    deviceSigningPublicKey: signer.publicKey,
    deviceSigningPrivateKey: signer.privateKey,
    namespaceId: descriptor.namespaceId,
    namespaceState: "active",
    membershipHumanId: humanId(`human-${seed}`),
    membershipState: "active",
    namespaceAccessRevision: descriptor.expectedNamespaceAccessRevision,
    policyRevision: descriptor.expectedPolicyRevision,
    domainId: descriptor.domainId,
    domainState: "active",
    domainEpoch: descriptor.expectedDomainEpoch,
    processorKind: "stenographer",
    processorVersion: 1,
    processorState: "active",
    processorAuthorizationRevision: authorizationRevision(seed + 4),
    aiRoot: crypto.hash(new TextEncoder().encode(`root-${seed}`)),
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  return {
    crypto,
    descriptor,
    authority,
    request: {
      formatVersion: 1 as const,
      descriptorBytes,
      descriptorHash: backgroundWorkDescriptorDigestV1(crypto, descriptor),
    },
  };
}

describe("background authorization device responder properties", () => {
  test("every current-fact substitution fails closed", async () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const state = await fixture(seed);
      const substitutions:
        readonly Partial<BackgroundAuthorizationDeviceAuthority>[] = [
          { namespaceId: namespaceId(`other-namespace-${seed}`) },
          { domainId: cryptoDomainId(`other-domain-${seed}`) },
          { deviceHumanId: humanId(`other-human-${seed}`) },
          { membershipHumanId: humanId(`other-human-${seed}`) },
          { domainEpoch: domainEpoch(seed + 100) },
          { namespaceAccessRevision: accessRevision(seed + 101) },
          { policyRevision: authorizationRevision(seed + 102) },
          {
            processorAuthorizationRevision:
              authorizationRevision(seed + 103),
          },
        ];
      for (const substitution of substitutions) {
        try {
          await fulfillProcessorBackgroundAuthorizationRequest({
            crypto: state.crypto,
            request: state.request,
            resolveCurrentAuthority: () => Promise.resolve({
              ...state.authority,
              ...substitution,
            }),
          });
          throw new Error("stale authority unexpectedly succeeded");
        } catch (error) {
          expect(error).toBeInstanceOf(
            BackgroundAuthorizationDeviceResponderError,
          );
          expect(
            (error as BackgroundAuthorizationDeviceResponderError).code,
          ).toBe("stale_authority");
        }
      }
    }
  });

  test("exact current facts produce a response bound to the request digest", async () => {
    const seen = new Set<string>();
    for (let seed = 65; seed <= 128; seed += 1) {
      const state = await fixture(seed);
      const result =
        await fulfillProcessorBackgroundAuthorizationRequest({
          crypto: state.crypto,
          request: state.request,
          resolveCurrentAuthority: () =>
            Promise.resolve(state.authority),
        });
      const digest = Array.from(
        state.crypto.hash(result.responseBytes),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      expect(result.requestId).toBe(state.descriptor.requestId);
      expect(result.credentialHash).toHaveLength(32);
      expect(result.responseHash).toHaveLength(32);
      expect(result.signerAuthorizationHash).toHaveLength(32);
      expect(seen.has(digest)).toBe(false);
      seen.add(digest);
    }
  });
});
