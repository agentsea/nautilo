import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  coordinateGrantAuthoritySetUse,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  grantId,
  grantWriteRecord,
  humanId,
  InMemoryLatticeStore,
  mintGrant,
  namespaceGeneration,
  namespaceId,
  objectId,
  preflightGrantAuthoritySetUse,
  prepareAgentObjectAccessManifestGenesisSet,
  prepareAgentRuntimeInitialization,
  prepareHumanObjectAccessManifestGenesisSet,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type GrantAuthoritySetAuthorization,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  serializeGrantV2,
} from "@nautilo/lattice-crypto/wire";

import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";
import {
  createPreparedAgentTaskContentCryptoRevisionV1,
  createPreparedHumanTaskContentCryptoRevisionV1,
  readPreparedTaskContentCryptoRevisionSnapshotV1,
} from "../../src/task/task-content-prepared-revision.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentCoordinateV1,
} from "../../src/task/task-content-repository.ts";
import {
  encodeTaskPayloadV1,
  encodeTaskRunResultPayloadV1,
} from "../../src/task/task-payload-v1.ts";

const NOW = 1_820_000_000_000;
const HUMAN_ID = "30000000-0000-4000-8000-000000000001";
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "40000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "50000000-0000-4000-8000-000000000001";

const definition = Object.freeze({
  kind: "definition" as const,
  taskId: TASK_ID,
  contentRevision: 1,
});
const result = Object.freeze({
  kind: "run_result" as const,
  taskId: TASK_ID,
  taskRunId: RUN_ID,
  contentRevision: 1,
});
const authority = Object.freeze({
  authorityVersion: 1,
  kind: "requester_private_namespace",
  keyClass: "ai",
  requesterHumanId: HUMAN_ID,
  namespaceId: NAMESPACE_ID,
  domainId: DOMAIN_ID,
  expectedAccessRevision: 2,
  expectedPolicyRevision: 3,
} satisfies TaskContentAuthorityV1);

function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    bytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        bytes[index] = state & 0xff;
      }
      return bytes;
    },
  };
}

function encodedContent(coordinate: TaskContentCoordinateV1): Uint8Array {
  return coordinate.kind === "definition"
    ? encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "Private definition",
      expectedOutput: null,
      protectedMetadata: {},
    })
    : encodeTaskRunResultPayloadV1({
      formatVersion: 1,
      resultText: "Private result",
      lastError: null,
    });
}

function encrypt(coordinate: TaskContentCoordinateV1, seed: number) {
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => NOW });
  const objectIdentity = deriveTaskContentCryptoObjectIdV1(coordinate);
  const plaintext = encodedContent(coordinate);
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(objectIdentity),
    keyClass: "ai",
    objectType: coordinate.kind === "definition"
      ? "nautilo-task-definition-v1"
      : "nautilo-task-run-result-v1",
    createdAt: unixTimestamp(NOW),
  }, plaintext);
  plaintext.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const namespaceKey = new Uint8Array(32).fill(0x51);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(crypto, namespaceKey, {
      objectId: objectId(objectIdentity),
      namespaceId: namespaceId(NAMESPACE_ID),
      keyClass: "ai",
      keyGeneration: namespaceGeneration(4),
      bindingRevisionAtWrap: accessRevision(
        authority.expectedAccessRevision,
      ),
    }, encrypted.dek),
  );
  encrypted.dek.fill(0);
  return {
    crypto,
    objectIdentity,
    payloadBytes,
    envelopeBytes,
    object: encryptedObjectWriteRecord(payloadBytes),
  };
}

function prepareHuman(coordinate: TaskContentCoordinateV1, seed = 1) {
  const encrypted = encrypt(coordinate, seed);
  const signer = encrypted.crypto.generateSigningKeyPair();
  const access = prepareHumanObjectAccessManifestGenesisSet(
    encrypted.crypto,
    {
      objectId: encrypted.objectIdentity,
      payloadHash: encrypted.crypto.hash(encrypted.payloadBytes),
      envelopeBytes: [encrypted.envelopeBytes],
      sourceAuthorized: true,
      targetAuthorized: true,
      subjectHumanId: HUMAN_ID,
      committerDeviceId: "human-device.1",
      hostAuthorizationRevision: 7,
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    },
  );
  const prepared = createPreparedHumanTaskContentCryptoRevisionV1({
    signerKind: "human_device",
    coordinate,
    authority,
    object: encrypted.object,
    access,
  });
  return { ...encrypted, access, prepared };
}

