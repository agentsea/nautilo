import { createPostgresForegroundAgentAcceptedExecutionEvidenceResolver } from "../../src/server/message/postgres-foreground-agent-signer.ts";
import { verifyConversationProductPostgresHandle } from "../../src/server/message/postgres-conversation-product-store.ts";
/* eslint-disable @typescript-eslint/require-await -- Transactional fixture preserves asynchronous production callback signatures. */
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from "../../src/task/task-historical-content-identity.ts";
import { preparedTaskHistoricalRepairProvenanceV1 } from "../../src/task/task-historical-repair-provenance.ts";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  coordinateGrantAuthoritySetUse,
  createCommonHumanObjectAccessManifest,
  createDomainForegroundAuthorizationPlan,
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
  prepareHumanExistingTaskRepresentationPublicationRequest,
  unixTimestamp,
  wrapObjectDekForNamespace,
  openObjectDekForNamespace,
  type GrantAuthoritySetAuthorization,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  decodeNamespaceObjectEnvelopeV2,
  destroyDomainForegroundAuthorizationPlanV2,
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  encodeLiveShadowMessagePlanV4,
  encodeNamespaceObjectEnvelopeV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeGrantV2,
} from "@nautilo/lattice-crypto/wire";

import {
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
  createPreparedForegroundTaskDefinitionCryptoRevisionV1,
  createPreparedHumanTaskContentCryptoRevisionV1,
  authenticatePreparedHistoricalTaskContentCryptoRevisionV1,
} from "../../src/task/task-content-prepared-revision.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  taskContentObjectTypeV1,
  type TaskContentCoordinateV1,
  fingerprintTaskContentAuthorityIdentityV1,
  fingerprintTaskContentAuthorityV1,
  type TaskContentCryptoRevisionReferenceV1,
} from "../../src/task/task-content-repository.ts";
import { prepareDeviceWrappedAgentObject } from "../../src/object/device-wrapped-agent-object-crypto.ts";
import { encodeTaskDefinitionContent, encodeTaskPayloadV1, encodeTaskRunResultPayloadV1,
  type TaskDefinitionContent } from "../../src/task/task-payload-v1.ts";

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

  namespaceHead: DatabaseRow | null = null;
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
        if (normalized.includes("from namespace_domain_key_heads")) {
          return (this.namespaceHead === null ? [] : [this.namespaceHead]) as Row[];
        }
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
            signer_evidence_bytes: parameters[6] instanceof Uint8Array
              ? parameters[6].slice()
              : null,
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

function encryptedFixture(seed: number, objectIdentity = deriveTaskContentCryptoObjectIdV1(coordinate),
  contentCoordinate: TaskContentCoordinateV1 = coordinate,
  definitionContent: TaskDefinitionContent = { formatVersion: 1, prompt: "Private definition",
    expectedOutput: null, protectedMetadata: {} }) {
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => NOW });
  const plaintext = contentCoordinate.kind === "run_result"
    ? encodeTaskRunResultPayloadV1({ formatVersion: 1, resultText: "Private result", lastError: null })
    : encodeTaskDefinitionContent(definitionContent);
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(objectIdentity),
    keyClass: "ai",
    objectType: taskContentObjectTypeV1(contentCoordinate),
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

