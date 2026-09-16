import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";

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
  createAgentObjectAccessManifestV5,
  createHumanObjectAccessManifestV5,
  createProcessorObjectAccessManifestV5,
  decodeObjectAccessManifestV5,
  encodeObjectAccessManifestV5,
  OBJECT_ACCESS_MANIFEST_DOMAIN_V5,
  OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5,
  verifyObjectAccessManifestChainV5,
  verifyObjectAccessManifestV5,
  type ObjectAccessManifestUnsignedV5,
} from "../../src/format/object-access-manifest-v5.ts";
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

function runtime(): AgentRuntimeGenerationV2 {
  return {
    agentId: agentId("agent-common-protocol"),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(4),
    key: hash(0x44),
  };
}

describe("ObjectAccessManifestV5", () => {
  test("creates canonical Human-device bytes and verifies exact historical authority", () => {
    const crypto = new LatticeCrypto(seededRng(2_630));
    const device = crypto.generateSigningKeyPair();
    const unsigned: ObjectAccessManifestUnsignedV5 = {
      objectId: objectId("memory-common-1"),
      payloadHash: hash(0x11),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [hash(0x32), hash(0x31)],
      signer: {
        kind: "human_device",
        subjectHumanId: humanId("human-alice"),
        committerDeviceId: cryptoDeviceId("alice-device"),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(7),
    };
    const created = createHumanObjectAccessManifestV5(
      crypto,
      unsigned,
      device.privateKey,
    );
    const decoded = decodeObjectAccessManifestV5(created.bytes);
    const verified = verifyObjectAccessManifestV5(crypto, {
      manifestBytes: created.bytes,
      resolveHistoricalHumanDeviceSigningPublicKey: (context) => {
        expect(context).toEqual({
          subjectHumanId: humanId("human-alice"),
          committerDeviceId: cryptoDeviceId("alice-device"),
          hostAuthorizationRevision: authorizationRevision(7),
        });
        return device.publicKey;
      },
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    });

    expect(decoded).toEqual(created.manifest);
    expect(decoded.envelopeHashes).toEqual([hash(0x31), hash(0x32)]);
    expect(encodeObjectAccessManifestV5(decoded)).toEqual(created.bytes);
    expect(verified.manifestHash).toEqual(crypto.hash(created.bytes));
    expect(OBJECT_ACCESS_MANIFEST_DOMAIN_V5)
      .toBe("nautilo/lattice-crypto/object-access-manifest/v5");
    expect(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5).toBe(5);
    expect(bytesToHex(crypto.hash(created.bytes))).toBe(
      "1044ba23eb819627f9ae0293f9ade522321323a546dd1965d9edba4699336c5a",
    );
  });

  test("verifies one Human -> Agent -> Human chain from a retained minimum", () => {
    const crypto = new LatticeCrypto(seededRng(2_631));
    const firstDevice = crypto.generateSigningKeyPair();
    const secondDevice = crypto.generateSigningKeyPair();
    const agentRuntime = runtime();
    const agentSigner = deriveAgentRuntimeObjectSignerPublicV1(
      crypto,
      agentRuntime,
    );
    const common = {
      objectId: objectId("artifact-control-common-1"),
      payloadHash: hash(0x51),
      envelopeHashes: [hash(0x61)],
      signerAuthorizationHash: null,
    } as const;
    const genesis = createHumanObjectAccessManifestV5(crypto, {
      ...common,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      signer: {
        kind: "human_device",
        subjectHumanId: humanId("human-alice"),
        committerDeviceId: cryptoDeviceId("alice-device-1"),
      },
      hostAuthorizationRevision: authorizationRevision(2),
    }, firstDevice.privateKey);
    const agentUpdate = createAgentObjectAccessManifestV5(crypto, {
      ...common,
      accessRevision: accessRevision(1),
      previousManifestHash: genesis.hash,
      signer: agentSigner.principal,
      hostAuthorizationRevision: authorizationRevision(9),
    }, agentRuntime);
    expect(bytesToHex(crypto.hash(agentUpdate.bytes))).toBe(
      "db931eb93a41eb040c4754391c4cbb139f90333b54cc0d978fd9bc5382dedc9b",
    );
    const humanUpdate = createHumanObjectAccessManifestV5(crypto, {
      ...common,
      accessRevision: accessRevision(2),
      previousManifestHash: agentUpdate.hash,
      signer: {
        kind: "human_device",
        subjectHumanId: humanId("human-alice"),
        committerDeviceId: cryptoDeviceId("alice-device-2"),
      },
      hostAuthorizationRevision: authorizationRevision(3),
    }, secondDevice.privateKey);
    const verified = verifyObjectAccessManifestChainV5(crypto, {
      manifestBytes: humanUpdate.bytes,
      proof: [agentUpdate.bytes],
      trustedMinimumHead: {
        objectId: common.objectId,
        payloadHash: common.payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
        context.committerDeviceId === "alice-device-1"
          ? firstDevice.publicKey
          : secondDevice.publicKey,
      resolveAgentRuntimeSignerPublicKey: () => agentSigner.publicKey,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    });
    expect(verified.manifest.accessRevision).toBe(accessRevision(2));
    expect(verified.manifest.signer.kind).toBe("human_device");

    expect(() => verifyObjectAccessManifestChainV5(crypto, {
      manifestBytes: humanUpdate.bytes,
      proof: [],
      trustedMinimumHead: {
        objectId: common.objectId,
        payloadHash: common.payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      resolveHistoricalHumanDeviceSigningPublicKey: () => secondDevice.publicKey,
      resolveAgentRuntimeSignerPublicKey: () => agentSigner.publicKey,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    })).toThrow("broken hash chain");
  });

  test("reuses the existing processor signer authorization boundary", () => {
    const crypto = new LatticeCrypto(seededRng(2_632));
    const issuer = crypto.generateSigningKeyPair();
    const signer = crypto.generateSigningKeyPair();
    const principal = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-common-auth",
      workDescriptorHash: hash(0x71),
      signerPrivateKey: signer.privateKey,
    }).principal;
    const authorizationUnsigned: ProcessorSignerAuthorizationUnsignedV1 = {
      formatVersion: PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
      id: "processor-common-auth",
      processorKind: "stenographer",
      processorVersion: 1,
      workId: "processor-common-work",
      namespaceId: namespaceId("room-common"),
      domainId: cryptoDomainId("domain-common"),
      domainEpoch: domainEpoch(4),
      namespaceAccessRevision: accessRevision(8),
      policyRevision: authorizationRevision(9),
      processorAuthorizationRevision: authorizationRevision(5),
      issuingHumanId: humanId("human-alice"),
      issuingDeviceId: cryptoDeviceId("alice-device"),
      issuingDeviceAuthorizationRevision: authorizationRevision(6),
      issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey),
      signer: principal,
      signerPublicKey: signer.publicKey,
      workDescriptorHash: hash(0x71),
      credentialHash: hash(0x72),
      outputObjectIds: [objectId("processor-output-common")],
      maxOutputObjects: 1,
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
    const created = createProcessorObjectAccessManifestV5(crypto, {
      objectId: objectId("processor-output-common"),
      payloadHash: hash(0x73),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [],
      signer: principal,
      signerAuthorizationHash: authorization.hash,
      hostAuthorizationRevision: authorizationRevision(5),
    }, {
      signerPrivateKey: signer.privateKey,
      signerAuthorizationBytes: authorization.bytes,
      now: 1_000,
      resolveCurrentIssuingDevicePublicKey: () => issuer.publicKey,
    });
    expect(bytesToHex(crypto.hash(created.bytes))).toBe(
      "3d320844fe44a7f16c89aec6ffb194b469e72e6d2404e3d2c3fe559b2691eff9",
    );
    const verified = verifyObjectAccessManifestV5(crypto, {
      manifestBytes: created.bytes,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: () => authorization.bytes,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => issuer.publicKey,
    });
    expect(verified.manifest.signer.kind).toBe("processor_invocation");
    expect(verified.signerAuthorization?.authorization.id)
      .toBe("processor-common-auth");

    const createWith = (
      patch: Partial<ObjectAccessManifestUnsignedV5>,
    ) => createProcessorObjectAccessManifestV5(crypto, {
      objectId: objectId("processor-output-common"),
      payloadHash: hash(0x73),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [],
      signer: principal,
      signerAuthorizationHash: authorization.hash,
      hostAuthorizationRevision: authorizationRevision(5),
      ...patch,
    }, {
      signerPrivateKey: signer.privateKey,
      signerAuthorizationBytes: authorization.bytes,
      now: 1_000,
      resolveCurrentIssuingDevicePublicKey: () => issuer.publicKey,
    });
    for (const patch of [
      { signerAuthorizationHash: hash(0xff) },
      { objectId: objectId("processor-output-other") },
      { hostAuthorizationRevision: authorizationRevision(6) },
      {
        signer: {
          ...principal,
          signerAuthorizationId: "processor-other-auth",
        },
      },
      { signer: { ...principal, signerKeyId: "processor-other-key" } },
      { signer: { ...principal, workDescriptorHash: hash(0xfe) } },
    ]) {
      expect(() => createWith(patch as Partial<ObjectAccessManifestUnsignedV5>))
        .toThrow();
    }
    expect(() => verifyObjectAccessManifestV5(crypto, {
      manifestBytes: created.bytes,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => issuer.publicKey,
    })).toThrow("evidence is unavailable");
    const alteredProcessor = created.bytes.slice();
    alteredProcessor[alteredProcessor.length - 1] =
      alteredProcessor[alteredProcessor.length - 1]! ^ 1;
    expect(() => verifyObjectAccessManifestV5(crypto, {
      manifestBytes: alteredProcessor,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: () => authorization.bytes,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => issuer.publicKey,
    })).toThrow("signature is invalid");
  });

  test("rejects unknown signers, altered signatures, and authorization misuse", () => {
    const crypto = new LatticeCrypto(seededRng(2_633));
    const device = crypto.generateSigningKeyPair();
    const created = createHumanObjectAccessManifestV5(crypto, {
      objectId: objectId("memory-common-negative"),
      payloadHash: hash(0x81),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [],
      signer: {
        kind: "human_device",
        subjectHumanId: humanId("human-alice"),
        committerDeviceId: cryptoDeviceId("alice-device"),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(1),
    }, device.privateKey);
    const altered = created.bytes.slice();
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    expect(() => verifyObjectAccessManifestV5(crypto, {
      manifestBytes: altered,
      resolveHistoricalHumanDeviceSigningPublicKey: () => device.publicKey,
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    })).toThrow("signature");
    expect(() => createHumanObjectAccessManifestV5(crypto, {
      objectId: created.manifest.objectId,
      payloadHash: created.manifest.payloadHash,
      accessRevision: created.manifest.accessRevision,
      previousManifestHash: created.manifest.previousManifestHash,
      envelopeHashes: created.manifest.envelopeHashes,
      signer: created.manifest.signer,
      signerAuthorizationHash: hash(0x82),
      hostAuthorizationRevision: created.manifest.hostAuthorizationRevision,
    }, device.privateKey)).toThrow("forbid");
    expect(() => encodeObjectAccessManifestV5({
      ...created.manifest,
      signer: { kind: "unknown" } as never,
    })).toThrow("unsupported");
  });
});
