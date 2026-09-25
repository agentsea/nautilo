import { createHash, randomUUID } from "node:crypto";

import {
  TaskRuntimeRecipientRegistry,
  type DomainForegroundSecretEntry,
  type TaskRuntimeRecipientAttempt,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import type {
  DomainForegroundAuthorizationPublicCurrentAuthorityV2,
} from "@nautilo/lattice-crypto/wire";

import type { JobExecutor } from "../../job";
import type {
  ProtectedTaskExecutionCandidate,
  ProtectedTaskJobSchedulingFacts,
} from "../../tasks/protected-task-execution-candidate";
import type { ProtectedTaskJobReferenceV1 } from
  "../../tasks/protected-task-job-reference";
import type {
  ClaimedProtectedTaskOccurrence,
  ClaimProtectedTaskOccurrenceResult,
  ProtectedTaskOccurrenceClaimPort,
} from "../../tasks/protected-task-occurrence-coordinator";
import type { ProtectedTaskOccurrence } from "../../tasks/task-observer";
import {
  BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
} from "./lifecycle";
import type {
  BackgroundAuthorizationRecord,
  BackgroundAuthorizationRepository,
  BackgroundAuthorizationTaskRuntimeRecordV3,
} from "./repository";

type CurrentTaskRuntimeAuthorityPort = <Value>(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  use(
    current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
  ): Value | Promise<Value>;
}>) => Promise<Value | null>;

