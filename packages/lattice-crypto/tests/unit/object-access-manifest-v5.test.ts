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
  createTaskRuntimeBackgroundAuthorizationRequestV1,
} from "../../src/background/task-runtime-request-v1.ts";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV3,
  encodeTaskRuntimeBackgroundAuthorizationRequestV3,
  type TaskRuntimePublicationWorkBindingV3,
} from "../../src/background/task-runtime-request-v3.ts";
import {
  createTaskRuntimeSignerAuthorizationV2,
} from "../../src/background/task-runtime-signer-authorization-v1.ts";
import {
  createProcessorSignerAuthorizationV1,
  PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
  type ProcessorSignerAuthorizationUnsignedV1,
} from "../../src/background/processor-signer-authorization-v1.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  mintDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import {
  createAgentObjectAccessManifestV5,
  createHumanObjectAccessManifestV5,
  createProcessorObjectAccessManifestV5,
  createTaskDefinitionForegroundObjectAccessManifestV5,
  createTaskRuntimeObjectAccessManifestV5,
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

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const TASK_RUN_ID = "22222222-2222-4222-8222-222222222222";
const TASK_JOB_ID = "33333333-3333-4333-8333-333333333333";
const TASK_MESSAGE_ID = `message:v2:${"a".repeat(64)}`;

