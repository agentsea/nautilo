import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { PostgresJsBridgeConnection } from "@nautilo/db";
import type {
  TaskRuntimeCancellationResultProof,
  TaskRuntimeCertifiedPublicationSigningInput,
  TaskRuntimeRecipientRegistry,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV3,
  decodeTaskRuntimeBackgroundAuthorizationResponseV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV3,
  isTaskRuntimeBackgroundAuthorizationRequestV3Carrier,
  type BackgroundAuthorizationIssuerV2,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV3,
} from "@nautilo/lattice-crypto/background";
import {
  claimTaskRuntimeBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  markBackgroundAuthorizationRunning,
  parseBackgroundAuthorizationRecord,
  sameBackgroundAuthorizationRecord,
  sameTaskRuntimeAuthorityPlan,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type TaskRuntimeRecipientRequestPlan,
} from "@nautilo/runtime";
import type { ProtectedTaskCancellationAuthorityPort } from
  "./protected-task-cancellation-authority";
import type { ProtectedTaskCancellationPlan } from
  "./protected-task-cancellation-plan";
import type { ProtectedTaskCancellationPublication } from
  "./protected-task-cancellation-publication";
import {
  acceptedTaskRuntimeRecord,
  copyProtectedTaskRuntimeAuthority,
  destroyAcceptedTaskRuntimeRecord,
  destroyProtectedTaskRuntimeAuthority,
} from "./task-runtime-current-authority";

type Repository = Pick<
  BackgroundAuthorizationTaskRuntimeReplacementRepository,
  "get" | "compareAndSwap"
>;

export type ProtectedTaskCancellationClaimDependencies = Readonly<{
  authority: ProtectedTaskCancellationAuthorityPort;
  recipients: Pick<TaskRuntimeRecipientRegistry,
    "withOpenedCancellationResultGrant" | "delete">;
  repository(restricted: PostgresJsBridgeConnection): Promise<Repository>;
  publish: ProtectedTaskCancellationPublication;
  now?: () => number;
  claimId?: () => string;
}>;

function cancellationRecord(
  record: BackgroundAuthorizationRecord | null,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record !== null
    && record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.workKind === "task.cancel_result"
    && record.purpose === "task.cancel_result";
}

function publicationRecord(record: BackgroundAuthorizationRecord | null,
  workKind: PublicationWorkKind,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record !== null && record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.workKind === workKind && record.purpose === workKind;
}

function exactPlan(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  plan: ProtectedTaskCancellationPlan,
): boolean {
  return cancellationRecord(record) && cancellationRecord(plan.initialRecord)
    && plan.intent.taskStatus === "cancelled"
    && plan.intent.runStatus === "cancelled"
    && plan.intent.resultRevision === 2
    && record.snapshot.requestId === plan.initialRecord.snapshot.requestId
    && record.snapshot.workId === plan.intent.taskRunId
    && record.snapshot.namespaceId === plan.intent.contentNamespaceId
    && record.expectedPolicyRevision === plan.intent.policyRevision
    && record.idempotencyKey === plan.initialRecord.idempotencyKey
    && sameTaskRuntimeAuthorityPlan(record, plan.initialRecord);
}

function exactRunningRecord(
  current: BackgroundAuthorizationRecord | null,
  expected: BackgroundAuthorizationTaskRuntimeRecordV3,
  claimId: string,
  now: number,
  workKind: PublicationWorkKind = "task.cancel_result",
): current is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return Number.isSafeInteger(now)
    && expected.snapshot.claimExpiresAt !== null
    && now >= expected.snapshot.updatedAt
    && now < expected.snapshot.claimExpiresAt
    && publicationRecord(current, workKind)
    && current.snapshot.state === "running"
    && current.snapshot.claimId === claimId
    && current.snapshot.claimExpiresAt === expected.snapshot.claimExpiresAt
    && current.snapshot.recipientGeneration
      === expected.snapshot.recipientGeneration
    && current.snapshot.requestRevision === expected.snapshot.requestRevision
    && sameBackgroundAuthorizationRecord(current, expected);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Claims and publishes only the fixed stopped-Task result. It never constructs
 * an execution occurrence, Job, model input, or executor.
 */
