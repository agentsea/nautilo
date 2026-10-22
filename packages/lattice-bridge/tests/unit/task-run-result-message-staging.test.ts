import { describe, expect, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainNamespaceRetainedAuthoritySetDigest,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareAgentRuntimeInitialization,
  prepareDomainNamespaceBundle,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type DomainForegroundSecretEntry,
  type TaskRuntimeRunResultReadEvidence,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
  DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import { createAgentObjectAccessManifestV5, createHumanObjectAccessManifestV5 } from
  "../../../lattice-crypto/src/format/object-access-manifest-v5.ts";
import {
  withTaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-run-result-read-evidence-v1.ts";

import { deriveMessageCryptoObjectIdV2 } from
  "../../src/message/conversation-repository.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
} from "../../src/task/task-content-repository.ts";
import { encodeTaskRunResultPayloadV1 } from
  "../../src/task/task-payload-v1.ts";
import {
  withNativeProtectedTaskRunResultMessageSourceV1,
  type NativeProtectedTaskRunResultOccurrenceV1,
} from "../../src/server/task/native-protected-task-run-result-opener.ts";
import {
  type NativeTaskRunResultMessageAuthority,
  type PrepareNativeTaskRunResultMessageInput,
} from "../../src/server/task/native-task-run-result-message-preparation.ts";
import {
  assertVerifiedStagedTaskRunResultMessagePublication,
  inspectStagedTaskRunResultMessagePublication,
  readStagedTaskRunResultMessageIntent,
  stageNativeTaskRunResultMessagePublication,
  type NativeTaskRunResultMessageCurrentAuthority,
  type NativeTaskRunResultMessageIntent,
} from "../../src/server/task/postgres-task-run-result-message-staging.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type { DatabaseRow, DatabaseScalar } from
  "../../src/server/storage/postgres-record-codecs.ts";
import { withCertifiedRunResultPublicationSigner } from
  "../fixtures/task-publication-signer.ts";

const NOW = 1_940_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000741";
const RUN = "20000000-0000-4000-8000-000000000741";
const HUMAN = "30000000-0000-4000-8000-000000000741";
const PRIVATE_NS = "private-result-namespace";
const PRIVATE_DOMAIN = "private-result-domain";
const DEST_NS = "destination-message-namespace";
const DEST_DOMAIN = "destination-message-domain";
const ROOM = "40000000-0000-4000-8000-000000000741";
const SESSION = "50000000-0000-4000-8000-000000000741";
const AGENT = "task-result-message-agent";
const SERVER = "https://nautilo.example";
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

async function fixture(mappedAccess = 0) {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const privateDomainKey = bytes(0x31);
  const privateGenerationKey = bytes(0x32);
  const destinationDomainKey = bytes(0x41);
  const destinationGenerationKey = bytes(0x42);
  const makeNamespace = (
    namespace: string,
    domain: string,
    domainKey: Uint8Array,
    generationKey: Uint8Array,
    marker: number,
  ) => {
    const retained = [{ generation: namespaceGeneration(0),
      accessRevision: accessRevision(0), headDigest: bytes(marker),
      generationKey }];
    const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(
      crypto, retained);
    const publicDomain = Object.freeze({
      domainId: domain, sourceNamespaceId: namespace,
      participantDigest: bytes(marker + 1), participantCount: 1,
      keyClass: "ai" as const, domainKeyGeneration: 4,
      authorizationRevision: authorizationRevision(9),
      headDigest: bytes(marker + 2),
      activeNamespaceBindingSetDigest: bytes(marker + 3),
      activeNamespaceBindingCount: 1,
    });
    const current = {
      serverId: SERVER, cryptoDomainId: cryptoDomainId(domain),
      participantDigest: publicDomain.participantDigest, participantCount: 1,
      keyClass: "ai" as const, domainKeyGeneration: 4,
      domainAuthorizationRevision: authorizationRevision(9),
      domainHeadDigest: publicDomain.headDigest,
      namespaceId: namespaceId(namespace),
      namespaceAccessRevision: accessRevision(0),
      namespaceCurrentGeneration: namespaceGeneration(0), bundleRevision: 1,
      retainedAuthoritySetDigest: retainedDigest,
    };
    const bundle = prepareDomainNamespaceBundle(crypto, {
      operationId: `task-result-message-binding:${namespace}`,
      previousBindingDigest: null,
      bundle: { ...current,
        formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
        purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
        retainedGenerationCount: 1, retainedGenerations: retained },
      issuerHumanId: humanId(HUMAN), issuerDeviceId: cryptoDeviceId("device"),
      issuerDeviceSigningGeneration: 1,
      issuerSigningPrivateKey: issuer.privateKey,
      issuerSigningPublicKey: issuer.publicKey, domainKey, issuedAt: NOW,
    });
    return { publicDomain, current, bundle, retainedDigest };
  };
  const privateNamespace = makeNamespace(PRIVATE_NS, PRIVATE_DOMAIN,
    privateDomainKey, privateGenerationKey, 0x51);
  const destinationNamespace = makeNamespace(DEST_NS, DEST_DOMAIN,
    destinationDomainKey, destinationGenerationKey, 0x61);
  const initialized = await prepareAgentRuntimeInitialization({
    crypto, operationId: "task-result-message-runtime", agentId: agentId(AGENT),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{ objectId: "task-result-message-config",
      configRevision: authorizationRevision(1), plaintextDek: bytes(0x21) }],
    domains: [], resolveCurrentDomainCommitterAuthority: () => null,
    manager: { managerHumanId: humanId(HUMAN),
      managerAuthorizationRevision: authorizationRevision(2),
      managerDeviceId: cryptoDeviceId("device") },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const result = {
    taskId: TASK, taskRunId: RUN, terminalStatus: "completed" as const,
    contentRevision: 1 as const, cryptoAccessRevision: mappedAccess,
    objectId: deriveTaskContentCryptoObjectIdV1({
      kind: "run_result", taskId: TASK, taskRunId: RUN, contentRevision: 1,
    }),
    genesisManifestHash: bytes(0), signerAgentId: AGENT,
    namespace: { namespaceId: PRIVATE_NS, domainId: PRIVATE_DOMAIN,
      operations: ["decrypt"] as const, expectedAccessRevision: 0,
      expectedPolicyRevision: 7 },
  };
  const resultPlaintext = encodeTaskRunResultPayloadV1({
    formatVersion: 1, resultText: "A durable protected Task result",
    lastError: "must never become Message content",
  });
  const encryptedResult = encryptObjectPayload(crypto, {
    objectId: objectId(result.objectId), keyClass: "ai",
    objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1, createdAt: unixTimestamp(NOW),
  }, resultPlaintext);
  resultPlaintext.fill(0);
  const resultPayloadBytes = encodeEncryptedPayloadV2(encryptedResult.payload);
  const resultEnvelope = wrapObjectDekForNamespace(crypto,
    privateGenerationKey, { objectId: objectId(result.objectId),
      namespaceId: namespaceId(PRIVATE_NS), keyClass: "ai",
      keyGeneration: namespaceGeneration(0),
      bindingRevisionAtWrap: accessRevision(0) }, encryptedResult.dek);
  const resultEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(resultEnvelope);
  encryptedResult.dek.fill(0);
  encryptedResult.payload.ciphertext.fill(0);
  resultEnvelope.wrappedDek.fill(0);
  const resultManifest = createAgentObjectAccessManifestV5(crypto, {
    objectId: objectId(result.objectId),
    payloadHash: crypto.hash(resultPayloadBytes), accessRevision: accessRevision(0),
    previousManifestHash: null,
    envelopeHashes: [crypto.hash(resultEnvelopeBytes)],
    signer: { kind: "agent_runtime", agentId: initialized.runtime.agentId,
      runtimeGeneration: initialized.runtime.generation,
      signerKeyId: initialized.signerPublication.signerKeyId },
    signerAuthorizationHash: null,
    hostAuthorizationRevision: authorizationRevision(7),
  }, initialized.runtime);
  result.genesisManifestHash = resultManifest.hash.slice();
  const invocation = { kind: "raw" as const,
    bindingId: `task-run-output:${RUN}`,
    operationId: `task-run-delivery-message:${RUN}`,
    roomId: ROOM, sessionId: SESSION };
  const occurrence: NativeProtectedTaskRunResultOccurrenceV1 = {
    requesterHumanId: HUMAN, result, invocation,
  };
  const authorizationBytes = new Uint8Array([7, 4, 1, 9]);
  const evidenceInput: TaskRuntimeRunResultReadEvidenceInputV1 = {
    purpose: "task.runtime.run_result_read", workKind: "task.deliver_result",
    requestId: `task-run-delivery-result-authorization:${RUN}`, workId: RUN,
    claimId: "task-result-message-read-claim", claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 50_000,
    authorizationExpiresAt: NOW + 40_000, expiresAt: NOW + 40_000,
    recipientGeneration: 2, recipientKeyId: "task-result-message-recipient",
    authorizationDigest: crypto.hash(authorizationBytes), requesterHumanId: HUMAN,
    policyRevision: 7, episodeId: SESSION, sourceRoomId: ROOM,
    hostAuthorizationRevision: 5, recipientAuthorizationRevision: 6,
    operations: ["decrypt"], result, invocation,
    resultDomain: privateNamespace.publicDomain,
    messageWrite: { taskId: TASK, taskRunId: RUN,
      bindingId: invocation.bindingId, messageOperationId: invocation.operationId,
      roomId: ROOM, sessionId: SESSION, signerAgentId: AGENT,
      namespace: { namespaceId: DEST_NS, domainId: DEST_DOMAIN,
        operations: ["encrypt"], expectedAccessRevision: 0,
        expectedPolicyRevision: 7 },
      domain: destinationNamespace.publicDomain },
  };
  let sourceHead = mappedAccess;
  const rewrap = createHumanObjectAccessManifestV5(crypto, {
    objectId: objectId(result.objectId), payloadHash: crypto.hash(resultPayloadBytes), accessRevision: accessRevision(1),
    previousManifestHash: resultManifest.hash, envelopeHashes: [crypto.hash(resultEnvelopeBytes)],
    signer: { kind: "human_device", subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId("device") },
    signerAuthorizationHash: null, hostAuthorizationRevision: authorizationRevision(1),
  }, issuer.privateKey);
  const manifestRow = { object_id: result.objectId, access_revision: 0,
    manifest_hash: resultManifest.hash, previous_manifest_hash: null,
    payload_hash: crypto.hash(resultPayloadBytes),
    manifest_bytes: resultManifest.bytes };
  const restricted: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) {
        rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      } else if (statement.includes('from "namespace_domain_key_heads"')
        && statement.includes("inner join")) {
        rows = [{ binding_bytes: privateNamespace.bundle.bytes,
          binding_digest: privateNamespace.bundle.bindingDigest,
          signing_public_key: issuer.publicKey }];
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        rows = [{ namespace_id: PRIVATE_NS, namespace_access_revision: 0,
          namespace_current_generation: 0, domain_id: PRIVATE_DOMAIN,
          domain_key_generation: 4, domain_authorization_revision: 9,
          domain_head_digest: privateNamespace.publicDomain.headDigest,
          bundle_revision: 1, retained_generation_count: 1,
          retained_authority_set_digest: privateNamespace.retainedDigest,
          binding_digest: privateNamespace.bundle.bindingDigest }];
      } else if (statement.includes('from "domain_key_heads"')) {
        rows = [{ domain_id: PRIVATE_DOMAIN, domain_key_generation: "4",
          authorization_revision: "9",
          head_digest: privateNamespace.publicDomain.headDigest,
          participant_digest: privateNamespace.publicDomain.participantDigest,
          participant_count: "1" }];
      } else if (statement.includes('from "crypto_objects"')) {
        rows = [{ object_id: result.objectId, payload_bytes: resultPayloadBytes,
          payload_hash: crypto.hash(resultPayloadBytes) }];
      } else if (statement.includes('from "object_crypto_access_heads"')) {
        rows = sourceHead === 0 ? [manifestRow] : [{ ...manifestRow, access_revision: 1, previous_manifest_hash: resultManifest.hash, manifest_hash: rewrap.hash, manifest_bytes: rewrap.bytes }];
      } else if (statement.includes('from "object_crypto_namespace_envelopes"')) {
        rows = [{ object_id: result.objectId, access_revision: sourceHead, ordinal: 0, namespace_id: PRIVATE_NS,
          envelope_hash: crypto.hash(resultEnvelopeBytes),
          envelope_bytes: resultEnvelopeBytes }];
      } else if (statement.includes('from "object_crypto_access_manifests"')) {
        rows = sourceHead === 1 && statement.includes("order by")
          ? [manifestRow, { ...manifestRow, access_revision: 1, previous_manifest_hash: resultManifest.hash,
            manifest_hash: rewrap.hash, manifest_bytes: rewrap.bytes }] : [manifestRow];
      } else if (statement.includes('from "human_crypto_devices"')) {
        rows = [{ device_id: "device", human_id: HUMAN, signing_public_key: issuer.publicKey, state: "active", revision: 1 }];
      } else if (statement.includes('from "agent_crypto_runtime_signers"')) {
        rows = [{ agent_id: AGENT,
          runtime_generation: initialized.runtime.generation,
          authorization_revision: initialized.signerPublication.authorizationRevision,
          transition_kind: initialized.signerPublication.transitionKind,
          operation_id: initialized.signerPublication.operationId,
          signer_key_id: initialized.signerPublication.signerKeyId,
          signer_public_key: initialized.signerPublication.signerPublicKey,
          publication_bytes:
            encodeAgentRuntimeSignerPublicationV1(initialized.signerPublication) }];
      } else throw new Error(`Unexpected Task result Message query: ${statement}`);
      return rows as readonly Row[];
    },
    transaction: async use => use(restricted),
    transactionOnce: async use => use(restricted),
  };
  const privateDomain = {
    ...privateNamespace.publicDomain, domainKey: privateDomainKey,
  } satisfies DomainForegroundSecretEntry;
  const allocation = { sessionId: SESSION, messageId: 23, revision: 0 as const,
    objectId: deriveMessageCryptoObjectIdV2({ sessionId: SESSION,
      messageId: 23, revision: 0 }), createdAt: NOW,
    mode: "encrypted_only" as const, acceptedPolicyRevision: 6,
    publicationPolicyRevision: 7 };
  const controller = new AbortController();
  let now = NOW;
  const checks: NativeTaskRunResultMessageAuthority[] = [];
  const destinationSource: PrepareNativeTaskRunResultMessageInput["namespace"] = {
    current: destinationNamespace.current,
    bindingBytes: destinationNamespace.bundle.bytes,
    expectedBindingDigest: destinationNamespace.bundle.bindingDigest,
    issuerSigningPublicKey: issuer.publicKey,
    domainKey: destinationDomainKey,
  };
  const run = <Value>(operation: (input: Readonly<{
    evidence: TaskRuntimeRunResultReadEvidence;
    source: PrepareNativeTaskRunResultMessageInput["source"];
    preparation: PrepareNativeTaskRunResultMessageInput;
  }>) => Value | PromiseLike<Value>) =>
    withTaskRuntimeRunResultReadEvidenceV1({ evidence: evidenceInput,
      signal: controller.signal, now: () => now,
      execute: evidence => withNativeProtectedTaskRunResultMessageSourceV1({
        restricted, crypto, serverScope: SERVER, evidence,
        domains: [privateDomain], signal: controller.signal,
        loadCurrentResult: async () => occurrence,
        resolveHistoricalAgentSignerAuthority: context => ({ ...context,
          managerSigningPublicKey: manager.publicKey }),
        execute: source => operation({ evidence, source,
          preparation: {
            crypto, evidence, source, allocation,
            namespace: destinationSource,
            runtime: initialized.runtime,
            signerPublication: initialized.signerPublication,
            agentAuthorizationRevision: 7,
            resolveHistoricalSignerPublicationManager: () => manager.publicKey,
            signal: controller.signal,
            resolveCurrentAuthority: authority => {
              checks.push(authority);
              return Promise.resolve({ ...authority });
            },
          },
        }),
      }),
    });
  const certifiedRun = <Value>(operation: (input: Readonly<{
    evidence: TaskRuntimeRunResultReadEvidence;
    source: PrepareNativeTaskRunResultMessageInput["source"];
    preparation: PrepareNativeTaskRunResultMessageInput;
    authorizationBytes: Uint8Array;
    certificateBytes: Uint8Array;
  }>) => Value | PromiseLike<Value>) =>
    withCertifiedRunResultPublicationSigner({
      crypto,
      now: crypto.clock.now(),
      deviceSigner: issuer,
      requestId: evidenceInput.requestId,
      sessionId: SESSION,
      roomId: ROOM,
      requesterHumanId: HUMAN,
      signerAgentId: AGENT,
      policyRevision: 7,
      domains: [privateDomain, {
        ...destinationNamespace.publicDomain,
        domainKey: destinationDomainKey,
      }],
      namespaceRequirements: [
        { ...evidenceInput.messageWrite!.namespace, ordinal: 0 },
        { ...result.namespace, ordinal: 1 },
      ],
      work: {
        kind: "task.deliver_result",
        taskId: TASK,
        taskRunId: RUN,
        contentRevision: 1,
        workIdentityHash: bytes(0xb3),
      },
      result,
      invocation,
      foregroundNamespaceRequirements: [{
        ...evidenceInput.messageWrite!.namespace,
        ordinal: 0,
      }],
    }, async ({ evidence, signer, authorizationBytes, certificateBytes }) =>
      withNativeProtectedTaskRunResultMessageSourceV1({
        restricted, crypto, serverScope: SERVER, evidence,
        domains: [privateDomain], signal: controller.signal,
        loadCurrentResult: async () => occurrence,
        resolveHistoricalAgentSignerAuthority: context => ({ ...context,
          managerSigningPublicKey: manager.publicKey }),
        execute: source => operation({ evidence, source,
          authorizationBytes, certificateBytes,
          preparation: {
            crypto, evidence, source, allocation,
            namespace: destinationSource,
            runtime: signer.runtime,
            signerPublication: null,
            temporarySigner: signer,
            agentAuthorizationRevision: 0,
            resolveHistoricalSignerPublicationManager: () => {
              throw new Error("permanent signer history must not be loaded");
            },
            signal: controller.signal,
            resolveCurrentAuthority: authority => {
              checks.push(authority);
              return Promise.resolve({ ...authority });
            },
          },
        }),
      }));
  return { crypto, run, certifiedRun, allocation, checks,
    destinationGenerationKey,
    rewrapSource: () => { sourceHead = 1; }, sourceObjectId: result.objectId, sourceQuery: restricted.query,
    destinationSource,
    controller, evidenceInput, signerPublication: initialized.signerPublication,
    deviceSigningPublicKey: issuer.publicKey.slice(),
    managerPublicKey: manager.publicKey.slice(),
    authorizationBytes,
    expire: () => { now = NOW + 60_000; } };
}

