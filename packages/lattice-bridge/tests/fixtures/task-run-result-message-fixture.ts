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
  type TaskRuntimeRunResultReadEvidence,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
  DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import { createAgentObjectAccessManifestV5 } from
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
  prepareNativeTaskRunResultMessage,
  type NativeTaskRunResultMessageAuthority,
  type PreparedNativeTaskRunResultMessage,
  type PrepareNativeTaskRunResultMessageInput,
} from "../../src/server/task/native-task-run-result-message-preparation.ts";

export const NOW = 1_940_000_000_000;
export const TASK = "10000000-0000-4000-8000-000000000741";
export const RUN = "20000000-0000-4000-8000-000000000741";
const HUMAN = "30000000-0000-4000-8000-000000000741";
const PRIVATE_NS = "private-result-namespace";
const PRIVATE_DOMAIN = "private-result-domain";
export const DEST_NS = "destination-message-namespace";
export const DEST_DOMAIN = "destination-message-domain";
export const ROOM = "40000000-0000-4000-8000-000000000741";
export const SESSION = "50000000-0000-4000-8000-000000000741";
const AGENT = "task-result-message-agent";
const SERVER = "https://nautilo.example";
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

export async function taskRunResultMessageFixture() {
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
    contentRevision: 1 as const, cryptoAccessRevision: 0 as const,
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
  const evidenceInput: TaskRuntimeRunResultReadEvidenceInputV1 = {
    purpose: "task.runtime.run_result_read", workKind: "task.deliver_result",
    requestId: `task-run-delivery-result-authorization:${RUN}`, workId: RUN,
    claimId: "task-result-message-read-claim", claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 50_000,
    authorizationExpiresAt: NOW + 40_000, expiresAt: NOW + 40_000,
    recipientGeneration: 2, recipientKeyId: "task-result-message-recipient",
    authorizationDigest: bytes(0x71), requesterHumanId: HUMAN,
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
  const messageWrite = evidenceInput.messageWrite;
  if (messageWrite === null) {
    throw new Error("Task result Message write fixture is absent");
  }
  const manifestRow = { object_id: result.objectId, access_revision: 0,
    manifest_hash: resultManifest.hash, previous_manifest_hash: null,
    payload_hash: crypto.hash(resultPayloadBytes),
    manifest_bytes: resultManifest.bytes };
  const restricted: PostgresJsBridgeConnection = {
    query: <Row extends PostgresJsBridgeRow>(statement: string) => {
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
        rows = [manifestRow];
      } else if (statement.includes('from "object_crypto_namespace_envelopes"')) {
        rows = [{ namespace_id: PRIVATE_NS,
          envelope_hash: crypto.hash(resultEnvelopeBytes),
          envelope_bytes: resultEnvelopeBytes }];
      } else if (statement.includes('from "object_crypto_access_manifests"')) {
        rows = [manifestRow];
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
      return Promise.resolve(rows as readonly Row[]);
    },
    transaction: async use => use(restricted),
    transactionOnce: async use => use(restricted),
  };
  const privateDomain = {
    ...privateNamespace.publicDomain, domainKey: privateDomainKey,
  };
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
  const open = <Value>(
    evidence: TaskRuntimeRunResultReadEvidence,
    operation: (input: Readonly<{
    evidence: TaskRuntimeRunResultReadEvidence;
    source: Parameters<typeof prepareNativeTaskRunResultMessage>[0]["source"];
    prepare(overrides?: Partial<PrepareNativeTaskRunResultMessageInput>):
      Promise<PreparedNativeTaskRunResultMessage>;
  }>) => Value | PromiseLike<Value>,
  ) => withNativeProtectedTaskRunResultMessageSourceV1({
        restricted, crypto, serverScope: SERVER, evidence,
        domains: [privateDomain], signal: controller.signal,
        loadCurrentResult: () => Promise.resolve(occurrence),
        resolveHistoricalAgentSignerAuthority: context => ({ ...context,
          managerSigningPublicKey: manager.publicKey }),
        execute: source => operation({ evidence, source,
          prepare: (overrides = {}) => prepareNativeTaskRunResultMessage({
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
            ...overrides,
          }),
        }),
      }).then(opened => {
        if (opened.status !== "available") {
          throw new Error("Task result Message source was unavailable");
        }
        return opened.value;
      });
  const run = <Value>(operation: (input: Readonly<{
    evidence: TaskRuntimeRunResultReadEvidence;
    source: Parameters<typeof prepareNativeTaskRunResultMessage>[0]["source"];
    prepare(overrides?: Partial<PrepareNativeTaskRunResultMessageInput>):
      Promise<PreparedNativeTaskRunResultMessage>;
  }>) => Value | PromiseLike<Value>) =>
    withTaskRuntimeRunResultReadEvidenceV1({ evidence: evidenceInput,
      signal: controller.signal, now: () => now,
      execute: evidence => open(evidence, operation),
    });
  return { crypto, run, allocation, checks, destinationGenerationKey,
    destinationSource, open, issuer,
    domains: [privateDomain, {
      ...destinationNamespace.publicDomain,
      domainKey: destinationDomainKey,
    }] as const,
    namespaceRequirements: [
      { ordinal: 0, ...messageWrite.namespace },
      { ordinal: 1, ...result.namespace },
    ] as const,
    foregroundNamespaceRequirements: [{
      ordinal: 0,
      ...messageWrite.namespace,
    }] as const,
    invocation, controller, evidenceInput,
    expire: () => { now = NOW + 60_000; } };
}
