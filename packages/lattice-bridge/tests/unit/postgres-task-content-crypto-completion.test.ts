import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  coordinateGrantAuthoritySetUse,
  createCommonHumanObjectAccessManifest,
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
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  serializeGrantV2,
} from "@nautilo/lattice-crypto/wire";

import {
  TaskContentCryptoCompletionConflictError,
  createPostgresTaskContentCryptoCompletion,
} from "../../src/server/task/postgres-task-content-crypto-completion.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";
import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";
import {
  createPreparedAgentTaskContentCryptoRevisionV1,
  createPreparedHumanTaskContentCryptoRevisionV1,
} from "../../src/task/task-content-prepared-revision.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityIdentityV1,
  fingerprintTaskContentAuthorityV1,
  type TaskContentCryptoRevisionReferenceV1,
} from "../../src/task/task-content-repository.ts";
import { encodeTaskPayloadV1 } from "../../src/task/task-payload-v1.ts";

const NOW = 1_820_000_000_000;
const HUMAN_ID = "30000000-0000-4000-8000-000000000001";
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_TASK_ID = "10000000-0000-4000-8000-000000000002";
const NAMESPACE_ID = "40000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "50000000-0000-4000-8000-000000000001";

const coordinate = Object.freeze({
  kind: "definition" as const,
  taskId: TASK_ID,
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
      const value = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        value[index] = state & 0xff;
      }
      return value;
    },
  };
}

function cloneRow(row: DatabaseRow): DatabaseRow {
  return Object.freeze(Object.fromEntries(Object.entries(row).map(
    ([key, value]) => [key, value instanceof Uint8Array ? value.slice() : value],
  ))) as DatabaseRow;
}

type DurableState = {
  object: DatabaseRow | null;
  manifests: Map<number, DatabaseRow>;
  envelopes: DatabaseRow[];
  head: DatabaseRow | null;
};

function cloneState(state: DurableState): DurableState {
  return {
    object: state.object === null ? null : cloneRow(state.object),
    manifests: new Map([...state.manifests].map(
      ([revision, row]) => [revision, cloneRow(row)],
    )),
    envelopes: state.envelopes.map(cloneRow),
    head: state.head === null ? null : cloneRow(state.head),
  };
}

class TaskCryptoConnection implements CryptoPostgresConnection {
  state: DurableState = {
    object: null,
    manifests: new Map(),
    envelopes: [],
    head: null,
  };

