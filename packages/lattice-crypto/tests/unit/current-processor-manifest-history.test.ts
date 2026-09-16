import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "../../src/crypto/index.ts";
import {
  createBackgroundAuthorizationResponseV2, decodeBackgroundAuthorizationResponseV2,
  readProcessorSignerAuthorizationVersion, verifyHistoricalProcessorSignerAuthorizationV2,
  withOpenedBackgroundAuthorizationV2,
  type BackgroundAuthorizationIssuerV2,
} from "../../src/background/processor-authorization-v2.ts";
import {signProcessorObjectBytesV1} from "../../src/background/processor-object-signer-v1.ts";
import {backgroundProcessorWorkV2Fixture} from "../helpers/background-work-v2-fixture.ts";
import {encodeBackgroundWorkDescriptorV2, backgroundProcessorNamespaceRequirementsV2} from "../../src/background/work-descriptor-v2.ts";
import {
  createCurrentProcessorObjectAccessManifestV4, encodeObjectAccessManifestV4,
  objectAccessManifestSigningBytesV4, verifyObjectAccessManifestV4,
  type ObjectAccessManifestUnsignedV4,
} from "../../src/format/object-access-manifest-v4.ts";
import {
  encodeObjectAccessManifestV5, objectAccessManifestSigningBytesV5,
  verifyObjectAccessManifestV5, verifyObjectAccessManifestChainV5,
} from "../../src/format/object-access-manifest-v5.ts";
import {accessRevision, authorizationRevision, objectId} from "../../src/v2-types/ids.ts";

async function fixture() {
  const crypto = new LatticeCrypto();
  const device = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const descriptor = backgroundProcessorWorkV2Fixture(recipient.publicKey);
  const issuer: BackgroundAuthorizationIssuerV2 = {humanId: "human-1", deviceId: "device-1", deviceGeneration: 2,
    serverInstanceId: "server-instance-uuid", lineageGeneration: 3, epoch: 4, securityRevision: 5,
    headDigest: new Uint8Array(32).fill(7), signingPublicKeyHash: crypto.hash(device.publicKey)};
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: "credential-1", descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor),
    issuer, issuerSigningPrivateKey: device.privateKey, domainKey: crypto.randomBytes(32),
  });
  const {signerAuthorizationBytes} = decodeBackgroundAuthorizationResponseV2(responseBytes);
  const signed = await withOpenedBackgroundAuthorizationV2(crypto, {
    responseBytes, recipientPrivateKey: recipient.privateKey,
    now: () => descriptor.issuedAt + 1, resolveCurrentIssuer: () => device.publicKey,
    use: ({verified, signerPrivateKey}) => {
      const base: ObjectAccessManifestUnsignedV4 = {
        objectId: objectId("record-1"), payloadHash: new Uint8Array(32).fill(1),
        accessRevision: accessRevision(0), previousManifestHash: null,
        envelopeHashes: [new Uint8Array(32).fill(2)], signer: verified.signer,
        signerAuthorizationHash: verified.signerAuthorizationHash,
        hostAuthorizationRevision: authorizationRevision(issuer.securityRevision),
      };
      const sign = (version: 4 | 5, override: Partial<ObjectAccessManifestUnsignedV4> = {}) => {
        const unsigned = {...base, ...override};
        const signature = signProcessorObjectBytesV1(crypto, {
          principal: verified.signer, signerPrivateKey,
          message: version === 4 ? objectAccessManifestSigningBytesV4(unsigned) : objectAccessManifestSigningBytesV5(unsigned),
        });
        return version === 4
          ? encodeObjectAccessManifestV4({...unsigned, formatVersion: 4, signature})
          : encodeObjectAccessManifestV5({...unsigned, formatVersion: 5, signature});
      };
      const created = createCurrentProcessorObjectAccessManifestV4(crypto, base, {
        signerPrivateKey, signerAuthorizationBytes, issuerSigningPublicKey: device.publicKey,
        now: descriptor.issuedAt + 1,
      });
      const v5 = sign(5);
      const next = sign(5, {accessRevision: accessRevision(1), previousManifestHash: crypto.hash(v5), envelopeHashes: []});
      const third = sign(5, {accessRevision: accessRevision(2), previousManifestHash: crypto.hash(next), envelopeHashes: []});
      const bad = [4, 5].map((version) => [
        sign(version as 4 | 5, {objectId: objectId("unauthorized-record")}),
        sign(version as 4 | 5, {hostAuthorizationRevision: authorizationRevision(6)}),
        sign(version as 4 | 5, {signerAuthorizationHash: new Uint8Array(32)}),
      ]);
      for (const override of [{objectId: objectId("unauthorized-record")},
        {hostAuthorizationRevision: authorizationRevision(6)}, {signerAuthorizationHash: new Uint8Array(32)}]) {
        expect(() => createCurrentProcessorObjectAccessManifestV4(crypto, {...base, ...override}, {
          signerPrivateKey, signerAuthorizationBytes, issuerSigningPublicKey: device.publicKey,
          now: descriptor.issuedAt + 1,
        })).toThrow("boundary");
      }
      return {v4: created.bytes, v5, next, third, bad, payloadHash: base.payloadHash};
    },
  });
  const resolvers = {
    resolveAgentRuntimeSignerPublicKey: () => null,
    resolveHistoricalHumanDeviceSigningPublicKey: () => null,
    resolveHistoricalIssuingDevicePublicKey: () => null,
    resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    resolveProcessorSignerAuthorizationBytes: () => signerAuthorizationBytes,
    resolveHistoricalCurrentIssuer: () => device.publicKey,
  };
  return {crypto, device, descriptor, issuer, signerAuthorizationBytes, resolvers, ...signed};
}

