import {
  and, eq, taskRunResultCryptoRevisions,
  PROTECTED_TASK_CANCELLED_RESULT, publishProtectedTaskCancellationProduct,
  recordProtectedTaskRunResultAttached,
  type DirectDatabase, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  ClassifiedDataOperationError, fingerprintTaskContentAuthorityV1,
  sameTaskContentCoordinateV1, taskRuntimePreparedResultDigestV1,
  withProtectedTaskCancellationResultSigner,
  type EncryptionDataOperationOwner, type TaskContentAuthorityV1,
  type PreparedTaskContentCryptoRevisionV1, type TaskRunResultContentCoordinateV1, type TaskContentCoordinateV1,
} from "@nautilo/lattice-bridge";
import {
  createPostgresTaskContentRepositoryV1, PostgresHumanDeviceSignerHistory,
  PostgresLatticeStorage, prepareNativeTaskRuntimeCancelledRunResult,
  verifyCryptoPostgresHandle, type DurableTaskContentRepositoryV1,
} from "@nautilo/lattice-bridge/server";
import {
  assertAuthenticTaskRuntimeCancellationResultEvidence,
  type DomainForegroundSecretEntry, type LatticeCrypto,
  type TaskRuntimeCancellationResultEvidence,
} from "@nautilo/lattice-crypto";
import { parseBackgroundAuthorizationRecord, type BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import type { ProtectedTaskCancellationAuthorityPort } from "./protected-task-cancellation-authority";
import type { ProtectedTaskCancellationPlan } from "./protected-task-cancellation-plan";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import { createProtectedTaskHistoricalHumanDeviceSigningKeyResolver } from
  "./protected-task-historical-human-device-signing-key";
import { withProtectedTaskResultSignerHistory } from "./protected-task-result-signer-history";
import { acceptedTaskRuntimeRecord, destroyAcceptedTaskRuntimeRecord } from
  "./task-runtime-current-authority";

export type ProtectedTaskCancellationPublication = (input: Readonly<{
  plan: ProtectedTaskCancellationPlan;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  domains: readonly DomainForegroundSecretEntry[];
  evidence: TaskRuntimeCancellationResultEvidence;
  signal: AbortSignal;
  assertCurrentClaim(): void | Promise<void>;
}>) => Promise<void>;

type ContentAuthorityResolver = (expected: Readonly<{
  requesterHumanId: string; namespaceId: string;
}>) => Promise<TaskContentAuthorityV1 | null>;

export type ProtectedTaskCancellationPublicationDependencies = Readonly<{
  prepare(input: Readonly<{
    agentId: string;
    authority: TaskContentAuthorityV1;
    evidence: TaskRuntimeCancellationResultEvidence;
    domains: readonly DomainForegroundSecretEntry[];
    signal: AbortSignal;
    assertCurrentTaskAuthority(): Promise<void>;
  }>): Promise<PreparedTaskContentCryptoRevisionV1>;
  repository(input: Readonly<{
    requesterUserId: string;
    coordinate: TaskRunResultContentCoordinateV1;
    authority: TaskContentAuthorityV1;
    resolveAuthority: ContentAuthorityResolver;
    assertReservationCurrent(coordinate: TaskContentCoordinateV1): Promise<void>;
  }>): Promise<Pick<DurableTaskContentRepositoryV1<unknown>, "publishPreparedProtectedOrDual">>;
}>;

function unavailable(): never {
  throw new ClassifiedDataOperationError("authority", "Cancellation publication authority is unavailable");
}

function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) wipe(child);
  }
}