  constructor(readonly signer: DatabaseRow | null) {}

  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    _parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as unknown as Row[]);
    }
    throw new Error("Task crypto queries must use the transaction executor");
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    const working = cloneState(this.state);
    const transaction: CryptoPostgresExecutor = {
      query: async <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        parameters: readonly DatabaseScalar[] = [],
      ): Promise<readonly Row[]> => {
        const normalized = statement.replaceAll('"', "").toLowerCase();
        if (normalized.includes("pg_advisory_xact_lock")) return [];
        if (normalized.includes("from crypto_objects")) {
          return (working.object === null ? [] : [cloneRow(working.object)]) as Row[];
        }
        if (normalized.includes("from object_crypto_access_heads")) {
          if (working.head === null) return [];
          const revision = working.head["access_revision"] as number;
          const manifest = working.manifests.get(revision);
          if (manifest === undefined) return [];
          return [{ ...cloneRow(working.head), ...cloneRow(manifest) }] as Row[];
        }
        if (
          normalized.includes("from object_crypto_access_manifests")
          && normalized.includes("access_revision >=")
        ) {
          const minimum = parameters[1] as number;
          const maximum = parameters[2] as number;
          return [...working.manifests]
            .filter(([revision]) => revision >= minimum && revision <= maximum)
            .sort(([left], [right]) => left - right)
            .map(([, row]) => cloneRow(row)) as Row[];
        }
        if (normalized.includes("from object_crypto_access_manifests")) {
          const revision = parameters[1] as number;
          const manifest = working.manifests.get(revision);
          return (manifest === undefined ? [] : [cloneRow(manifest)]) as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")) {
          const revision = parameters[1] as number;
          return working.envelopes.filter(
            (row) => row["access_revision"] === revision,
          ).map(cloneRow) as Row[];
        }
        if (normalized.includes("from agent_crypto_runtime_signers")) {
          return (this.signer === null ? [] : [cloneRow(this.signer)]) as Row[];
        }
        if (normalized.includes("insert into crypto_objects")) {
          working.object = {
            object_id: parameters[0] as string,
            payload_hash: (parameters[1] as Uint8Array).slice(),
            payload_bytes: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_manifests")) {
          const revision = parameters[1] as number;
          working.manifests.set(revision, {
            object_id: parameters[0] as string,
            access_revision: revision,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
            previous_manifest_hash: parameters[3] === null
              ? null
              : (parameters[3] as Uint8Array).slice(),
            payload_hash: (parameters[4] as Uint8Array).slice(),
            manifest_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_namespace_envelopes")) {
          working.envelopes.push({
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            namespace_id: parameters[2] as string,
            ordinal: parameters[3] as number,
            envelope_hash: (parameters[4] as Uint8Array).slice(),
            envelope_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_heads")) {
          working.head = {
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        throw new Error(`Unexpected Task crypto SQL: ${statement.trim()}`);
      },
    };
    const result = await callback(transaction);
    this.state = working;
    return result;
  }
}

function encryptedFixture(seed: number) {
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => NOW });
  const objectIdentity = deriveTaskContentCryptoObjectIdV1(coordinate);
  const plaintext = encodeTaskPayloadV1({
    formatVersion: 1,
    prompt: "Private definition",
    expectedOutput: null,
    protectedMetadata: {},
  });
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(objectIdentity),
    keyClass: "ai",
    objectType: "nautilo-task-definition-v1",
    createdAt: unixTimestamp(NOW),
  }, plaintext);
  plaintext.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(crypto, new Uint8Array(32).fill(0x51), {
      objectId: objectId(objectIdentity),
      namespaceId: namespaceId(NAMESPACE_ID),
      keyClass: "ai",
      keyGeneration: namespaceGeneration(4),
      bindingRevisionAtWrap: accessRevision(authority.expectedAccessRevision),
    }, encrypted.dek),
  );
  const objectDek = encrypted.dek.slice();
  encrypted.dek.fill(0);
  return {
    crypto,
    objectIdentity,
    payloadBytes,
    envelopeBytes,
    object: encryptedObjectWriteRecord(payloadBytes),
    objectDek,
  };
}

