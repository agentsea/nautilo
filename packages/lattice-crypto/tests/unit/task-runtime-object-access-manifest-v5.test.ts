import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "bun:test";

import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
} from "../../src/v2-types/ids.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  deriveAgentRuntimeObjectSignerPublicV1
    as deriveAgentRuntimeObjectSignerPublic,
} from "../../src/agent-runtime/object-signer-v1.ts";
import type {
  AgentRuntimeGenerationV2 as AgentRuntimeKeyGeneration,
} from "../../src/agent-runtime/types.ts";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "../../src/background/task-runtime-request-v1.ts";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2,
} from "../../src/background/task-runtime-request-v2.ts";
import { createTaskRuntimeSignerAuthorizationV1 } from
  "../../src/background/task-runtime-signer-authorization-v1.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  mintDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import {
  createAgentObjectAccessManifestV5
    as createCommonAgentObjectAccessManifest,
  createHumanObjectAccessManifestV5
    as createCommonHumanObjectAccessManifest,
  createTaskRuntimeObjectAccessManifestV5
    as createTaskRuntimeCommonObjectAccessManifest,
  encodeObjectAccessManifestV5,
  verifyObjectAccessManifestV5 as verifyCommonObjectAccessManifest,
  type ObjectAccessManifestUnsignedV5
    as CommonObjectAccessManifestUnsigned,
  type ObjectAccessManifestV5,
} from "../../src/format/object-access-manifest-v5.ts";

const NOW = 1_800_900_000_000;
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function fixture(seed = 809_001) {
  let currentNow = NOW;
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => currentNow });
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x41));
  const runtime: AgentRuntimeKeyGeneration = {
    agentId: agentId("agent:task"),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(0),
    key: bytes(0x42),
  };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const domain = {
    domainId: "domain:task",
    sourceNamespaceId: "namespace:task",
    participantDigest: bytes(0x11),
    participantCount: 2,
    keyClass: "ai" as const,
    domainKeyGeneration: 5,
    authorizationRevision: authorizationRevision(7),
    headDigest: bytes(0x12),
    activeNamespaceBindingSetDigest: bytes(0x13),
    activeNamespaceBindingCount: 1,
  };
  const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: "request:task",
    policyRevision: 9,
    sessionId: "episode:task",
    roomId: "room:task",
    subjectHumanId: humanId("human:task"),
    committerDeviceId: cryptoDeviceId("device:task"),
    committerDeviceSigningGeneration: 4,
    hostAuthorizationRevision: authorizationRevision(6),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: "recipient:task",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 2_048,
    domains: [domain],
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: "request:task",
    workId: RUN_ID,
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: 0,
    episodeId: "episode:task",
    sourceRoomId: "room:task",
    recipientKeyId: "recipient:task",
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
  });
  const resultObjectId = `task-run-result:v1:${bytesToHex(crypto.hash(
    new TextEncoder().encode(
      `nautilo/task-run-result-crypto-object/v1\n${TASK_ID}\n${RUN_ID}\n1`,
    ),
  ))}`;
  const request = createTaskRuntimeBackgroundAuthorizationRequestV2(crypto, {
    baseRequest,
    work: {
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      inputObjectId: `task-definition:v1:${"b".repeat(64)}`,
      resultObjectId,
      executionSegment: 1,
      workIdentityHash: bytes(0x21),
    },
    signer: {
      agentId: signer.principal.agentId,
      runtimeGeneration: 0,
      signerKeyId: signer.principal.signerKeyId,
      signerPublicKey: signer.publicKey,
    },
    deviceGroupHead: {
      serverInstanceId: "server:task",
      lineageGeneration: 3,
      epoch: 10,
      headDigest: bytes(0x22),
      signingPublicKeyHash: crypto.hash(issuer.publicKey),
    },
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: "namespace:task",
      domainId: "domain:task",
      operations: ["decrypt", "encrypt"],
      expectedAccessRevision: 8,
      expectedPolicyRevision: 9,
    }],
  });
  const authorization = await mintDomainForegroundAuthorizationV2(crypto, {
    plan,
    domains: [{ ...domain, domainKey: bytes(0x31) }],
    committerDeviceSigningPrivateKey: issuer.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
    crypto,
    request,
  );
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const authorizationPlanBytes = serializeDomainForegroundAuthorizationPlanV2(
    plan,
  );
  const requestHash = crypto.hash(requestBytes);
  const authorizationHash = crypto.hash(authorizationBytes);
  const certificateBytes = createTaskRuntimeSignerAuthorizationV1(crypto, {
    requestBytes,
    authorizationBytes,
    expectedAuthorizationPlanBytes: authorizationPlanBytes,
    expectedAuthorizationHash: authorizationHash,
    issuerSigningPrivateKey: issuer.privateKey,
  });
  recipient.privateKey.fill(0);
  recipient.publicKey.fill(0);
  return {
    crypto,
    issuer,
    runtime,
    signer,
    plan,
    baseRequest,
    request,
    authorization,
    requestBytes,
    authorizationBytes,
    authorizationPlanBytes,
    requestHash,
    authorizationHash,
    certificateBytes,
    certificateHash: crypto.hash(certificateBytes),
    resultObjectId,
    setNow: (next: number) => {
      currentNow = next;
    },
  };
}

