import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createProcessorObjectSignerPublicV1,
} from "../../src/background/processor-object-signer-v1.ts";
import {
  createProcessorSignerAuthorizationV1,
  decodeProcessorSignerAuthorizationV1,
  encodeProcessorSignerAuthorizationV1,
  MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
  PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
  processorSignerAuthorizationSigningBytesV1,
  verifyCurrentProcessorSignerAuthorizationV1,
  verifyCurrentProcessorSignerAuthorizationForCredentialV1,
  verifyHistoricalProcessorSignerAuthorizationV1,
  type ProcessorSignerAuthorizationAuthorityContextV1,
  type ProcessorSignerAuthorizationUnsignedV1,
} from "../../src/background/processor-signer-authorization-v1.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";
import {
  createProcessorCredentialFixtureV1,
} from "../helpers/processor-credential-v1-fixture.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function hash(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function fixture() {
  const crypto = new LatticeCrypto(seededRng(2_420));
  const issuer = crypto.generateSigningKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const principal = createProcessorObjectSignerPublicV1(crypto, {
    processorKind: "stenographer",
    processorVersion: 1,
    signerAuthorizationId: "processor-auth-1",
    workDescriptorHash: hash(0x11),
    signerPrivateKey: signer.privateKey,
  }).principal;
  const unsigned: ProcessorSignerAuthorizationUnsignedV1 = {
    formatVersion: PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
    id: "processor-auth-1",
    processorKind: "stenographer",
    processorVersion: 1,
    workId: "journal-batch-1",
    namespaceId: namespaceId("room-1"),
    domainId: cryptoDomainId("domain-1"),
    domainEpoch: domainEpoch(4),
    namespaceAccessRevision: accessRevision(8),
    policyRevision: authorizationRevision(9),
    processorAuthorizationRevision: authorizationRevision(5),
    issuingHumanId: humanId("alice"),
    issuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingDeviceAuthorizationRevision: authorizationRevision(6),
    issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey),
    signer: principal,
    signerPublicKey: signer.publicKey,
    workDescriptorHash: hash(0x11),
    credentialHash: hash(0x22),
    outputObjectIds: [
      objectId("journal-event-1"),
      objectId("journal-event-2"),
    ],
    maxOutputObjects: 2,
    maxOutputPlaintextBytes: 4_096,
    maxOutputCiphertextBytes: 8_192,
    issuedAt: 1_000,
    expiresAt: 601_000,
  };
  return { crypto, issuer, signer, unsigned };
}