async function fixture(kind: "human" | "agent" | "historical" | "foreground",
  includeForegroundResolver = true, ephemeralForeground = false,
  contentCoordinate: TaskContentCoordinateV1 = coordinate,
  definitionContent?: TaskDefinitionContent,
  taskDefinitionForegroundAuthorizationBytes?: Uint8Array) {
  const coordinate = contentCoordinate;
  const sourceDigest = new Uint8Array(32).fill(12);
  const encrypted = encryptedFixture(kind === "agent" ? 12 : 11, kind === "historical"
    ? deriveTaskHistoricalContentCryptoObjectIdV1({ coordinate, sourceDigest, namespaceId: NAMESPACE_ID })
    : deriveTaskContentCryptoObjectIdV1(coordinate), coordinate, definitionContent);
  let signerRow: DatabaseRow | null = null;
  let humanPublicKey: Uint8Array | null = null;
  let managerPublicKey: Uint8Array | null = null;
  let humanSigner: ReturnType<LatticeCrypto["generateSigningKeyPair"]> | null = null;
  let prepared;
  if (kind !== "agent" && kind !== "foreground") {
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
    if (kind === "historical") {
      const digest = new Uint8Array(32).fill(13);
      const claimId = "60000000-0000-4000-8000-000000000001";
      const operationId = "historical-completion";
      const signed = prepareHumanExistingTaskRepresentationPublicationRequest(encrypted.crypto, {
        kind: coordinate.kind, entityId: coordinate.kind === "definition" ? TASK_ID : coordinate.taskRunId, taskId: TASK_ID, claimId, operationId,
        cryptoObjectId: encrypted.objectIdentity, sourceDigest, sourcePayloadHash: digest, planDigest: digest,
        operationalFieldsDigest: digest, expectedContentRevision: 0, nextContentRevision: 1,
        expectedCryptoAccessRevision: 0, resultCryptoAccessRevision: 0, subjectHumanId: HUMAN_ID,
        committerDeviceId: "human-device.1", hostAuthorizationRevision: 7, namespaceId: NAMESPACE_ID,
        domainId: DOMAIN_ID, expectedNamespaceAccessRevision: authority.expectedAccessRevision,
        expectedPolicyRevision: authority.expectedPolicyRevision, bindingHash: digest, keyGeneration: 4,
        payloadHash: encrypted.crypto.hash(encrypted.payloadBytes), manifestHash: encrypted.crypto.hash(access.manifestBytes),
        envelopeHash: encrypted.crypto.hash(encrypted.envelopeBytes), issuedAt: NOW, deadlineAt: NOW + 30_000,
        committerSigningPublicKey: signer.publicKey, committerSigningPrivateKey: signer.privateKey,
      });
      prepared = await authenticatePreparedHistoricalTaskContentCryptoRevisionV1({ crypto: encrypted.crypto,
        now: NOW, operationId, claimId, coordinate, authority, sourceDigest, sourcePayloadHash: digest,
        planDigest: digest, operationalFieldsDigest: digest, payloadBytes: encrypted.payloadBytes,
        manifestBytes: access.manifestBytes, envelopeBytes: encrypted.envelopeBytes,
        signedPublicationRequestBytes: signed.bytes, resolveCurrentAuthority: async () => signer.publicKey });
    } else prepared = createPreparedHumanTaskContentCryptoRevisionV1({
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
    if (kind === "foreground") {
      if (coordinate.kind !== "definition") throw new Error("Foreground fixture requires definition");
      const object = prepareDeviceWrappedAgentObject({
        crypto: encrypted.crypto, objectId: encrypted.objectIdentity,
        objectType: "nautilo-task-definition-v1",
        plaintextBytes: encodeTaskPayloadV1({ formatVersion: 1, prompt: "Native definition", expectedOutput: null, protectedMetadata: {} }),
        createdAt: NOW, operationId: "foreground-task-create",
        grant: { grantId: "foreground-task-grant", grantHash: new Uint8Array(32).fill(21), recipientKeyId: "foreground-recipient" },
        runtime: initialized.runtime, signerKeyId: publication.signerKeyId,
        signerPublicKey: publication.signerPublicKey,
        agentAuthorizationRevision:
          taskDefinitionForegroundAuthorizationBytes === undefined
            ? publication.authorizationRevision
            : 0,
        ...(taskDefinitionForegroundAuthorizationBytes === undefined ? {} : {
          taskDefinitionForegroundAuthorizationBytes,
        }),
        namespaceSet: [{ namespaceId: NAMESPACE_ID, domainId: DOMAIN_ID,
          accessRevision: authority.expectedAccessRevision, keyGeneration: 4,
          domainKeyGeneration: 1, domainAuthorizationRevision: 2,
          domainHeadDigest: new Uint8Array(32).fill(31), headDigest: new Uint8Array(32).fill(32),
          publicationDigest: new Uint8Array(32).fill(32), publicationSetDigest: new Uint8Array(32).fill(32),
          audienceFingerprint: new Uint8Array(32).fill(32), key: new Uint8Array(32).fill(51) }],
      });
      prepared = createPreparedForegroundTaskDefinitionCryptoRevisionV1({ coordinate, authority, prepared: object });
    }
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
  const connection = new TaskCryptoConnection(ephemeralForeground ? null : signerRow);
  const acceptedForeground = ephemeralForeground && signerRow !== null
    ? await acceptedForegroundSignerFixture(encrypted.crypto, signerRow) : undefined;
  const foregroundEvidence = acceptedForeground?.resolve;
  connection.namespaceHead = { domain_id: DOMAIN_ID, domain_key_generation: 1,
    domain_authorization_revision: 2, domain_head_digest: new Uint8Array(32).fill(31),
    namespace_current_generation: 4, namespace_access_revision: authority.expectedAccessRevision,
    retained_authority_set_digest: new Uint8Array(32).fill(32), state: "active" };
  const handle = await verifyCryptoPostgresHandle(connection);
  let foregroundAllowed = true;
  let changeAfterForeground = false;
  let currentAuthority: TaskContentAuthorityV1 | null = authority;
  let signerHistoryAvailable = true;
  const adapter = createPostgresTaskContentCryptoCompletion({
    handle,
    crypto: encrypted.crypto,
    resolveCurrentAuthority: () => Promise.resolve(currentAuthority),
    resolveForegroundAgentAcceptedExecutionEvidence: foregroundEvidence,
    ...(taskDefinitionForegroundAuthorizationBytes === undefined ? {} : {
      resolveTaskDefinitionForegroundAuthorization: async (evidence: Readonly<{
        objectId: string;
        authorizationBytes: Uint8Array;
      }>) => evidence.objectId === encrypted.objectIdentity
        && evidence.authorizationBytes.length
          === taskDefinitionForegroundAuthorizationBytes.length
        && evidence.authorizationBytes.every((byte, index) =>
          byte === taskDefinitionForegroundAuthorizationBytes[index])
        && signerRow?.["signer_public_key"] instanceof Uint8Array
          ? signerRow["signer_public_key"].slice()
          : null,
    }),
    ...(kind !== "foreground" || !includeForegroundResolver ? {} : { resolveCurrentForegroundDefinitionAuthorization: (context: import("@nautilo/lattice-crypto").DeviceWrappedAgentObjectAccessGenesisSetAuthorityContext) => {
      if (!foregroundAllowed || signerRow === null) return null;
      if (changeAfterForeground) currentAuthority = null;
      return { context, grantAuthorized: true as const, namespacesAuthorized: true as const,
        agentAuthorized: true as const, hostAllowsOperation: true as const,
        currentRuntime: { agentId: agentId(context.agentId), authorizationRevision: authorizationRevision(context.agentAuthorizationRevision),
          runtimeGeneration: agentRuntimeGeneration(context.runtimeGeneration) }, signerPublicKey: signerRow["signer_public_key"] as Uint8Array };
    } }),
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
    ...(kind !== "historical" ? {} : { historicalRepair: { namespaceId: NAMESPACE_ID,
      provenance: preparedTaskHistoricalRepairProvenanceV1(prepared) },
      expectedGenesisManifestHash: Uint8Array.from(
        (preparedTaskHistoricalRepairProvenanceV1(prepared) as { genesisManifestHash: string }).genesisManifestHash.match(/../gu)!,
        byte => Number.parseInt(byte, 16)) }),
    expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
    expectedAuthorityIdentityFingerprint:
      fingerprintTaskContentAuthorityIdentityV1(authority),
  };
  return {
    adapter, handle, crypto: encrypted.crypto,
    foregroundSignerPublicKey: kind === "foreground"
      && signerRow?.["signer_public_key"] instanceof Uint8Array
      ? signerRow["signer_public_key"].slice()
      : null,
    historicalDevicePublicKey(deviceId: string) { return (deviceId === "manager-device" ? managerPublicKey : humanPublicKey)?.slice() ?? null; },
    invalidateAcceptedPlan() { acceptedForeground?.invalidate(); },
    history: {
      resolveForegroundAgentAcceptedExecutionEvidence: foregroundEvidence,
      resolveHistoricalAgentSignerAuthority: (context: Parameters<Parameters<typeof createPostgresTaskContentCryptoCompletion>[0]["resolveHistoricalAgentSignerAuthority"]>[0]) => signerHistoryAvailable && managerPublicKey !== null ? { ...context, managerSigningPublicKey: managerPublicKey.slice() } : null,
      resolveHistoricalHumanDeviceSigningPublicKey: () => Promise.resolve(signerHistoryAvailable ? humanPublicKey?.slice() ?? null : null),
    },
    connection,
    prepared,
    reference,
    denyForeground() { foregroundAllowed = false; },
    changeAuthorityAfterForeground() { changeAfterForeground = true; },
    setCurrentAuthority(value: TaskContentAuthorityV1 | null) {
      currentAuthority = value;
    },
    setSignerHistoryAvailable(value: boolean) {
      signerHistoryAvailable = value;
    },
    rewrapHuman(nextAccessRevision: number) {
      let dek: Uint8Array = encrypted.objectDek;
      if (kind === "foreground") {
        humanSigner ??= encrypted.crypto.generateSigningKeyPair(); humanPublicKey = humanSigner.publicKey.slice();
        const bytes = connection.state.envelopes[0]?.["envelope_bytes"];
        if (!(bytes instanceof Uint8Array)) throw new Error("Missing foreground envelope");
        const opened = openObjectDekForNamespace(encrypted.crypto, new Uint8Array(32).fill(51), decodeNamespaceObjectEnvelopeV2(bytes));
        if (opened === null) throw new Error("Missing foreground key");
        dek = opened;
      }
      if (kind === "agent") { humanSigner ??= encrypted.crypto.generateSigningKeyPair(); humanPublicKey = humanSigner.publicKey.slice(); }
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
          dek,
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

export { fixture, authority, coordinate, NAMESPACE_ID, OTHER_TASK_ID };

export async function acceptedForegroundSignerFixture(
  crypto: LatticeCrypto,
  publication: Readonly<Record<string, unknown>>,
  coordinates: Readonly<{
    subjectHumanId: string;
    namespaceId: string;
    domainId: string;
  }> = { subjectHumanId: HUMAN_ID, namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID },
) {
  let acceptedPlanValid = true;
    const planBytes = encodeLiveShadowMessagePlanV4({
      formatVersion: 4, purpose: "message.live_shadow_plan", operationId: "accepted-foreground-turn",
      policyRevision: authority.expectedPolicyRevision, sessionId: TASK_ID, roomId: TASK_ID,
      humanMessageId: 12, revision: 0, createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(coordinates.subjectHumanId), committerDeviceId: cryptoDeviceId("human-device"),
      committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: authorizationRevision(1),
      recipientAgentId: agentId(publication["agent_id"] as string),
      agentAuthorizationRevision: authorizationRevision(17),
      agentRuntimeGeneration: agentRuntimeGeneration(publication["runtime_generation"] as number),
      agentSignerKeyId: publication["signer_key_id"] as string,
      agentSignerPublicKey: publication["signer_public_key"] as Uint8Array,
      namespaceId: namespaceId(coordinates.namespaceId), namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(4), namespaceHeadDigest: new Uint8Array(32).fill(32),
      namespacePublicationDigest: new Uint8Array(32).fill(32), namespacePublicationSetDigest: new Uint8Array(32).fill(32),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(32), grantDomainId: coordinates.domainId,
      grantDomainParticipantDigest: new Uint8Array(32).fill(32), grantDomainKeyGeneration: 1,
      grantDomainHeadDigest: new Uint8Array(32).fill(31), grantDomainPublicationDigest: new Uint8Array(32).fill(32),
      grantDomainAuthorizationRevision: authorizationRevision(2), namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(2),
      namespaceBundleRevision: 1, namespaceBundleDigest: new Uint8Array(32).fill(32),
      authorization: { disposition: "authorization_reusable", sessionReference: "retained-session",
        authorizationDigest: new Uint8Array(32).fill(21) },
      attemptCoordinate: "accepted-attempt", issuedAt: unixTimestamp(NOW), deadlineAt: unixTimestamp(NOW + 1000),
    });
    const authorizationPlan = createDomainForegroundAuthorizationPlan(crypto, {
      authorizationId: "accepted-foreground-authorization",
      policyRevision: authority.expectedPolicyRevision,
      sessionId: TASK_ID,
      roomId: TASK_ID,
      subjectHumanId: humanId(coordinates.subjectHumanId),
      committerDeviceId: cryptoDeviceId("human-device"),
      committerDeviceSigningGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(1),
      recipientKind: "agent",
      recipientPrincipalId: agentId(publication["agent_id"] as string),
      recipientAuthorizationRevision: authorizationRevision(17),
      recipientRuntimeGeneration:
        agentRuntimeGeneration(publication["runtime_generation"] as number),
      recipientKeyId: "foreground-recipient",
      operations: ["decrypt", "encrypt"],
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 1_000),
      maximumSecretBytes: 4_096,
      domains: [{ domainId: coordinates.domainId, sourceNamespaceId: namespaceId(coordinates.namespaceId),
        participantDigest: new Uint8Array(32).fill(32), participantCount: 1,
        keyClass: "ai", domainKeyGeneration: 1,
        authorizationRevision: authorizationRevision(2),
        headDigest: new Uint8Array(32).fill(31),
        activeNamespaceBindingSetDigest: new Uint8Array(32).fill(32),
        activeNamespaceBindingCount: 1 }],
    });
    const authorizationPlanBytes =
      serializeDomainForegroundAuthorizationPlanV2(authorizationPlan);
    destroyDomainForegroundAuthorizationPlanV2(authorizationPlan);
    const row = { operation_id: "accepted-foreground-turn", session_id: TASK_ID, room_id: TASK_ID,
      agent_id: publication["agent_id"], agent_runtime_generation: publication["runtime_generation"],
      agent_signer_key_id: publication["signer_key_id"], agent_signer_public_key: publication["signer_public_key"],
      plan_bytes: planBytes, plan_digest: crypto.hash(planBytes), grant_digest: new Uint8Array(32).fill(21),
      human_request_digest: new Uint8Array(32).fill(22), agent_grant_plan_bytes: authorizationPlanBytes,
      agent_grant_plan_digest: crypto.hash(authorizationPlanBytes), recipient_key_id: "foreground-recipient" };
    const query = async <Row extends import("../../src/server/message/postgres-conversation-product-store.ts").ConversationProductDatabaseRow>(statement: string): Promise<readonly Row[]> => {
      if (statement.includes("current_user")) return [{current_user: "nautilo", session_user: "nautilo"}] as unknown as Row[];
      if (statement.includes("conversation_shared_agent_shadow_executions")) return [];
      if (statement.includes("conversation_shadow_turn_agent_signers")) return [{ ...row,
        plan_digest: acceptedPlanValid ? row.plan_digest : new Uint8Array(32) }] as unknown as Row[];
      throw new Error("Unexpected accepted execution query");
    };
    const product = await verifyConversationProductPostgresHandle({ query, transaction: use => use({ query }) });
    return { resolve: createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({ product, crypto,
      rejectInvalidSelectedEvidence: true }), invalidate() { acceptedPlanValid = false; } };

}