async function prepareAgent(coordinate: TaskContentCoordinateV1, seed = 2) {
  const encrypted = encrypt(coordinate, seed);
  const issuer = encrypted.crypto.generateSigningKeyPair();
  const recipient = await encrypted.crypto.generateEncryptionKeyPair();
  const manager = encrypted.crypto.generateSigningKeyPair();
  const runtimeAuthorizationRevision = authorizationRevision(17);
  const initialized = await prepareAgentRuntimeInitialization({
    crypto: encrypted.crypto,
    operationId: "task-agent-runtime-initialization",
    agentId: agentId("task-agent"),
    authorizationRevision: runtimeAuthorizationRevision,
    configObjects: [{
      objectId: "task-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x31),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(HUMAN_ID),
      managerAuthorizationRevision: authorizationRevision(8),
      managerDeviceId: cryptoDeviceId("manager-device"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const domain = {
    domainId: cryptoDomainId(DOMAIN_ID),
    domainEpoch: domainEpoch(4),
    agentAuthorizationRevision: authorizationRevision(11),
    aiRoot: new Uint8Array(32).fill(0x41),
  };
  const grant = await mintGrant(encrypted.crypto, {
    id: grantId("task-reusable-grant"),
    issuingDeviceId: cryptoDeviceId("human-device.1"),
    issuingHumanId: humanId(HUMAN_ID),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: initialized.runtime.agentId,
    recipientKeyId: "task-recipient",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId(HUMAN_ID)],
    operations: ["encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [domain],
    singleUse: false,
  });
  const namespaceRequirement = {
    namespaceId: namespaceId(NAMESPACE_ID),
    domainId: domain.domainId,
    operations: ["encrypt"] as const,
    namespaceParticipants: [humanId(HUMAN_ID)],
    expectedAccessRevision: accessRevision(authority.expectedAccessRevision),
    expectedPolicyRevision: authorizationRevision(
      authority.expectedPolicyRevision,
    ),
  };
  const authorization: GrantAuthoritySetAuthorization = {
    now: NOW + 1,
    expectedIssuingDeviceId: grant.issuingDeviceId,
    issuingDeviceHumanId: humanId(HUMAN_ID),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: initialized.runtime.agentId,
    recipientKeyId: grant.recipientKeyId,
    recipientEncryptionPrivateKey: recipient.privateKey,
    singleUseAvailable: true,
    grantScope: grant.scope,
    namespaceRequirements: [namespaceRequirement],
    domainRequirements: [{
      domainId: domain.domainId,
      expectedEpoch: domain.domainEpoch,
      expectedAgentAuthorizationRevision: domain.agentAuthorizationRevision,
    }],
    hostAllowsOperation: true,
  };
  const store = new InMemoryLatticeStore();
  await store.putGrant(grantWriteRecord(serializeGrantV2(grant)));
  const preflight = await preflightGrantAuthoritySetUse(
    encrypted.crypto,
    grant,
    authorization,
  );
  if (preflight === null) throw new Error("expected Task grant preflight");
  const coordinated = await coordinateGrantAuthoritySetUse({
    preflight,
    storage: store,
    resolveCurrentAuthorization: (context) => ({
      context,
      currentTime: context.preflightTime,
      issuingDeviceActive: true,
      recipientAgentAuthorized: true,
      requestedNamespacesAuthorized: true,
      requestedDomainsAuthorized: true,
      hostAllowsOperation: true,
      currentSingleUseStatus: context.singleUseStatus,
    }),
    execute: (_opened, evidence) => prepareAgentObjectAccessManifestGenesisSet(
      encrypted.crypto,
      {
        objectId: encrypted.objectIdentity,
        payloadHash: encrypted.crypto.hash(encrypted.payloadBytes),
        envelopeBytes: [encrypted.envelopeBytes],
        authoritySet: evidence,
        namespaceBindings: [{
          namespaceId: NAMESPACE_ID,
          domainId: DOMAIN_ID,
          expectedAccessRevision: authority.expectedAccessRevision,
          expectedPolicyRevision: authority.expectedPolicyRevision,
          bindingHash: new Uint8Array(32).fill(0x71),
        }],
        agentAuthorizationRevision: runtimeAuthorizationRevision,
        runtime: initialized.runtime,
        signerPublication: initialized.signerPublication,
      },
    ),
  });
  if (coordinated.status !== "executed") {
    throw new Error("expected Task access preparation");
  }
  const access = coordinated.value;
  const prepared = createPreparedAgentTaskContentCryptoRevisionV1({
    signerKind: "agent_runtime",
    coordinate,
    authority,
    object: encrypted.object,
    access,
  });
  return { ...encrypted, access, prepared };
}

describe("prepared Task content revision", () => {
  test("accepts Human and Agent signers for both content kinds", async () => {
    for (const coordinate of [definition, result] as const) {
      expect(readPreparedTaskContentCryptoRevisionSnapshotV1(
        prepareHuman(coordinate, coordinate.kind === "definition" ? 11 : 12)
          .prepared,
      ).signerKind).toBe("human_device");
      expect(readPreparedTaskContentCryptoRevisionSnapshotV1(
        (await prepareAgent(
          coordinate,
          coordinate.kind === "definition" ? 13 : 14,
        )).prepared,
      ).signerKind).toBe("agent_runtime");
    }
  });

  test("rejects a signer through the wrong canonical preparation path", async () => {
    const human = prepareHuman(definition, 21);
    expect(() => createPreparedAgentTaskContentCryptoRevisionV1({
      signerKind: "agent_runtime",
      coordinate: definition,
      authority,
      object: human.object,
      access: human.access as never,
    })).toThrow("authentic prepared exact-set genesis");

    const agent = await prepareAgent(result, 22);
    expect(() => createPreparedHumanTaskContentCryptoRevisionV1({
      signerKind: "human_device",
      coordinate: result,
      authority,
      object: agent.object,
      access: agent.access as never,
    })).toThrow("authentic prepared v5 genesis");
  });

  test("rejects structurally valid non-canonical Human and Agent access sets", async () => {
    const human = prepareHuman(definition, 23);
    expect(() => createPreparedHumanTaskContentCryptoRevisionV1({
      signerKind: "human_device",
      coordinate: definition,
      authority,
      object: human.object,
      access: Object.freeze({ ...human.access }),
    })).toThrow("authentic prepared v5 genesis");

    const agent = await prepareAgent(result, 24);
    expect(() => createPreparedAgentTaskContentCryptoRevisionV1({
      signerKind: "agent_runtime",
      coordinate: result,
      authority,
      object: agent.object,
      access: Object.freeze({ ...agent.access }),
    })).toThrow("authentic prepared exact-set genesis");
  });

  test("rejects foreign handles and Human ciphertext mutation after sealing", () => {
    const value = prepareHuman(definition, 31);
    const foreign = Object.freeze({ ...value.prepared }) as
      PreparedTaskContentCryptoRevisionV1;
    expect(() => readPreparedTaskContentCryptoRevisionSnapshotV1(foreign))
      .toThrow("foreign or changed");
    value.object.payloadBytes.ciphertext[0]! ^= 1;
    expect(() => readPreparedTaskContentCryptoRevisionSnapshotV1(
      value.prepared,
    )).toThrow("foreign or changed");
  });

  test("rejects Agent envelope mutation after sealing", async () => {
    const value = await prepareAgent(result, 32);
    value.access.envelopeBytes[0]![0]! ^= 1;
    expect(() => readPreparedTaskContentCryptoRevisionSnapshotV1(
      value.prepared,
    )).toThrow("foreign or changed");

    const manifestMutation = await prepareAgent(definition, 33);
    manifestMutation.access.manifestBytes[0]! ^= 1;
    expect(() => readPreparedTaskContentCryptoRevisionSnapshotV1(
      manifestMutation.prepared,
    )).toThrow("foreign or changed");
  });
});
