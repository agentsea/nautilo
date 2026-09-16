import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "../../src/crypto/index.ts";
import {encodeBackgroundWorkDescriptorV2, backgroundProcessorNamespaceRequirementsV2} from "../../src/background/work-descriptor-v2.ts";
import {backgroundProcessorWorkV2Fixture} from "../helpers/background-work-v2-fixture.ts";
import {
  createBackgroundAuthorizationResponseV2, decodeBackgroundAuthorizationResponseV2,
  verifyBackgroundAuthorizationResponseV2, verifyProcessorSignerAuthorizationV2,
  withOpenedBackgroundAuthorizationV2,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2,
  type BackgroundAuthorizationIssuerV2,
} from "../../src/background/processor-authorization-v2.ts";

async function fixture() {
  const crypto = new LatticeCrypto();
  const device = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const descriptor = backgroundProcessorWorkV2Fixture(recipient.publicKey);
  const issuer: BackgroundAuthorizationIssuerV2 = {
    humanId: "human-1", deviceId: "device-1", deviceGeneration: 2,
    serverInstanceId: "f0957632-c716-4b4e-a366-28bfcd9a1959", lineageGeneration: 3, epoch: 4, securityRevision: 5,
    headDigest: new Uint8Array(32).fill(8), signingPublicKeyHash: crypto.hash(device.publicKey),
  };
  const domainKey = crypto.randomBytes(32);
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: "credential-1", descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor),
    issuer, issuerSigningPrivateKey: device.privateKey, domainKey,
  });
  return {crypto, device, recipient, descriptor, issuer, domainKey, responseBytes};
}