type DurableState = Readonly<{
  object: DatabaseRow | null;
  head: DatabaseRow | null;
  manifests: readonly DatabaseRow[];
  envelopes: readonly DatabaseRow[];
  receipt: DatabaseRow | null;
}>;
const emptyState = (): DurableState => ({
  object: null, head: null, manifests: [], envelopes: [], receipt: null,
});
function cloneRow(row: DatabaseRow): DatabaseRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, value instanceof Uint8Array ? value.slice() : value,
  ])) as DatabaseRow;
}
function cloneState(state: DurableState): DurableState {
  return { object: state.object === null ? null : cloneRow(state.object),
    head: state.head === null ? null : cloneRow(state.head),
    manifests: state.manifests.map(cloneRow),
    envelopes: state.envelopes.map(cloneRow),
    receipt: state.receipt === null ? null : cloneRow(state.receipt) };
}

class ResultMessageCryptoConnection implements CryptoPostgresConnection {
  state: DurableState = emptyState();
  claim: DatabaseRow | null = null;
  namespaces: readonly DatabaseRow[] = [];
  domains: readonly DatabaseRow[] = [];
  sourceObjectId: string | undefined;
  sourceQuery: PostgresJsBridgeConnection["query"] | undefined;
  failReceipt = false;
  claimReads = 0;
  humanDevice: DatabaseRow | null = null;
  readonly locks: string[] = [];

