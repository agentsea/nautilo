import { describe, expect, test } from "bun:test";

import {
  MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1,
  PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1,
  PROCESSOR_CREDENTIAL_MAX_TTL_MS_V1,
  PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1,
  createProcessorCredentialV1,
  decodeProcessorCredentialV1,
  encodeProcessorCredentialV1,
  openProcessorCredentialV1,
  processorCredentialSigningBytesV1,
  verifyProcessorCredentialV1,
  type ProcessorCredentialV1,
  type ProcessorCredentialIssuerAuthorityContextV1,
} from "../../src/background/processor-credential-v1.ts";
import {
  MAX_PROCESSOR_CREDENTIAL_SECRET_WIRE_BYTES_V1,
  PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1,
  decodeProcessorCredentialSecretV1,
  destroyProcessorCredentialSecretV1,
  encodeProcessorCredentialSecretV1,
  type ProcessorCredentialSecretV1,
} from "../../src/background/processor-credential-secret-v1.ts";
import {
  backgroundWorkDescriptorDigestV1,
} from "../../src/background/work-descriptor-v1.ts";
import {
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
} from "../../src/v2-types/ids.ts";
import {
  PROCESSOR_CREDENTIAL_FIXTURE_NOW,
  createProcessorCredentialFixtureV1,
} from "../helpers/processor-credential-v1-fixture.ts";

function resolveIssuer(
  expected: ProcessorCredentialIssuerAuthorityContextV1,
  publicKey: Uint8Array,
) {
  return (context: ProcessorCredentialIssuerAuthorityContextV1) => {
    expect(context).toEqual(expected);
    return publicKey;
  };
}