export function createProtectedTaskCancellationClaim(
  dependencies: ProtectedTaskCancellationClaimDependencies,
) {
  return createProtectedTaskPublicationClaim<ProtectedTaskCancellationPlan>({
    workKind: "task.cancel_result", recipients: dependencies.recipients,
    repository: dependencies.repository, matchesPlan: exactPlan,
    coordinates: plan => ({ workId: plan.intent.taskRunId,
      requesterUserId: plan.intent.requesterUserId }),
    withAccepted: ({ plan, ...operation }) => dependencies.authority.withAccepted({
      ...operation, intent: plan.intent }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.claimId === undefined ? {} : { claimId: dependencies.claimId }),
    openGrant: async ({ plan, request, certifiedSigning, authorizationBytes,
      record, claimId, claimExpiresAt, authority, signal, assertCurrentClaim }) => {
      const namespace = record.authoritySet.namespaceRequirements[0]!;
      const proof: TaskRuntimeCancellationResultProof = Object.freeze({
        taskId: plan.intent.taskId, taskRunId: plan.intent.taskRunId,
        contentRevision: 2, objectId: plan.intent.resultObjectId,
        signerAgentId: plan.intent.agentId,
        namespace: Object.freeze({ namespaceId: namespace.namespaceId, domainId: namespace.domainId,
          operations: Object.freeze(["encrypt"] as const),
          expectedAccessRevision: namespace.expectedAccessRevision,
          expectedPolicyRevision: namespace.expectedPolicyRevision }),
      });
      const expectedPublication = Object.freeze({
        kind: "task.cancel_result" as const,
        taskId: proof.taskId,
        taskRunId: proof.taskRunId,
        contentRevision: 2 as const,
        workIdentityHash: Uint8Array.from(record.workIdentityHash),
      });
      try {
        const opened = await dependencies.recipients.withOpenedCancellationResultGrant({
          requestId: request.requestId, workId: request.workId,
          recipientGeneration: record.snapshot.recipientGeneration,
          recipientKeyId: request.recipientKeyId, claimId, claimExpiresAt,
          authorizationBytes, current: authority.foreground,
          currentNamespaceRequirements: authority.namespaceRequirements,
          result: proof, signal,
          certifiedSigning: Object.freeze({
            ...certifiedSigning, expectedPublication,
          }),
          operation: async (domains, activeSignal, evidence) => {
            await assertCurrentClaim();
            await dependencies.publish({ plan, record, domains, evidence,
              signal: activeSignal, assertCurrentClaim });
          },
        });
        return opened.status === "opened";
      } finally {
        expectedPublication.workIdentityHash.fill(0);
      }
    },
  });
}

type PublicationWorkKind = "task.cancel_result" | "task.deliver_message"
  | "task.deliver_result" | "task.delivery_wake";
type PublicationPlan = TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV3
> & Readonly<{ sourceRoomId: string }>;
type PublicationSigningBase = Omit<
  TaskRuntimeCertifiedPublicationSigningInput,
  "expectedPublication"
