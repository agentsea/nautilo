import { describe, expect, test } from "bun:test";

import {
  deriveAgentRuntimeObjectSignerPublicV1,
} from "../../src/agent-runtime/object-signer-v1.ts";
import type {
  AgentRuntimeGenerationV2,
} from "../../src/agent-runtime/types.ts";
import {
  createProcessorObjectSignerPublicV1,
} from "../../src/background/processor-object-signer-v1.ts";
import {
  createProcessorSignerAuthorizationV1,
  PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
  type ProcessorSignerAuthorizationUnsignedV1,
} from "../../src/background/processor-signer-authorization-v1.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  OBJECT_ACCESS_MANIFEST_DOMAIN_V4,
  OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4,
  createAgentObjectAccessManifestV4,
  createProcessorObjectAccessManifestV4,
  decodeObjectAccessManifestV4,
  encodeObjectAccessManifestV4,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V4,
  verifyObjectAccessManifestV4,
  type ObjectAccessManifestUnsignedV4,
} from "../../src/format/object-access-manifest-v4.ts";
import {
  OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3,
} from "../../src/format/object-access-manifest-v3.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";

function hash(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function bytesIndexOf(haystack: Uint8Array, needle: Uint8Array): number {
  return haystack.findIndex((_, index) =>
    needle.every((byte, offset) => haystack[index + offset] === byte)
  );
}

function agentRuntime(): AgentRuntimeGenerationV2 {
  return {
    agentId: agentId("agent-alpha"),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(7),
    key: hash(0x71),
  };
}

function processorFixture() {
  const crypto = new LatticeCrypto(seededRng(2_441));
  const issuer = crypto.generateSigningKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const principal = createProcessorObjectSignerPublicV1(crypto, {
    processorKind: "stenographer",
    processorVersion: 1,
    signerAuthorizationId: "processor-auth-1",
    workDescriptorHash: hash(0x41),
    signerPrivateKey: signer.privateKey,
  }).principal;
  const authorizationUnsigned: ProcessorSignerAuthorizationUnsignedV1 = {
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
    workDescriptorHash: hash(0x41),
    credentialHash: hash(0x42),
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
  const authorization = createProcessorSignerAuthorizationV1(
    crypto,
    authorizationUnsigned,
    issuer.privateKey,
  );
  const manifestUnsigned: ObjectAccessManifestUnsignedV4 = {
    objectId: objectId("journal-event-1"),
    payloadHash: hash(0x51),
    accessRevision: accessRevision(0),
    previousManifestHash: null,
    envelopeHashes: [hash(0x63), hash(0x62)],
    signer: principal,
    signerAuthorizationHash: authorization.hash,
    hostAuthorizationRevision: authorizationRevision(5),
  };
  return {
    crypto,
    issuer,
    signer,
    authorization,
    authorizationUnsigned,
    manifestUnsigned,
  };
}

describe("ObjectAccessManifestV4", () => {
  test("locks the exact maximum canonical wire size", () => {
    expect(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V4).toBe(9_952);
  });

  test("creates and historically verifies a processor manifest inside the certificate output boundary", () => {
    const state = processorFixture();
    const created = createProcessorObjectAccessManifestV4(
      state.crypto,
      state.manifestUnsigned,
      {
        signerPrivateKey: state.signer.privateKey,
        signerAuthorizationBytes: state.authorization.bytes,
        now: 1_000,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      },
    );
    const decoded = decodeObjectAccessManifestV4(created.bytes);
    const verified = verifyObjectAccessManifestV4(state.crypto, {
      manifestBytes: created.bytes,
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: (evidence) => {
        expect(evidence.authorizationId).toBe("processor-auth-1");
        expect(evidence.authorizationHash).toEqual(
          state.authorization.hash,
        );
        expect(evidence.signer).toEqual(state.authorizationUnsigned.signer);
        expect(evidence.objectId).toBe(objectId("journal-event-1"));
        return state.authorization.bytes;
      },
      resolveHistoricalIssuingDevicePublicKey: () =>
        state.issuer.publicKey,
    });

    expect(decoded).toEqual(created.manifest);
    expect(decoded.signer.kind).toBe("processor_invocation");
    expect(decoded.envelopeHashes).toEqual([hash(0x62), hash(0x63)]);
    expect(encodeObjectAccessManifestV4(decoded)).toEqual(created.bytes);
    expect(verified.manifest).toEqual(decoded);
    expect(verified.signerAuthorization?.authorization.id)
      .toBe("processor-auth-1");
    expect(verified.manifestHash).toEqual(state.crypto.hash(created.bytes));
    expect(OBJECT_ACCESS_MANIFEST_DOMAIN_V4)
      .toBe("nautilo/lattice-crypto/object-access-manifest/v4");
    expect(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4).toBe(4);
  });

  test("keeps an explicit Agent Runtime compatibility path without changing v2/v3", () => {
    const crypto = new LatticeCrypto(seededRng(2_442));
    const runtime = agentRuntime();
    const signer = deriveAgentRuntimeObjectSignerPublicV1(crypto, runtime);
    const unsigned: ObjectAccessManifestUnsignedV4 = {
      objectId: objectId("agent-output-1"),
      payloadHash: hash(0x11),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [],
      signer: signer.principal,
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(3),
    };
    const created = createAgentObjectAccessManifestV4(
      crypto,
      unsigned,
      runtime,
    );
    const verified = verifyObjectAccessManifestV4(crypto, {
      manifestBytes: created.bytes,
      resolveAgentRuntimeSignerPublicKey: (principal) =>
        principal.signerKeyId === signer.principal.signerKeyId
          ? signer.publicKey
          : null,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalIssuingDevicePublicKey: () => null,
    });

    expect(verified.manifest.signer).toEqual(signer.principal);
    expect(verified.signerAuthorization).toBeNull();
    expect(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2).toBe(2);
    expect(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3).toBe(3);
    expect(created.bytes).not.toEqual(
      new Uint8Array([OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3]),
    );

    expect(() =>
      verifyObjectAccessManifestV4(crypto, {
        manifestBytes: created.bytes,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalIssuingDevicePublicKey: () => null,
      })
    ).toThrow("trusted Agent Runtime signing key");
    expect(() =>
      verifyObjectAccessManifestV4(crypto, {
        manifestBytes: created.bytes,
        resolveAgentRuntimeSignerPublicKey: () => new Uint8Array(31),
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalIssuingDevicePublicKey: () => null,
      })
    ).toThrow("exactly 32 bytes");
    const otherSigner = deriveAgentRuntimeObjectSignerPublicV1(crypto, {
      ...runtime,
      key: hash(0x72),
    });
    expect(() =>
      verifyObjectAccessManifestV4(crypto, {
        manifestBytes: created.bytes,
        resolveAgentRuntimeSignerPublicKey: () => otherSigner.publicKey,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalIssuingDevicePublicKey: () => null,
      })
    ).toThrow("key id");
    const tamperedSignature = created.bytes.slice();
    const lastAgentByte = tamperedSignature.length - 1;
    tamperedSignature[lastAgentByte] = tamperedSignature[lastAgentByte]! ^ 1;
    expect(() =>
      verifyObjectAccessManifestV4(crypto, {
        manifestBytes: tamperedSignature,
        resolveAgentRuntimeSignerPublicKey: () => signer.publicKey,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalIssuingDevicePublicKey: () => null,
      })
    ).toThrow("signature");
  });

  test("rejects output, certificate, signer, revision, and authorization-hash substitution", () => {
    const state = processorFixture();
    const create = (unsigned = state.manifestUnsigned) =>
      createProcessorObjectAccessManifestV4(
        state.crypto,
        unsigned,
        {
          signerPrivateKey: state.signer.privateKey,
          signerAuthorizationBytes: state.authorization.bytes,
          now: 1_000,
          resolveCurrentIssuingDevicePublicKey: () =>
            state.issuer.publicKey,
        },
      );

    expect(() =>
      create({
        ...state.manifestUnsigned,
        objectId: objectId("journal-event-outside-boundary"),
      })
    ).toThrow("output boundary");
    expect(() =>
      create({
        ...state.manifestUnsigned,
        signerAuthorizationHash: hash(0xee),
      })
    ).toThrow("authorization hash");
    expect(() =>
      create({
        ...state.manifestUnsigned,
        hostAuthorizationRevision: authorizationRevision(6),
      })
    ).toThrow("authorization revision");

    const created = create();
    const otherAuthorization = createProcessorSignerAuthorizationV1(
      state.crypto,
      {
        ...state.authorizationUnsigned,
        id: "processor-auth-other",
        signer: {
          ...state.authorizationUnsigned.signer,
          signerAuthorizationId: "processor-auth-other",
        },
      },
      state.issuer.privateKey,
    );
    expect(() =>
      verifyObjectAccessManifestV4(state.crypto, {
        manifestBytes: created.bytes,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () =>
          otherAuthorization.bytes,
        resolveHistoricalIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      })
    ).toThrow("authorization hash");

    const substitutedObject = encodeObjectAccessManifestV4({
      ...created.manifest,
      objectId: objectId("journal-event-2"),
    });
    expect(() =>
      verifyObjectAccessManifestV4(state.crypto, {
        manifestBytes: substitutedObject,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () =>
          state.authorization.bytes,
        resolveHistoricalIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      })
    ).toThrow("signature");

    const otherSignerKeyPair = state.crypto.generateSigningKeyPair();
    const otherSigner = createProcessorObjectSignerPublicV1(state.crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-auth-1",
      workDescriptorHash: hash(0x41),
      signerPrivateKey: otherSignerKeyPair.privateKey,
    });
    const signerSubstitutions = [
      {
        ...state.manifestUnsigned.signer,
        signerAuthorizationId: "processor-auth-other",
      },
      {
        ...state.manifestUnsigned.signer,
        workDescriptorHash: hash(0x43),
      },
      otherSigner.principal,
    ];
    for (const substitutedSigner of signerSubstitutions) {
      const substituted = encodeObjectAccessManifestV4({
        ...created.manifest,
        signer: substitutedSigner,
      });
      expect(() =>
        verifyObjectAccessManifestV4(state.crypto, {
          manifestBytes: substituted,
          resolveAgentRuntimeSignerPublicKey: () => null,
          resolveProcessorSignerAuthorizationBytes: () =>
            state.authorization.bytes,
          resolveHistoricalIssuingDevicePublicKey: () =>
            state.issuer.publicKey,
        })
      ).toThrow("signer");
    }

    const tamperedSignature = created.bytes.slice();
    const lastProcessorByte = tamperedSignature.length - 1;
    tamperedSignature[lastProcessorByte] =
      tamperedSignature[lastProcessorByte]! ^ 1;
    expect(() =>
      verifyObjectAccessManifestV4(state.crypto, {
        manifestBytes: tamperedSignature,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () =>
          state.authorization.bytes,
        resolveHistoricalIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      })
    ).toThrow("signature");
  });

  test("rejects noncanonical envelope ordering and invalid presence tags", () => {
    const state = processorFixture();
    const processor = createProcessorObjectAccessManifestV4(
      state.crypto,
      state.manifestUnsigned,
      {
        signerPrivateKey: state.signer.privateKey,
        signerAuthorizationBytes: state.authorization.bytes,
        now: 1_000,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      },
    );
    const unordered = processor.bytes.slice();
    const firstHash = bytesIndexOf(unordered, hash(0x62)) - 4;
    const secondHash = bytesIndexOf(unordered, hash(0x63)) - 4;
    expect(firstHash).toBeGreaterThanOrEqual(0);
    expect(secondHash).toBeGreaterThan(firstHash);
    const firstFrame = unordered.slice(firstHash, firstHash + 36);
    const secondFrame = unordered.slice(secondHash, secondHash + 36);
    unordered.set(secondFrame, firstHash);
    unordered.set(firstFrame, secondHash);
    expect(() => decodeObjectAccessManifestV4(unordered))
      .toThrow("noncanonical ordering");

    const invalidAuthorizationPresence = processor.bytes.slice();
    const authorizationHashStart = bytesIndexOf(
      invalidAuthorizationPresence,
      state.authorization.hash,
    );
    expect(authorizationHashStart).toBeGreaterThanOrEqual(8);
    invalidAuthorizationPresence[authorizationHashStart - 5] = 2;
    expect(() =>
      decodeObjectAccessManifestV4(invalidAuthorizationPresence)
    ).toThrow("presence");

    const crypto = new LatticeCrypto(seededRng(2_443));
    const runtime = agentRuntime();
    const signer = deriveAgentRuntimeObjectSignerPublicV1(crypto, runtime);
    const agent = createAgentObjectAccessManifestV4(crypto, {
      objectId: objectId("agent-output-presence"),
      payloadHash: hash(0x21),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [],
      signer: signer.principal,
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(3),
    }, runtime);
    const invalidPreviousPresence = agent.bytes.slice();
    const payloadHashStart = bytesIndexOf(
      invalidPreviousPresence,
      hash(0x21),
    );
    expect(payloadHashStart).toBeGreaterThanOrEqual(0);
    invalidPreviousPresence[payloadHashStart + 43] = 2;
    expect(() => decodeObjectAccessManifestV4(invalidPreviousPresence))
      .toThrow("presence");
  });

  test("rejects malformed signer unions, noncanonical bytes, trailing bytes, and exact-bound violations", () => {
    const state = processorFixture();
    const runtime = agentRuntime();
    const runtimeSigner = deriveAgentRuntimeObjectSignerPublicV1(
      state.crypto,
      runtime,
    );
    expect(() =>
      createAgentObjectAccessManifestV4(
        state.crypto,
        state.manifestUnsigned,
        runtime,
      )
    ).toThrow("requires an Agent Runtime signer");
    expect(() =>
      createProcessorObjectAccessManifestV4(
        state.crypto,
        {
          ...state.manifestUnsigned,
          signer: runtimeSigner.principal,
          signerAuthorizationHash: null,
        },
        {
          signerPrivateKey: state.signer.privateKey,
          signerAuthorizationBytes: state.authorization.bytes,
          now: 1_000,
          resolveCurrentIssuingDevicePublicKey: () =>
            state.issuer.publicKey,
        },
      )
    ).toThrow("requires a processor signer");
    expect(() =>
      createProcessorObjectAccessManifestV4(
        state.crypto,
        {
          ...state.manifestUnsigned,
          signerAuthorizationHash: null,
        },
        {
          signerPrivateKey: state.signer.privateKey,
          signerAuthorizationBytes: state.authorization.bytes,
          now: 1_000,
          resolveCurrentIssuingDevicePublicKey: () =>
            state.issuer.publicKey,
        },
      )
    ).toThrow("requires");
    expect(() =>
      createProcessorObjectAccessManifestV4(
        state.crypto,
        {
          ...state.manifestUnsigned,
          payloadHash: new Uint8Array(31),
        },
        {
          signerPrivateKey: state.signer.privateKey,
          signerAuthorizationBytes: state.authorization.bytes,
          now: 1_000,
          resolveCurrentIssuingDevicePublicKey: () =>
            state.issuer.publicKey,
        },
      )
    ).toThrow("exactly 32 bytes");

    const created = createProcessorObjectAccessManifestV4(
      state.crypto,
      state.manifestUnsigned,
      {
        signerPrivateKey: state.signer.privateKey,
        signerAuthorizationBytes: state.authorization.bytes,
        now: 1_000,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      },
    );
    expect(() =>
      decodeObjectAccessManifestV4(
        Uint8Array.from([...created.bytes, 0]),
      )
    ).toThrow("trailing bytes");
    expect(() =>
      decodeObjectAccessManifestV4(
        new Uint8Array(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V4 + 1),
      )
    ).toThrow("wire limit");
    expect(() =>
      encodeObjectAccessManifestV4({
        ...created.manifest,
        signer: {
          kind: "human_device",
        },
      } as never)
    ).toThrow("unsupported");
    expect(() =>
      encodeObjectAccessManifestV4({
        ...created.manifest,
        extra: true,
      } as never)
    ).toThrow("field");
  });

  test("rejects malformed containers, duplicate envelopes, and broken revision chains", () => {
    const state = processorFixture();
    const created = createProcessorObjectAccessManifestV4(
      state.crypto,
      state.manifestUnsigned,
      {
        signerPrivateKey: state.signer.privateKey,
        signerAuthorizationBytes: state.authorization.bytes,
        now: 1_000,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      },
    );
    const { payloadHash: _, ...withoutPayloadHash } = created.manifest;
    const malformed: Array<readonly [unknown, string]> = [
      [null, "object access manifest must be an object"],
      [[], "object access manifest must be an object"],
      ["manifest", "object access manifest must be an object"],
      [{ ...withoutPayloadHash, payloadDigest: created.manifest.payloadHash },
        "invalid field set"],
      [{ ...created.manifest, signer: null },
        "object access manifest signer must be an object"],
      [{ ...created.manifest, signer: [] },
        "object access manifest signer must be an object"],
      [{ ...created.manifest, envelopeHashes: null },
        "manifest envelope hashes must be an array"],
      [{
        ...created.manifest,
        envelopeHashes: [hash(0x62), hash(0x62)],
      }, "duplicate envelope hash"],
      [{
        ...created.manifest,
        accessRevision: accessRevision(0),
        previousManifestHash: hash(0x64),
      }, "revision zero requires no previous"],
      [{
        ...created.manifest,
        accessRevision: accessRevision(1),
        previousManifestHash: null,
      }, "later revisions require one"],
    ];

    for (const [value, expectedMessage] of malformed) {
      expect(() =>
        encodeObjectAccessManifestV4(value as never)
      ).toThrow(expectedMessage);
    }

    expect(() => decodeObjectAccessManifestV4(null as never))
      .toThrow("must be Uint8Array");
    expect(() =>
      verifyObjectAccessManifestV4(state.crypto, {
        manifestBytes: null as never,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalIssuingDevicePublicKey: () => null,
      })
    ).toThrow("must be Uint8Array");
  });

  test("historical verification survives certificate expiry but refuses missing historical evidence", () => {
    const state = processorFixture();
    const created = createProcessorObjectAccessManifestV4(
      state.crypto,
      state.manifestUnsigned,
      {
        signerPrivateKey: state.signer.privateKey,
        signerAuthorizationBytes: state.authorization.bytes,
        now: 1_000,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      },
    );
    expect(() =>
      createProcessorObjectAccessManifestV4(
        state.crypto,
        state.manifestUnsigned,
        {
          signerPrivateKey: state.signer.privateKey,
          signerAuthorizationBytes: state.authorization.bytes,
          now: state.authorizationUnsigned.expiresAt,
          resolveCurrentIssuingDevicePublicKey: () => null,
        },
      )
    ).toThrow("not currently valid");
    expect(
      verifyObjectAccessManifestV4(state.crypto, {
        manifestBytes: created.bytes,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () =>
          state.authorization.bytes,
        resolveHistoricalIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      }).manifest.objectId,
    ).toBe(objectId("journal-event-1"));

    expect(() =>
      verifyObjectAccessManifestV4(state.crypto, {
        manifestBytes: created.bytes,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      })
    ).toThrow("authorization evidence");
    expect(() =>
      verifyObjectAccessManifestV4(state.crypto, {
        manifestBytes: created.bytes,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () =>
          state.authorization.bytes,
        resolveHistoricalIssuingDevicePublicKey: () => null,
      })
    ).toThrow("not authorized");
  });
});