describe("ProcessorCredentialSecretV1 canonical format", () => {
  function secretFixture(): ProcessorCredentialSecretV1 {
    return {
      formatVersion: PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1,
      workDescriptorHash: new Uint8Array(32).fill(0x11),
      domainId: cryptoDomainId("domain-secret"),
      domainEpoch: domainEpoch(7),
      aiRoot: new Uint8Array(32).fill(0x22),
      processorSignerPrivateKey: new Uint8Array(32).fill(0x33),
    };
  }

  test("round-trips only the exact bounded secret fields", () => {
    const secret = secretFixture();
    const bytes = encodeProcessorCredentialSecretV1(secret);
    const decoded = decodeProcessorCredentialSecretV1(bytes);

    expect(decoded).toEqual(secret);
    expect(decoded.aiRoot).not.toBe(secret.aiRoot);
    expect(decoded.processorSignerPrivateKey)
      .not.toBe(secret.processorSignerPrivateKey);
    expect(encodeProcessorCredentialSecretV1(decoded)).toEqual(bytes);
    expect(() =>
      encodeProcessorCredentialSecretV1({
        ...secret,
        extra: true,
      } as never)
    ).toThrow("field set");
    const { domainId: _domainId, ...sameCountSubstitution } = secret;
    expect(() => encodeProcessorCredentialSecretV1({
      ...sameCountSubstitution,
      namespaceId: "namespace-secret",
    } as never)).toThrow("field set");
    expect(() =>
      encodeProcessorCredentialSecretV1({
        ...secret,
        aiRoot: new Uint8Array(31),
      })
    ).toThrow("32");
    expect(() =>
      decodeProcessorCredentialSecretV1(new Uint8Array([...bytes, 0]))
    ).toThrow("trailing");
  });

  test("rejects every invalid secret object boundary", () => {
    const secret = secretFixture();
    const invalidObjects: unknown[] = [null, [], "secret"];
    for (const invalid of invalidObjects) {
      expect(() => encodeProcessorCredentialSecretV1(invalid as never))
        .toThrow("must be an object");
    }

    expect(() => encodeProcessorCredentialSecretV1({
      ...secret,
      formatVersion: 2,
    } as never)).toThrow("format version");
    expect(() => encodeProcessorCredentialSecretV1({
      ...secret,
      domainId: "" as never,
    })).toThrow();
    expect(() => encodeProcessorCredentialSecretV1({
      ...secret,
      domainEpoch: -1 as never,
    })).toThrow();

    for (const field of [
      "workDescriptorHash",
      "aiRoot",
      "processorSignerPrivateKey",
    ] as const) {
      expect(() => encodeProcessorCredentialSecretV1({
        ...secret,
        [field]: new Uint8Array(31),
      })).toThrow("exactly 32 bytes");
      expect(() => encodeProcessorCredentialSecretV1({
        ...secret,
        [field]: [] as never,
      })).toThrow("exactly 32 bytes");
    }
  });

  test("rejects non-secret wire values before returning secret material", () => {
    const secret = secretFixture();
    const bytes = encodeProcessorCredentialSecretV1(secret);
    const wrongDomain = bytes.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;

    expect(() => decodeProcessorCredentialSecretV1([] as never))
      .toThrow("Uint8Array");
    expect(() => decodeProcessorCredentialSecretV1(
      new Uint8Array(MAX_PROCESSOR_CREDENTIAL_SECRET_WIRE_BYTES_V1 + 1),
    )).toThrow("wire limit");
    expect(() => decodeProcessorCredentialSecretV1(wrongDomain))
      .toThrow("domain mismatch");
    expect(() => decodeProcessorCredentialSecretV1(bytes.subarray(0, 20)))
      .toThrow();
  });

  test("destroys every owned secret byte array without aliasing inputs", () => {
    const secret = secretFixture();
    const decoded = decodeProcessorCredentialSecretV1(
      encodeProcessorCredentialSecretV1(secret),
    );

    destroyProcessorCredentialSecretV1(decoded);

    expect(decoded.workDescriptorHash.every((byte) => byte === 0)).toBe(true);
    expect(decoded.aiRoot.every((byte) => byte === 0)).toBe(true);
    expect(decoded.processorSignerPrivateKey.every((byte) => byte === 0))
      .toBe(true);
    expect(secret.workDescriptorHash.every((byte) => byte === 0x11))
      .toBe(true);
    expect(secret.aiRoot.every((byte) => byte === 0x22)).toBe(true);
    expect(secret.processorSignerPrivateKey.every((byte) => byte === 0x33))
      .toBe(true);
  });

  test("zeroizes normalized encode copies and decoded raw temporaries", () => {
    const secret = secretFixture();
    const originalFill = Uint8Array.prototype.fill;
    const zeroized: Array<{ before: Uint8Array; target: Uint8Array }> = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const before = this.slice();
      const result = originalFill.call(this, value, start, end);
      if (value === 0) zeroized.push({ before, target: this });
      return result;
    };

    try {
      const bytes = encodeProcessorCredentialSecretV1(secret);
      for (const marker of [0x11, 0x22, 0x33]) {
        expect(zeroized.some(({ before, target }) =>
          before.length === 32
          && before.every((byte) => byte === marker)
          && target.every((byte) => byte === 0)
        )).toBe(true);
      }
      zeroized.length = 0;

      const decoded = decodeProcessorCredentialSecretV1(bytes);
      for (const marker of [0x11, 0x22, 0x33]) {
        expect(zeroized.some(({ before, target }) =>
          before.length === 32
          && before.every((byte) => byte === marker)
          && target.every((byte) => byte === 0)
        )).toBe(true);
      }
      expect(zeroized.some(({ before, target }) =>
        before.length === bytes.length
        && before.every((byte, index) => byte === bytes[index])
        && target.every((byte) => byte === 0)
      )).toBe(true);
      expect(decoded).toEqual(secret);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
  });
});