function cleanup(value: Awaited<ReturnType<typeof fixture>>): void {
  destroyTaskRuntimeBackgroundAuthorizationRequestV2(value.request);
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(value.baseRequest);
  destroyDomainForegroundAuthorizationV2(value.authorization);
  destroyDomainForegroundAuthorizationPlanV2(value.plan);
  value.requestBytes.fill(0);
  value.authorizationBytes.fill(0);
  value.authorizationPlanBytes.fill(0);
  value.requestHash.fill(0);
  value.authorizationHash.fill(0);
  value.certificateBytes.fill(0);
  value.certificateHash.fill(0);
  value.issuer.privateKey.fill(0);
  value.issuer.publicKey.fill(0);
  value.runtime.key.fill(0);
  value.signer.publicKey.fill(0);
}

function unsigned(
  value: Awaited<ReturnType<typeof fixture>>,
  targetObjectId = value.resultObjectId,
): CommonObjectAccessManifestUnsigned {
  return {
    objectId: objectId(targetObjectId),
    payloadHash: bytes(0x51),
    accessRevision: accessRevision(0),
    previousManifestHash: null,
    envelopeHashes: [bytes(0x61), bytes(0x62)],
    signer: value.signer.principal,
    signerAuthorizationHash: value.certificateHash,
    hostAuthorizationRevision: authorizationRevision(6),
  };
}

function creationInput(value: Awaited<ReturnType<typeof fixture>>, now = NOW + 1) {
  return {
    runtime: value.runtime,
    certificateBytes: value.certificateBytes,
    issuerSigningPublicKey: value.issuer.publicKey,
    expectedRequestHash: value.requestHash,
    expectedAuthorizationHash: value.authorizationHash,
    now,
  };
}

function verificationInput(
  value: Awaited<ReturnType<typeof fixture>>,
  manifestBytes: Uint8Array,
  legacyAgentResolver = () => null as Uint8Array | null,
) {
  return {
    manifestBytes,
    resolveHistoricalHumanDeviceSigningPublicKey: () => null,
    resolveAgentRuntimeSignerPublicKey: legacyAgentResolver,
    resolveProcessorSignerAuthorizationBytes: () => null,
    resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    resolveTaskRuntimeSignerAuthorizationBytes: (evidence: {
      signer: typeof value.signer.principal;
      authorizationHash: Uint8Array;
      objectId: string;
    }) => {
      expect(evidence.signer).toEqual(value.signer.principal);
      expect(evidence.authorizationHash).toEqual(value.certificateHash);
      expect(evidence.objectId).toBe(value.resultObjectId);
      return value.certificateBytes;
    },
    resolveHistoricalTaskRuntimeIssuer: (context: {
      issuer: {
        humanId: string;
        deviceId: string;
        deviceGeneration: number;
        serverInstanceId: string;
        lineageGeneration: number;
        epoch: number;
        securityRevision: number;
        headDigest: Uint8Array;
        signingPublicKeyHash: Uint8Array;
      };
    }) => {
      expect(context.issuer).toMatchObject({
        humanId: "human:task",
        deviceId: "device:task",
        deviceGeneration: 4,
        serverInstanceId: "server:task",
        lineageGeneration: 3,
        epoch: 10,
        securityRevision: 6,
      });
      expect(context.issuer.headDigest).toEqual(bytes(0x22));
      expect(context.issuer.signingPublicKeyHash)
        .toEqual(value.crypto.hash(value.issuer.publicKey));
      return value.issuer.publicKey;
    },
  };
}

