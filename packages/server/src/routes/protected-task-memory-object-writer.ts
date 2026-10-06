import { bytesToHex } from "@noble/hashes/utils.js";
import {
  acquireEncryptionConsumptionFence,
  eq,
  humanCryptoDevices,
  jobs,
  taskRuns,
  tasks,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  type LatticeCrypto,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  deriveMemoryCryptoObjectIdV1,
  MEMORY_OBJECT_TYPE,
  type PreparedTaskRuntimeAgentObject,
} from "@nautilo/lattice-bridge";
import {
  bindConversationProductCanonicalTransactionRunner,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  persistTaskRuntimeAgentObject,
  PostgresLatticeStorage,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  withCurrentAcceptedTaskRuntimeAuthority,
  type ConversationProductCanonicalTransactionRunner,
  type CurrentTaskRuntimeAuthority,
  type TaskRuntimeAuthoritySubject,
} from "@nautilo/lattice-bridge/server";
import {
  assertProtectedTaskJobReferenceV1,
  isCurrentProtectedTaskRunForGrant,
  PostgresBackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskJobReferenceV1,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";
import {
  acceptedTaskRuntimeRecord,
  destroyAcceptedTaskRuntimeRecord,
  loadCurrentProtectedTaskRuntimeFacts,
} from "./task-runtime-current-authority";

export type ProtectedTaskMemoryObjectWriterInput = Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  subject: TaskRuntimeAuthoritySubject;
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  evidence: TaskRuntimeExecutionEvidence;
  jobId: string;
  executionRoomId: string;
  reference: ProtectedTaskJobReferenceV1;
  now(): number;
  signal: AbortSignal;
}>;

type MemoryWrite = Readonly<{
  memoryId: string;
  contentRevision: number;
  operationId: string;
  prepared: PreparedTaskRuntimeAgentObject;
}>;

class TaskMemoryWriteAuthorityUnavailable extends Error {}

function connection(
  executor: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  return {
    query: executor.query.bind(executor),
    transaction: (use) => use(executor),
    transactionOnce: (use) => use(executor),
  };
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length && left.every((byte, i) => byte === right[i])
  );
}
function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) wipe(nested);
  }
}
function exactReference(
  value: unknown,
  expected: ProtectedTaskJobReferenceV1,
): boolean {
  try {
    assertProtectedTaskJobReferenceV1(value);
  } catch {
    return false;
  }
  return Object.entries(expected).every(
    ([key, entry]) => (value as Record<string, unknown>)[key] === entry,
  );
}

/** Compare the complete live grant, not just the selected write Namespace. */
export function taskMemoryWriteAuthorityMatchesEvidence(
  authority: CurrentTaskRuntimeAuthority,
  evidence: TaskRuntimeExecutionEvidence,
): boolean {
  const plan = authority.plan;
  return (
    authority.policyRevision === evidence.policyRevision &&
    plan.authorizationId === evidence.requestId &&
    plan.sessionId === evidence.episodeId &&
    plan.roomId === evidence.sourceRoomId &&
    plan.hostAuthorizationRevision === evidence.hostAuthorizationRevision &&
    plan.recipientKind === "runtime" &&
    plan.recipientPrincipalId === "nautilo_task_runtime" &&
    plan.recipientAuthorizationRevision ===
      evidence.recipientAuthorizationRevision &&
    plan.recipientRuntimeGeneration === evidence.recipientGeneration &&
    plan.recipientKeyId === evidence.recipientKeyId &&
    authority.namespaceRequirements.length ===
      evidence.namespaceRequirements.length &&
    authority.namespaceRequirements.every((entry, index) => {
      const expected = evidence.namespaceRequirements[index];
      return (
        expected !== undefined &&
        entry.ordinal === expected.ordinal &&
        entry.namespaceId === expected.namespaceId &&
        entry.domainId === expected.domainId &&
        entry.expectedAccessRevision === expected.expectedAccessRevision &&
        entry.expectedPolicyRevision === expected.expectedPolicyRevision &&
        entry.operations.join(",") === expected.operations.join(",")
      );
    }) &&
    authority.domains.length === evidence.domainRequirements.length &&
    authority.domains.every((entry) => {
      const matches = evidence.domainRequirements.filter(
        (expected) => expected.domainId === entry.domainId,
      );
      const expected = matches[0];
      return (
        matches.length === 1 &&
        expected !== undefined &&
        entry.keyClass === "ai" &&
        entry.sourceNamespaceId === expected.sourceNamespaceId &&
        entry.domainKeyGeneration === expected.domainKeyGeneration &&
        entry.authorizationRevision === expected.authorizationRevision &&
        entry.participantCount === expected.participantCount &&
        entry.activeNamespaceBindingCount ===
          expected.activeNamespaceBindingCount &&
        sameBytes(entry.participantDigest, expected.participantDigest) &&
        sameBytes(entry.headDigest, expected.headDigest) &&
        sameBytes(
          entry.activeNamespaceBindingSetDigest,
          expected.activeNamespaceBindingSetDigest,
        )
      );
    })
  );
}

