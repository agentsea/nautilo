import {
  and, eq, jobs, protectedTaskRunOutputBindings, rooms, sessions, tasks, taskRuns,
  sessionMessageCryptoRevisions, protectedTaskRunWakeJobId, protectedTaskRunWakeOperationId,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  agentId, agentRuntimeGeneration, authorizationRevision,
  assertAuthenticTaskRuntimeWakeForegroundEvidence,
  assertTaskRuntimeTemporarySignerForPreparation,
  hasTaskRuntimeTemporarySigner,
  verifyHistoricalAgentRuntimeSignerPublication,
  withTaskRuntimeTemporarySigner,
  type ResolveHistoricalAgentRuntimeSignerPublicationManager,
  type ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization,
  type ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization,
  type TaskRuntimeWakeForegroundEvidence,
} from "@nautilo/lattice-crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type {
  ConversationAppendInput, TaskWakeLiveShadowPublicationAuthority,
} from "../../message/conversation-repository.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from "../../message/conversation-repository.ts";
import { withCurrentAcceptedTaskOutputRuntimeClaimAuthority } from "../task/current-task-runtime-authority.ts";
import { withTaskOutputProductAuthorityContext } from "../task/initial-task-runtime-namespace-authority.ts";
import {
  PostgresDomainKeyAuthorityRepository,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "../delivery/postgres-domain-key-authority.ts";
import { PostgresLatticeStorage, verifyCryptoPostgresHandle } from "../storage/postgres-lattice-storage.ts";
import {
  bindConversationProductCanonicalTransactionRunner, PostgresConversationProductStore,
  verifyConversationProductPostgresHandle,
} from "./postgres-conversation-product-store.ts";

type WakeScope = Readonly<{
  transaction: CanonicalTranscriptTx;
  evidence: TaskRuntimeWakeForegroundEvidence;
  roomId: string;
  namespaceId: string;
  representation: "ordinary_and_protected" | "protected_only";
}>;
const scopes = new WeakMap<object, WakeScope>();

/** Internal product-store check. A copied or escaped token never grants a write. */
export function assertTaskWakeLiveShadowPublicationAuthority(
  authority: TaskWakeLiveShadowPublicationAuthority | undefined,
  expected: Readonly<{
    transaction: CanonicalTranscriptTx; operationId: string; sessionId: string;
    namespaceId?: string;
    publicationPolicy?: ConversationAppendInput["publicationPolicy"];
  }>,
): WakeScope {
  const scope = authority === undefined ? undefined : scopes.get(authority);
  if (scope === undefined) throw new TypeError("Task wake publication authority is not active");
  assertAuthenticTaskRuntimeWakeForegroundEvidence(scope.evidence);
  if (scope.transaction !== expected.transaction
    || scope.evidence.invocation.operationId !== expected.operationId
    || scope.evidence.invocation.sessionId !== expected.sessionId
    || expected.namespaceId !== undefined && expected.namespaceId !== scope.namespaceId
    || "publicationPolicy" in expected && (expected.publicationPolicy === undefined || (
      expected.publicationPolicy.expectedRevision !== scope.evidence.policyRevision
      || expected.publicationPolicy.representation !== scope.representation))) {
    throw new TypeError("Task wake publication authority does not match the coordinate");
  }
  return scope;
}

export type TaskWakeLiveShadowRuntimeSigner = Readonly<{
  agentAuthorizationRevision: number;
  runtimeGeneration: number;
  signerKeyId: string;
  signerPublicKey: Uint8Array;
  signerAuthorizationHash?: Uint8Array;
}>;
export type TaskWakeLiveShadowCurrentWriter = Readonly<{
  /** Recheck the exact parent through the callback-live borrowed transaction. */
  assertCurrent(): Promise<void>;
  productStore: PostgresConversationProductStore;
  product: PostgresJsBridgeConnection;
  restricted: PostgresJsBridgeConnection;
  transaction: CanonicalTranscriptTx;
  resolveCurrentAgentObjectWrite: ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization;
  resolveCurrentForegroundEntityObjectWrite: ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
}>;
export type PostgresTaskWakeLiveShadowAuthorityInput<Value> = Omit<
  Parameters<typeof withCurrentAcceptedTaskOutputRuntimeClaimAuthority<Value>>[0], "use"
> & Readonly<{
  evidence: TaskRuntimeWakeForegroundEvidence;
  signer: TaskWakeLiveShadowRuntimeSigner;
  resolveHistoricalSignerPublicationManager: ResolveHistoricalAgentRuntimeSignerPublicationManager;
  use(authority: TaskWakeLiveShadowCurrentWriter): Promise<Value>;
}>;

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function exactReference(actual: Record<string, unknown> | null,
  expected: TaskRuntimeWakeForegroundEvidence["invocation"]["reference"]): boolean {
  return actual !== null && Object.keys(actual).length === 6
    && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/** Current product proof is already held; Session ownership is independent of Task ownership. */
async function lockWakeParent(transaction: CanonicalTranscriptTx,
  evidence: TaskRuntimeWakeForegroundEvidence, requesterUserId: string,
): Promise<Readonly<{ namespaceId: string; representation: WakeScope["representation"] }> | null> {
  const invocation = evidence.invocation;
  const [row] = await transaction.select({
    job: jobs, binding: protectedTaskRunOutputBindings,
    taskId: tasks.id, taskOwnerId: tasks.ownerId, taskRequestorId: tasks.requestorId,
    agentId: tasks.agentId, representation: tasks.contentRepresentation,
    roomNamespaceId: rooms.namespaceId, roomArchivedAt: rooms.archivedAt,
    roomOwnerId: rooms.ownerId, sessionOwnerId: sessions.ownerId,
    sessionAgentId: sessions.agentId, sessionRoomId: sessions.roomId,
  }).from(jobs).innerJoin(protectedTaskRunOutputBindings,
    eq(protectedTaskRunOutputBindings.wakeJobId, jobs.id))
    .innerJoin(taskRuns, eq(taskRuns.id, protectedTaskRunOutputBindings.taskRunId))
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .innerJoin(rooms, eq(rooms.id, protectedTaskRunOutputBindings.destinationRoomId))
    .innerJoin(sessions, eq(sessions.id, invocation.sessionId))
    .where(and(eq(jobs.id, invocation.jobId), eq(protectedTaskRunOutputBindings.taskRunId, invocation.reference.taskRunId)))
    .for("share", { of: jobs }).limit(2);
  if (row === undefined || row.job.status !== "running" || row.job.startedAt === null
    || row.job.completedAt !== null || row.job.result !== null || row.job.message !== null
    || Object.keys(row.job.metadata).length !== 0
    || row.job.ownerId !== row.taskOwnerId || row.job.requestorId !== requesterUserId
    || row.taskRequestorId !== requesterUserId || row.agentId !== evidence.signerAgentId
    || row.job.roomId !== invocation.roomId || row.job.laneKey !== `room:${invocation.roomId}`
    || row.job.type !== "foreground" || !exactReference(row.job.input, invocation.reference)
    || row.taskId !== invocation.reference.taskId || row.binding.bindingId !== invocation.bindingId
    || row.binding.resultObjectId !== invocation.reference.resultObjectId
    || row.binding.wakeOperationId !== invocation.operationId
    || row.binding.wakeOperationId !== protectedTaskRunWakeOperationId(row.binding.taskRunId)
    || row.job.id !== protectedTaskRunWakeJobId(row.binding.taskRunId)
    || row.binding.wakeScheduledAt?.getTime() !== row.job.createdAt.getTime()
    || row.binding.completedAt?.getTime() !== row.job.createdAt.getTime()
    || row.binding.resultAttachedAt === null || row.binding.acceptedPolicyRevision > evidence.policyRevision
    || row.binding.destinationRoomId !== invocation.roomId || row.roomArchivedAt !== null
    || row.binding.destinationNamespaceId !== row.roomNamespaceId
    || row.sessionRoomId !== invocation.roomId || row.sessionOwnerId !== row.roomOwnerId
    || row.sessionAgentId !== evidence.signerAgentId
    || (row.representation !== "protected" && row.representation !== "dual")) return null;
  return { namespaceId: row.roomNamespaceId,
    representation: row.representation === "protected" ? "protected_only" : "ordinary_and_protected" };
}

/** Each caller lends one mutation/completion, never a model turn, to the held current owner. */
export async function withPostgresTaskWakeLiveShadowAuthority<Value>(
  input: PostgresTaskWakeLiveShadowAuthorityInput<Value>,
): Promise<Value | null> {
  const evidence = input.evidence;
  assertAuthenticTaskRuntimeWakeForegroundEvidence(evidence);
  if (input.accepted.workKind !== "task.delivery_wake" || input.accepted.workPurpose !== "task.delivery_wake"
    || input.accepted.requestId !== evidence.requestId || input.accepted.workId !== evidence.workId
    || input.accepted.recipientGeneration !== evidence.recipientGeneration
    || input.accepted.recipientKeyId !== evidence.recipientKeyId
    || input.accepted.authorizationDigest !== bytesToHex(evidence.authorizationDigest)
    || input.subject.humanActorId !== evidence.requesterHumanId
    || input.subject.deviceId !== evidence.committerDeviceId) return null;
  const signer = {
    ...input.signer,
    signerPublicKey: Uint8Array.from(input.signer.signerPublicKey),
    ...(input.signer.signerAuthorizationHash === undefined ? {} : {
      signerAuthorizationHash:
        Uint8Array.from(input.signer.signerAuthorizationHash),
    }),
  };
  return withTaskOutputProductAuthorityContext(input.productAuthority, context => {
    if (context.input.workKind !== "task.delivery_wake"
      || context.input.taskId !== evidence.invocation.reference.taskId
      || context.input.taskRunId !== evidence.invocation.reference.taskRunId
      || context.input.agentId !== evidence.signerAgentId
      || context.input.destinationRoomId !== evidence.invocation.roomId
      || context.input.episodeId !== evidence.invocation.sessionId
      || context.input.foregroundNamespaceIds.length !== evidence.namespaceRequirements.length
      || context.input.foregroundNamespaceIds.some(id => !evidence.namespaceRequirements.some(n => n.namespaceId === id))) return Promise.resolve(null);
    const extra = evidence.additionalMutationDestination;
    const expectedExtra = context.input.additionalMutationDestination;
    if ((extra === undefined) !== (expectedExtra === undefined)
      || extra !== undefined && (expectedExtra === undefined
        || extra.roomId !== expectedExtra.roomId || extra.namespace.namespaceId !== expectedExtra.namespaceId
        || extra.semanticDigest !== expectedExtra.semanticDigest)) return Promise.resolve(null);
    const requirements = [...evidence.namespaceRequirements,
      ...(extra === undefined ? [] : [extra.namespace])];
    return withCurrentAcceptedTaskOutputRuntimeClaimAuthority({ ...input,
      use: async (current, product, restricted, transaction) => {
        assertAuthenticTaskRuntimeWakeForegroundEvidence(evidence);
        if (current.policyRevision !== evidence.policyRevision
          || current.device.deviceId !== evidence.committerDeviceId
          || current.device.deviceGeneration !== evidence.committerDeviceSigningGeneration
          || !equal(input.crypto.hash(current.device.signingPublicKey), evidence.committerDeviceSigningPublicKeyHash)
          || current.plan.hostAuthorizationRevision !== evidence.hostAuthorizationRevision
          || current.plan.recipientAuthorizationRevision !== evidence.recipientAuthorizationRevision
          || requirements.some(expected => !current.namespaceRequirements.some(actual =>
            actual.namespaceId === expected.namespaceId && actual.domainId === expected.domainId
            && actual.expectedAccessRevision === expected.expectedAccessRevision
            && actual.expectedPolicyRevision === expected.expectedPolicyRevision
            && actual.operations.length === expected.operations.length
            && actual.operations.every((operation, index) => operation === expected.operations[index])))
          || evidence.domainRequirements.some(expected => !current.domains.some(actual =>
            actual.domainId === expected.domainId && actual.sourceNamespaceId === expected.sourceNamespaceId
            && actual.domainKeyGeneration === expected.domainKeyGeneration && actual.authorizationRevision === expected.authorizationRevision
            && actual.participantCount === expected.participantCount && actual.activeNamespaceBindingCount === expected.activeNamespaceBindingCount
            && equal(actual.participantDigest, expected.participantDigest) && equal(actual.headDigest, expected.headDigest)
            && equal(actual.activeNamespaceBindingSetDigest, expected.activeNamespaceBindingSetDigest)))) return null;
        const parent = await lockWakeParent(transaction, evidence, input.subject.userId);
        if (parent === null || !evidence.namespaceRequirements.some(n => n.namespaceId === parent.namespaceId)) return null;
        const cryptoHandle = await verifyCryptoPostgresHandle(restricted);
        const storage = new PostgresLatticeStorage(cryptoHandle);
        const namespaceOwner = new PostgresDomainKeyAuthorityRepository(restricted, input.crypto, input.serverScope);
        const hasTemporarySigner = hasTaskRuntimeTemporarySigner(evidence);
        const expectsTemporarySigner = signer.signerAuthorizationHash !== undefined;
        if (hasTemporarySigner !== expectsTemporarySigner) return null;
        let runtime: Awaited<ReturnType<
          typeof storage.getAgentRuntimeAtomicState
        >> = null;
        if (expectsTemporarySigner) {
          if (signer.agentAuthorizationRevision !== 0
            || signer.runtimeGeneration !== 0) return null;
          let temporaryMatches = false;
          try {
            temporaryMatches = await withTaskRuntimeTemporarySigner(
              evidence,
              temporarySigner => {
                const verified = assertTaskRuntimeTemporarySignerForPreparation(
                  input.crypto,
                  evidence,
                  temporarySigner.runtime,
                  temporarySigner,
                );
                try {
                  return verified.signerKeyId === signer.signerKeyId
                    && equal(temporarySigner.signerPublicKey, signer.signerPublicKey)
                    && equal(verified.certificateHash, signer.signerAuthorizationHash!)
                    && temporarySigner.issuer.humanId === input.accepted.issuingHumanId
                    && temporarySigner.issuer.deviceId === input.accepted.issuingDeviceId
                    && temporarySigner.issuer.deviceGeneration
                      === evidence.committerDeviceSigningGeneration
                    && temporarySigner.issuer.securityRevision
                      === input.accepted.issuingDeviceAuthorizationRevision
                    && temporarySigner.issuer.securityRevision
                      === evidence.hostAuthorizationRevision
                    && equal(
                      temporarySigner.issuer.signingPublicKeyHash,
                      input.accepted.issuerSigningPublicKeyHash,
                    )
                    && equal(
                      temporarySigner.issuer.signingPublicKeyHash,
                      evidence.committerDeviceSigningPublicKeyHash,
                    );
                } finally {
                  verified.certificateHash.fill(0);
                }
              },
            );
          } catch {
            temporaryMatches = false;
          }
          if (!temporaryMatches) return null;
        } else {
          runtime = await storage.getAgentRuntimeAtomicState(evidence.signerAgentId);
          const publication = await storage.getAgentRuntimeSignerPublication(
            evidence.signerAgentId,
            signer.runtimeGeneration,
          );
          if (runtime === null || publication === null
            || runtime.runtime.agentId !== evidence.signerAgentId || publication.agentId !== evidence.signerAgentId
            || runtime.runtime.authorizationRevision !== signer.agentAuthorizationRevision
            || runtime.runtime.runtimeGeneration !== signer.runtimeGeneration
            || publication.authorizationRevision !== signer.agentAuthorizationRevision
            || publication.runtimeGeneration !== signer.runtimeGeneration
            || publication.signerKeyId !== signer.signerKeyId || !equal(publication.signerPublicKey, signer.signerPublicKey)
            || !verifyHistoricalAgentRuntimeSignerPublication({ crypto: input.crypto, publication,
              resolveHistoricalManagerAuthority: input.resolveHistoricalSignerPublicationManager })) return null;
        }
        const namespaces = new Map<string, DomainForegroundNamespaceAuthorityInspectionV2>();
        for (const expected of requirements) {
          const inspected = await namespaceOwner.inspectForegroundNamespaceAuthority({ namespaceId: expected.namespaceId, keyClass: "ai" });
          const domain = evidence.domainRequirements.find(d => d.domainId === expected.domainId);
          if (inspected.status !== "ready" || domain === undefined
            || inspected.namespaceAccessRevision !== expected.expectedAccessRevision
            || inspected.domainId !== expected.domainId || inspected.domainKeyGeneration !== domain.domainKeyGeneration
            || inspected.domainAuthorizationRevision !== domain.authorizationRevision || !equal(inspected.domainHeadDigest, domain.headDigest)
            || runtime !== null && !runtime.domainEnvelopes.some(e => e.agentId === evidence.signerAgentId && e.domainId === domain.domainId && e.domainEpoch === domain.domainKeyGeneration
              && e.agentAuthorizationRevision === signer.agentAuthorizationRevision && e.runtimeGeneration === signer.runtimeGeneration)) return null;
          namespaces.set(expected.namespaceId, inspected);
        }
        const token = Object.freeze({}) as TaskWakeLiveShadowPublicationAuthority;
        const scope: WakeScope = { transaction, evidence, roomId: evidence.invocation.roomId, ...parent };
        scopes.set(token, scope);
        const assertActive = () => {
          assertTaskWakeLiveShadowPublicationAuthority(token, { transaction,
            operationId: evidence.invocation.operationId, sessionId: evidence.invocation.sessionId });
          input.signal?.throwIfAborted();
        };
        try {
          const handle = await verifyConversationProductPostgresHandle(product);
          const runner = bindConversationProductCanonicalTransactionRunner(handle, {
            transaction: async callback => { assertActive(); const result = await callback(transaction, product); assertActive(); return result; },
          });
          const store = new PostgresConversationProductStore(handle, runner, undefined, token);
          // The three public inputs remain compatible; only this scoped adapter lends the wake parent.
          const reserve = store.reserveLiveShadowAgent.bind(store);
          store.reserveLiveShadowAgent = value => reserve({ ...value, taskWakeAuthority: token });
          const publish = store.publishReservedLiveShadowAgent.bind(store);
          store.publishReservedLiveShadowAgent = value => publish({ ...value, taskWakeAuthority: token });
          const record = store.recordLiveShadowAgentEvidence.bind(store);
          store.recordLiveShadowAgentEvidence = value => record({ ...value, taskWakeAuthority: token });
          const signerMatches = (value: { agentId: string; agentAuthorizationRevision: number;
            runtimeGeneration: number; signerKeyId: string; signerAuthorizationHash?: Uint8Array }) =>
            value.agentId === evidence.signerAgentId && value.agentAuthorizationRevision === signer.agentAuthorizationRevision
            && value.runtimeGeneration === signer.runtimeGeneration && value.signerKeyId === signer.signerKeyId
            && (signer.signerAuthorizationHash === undefined
              ? value.signerAuthorizationHash === undefined
              : value.signerAuthorizationHash !== undefined
                && equal(value.signerAuthorizationHash, signer.signerAuthorizationHash));
          const authorization = { grantAuthorized: true as const, agentAuthorized: true as const, hostAllowsOperation: true as const,
            currentRuntime: { agentId: agentId(evidence.signerAgentId), authorizationRevision: authorizationRevision(signer.agentAuthorizationRevision),
              runtimeGeneration: agentRuntimeGeneration(signer.runtimeGeneration) }, signerPublicKey: signer.signerPublicKey };
          const resolveCurrentAgentObjectWrite: ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization = async value => {
            assertActive();
            if (await lockWakeParent(transaction, evidence, input.subject.userId) === null) return null;
            assertActive();
            const namespace = namespaces.get(parent.namespaceId);
            if (namespace === undefined || value.operationId !== evidence.invocation.operationId
              || value.grantId !== evidence.requestId || !equal(value.grantHash, evidence.authorizationDigest)
              || value.recipientKeyId !== evidence.recipientKeyId || !signerMatches(value)
              || value.namespaceId !== namespace.namespaceId || value.namespaceAccessRevision !== namespace.namespaceAccessRevision
              || !equal(value.namespaceHeadDigest, namespace.namespaceHeadDigest)
              || !equal(value.namespacePublicationDigest, namespace.namespacePublicationDigest)
              || !equal(value.namespacePublicationSetDigest, namespace.namespacePublicationSetDigest)
              || !equal(value.namespaceAudienceFingerprint, namespace.namespaceAudienceFingerprint)
              || value.envelope.namespaceId !== namespace.namespaceId || value.envelope.keyClass !== "ai"
              || value.envelope.keyGeneration !== namespace.namespaceKeyGeneration
              || value.envelope.bindingRevisionAtWrap !== namespace.namespaceAccessRevision) return null;
            const [row] = await transaction.select().from(sessionMessageCryptoRevisions)
              .where(eq(sessionMessageCryptoRevisions.cryptoObjectId, value.objectId)).limit(2);
            assertActive();
            if (row === undefined || row.taskWakeOperationId !== evidence.invocation.operationId
              || row.sessionId !== evidence.invocation.sessionId || row.roomId !== evidence.invocation.roomId
              || row.namespaceIdAtAllocation !== parent.namespaceId || row.objectIdScheme !== "live_shadow_v1"
              || row.representationMode !== (parent.representation === "protected_only" ? "full_encryption" : "shadow_encryption")
              || row.publicationPolicyRevision !== (parent.representation === "protected_only" ? evidence.policyRevision : null)
              || row.shadowOperationId !== null || row.humanPeerShadowOperationId !== null
              || row.sharedAgentShadowOperationId !== null || row.sharedAgentShadowExecutionId !== null
              || row.editRevision !== 0 || row.shadowTranscriptOrdinal === null || row.shadowTranscriptOrdinal < 2
              || (row.authorRole !== "assistant" && row.authorRole !== "tool")
              || row.cryptoObjectId !== deriveLiveShadowMessageCryptoObjectIdV1({ operationId: evidence.invocation.operationId,
                sessionId: row.sessionId, messageId: row.messageId, revision: 0, transcriptOrdinal: row.shadowTranscriptOrdinal, authorRole: row.authorRole })) return null;
            return { context: value, namespaceAuthorized: true, ...authorization, signerPublicKey: Uint8Array.from(signer.signerPublicKey) };
          };
          const resolveCurrentForegroundEntityObjectWrite: ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization = async value => {
            assertActive();
            if (await lockWakeParent(transaction, evidence, input.subject.userId) === null) return null;
            assertActive();
            if (value.operationId !== evidence.invocation.operationId || value.grantId !== evidence.requestId
              || !equal(value.grantHash, evidence.authorizationDigest) || value.recipientKeyId !== evidence.recipientKeyId
              || !signerMatches(value) || value.namespaces.length === 0 || value.namespaces.length !== value.envelopes.length) return null;
            for (const [index, expected] of value.namespaces.entries()) {
              if (extra?.namespace.namespaceId === expected.namespaceId
                && (context.input.projectionDestination?.roomId !== extra.roomId
                  || context.input.projectionDestination.namespaceId !== extra.namespace.namespaceId)) return null;
              const actual = namespaces.get(expected.namespaceId);
              const envelope = value.envelopes.find(e => e.namespaceId === expected.namespaceId);
              if (actual === undefined || envelope === undefined || index > 0 && value.namespaces[index - 1]!.namespaceId >= expected.namespaceId
                || expected.accessRevision !== actual.namespaceAccessRevision || expected.keyGeneration !== actual.namespaceKeyGeneration
                || expected.domainId !== actual.domainId || expected.domainKeyGeneration !== actual.domainKeyGeneration
                || expected.domainAuthorizationRevision !== actual.domainAuthorizationRevision
                || !equal(expected.domainHeadDigest, actual.domainHeadDigest) || !equal(expected.headDigest, actual.namespaceHeadDigest)
                || !equal(expected.publicationDigest, actual.namespacePublicationDigest)
                || !equal(expected.publicationSetDigest, actual.namespacePublicationSetDigest)
                || !equal(expected.audienceFingerprint, actual.namespaceAudienceFingerprint)
                || envelope.keyClass !== "ai" || envelope.keyGeneration !== actual.namespaceKeyGeneration
                || envelope.bindingRevisionAtWrap !== actual.namespaceAccessRevision) return null;
            }
            return { context: value, namespacesAuthorized: true, ...authorization, signerPublicKey: Uint8Array.from(signer.signerPublicKey) };
          };
          const assertCurrent = async () => {
            assertActive();
            if (await lockWakeParent(transaction, evidence, input.subject.userId) === null) {
              throw new Error("Task wake publication parent changed");
            }
            assertActive();
          };
          const result = await input.use({ productStore: store, product, restricted, transaction, assertCurrent,
            resolveCurrentAgentObjectWrite, resolveCurrentForegroundEntityObjectWrite });
          assertActive();
          if (await lockWakeParent(transaction, evidence, input.subject.userId) === null) {
            throw new Error("Task wake publication parent changed before commit");
          }
          assertActive();
          return result;
        } finally { scopes.delete(token); }
      },
    });
  });
}