>;
export type TaskPublicationClaimInput<Plan extends PublicationPlan> = Readonly<{
  plan: Plan;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  restricted: PostgresJsBridgeConnection;
  signal: AbortSignal;
}>;
type AcceptedOperation = Parameters<ProtectedTaskCancellationAuthorityPort["withAccepted"]>[0];
export type TaskPublicationClaimDependencies<Plan extends PublicationPlan> = Readonly<{
  workKind: PublicationWorkKind;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  repository(restricted: PostgresJsBridgeConnection): Promise<Repository>;
  coordinates(plan: Plan): Readonly<{ workId: string; requesterUserId: string }>;
  matchesPlan(record: BackgroundAuthorizationTaskRuntimeRecordV3, plan: Plan): boolean;
  withAccepted(input: Omit<AcceptedOperation, "intent" | "use"> & Readonly<{
    plan: Plan;
    use(...args: Parameters<AcceptedOperation["use"]>): Promise<boolean | null>;
  }>): Promise<boolean | null>;
  openGrant(input: Readonly<{
    plan: Plan;
    request: TaskRuntimeBackgroundAuthorizationRequestV1;
    certifiedSigning: PublicationSigningBase;
    authorizationBytes: Uint8Array;
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    claimId: string;
    claimExpiresAt: number;
    authority: ReturnType<typeof copyProtectedTaskRuntimeAuthority>;
    signal: AbortSignal;
    assertCurrentClaim(): Promise<void>;
  }>): Promise<boolean | Readonly<{ status: "parked"; record: BackgroundAuthorizationTaskRuntimeRecordV3 }>>;
  now?: () => number;
  claimId?: () => string;
}>;

function publicationAuthorityShape(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  workKind: PublicationWorkKind,
): boolean {
  const namespaces = record.authoritySet.namespaceRequirements;
  const domains = record.authoritySet.domainRequirements;
  if (workKind === "task.cancel_result" || workKind === "task.deliver_message") {
    const namespace = namespaces[0];
    const domain = domains[0];
    return namespaces.length === 1 && domains.length === 1
      && namespace?.ordinal === 0 && domain?.ordinal === 0
      && namespace.domainId === domain.domainId
      && namespace.operations.length === 1 && namespace.operations[0] === "encrypt";
  }
  if (workKind !== "task.deliver_result" && workKind !== "task.delivery_wake") return false;
  const primary = namespaces.find(n => n.namespaceId === record.snapshot.namespaceId);
  const foreground = namespaces.filter(n => n.operations.includes("encrypt"));
  return primary !== undefined && primary.operations.includes("decrypt")
    && primary.domainId === record.domainId
    && foreground.length > 0
    && (workKind !== "task.deliver_result" || foreground.length === 1)
    && (workKind !== "task.delivery_wake" || foreground.some(n => n.operations.includes("decrypt"))
      && foreground.filter(n => n.operations.length === 1 && n.operations[0] === "encrypt").length <= 1)
    && namespaces.every(n => n.expectedPolicyRevision === record.expectedPolicyRevision
      && (n.namespaceId === primary.namespaceId
        ? n.operations.length === 1 && n.operations[0] === "decrypt"
          || n.operations.length === 2 && n.operations[0] === "decrypt" && n.operations[1] === "encrypt"
        : workKind === "task.deliver_result"
          ? n.operations.length === 1 && n.operations[0] === "encrypt"
          : n.operations.length === 1 && n.operations[0] === "encrypt"
            || n.operations.length === 2 && n.operations[0] === "decrypt" && n.operations[1] === "encrypt"));
}

