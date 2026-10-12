import { createHash } from "node:crypto";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import type { TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import {
  matchesCurrentTaskRuntimeAuthority, matchesStenographerRequestAdmission,
  type CurrentDeviceAdmissionAuthority,
} from "@nautilo/lattice-bridge/server";
import {
  attachBackgroundAuthorizationRecipient, parseBackgroundAuthorizationRecord,
  sameTaskRuntimeAuthorityPlan,
  type BackgroundAuthorizationRecord, type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type BindTaskRuntimeRecipientResult,
} from "@nautilo/runtime";
import type { createProductionBackgroundAuthorizationComposition } from "./background-authorization-composition";
import type { ProtectedTaskCancellationAuthorityPort } from "./protected-task-cancellation-authority";
import type { ProtectedTaskCancellationPlan } from "./protected-task-cancellation-plan";

type DeviceHooks = Required<Pick<NonNullable<Parameters<
  typeof createProductionBackgroundAuthorizationComposition
>[0]>, "bindTaskRecipient" | "withTaskAuthority" | "isTaskRecipientActive">>;

export type ProtectedTaskCancellationDeviceAuthorizationInput = Readonly<{
  recipients: TaskRuntimeRecipientRegistry;
  authority: ProtectedTaskCancellationAuthorityPort;
  resolvePlan(record: BackgroundAuthorizationTaskRuntimeRecordV3): Promise<ProtectedTaskCancellationPlan | null>;
  repository(restricted: PostgresJsBridgeConnection): Promise<Pick<
    BackgroundAuthorizationTaskRuntimeReplacementRepository, "get" | "compareAndSwap">>;
  now?: () => number;
}>;

function cancellationRecord(record: BackgroundAuthorizationRecord): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.workKind === "task.cancel_result" && record.purpose === "task.cancel_result";
}