describe("current Domain-key Stenographer authorization", () => {
  test("complete Namespace-bound V2 inventory fits persisted signer evidence without truncation", async () => {
    const f = await fixture();
    const id = (prefix: string) => prefix.padEnd(128, "x");
    const namespace = id("namespace");
    const descriptor = {...f.descriptor,
      requestId: id("request"), workId: id("work"), recipientKeyId: id("recipient"), idempotencyId: id("idempotency"),
      anchorNamespaceId: namespace, anchorDomainId: id("domain"),
      authority: {...f.descriptor.authority, namespaceId: namespace, domainId: id("domain"), serverId: id("server"), roomId: id("room")},
      inputBindings: Array.from({length: 256}, (_, index) => ({objectId: id(`input-${index}`), namespaceId: namespace})),
      outputSlots: Array.from({length: 5}, (_, index) => ({...f.descriptor.outputSlots[0]!, objectId: id(`output-${index}`), namespaceIds: [namespace]})),
    };
    const bytes = await createBackgroundAuthorizationResponseV2(f.crypto, {
      credentialId: id("credential"), descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor),
      issuer: {...f.issuer, humanId: id("human"), deviceId: id("device"), serverInstanceId: id("instance")},
      issuerSigningPrivateKey: f.device.privateKey, domainKey: f.domainKey,
    });
    const response = decodeBackgroundAuthorizationResponseV2(bytes);
    expect(response.signerAuthorizationBytes.length).toBeGreaterThan(64 * 1_024);
    expect(response.signerAuthorizationBytes.length).toBeLessThanOrEqual(MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2);
    expect(response.signerAuthorizationBytes.length).toBeLessThanOrEqual(128 * 1_024);
    const verified = await verifyBackgroundAuthorizationResponseV2(f.crypto, {
      responseBytes: bytes, now: descriptor.issuedAt + 1, resolveCurrentIssuer: () => f.device.publicKey,
    });
    expect(verified.descriptor).toEqual(descriptor);
  });

  test("an issuer callback cannot rewrite the signed execution scope", async () => {
    const f = await fixture();
    let callbackContext: Parameters<Parameters<typeof verifyBackgroundAuthorizationResponseV2>[1]["resolveCurrentIssuer"]>[0] | undefined;
    const verified = await verifyBackgroundAuthorizationResponseV2(f.crypto, {
      responseBytes: f.responseBytes, now: f.descriptor.issuedAt + 1,
      resolveCurrentIssuer: context => {
        callbackContext = context;
        Object.assign(context.descriptor, {workKind: "stenographer.compaction", inputBindings: ["foreign-object"].map(objectId => ({objectId, namespaceId: "namespace-1"})), maximumPlaintextBytes: 1});
        Object.assign(backgroundProcessorNamespaceRequirementsV2(context.descriptor)[0]!.authority, {namespaceId: "foreign-namespace"});
        context.descriptor.source.fingerprint.fill(0);
        context.descriptorHash.fill(0);
        context.issuer.headDigest.fill(0);
        return f.device.publicKey;
      },
    });
    expect(verified.descriptor).toEqual(f.descriptor);
    expect(verified.descriptorBytes).toEqual(encodeBackgroundWorkDescriptorV2(f.descriptor));
    expect(verified.descriptorHash).toEqual(f.crypto.hash(verified.descriptorBytes));
    expect(verified.issuer).toEqual(f.issuer);
    backgroundProcessorNamespaceRequirementsV2(callbackContext!.descriptor)[0]!.authority.namespaceHeadDigest.fill(0);
    expect(backgroundProcessorNamespaceRequirementsV2(verified.descriptor)[0]!.authority.namespaceHeadDigest).toEqual(f.descriptor.authority.namespaceHeadDigest);
  });

  test("binds existing device authority and opens only under the exact recipient with borrowed keys", async () => {
    const f = await fixture();
    let copiedDomain: Uint8Array | undefined;
    let borrowedDomain: Uint8Array | undefined;
    let borrowedSigner: Uint8Array | undefined;
    const calls: unknown[] = [];
    const result = await withOpenedBackgroundAuthorizationV2(f.crypto, {
      responseBytes: f.responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => f.descriptor.issuedAt + 1,
      resolveCurrentIssuer: (context) => {
        calls.push(context);
        expect(context.issuer).toEqual(f.issuer);
        expect(backgroundProcessorNamespaceRequirementsV2(context.descriptor)[0]!.authority).toEqual(f.descriptor.authority);
        return f.device.publicKey;
      },
      use: ({verified, domainKey, signerPrivateKey}) => {
        expect(verified.credentialId).toBe("credential-1");
        expect(domainKey).toEqual(f.domainKey);
        copiedDomain = domainKey.slice(); borrowedDomain = domainKey; borrowedSigner = signerPrivateKey;
        return "done";
      },
    });
    expect(result).toBe("done"); expect(calls).toHaveLength(2);
    expect(copiedDomain).toEqual(f.domainKey);
    expect(borrowedDomain?.every((byte) => byte === 0)).toBe(true);
    expect(borrowedSigner?.every((byte) => byte === 0)).toBe(true);
    expect(f.domainKey.some((byte) => byte !== 0)).toBe(true);
    expect(f.recipient.privateKey.some((byte) => byte !== 0)).toBe(true);
  });

  test("keeps durable public signer evidence independently verifiable after grant expiry", async () => {
    const f = await fixture();
    const response = decodeBackgroundAuthorizationResponseV2(f.responseBytes);
    const certificate = verifyProcessorSignerAuthorizationV2(f.crypto, {
      authorizationBytes: response.signerAuthorizationBytes, issuerSigningPublicKey: f.device.publicKey,
    });
    expect(certificate.descriptor).toEqual(f.descriptor);
    expect(certificate.credentialHash).toEqual(f.crypto.hash(response.credentialBytes));
    expect(Object.keys(certificate)).not.toContain("encryptedSecret");
    expect(Object.keys(certificate)).not.toContain("domainKey");
    expect(response.signerAuthorizationBytes.length).toBeLessThanOrEqual(128 * 1_024);
    expect(f.responseBytes.length).toBeLessThanOrEqual(196 * 1_024);
    expect(f.responseBytes.length).toBeLessThanOrEqual(MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2);
    expect(verifyBackgroundAuthorizationResponseV2(f.crypto, {
      responseBytes: f.responseBytes, now: f.descriptor.expiresAt,
      resolveCurrentIssuer: () => f.device.publicKey,
    })).rejects.toMatchObject({code: "expired"});
  });

  test("rejects wrong device keys, removed authority, modified response, and wrong recipient", async () => {
    const f = await fixture();
    for (const resolver of [() => null, () => f.crypto.generateSigningKeyPair().publicKey]) {
      expect(verifyBackgroundAuthorizationResponseV2(f.crypto, {
        responseBytes: f.responseBytes, now: f.descriptor.issuedAt + 1,
        resolveCurrentIssuer: resolver,
      })).rejects.toThrow();
    }
    const changed = f.responseBytes.slice(); changed[changed.length - 1]! ^= 1;
    expect(verifyBackgroundAuthorizationResponseV2(f.crypto, {
      responseBytes: changed, now: f.descriptor.issuedAt + 1, resolveCurrentIssuer: () => f.device.publicKey,
    })).rejects.toThrow();
    const otherRecipient = await f.crypto.generateEncryptionKeyPair();
    let invoked = false;
    expect(withOpenedBackgroundAuthorizationV2(f.crypto, {
      responseBytes: f.responseBytes, recipientPrivateKey: otherRecipient.privateKey,
      now: () => f.descriptor.issuedAt + 1, resolveCurrentIssuer: () => f.device.publicKey,
      use: () => { invoked = true; },
    })).rejects.toMatchObject({code: "secret_unavailable"});
    expect(invoked).toBe(false);
  });

  test("revocation during key opening prevents use and wipes the late secret", async () => {
    const f = await fixture();
    const realOpen = f.crypto.openSealed.bind(f.crypto);
    let openedSecret: Uint8Array | null = null;
    let lookups = 0;
    let used = false;
    f.crypto.openSealed = async (...args) => {
      openedSecret = await realOpen(...args);
      return openedSecret;
    };
    expect(withOpenedBackgroundAuthorizationV2(f.crypto, {
      responseBytes: f.responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => f.descriptor.issuedAt + 1,
      resolveCurrentIssuer: () => ++lookups === 1 ? f.device.publicKey : null,
      use: () => {used = true;},
    })).rejects.toMatchObject({code: "authority_unavailable"});
    expect(used).toBe(false);
    expect((openedSecret as Uint8Array | null)?.every((byte) => byte === 0)).toBe(true);
  });

  test("Buffer-backed custody inputs remain owned by the caller", async () => {
    const f = await fixture();
    const privateKey = Buffer.from(f.device.privateKey);
    const domainKey = Buffer.from(f.domainKey);
    const recipientKey = Buffer.from(f.recipient.privateKey);
    const descriptorBytes = Buffer.from(encodeBackgroundWorkDescriptorV2(f.descriptor));
    const response = Buffer.from(await createBackgroundAuthorizationResponseV2(f.crypto, {
      credentialId: "buffer-credential", descriptorBytes, issuer: f.issuer,
      issuerSigningPrivateKey: privateKey, domainKey,
    }));
    const responseCopy = Uint8Array.from(response);
    await withOpenedBackgroundAuthorizationV2(f.crypto, {
      responseBytes: response, recipientPrivateKey: recipientKey,
      now: () => f.descriptor.issuedAt + 1, resolveCurrentIssuer: () => f.device.publicKey,
      use: ({domainKey: borrowed}) => expect(borrowed).toEqual(f.domainKey),
    });
    expect(Array.from(privateKey)).toEqual(Array.from(f.device.privateKey));
    expect(Array.from(domainKey)).toEqual(Array.from(f.domainKey));
    expect(Array.from(recipientKey)).toEqual(Array.from(f.recipient.privateKey));
    expect(Array.from(response)).toEqual(Array.from(responseCopy));
    expect(Array.from(descriptorBytes)).toEqual(Array.from(encodeBackgroundWorkDescriptorV2(f.descriptor)));
  });

  test("the final current-authority lookup cannot carry execution past expiry", async () => {
    const f = await fixture();
    let now = f.descriptor.issuedAt + 1;
    let lookups = 0;
    let invoked = false;
    const operation = withOpenedBackgroundAuthorizationV2(f.crypto, {
      responseBytes: f.responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => now,
      resolveCurrentIssuer: async () => {
        await Promise.resolve();
        if (++lookups === 2) now = f.descriptor.expiresAt;
        return f.device.publicKey;
      },
      use: () => {invoked = true;},
    });
    expect(await operation.then(() => "used", error => (error as {code: string}).code)).toBe("expired");
    expect(invoked).toBe(false);
  });

  test("abort wipes borrowed keys while an asynchronous model callback is still settling", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let domain: Uint8Array | undefined;
    const outcome = withOpenedBackgroundAuthorizationV2(f.crypto, {
      responseBytes: f.responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => f.descriptor.issuedAt + 1, signal: controller.signal,
      resolveCurrentIssuer: () => f.device.publicKey,
      use: async ({domainKey, signerPrivateKey}) => {
        domain = domainKey;
        controller.abort();
        expect(domainKey.every((byte) => byte === 0)).toBe(true);
        expect(signerPrivateKey.every((byte) => byte === 0)).toBe(true);
        await Promise.resolve();
      },
    });
    expect(await outcome.then(() => "completed", () => "aborted")).toBe("aborted");
    expect(domain?.every((byte) => byte === 0)).toBe(true);
  });
});