describe("ProcessorCredentialV1 create, verify, and open", () => {
  test("rejects each malformed credential field at its owning boundary", async () => {
    const state = await createProcessorCredentialFixtureV1(24_200);
    const credential = state.created.credential;
    const invalidObjects: unknown[] = [null, [], "credential"];
    for (const invalid of invalidObjects) {
      expect(() => encodeProcessorCredentialV1(invalid as never))
        .toThrow("must be an object");
    }

    const { id: _id, ...sameCountSubstitution } = credential;
    expect(() => encodeProcessorCredentialV1({
      ...sameCountSubstitution,
      grantId: "credential-field-substitution",
    } as never)).toThrow("field set");
    expect(() => encodeProcessorCredentialV1({
      ...credential,
      workDescriptorBytes: new Uint8Array(),
    })).toThrow("work descriptor must contain 1-131072 bytes");

    const invalidCredentials: ProcessorCredentialV1[] = [
      { ...credential, formatVersion: 2 as never },
      { ...credential, id: "" },
      { ...credential, workDescriptorBytes: [] as never },
      { ...credential, workDescriptorHash: new Uint8Array(31) },
      { ...credential, workDescriptorHash: new Uint8Array(32).fill(0x7a) },
      { ...credential, issuingHumanId: "" as never },
      { ...credential, issuingDeviceId: "" as never },
      {
        ...credential,
        issuingDeviceAuthorizationRevision: -1 as never,
      },
      { ...credential, issuerSigningPublicKeyHash: new Uint8Array(31) },
      {
        ...credential,
        signer: {
          ...credential.signer,
          workDescriptorHash: new Uint8Array(32).fill(0x7b),
        },
      },
      { ...credential, signerPublicKey: new Uint8Array(31) },
      { ...credential, transformPermission: "decrypt" as never },
      { ...credential, issuedAt: credential.issuedAt + 1 },
      { ...credential, notBefore: credential.notBefore + 1 },
      { ...credential, expiresAt: credential.expiresAt - 1 },
      { ...credential, encryptedSecret: new Uint8Array() },
      { ...credential, encryptedSecret: [] as never },
      { ...credential, singleUse: false as never },
      { ...credential, signature: new Uint8Array(63) },
    ];
    for (const invalid of invalidCredentials) {
      expect(() => encodeProcessorCredentialV1(invalid)).toThrow();
    }
  });

  test("accepts exact encrypted-secret byte boundaries and rejects one over", async () => {
    const state = await createProcessorCredentialFixtureV1(24_199);
    for (const length of [1, MAX_PROCESSOR_CREDENTIAL_SECRET_WIRE_BYTES_V1 + 512]) {
      expect(() => encodeProcessorCredentialV1({
        ...state.created.credential,
        encryptedSecret: new Uint8Array(length).fill(0x41),
      })).not.toThrow();
    }
    expect(() => encodeProcessorCredentialV1({
      ...state.created.credential,
      encryptedSecret: new Uint8Array(
        MAX_PROCESSOR_CREDENTIAL_SECRET_WIRE_BYTES_V1 + 513,
      ),
    })).toThrow("1-1024 bytes");
  });

  test("rejects non-credential wire and a forged single-use marker", async () => {
    const state = await createProcessorCredentialFixtureV1(24_198);
    const wrongDomain = state.created.bytes.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    const wrongSingleUse = state.created.bytes.slice();
    wrongSingleUse[wrongSingleUse.length - 69] = 0;

    expect(() => decodeProcessorCredentialV1([] as never))
      .toThrow("Uint8Array");
    expect(() => decodeProcessorCredentialV1(
      new Uint8Array(MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1 + 1),
    )).toThrow("wire limit");
    expect(() => decodeProcessorCredentialV1(wrongDomain))
      .toThrow("domain mismatch");
    expect(() => decodeProcessorCredentialV1(wrongSingleUse))
      .toThrow("single-use marker");
  });

  test("creates a distinct signed one-run credential and opens exact secrets", async () => {
    const state = await createProcessorCredentialFixtureV1();
    const credential = state.created.credential;
    const expectedContext: ProcessorCredentialIssuerAuthorityContextV1 = {
      purpose: "verify-current-processor-credential",
      credentialId: credential.id,
      issuingHumanId: credential.issuingHumanId,
      issuingDeviceId: credential.issuingDeviceId,
      issuingDeviceAuthorizationRevision:
        credential.issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash: credential.issuerSigningPublicKeyHash,
      workDescriptorHash: credential.workDescriptorHash,
      namespaceId: state.descriptor.namespaceId,
      domainId: state.descriptor.domainId,
      domainEpoch: state.descriptor.expectedDomainEpoch,
      namespaceAccessRevision:
        state.descriptor.expectedNamespaceAccessRevision,
      policyRevision: state.descriptor.expectedPolicyRevision,
      issuedAt: credential.issuedAt,
      notBefore: credential.notBefore,
      expiresAt: credential.expiresAt,
    };
    const verified = await verifyProcessorCredentialV1(state.crypto, {
      credentialBytes: state.created.bytes,
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey:
        resolveIssuer(expectedContext, state.issuer.publicKey),
    });
    const opened = await openProcessorCredentialV1(state.crypto, {
      credentialBytes: state.created.bytes,
      recipientPrivateKey: state.recipient.privateKey,
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
    });

    expect(credential.formatVersion)
      .toBe(PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1);
    expect(credential.transformPermission)
      .toBe(PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1);
    expect(credential.singleUse).toBe(true);
    expect(credential.expiresAt - credential.issuedAt)
      .toBeLessThanOrEqual(PROCESSOR_CREDENTIAL_MAX_TTL_MS_V1);
    expect(encodeProcessorCredentialV1(
      decodeProcessorCredentialV1(state.created.bytes),
    )).toEqual(state.created.bytes);
    expect(verified.workDescriptor).toEqual(state.descriptor);
    expect(verified.credentialHash).toEqual(state.created.hash);
    expect(opened).not.toBeNull();
    expect(opened?.workDescriptor).toEqual(state.descriptor);
    expect(opened?.aiRoot).toEqual(state.aiRoot);
    expect(opened?.processorSignerPrivateKey)
      .toEqual(state.processorSigner.privateKey);
    expect(opened?.domainId).toBe(state.descriptor.domainId);
    expect(opened?.domainEpoch)
      .toBe(state.descriptor.expectedDomainEpoch);
  });

  test("requires exact ten-minute-or-shorter descriptor times", async () => {
    const state = await createProcessorCredentialFixtureV1(24_201);
    const exact = {
      ...state.descriptor,
      notBefore: state.descriptor.issuedAt,
      expiresAt:
        state.descriptor.issuedAt + PROCESSOR_CREDENTIAL_MAX_TTL_MS_V1,
    };
    expect(createProcessorCredentialV1(state.crypto, {
      id: "processor-credential-exact-ttl",
      workDescriptor: exact,
      issuingHumanId: state.created.credential.issuingHumanId,
      issuingDeviceId: state.created.credential.issuingDeviceId,
      issuingDeviceAuthorizationRevision: authorizationRevision(17),
      issuingDeviceSigningPublicKey: state.issuer.publicKey,
      issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      signer: {
        ...state.created.credential.signer,
        workDescriptorHash:
          backgroundWorkDescriptorDigestV1(state.crypto, exact),
      },
      signerPublicKey: state.created.credential.signerPublicKey,
      signerPrivateKey: state.processorSigner.privateKey,
      aiRoot: state.aiRoot,
    })).resolves.toBeDefined();

    const excessive = {
      ...exact,
      expiresAt: exact.expiresAt + 1,
    };
    expect(createProcessorCredentialV1(state.crypto, {
      id: "processor-credential-excessive-ttl",
      workDescriptor: excessive,
      issuingHumanId: state.created.credential.issuingHumanId,
      issuingDeviceId: state.created.credential.issuingDeviceId,
      issuingDeviceAuthorizationRevision: authorizationRevision(17),
      issuingDeviceSigningPublicKey: state.issuer.publicKey,
      issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      signer: {
        ...state.created.credential.signer,
        workDescriptorHash:
          backgroundWorkDescriptorDigestV1(state.crypto, excessive),
      },
      signerPublicKey: state.created.credential.signerPublicKey,
      signerPrivateKey: state.processorSigner.privateKey,
      aiRoot: state.aiRoot,
    })).rejects.toThrow("ten-minute");
  });

  test("enforces exact not-before and expiry boundaries with no wall-clock sleep", async () => {
    const state = await createProcessorCredentialFixtureV1(24_202);
    const verifyAt = (now: number) =>
      verifyProcessorCredentialV1(state.crypto, {
        credentialBytes: state.created.bytes,
        now,
        resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
      });

    expect(verifyAt(state.descriptor.notBefore - 1))
      .rejects.toThrow("not currently valid");
    expect(verifyAt(state.descriptor.notBefore)).resolves.toBeDefined();
    expect(verifyAt(state.descriptor.expiresAt - 1))
      .resolves.toBeDefined();
    expect(verifyAt(state.descriptor.expiresAt))
      .rejects.toThrow("not currently valid");
  });

  test("rejects oversized wire before resolver or crypto work", async () => {
    const state = await createProcessorCredentialFixtureV1(24_203);
    let resolved = false;
    expect(verifyProcessorCredentialV1(state.crypto, {
      credentialBytes:
        new Uint8Array(MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1 + 1),
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey: () => {
        resolved = true;
        return state.issuer.publicKey;
      },
    })).rejects.toThrow("wire limit");
    expect(resolved).toBe(false);
  });

  test("rejects malformed and mismatched creation keys", async () => {
    const state = await createProcessorCredentialFixtureV1(24_204);
    const alternateIssuer = state.crypto.generateSigningKeyPair();
    const alternateSigner = state.crypto.generateSigningKeyPair();
    const base = {
      id: "processor-credential-key-boundaries",
      workDescriptor: state.descriptor,
      issuingHumanId: state.created.credential.issuingHumanId,
      issuingDeviceId: state.created.credential.issuingDeviceId,
      issuingDeviceAuthorizationRevision:
        state.created.credential.issuingDeviceAuthorizationRevision,
      issuingDeviceSigningPublicKey: state.issuer.publicKey,
      issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      signer: state.created.credential.signer,
      signerPublicKey: state.processorSigner.publicKey,
      signerPrivateKey: state.processorSigner.privateKey,
      aiRoot: state.aiRoot,
    };
    expect(createProcessorCredentialV1(state.crypto, {
      ...base,
      issuingDeviceSigningPublicKey: new Uint8Array(31),
    })).rejects.toThrow(
      "issuer signing public key must be exactly 32 bytes",
    );
    for (const change of [
      { issuingDeviceSigningPrivateKey: new Uint8Array(31) },
      { signerPublicKey: new Uint8Array(31) },
      { signerPrivateKey: new Uint8Array(31) },
      { aiRoot: new Uint8Array(31) },
      { issuingDeviceSigningPublicKey: alternateIssuer.publicKey },
      { signerPublicKey: alternateSigner.publicKey },
      { signerPrivateKey: alternateSigner.privateKey },
      {
        signer: {
          ...state.created.credential.signer,
          signerKeyId: "signer-key-substituted",
        },
      },
    ]) {
      expect(createProcessorCredentialV1(state.crypto, {
        ...base,
        ...change,
      })).rejects.toThrow();
    }
  });

  test("fails closed at every issuer and signer verification boundary", async () => {
    const state = await createProcessorCredentialFixtureV1(24_205);
    const verify = (
      credentialBytes: Uint8Array,
      resolver: unknown,
      now = PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
    ) => verifyProcessorCredentialV1(state.crypto, {
      credentialBytes,
      now,
      resolveCurrentIssuerPublicKey: resolver as never,
    });

    expect(verify(state.created.bytes, null)).rejects.toThrow("resolver");
    expect(verify(state.created.bytes, () => null))
      .rejects.toThrow("not currently authorized");
    expect(verify(state.created.bytes, () => new Uint8Array(31)))
      .rejects.toThrow("exactly 32 bytes");
    expect(verify(new Uint8Array(), () => state.issuer.publicKey))
      .rejects.toThrow();
    expect(verify(state.created.bytes, () => state.issuer.publicKey, -1))
      .rejects.toThrow();

    const substitutedSignerPublicKey = new Uint8Array(32).fill(0x7c);
    const {
      signature: _signature,
      ...unsigned
    } = state.created.credential;
    const substitutedUnsigned = {
      ...unsigned,
      signerPublicKey: substitutedSignerPublicKey,
    };
    const signingBytes = processorCredentialSigningBytesV1(
      substitutedUnsigned,
    );
    const substitutedBytes = encodeProcessorCredentialV1({
      ...substitutedUnsigned,
      signature: state.crypto.sign(state.issuer.privateKey, signingBytes),
    });
    signingBytes.fill(0);
    expect(verify(substitutedBytes, () => state.issuer.publicKey))
      .rejects.toThrow("signer public key");
    expect(openProcessorCredentialV1(state.crypto, {
      credentialBytes: state.created.bytes,
      recipientPrivateKey: state.recipient.privateKey,
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey: () => null,
    })).rejects.toThrow("issuer is not currently authorized");
  });

  test("rejects each independently substituted opened secret binding", async () => {
    const state = await createProcessorCredentialFixtureV1(24_206);
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    const baseSecret: ProcessorCredentialSecretV1 = {
      formatVersion: PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1,
      workDescriptorHash: state.created.credential.workDescriptorHash,
      domainId: state.descriptor.domainId,
      domainEpoch: state.descriptor.expectedDomainEpoch,
      aiRoot: state.aiRoot,
      processorSignerPrivateKey: state.processorSigner.privateKey,
    };
    const substitutions: ProcessorCredentialSecretV1[] = [
      { ...baseSecret, workDescriptorHash: new Uint8Array(32).fill(0x71) },
      { ...baseSecret, domainId: cryptoDomainId("domain-substituted") },
      {
        ...baseSecret,
        domainEpoch: domainEpoch(baseSecret.domainEpoch + 1),
      },
      {
        ...baseSecret,
        processorSignerPrivateKey: new Uint8Array(32).fill(0x72),
      },
    ];

    try {
      for (const substituted of substitutions) {
        state.crypto.openSealed = async () =>
          encodeProcessorCredentialSecretV1(substituted);
        expect(openProcessorCredentialV1(state.crypto, {
          credentialBytes: state.created.bytes,
          recipientPrivateKey: state.recipient.privateKey,
          now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
          resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
        })).rejects.toThrow();
      }
    } finally {
      state.crypto.openSealed = originalOpen;
    }
    expect(openProcessorCredentialV1(state.crypto, {
      credentialBytes: state.created.bytes,
      recipientPrivateKey: new Uint8Array(31),
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
    })).rejects.toThrow("exactly 32 bytes");
  });

  test("zeroizes verifier authority context and opener-owned credential state", async () => {
    const state = await createProcessorCredentialFixtureV1(24_207);
    const originalFill = Uint8Array.prototype.fill;
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    const zeroized: Array<{ before: Uint8Array; target: Uint8Array }> = [];
    let context: ProcessorCredentialIssuerAuthorityContextV1 | null = null;
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const before = this.slice();
      const result = originalFill.call(this, value, start, end);
      if (value === 0) zeroized.push({ before, target: this });
      return result;
    };

    try {
      await verifyProcessorCredentialV1(state.crypto, {
        credentialBytes: state.created.bytes,
        now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
        resolveCurrentIssuerPublicKey: (value) => {
          zeroized.length = 0;
          context = value;
          return state.issuer.publicKey;
        },
      });
      expect(context).not.toBeNull();
      expect(context!.issuerSigningPublicKeyHash.every((byte) => byte === 0))
        .toBe(true);
      expect(context!.workDescriptorHash.every((byte) => byte === 0))
        .toBe(true);
      expect(zeroized.some(({ before, target }) =>
        before.every((byte, index) => byte === state.issuer.publicKey[index])
        && before.length === state.issuer.publicKey.length
        && target.every((byte) => byte === 0)
      )).toBe(true);

      state.crypto.openSealed = async (privateKey, sealed) => {
        zeroized.length = 0;
        return originalOpen(privateKey, sealed);
      };
      await openProcessorCredentialV1(state.crypto, {
        credentialBytes: state.created.bytes,
        recipientPrivateKey: state.recipient.privateKey,
        now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
        resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
      });
      for (const expected of [state.created.bytes, state.created.hash]) {
        expect(zeroized.some(({ before, target }) =>
          before.length === expected.length
          && before.every((byte, index) => byte === expected[index])
          && target.every((byte) => byte === 0)
        )).toBe(true);
      }

      state.crypto.openSealed = async () => {
        zeroized.length = 0;
        return new Uint8Array([1]);
      };
      expect(openProcessorCredentialV1(state.crypto, {
        credentialBytes: state.created.bytes,
        recipientPrivateKey: state.recipient.privateKey,
        now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
        resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
      })).rejects.toThrow();
      for (const expected of [state.created.bytes, state.created.hash]) {
        expect(zeroized.some(({ before, target }) =>
          before.length === expected.length
          && before.every((byte, index) => byte === expected[index])
          && target.every((byte) => byte === 0)
        )).toBe(true);
      }
    } finally {
      state.crypto.openSealed = originalOpen;
      Uint8Array.prototype.fill = originalFill;
    }
  });

  test("zeroizes every captured creation secret after successful issuance", async () => {
    const state = await createProcessorCredentialFixtureV1(24_208);
    const originalFill = Uint8Array.prototype.fill;
    const originalSeal = state.crypto.sealTo.bind(state.crypto);
    const originalSign = state.crypto.sign.bind(state.crypto);
    const originalVerify = state.crypto.verify.bind(state.crypto);
    const zeroized: Array<{ before: Uint8Array; target: Uint8Array }> = [];
    let sealedPlaintext: Uint8Array | null = null;
    let encryptedSecret: Uint8Array | null = null;
    let signingPrivateKey: Uint8Array | null = null;
    let signingBytes: Uint8Array | null = null;
    let verifyingPublicKey: Uint8Array | null = null;
    let verifyingSignature: Uint8Array | null = null;
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const before = this.slice();
      const result = originalFill.call(this, value, start, end);
      if (value === 0) zeroized.push({ before, target: this });
      return result;
    };
    state.crypto.sealTo = async (publicKey, plaintext) => {
      sealedPlaintext = plaintext;
      encryptedSecret = await originalSeal(publicKey, plaintext);
      return encryptedSecret;
    };
    state.crypto.sign = (privateKey, message) => {
      signingPrivateKey = privateKey;
      signingBytes = message;
      return originalSign(privateKey, message);
    };
    state.crypto.verify = (publicKey, message, signature) => {
      zeroized.length = 0;
      verifyingPublicKey = publicKey;
      verifyingSignature = signature;
      return originalVerify(publicKey, message, signature);
    };
    const expectCapturedZeroized = (captured: Uint8Array | null): void => {
      expect(captured).not.toBeNull();
      expect(captured?.every((byte) => byte === 0)).toBe(true);
    };

    try {
      await createProcessorCredentialV1(state.crypto, {
        id: "processor-credential-zeroization",
        workDescriptor: state.descriptor,
        issuingHumanId: state.created.credential.issuingHumanId,
        issuingDeviceId: state.created.credential.issuingDeviceId,
        issuingDeviceAuthorizationRevision:
          state.created.credential.issuingDeviceAuthorizationRevision,
        issuingDeviceSigningPublicKey: state.issuer.publicKey,
        issuingDeviceSigningPrivateKey: state.issuer.privateKey,
        signer: state.created.credential.signer,
        signerPublicKey: state.processorSigner.publicKey,
        signerPrivateKey: state.processorSigner.privateKey,
        aiRoot: state.aiRoot,
      });
      for (const captured of [
        sealedPlaintext,
        encryptedSecret,
        signingPrivateKey,
        signingBytes,
        verifyingPublicKey,
        verifyingSignature,
      ]) {
        expectCapturedZeroized(captured);
      }
      for (const expected of [state.processorSigner.privateKey, state.aiRoot]) {
        expect(zeroized.some(({ before, target }) =>
          before.length === expected.length
          && before.every((byte, index) => byte === expected[index])
          && target.every((byte) => byte === 0)
        )).toBe(true);
      }
    } finally {
      state.crypto.sealTo = originalSeal;
      state.crypto.sign = originalSign;
      state.crypto.verify = originalVerify;
      Uint8Array.prototype.fill = originalFill;
    }
  });
});