async function fixture(kind: "human" | "agent") {
  const encrypted = encryptedFixture(kind === "human" ? 11 : 12);
  let signerRow: DatabaseRow | null = null;
  let humanPublicKey: Uint8Array | null = null;
  let managerPublicKey: Uint8Array | null = null;
  let humanSigner: ReturnType<LatticeCrypto["generateSigningKeyPair"]> | null = null;
  let prepared;
  if (kind === "human") {
    const signer = encrypted.crypto.generateSigningKeyPair();
    humanSigner = signer;
    humanPublicKey = signer.publicKey.slice();
    const access = prepareHumanObjectAccessManifestGenesisSet(encrypted.crypto, {
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
    });
    prepared = createPreparedHumanTaskContentCryptoRevisionV1({
      signerKind: "human_device",
      coordinate,
      authority,
      object: encrypted.object,
      access,
    });
  } else {
    const issuer = encrypted.crypto.generateSigningKeyPair();
    const recipient = await encrypted.crypto.generateEncryptionKeyPair();
    const manager = encrypted.crypto.generateSigningKeyPair();
    managerPublicKey = manager.publicKey.slice();
    const initialized = await prepareAgentRuntimeInitialization({
      crypto: encrypted.crypto,
      operationId: "task-agent-runtime-initialization",
      agentId: agentId("task-agent"),
      authorizationRevision: authorizationRevision(17),
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
      expectedPolicyRevision: authorizationRevision(authority.expectedPolicyRevision),
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
    if (preflight === null) throw new Error("expected Task Grant preflight");
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
          agentAuthorizationRevision: authorizationRevision(17),
          runtime: initialized.runtime,
          signerPublication: initialized.signerPublication,
        },
      ),
    });
    if (coordinated.status !== "executed") throw new Error("expected preparation");
    prepared = createPreparedAgentTaskContentCryptoRevisionV1({
      signerKind: "agent_runtime",
      coordinate,
      authority,
      object: encrypted.object,
      access: coordinated.value,
    });
    const publication = initialized.signerPublication;
    signerRow = {
      agent_id: publication.agentId,
      runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision,
      transition_kind: publication.transitionKind,
      operation_id: publication.operationId,
      signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
    };
  }
  const connection = new TaskCryptoConnection(signerRow);
  const handle = await verifyCryptoPostgresHandle(connection);
  let currentAuthority: TaskContentAuthorityV1 | null = authority;
  let signerHistoryAvailable = true;
  const adapter = createPostgresTaskContentCryptoCompletion({
    handle,
    crypto: encrypted.crypto,
    resolveCurrentAuthority: () => Promise.resolve(currentAuthority),
    resolveHistoricalHumanDeviceSigningPublicKey: () =>
      Promise.resolve(signerHistoryAvailable ? humanPublicKey?.slice() ?? null : null),
    resolveHistoricalAgentSignerAuthority: (context) =>
      signerHistoryAvailable && managerPublicKey !== null
        ? { ...context, managerSigningPublicKey: managerPublicKey.slice() }
        : null,
  });
  const reference: TaskContentCryptoRevisionReferenceV1 = {
    coordinate,
    objectId: prepared.objectId,
    objectType: prepared.objectType,
    expectedAccessRevision: 0,
    expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
    expectedAuthorityIdentityFingerprint:
      fingerprintTaskContentAuthorityIdentityV1(authority),
  };
  return {
    adapter,
    connection,
    prepared,
    reference,
    setCurrentAuthority(value: TaskContentAuthorityV1 | null) {
      currentAuthority = value;
    },
    setSignerHistoryAvailable(value: boolean) {
      signerHistoryAvailable = value;
    },
    rewrapHuman(nextAccessRevision: number) {
      if (humanSigner === null || connection.state.object === null) {
        throw new Error("Human Task fixture is unavailable");
      }
      const previous = connection.state.manifests.get(0);
      if (previous === undefined) throw new Error("Task genesis is missing");
      const previousManifestHash = previous["manifest_hash"];
      const payloadHash = previous["payload_hash"];
      if (!(previousManifestHash instanceof Uint8Array)
        || !(payloadHash instanceof Uint8Array)) {
        throw new Error("Task genesis hashes are invalid");
      }
      const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
        wrapObjectDekForNamespace(
          encrypted.crypto,
          new Uint8Array(32).fill(0x52),
          {
            objectId: objectId(encrypted.objectIdentity),
            namespaceId: namespaceId(NAMESPACE_ID),
            keyClass: "ai",
            keyGeneration: namespaceGeneration(5),
            bindingRevisionAtWrap: accessRevision(nextAccessRevision),
          },
          encrypted.objectDek,
        ),
      );
      const manifest = createCommonHumanObjectAccessManifest(
        encrypted.crypto,
        {
          objectId: objectId(encrypted.objectIdentity),
          payloadHash,
          accessRevision: accessRevision(1),
          previousManifestHash,
          envelopeHashes: [encrypted.crypto.hash(envelopeBytes)],
          signer: {
            kind: "human_device",
            subjectHumanId: humanId(HUMAN_ID),
            committerDeviceId: cryptoDeviceId("human-device.1"),
          },
          signerAuthorizationHash: null,
          hostAuthorizationRevision: authorizationRevision(8),
        },
        humanSigner.privateKey,
      );
      connection.state.manifests.set(1, {
        object_id: encrypted.objectIdentity,
        access_revision: 1,
        manifest_hash: manifest.hash.slice(),
        previous_manifest_hash: previousManifestHash,
        payload_hash: payloadHash,
        manifest_bytes: manifest.bytes.slice(),
      });
      connection.state.envelopes.push({
        object_id: encrypted.objectIdentity,
        access_revision: 1,
        namespace_id: NAMESPACE_ID,
        ordinal: 0,
        envelope_hash: encrypted.crypto.hash(envelopeBytes),
        envelope_bytes: envelopeBytes,
      });
      connection.state.head = {
        object_id: encrypted.objectIdentity,
        access_revision: 1,
        manifest_hash: manifest.hash.slice(),
      };
      currentAuthority = {
        ...authority,
        expectedAccessRevision: nextAccessRevision,
        expectedPolicyRevision: authority.expectedPolicyRevision + 1,
      };
    },
  };
}