export type TaskRuntimeGrantClaimPlan = Readonly<{
  initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3;
  reference: ProtectedTaskJobReferenceV1;
  scheduling: ProtectedTaskJobSchedulingFacts;
  executor: JobExecutor;
  modelAttribution?: "external";
  recipientAttempt(input: Readonly<{
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Readonly<{ recipientKeyId: string; expiresAt: number }>;
  buildRequest(input: Readonly<{
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    attempt: TaskRuntimeRecipientAttempt;
  }>): TaskRuntimeBackgroundAuthorizationRequestV1;
  openTransientInput(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    domains: readonly DomainForegroundSecretEntry[];
    signal: AbortSignal;
  }>): Promise<Record<string, unknown>>;
}>;

export interface TaskRuntimeGrantClaimDependencies {
  repository: BackgroundAuthorizationRepository;
  recipients: TaskRuntimeRecipientRegistry;
  plan(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<TaskRuntimeGrantClaimPlan> | TaskRuntimeGrantClaimPlan;
  withCurrentAuthority: CurrentTaskRuntimeAuthorityPort;
  now?: () => number;
  claimId?: () => string;
}

function isTaskRuntimeRecord(
  record: BackgroundAuthorizationRecord,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.authoritySet !== undefined;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function exactOccurrenceRecord(
  occurrence: ProtectedTaskOccurrence,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  return record.snapshot.workId === occurrence.run.id
    && record.snapshot.namespaceId === occurrence.task.contentNamespaceId
    && record.workKind === "task.execute"
    && record.purpose === "task.execute"
    && record.processorAuthorizationRevision === null
    && record.expectedDomainEpoch !== null
    && record.authoritySet.namespaceRequirements.some((requirement) =>
      requirement.namespaceId === occurrence.task.contentNamespaceId
      && requirement.expectedAccessRevision
        === occurrence.task.cryptoAccessRevision)
    && record.authoritySet.namespaceRequirements.every((requirement) =>
      requirement.operations.length === 2
      && requirement.operations[0] === "decrypt"
      && requirement.operations[1] === "encrypt");
}

function sameDurablePlan(
  current: BackgroundAuthorizationTaskRuntimeRecordV3,
  initial: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  return current.snapshot.requestId === initial.snapshot.requestId
    && current.snapshot.workId === initial.snapshot.workId
    && current.snapshot.namespaceId === initial.snapshot.namespaceId
    && JSON.stringify(current.snapshot.credentialSubject)
      === JSON.stringify(initial.snapshot.credentialSubject)
    && current.idempotencyKey === initial.idempotencyKey
    && sameBytes(current.workIdentityHash, initial.workIdentityHash)
    && current.workKind === initial.workKind
    && current.purpose === initial.purpose
    && current.domainId === initial.domainId
    && current.processorAuthorizationRevision
      === initial.processorAuthorizationRevision
    && current.expectedDomainEpoch === initial.expectedDomainEpoch
    && current.expectedNamespaceAccessRevision
      === initial.expectedNamespaceAccessRevision
    && current.expectedPolicyRevision === initial.expectedPolicyRevision
    && JSON.stringify(current.authoritySet)
      === JSON.stringify(initial.authoritySet);
}

function assertPlan(
  occurrence: ProtectedTaskOccurrence,
  plan: TaskRuntimeGrantClaimPlan,
): void {
  const initial = plan.initialRecord;
  if (
    !isTaskRuntimeRecord(initial)
    || !exactOccurrenceRecord(occurrence, initial)
    || initial.snapshot.state !== "awaiting_recipient"
    || initial.snapshot.recipientGeneration !== 0
    || initial.snapshot.recipient !== null
    || initial.snapshot.acceptedResponse !== null
    || initial.snapshot.claimId !== null
    || initial.snapshot.claimExpiresAt !== null
    || initial.snapshot.requestRevision !== 0
    || initial.descriptorBytes !== null
    || initial.acceptedMaterial !== null
    || initial.finishedAt !== null
    || plan.reference.taskId !== occurrence.task.id
    || plan.reference.taskRunId !== occurrence.run.id
    || plan.reference.inputObjectId !== occurrence.task.cryptoObjectId
    || plan.reference.authorizationRequestId !== initial.snapshot.requestId
    || plan.reference.policyRevision !== initial.expectedPolicyRevision
    || plan.scheduling.ownerId !== occurrence.task.ownerId
    || plan.scheduling.requestorId !== occurrence.task.requestorId
    || plan.scheduling.agentId !== occurrence.task.agentId
    || plan.scheduling.callingRoomId !== occurrence.task.callingRoomId
    || plan.scheduling.graphThreadId !== occurrence.run.graphThreadId
    || typeof plan.executor !== "function"
    || typeof plan.openTransientInput !== "function"
  ) throw new TypeError("Task Runtime grant plan disagrees with its occurrence");
}

function exactRequest(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  attempt: TaskRuntimeRecipientAttempt,
  request: TaskRuntimeBackgroundAuthorizationRequestV1,
): boolean {
  return request.requestId === record.snapshot.requestId
    && request.workId === record.snapshot.workId
    && request.workKind === "task.execute"
    && request.workPurpose === "task.execute"
    && request.recipientGeneration === record.snapshot.recipientGeneration
    && request.recipientGeneration === attempt.recipientGeneration
    && request.recipientKeyId === attempt.recipientKeyId
    && sameBytes(request.recipientPublicKey, attempt.recipientPublicKey)
    && request.deadlineAt === attempt.expiresAt
    && request.issuedAt < request.deadlineAt;
}

function activeRecipient(
  recipients: TaskRuntimeRecipientRegistry,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  const recipient = record.snapshot.recipient;
  return recipient !== null && recipients.hasAttempt({
    requestId: record.snapshot.requestId,
    workId: record.snapshot.workId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: recipient.recipientKeyId,
  });
}

function requestFromRecord(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): TaskRuntimeBackgroundAuthorizationRequestV1 | null {
  if (record.descriptorBytes === null) return null;
  const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
    record.descriptorBytes,
  );
  if (request === null) return null;
  const recipient = record.snapshot.recipient;
  if (
    recipient === null
    || request.requestId !== record.snapshot.requestId
    || request.workId !== record.snapshot.workId
    || request.recipientGeneration !== record.snapshot.recipientGeneration
    || request.recipientKeyId !== recipient.recipientKeyId
    || Buffer.from(request.recipientPublicKey).toString("base64url")
      !== recipient.recipientPublicKey
    || request.deadlineAt !== recipient.expiresAt
  ) {
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    return null;
  }
  return request;
}

function currentMatchesRequest(
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
  request: TaskRuntimeBackgroundAuthorizationRequestV1,
): boolean {
  return current.authorizationId === request.requestId
    && current.sessionId === request.episodeId
    && current.roomId === request.sourceRoomId
    && current.recipientKind === "runtime"
    && current.recipientPrincipalId === "nautilo_task_runtime"
    && current.recipientAuthorizationRevision === 0
    && current.recipientRuntimeGeneration === request.recipientGeneration
    && current.recipientKeyId === request.recipientKeyId
    && current.recipientAuthorized
    && current.committerDeviceActive;
}

function copyCurrentAuthority(
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
): DomainForegroundAuthorizationPublicCurrentAuthorityV2 {
  return Object.freeze({
    ...current,
    committerDeviceSigningPublicKey:
      current.committerDeviceSigningPublicKey.slice(),
    domains: Object.freeze(current.domains.map((domain) => Object.freeze({
      ...domain,
      participantDigest: domain.participantDigest.slice(),
      headDigest: domain.headDigest.slice(),
      activeNamespaceBindingSetDigest:
        domain.activeNamespaceBindingSetDigest.slice(),
    }))),
  });
}

function destroyCurrentAuthority(
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
): void {
  current.committerDeviceSigningPublicKey.fill(0);
  for (const domain of current.domains) {
    domain.participantDigest.fill(0);
    domain.headDigest.fill(0);
    domain.activeNamespaceBindingSetDigest.fill(0);
  }
}

function staleClaimResult(
  current: BackgroundAuthorizationRecord | null,
): ClaimProtectedTaskOccurrenceResult {
  return current?.snapshot.state === "claimed"
    || current?.snapshot.state === "running"
    ? Object.freeze({ status: "already_claimed" as const })
    : Object.freeze({ status: "inactive" as const });
}

function createCandidate(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  claimed: BackgroundAuthorizationTaskRuntimeRecordV3;
  plan: TaskRuntimeGrantClaimPlan;
  dependencies: TaskRuntimeGrantClaimDependencies;
  claimId: string;
}>): ProtectedTaskExecutionCandidate {
  let state: "ready" | "running" | "finished" = "ready";
  const release = (): void => {
    input.dependencies.recipients.delete(
      input.claimed.snapshot.requestId,
      input.claimed.snapshot.recipientGeneration,
    );
  };
  return Object.freeze({
    async run<Value>(work: (
      transientInput: Record<string, unknown>,
      authorizationSignal: AbortSignal,
    ) => Promise<Value>): Promise<Value> {
      if (state !== "ready") {
        throw new Error("Task Runtime execution candidate is one-use");
      }
      state = "running";
      try {
        const current = await input.dependencies.repository.get(
          input.claimed.snapshot.requestId,
        );
        if (
          current === null
          || !isTaskRuntimeRecord(current)
          || current.snapshot.state !== "claimed"
          || current.snapshot.claimId !== input.claimId
          || current.snapshot.claimExpiresAt === null
          || current.acceptedMaterial === null
          || !exactOccurrenceRecord(input.occurrence, current)
        ) throw new Error("Task Runtime durable claim is no longer current");
        const request = requestFromRecord(current);
        if (request === null) {
          throw new Error("Task Runtime authorization request is unavailable");
        }
        try {
          const authority = await input.dependencies.withCurrentAuthority({
            occurrence: input.occurrence,
            record: current,
            request,
            use: (held) => currentMatchesRequest(held, request)
              ? copyCurrentAuthority(held)
              : null,
          });
          if (authority === null) {
            throw new Error("Task Runtime authority is no longer current");
          }
          try {
            const opened = await input.dependencies.recipients.withOpenedGrant({
              requestId: request.requestId,
              workId: request.workId,
              recipientGeneration: request.recipientGeneration,
              recipientKeyId: request.recipientKeyId,
              claimId: input.claimId,
              claimExpiresAt: current.snapshot.claimExpiresAt,
              authorizationBytes: current.acceptedMaterial.responseBytes,
              current: authority,
              operation: async (domains, signal) => {
                const transientInput = await input.plan.openTransientInput({
                  occurrence: input.occurrence,
                  record: current,
                  domains,
                  signal,
                });
                signal.throwIfAborted();
                return work(transientInput, signal);
              },
            });
            if (opened.status !== "opened") {
              throw new Error("Task Runtime authorization could not be opened");
            }
            return opened.value;
          } finally {
            destroyCurrentAuthority(authority);
          }
        } finally {
          destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
        }
      } finally {
        state = "finished";
        release();
      }
    },
    onIneligible(): void {
      if (state !== "ready") return;
      state = "finished";
      release();
    },
  });
}

/**
 * Dark Task Runtime grant/claim composition. It can prepare and atomically
 * claim an accepted device grant, but does not mount the protected executor.
 */
export class TaskRuntimeGrantClaim implements ProtectedTaskOccurrenceClaimPort {
  readonly #now: () => number;
  readonly #claimId: () => string;

  constructor(private readonly dependencies: TaskRuntimeGrantClaimDependencies) {
    this.#now = dependencies.now ?? Date.now;
    this.#claimId = dependencies.claimId ?? randomUUID;
  }

  async prepareOrClaimExact(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<ClaimProtectedTaskOccurrenceResult> {
    const plan = await this.dependencies.plan(occurrence);
    assertPlan(occurrence, plan);
    const existing = await this.dependencies.repository.get(
      plan.initialRecord.snapshot.requestId,
    );
    const durable = existing ?? (await this.dependencies.repository.create(
      plan.initialRecord,
    )).record;
    if (!isTaskRuntimeRecord(durable)
      || !exactOccurrenceRecord(occurrence, durable)
      || !sameDurablePlan(durable, plan.initialRecord)) {
      throw new TypeError("Task Runtime durable record was substituted");
    }
    let current = durable;

    if (current.snapshot.state === "awaiting_recipient") {
      const now = this.#now();
      const recipient = plan.recipientAttempt({ record: current, now });
      const attempt = await this.dependencies.recipients.createAttempt({
        requestId: current.snapshot.requestId,
        workId: current.snapshot.workId,
        recipientGeneration: current.snapshot.recipientGeneration,
        recipientKeyId: recipient.recipientKeyId,
        expiresAt: recipient.expiresAt,
      });
      if (attempt.status !== "created") {
        return Object.freeze({ status: "awaiting_authorization" as const });
      }
      let retain = false;
      const request = plan.buildRequest({ record: current, attempt: attempt.attempt });
      try {
        if (!exactRequest(current, attempt.attempt, request)) {
          throw new TypeError("Task Runtime request was substituted");
        }
        const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
          request,
        );
        const descriptorDigest = createHash("sha256")
          .update(descriptorBytes)
          .digest("hex");
        const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
          ...current,
          snapshot: attachBackgroundAuthorizationRecipient(current.snapshot, {
            recipientGeneration: current.snapshot.recipientGeneration,
            descriptorDigest,
            recipientKeyId: attempt.attempt.recipientKeyId,
            recipientPublicKey: Buffer.from(attempt.attempt.recipientPublicKey)
              .toString("base64url"),
            expiresAt: attempt.attempt.expiresAt,
            now,
          }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
          descriptorBytes,
        };
        const stored = await this.dependencies.repository.compareAndSwap({
          expectedRequestRevision: current.snapshot.requestRevision,
          next,
        });
        if (stored.status !== "updated" || !isTaskRuntimeRecord(stored.record)) {
          return Object.freeze({ status: "awaiting_authorization" as const });
        }
        current = stored.record;
        retain = true;
      } finally {
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
        if (!retain) {
          this.dependencies.recipients.delete(
            current.snapshot.requestId,
            current.snapshot.recipientGeneration,
          );
        }
      }
    }

    if (current.snapshot.state === "awaiting_device") {
      return Object.freeze({ status: "awaiting_authorization" as const });
    }
    if (current.snapshot.state === "claimed" || current.snapshot.state === "running") {
      return Object.freeze({ status: "already_claimed" as const });
    }
    if (
      current.snapshot.state !== "grant_ready"
      || current.acceptedMaterial === null
      || current.snapshot.recipient === null
      || !activeRecipient(this.dependencies.recipients, current)
    ) return Object.freeze({ status: "inactive" as const });

    const request = requestFromRecord(current);
    if (request === null) return Object.freeze({ status: "inactive" as const });
    const now = this.#now();
    const claimExpiresAt = Math.min(
      current.snapshot.recipient.expiresAt,
      current.acceptedMaterial.authorizationExpiresAt,
      now + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
    );
    if (
      now >= current.acceptedMaterial.authorizationExpiresAt
      || claimExpiresAt <= now
    ) {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
      return Object.freeze({ status: "inactive" as const });
    }
    const claimId = this.#claimId();
    try {
      const claimed = await this.dependencies.withCurrentAuthority({
        occurrence,
        record: current,
        request,
        use: async (authority) => {
          if (!currentMatchesRequest(authority, request)) return null;
          const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
            ...current,
            snapshot: claimBackgroundAuthorizationRequest(
              current.snapshot,
              claimId,
              now,
              claimExpiresAt,
            ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
          };
          return this.dependencies.repository.compareAndSwap({
            expectedRequestRevision: current.snapshot.requestRevision,
            next,
          });
        },
      });
      if (claimed === null) return Object.freeze({ status: "inactive" as const });
      if (claimed.status === "stale") return staleClaimResult(claimed.current);
      if (!isTaskRuntimeRecord(claimed.record)) {
        throw new TypeError("Task Runtime claim changed credential family");
      }
      const candidate = createCandidate({
        occurrence,
        claimed: claimed.record,
        plan,
        dependencies: this.dependencies,
        claimId,
      });
      const dispatch: ClaimedProtectedTaskOccurrence = Object.freeze({
        reference: plan.reference,
        scheduling: plan.scheduling,
        executor: plan.executor,
        candidate,
        ...(plan.modelAttribution === undefined
          ? {}
          : { modelAttribution: plan.modelAttribution }),
      });
      return Object.freeze({ status: "claimed" as const, dispatch });
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    }
  }
}

export function createTaskRuntimeGrantClaim(
  dependencies: TaskRuntimeGrantClaimDependencies,
): TaskRuntimeGrantClaim {
  return new TaskRuntimeGrantClaim(dependencies);
}