describe("current processor retained publication evidence", () => {
  test("retains the exact V3 certificate in V4/V5 results without a legacy authorization projection", async () => {
    const f = await fixture();
    for (const [version, bytes] of [[4, f.v4], [5, f.v5]] as const) {
      const input = {...f.resolvers, manifestBytes: bytes, resolveHistoricalCurrentIssuer: (context: Parameters<
        NonNullable<Parameters<typeof verifyObjectAccessManifestV4>[1]["resolveHistoricalCurrentIssuer"]>>[0]) => {
          expect(context.issuer).toEqual(f.issuer);
          expect(context.descriptor).toEqual(f.descriptor);
          return f.device.publicKey;
        }};
      const verified = version === 4 ? verifyObjectAccessManifestV4(f.crypto, input) : verifyObjectAccessManifestV5(f.crypto, input);
      expect(verified.signerAuthorization).toBeNull();
      expect(verified.currentSignerAuthorization!.authorizationBytes).toEqual(f.signerAuthorizationBytes);
      expect(verified.currentSignerAuthorization!.certificate.issuer).toEqual(f.issuer);
      expect(verified.currentSignerAuthorization!.certificate.descriptor).toEqual(f.descriptor);
      expect(verified.currentSignerAuthorization!.authorizationHash).toEqual(f.crypto.hash(f.signerAuthorizationBytes));
    }
  });

  test("legacy-only verification stays closed and never downgrades a V3 certificate", async () => {
    const f = await fixture();
    let legacyLookups = 0;
    const {resolveHistoricalCurrentIssuer: _resolver, ...legacy} = f.resolvers;
    const input = {...legacy,
      resolveHistoricalIssuingDevicePublicKey: () => {legacyLookups++; return f.device.publicKey;},
      resolveHistoricalProcessorIssuingDevicePublicKey: () => {legacyLookups++; return f.device.publicKey;},
    };
    expect(() => verifyObjectAccessManifestV4(f.crypto, {...input, manifestBytes: f.v4})).toThrow("resolver is required");
    expect(() => verifyObjectAccessManifestV5(f.crypto, {...input, manifestBytes: f.v5})).toThrow("resolver is required");
    expect(legacyLookups).toBe(0);
  });

  test("missing or wrong retained issuer authority is rejected for both manifest versions", async () => {
    const f = await fixture();
    for (const key of [null, f.crypto.generateSigningKeyPair().publicKey]) {
      const input = {...f.resolvers, resolveHistoricalCurrentIssuer: () => key};
      expect(() => verifyObjectAccessManifestV4(f.crypto, {...input, manifestBytes: f.v4})).toThrow();
      expect(() => verifyObjectAccessManifestV5(f.crypto, {...input, manifestBytes: f.v5})).toThrow();
    }
  });

  test("even valid processor signatures cannot widen output, certificate hash, or issuer revision", async () => {
    const f = await fixture();
    for (const manifestBytes of f.bad[0]!) {
      expect(() => verifyObjectAccessManifestV4(f.crypto, {...f.resolvers, manifestBytes})).toThrow("boundary");
    }
    for (const manifestBytes of f.bad[1]!) {
      expect(() => verifyObjectAccessManifestV5(f.crypto, {...f.resolvers, manifestBytes})).toThrow("boundary");
    }
    const corrupted = f.v4.slice(); corrupted[corrupted.length - 1]! ^= 1;
    expect(() => verifyObjectAccessManifestV4(f.crypto, {...f.resolvers, manifestBytes: corrupted})).toThrow("signature is invalid");
  });

  test("V5 chain verification propagates retained V3 authority and preserves final evidence", async () => {
    const f = await fixture();
    const input = {...f.resolvers, manifestBytes: f.third, proof: [f.next],
      trustedMinimumHead: {objectId: objectId("record-1"), payloadHash: f.payloadHash,
        accessRevision: accessRevision(0), manifestHash: f.crypto.hash(f.v5)}};
    const verified = verifyObjectAccessManifestChainV5(f.crypto, input);
    expect(verified.currentSignerAuthorization!.authorizationBytes).toEqual(f.signerAuthorizationBytes);
    expect(verified.signerAuthorization).toBeNull();
    expect(verified.manifest.accessRevision).toBe(accessRevision(2));
    expect(() => verifyObjectAccessManifestChainV5(f.crypto, {...input, proof: []})).toThrow("broken hash chain");
    expect(() => verifyObjectAccessManifestChainV5(f.crypto, {...input,
      resolveHistoricalCurrentIssuer: () => null})).toThrow();
    expect(f.signerAuthorizationBytes.some((byte) => byte !== 0)).toBe(true);
  });

  test("explicit protocol dispatch rejects malformed headers, mismatched versions and oversized bytes", async () => {
    const f = await fixture();
    expect(readProcessorSignerAuthorizationVersion(f.signerAuthorizationBytes)).toBe(2);
    const changed = f.signerAuthorizationBytes.slice();
    const domainLength = new DataView(changed.buffer).getUint32(0);
    changed[4 + domainLength + 3] = 1;
    expect(() => readProcessorSignerAuthorizationVersion(changed)).toThrow();
    expect(() => readProcessorSignerAuthorizationVersion(new Uint8Array([1]))).toThrow();
    expect(() => readProcessorSignerAuthorizationVersion(new Uint8Array(1_000_000))).toThrow();
    expect(() => verifyHistoricalProcessorSignerAuthorizationV2(f.crypto, {
      authorizationBytes: changed, resolveHistoricalIssuer: () => f.device.publicKey,
    })).toThrow();
  });

  test("historical resolver mutation cannot change the verified signed descriptor", async () => {
    const f = await fixture();
    const verified = verifyHistoricalProcessorSignerAuthorizationV2(f.crypto, {
      authorizationBytes: Buffer.from(f.signerAuthorizationBytes), resolveHistoricalIssuer: (context) => {
        backgroundProcessorNamespaceRequirementsV2(context.descriptor)[0]!.authority.domainHeadDigest.fill(0);
        context.descriptorHash.fill(0);
        context.issuer.headDigest.fill(0);
        return Buffer.from(f.device.publicKey);
      },
    });
    expect(verified.certificate.descriptor).toEqual(f.descriptor);
    expect(verified.certificate.issuer).toEqual(f.issuer);
  });
});