  constructor(readonly signer: DatabaseRow) {}

  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{ current_user: "nautilo_crypto",
        session_user: "nautilo_crypto" }] as unknown as Row[]);
    }
    return this.transaction(tx => tx.query<Row>(statement, parameters));
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    const working = cloneState(this.state);
    const executor: CryptoPostgresExecutor = {
      query: async <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        parameters: readonly DatabaseScalar[] = [],
      ): Promise<readonly Row[]> => {
        if (this.sourceQuery !== undefined && (parameters.includes(this.sourceObjectId ?? "")
          || statement.includes('from "human_crypto_devices"'))) {
          return this.sourceQuery<Row>(statement, parameters);
        }
        const normalized = statement.replaceAll('"', "").toLowerCase();
        if (normalized.includes("current_user::text")) return [{
          current_user: "nautilo_crypto", session_user: "nautilo_crypto",
        }] as unknown as Row[];
        if (normalized.includes("pg_advisory_xact_lock")) {
          this.locks.push(parameters[0] as string);
          return [];
        }
        if (normalized.includes("from background_crypto_authorization_namespace_requirements")) {
          return this.namespaces.map(cloneRow) as Row[];
        }
        if (normalized.includes("from background_crypto_authorization_domain_requirements")) {
          return this.domains.map(cloneRow) as Row[];
        }
        if (normalized.includes("from background_crypto_authorization_requests")) {
          this.claimReads += 1;
          return (this.claim === null ? [] : [cloneRow(this.claim)]) as Row[];
        }
        if (normalized.includes("from task_terminal_message_crypto_staging_receipts")) {
          return (working.receipt === null ? [] : [cloneRow(working.receipt)]) as Row[];
        }
        if (normalized.includes("insert into task_terminal_message_crypto_staging_receipts")) {
          if (this.failReceipt) throw new Error("receipt write failed");
          const fields = ["request_id", "recipient_generation", "claim_id",
            "authorization_digest", "delivery_intent_hash", "raw_result_message_intent",
            "accepted_policy_revision", "publication_policy_revision",
            "authority_fingerprint", "crypto_object_id",
            "genesis_manifest_hash"];
          (working as { receipt: DatabaseRow | null }).receipt =
            Object.fromEntries(fields.map((field, index) => {
              const value = parameters[index]!;
              return [field, field === "raw_result_message_intent" && typeof value === "string"
                ? JSON.parse(value) as unknown : value instanceof Uint8Array ? value.slice() : value];
            })) as DatabaseRow;
          return [];
        }
        if (normalized.includes("from crypto_objects")) {
          return (working.object === null ? [] : [cloneRow(working.object)]) as Row[];
        }
        if (normalized.includes("from object_crypto_access_heads")) {
          return (working.head === null ? [] : [cloneRow(working.head)]) as Row[];
        }
        if (normalized.includes("from object_crypto_access_manifests")) {
          return working.manifests.map(cloneRow) as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")) {
          return working.envelopes.map(cloneRow) as Row[];
        }
        if (normalized.includes("from agent_crypto_runtime_signers")) {
          return [cloneRow(this.signer)] as Row[];
        }
        if (normalized.includes("from human_crypto_devices")) {
          return (this.humanDevice === null ? []
            : [cloneRow(this.humanDevice)]) as Row[];
        }
        if (normalized.includes("insert into crypto_objects")) {
          (working as { object: DatabaseRow | null }).object = {
            object_id: parameters[0] as string,
            payload_hash: (parameters[1] as Uint8Array).slice(),
            payload_bytes: (parameters[2] as Uint8Array).slice(),
          }; return [];
        }
        if (normalized.includes("insert into object_crypto_access_manifests")) {
          (working.manifests as DatabaseRow[]).push({
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
            previous_manifest_hash: parameters[3] as null,
            payload_hash: (parameters[4] as Uint8Array).slice(),
            manifest_bytes: (parameters[5] as Uint8Array).slice(),
            signer_evidence_bytes: parameters[6] === null ? null
              : (parameters[6] as Uint8Array).slice(),
          }); return [];
        }
        if (normalized.includes("insert into object_crypto_namespace_envelopes")) {
          (working.envelopes as DatabaseRow[]).push({
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            namespace_id: parameters[2] as string,
            ordinal: parameters[3] as number,
            envelope_hash: (parameters[4] as Uint8Array).slice(),
            envelope_bytes: (parameters[5] as Uint8Array).slice(),
          }); return [];
        }
        if (normalized.includes("insert into object_crypto_access_heads")) {
          (working as { head: DatabaseRow | null }).head = {
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
          }; return [];
        }
        throw new Error(`Unexpected Task result Message SQL: ${statement}`);
      },
    };
    const result = await callback(executor);
    this.state = working;
    return result;
  }
}