describe("processor signer authorization v1", () => {
  test("keeps historical V1 credentials Stenographer-only when generic principals admit Reflection", () => {
    const state = fixture();
    expect(() => createProcessorSignerAuthorizationV1(state.crypto, {
      ...state.unsigned, signer: {...state.unsigned.signer, processorKind: "reflection"},
    }, state.issuer.privateKey)).toThrow();
  });

  async function exactCredentialAuthorization(seed: number) {
    const credential = await createProcessorCredentialFixtureV1(seed);
    const created = createProcessorSignerAuthorizationV1(
      credential.crypto,
      {
        formatVersion: PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
        id: credential.created.credential.signer.signerAuthorizationId,
        processorKind: "stenographer",
        processorVersion: 1,
        workId: credential.descriptor.workId,
        namespaceId: credential.descriptor.namespaceId,
        domainId: credential.descriptor.domainId,
        domainEpoch: credential.descriptor.expectedDomainEpoch,
        namespaceAccessRevision:
          credential.descriptor.expectedNamespaceAccessRevision,
        policyRevision: credential.descriptor.expectedPolicyRevision,
        processorAuthorizationRevision: authorizationRevision(19),
        issuingHumanId: credential.created.credential.issuingHumanId,
        issuingDeviceId: credential.created.credential.issuingDeviceId,
        issuingDeviceAuthorizationRevision:
          credential.created.credential.issuingDeviceAuthorizationRevision,
        issuerSigningPublicKeyHash:
          credential.created.credential.issuerSigningPublicKeyHash,
        signer: credential.created.credential.signer,
        signerPublicKey: credential.created.credential.signerPublicKey,
        workDescriptorHash:
          credential.created.credential.workDescriptorHash,
        credentialHash: credential.created.hash,
        outputObjectIds: credential.descriptor.outputObjectIds,
        maxOutputObjects: credential.descriptor.maximumOutputObjectCount,
        maxOutputPlaintextBytes:
          credential.descriptor.maximumPlaintextBytes,
        maxOutputCiphertextBytes:
          credential.descriptor.maximumCiphertextBytes,
        issuedAt: credential.created.credential.issuedAt,
        expiresAt: credential.created.credential.expiresAt,
      },
      credential.issuer.privateKey,
    );
    return { credential, created };
  }

  test("rejects every malformed authorization field at its owning boundary", () => {
    const state = fixture();
    for (const invalid of [null, [], "authorization"] as unknown[]) {
      expect(() => createProcessorSignerAuthorizationV1(
        state.crypto,
        invalid as never,
        state.issuer.privateKey,
      )).toThrow("must be an object");
    }

    const { id: _id, ...sameCountSubstitution } = state.unsigned;
    expect(() => createProcessorSignerAuthorizationV1(
      state.crypto,
      {
        ...sameCountSubstitution,
        grantId: "authorization-field-substitution",
      } as never,
      state.issuer.privateKey,
    )).toThrow("field set");
    expect(() => createProcessorSignerAuthorizationV1(
      state.crypto,
      { ...state.unsigned, signerPublicKey: new Uint8Array(31) },
      state.issuer.privateKey,
    )).toThrow("signer public key must be exactly 32 bytes");
    expect(() => createProcessorSignerAuthorizationV1(
      state.crypto,
      {
        ...state.unsigned,
        signer: { ...state.unsigned.signer, kind: "agent" as never },
      },
      state.issuer.privateKey,
    )).toThrow("principal kind is invalid");

    const invalidUnsigned: ProcessorSignerAuthorizationUnsignedV1[] = [
      { ...state.unsigned, formatVersion: 2 as never },
      { ...state.unsigned, id: "" },
      { ...state.unsigned, processorKind: "summarizer" as never },
      { ...state.unsigned, processorVersion: 2 as never },
      { ...state.unsigned, workId: "" },
      { ...state.unsigned, namespaceId: "" as never },
      { ...state.unsigned, domainId: "" as never },
      { ...state.unsigned, domainEpoch: -1 as never },
      { ...state.unsigned, namespaceAccessRevision: -1 as never },
      { ...state.unsigned, policyRevision: -1 as never },
      { ...state.unsigned, processorAuthorizationRevision: -1 as never },
      { ...state.unsigned, issuingHumanId: "" as never },
      { ...state.unsigned, issuingDeviceId: "" as never },
      {
        ...state.unsigned,
        issuingDeviceAuthorizationRevision: -1 as never,
      },
      { ...state.unsigned, issuerSigningPublicKeyHash: new Uint8Array(31) },
      {
        ...state.unsigned,
        signer: {
          ...state.unsigned.signer,
          signerAuthorizationId: "authorization-other",
        },
      },
      {
        ...state.unsigned,
        signer: {
          ...state.unsigned.signer,
          workDescriptorHash: hash(0x7a),
        },
      },
      { ...state.unsigned, workDescriptorHash: new Uint8Array(31) },
      { ...state.unsigned, credentialHash: new Uint8Array(31) },
      { ...state.unsigned, outputObjectIds: [] },
      { ...state.unsigned, outputObjectIds: {} as never },
      {
        ...state.unsigned,
        outputObjectIds: [
          state.unsigned.outputObjectIds[0]!,
          state.unsigned.outputObjectIds[0]!,
        ],
      },
      {
        ...state.unsigned,
        outputObjectIds: [...state.unsigned.outputObjectIds].reverse(),
      },
      { ...state.unsigned, maxOutputObjects: 0 },
      { ...state.unsigned, maxOutputObjects: 1 },
      { ...state.unsigned, maxOutputPlaintextBytes: 0 },
      { ...state.unsigned, maxOutputCiphertextBytes: 0 },
      { ...state.unsigned, issuedAt: -1 },
      { ...state.unsigned, issuedAt: Number.NaN },
      { ...state.unsigned, issuedAt: 1.5 },
      { ...state.unsigned, expiresAt: Number.NaN },
      { ...state.unsigned, expiresAt: 2.5 },
      { ...state.unsigned, expiresAt: state.unsigned.issuedAt },
      {
        ...state.unsigned,
        expiresAt: state.unsigned.issuedAt + 600_001,
      },
    ];
    for (const invalid of invalidUnsigned) {
      expect(() => createProcessorSignerAuthorizationV1(
        state.crypto,
        invalid,
        state.issuer.privateKey,
      )).toThrow();
    }
    expect(() => createProcessorSignerAuthorizationV1(
      state.crypto,
      state.unsigned,
      new Uint8Array(31),
    )).toThrow("exactly 32 bytes");

    const created = createProcessorSignerAuthorizationV1(
      state.crypto,
      state.unsigned,
      state.issuer.privateKey,
    );
    expect(() => encodeProcessorSignerAuthorizationV1({
      ...created.authorization,
      signature: new Uint8Array(63),
    })).toThrow("exactly 64 bytes");
  });

  test("round-trips exact public authority and verifies current issuance", () => {
    const state = fixture();
    const created = createProcessorSignerAuthorizationV1(
      state.crypto,
      state.unsigned,
      state.issuer.privateKey,
    );
    const decoded = decodeProcessorSignerAuthorizationV1(created.bytes);
    const verified = verifyCurrentProcessorSignerAuthorizationV1(
      state.crypto,
      {
        authorizationBytes: created.bytes,
        now: 1_000,
        resolveCurrentIssuingDevicePublicKey: (context) => {
          expect(context.purpose)
            .toBe("issue-processor-signer-authorization");
          return state.issuer.publicKey;
        },
      },
    );

    expect(decoded).toEqual(created.authorization);
    expect(encodeProcessorSignerAuthorizationV1(decoded))
      .toEqual(created.bytes);
    expect(verified.authorization).toEqual(created.authorization);
    expect(verified.authorizationHash).toEqual(
      state.crypto.hash(created.bytes),
    );
  });

  test("rejects non-authorization wire before normalization", () => {
    const state = fixture();
    const created = createProcessorSignerAuthorizationV1(
      state.crypto,
      state.unsigned,
      state.issuer.privateKey,
    );
    const wrongDomain = created.bytes.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;

    expect(() => decodeProcessorSignerAuthorizationV1([] as never))
      .toThrow("Uint8Array");
    expect(() => decodeProcessorSignerAuthorizationV1(
      new Uint8Array(MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1 + 1),
    )).toThrow("wire limit");
    expect(() => decodeProcessorSignerAuthorizationV1(wrongDomain))
      .toThrow("domain mismatch");
  });

  test("accepts exact output and lifetime boundaries", () => {
    const state = fixture();
    const oneOutput = {
      ...state.unsigned,
      outputObjectIds: [objectId("boundary-output")],
      maxOutputObjects: 1,
      maxOutputPlaintextBytes: 1,
      maxOutputCiphertextBytes: 1,
      expiresAt:
        state.unsigned.issuedAt + 10 * 60 * 1_000,
    };
    expect(() => createProcessorSignerAuthorizationV1(
      state.crypto,
      oneOutput,
      state.issuer.privateKey,
    )).not.toThrow();

    const epochCreated = createProcessorSignerAuthorizationV1(
      state.crypto,
      {
        ...oneOutput,
        issuedAt: 0,
        expiresAt: 10 * 60 * 1_000,
      },
      state.issuer.privateKey,
    );
    expect(() => verifyCurrentProcessorSignerAuthorizationV1(
      state.crypto,
      {
        authorizationBytes: epochCreated.bytes,
        now: 0,
        resolveCurrentIssuingDevicePublicKey: () => state.issuer.publicKey,
      },
    )).not.toThrow();

    const maximumOutputs = Array.from(
      { length: V2_LIMITS.batchItems },
      (_value, index) => objectId(`boundary-${index.toString().padStart(3, "0")}`),
    );
    expect(() => createProcessorSignerAuthorizationV1(
      state.crypto,
      {
        ...state.unsigned,
        outputObjectIds: maximumOutputs,
        maxOutputObjects: V2_LIMITS.batchItems,
        maxOutputPlaintextBytes: V2_LIMITS.plaintextBytes,
        maxOutputCiphertextBytes: V2_LIMITS.ciphertextBytes,
      },
      state.issuer.privateKey,
    )).not.toThrow();
  });

  test("fails closed at every issuer and signer verification boundary", () => {
    const state = fixture();
    const created = createProcessorSignerAuthorizationV1(
      state.crypto,
      state.unsigned,
      state.issuer.privateKey,
    );
    const verify = (bytes: Uint8Array, now: number, resolver: unknown) =>
      verifyCurrentProcessorSignerAuthorizationV1(state.crypto, {
        authorizationBytes: bytes,
        now,
        resolveCurrentIssuingDevicePublicKey: resolver as never,
      });

    expect(() => verify(created.bytes, -1, () => state.issuer.publicKey))
      .toThrow("current time");
    expect(() => verify(created.bytes, state.unsigned.issuedAt, () => null))
      .toThrow("not authorized");
    expect(() => verify(
      created.bytes,
      state.unsigned.issuedAt,
      () => new Uint8Array(31),
    )).toThrow("exactly 32 bytes");

    const alternateSigner = state.crypto.generateSigningKeyPair();
    const { signature: _signature, ...unsigned } = created.authorization;
    const substitutedUnsigned = {
      ...unsigned,
      signerPublicKey: alternateSigner.publicKey,
    };
    const signingBytes = processorSignerAuthorizationSigningBytesV1(
      substitutedUnsigned,
    );
    const substitutedBytes = encodeProcessorSignerAuthorizationV1({
      ...substitutedUnsigned,
      signature: state.crypto.sign(state.issuer.privateKey, signingBytes),
    });
    signingBytes.fill(0);
    expect(() => verify(
      substitutedBytes,
      state.unsigned.issuedAt,
      () => state.issuer.publicKey,
    )).toThrow("signer key id");
  });

  test("rejects mismatched but well-sized creation keys", () => {
    const state = fixture();
    const alternateIssuer = state.crypto.generateSigningKeyPair();
    const alternateSigner = state.crypto.generateSigningKeyPair();
    expect(() => createProcessorSignerAuthorizationV1(
      state.crypto,
      state.unsigned,
      alternateIssuer.privateKey,
    )).toThrow("issuer key hash");
    expect(() => createProcessorSignerAuthorizationV1(
      state.crypto,
      { ...state.unsigned, signerPublicKey: alternateSigner.publicKey },
      state.issuer.privateKey,
    )).toThrow("signer key id");

    const originalHash = state.crypto.hash.bind(state.crypto);
    state.crypto.hash = () => new Uint8Array(31);
    try {
      expect(() => createProcessorSignerAuthorizationV1(
        state.crypto,
        state.unsigned,
        state.issuer.privateKey,
      )).toThrow(
        "issuing device public key hash must be exactly 32 bytes",
      );
    } finally {
      state.crypto.hash = originalHash;
    }
  });

  test("historical verification survives expiry and current device revocation", () => {
    const state = fixture();
    const created = createProcessorSignerAuthorizationV1(
      state.crypto,
      state.unsigned,
      state.issuer.privateKey,
    );
    expect(() =>
      verifyCurrentProcessorSignerAuthorizationV1(state.crypto, {
        authorizationBytes: created.bytes,
        now: state.unsigned.expiresAt,
        resolveCurrentIssuingDevicePublicKey: () => null,
      })
    ).toThrow("not currently valid");

    expect(
      verifyHistoricalProcessorSignerAuthorizationV1(state.crypto, {
        authorizationBytes: created.bytes,
        resolveHistoricalIssuingDevicePublicKey: (context) => {
          expect(context.purpose)
            .toBe("verify-historical-processor-signer-authorization");
          return state.issuer.publicKey;
        },
      }).authorization,
    ).toEqual(created.authorization);
  });

  test("fails closed on signer, work, key, signature, field, and wire substitution", () => {
    const state = fixture();
    const created = createProcessorSignerAuthorizationV1(
      state.crypto,
      state.unsigned,
      state.issuer.privateKey,
    );
    const verify = (bytes: Uint8Array) =>
      verifyHistoricalProcessorSignerAuthorizationV1(state.crypto, {
        authorizationBytes: bytes,
        resolveHistoricalIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      });

    for (const change of [
      { workId: "journal-batch-other" },
      { credentialHash: hash(0x33) },
      { outputObjectIds: [objectId("journal-event-other")] },
      {
        signer: {
          ...created.authorization.signer,
          workDescriptorHash: hash(0x44),
        },
      },
    ]) {
      expect(() =>
        verify(encodeProcessorSignerAuthorizationV1({
          ...created.authorization,
          ...change,
        }))
      ).toThrow();
    }
    expect(() =>
      verifyHistoricalProcessorSignerAuthorizationV1(state.crypto, {
        authorizationBytes: created.bytes,
        resolveHistoricalIssuingDevicePublicKey: () =>
          new Uint8Array(32).fill(0xff),
      })
    ).toThrow();
    expect(() =>
      encodeProcessorSignerAuthorizationV1({
        ...created.authorization,
        extra: true,
      } as never)
    ).toThrow("field");
    expect(() => decodeProcessorSignerAuthorizationV1(
      new Uint8Array([...created.bytes, 0]),
    )).toThrow();
  });

  test("rejects noncanonical outputs and invalid time or output budgets", () => {
    const state = fixture();
    expect(() =>
      createProcessorSignerAuthorizationV1(
        state.crypto,
        {
          ...state.unsigned,
          outputObjectIds: [...state.unsigned.outputObjectIds].reverse(),
        },
        state.issuer.privateKey,
      )
    ).toThrow("canonical");
    expect(() =>
      createProcessorSignerAuthorizationV1(
        state.crypto,
        {
          ...state.unsigned,
          expiresAt: state.unsigned.issuedAt,
        },
        state.issuer.privateKey,
      )
    ).toThrow("timestamps");
    expect(() =>
      createProcessorSignerAuthorizationV1(
        state.crypto,
        {
          ...state.unsigned,
          maxOutputObjects: 1,
        },
        state.issuer.privateKey,
      )
    ).toThrow("output");
    expect(() =>
      createProcessorSignerAuthorizationV1(
        state.crypto,
        {
          ...state.unsigned,
          maxOutputObjects: 3,
        },
        state.issuer.privateKey,
      )
    ).toThrow("output");
    expect(() =>
      createProcessorSignerAuthorizationV1(
        state.crypto,
        {
          ...state.unsigned,
          maxOutputCiphertextBytes: 0,
        },
        state.issuer.privateKey,
      )
    ).toThrow("ciphertext");
  });

  test("verifies a signer certificate only with its exact referenced credential", async () => {
    const exact = await exactCredentialAuthorization(24_260);
    const foreign = await exactCredentialAuthorization(24_261);
    const verify = (
      authorizationBytes: Uint8Array,
      signerIssuerPublicKey: Uint8Array,
    ) => verifyCurrentProcessorSignerAuthorizationForCredentialV1(
      exact.credential.crypto,
      {
        authorizationBytes,
        credentialBytes: exact.credential.created.bytes,
        now: exact.credential.descriptor.notBefore,
        resolveCurrentCredentialIssuerPublicKey: () =>
          exact.credential.issuer.publicKey,
        resolveCurrentSignerIssuingDevicePublicKey: () =>
          signerIssuerPublicKey,
      },
    );

    expect(
      (await verify(
        exact.created.bytes,
        exact.credential.issuer.publicKey,
      )).signerAuthorization.authorization.credentialHash,
    ).toEqual(exact.credential.created.hash);
    expect(
      verify(
        foreign.created.bytes,
        foreign.credential.issuer.publicKey,
      ),
    ).rejects.toThrow("does not match the exact credential");
    const {
      signature: _signature,
      ...exactUnsigned
    } = exact.created.authorization;
    const staleRevision = createProcessorSignerAuthorizationV1(
      exact.credential.crypto,
      {
        ...exactUnsigned,
        processorAuthorizationRevision: authorizationRevision(20),
      },
      exact.credential.issuer.privateKey,
    );
    expect(
      verify(
        staleRevision.bytes,
        exact.credential.issuer.publicKey,
      ),
    ).rejects.toThrow("does not match the exact credential");
    expect(verifyCurrentProcessorSignerAuthorizationForCredentialV1(
      exact.credential.crypto,
      {
        authorizationBytes: exact.created.bytes,
        credentialBytes: exact.credential.created.bytes,
        now: exact.credential.descriptor.notBefore,
        resolveCurrentCredentialIssuerPublicKey: () =>
          exact.credential.issuer.publicKey,
        resolveCurrentSignerIssuingDevicePublicKey: () => null,
      },
    )).rejects.toThrow("issuing device is not authorized");
  });

  test("rejects each independently re-signed credential binding substitution", async () => {
    const exact = await exactCredentialAuthorization(24_262);
    const { signature: _signature, ...unsigned } =
      exact.created.authorization;
    const alternateSigner = exact.credential.crypto.generateSigningKeyPair();
    const alternatePrincipal = createProcessorObjectSignerPublicV1(
      exact.credential.crypto,
      {
        processorKind: "stenographer",
        processorVersion: 1,
        signerAuthorizationId: unsigned.id,
        workDescriptorHash: unsigned.workDescriptorHash,
        signerPrivateKey: alternateSigner.privateKey,
      },
    ).principal;
    const substitutions: ProcessorSignerAuthorizationUnsignedV1[] = [
      { ...unsigned, workId: "work-substituted" },
      { ...unsigned, namespaceId: namespaceId("namespace-substituted") },
      { ...unsigned, domainId: cryptoDomainId("domain-substituted") },
      { ...unsigned, domainEpoch: domainEpoch(unsigned.domainEpoch + 1) },
      {
        ...unsigned,
        namespaceAccessRevision:
          accessRevision(unsigned.namespaceAccessRevision + 1),
      },
      {
        ...unsigned,
        policyRevision: authorizationRevision(unsigned.policyRevision + 1),
      },
      {
        ...unsigned,
        processorAuthorizationRevision:
          authorizationRevision(unsigned.processorAuthorizationRevision + 1),
      },
      { ...unsigned, issuingHumanId: humanId("human-substituted") },
      {
        ...unsigned,
        issuingDeviceId: cryptoDeviceId("device-substituted"),
      },
      {
        ...unsigned,
        issuingDeviceAuthorizationRevision: authorizationRevision(
          unsigned.issuingDeviceAuthorizationRevision + 1,
        ),
      },
      {
        ...unsigned,
        id: "authorization-substituted",
        signer: {
          ...unsigned.signer,
          signerAuthorizationId: "authorization-substituted",
        },
      },
      {
        ...unsigned,
        signer: alternatePrincipal,
        signerPublicKey: alternateSigner.publicKey,
      },
      { ...unsigned, credentialHash: hash(0x7a) },
      {
        ...unsigned,
        outputObjectIds: unsigned.outputObjectIds.map((_id, index) =>
          objectId(`output-substituted-${index}`)
        ),
      },
      {
        ...unsigned,
        maxOutputPlaintextBytes: unsigned.maxOutputPlaintextBytes - 1,
      },
      {
        ...unsigned,
        maxOutputCiphertextBytes: unsigned.maxOutputCiphertextBytes - 1,
      },
      { ...unsigned, issuedAt: unsigned.issuedAt + 1 },
      { ...unsigned, expiresAt: unsigned.expiresAt - 1 },
    ];

    for (const substituted of substitutions) {
      const created = createProcessorSignerAuthorizationV1(
        exact.credential.crypto,
        substituted,
        exact.credential.issuer.privateKey,
      );
      expect(verifyCurrentProcessorSignerAuthorizationForCredentialV1(
        exact.credential.crypto,
        {
          authorizationBytes: created.bytes,
          credentialBytes: exact.credential.created.bytes,
          now: exact.credential.descriptor.notBefore + 1,
          resolveCurrentCredentialIssuerPublicKey: () =>
            exact.credential.issuer.publicKey,
          resolveCurrentSignerIssuingDevicePublicKey: () =>
            exact.credential.issuer.publicKey,
        },
      )).rejects.toThrow("does not match the exact credential");
    }
  });

  test("zeroizes resolver context and both verified records after binding failure", async () => {
    const exact = await exactCredentialAuthorization(24_263);
    const foreign = await exactCredentialAuthorization(24_264);
    const originalFill = Uint8Array.prototype.fill;
    const zeroized: Array<{ before: Uint8Array; target: Uint8Array }> = [];
    let context: ProcessorSignerAuthorizationAuthorityContextV1 | null = null;
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
      expect(verifyCurrentProcessorSignerAuthorizationForCredentialV1(
        exact.credential.crypto,
        {
          authorizationBytes: foreign.created.bytes,
          credentialBytes: exact.credential.created.bytes,
          now: exact.credential.descriptor.notBefore,
          resolveCurrentCredentialIssuerPublicKey: () =>
            exact.credential.issuer.publicKey,
          resolveCurrentSignerIssuingDevicePublicKey: (value) => {
            zeroized.length = 0;
            context = value;
            return foreign.credential.issuer.publicKey;
          },
        },
      )).rejects.toThrow("does not match the exact credential");

      expect(context).not.toBeNull();
      for (const value of [
        context!.issuerSigningPublicKeyHash,
        context!.signer.workDescriptorHash,
        context!.signerPublicKey,
        context!.workDescriptorHash,
        context!.credentialHash,
      ]) {
        expect(value.every((byte) => byte === 0)).toBe(true);
      }
      for (const expected of [
        foreign.created.bytes,
        foreign.created.hash,
        exact.credential.created.bytes,
        exact.credential.created.hash,
      ]) {
        expect(zeroized.some(({ before, target }) =>
          before.length === expected.length
          && before.every((byte, index) => byte === expected[index])
          && target.every((byte) => byte === 0)
        )).toBe(true);
      }
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
  });

  test("zeroizes captured issuance key and signing bytes", () => {
    const state = fixture();
    const originalFill = Uint8Array.prototype.fill;
    const originalSign = state.crypto.sign.bind(state.crypto);
    const zeroized: Array<{ before: Uint8Array; target: Uint8Array }> = [];
    let privateKey: Uint8Array | null = null;
    let signingBytes: Uint8Array | null = null;
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
    state.crypto.sign = (capturedPrivateKey, capturedSigningBytes) => {
      zeroized.length = 0;
      privateKey = capturedPrivateKey;
      signingBytes = capturedSigningBytes;
      return originalSign(capturedPrivateKey, capturedSigningBytes);
    };

    try {
      createProcessorSignerAuthorizationV1(
        state.crypto,
        state.unsigned,
        state.issuer.privateKey,
      );
      expect(privateKey).not.toBeNull();
      expect(privateKey!.every((byte) => byte === 0)).toBe(true);
      expect(signingBytes).not.toBeNull();
      expect(signingBytes!.every((byte) => byte === 0)).toBe(true);
      expect(zeroized.some(({ before, target }) =>
        before.length === state.issuer.publicKey.length
        && before.every((byte, index) =>
          byte === state.issuer.publicKey[index]
        )
        && target.every((byte) => byte === 0)
      )).toBe(true);
    } finally {
      state.crypto.sign = originalSign;
      Uint8Array.prototype.fill = originalFill;
    }
  });
});