function assertBoundInput(input: ProtectedTaskMemoryObjectWriterInput): void {
  input.signal.throwIfAborted();
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  assertProtectedTaskJobReferenceV1(input.reference);
  const { evidence, reference, occurrence, record, request } = input;
  const snapshot = record.snapshot;
  if (
    reference.taskId !== occurrence.task.id ||
    reference.taskRunId !== occurrence.run.id ||
    reference.inputObjectId !== occurrence.task.cryptoObjectId ||
    reference.resultObjectId !== evidence.result.objectId ||
    reference.authorizationRequestId !== evidence.requestId ||
    reference.policyRevision !== evidence.policyRevision ||
    evidence.result.taskId !== occurrence.task.id ||
    evidence.result.taskRunId !== occurrence.run.id ||
    evidence.workId !== occurrence.run.id ||
    evidence.result.signerAgentId !== occurrence.task.agentId ||
    evidence.result.namespace.namespaceId !==
      occurrence.task.contentNamespaceId ||
    occurrence.task.requestorId !== input.subject.userId ||
    (snapshot.state !== "claimed" && snapshot.state !== "running") ||
    snapshot.requestId !== evidence.requestId ||
    snapshot.workId !== evidence.workId ||
    snapshot.claimId !== evidence.claimId ||
    snapshot.claimExpiresAt !== evidence.claimExpiresAt ||
    snapshot.recipientGeneration !== evidence.recipientGeneration ||
    snapshot.recipient?.recipientKeyId !== evidence.recipientKeyId ||
    snapshot.recipient.expiresAt !== evidence.recipientExpiresAt ||
    snapshot.acceptedResponse?.responseDigest !==
      bytesToHex(evidence.authorizationDigest) ||
    record.expectedPolicyRevision !== evidence.policyRevision ||
    request.requestId !== evidence.requestId ||
    request.workId !== evidence.workId ||
    request.episodeId !== evidence.episodeId ||
    request.sourceRoomId !== evidence.sourceRoomId ||
    input.jobId.length === 0 ||
    input.executionRoomId.length === 0 ||
    !Number.isSafeInteger(input.now()) ||
    input.now() >= evidence.expiresAt
  ) {
    throw new TaskMemoryWriteAuthorityUnavailable();
  }
  const bytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  try {
    if (
      record.descriptorBytes === null ||
      !sameBytes(bytes, record.descriptorBytes)
    ) {
      throw new TaskMemoryWriteAuthorityUnavailable();
    }
  } finally {
    bytes.fill(0);
  }
}

/**
 * The sealed Task Memory crypto writer. The global policy fence precedes
 * Task/Run/Job and Namespace locks; the exact live request then precedes
 * device/Domain/Runtime locks. Every
 * lock remains held through payload and manifest CAS. Semantic Memory mapping
 * remains the Agent repository's responsibility; no content is written here to
 * a product table.
 */