async function taskSignerFixture(
  kind: TaskRuntimePublicationWorkBindingV3["kind"],
) {
  const now = 1_801_200_000_000;
  const crypto = new LatticeCrypto(seededRng(2_634), { now: () => now });
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.deriveEncryptionKeyPair(hash(0x91));
  const taskRuntime: AgentRuntimeGenerationV2 = {
    agentId: agentId("agent-task-publication"),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(0),
    key: hash(0x92),
  };
  const signer = deriveAgentRuntimeObjectSignerPublicV1(crypto, taskRuntime);
  const operations = kind === "task.cancel_result"
      || kind === "task.deliver_message"
    ? ["encrypt"] as const
    : ["decrypt", "encrypt"] as const;
  const domain = {
    domainId: "domain:task-publication",
    sourceNamespaceId: "namespace:task-publication",
    participantDigest: hash(0x93),
    participantCount: 2,
    keyClass: "ai" as const,
    domainKeyGeneration: 3,
    authorizationRevision: authorizationRevision(4),
    headDigest: hash(0x94),
    activeNamespaceBindingSetDigest: hash(0x95),
    activeNamespaceBindingCount: 1,
  };
  const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: `request:${kind}`,
    policyRevision: 7,
    sessionId: "episode:task-publication",
    roomId: "room:task-publication",
    subjectHumanId: humanId("human-task-publication"),
    committerDeviceId: cryptoDeviceId("device-task-publication"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(6),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: "recipient:task-publication",
    operations,
    issuedAt: now,
    deadlineAt: now + 60_000,
    maximumSecretBytes: 2_048,
    domains: [domain],
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: `request:${kind}`,
    workId: kind === "task.delivery_wake" ? TASK_JOB_ID : TASK_RUN_ID,
    workKind: kind,
    workPurpose: kind,
    recipientGeneration: 0,
    episodeId: "episode:task-publication",
    sourceRoomId: "room:task-publication",
    recipientKeyId: "recipient:task-publication",
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: now,
    deadlineAt: now + 60_000,
  });
  const commonWork = {
    taskId: TASK_ID,
    taskRunId: TASK_RUN_ID,
    workIdentityHash: hash(0x96),
  };
  const work: TaskRuntimePublicationWorkBindingV3 =
    kind === "task.cancel_result"
      ? { ...commonWork, kind, contentRevision: 2 }
      : kind === "task.deliver_message"
        ? { ...commonWork, kind, contentRevision: 2,
          messageObjectId: TASK_MESSAGE_ID }
        : kind === "task.deliver_result"
          ? { ...commonWork, kind, contentRevision: 1 }
          : { ...commonWork, kind, contentRevision: 1, jobId: TASK_JOB_ID };
  const request = createTaskRuntimeBackgroundAuthorizationRequestV3(crypto, {
    baseRequest,
    work,
    signer: {
      agentId: signer.principal.agentId,
      runtimeGeneration: 0,
      signerKeyId: signer.principal.signerKeyId,
      signerPublicKey: signer.publicKey,
    },
    deviceGroupHead: {
      serverInstanceId: "server:task-publication",
      lineageGeneration: 1,
      epoch: 5,
      headDigest: hash(0x97),
      signingPublicKeyHash: crypto.hash(issuer.publicKey),
    },
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: "namespace:task-publication",
      domainId: "domain:task-publication",
      operations,
      expectedAccessRevision: 4,
      expectedPolicyRevision: 7,
    }],
  });
  const authorization = await mintDomainForegroundAuthorizationV2(crypto, {
    plan,
    domains: [{ ...domain, domainKey: hash(0x98) }],
    committerDeviceSigningPrivateKey: issuer.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(
    crypto, request,
  );
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const authorizationHash = crypto.hash(authorizationBytes);
  const certificateBytes = createTaskRuntimeSignerAuthorizationV2(crypto, {
    requestBytes,
    authorizationBytes,
    expectedAuthorizationPlanBytes:
      serializeDomainForegroundAuthorizationPlanV2(plan),
    expectedAuthorizationHash: authorizationHash,
    issuerSigningPrivateKey: issuer.privateKey,
  });
  return {
    crypto, issuer, taskRuntime, signer, requestBytes, authorizationHash,
    certificateBytes, now,
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

  test("enforces fixed publication outputs and retains dynamic effect ownership", async () => {
    for (const kind of [
      "task.cancel_result",
      "task.deliver_message",
      "task.deliver_result",
      "task.delivery_wake",
    ] as const) {
      const fixture = await taskSignerFixture(kind);
      const cancelledResultId = `task-run-result:v1:${bytesToHex(
        fixture.crypto.hash(new TextEncoder().encode(
          `nautilo/task-run-result-crypto-object/v1\n${TASK_ID}\n${TASK_RUN_ID}\n2`,
        )),
      )}`;
      const expectedObjectId = kind === "task.cancel_result"
        ? cancelledResultId
        : kind === "task.deliver_message"
          ? TASK_MESSAGE_ID
          : `memory:v2:${(kind === "task.deliver_result" ? "b" : "c").repeat(64)}`;
      const create = (candidateObjectId: string) =>
        createTaskRuntimeObjectAccessManifestV5(fixture.crypto, {
          objectId: objectId(candidateObjectId),
          payloadHash: hash(0xa1),
          accessRevision: accessRevision(0),
          previousManifestHash: null,
          envelopeHashes: [],
          signer: fixture.signer.principal,
          signerAuthorizationHash: fixture.crypto.hash(fixture.certificateBytes),
          hostAuthorizationRevision: authorizationRevision(6),
        }, {
          runtime: fixture.taskRuntime,
          certificateBytes: fixture.certificateBytes,
          issuerSigningPublicKey: fixture.issuer.publicKey,
          expectedRequestHash: fixture.crypto.hash(fixture.requestBytes),
          expectedAuthorizationHash: fixture.authorizationHash,
          now: fixture.now + 1,
        });
      const created = create(expectedObjectId);
      const verified = verifyObjectAccessManifestV5(fixture.crypto, {
        manifestBytes: created.bytes,
        resolveHistoricalHumanDeviceSigningPublicKey: () => null,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
        resolveTaskRuntimeSignerAuthorizationBytes: () =>
          fixture.certificateBytes,
        resolveHistoricalTaskRuntimeIssuer: () => fixture.issuer.publicKey,
      });
      expect(verified.manifest.objectId).toBe(objectId(expectedObjectId));

      if (kind === "task.cancel_result" || kind === "task.deliver_message") {
        expect(() => create(`memory:v2:${"d".repeat(64)}`))
          .toThrow("disagrees with its certified Runtime signer");
      }
    }
  });

  test("verifies Task-definition foreground evidence only through its explicit resolver", () => {
    const crypto = new LatticeCrypto(seededRng(2_635));
    const agentRuntime = runtime();
    const signer = deriveAgentRuntimeObjectSignerPublicV1(crypto, agentRuntime);
    const authorizationBytes = new Uint8Array(128).fill(0x71);
    const created = createTaskDefinitionForegroundObjectAccessManifestV5(
      crypto,
      {
        objectId: objectId(`task-definition:v1:${"a".repeat(64)}`),
        payloadHash: hash(0x72),
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [hash(0x73)],
        signer: signer.principal,
        signerAuthorizationHash: crypto.hash(authorizationBytes),
        hostAuthorizationRevision: authorizationRevision(9),
      },
      agentRuntime,
    );
    const base = {
      manifestBytes: created.bytes,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    };
    expect(() => verifyObjectAccessManifestV5(crypto, base))
      .toThrow("Task definition foreground authorization resolver is required");
    const verified = verifyObjectAccessManifestV5(crypto, {
      ...base,
      resolveTaskDefinitionForegroundAuthorizationSignerPublicKey: evidence => {
        expect(evidence.authorizationHash).toEqual(crypto.hash(authorizationBytes));
        return signer.publicKey.slice();
      },
    });
    expect(verified.manifest.objectId).toBe(created.manifest.objectId);
    expect(() => createTaskDefinitionForegroundObjectAccessManifestV5(
      crypto,
      {
        objectId: objectId(`memory:v2:${"b".repeat(64)}`),
        payloadHash: created.manifest.payloadHash,
        accessRevision: created.manifest.accessRevision,
        previousManifestHash: created.manifest.previousManifestHash,
        envelopeHashes: created.manifest.envelopeHashes,
        signer: created.manifest.signer,
        signerAuthorizationHash:
          created.manifest.signerAuthorizationHash,
        hostAuthorizationRevision:
          created.manifest.hostAuthorizationRevision,
      },
      agentRuntime,
    )).toThrow("Task definition manifest requires");
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