/** Shared one-use publication lifecycle; each closed owner supplies its proof and grant opener. */
export function createProtectedTaskPublicationClaim<Plan extends PublicationPlan>(
  dependencies: TaskPublicationClaimDependencies<Plan>,
) {
  const cancellationRecord = (record: BackgroundAuthorizationRecord | null): record is BackgroundAuthorizationTaskRuntimeRecordV3 => publicationRecord(record, dependencies.workKind);
  const now = dependencies.now ?? Date.now;
  const createClaimId = dependencies.claimId ?? randomUUID;

  return async (
    input: TaskPublicationClaimInput<Plan>,
  ): Promise<BackgroundAuthorizationTaskRuntimeRecordV3 | null> => {
    const coordinates = dependencies.coordinates(input.plan);
    const selected = parseBackgroundAuthorizationRecord(input.record);
    if (!cancellationRecord(selected)
      || selected.snapshot.state !== "grant_ready"
      || !dependencies.matchesPlan(selected, input.plan)
      || selected.descriptorBytes === null) return null;
    const accepted = acceptedTaskRuntimeRecord(selected);
    if (accepted === null) return null;
    if (!isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(
      selected.descriptorBytes,
    )) {
      destroyAcceptedTaskRuntimeRecord(accepted);
      return null;
    }
    const certifiedRequest = decodeTaskRuntimeBackgroundAuthorizationRequestV3(
      { hash: value => new Uint8Array(createHash("sha256").update(value).digest()) },
      selected.descriptorBytes,
    );
    if (certifiedRequest === null) {
      destroyAcceptedTaskRuntimeRecord(accepted);
      return null;
    }
    const request = certifiedRequest.baseRequest;
    const recipient = selected.snapshot.recipient;
    const material = selected.acceptedMaterial;
    const wrappedResponse = material === null ? null
      : decodeTaskRuntimeBackgroundAuthorizationResponseV2(
        material.responseBytes,
      );
    const namespace = selected.authoritySet.namespaceRequirements[0];
    const domain = selected.authoritySet.domainRequirements[0];
    const claimId = createClaimId();
    const lifecycle: {
      publicAuthority: ReturnType<typeof copyProtectedTaskRuntimeAuthority> | null;
      runningRecord: BackgroundAuthorizationTaskRuntimeRecordV3 | null;
    } = { publicAuthority: null, runningRecord: null };
    try {
      if (recipient === null || material === null || wrappedResponse === null
        || namespace === undefined
        || domain === undefined
        || certifiedRequest.work.kind !== dependencies.workKind
        || !sameBytes(certifiedRequest.work.workIdentityHash, selected.workIdentityHash)
        || !publicationAuthorityShape(selected, dependencies.workKind)
        || request.requestId !== selected.snapshot.requestId
        || request.workId !== coordinates.workId
        || request.workKind !== dependencies.workKind
        || request.workPurpose !== dependencies.workKind
        || request.sourceRoomId !== input.plan.sourceRoomId
        || request.recipientGeneration !== selected.snapshot.recipientGeneration
        || request.recipientKeyId !== recipient.recipientKeyId
        || request.deadlineAt !== recipient.expiresAt
        || accepted.requestId !== request.requestId
        || accepted.recipientGeneration !== request.recipientGeneration
        || accepted.recipientKeyId !== request.recipientKeyId) return null;
      input.signal.throwIfAborted();
      const subject = Object.freeze({
        userId: coordinates.requesterUserId,
        humanActorId: accepted.issuingHumanId,
        deviceId: accepted.issuingDeviceId,
      });
      let scopedRepository: Repository | null = null;
      const assertScopedRunning = async () => {
        input.signal.throwIfAborted();
        const expected = lifecycle.runningRecord;
        const repository = scopedRepository;
        if (expected === null || repository === null
          || !exactRunningRecord(
            await repository.get(expected.snapshot.requestId),
            expected,
            claimId,
            now(),
            dependencies.workKind,
          )) throw new Error("Cancellation result claim is no longer current");
      };
      const held = await dependencies.withAccepted({
        plan: input.plan,
        subject,
        accepted,
        restricted: input.restricted,
        signal: input.signal,
        validateBeforeCommit: async () => {
          input.signal.throwIfAborted();
          // The owner invokes this once before lending its scoped connection.
          if (lifecycle.runningRecord !== null) await assertScopedRunning();
        },
        use: async (current, _product, restricted) => {
          scopedRepository = await dependencies.repository(restricted);
          const loaded = await scopedRepository.get(selected.snapshot.requestId);
          if (!cancellationRecord(loaded)
            || loaded.snapshot.state !== "grant_ready"
            || !sameBackgroundAuthorizationRecord(loaded, selected)) return null;
          const claimedAt = now();
          if (!Number.isSafeInteger(claimedAt)
            || claimedAt < request.issuedAt
            || claimedAt >= request.deadlineAt
            || claimedAt >= recipient.expiresAt
            || claimedAt >= material.authorizationExpiresAt) return null;
          const claimed = parseBackgroundAuthorizationRecord({
            ...loaded,
            snapshot: claimTaskRuntimeBackgroundAuthorizationRequest(
              loaded.snapshot,
              { claimId, now: claimedAt,
                requestDeadlineAt: request.deadlineAt,
                authorizationExpiresAt: material.authorizationExpiresAt },
            ),
          });
          if (!cancellationRecord(claimed)) {
            throw new TypeError("Cancellation claim changed credential family");
          }
          const claimedResult = await scopedRepository.compareAndSwap({
            expectedRequestRevision: loaded.snapshot.requestRevision,
            next: claimed,
          });
          if (claimedResult.status !== "updated"
            || !sameBackgroundAuthorizationRecord(claimedResult.record, claimed)) return null;
          const runningAt = now();
          if (!Number.isSafeInteger(runningAt)
            || runningAt < claimedAt
            || claimed.snapshot.claimExpiresAt === null
            || runningAt >= claimed.snapshot.claimExpiresAt) {
            throw new Error("Cancellation result claim expired before start");
          }
          const running = parseBackgroundAuthorizationRecord({
            ...claimed,
            snapshot: markBackgroundAuthorizationRunning(
              claimed.snapshot,
              runningAt,
            ),
          });
          if (!cancellationRecord(running)) {
            throw new TypeError("Cancellation start changed credential family");
          }
          const runningResult = await scopedRepository.compareAndSwap({
            expectedRequestRevision: claimed.snapshot.requestRevision,
            next: running,
          });
          if (runningResult.status !== "updated"
            || !sameBackgroundAuthorizationRecord(runningResult.record, running)) {
            throw new Error("Cancellation result start could not be recorded");
          }
          lifecycle.runningRecord = running;
          await assertScopedRunning();
          lifecycle.publicAuthority = copyProtectedTaskRuntimeAuthority(current, false);
          return true;
        },
      });
      const runningRecord = lifecycle.runningRecord;
      const publicAuthority = lifecycle.publicAuthority;
      if (held !== true || runningRecord === null || publicAuthority === null) return null;

      const rootRepository = await dependencies.repository(input.restricted);
      const assertCurrentClaim = async () => {
        input.signal.throwIfAborted();
        if (!exactRunningRecord(
          await rootRepository.get(runningRecord.snapshot.requestId),
          runningRecord,
          claimId,
          now(),
          dependencies.workKind,
        )) throw new Error("Cancellation result claim is no longer current");
      };
      await assertCurrentClaim();
      const claimExpiresAt = runningRecord.snapshot.claimExpiresAt;
      if (claimExpiresAt === null) {
        throw new Error("Cancellation result claim expiry is unavailable");
      }
      const currentIssuer = publicAuthority.currentIssuer;
      if (currentIssuer === undefined) return null;
      const certifiedSigning: PublicationSigningBase = Object.freeze({
        requestBytes: Uint8Array.from(selected.descriptorBytes),
        certificateBytes: Uint8Array.from(wrappedResponse.certificateBytes),
        currentIssuer: copyIssuer(currentIssuer),
      });
      let opened: Awaited<ReturnType<typeof dependencies.openGrant>>;
      try {
        opened = await dependencies.openGrant({ plan: input.plan, request,
          certifiedSigning,
          authorizationBytes: wrappedResponse.authorizationBytes,
          record: runningRecord,
          claimId, claimExpiresAt, authority: publicAuthority, signal: input.signal,
          assertCurrentClaim });
      } finally {
        destroyPublicationSigningBase(certifiedSigning);
      }
      if (opened === false) throw new Error("Task publication authorization could not be opened");
      if (opened !== true) {
        const parked = opened.record;
        const stored = await rootRepository.get(runningRecord.snapshot.requestId);
        if (dependencies.workKind !== "task.delivery_wake" || opened.status !== "parked"
          || !cancellationRecord(stored) || !sameBackgroundAuthorizationRecord(stored, parked)
          || parked.workKind !== "task.delivery_wake" || parked.purpose !== "task.delivery_wake"
          || parked.snapshot.requestId !== runningRecord.snapshot.requestId
          || parked.snapshot.workId !== runningRecord.snapshot.workId
          || parked.snapshot.namespaceId !== runningRecord.snapshot.namespaceId
          || !isDeepStrictEqual(parked.snapshot.credentialSubject, runningRecord.snapshot.credentialSubject)
          || parked.idempotencyKey !== runningRecord.idempotencyKey
          || parked.expectedPolicyRevision < runningRecord.expectedPolicyRevision
          || parked.snapshot.requestRevision <= runningRecord.snapshot.requestRevision
          || parked.snapshot.recipientGeneration <= runningRecord.snapshot.recipientGeneration
          || parked.snapshot.state !== "awaiting_recipient" || parked.finishedAt !== null
          || parked.acceptedMaterial !== null || parked.snapshot.claimId !== null
          || parked.snapshot.recipient !== null) throw new Error("Task wake park transition is not current");
        return parked;
      }
      await assertCurrentClaim();
      const completedAt = now();
      if (!Number.isSafeInteger(completedAt)
        || runningRecord.snapshot.claimExpiresAt === null
        || completedAt < runningRecord.snapshot.updatedAt
        || completedAt >= runningRecord.snapshot.claimExpiresAt) {
        throw new Error("Cancellation result claim expired before completion");
      }
      const completed = parseBackgroundAuthorizationRecord({
        ...runningRecord,
        snapshot: completeBackgroundAuthorizationRequest(
          runningRecord.snapshot,
          completedAt,
        ),
        finishedAt: completedAt,
      });
      if (!cancellationRecord(completed)) {
        throw new TypeError("Cancellation completion changed credential family");
      }
      let stored: BackgroundAuthorizationRecord | null;
      try {
        const result = await rootRepository.compareAndSwap({
          expectedRequestRevision: runningRecord.snapshot.requestRevision,
          next: completed,
        });
        stored = result.status === "updated" ? result.record : result.current;
      } catch {
        stored = await rootRepository.get(completed.snapshot.requestId);
      }
      if (!cancellationRecord(stored)
        || !sameBackgroundAuthorizationRecord(stored, completed)) {
        throw new Error("Cancellation result completion could not be recorded");
      }
      dependencies.recipients.delete(
        completed.snapshot.requestId,
        completed.snapshot.recipientGeneration,
      );
      return completed;
    } finally {
      if (lifecycle.publicAuthority !== null) {
        destroyProtectedTaskRuntimeAuthority(lifecycle.publicAuthority);
      }
      wrappedResponse?.authorizationBytes.fill(0);
      wrappedResponse?.certificateBytes.fill(0);
      destroyTaskRuntimeBackgroundAuthorizationRequestV3(certifiedRequest);
      destroyAcceptedTaskRuntimeRecord(accepted);
    }
  };
}

function copyIssuer(
  issuer: BackgroundAuthorizationIssuerV2,
): BackgroundAuthorizationIssuerV2 {
  return Object.freeze({
    ...issuer,
    headDigest: Uint8Array.from(issuer.headDigest),
    signingPublicKeyHash: Uint8Array.from(issuer.signingPublicKeyHash),
  });
}

function destroyPublicationSigningBase(value: PublicationSigningBase): void {
  value.requestBytes.fill(0);
  value.certificateBytes.fill(0);
  value.currentIssuer.headDigest.fill(0);
  value.currentIssuer.signingPublicKeyHash.fill(0);
}
