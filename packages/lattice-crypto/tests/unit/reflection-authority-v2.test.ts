import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "../../src/crypto/index.ts";
import {
  backgroundProcessorDomainRequirementsV2, decodeAnyBackgroundProcessorWorkDescriptorV2, decodeBackgroundProcessorWorkDescriptorV2,
  encodeBackgroundWorkDescriptorV2, MAX_BACKGROUND_REFLECTION_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  type BackgroundReflectionWorkDescriptorV2,
} from "../../src/background/work-descriptor-v2.ts";
import {
  createBackgroundAuthorizationResponseV2, verifyBackgroundAuthorizationResponseV2, withOpenedBackgroundAuthorizationV2,
  withOpenedReflectionBackgroundAuthorizationV2, MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
} from "../../src/background/processor-authorization-v2.ts";
import {backgroundProcessorWorkV2Fixture} from "../helpers/background-work-v2-fixture.ts";
import {createCurrentProcessorObjectAccessManifestV5, verifyObjectAccessManifestV5} from "../../src/format/object-access-manifest-v5.ts";
import {accessRevision, authorizationRevision, objectId} from "../../src/v2-types/ids.ts";

function descriptor(recipientPublicKey: Uint8Array, count = 2, sharedDomain = false, maximalIds = false): BackgroundReflectionWorkDescriptorV2 {
  const base = backgroundProcessorWorkV2Fixture(recipientPublicKey);
  const id = (value: string) => maximalIds ? value.padEnd(128, "x") : value;
  const namespaces = Array.from({length: count}, (_, i) => id(`namespace-${i.toString().padStart(5, "0")}`));
  const requirements = namespaces.map((namespaceId, i) => ({authority: {...base.authority, namespaceId,
    roomId: id(`room-${i}`), domainId: id(sharedDomain ? "domain-shared" : `domain-${i.toString().padStart(5, "0")}`)},
    operations: i === count - 1 ? ["encrypt" as const] : ["decrypt" as const]}));
  const {authority: _authority, ...common} = base;
  return {...common, anchorNamespaceId: namespaces[0]!, anchorDomainId: requirements[0]!.authority.domainId,
    workKind: "reflection.authority_reproject", purpose: "record.reproject",
    subject: {kind: "processor", processorKind: "reflection", processorVersion: 1},
    namespaceRequirements: requirements,
    source: {kind: "reflection_authority", recordRef: "record-1", sourceChangeGeneration: 4, projectionGeneration: 5,
      expectedRepresentationGeneration: 1, targetRepresentationGeneration: 2, fingerprint: new Uint8Array(32).fill(6)},
    inputBindings: namespaces.slice(0, -1).map((namespaceId, i) => ({objectId: id(`input-${i}`), namespaceId})),
    outputSlots: [{...base.outputSlots[0]!, objectId: "new-record-object", namespaceIds: [namespaces.at(-1)!]}]};
}

async function fixture(count = 2, sharedDomain = false, maximalIds = false) {
  const crypto = new LatticeCrypto(); const device = crypto.generateSigningKeyPair(); const recipient = await crypto.generateEncryptionKeyPair();
  const value = descriptor(recipient.publicKey, count, sharedDomain, maximalIds);
  const domains = backgroundProcessorDomainRequirementsV2(value);
  const domainKeys = domains.map(domain => ({domainId: domain.domainId, key: crypto.randomBytes(32)}));
  domains.forEach(domain => domain.domainHeadDigest.fill(0));
  const input = {credentialId: "reflection-credential", descriptorBytes: encodeBackgroundWorkDescriptorV2(value),
    issuer: {humanId: "human-1", deviceId: "device-1", deviceGeneration: 2, serverInstanceId: "instance-1", lineageGeneration: 3,
      epoch: 4, securityRevision: 5, headDigest: new Uint8Array(32), signingPublicKeyHash: crypto.hash(device.publicKey)},
    issuerSigningPrivateKey: device.privateKey, domainKeys};
  return {crypto, device, recipient, descriptor: value, domainKeys, input};
}

const zeroed = (bytes: Uint8Array) => bytes.every(byte => byte === 0);