describe("Task Runtime ObjectAccessManifestV5", () => {
  test("creates Task result and dynamic Memory manifests and verifies retained history after expiry", async () => {
    const value = await fixture();
    try {
      const result = createTaskRuntimeCommonObjectAccessManifest(
        value.crypto,
        unsigned(value),
        creationInput(value),
      );
      const memoryObjectId = objectId("memory:task-runtime:dynamic:1");
      const memory = createTaskRuntimeCommonObjectAccessManifest(
        value.crypto,
        unsigned(value, memoryObjectId),
        creationInput(value),
      );
      value.setNow(NOW + 120_000);
      let legacyCalls = 0;
      const verified = verifyCommonObjectAccessManifest(value.crypto, {
        ...verificationInput(value, result.bytes, () => {
          legacyCalls += 1;
          return value.signer.publicKey;
        }),
      });
      expect(legacyCalls).toBe(0);
      expect(Object.keys(verified).sort()).toEqual([
        "currentSignerAuthorization",
        "manifest",
        "manifestBytes",
        "manifestHash",
        "signerAuthorization",
      ]);
      expect(verified).toMatchObject({
        manifest: {
          formatVersion: 5,
          objectId: value.resultObjectId,
          signer: value.signer.principal,
          hostAuthorizationRevision: 6,
        },
        signerAuthorization: null,
        currentSignerAuthorization: null,
      });
      const historical = verifyCommonObjectAccessManifest(value.crypto, {
        ...verificationInput(value, memory.bytes),
        resolveTaskRuntimeSignerAuthorizationBytes: evidence => {
          expect(evidence.objectId).toBe(memoryObjectId);
          return value.certificateBytes;
        },
      });
      expect(historical.manifest.objectId).toBe(memoryObjectId);
      expect(historical.manifest.signerAuthorizationHash)
        .toEqual(value.certificateHash);
    } finally {
      cleanup(value);
    }
  });

  test("creation rejects stale time and every certified Runtime boundary mismatch", async () => {
    const value = await fixture();
    const otherRuntime: AgentRuntimeKeyGeneration = {
      ...value.runtime,
      key: bytes(0x77),
    };
    const otherSigner = deriveAgentRuntimeObjectSignerPublic(
      value.crypto,
      otherRuntime,
    );
    const wrongIssuer = value.crypto.generateSigningKeyPair();
    try {
      const create = (
        candidate: CommonObjectAccessManifestUnsigned,
        input = creationInput(value),
      ) => createTaskRuntimeCommonObjectAccessManifest(
        value.crypto,
        candidate,
        input,
      );
      expect(() => create(unsigned(value), creationInput(value, NOW - 1)))
        .toThrow("outside its live window");
      expect(() => create(unsigned(value), creationInput(value, NOW + 60_000)))
        .toThrow("outside its live window");
      expect(() => create(unsigned(value), {
        ...creationInput(value),
        issuerSigningPublicKey: wrongIssuer.publicKey,
      })).toThrow();
      expect(() => create(unsigned(value), {
        ...creationInput(value),
        expectedRequestHash: bytes(0x6e),
      })).toThrow();
      expect(() => create(unsigned(value), {
        ...creationInput(value),
        expectedAuthorizationHash: bytes(0x6f),
      })).toThrow();
      expect(() => create({
        ...unsigned(value),
        signerAuthorizationHash: bytes(0x70),
      })).toThrow("certified Runtime signer");
      expect(() => create({
        ...unsigned(value),
        signer: { ...value.signer.principal, agentId: agentId("agent:other") },
      })).toThrow("certified Runtime signer");
      expect(() => create({
        ...unsigned(value),
        signer: { ...value.signer.principal, runtimeGeneration: agentRuntimeGeneration(1) },
      })).toThrow("certified Runtime signer");
      expect(() => create({
        ...unsigned(value),
        signer: otherSigner.principal,
      })).toThrow("certified Runtime signer");
      expect(() => create({
        ...unsigned(value),
        hostAuthorizationRevision: authorizationRevision(7),
      })).toThrow("certified Runtime signer");
      expect(() => create({
        ...unsigned(value),
        objectId: objectId(`task-run-result:v1:${"f".repeat(64)}`),
      })).toThrow("certified Runtime signer");
    } finally {
      otherRuntime.key.fill(0);
      otherSigner.publicKey.fill(0);
      wrongIssuer.privateKey.fill(0);
      wrongIssuer.publicKey.fill(0);
      cleanup(value);
    }
  });

  test("verification never falls back to legacy Agent authority for certified manifests", async () => {
    const value = await fixture();
    try {
      const created = createTaskRuntimeCommonObjectAccessManifest(
        value.crypto,
        unsigned(value),
        creationInput(value),
      );
      let legacyCalls = 0;
      const common = {
        manifestBytes: created.bytes,
        resolveHistoricalHumanDeviceSigningPublicKey: () => null,
        resolveAgentRuntimeSignerPublicKey: () => {
          legacyCalls += 1;
          return value.signer.publicKey;
        },
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      };
      expect(() => verifyCommonObjectAccessManifest(value.crypto, common))
        .toThrow("certificate resolvers are required");
      expect(legacyCalls).toBe(0);
      expect(() => verifyCommonObjectAccessManifest(value.crypto, {
        ...common,
        resolveTaskRuntimeSignerAuthorizationBytes: () => null,
        resolveHistoricalTaskRuntimeIssuer: () => value.issuer.publicKey,
      })).toThrow("certificate is unavailable");
      expect(legacyCalls).toBe(0);
      expect(() => verifyCommonObjectAccessManifest(value.crypto, {
        ...common,
        resolveTaskRuntimeSignerAuthorizationBytes: () =>
          new Uint8Array([0x01]),
        resolveHistoricalTaskRuntimeIssuer: () => value.issuer.publicKey,
      })).toThrow();
      expect(legacyCalls).toBe(0);
    } finally {
      cleanup(value);
    }
  });

  test("verification rejects payload and envelope changes under retained Task evidence", async () => {
    const value = await fixture();
    try {
      const created = createTaskRuntimeCommonObjectAccessManifest(
        value.crypto,
        unsigned(value),
        creationInput(value),
      );
      const changed = (manifest: ObjectAccessManifestV5) =>
        verifyCommonObjectAccessManifest(value.crypto, {
          ...verificationInput(value, encodeObjectAccessManifestV5(manifest)),
        });
      expect(() => changed({
        ...created.manifest,
        payloadHash: bytes(0x72),
      })).toThrow("signature is invalid");
      expect(() => changed({
        ...created.manifest,
        envelopeHashes: [bytes(0x73)],
      })).toThrow("signature is invalid");
    } finally {
      cleanup(value);
    }
  });

  test("legacy Agent and Human manifests remain unchanged while Agent creation refuses certification", async () => {
    const value = await fixture();
    try {
      const legacyAgentUnsigned = {
        ...unsigned(value, "memory:legacy-agent"),
        signerAuthorizationHash: null,
      };
      const agentManifest = createCommonAgentObjectAccessManifest(
        value.crypto,
        legacyAgentUnsigned,
        value.runtime,
      );
      const verifiedAgent = verifyCommonObjectAccessManifest(value.crypto, {
        manifestBytes: agentManifest.bytes,
        resolveHistoricalHumanDeviceSigningPublicKey: () => null,
        resolveAgentRuntimeSignerPublicKey: () => value.signer.publicKey,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      });
      expect(verifiedAgent.manifest.signerAuthorizationHash).toBeNull();
      expect(() => createCommonAgentObjectAccessManifest(
        value.crypto,
        unsigned(value, "memory:certified-through-legacy-creator"),
        value.runtime,
      )).toThrow("requires Task signer evidence");

      const humanUnsigned: CommonObjectAccessManifestUnsigned = {
        ...legacyAgentUnsigned,
        objectId: objectId("memory:legacy-human"),
        signer: {
          kind: "human_device",
          subjectHumanId: humanId("human:task"),
          committerDeviceId: cryptoDeviceId("device:task"),
        },
      };
      const humanManifest = createCommonHumanObjectAccessManifest(
        value.crypto,
        humanUnsigned,
        value.issuer.privateKey,
      );
      const verifiedHuman = verifyCommonObjectAccessManifest(value.crypto, {
        manifestBytes: humanManifest.bytes,
        resolveHistoricalHumanDeviceSigningPublicKey: () =>
          value.issuer.publicKey,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      });
      expect(verifiedHuman.manifest.signer).toEqual(humanUnsigned.signer);
    } finally {
      cleanup(value);
    }
  });
});