export async function persistProtectedTaskMemoryObject(
  input: ProtectedTaskMemoryObjectWriterInput,
  write: MemoryWrite,
): Promise<"created" | "duplicate" | "stale"> {
  if (input.runner.role !== "nautilo") {
    throw new TypeError(
      "Task Memory publication requires the complete product role",
    );
  }
  assertBoundInput(input);
  const objectId = deriveMemoryCryptoObjectIdV1(write);
  if (
    write.prepared.objectId !== objectId ||
    write.prepared.objectType !== MEMORY_OBJECT_TYPE ||
    write.operationId.length === 0
  )
    throw new TypeError("Task Memory object coordinate is not exact");
  const accepted = acceptedTaskRuntimeRecord(input.record);
  if (accepted === null) return "stale";
  try {
    return await persistTaskRuntimeAgentObject({
      crypto: input.crypto,
      prepared: write.prepared,
      evidence: input.evidence,
      withCurrentAuthorization: async (context, use) => {
        if (
          context.objectId !== objectId ||
          context.operationId !== write.operationId
        )
          return null;
        return input.runner.transaction(
          async (tx, executor) => {
            // The global fence precedes every entity lock. Within it, retain
            // cancellation's Task -> Run -> Job order.
            const policy = await acquireEncryptionConsumptionFence(tx);
            if (
              policy.mode === "plaintext_only" ||
              policy.revision !== input.evidence.policyRevision
            )
              return null;
            const [task] = await tx
              .select({ id: tasks.id })
              .from(tasks)
              .where(eq(tasks.id, input.occurrence.task.id))
              .limit(1)
              .for("update");
            const [run] = await tx
              .select({
                id: taskRuns.id,
                taskId: taskRuns.taskId,
                jobId: taskRuns.jobId,
              })
              .from(taskRuns)
              .where(eq(taskRuns.id, input.occurrence.run.id))
              .limit(1)
              .for("update");
            const [job] = await tx
              .select({
                id: jobs.id,
                ownerId: jobs.ownerId,
                requestorId: jobs.requestorId,
                laneKey: jobs.laneKey,
                roomId: jobs.roomId,
                type: jobs.type,
                status: jobs.status,
                input: jobs.input,
                completedAt: jobs.completedAt,
              })
              .from(jobs)
              .where(eq(jobs.id, input.jobId))
              .limit(1)
              .for("update");
            if (
              task === undefined ||
              run === undefined ||
              job === undefined ||
              run.taskId !== task.id ||
              run.jobId !== job.id ||
              job.ownerId !== input.subject.userId ||
              job.requestorId !== input.subject.userId ||
              job.laneKey !== `task:${task.id}` ||
              job.type !== "foreground" ||
              job.roomId !== input.executionRoomId ||
              job.status !== "running" ||
              job.completedAt !== null ||
              !exactReference(job.input, input.reference)
            )
              return null;
            const product = connection(executor);
            const handle =
              await verifyConversationProductPostgresHandle(product);
            const runner = bindConversationProductCanonicalTransactionRunner(
              handle,
              {
                transaction: (use) => use(tx, executor),
              },
            );
            const restricted: PostgresJsBridgeConnection = {
              query: input.restricted.query.bind(input.restricted),
              transaction: input.restricted.transaction.bind(input.restricted),
              transactionOnce: async (use) => {
                // The accepted-authority owner has acquired policy and product
                // Namespace locks. Validate the private source Room before crypto.
                const facts = await loadCurrentProtectedTaskRuntimeFacts({
                  product,
                  occurrence: input.occurrence,
                });
                if (
                  facts === null ||
                  !isCurrentProtectedTaskRunForGrant({
                    occurrence: input.occurrence,
                    task: facts.task,
                    run: facts.run,
                    requestorUserId: input.subject.userId,
                    requestWorkId: input.request.workId,
                    sourceRoomId: input.request.sourceRoomId,
                    requesterPrivateRoom: facts.requesterPrivateRoom,
                    phase: "running",
                  })
                )
                  throw new TaskMemoryWriteAuthorityUnavailable();
                return input.restricted.transactionOnce(
                  async (executor) => {
                    const handle = await verifyCryptoPostgresHandle(
                      connection(executor),
                    );
                    const repository =
                      new PostgresBackgroundAuthorizationRepository(handle);
                    const result =
                      await repository.withCurrentTaskRuntimeExecutionClaim({
                        expected: input.record,
                        now: input.now,
                        use: async () => use(executor),
                      });
                    if (result === null)
                      throw new TaskMemoryWriteAuthorityUnavailable();
                    return result;
                  },
                  { isolationLevel: "read committed" },
                );
              },
            };
            const result = await withCurrentAcceptedTaskRuntimeAuthority({
              runner,
              restricted,
              crypto: input.crypto,
              serverScope: input.serverScope,
              subject: input.subject,
              accepted,
              now: input.now,
              signal: input.signal,
              use: async (authority, _product, restricted) => {
                assertBoundInput(input);
                if (
                  !taskMemoryWriteAuthorityMatchesEvidence(
                    authority,
                    input.evidence,
                  )
                ) {
                  throw new TaskMemoryWriteAuthorityUnavailable();
                }
                const storage = new PostgresLatticeStorage(
                  await verifyCryptoPostgresHandle(restricted),
                );
                // Read immutable publication identity before taking the manager
                // device lock, then lock Runtime state and re-read publication.
                const publication =
                  await storage.getAgentRuntimeSignerPublication(
                    context.agentId,
                    context.runtimeGeneration,
                  );
                if (publication === null) return null;
                let state: Awaited<
                  ReturnType<typeof storage.getAgentRuntimeAtomicState>
                > = null;
                let currentPublication: typeof publication | null = null;
                let managerKey: Uint8Array | null = null;
                try {
                  const rows = await executeTypedCryptoQuery(
                    restricted,
                    cryptoTypedDb
                      .select({
                        human_id: humanCryptoDevices.humanId,
                        signing_public_key: humanCryptoDevices.signingPublicKey,
                        state: humanCryptoDevices.state,
                        revision: humanCryptoDevices.revision,
                      })
                      .from(humanCryptoDevices)
                      .where(
                        eq(
                          humanCryptoDevices.deviceId,
                          publication.managerDeviceId,
                        ),
                      )
                      .limit(2)
                      .for("share"),
                  );
                  const manager = rows[0];
                  if (
                    rows.length !== 1 ||
                    manager === undefined ||
                    manager.human_id !== publication.managerHumanId ||
                    (manager.state !== "active" &&
                      manager.state !== "revoked") ||
                    manager.revision < publication.managerAuthorizationRevision
                  )
                    return null;
                  managerKey = Uint8Array.from(manager.signing_public_key);
                  state = await storage.getAgentRuntimeAtomicState(
                    context.agentId,
                  );
                  currentPublication =
                    await storage.getAgentRuntimeSignerPublication(
                      context.agentId,
                      context.runtimeGeneration,
                    );
                  if (
                    state === null ||
                    currentPublication === null ||
                    currentPublication.managerDeviceId !==
                      publication.managerDeviceId ||
                    currentPublication.managerHumanId !==
                      publication.managerHumanId ||
                    currentPublication.managerAuthorizationRevision !==
                      publication.managerAuthorizationRevision
                  )
                    return null;
                  const status = await use({
                    storage,
                    currentRuntime: state.runtime,
                    signerPublication: currentPublication,
                    currentManagerSigningPublicKey: managerKey,
                  });
                  assertBoundInput(input);
                  return status;
                } finally {
                  wipe(publication);
                  wipe(state);
                  wipe(currentPublication);
                  managerKey?.fill(0);
                }
              },
            });
            return result;
          },
          { isolationLevel: "read committed" },
        );
      },
    });
  } catch (error) {
    if (error instanceof TaskMemoryWriteAuthorityUnavailable) return "stale";
    throw error;
  } finally {
    destroyAcceptedTaskRuntimeRecord(accepted);
  }
}