describe("Hive Reflection current V2 exact authority sets", () => {
  test("keeps Stenographer wire bytes and its narrow decoder unchanged", () => {
    const crypto = new LatticeCrypto();
    const old = encodeBackgroundWorkDescriptorV2(backgroundProcessorWorkV2Fixture(new Uint8Array(65).fill(7)));
    expect(old.length).toBe(787);
    expect(Buffer.from(crypto.hash(old)).toString("hex")).toBe("32a2a477f9e740f7f2db1e18e81d6b276a9dfd2ac9fee4492886bf775a6c96b9");
    const value = descriptor(new Uint8Array(65).fill(7)); const bytes = encodeBackgroundWorkDescriptorV2(value);
    expect(bytes.length).toBe(1056);
    expect(Buffer.from(crypto.hash(bytes)).toString("hex")).toBe("f6380e2a75a99896589bdb8b1c1806384421634b38a6109023772578fe2a851d");
    expect(decodeAnyBackgroundProcessorWorkDescriptorV2(bytes)).toEqual(value);
    expect(() => decodeBackgroundProcessorWorkDescriptorV2(bytes)).toThrow("Stenographer");
  });

  test("rejects unused, reordered, partial, cross-server and inconsistent shared-Domain authority", () => {
    const value = descriptor(new Uint8Array(65).fill(7), 3, true);
    const invalid = [
      {...value, namespaceRequirements: [...value.namespaceRequirements].reverse()},
      {...value, namespaceRequirements: value.namespaceRequirements.slice(1)},
      {...value, namespaceRequirements: [...value.namespaceRequirements, {...value.namespaceRequirements[0]!, authority: {...value.namespaceRequirements[0]!.authority, namespaceId: "unused"}}]},
      {...value, namespaceRequirements: value.namespaceRequirements.map((entry, i) => i !== 1 ? entry : {...entry, authority: {...entry.authority, serverId: "other"}})},
      {...value, namespaceRequirements: value.namespaceRequirements.map((entry, i) => i !== 1 ? entry : {...entry, authority: {...entry.authority, domainKeyGeneration: entry.authority.domainKeyGeneration + 1}})},
      {...value, namespaceRequirements: value.namespaceRequirements.map(entry => ({...entry, operations: ["decrypt", "encrypt"]}))},
      {...value, inputBindings: [{objectId: "record", namespaceId: "not-required"}]},
      {...value, subject: {...value.subject, processorKind: "stenographer"}},
      {...value, expiresAt: value.issuedAt + 300_001},
    ];
    for (const candidate of invalid) expect(() => encodeBackgroundWorkDescriptorV2(candidate as BackgroundReflectionWorkDescriptorV2)).toThrow();
  });

  test.each([false, true])("opens exactly one complete canonical Domain key set shared=%s and wipes every borrowed key", async shared => {
    const f = await fixture(3, shared); const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, f.input);
    let keys: readonly {domainId: string; key: Uint8Array}[] = []; let signer: Uint8Array | undefined;
    await withOpenedReflectionBackgroundAuthorizationV2(f.crypto, {responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => f.descriptor.issuedAt + 1, resolveCurrentIssuer: context => {
        expect(context.descriptor).toEqual(f.descriptor);
        return f.device.publicKey;
      }, use: opened => {
        expect(opened.verified.signer.processorKind).toBe("reflection"); expect(opened.domainKeys).toEqual(f.domainKeys);
        expect(opened.domainKeys).toHaveLength(shared ? 1 : 3); expect(Object.isFrozen(opened.domainKeys)).toBe(true); keys = opened.domainKeys; signer = opened.signerPrivateKey;
      }});
    expect(keys.every(entry => zeroed(entry.key))).toBe(true); expect(zeroed(signer!)).toBe(true);
    expect(f.domainKeys.every(entry => !zeroed(entry.key))).toBe(true);
    expect(withOpenedBackgroundAuthorizationV2(f.crypto, {responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => f.descriptor.issuedAt + 1, resolveCurrentIssuer: () => f.device.publicKey, use: () => {throw new Error("not reached");}})).rejects.toMatchObject({code: "invalid"});
  });

  test("rejects partial, duplicate, substituted and wrong-shape key responses", async () => {
    const f = await fixture();
    for (const domainKeys of [f.domainKeys.slice(1), [...f.domainKeys].reverse(), [f.domainKeys[0]!, f.domainKeys[0]!],
      [{...f.domainKeys[0]!, domainId: "foreign"}, f.domainKeys[1]!], [{...f.domainKeys[0]!, key: new Uint8Array(31)}, f.domainKeys[1]!]]) {
      expect(createBackgroundAuthorizationResponseV2(f.crypto, {...f.input, domainKeys})).rejects.toThrow();
    }
    const {domainKeys: _keys, ...input} = f.input;
    expect(createBackgroundAuthorizationResponseV2(f.crypto, {...input, domainKey: new Uint8Array(32)})).rejects.toThrow();
  });

  test("a resolver cannot rewrite signed Reflection authority; revocation prevents key use", async () => {
    const f = await fixture(); const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, f.input);
    const verified = await verifyBackgroundAuthorizationResponseV2(f.crypto, {responseBytes, now: f.descriptor.issuedAt + 1,
      resolveCurrentIssuer: context => {
        const target = context.descriptor as BackgroundReflectionWorkDescriptorV2;
        target.namespaceRequirements[0]!.authority.domainHeadDigest.fill(0); Object.assign(target.source, {recordRef: "substituted"}); return f.device.publicKey;
      }});
    expect(verified.descriptor).toEqual(f.descriptor);
    let calls = 0; let used = false;
    expect(withOpenedReflectionBackgroundAuthorizationV2(f.crypto, {responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => f.descriptor.issuedAt + 1, resolveCurrentIssuer: () => ++calls === 1 ? f.device.publicKey : null,
      use: () => {used = true;}})).rejects.toMatchObject({code: "authority_unavailable"});
    expect(used).toBe(false);
  });

  test("abort wipes all lent Domain keys while an asynchronous callback is pending", async () => {
    const f = await fixture(); const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, f.input);
    const controller = new AbortController(); let keys: readonly {key: Uint8Array}[] = [];
    expect(withOpenedReflectionBackgroundAuthorizationV2(f.crypto, {responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => f.descriptor.issuedAt + 1, signal: controller.signal, resolveCurrentIssuer: () => f.device.publicKey,
      use: async opened => {keys = opened.domainKeys; controller.abort(new Error("stop")); await Promise.resolve(); expect(keys.every(entry => zeroed(entry.key))).toBe(true);},
    })).rejects.toThrow("stop");
    expect(keys.every(entry => zeroed(entry.key))).toBe(true);
  });

  test("creates and historically verifies a Reflection-signed V5 output under its exact slot", async () => {
    const f = await fixture(); const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, f.input);
    await withOpenedReflectionBackgroundAuthorizationV2(f.crypto, {responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => f.descriptor.issuedAt + 1, resolveCurrentIssuer: () => f.device.publicKey, use: ({verified, signerPrivateKey}) => {
        const unsigned = {objectId: objectId("new-record-object"), payloadHash: new Uint8Array(32).fill(1), accessRevision: accessRevision(0),
          previousManifestHash: null, envelopeHashes: [new Uint8Array(32).fill(2)], signer: verified.signer,
          signerAuthorizationHash: verified.signerAuthorizationHash, hostAuthorizationRevision: authorizationRevision(f.input.issuer.securityRevision)};
        const creation = {signerPrivateKey, signerAuthorizationBytes: verified.signerAuthorizationBytes, issuerSigningPublicKey: f.device.publicKey, now: f.descriptor.issuedAt + 1};
        const manifest = createCurrentProcessorObjectAccessManifestV5(f.crypto, unsigned, creation);
        const read = verifyObjectAccessManifestV5(f.crypto, {manifestBytes: manifest.bytes,
          resolveAgentRuntimeSignerPublicKey: () => null, resolveHistoricalHumanDeviceSigningPublicKey: () => null,
          resolveHistoricalProcessorIssuingDevicePublicKey: () => null, resolveProcessorSignerAuthorizationBytes: () => verified.signerAuthorizationBytes,
          resolveHistoricalCurrentIssuer: () => f.device.publicKey});
        expect(read.currentSignerAuthorization?.certificate.signer.processorKind).toBe("reflection");
        expect(() => createCurrentProcessorObjectAccessManifestV5(f.crypto, {...unsigned, objectId: objectId("foreign")}, creation)).toThrow("boundary");
        expect(() => createCurrentProcessorObjectAccessManifestV5(f.crypto, {...unsigned, signer: {...verified.signer, processorKind: "stenographer"}}, creation)).toThrow("boundary");
      }});
  });

  test("carries all16384 exact Namespaces and distinct Domains through a complete signed response", async () => {
    const f = await fixture(16_384, false, true);
    expect(f.input.descriptorBytes.length).toBeLessThanOrEqual(MAX_BACKGROUND_REFLECTION_WORK_DESCRIPTOR_WIRE_BYTES_V2);
    const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, f.input);
    expect(responseBytes.length).toBeLessThanOrEqual(MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2);
    const verified = await verifyBackgroundAuthorizationResponseV2(f.crypto, {responseBytes, now: f.descriptor.issuedAt + 1, resolveCurrentIssuer: () => f.device.publicKey});
    expect((verified.descriptor as BackgroundReflectionWorkDescriptorV2).namespaceRequirements).toHaveLength(16_384);
    await withOpenedReflectionBackgroundAuthorizationV2(f.crypto, {responseBytes, recipientPrivateKey: f.recipient.privateKey,
      now: () => f.descriptor.issuedAt + 1, resolveCurrentIssuer: () => f.device.publicKey,
      use: opened => {expect(opened.domainKeys).toHaveLength(16_384); expect(opened.domainKeys.at(-1)!.key).toEqual(f.domainKeys.at(-1)!.key);}});
  }, 60_000);
});
