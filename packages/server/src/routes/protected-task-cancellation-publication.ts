import {
  and, eq, taskRunResultCryptoRevisions,
  recordProtectedTaskRunResultAttached,
  type DirectDatabase, type PostgresJsBridgeConnection, type ProtectedTaskCancellationOutputIntent,
} from "@nautilo/db";
import {
  ClassifiedDataOperationError,
  withProtectedTaskCancellationResultSigner,
  type EncryptionDataOperationOwner, type TaskContentAuthorityV1,
} from "@nautilo/lattice-bridge";
import {
  PostgresHumanDeviceSignerHistory, PostgresLatticeStorage,
  stageNativeTaskCancellationPublication, verifyCryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import {
  assertAuthenticTaskRuntimeCancellationResultEvidence,
  hasTaskRuntimeTemporarySigner,
  type DomainForegroundSecretEntry, type LatticeCrypto,
  type TaskRuntimeCancellationResultEvidence,
} from "@nautilo/lattice-crypto";
import { parseBackgroundAuthorizationRecord, type BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import type { ProtectedTaskCancellationAuthorityPort } from "./protected-task-cancellation-authority";
import type { ProtectedTaskCancellationPlan } from "./protected-task-cancellation-plan";
import { createProtectedTaskCancellationPublicationRecovery } from "./protected-task-cancellation-publication-recovery";
import { createProtectedTaskHistoricalHumanDeviceSigningKeyResolver } from
  "./protected-task-historical-human-device-signing-key";
import { withProtectedTaskResultSignerHistory, type ProtectedTaskResultSignerHistory } from "./protected-task-result-signer-history";
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

export type ProtectedTaskCancellationPublicationDependencies = Readonly<{
  stage(input: Readonly<{
    agentId: string;
    intent: ProtectedTaskCancellationOutputIntent;
    restricted: PostgresJsBridgeConnection;
    authority: TaskContentAuthorityV1;
    evidence: TaskRuntimeCancellationResultEvidence;
    domains: readonly DomainForegroundSecretEntry[];
    signal: AbortSignal;
    assertCurrentTaskAuthority(): Promise<void>;
    assertCurrentClaim(): void | Promise<void>;
  }>): Promise<"staged" | "already_staged">;
  recover(coordinates: Readonly<{ taskId: string; taskRunId: string }>):
    Promise<"missing" | "pending" | "mapped" | "quarantined">;
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
  const stage: ProtectedTaskCancellationPublicationDependencies["stage"] =
    overrides.stage ?? (async value => {
      const handle = await verifyCryptoPostgresHandle(value.restricted);
      const storage = new PostgresLatticeStorage(handle);
      const signerHistory = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
      const domains = value.domains;
      const domain = domains[0];
      if (domains.length !== 1 || domain === undefined || domain.domainId !== value.authority.domainId
        || domain.keyClass !== "ai") unavailable();
      const publish = async (history: ProtectedTaskResultSignerHistory, authorizationRevision: number) => {
        const result = await withProtectedTaskCancellationResultSigner({
            crypto: input.crypto, storage, evidence: value.evidence, domain,
            expectedAgentAuthorizationRevision: authorizationRevision,
            resolveHistoricalRuntimeCommitter: history.resolveHistoricalRuntimeCommitter,
            resolveHistoricalSignerPublicationManager: history.resolveHistoricalSignerPublicationManager,
            execute: signer => stageNativeTaskCancellationPublication({
              intent: value.intent, assertCurrentClaim: value.assertCurrentClaim,
              resolveHistoricalAgentSignerAuthority: signerHistory.resolveAgentRuntimeSignerManager,
              resolveHistoricalHumanDeviceSigningPublicKey:
                createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle),
              preparation: { restricted: value.restricted, serverScope: input.serverScope, domains,
              signal: value.signal, assertCurrentTaskAuthority: value.assertCurrentTaskAuthority,
              crypto: input.crypto, evidence: value.evidence, authority: value.authority,
              createdAt: now(), agentAuthorizationRevision: signer.agentAuthorizationRevision,
              runtime: signer.runtime, signerPublication: signer.signerPublication,
              ...(signer.temporarySigner === undefined ? {} : { temporarySigner: signer.temporarySigner }),
              resolveHistoricalSignerPublicationManager: history.resolveHistoricalSignerPublicationManager,
              },
            }),
          });
        if (result.status !== "executed") unavailable();
        return result.value;
      };
      if (hasTaskRuntimeTemporarySigner(value.evidence)) {
        // Certified publication never loads permanent Agent Runtime state.
        return publish({
          resolveHistoricalRuntimeCommitter: () => null,
          resolveHistoricalSignerPublicationManager: () => null,
        }, 0);
      }
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
        use: history => publish(history, agentAuthorizationRevision),
      });
    });
  const recover = overrides.recover ?? createProtectedTaskCancellationPublicationRecovery({
    ...input,
    // The claim owner completes its authorization after publication returns.
    // Recovery here only attaches the durable result; the observer settles abandoned claims.
    settle: async (coordinates, _verifyStaged, context) =>
      (await recordProtectedTaskRunResultAttached(context.db, coordinates)).status !== "rejected",
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
      const publish = async (representation: "protected" | "dual") => {
        if (representation !== intent.representation) unavailable();
        const staged = await withCurrent(async (_current, _product, restricted, transaction) => {
          const currentReservation = await transaction.select({ operationId: taskRunResultCryptoRevisions.operationId })
            .from(taskRunResultCryptoRevisions).where(and(
              eq(taskRunResultCryptoRevisions.taskId, intent.taskId),
              eq(taskRunResultCryptoRevisions.taskRunId, intent.taskRunId),
              eq(taskRunResultCryptoRevisions.resultRevision, 2),
            )).limit(1);
          if (currentReservation.length !== 0) {
            throw new ClassifiedDataOperationError("stale", "Cancellation result requires publication reconciliation");
          }
          // Authority locks are already held. Re-entering withAccepted here
          // would deadlock on the same stopped Task/Run.
          return stage({ agentId: intent.agentId, intent, restricted, authority,
            evidence, domains: publication.domains, signal,
            assertCurrentTaskAuthority: assertLive,
            assertCurrentClaim: publication.assertCurrentClaim });
        });
        if (staged === null) unavailable();
        // The restricted outer transaction has committed before any product
        // reservation. Recovery uses the durable receipt, never a live grant.
        const outcome = await recover({ taskId: intent.taskId, taskRunId: intent.taskRunId });
        if (outcome !== "mapped") {
          throw new ClassifiedDataOperationError("stale", "Cancellation result requires publication reconciliation");
        }
      };
      await input.owner.runMutation({
        protected: () => publish("protected"), dual: () => publish("dual"),
      });
    } finally { destroyAcceptedTaskRuntimeRecord(accepted); }
  };
}