function exactPlan(record: BackgroundAuthorizationTaskRuntimeRecordV3, plan: ProtectedTaskCancellationPlan): boolean {
  return cancellationRecord(record) && cancellationRecord(plan.initialRecord)
    && record.snapshot.workId === plan.intent.taskRunId
    && record.snapshot.namespaceId === plan.intent.contentNamespaceId
    && record.expectedPolicyRevision === plan.intent.policyRevision
    && record.idempotencyKey === plan.initialRecord.idempotencyKey
    && sameTaskRuntimeAuthorityPlan(record, plan.initialRecord);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Dark stopped-result hooks, with no execution occurrence or Job admission. */
export function createProtectedTaskCancellationDeviceAuthorization(
  input: ProtectedTaskCancellationDeviceAuthorizationInput,
): DeviceHooks {
  const recipients = input.recipients;
  const authority = input.authority;
  const resolvePlan = input.resolvePlan;
  const repository = input.repository;
  const now = input.now ?? Date.now;
  const isTaskRecipientActive: DeviceHooks["isTaskRecipientActive"] = record => {
    const recipient = record.snapshot.recipient;
    return cancellationRecord(record) && recipient !== null
      && now() < recipient.expiresAt && recipients.hasAttempt({
        requestId: record.snapshot.requestId, workId: record.snapshot.workId,
        recipientGeneration: record.snapshot.recipientGeneration,
        recipientKeyId: recipient.recipientKeyId,
      });
  };

  return Object.freeze({
    isTaskRecipientActive,
    bindTaskRecipient: async operation => {
      const selected = parseBackgroundAuthorizationRecord(operation.record);
      const subject = Object.freeze({ ...operation.subject });
      const admission = Object.freeze({ ...operation.admission, headDigest: operation.admission.headDigest.slice() });
      let attached: BindTaskRuntimeRecipientResult = null;
      let created: Readonly<{ requestId: string; generation: number }> | null = null;
      let retain = false;
      const clearAttempt = () => {
        if (created !== null) recipients.delete(created.requestId, created.generation);
        attached?.requestBytes.fill(0);
      };
      try {
        if (!cancellationRecord(selected) || selected.snapshot.state !== "awaiting_recipient"
          || selected.snapshot.recipient !== null || selected.descriptorBytes !== null
          || selected.snapshot.descriptorDigest !== null
          || !matchesStenographerRequestAdmission(admission, operation.device, now())) return null;
        const plan = await resolvePlan(selected);
        if (plan === null || !exactPlan(selected, plan)
          || subject.userId !== plan.intent.requesterUserId) return null;
        let currentDevice: CurrentDeviceAdmissionAuthority | null = null;
        let used = false;
        const bound = await authority.withDiscovery({
          intent: plan.intent, subject, restricted: operation.restricted,
          validateBeforeCommit: () => {
            if (attached === null) return;
            if (currentDevice === null || !isTaskRecipientActive(attached.record)
              || !matchesStenographerRequestAdmission(admission, currentDevice, now())) {
              throw new Error("Cancellation recipient authority expired before commit");
            }
          },
          use: async current => {
            if (used) throw new TypeError("Cancellation recipient binder is one-use");
            used = true;
            currentDevice = current.device;
            if (!matchesStenographerRequestAdmission(admission, current.device, now())) return null;
            const scoped = await repository(current.restricted);
            const loaded = await scoped.get(selected.snapshot.requestId);
            if (loaded === null || !cancellationRecord(loaded) || !exactPlan(loaded, plan)
              || loaded.snapshot.requestRevision !== selected.snapshot.requestRevision
              || loaded.snapshot.state !== "awaiting_recipient" || loaded.snapshot.recipient !== null
              || loaded.snapshot.descriptorDigest !== null || loaded.descriptorBytes !== null) return null;
            const at = now();
            const expected = plan.recipientAttempt({ record: loaded, now: at });
            const attempt = await recipients.createAttempt({ requestId: loaded.snapshot.requestId,
              workId: loaded.snapshot.workId, recipientGeneration: loaded.snapshot.recipientGeneration,
              recipientKeyId: expected.recipientKeyId, expiresAt: expected.expiresAt });
            if (attempt.status !== "created") return null;
            created = { requestId: loaded.snapshot.requestId, generation: loaded.snapshot.recipientGeneration };
            const request = plan.buildRequest({ record: loaded, attempt: attempt.attempt, binding: subject, authority: current });
            const grant = parseDomainForegroundAuthorizationPlanV2(request.authorizationPlanBytes);
            try {
              if (grant === null || request.workKind !== "task.cancel_result" || request.workPurpose !== "task.cancel_result"
                || request.requestId !== loaded.snapshot.requestId || request.workId !== plan.intent.taskRunId
                || request.sourceRoomId !== plan.sourceRoomId || current.sourceRoomId !== plan.sourceRoomId
                || request.recipientGeneration !== loaded.snapshot.recipientGeneration
                || request.recipientKeyId !== attempt.attempt.recipientKeyId
                || request.deadlineAt !== attempt.attempt.expiresAt
                || !sameBytes(request.recipientPublicKey, attempt.attempt.recipientPublicKey)
                || !matchesCurrentTaskRuntimeAuthority({ request, plan: grant, subject, admission,
                  device: current.device, namespaces: current.namespaceRequirements,
                  domainRequirements: loaded.authoritySet.domainRequirements,
                  domains: current.domains, policyRevision: current.policyRevision, now: now() })) {
                throw new TypeError("Cancellation recipient request was substituted");
              }
              const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
              const descriptorDigest = digest(descriptorBytes);
              const next: BackgroundAuthorizationTaskRuntimeRecordV3 = { ...loaded,
                snapshot: attachBackgroundAuthorizationRecipient(loaded.snapshot, {
                  recipientGeneration: loaded.snapshot.recipientGeneration, descriptorDigest,
                  recipientKeyId: attempt.attempt.recipientKeyId,
                  recipientPublicKey: Buffer.from(attempt.attempt.recipientPublicKey).toString("base64url"),
                  expiresAt: attempt.attempt.expiresAt, now: at,
                }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"], descriptorBytes };
              const result = await scoped.compareAndSwap({ expectedRequestRevision: loaded.snapshot.requestRevision, next });
              if (result.status !== "updated") return null;
              const stored = result.record;
              const recipient = stored.snapshot.recipient;
              if (!cancellationRecord(stored) || !exactPlan(stored, plan)
                || stored.snapshot.state !== "awaiting_device"
                || stored.snapshot.requestRevision !== next.snapshot.requestRevision
                || stored.snapshot.recipientGeneration !== loaded.snapshot.recipientGeneration
                || stored.snapshot.descriptorDigest !== descriptorDigest || stored.descriptorBytes === null
                || !sameBytes(stored.descriptorBytes, descriptorBytes) || recipient === null
                || recipient.recipientKeyId !== attempt.attempt.recipientKeyId
                || recipient.recipientPublicKey !== Buffer.from(attempt.attempt.recipientPublicKey).toString("base64url")
                || recipient.expiresAt !== attempt.attempt.expiresAt) {
                throw new TypeError("Cancellation recipient binding was substituted");
              }
              if (now() < at || !isTaskRecipientActive(stored)
                || !matchesStenographerRequestAdmission(admission, current.device, now())) {
                throw new Error("Cancellation recipient expired before commit");
              }
              attached = Object.freeze({ record: stored, requestBytes: descriptorBytes.slice() });
              return attached;
            } finally {
              if (grant !== null) destroyDomainForegroundAuthorizationPlanV2(grant);
              destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
            }
          },
        });
        if (bound !== attached) {
          if (bound !== null) throw new TypeError("Cancellation recipient owner changed its receipt");
          return null;
        }
        retain = bound !== null;
        return bound;
      } finally {
        admission.headDigest.fill(0);
        if (!retain) clearAttempt();
      }
    },
    withTaskAuthority: async operation => {
      const selected = parseBackgroundAuthorizationRecord(operation.record);
      const subject = Object.freeze({ ...operation.subject });
      const admission = Object.freeze({ ...operation.admission, headDigest: operation.admission.headDigest.slice() });
      try {
        if (!cancellationRecord(selected) || !isTaskRecipientActive(selected)
          || !["awaiting_device", "grant_ready"].includes(selected.snapshot.state)
          || selected.descriptorBytes === null || digest(selected.descriptorBytes) !== selected.snapshot.descriptorDigest) return null;
        const plan = await resolvePlan(selected);
        if (plan === null || !exactPlan(selected, plan) || subject.userId !== plan.intent.requesterUserId) return null;
        const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(selected.descriptorBytes);
        if (request === null) return null;
        try {
          const recipient = selected.snapshot.recipient;
          if (recipient === null || request.requestId !== selected.snapshot.requestId
            || request.workId !== plan.intent.taskRunId || request.workKind !== "task.cancel_result"
            || request.workPurpose !== "task.cancel_result" || request.sourceRoomId !== plan.sourceRoomId
            || request.recipientGeneration !== selected.snapshot.recipientGeneration
            || request.recipientKeyId !== recipient.recipientKeyId || request.deadlineAt !== recipient.expiresAt
            || Buffer.from(request.recipientPublicKey).toString("base64url") !== recipient.recipientPublicKey) return null;
          let used = false;
          return await authority.withBound({ intent: plan.intent, subject, admission, request,
            namespaceRequirements: selected.authoritySet.namespaceRequirements,
            domainRequirements: selected.authoritySet.domainRequirements, restricted: operation.restricted,
            use: async (current, _product, scoped) => {
              if (used) throw new TypeError("Cancellation bound authority is one-use");
              used = true;
              if (!isTaskRecipientActive(selected)
                || !matchesStenographerRequestAdmission(admission, current.device, now())) return null;
              const value = await operation.use(request, current.plan, current.domains, current.device, scoped);
              if (!isTaskRecipientActive(selected)
                || !matchesStenographerRequestAdmission(admission, current.device, now())) {
                throw new Error("Cancellation device authority expired before commit");
              }
              return value;
            },
          });
        } finally { destroyTaskRuntimeBackgroundAuthorizationRequestV1(request); }
      } finally { admission.headDigest.fill(0); }
    },
  });
}