describe("Postgres Task content crypto completion", () => {
  test("completes and verifies Human-device and Agent-runtime publications", async () => {
    for (const kind of ["human", "agent"] as const) {
      const state = await fixture(kind);
      expect(await state.adapter.complete(state.prepared)).toBe("created");
      expect(await state.adapter.verify(state.reference)).toMatchObject({
        coordinate,
        objectId: state.prepared.objectId,
        objectType: "nautilo-task-definition-v1",
        payloadVersion: 1,
        namespaceId: NAMESPACE_ID,
      });
    }
  });

  test("accepts exact replay and rejects an object-ID byte collision", async () => {
    const state = await fixture("human");
    expect(await state.adapter.complete(state.prepared)).toBe("created");
    expect(await state.adapter.complete(state.prepared)).toBe("duplicate");
    const object = state.connection.state.object;
    if (object === null) throw new Error("missing stored object");
    (object["payload_bytes"] as Uint8Array)[0]! ^= 1;
    expect(state.adapter.complete(state.prepared)).rejects.toBeInstanceOf(
      TaskContentCryptoCompletionConflictError,
    );
  });

  test("accepts exact replay and verification after a valid Namespace rewrap", async () => {
    const state = await fixture("human");
    expect(await state.adapter.complete(state.prepared)).toBe("created");
    state.rewrapHuman(3);
    expect(await state.adapter.complete(state.prepared)).toBe("duplicate");
    expect(await state.adapter.verify({
      ...state.reference,
      expectedAccessRevision: 1,
    })).toMatchObject({
      coordinate,
      objectId: state.prepared.objectId,
      namespaceId: NAMESPACE_ID,
    });
  });

  test("rejects cross-coordinate, cross-kind, and wrong access references", async () => {
    const state = await fixture("human");
    await state.adapter.complete(state.prepared);
    expect(state.adapter.verify({
      ...state.reference,
      coordinate: { ...coordinate, taskId: OTHER_TASK_ID },
    })).rejects.toThrow("reference is invalid");
    expect(state.adapter.verify({
      ...state.reference,
      objectType: "nautilo-task-run-result-v1",
    })).rejects.toThrow("reference is invalid");
    expect(state.adapter.verify({
      ...state.reference,
      expectedAccessRevision: 1,
    })).rejects.toBeInstanceOf(TaskContentCryptoCompletionConflictError);
  });

  test("rejects substituted Namespace authority and unavailable signer history", async () => {
    const state = await fixture("human");
    await state.adapter.complete(state.prepared);
    state.setCurrentAuthority({
      ...authority,
      namespaceId: "40000000-0000-4000-8000-000000000002",
    });
    expect(await state.adapter.verify(state.reference)).toBeNull();
    state.setCurrentAuthority(authority);
    state.setSignerHistoryAvailable(false);
    expect(state.adapter.verify(state.reference)).rejects.toThrow(
      "signer history is unavailable",
    );

    const agent = await fixture("agent");
    await agent.adapter.complete(agent.prepared);
    agent.setSignerHistoryAvailable(false);
    expect(agent.adapter.verify(agent.reference)).rejects.toThrow();
  });
});