function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function failure(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error: unknown) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected operation to fail");
}

describe("Task run result Message crypto staging", () => {
  test("stages a certified V3 result response bound to its active signer", async () => {
    const value = await fixture();
    const publication = value.signerPublication;
    const connection = new ResultMessageCryptoConnection({
      agent_id: publication.agentId,
      runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision,
      transition_kind: publication.transitionKind,
      operation_id: publication.operationId,
      signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
    });
    connection.humanDevice = {
      device_id: "device:task-publication-signer-fixture",
      human_id: HUMAN, device_generation: 1,
      signing_public_key: value.deviceSigningPublicKey, state: "active",
    };
    await value.certifiedRun(async ({ evidence, source, preparation,
      authorizationBytes, certificateBytes }) => {
      const write = evidence.messageWrite!;
      if (evidence.result.terminalStatus !== "completed"
        && evidence.result.terminalStatus !== "errored") {
        throw new Error("Expected a raw revision-one terminal result");
      }
      const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
        authorizationBytes,
        certificateBytes,
      });
      connection.claim = {
        request_id: evidence.requestId, work_id: evidence.workId,
        work_kind: "task.deliver_result", purpose: "task.deliver_result",
        state: "running", format_version: 3,
        credential_subject_kind: "runtime", runtime_kind: "task",
        runtime_version: 1, claim_id: evidence.claimId,
        recipient_generation: evidence.recipientGeneration,
        recipient_key_id: evidence.recipientKeyId,
        idempotency_key: `task-output-read:${"c".repeat(64)}`,
        accepted_response_kind: "runtime",
        accepted_response_hash: value.crypto.hash(responseBytes),
        accepted_response_bytes: responseBytes,
        expected_policy_revision: evidence.policyRevision,
        namespace_id: evidence.result.namespace.namespaceId,
        domain_id: evidence.result.namespace.domainId,
        expected_namespace_access_revision:
          evidence.result.namespace.expectedAccessRevision,
        expected_domain_epoch: evidence.resultDomain.domainKeyGeneration,
        live: true,
      };
      connection.namespaces = [
        { request_id: evidence.requestId,
          namespace_id: evidence.result.namespace.namespaceId, ordinal: 0,
          domain_id: evidence.result.namespace.domainId, operation_mask: 1,
          expected_access_revision:
            evidence.result.namespace.expectedAccessRevision,
          expected_policy_revision: evidence.policyRevision },
        { request_id: evidence.requestId,
          namespace_id: write.namespace.namespaceId, ordinal: 1,
          domain_id: write.namespace.domainId, operation_mask: 2,
          expected_access_revision: write.namespace.expectedAccessRevision,
          expected_policy_revision: evidence.policyRevision },
      ];
      connection.domains = [evidence.resultDomain, write.domain].map(
        (domain, ordinal) => ({ request_id: evidence.requestId,
          domain_id: domain.domainId, ordinal,
          expected_epoch: domain.domainKeyGeneration,
          expected_agent_authorization_revision: null,
          expected_authorization_revision: domain.authorizationRevision }));
      const current: NativeTaskRunResultMessageCurrentAuthority = {
        taskId: evidence.result.taskId, taskRunId: evidence.result.taskRunId,
        bindingId: evidence.invocation.bindingId,
        messageOperationId: evidence.invocation.operationId,
        sessionId: preparation.allocation.sessionId,
        messageId: preparation.allocation.messageId, revision: 0,
        objectId: preparation.allocation.objectId,
        roomId: evidence.invocation.roomId,
        namespaceId: write.namespace.namespaceId,
        domainId: write.namespace.domainId, mode: preparation.allocation.mode,
        acceptedPolicyRevision: preparation.allocation.acceptedPolicyRevision,
        currentPolicyRevision:
          preparation.allocation.publicationPolicyRevision,
        namespaceAccessRevision: write.namespace.expectedAccessRevision,
        requesterHumanId: evidence.requesterHumanId,
        resultTerminalStatus: evidence.result.terminalStatus,
        resultContentRevision: 1,
        resultObjectId: evidence.result.objectId,
        resultGenesisManifestHash: hex(evidence.result.genesisManifestHash),
        resultCryptoAccessRevision: evidence.result.cryptoAccessRevision,
        resultNamespaceId: evidence.result.namespace.namespaceId,
        resultDomainId: evidence.result.namespace.domainId,
        resultNamespaceAccessRevision:
          evidence.result.namespace.expectedAccessRevision,
      };
      expect(source.result.objectId).toBe(evidence.result.objectId);
      expect(await stageNativeTaskRunResultMessagePublication({
        restricted: connection as unknown as PostgresJsBridgeConnection,
        preparation,
        resolveHistoricalAgentSignerAuthority: context => ({ ...context,
          managerSigningPublicKey: value.managerPublicKey.slice() }),
        assertCurrentClaim: () => undefined,
        resolveCurrentDeliveryAuthority: () => Promise.resolve(current),
      })).toBe("staged");
    });
    expect(connection.state.object).not.toBeNull();
    expect(connection.state.receipt).not.toBeNull();
  });

  test.each([0, 1])("atomically stages and recovers authentic result head %s without another read grant", async mappedAccess => {
    const value = await fixture(mappedAccess);
    const publication = value.signerPublication;
    const connection = new ResultMessageCryptoConnection({
      agent_id: publication.agentId,
      runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision,
      transition_kind: publication.transitionKind,
      operation_id: publication.operationId,
      signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
    });
    const historical = (context: Parameters<Parameters<
      typeof inspectStagedTaskRunResultMessagePublication
    >[0]["resolveHistoricalAgentSignerAuthority"]>[0]) => ({ ...context,
      managerSigningPublicKey: value.managerPublicKey.slice() });
    let retained: { intent: NativeTaskRunResultMessageIntent; current: NativeTaskRunResultMessageCurrentAuthority } | undefined;
    await value.run(async ({ evidence, source, preparation }) => {
      const write = evidence.messageWrite!;
      if (evidence.result.terminalStatus !== "completed"
        && evidence.result.terminalStatus !== "errored") {
        throw new Error("Expected a raw revision-one terminal result");
      }
      connection.claim = {
        request_id: evidence.requestId, work_id: evidence.workId,
        work_kind: "task.deliver_result", purpose: "task.deliver_result",
        state: "running", format_version: 3,
        credential_subject_kind: "runtime", runtime_kind: "task",
        runtime_version: 1, claim_id: evidence.claimId,
        recipient_generation: evidence.recipientGeneration,
        recipient_key_id: evidence.recipientKeyId,
        idempotency_key: `task-output-read:${"a".repeat(64)}`,
        accepted_response_kind: "runtime",
        accepted_response_hash: evidence.authorizationDigest.slice(),
        accepted_response_bytes: value.authorizationBytes.slice(),
        expected_policy_revision: evidence.policyRevision,
        namespace_id: evidence.result.namespace.namespaceId,
        domain_id: evidence.result.namespace.domainId,
        expected_namespace_access_revision:
          evidence.result.namespace.expectedAccessRevision,
        expected_domain_epoch: evidence.resultDomain.domainKeyGeneration,
        live: true,
      };
      connection.namespaces = [
        { request_id: evidence.requestId,
          namespace_id: evidence.result.namespace.namespaceId, ordinal: 0,
          domain_id: evidence.result.namespace.domainId, operation_mask: 1,
          expected_access_revision:
            evidence.result.namespace.expectedAccessRevision,
          expected_policy_revision: evidence.policyRevision },
        { request_id: evidence.requestId,
          namespace_id: write.namespace.namespaceId, ordinal: 1,
          domain_id: write.namespace.domainId, operation_mask: 2,
          expected_access_revision: write.namespace.expectedAccessRevision,
          expected_policy_revision: evidence.policyRevision },
      ];
      connection.domains = [evidence.resultDomain, write.domain].map(
        (domain, ordinal) => ({ request_id: evidence.requestId,
          domain_id: domain.domainId, ordinal,
          expected_epoch: domain.domainKeyGeneration,
          expected_agent_authorization_revision: null,
          expected_authorization_revision: domain.authorizationRevision }));
      const intent: NativeTaskRunResultMessageIntent = {
        taskId: evidence.result.taskId, taskRunId: evidence.result.taskRunId,
        bindingId: evidence.invocation.bindingId,
        messageOperationId: evidence.invocation.operationId,
        sessionId: preparation.allocation.sessionId,
        messageId: preparation.allocation.messageId, revision: 0,
        objectId: preparation.allocation.objectId,
        roomId: evidence.invocation.roomId,
        namespaceId: write.namespace.namespaceId,
        domainId: write.namespace.domainId, mode: preparation.allocation.mode,
        acceptedPolicyRevision: preparation.allocation.acceptedPolicyRevision,
        publicationPolicyRevision:
          preparation.allocation.publicationPolicyRevision,
        signerAgentId: write.signerAgentId,
        payloadDigest: hex(source.payloadDigest), role: "assistant",
        createdAt: preparation.allocation.createdAt,
        requesterHumanId: evidence.requesterHumanId,
        requestId: evidence.requestId,
        resultTerminalStatus: evidence.result.terminalStatus,
        resultContentRevision: 1, resultObjectId: evidence.result.objectId,
        resultGenesisManifestHash: hex(evidence.result.genesisManifestHash),
        resultCryptoAccessRevision: evidence.result.cryptoAccessRevision,
        resultNamespaceId: evidence.result.namespace.namespaceId,
        resultDomainId: evidence.result.namespace.domainId,
        resultNamespaceAccessRevision:
          evidence.result.namespace.expectedAccessRevision,
      };
      const current: NativeTaskRunResultMessageCurrentAuthority = {
        taskId: intent.taskId, taskRunId: intent.taskRunId,
        bindingId: intent.bindingId,
        messageOperationId: intent.messageOperationId,
        sessionId: intent.sessionId, messageId: intent.messageId, revision: 0,
        objectId: intent.objectId, roomId: intent.roomId,
        namespaceId: intent.namespaceId, domainId: intent.domainId,
        mode: intent.mode,
        acceptedPolicyRevision: intent.acceptedPolicyRevision,
        currentPolicyRevision: intent.publicationPolicyRevision,
        namespaceAccessRevision: write.namespace.expectedAccessRevision,
        requesterHumanId: intent.requesterHumanId,
        resultTerminalStatus: intent.resultTerminalStatus,
        resultContentRevision: 1, resultObjectId: intent.resultObjectId,
        resultGenesisManifestHash: intent.resultGenesisManifestHash,
        resultCryptoAccessRevision: intent.resultCryptoAccessRevision,
        resultNamespaceId: intent.resultNamespaceId,
        resultDomainId: intent.resultDomainId,
        resultNamespaceAccessRevision: intent.resultNamespaceAccessRevision,
      };
      retained = { intent, current };
      const stage = () => stageNativeTaskRunResultMessagePublication({
        restricted: connection as unknown as PostgresJsBridgeConnection,
        preparation, resolveHistoricalAgentSignerAuthority: historical,
        assertCurrentClaim: () => undefined,
        resolveCurrentDeliveryAuthority: () => Promise.resolve(current),
      });
      expect(await failure(stageNativeTaskRunResultMessagePublication({
        restricted: connection as unknown as PostgresJsBridgeConnection,
        preparation, resolveHistoricalAgentSignerAuthority: historical,
        assertCurrentClaim: () => undefined,
        resolveCurrentDeliveryAuthority: () => Promise.resolve({ ...current,
          resultDomainId: "fresh-substituted-source-domain",
          resultNamespaceAccessRevision: current.resultNamespaceAccessRevision + 1 }),
      }))).toBeInstanceOf(Error);
      expect(connection.state.object).toBeNull();
      expect(await stage()).toBe("staged");
      const checksAfterFirst = value.checks.length;
      expect(await stage()).toBe("already_staged");
      expect(value.checks).toHaveLength(checksAfterFirst);
      const retainedReceipt = connection.state.receipt!;
      connection.state = { ...connection.state, receipt: {
        ...retainedReceipt,
        recipient_generation: evidence.recipientGeneration + 1,
      } };
      expect((await failure(stage())).message)
        .toBe("Task result Message stage belongs to another claim");
      connection.state = { ...connection.state, receipt: retainedReceipt };
      const handle = await verifyCryptoPostgresHandle(connection);
      const recoveredIntent = await readStagedTaskRunResultMessageIntent(handle, {
        requestId: evidence.requestId, objectId: intent.objectId,
      });
      expect(recoveredIntent).toEqual(intent);
      expect(Object.isFrozen(recoveredIntent)).toBe(true);
      const claimBeforePrune = connection.claim;
      connection.claim = null;
      expect(await readStagedTaskRunResultMessageIntent(handle, {
        requestId: evidence.requestId, objectId: intent.objectId,
      })).toEqual(intent);
      connection.claim = claimBeforePrune;
      const advanced = { ...current,
        resultDomainId: "current-rotated-source-domain",
        resultNamespaceAccessRevision: current.resultNamespaceAccessRevision + 1,
        currentPolicyRevision: current.currentPolicyRevision + 1 };
      const staged = await inspectStagedTaskRunResultMessagePublication({
        handle, crypto: value.crypto, intent, currentAuthority: advanced,
        resolveHistoricalAgentSignerAuthority: historical,
      });
      const retainedWithIntent = connection.state.receipt!;
      for (const invalid of [
        { ...intent, resultDomainId: "forged-historical-domain" },
        { ...intent, resultNamespaceAccessRevision: intent.resultNamespaceAccessRevision + 1 },
        { ...intent, arbitraryPlaintext: "must never be retained" },
        { ...intent, requestId: "substituted" },
        { ...intent, revision: 1 },
      ]) {
        connection.state = { ...connection.state, receipt: {
          ...retainedWithIntent, raw_result_message_intent: invalid,
        } as unknown as DatabaseRow };
        expect(await failure(readStagedTaskRunResultMessageIntent(handle, {
          requestId: evidence.requestId, objectId: intent.objectId,
        }))).toBeInstanceOf(Error);
      }
      connection.state = { ...connection.state, receipt: { ...retainedWithIntent, raw_result_message_intent: null } };
      expect(await readStagedTaskRunResultMessageIntent(handle, {
        requestId: evidence.requestId, objectId: intent.objectId,
      })).toBeNull();
      connection.state = { ...connection.state, receipt: retainedWithIntent };
      expect(staged).not.toBeNull();
      expect(staged?.intent.resultObjectId).toBe(evidence.result.objectId);
      expect(staged?.intent.resultGenesisManifestHash)
        .toBe(hex(evidence.result.genesisManifestHash));
      expect(() => assertVerifiedStagedTaskRunResultMessagePublication(
        staged!, advanced)).not.toThrow();
      expect(() => assertVerifiedStagedTaskRunResultMessagePublication(
        { ...staged! }, advanced)).toThrow();
      const firstDigestByte = staged!.authorizationDigest[0]!;
      staged!.authorizationDigest[0] = firstDigestByte ^ 0xff;
      expect(() => assertVerifiedStagedTaskRunResultMessagePublication(
        staged!, advanced)).toThrow();
      staged!.authorizationDigest[0] = firstDigestByte;
      expect(() => assertVerifiedStagedTaskRunResultMessagePublication(
        staged!, { ...advanced, resultObjectId: "substituted" })).toThrow();
      expect(await failure(inspectStagedTaskRunResultMessagePublication({ handle,
        crypto: value.crypto,
        intent: { ...intent, resultTerminalStatus: "errored" },
        currentAuthority: { ...advanced, resultTerminalStatus: "errored" },
        resolveHistoricalAgentSignerAuthority: historical,
      }))).toBeInstanceOf(Error);
    });
    // The original grant callback is gone. Recovery uses its durable receipt and
    // independently verifies the repaired source chain without another read loan.
    if (retained === undefined) throw new Error("Expected staged result");
    const retainedIntent = retained.intent;
    value.rewrapSource();
    connection.sourceObjectId = value.sourceObjectId;
    connection.sourceQuery = value.sourceQuery;
    const handle = await verifyCryptoPostgresHandle(connection);
    const repaired = { ...retained.current, resultCryptoAccessRevision: 1 };
    const inspect = (currentAuthority: NativeTaskRunResultMessageCurrentAuthority) => inspectStagedTaskRunResultMessagePublication({
      handle, crypto: value.crypto, intent: retainedIntent, currentAuthority,
      resolveHistoricalAgentSignerAuthority: historical,
    });
    const recovered = await inspect(repaired);
    expect(recovered).not.toBeNull();
    expect(recovered?.intent.resultCryptoAccessRevision).toBe(mappedAccess);
    expect(() => assertVerifiedStagedTaskRunResultMessagePublication(recovered!, repaired)).not.toThrow();
    for (const changed of [{ ...repaired, resultCryptoAccessRevision: 2 },
      { ...repaired, resultGenesisManifestHash: "ab".repeat(32) },
      { ...repaired, resultNamespaceId: "substituted" }]) {
      expect(await failure(inspect(changed))).toBeInstanceOf(Error);
    }
    expect(connection.state.object).not.toBeNull();
    expect(connection.state.receipt).not.toBeNull();
    expect(connection.claimReads).toBeGreaterThan(2);
    expect(connection.locks.slice(0, 2)).toEqual([
      value.evidenceInput.requestId, value.allocation.objectId,
    ]);
  });

  test("rejects partition substitution and rolls back ciphertext when the receipt fails", async () => {
    const value = await fixture();
    const publication = value.signerPublication;
    const connection = new ResultMessageCryptoConnection({
      agent_id: publication.agentId,
      runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision,
      transition_kind: publication.transitionKind,
      operation_id: publication.operationId,
      signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
    });
    await value.run(async ({ evidence, preparation }) => {
      const write = evidence.messageWrite!;
      connection.claim = { request_id: evidence.requestId,
        work_id: evidence.workId, work_kind: "task.deliver_result",
        purpose: "task.deliver_result", state: "running", format_version: 3,
        credential_subject_kind: "runtime", runtime_kind: "task",
        runtime_version: 1, claim_id: evidence.claimId,
        recipient_generation: evidence.recipientGeneration,
        recipient_key_id: evidence.recipientKeyId,
        idempotency_key: `task-output-read:${"b".repeat(64)}`,
        accepted_response_kind: "runtime",
        accepted_response_hash: evidence.authorizationDigest.slice(),
        accepted_response_bytes: value.authorizationBytes.slice(),
        expected_policy_revision: evidence.policyRevision,
        namespace_id: evidence.result.namespace.namespaceId,
        domain_id: evidence.result.namespace.domainId,
        expected_namespace_access_revision:
          evidence.result.namespace.expectedAccessRevision,
        expected_domain_epoch: evidence.resultDomain.domainKeyGeneration,
        live: true };
      connection.namespaces = [{ request_id: evidence.requestId,
        namespace_id: write.namespace.namespaceId, ordinal: 0,
        domain_id: write.namespace.domainId, operation_mask: 2,
        expected_access_revision: write.namespace.expectedAccessRevision,
        expected_policy_revision: evidence.policyRevision }];
      connection.domains = [{ request_id: evidence.requestId,
        domain_id: write.domain.domainId, ordinal: 0,
        expected_epoch: write.domain.domainKeyGeneration,
        expected_agent_authorization_revision: null,
        expected_authorization_revision: write.domain.authorizationRevision }];
      const current = {
        taskId: TASK, taskRunId: RUN,
        bindingId: evidence.invocation.bindingId,
        messageOperationId: evidence.invocation.operationId,
        sessionId: SESSION, messageId: 23, revision: 0 as const,
        objectId: value.allocation.objectId, roomId: ROOM,
        namespaceId: write.namespace.namespaceId,
        domainId: write.namespace.domainId, mode: "encrypted_only" as const,
        acceptedPolicyRevision: 6, currentPolicyRevision: 7,
        namespaceAccessRevision: 0, requesterHumanId: HUMAN,
        resultTerminalStatus: "completed" as const,
        resultContentRevision: 1 as const,
        resultObjectId: evidence.result.objectId,
        resultGenesisManifestHash: hex(evidence.result.genesisManifestHash),
        resultCryptoAccessRevision: 0 as const,
        resultNamespaceId: PRIVATE_NS, resultDomainId: PRIVATE_DOMAIN,
        resultNamespaceAccessRevision: 0,
      };
      expect((await failure(stageNativeTaskRunResultMessagePublication({
        restricted: connection as unknown as PostgresJsBridgeConnection,
        preparation, resolveHistoricalAgentSignerAuthority: context => ({
          ...context, managerSigningPublicKey: value.managerPublicKey.slice(),
        }), assertCurrentClaim: () => undefined,
        resolveCurrentDeliveryAuthority: () => Promise.resolve(current),
      })))).toHaveProperty("message", "Task result Message staging claim is not current");
      expect(connection.state).toEqual(emptyState());

      connection.namespaces = [
        { request_id: evidence.requestId,
          namespace_id: evidence.result.namespace.namespaceId, ordinal: 0,
          domain_id: evidence.result.namespace.domainId, operation_mask: 1,
          expected_access_revision: 0,
          expected_policy_revision: evidence.policyRevision },
        { request_id: evidence.requestId,
          namespace_id: write.namespace.namespaceId, ordinal: 1,
          domain_id: write.namespace.domainId, operation_mask: 2,
          expected_access_revision: 0,
          expected_policy_revision: evidence.policyRevision },
      ];
      connection.domains = [evidence.resultDomain, write.domain].map(
        (domain, ordinal) => ({ request_id: evidence.requestId,
          domain_id: domain.domainId, ordinal,
          expected_epoch: domain.domainKeyGeneration,
          expected_agent_authorization_revision: null,
          expected_authorization_revision: domain.authorizationRevision }));
      connection.state = { ...emptyState(), object: {
        object_id: value.allocation.objectId,
        payload_hash: new Uint8Array(32), payload_bytes: new Uint8Array(1),
      } };
      expect((await failure(stageNativeTaskRunResultMessagePublication({
        restricted: connection as unknown as PostgresJsBridgeConnection,
        preparation, resolveHistoricalAgentSignerAuthority: context => ({
          ...context, managerSigningPublicKey: value.managerPublicKey.slice(),
        }), assertCurrentClaim: () => undefined,
        resolveCurrentDeliveryAuthority: () => Promise.resolve(current),
      }))).message).toBe(
        "Task result Message ciphertext has no staging receipt");
      connection.state = emptyState();
      connection.failReceipt = true;
      expect((await failure(stageNativeTaskRunResultMessagePublication({
        restricted: connection as unknown as PostgresJsBridgeConnection,
        preparation, resolveHistoricalAgentSignerAuthority: context => ({
          ...context, managerSigningPublicKey: value.managerPublicKey.slice(),
        }), assertCurrentClaim: () => undefined,
        resolveCurrentDeliveryAuthority: () => Promise.resolve(current),
      })))).toHaveProperty("message", "receipt write failed");
      expect(connection.state).toEqual(emptyState());
    });
  });
});