/** Fixed result only. No Task definition, execution Job, tool or model enters this owner. */
export function createProtectedTaskCancellationPublication(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  serverScope: string;
  authority: ProtectedTaskCancellationAuthorityPort;
  now?: () => number;
}>, overrides: Partial<ProtectedTaskCancellationPublicationDependencies> = {}): ProtectedTaskCancellationPublication {
  const now = input.now ?? Date.now;
  const prepare: ProtectedTaskCancellationPublicationDependencies["prepare"] =
    overrides.prepare ?? (async value => {
      const handle = await verifyCryptoPostgresHandle(input.restricted);
      const storage = new PostgresLatticeStorage(handle);
      const domains = value.domains;
      const domain = domains[0];
      if (domains.length !== 1 || domain === undefined || domain.domainId !== value.authority.domainId
        || domain.keyClass !== "ai") unavailable();
      const runtime = await storage.getAgentRuntimeAtomicState(value.agentId);
      let agentAuthorizationRevision: number;
      let runtimeGeneration: number;
      try {
        if (runtime === null || runtime.runtime.agentId !== value.agentId) unavailable();
        agentAuthorizationRevision = runtime.runtime.authorizationRevision;
        runtimeGeneration = runtime.runtime.runtimeGeneration;
      } finally { wipe(runtime); }
      return withProtectedTaskResultSignerHistory({
        handle, crypto: input.crypto, agentId: value.agentId,
        domainId: domain.domainId, domainEpoch: domain.domainKeyGeneration,
        expectedAgentAuthorizationRevision: agentAuthorizationRevision,
        expectedRuntimeGeneration: runtimeGeneration,
        use: async history => {
          const result = await withProtectedTaskCancellationResultSigner({
            crypto: input.crypto, storage, evidence: value.evidence, domain,
            expectedAgentAuthorizationRevision: agentAuthorizationRevision,
            resolveHistoricalRuntimeCommitter: history.resolveHistoricalRuntimeCommitter,
            resolveHistoricalSignerPublicationManager: history.resolveHistoricalSignerPublicationManager,
            execute: signer => prepareNativeTaskRuntimeCancelledRunResult({
              restricted: input.restricted, serverScope: input.serverScope, domains,
              signal: value.signal, assertCurrentTaskAuthority: value.assertCurrentTaskAuthority,
              crypto: input.crypto, evidence: value.evidence, authority: value.authority,
              createdAt: now(), agentAuthorizationRevision: signer.agentAuthorizationRevision,
              runtime: signer.runtime, signerPublication: signer.signerPublication,
              resolveHistoricalSignerPublicationManager: history.resolveHistoricalSignerPublicationManager,
            }),
          });
          if (result.status !== "executed") unavailable();
          return result.value;
        },
      });
    });
  const createRepository: ProtectedTaskCancellationPublicationDependencies["repository"] =
    overrides.repository ?? (async value => {
      const handle = await verifyCryptoPostgresHandle(input.restricted);
      const product = await createHumanProductTransactionContext(value.requesterUserId, input.db);
      const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
      return createPostgresTaskContentRepositoryV1({
        product: { handle: product.handle, resolveCurrentAuthority: value.resolveAuthority,
          assertReservationCurrent: value.assertReservationCurrent },
        crypto: { handle, crypto: input.crypto,
          resolveCurrentAuthority: candidate => sameTaskContentCoordinateV1(candidate, value.coordinate)
            ? value.resolveAuthority(value.authority) : Promise.resolve(null),
          resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
          resolveHistoricalHumanDeviceSigningPublicKey:
            createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle),
        },
        content: { prepareProtected: unavailable, publishProduct: unavailable,
          readOrdinary: unavailable, readProtected: unavailable },
      });
    });
  return async publication => {
    const intent = Object.freeze({ ...publication.plan.intent,
      terminalAt: new Date(publication.plan.intent.terminalAt.getTime()) });
    const requestId = publication.plan.initialRecord.snapshot.requestId;
    const { evidence, signal } = publication;
    const record = parseBackgroundAuthorizationRecord(publication.record);
    if (record.snapshot.formatVersion !== 3
      || record.snapshot.credentialSubject.kind !== "runtime"
      || record.snapshot.credentialSubject.runtimeKind !== "task"
      || record.snapshot.credentialSubject.runtimeVersion !== 1
      || record.workKind !== "task.cancel_result" || record.purpose !== "task.cancel_result") unavailable();
    const assertLive = async () => {
      signal.throwIfAborted();
      assertAuthenticTaskRuntimeCancellationResultEvidence(evidence);
      await publication.assertCurrentClaim();
      signal.throwIfAborted();
      assertAuthenticTaskRuntimeCancellationResultEvidence(evidence);
    };
    await assertLive();
    const accepted = acceptedTaskRuntimeRecord(record as BackgroundAuthorizationTaskRuntimeRecordV3);
    const target = evidence.result.namespace;
    if (accepted === null) unavailable();
    try {
      if (record.workKind !== "task.cancel_result" || record.purpose !== "task.cancel_result"
        || record.snapshot.state !== "running"
        || record.snapshot.requestId !== requestId
        || record.snapshot.workId !== intent.taskRunId
        || record.snapshot.claimId !== evidence.claimId
        || record.snapshot.recipientGeneration !== evidence.recipientGeneration
        || record.expectedPolicyRevision !== intent.policyRevision
        || evidence.requestId !== record.snapshot.requestId || evidence.workId !== intent.taskRunId
        || evidence.policyRevision !== intent.policyRevision
        || evidence.result.taskId !== intent.taskId || evidence.result.taskRunId !== intent.taskRunId
        || evidence.result.contentRevision !== 2 || evidence.result.objectId !== intent.resultObjectId
        || evidence.result.signerAgentId !== intent.agentId
        || target.namespaceId !== intent.contentNamespaceId) unavailable();
      const subject = { userId: intent.requesterUserId,
        humanActorId: accepted.issuingHumanId, deviceId: accepted.issuingDeviceId };
      const authority: TaskContentAuthorityV1 = Object.freeze({
        authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
        requesterHumanId: subject.humanActorId, namespaceId: target.namespaceId,
        domainId: target.domainId, expectedAccessRevision: target.expectedAccessRevision,
        expectedPolicyRevision: intent.policyRevision,
      });
      const expectedFingerprint = fingerprintTaskContentAuthorityV1(authority);
      const withCurrent = async <Value>(use: (...args: Parameters<Parameters<
        ProtectedTaskCancellationAuthorityPort["withAccepted"]
      >[0]["use"]>) => Value | Promise<Value>): Promise<Value | null> => input.authority.withAccepted({
        intent, subject, accepted, signal, restricted: input.restricted,
        validateBeforeCommit: assertLive,
        use: async (...args) => {
          const current = args[0];
          const namespace = current.namespaceRequirements[0];
          if (current.namespaceRequirements.length !== 1 || namespace === undefined
            || namespace.namespaceId !== authority.namespaceId
            || namespace.domainId !== authority.domainId
            || namespace.expectedAccessRevision !== authority.expectedAccessRevision
            || namespace.expectedPolicyRevision !== authority.expectedPolicyRevision
            || current.policyRevision !== intent.policyRevision) return unavailable();
          return await use(...args);
        },
      });
      const resolveAuthority = async (expected: Readonly<{
        requesterHumanId: string; namespaceId: string;
      }>) => {
        if (expected.requesterHumanId !== subject.humanActorId
          || expected.namespaceId !== intent.contentNamespaceId) return null;
        return withCurrent<TaskContentAuthorityV1>(() => authority);
      };
      const assertCurrentTaskAuthority = async () => {
        await assertLive();
        if (await resolveAuthority(authority) === null) unavailable();
      };
      await assertCurrentTaskAuthority();
      const reserved = await input.db.select({ operationId: taskRunResultCryptoRevisions.operationId })
        .from(taskRunResultCryptoRevisions).where(and(
          eq(taskRunResultCryptoRevisions.taskId, intent.taskId),
          eq(taskRunResultCryptoRevisions.taskRunId, intent.taskRunId),
          eq(taskRunResultCryptoRevisions.resultRevision, 2),
        )).limit(1);
      if (reserved.length !== 0) {
        // An immutable reservation owns its bytes. Recovery must inspect that
        // ledger; another random encryption would conflict with its identity.
        throw new ClassifiedDataOperationError("stale", "Cancellation result requires publication reconciliation");
      }
      const prepared = await prepare({ agentId: intent.agentId, authority,
        evidence, domains: publication.domains, signal, assertCurrentTaskAuthority });
      await assertLive();
      const coordinate = { kind: "run_result" as const, taskId: intent.taskId,
        taskRunId: intent.taskRunId, contentRevision: 2 };
      const repository = await createRepository({ requesterUserId: intent.requesterUserId,
        coordinate, authority, resolveAuthority, assertReservationCurrent: async candidate => {
          if (!sameTaskContentCoordinateV1(candidate, coordinate)) unavailable();
          await assertLive();
        } });
      const requestDigest = taskRuntimePreparedResultDigestV1(prepared);
      const publishProduct = async (token: number, representation: "protected" | "dual") => {
        if (token !== intent.policyRevision || representation !== intent.representation) unavailable();
        const result = await withCurrent(async (_current, _product, _restricted, transaction) => {
          // Reuse the already-held product transaction; a second connection
          // would wait forever for this owner's Task/Run locks.
          const result = await publishProtectedTaskCancellationProduct({
            transaction: use => use(transaction),
          }, { intent, requestDigest,
            prepared: { operationId: intent.resultOperationId, resultRevision: 2,
              resultObjectId: intent.resultObjectId, requesterHumanId: subject.humanActorId,
              authorityFingerprint: expectedFingerprint },
          }, async () => { await assertLive(); return true; });
          if (result.status === "rejected") unavailable();
          return result;
        });
        if (result === null) unavailable();
        return result;
      };
      const receipt = await repository.publishPreparedProtectedOrDual({
        owner: input.owner, operationId: intent.resultOperationId, requestDigest,
        authority, operationalMetadata: null, prepared,
        ordinaryContent: { coordinate,
          payload: { formatVersion: 1, resultText: PROTECTED_TASK_CANCELLED_RESULT, lastError: null } },
        publishProtectedProduct: context => publishProduct(context.revalidationToken, "protected"),
        publishDualProduct: (_content, context) => publishProduct(context.revalidationToken, "dual"),
      });
      if (receipt.representation !== intent.representation || receipt.protectedRevision === null
        || receipt.protectedRevision.status === "orphaned"
        || !sameTaskContentCoordinateV1(receipt.protectedRevision.coordinate, coordinate)
        || receipt.protectedRevision.cryptoObjectId !== intent.resultObjectId) unavailable();
      const attached = await recordProtectedTaskRunResultAttached(input.db, {
        taskId: intent.taskId, taskRunId: intent.taskRunId,
      });
      if (attached.status === "rejected") unavailable();
    } finally { destroyAcceptedTaskRuntimeRecord(accepted); }
  };
}
