import type { DirectDatabase, PostgresJsBridgeConnection } from "@nautilo/db";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { verifyCryptoPostgresHandle } from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto, TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import { PostgresBackgroundAuthorizationRepository } from "@nautilo/runtime";
import { createProtectedTaskPublicationDeviceAuthorization } from "./protected-task-cancellation-device-authorization";
import { createProtectedTaskOutputReadAuthorityPort,
  type ProtectedTaskWakeForegroundAdmission, type ProtectedTaskOutputReadAuthorityPort } from "./protected-task-output-read-authority";
import { createProtectedTaskOutputReadPreparation } from "./protected-task-output-read-preparation";
import { createProtectedTaskOutputReadClaim, type ProtectedTaskOutputReadPublication } from "./protected-task-output-read-claim";
import { createProtectedTaskRunResultMessagePublication } from "./protected-task-run-result-message-publication";
import { createProtectedTaskRunResultMessageRecovery } from "./protected-task-run-result-message-recovery";
import type { BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import type { ProtectedTaskAuthorizationRequested } from "./protected-task-authorization-requested";

/** Raw result reads and foreground wakes use fresh, independently admitted grants. */
export function createProtectedTaskOutputReadComposition(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  serverScope: string;
  recipients: TaskRuntimeRecipientRegistry;
  recipientTtlMs: number;
  authorizationRequested?: ProtectedTaskAuthorizationRequested | undefined;
  canonicalWakeForegroundAdmission?: ProtectedTaskWakeForegroundAdmission;
  now?: () => number;
  createWakePublication?(authority: ProtectedTaskOutputReadAuthorityPort): ProtectedTaskOutputReadPublication;
}>) {
  const now = input.now ?? Date.now;
  const authority = createProtectedTaskOutputReadAuthorityPort({ ...input,
    restricted: () => input.restricted, now });
  const preparation = createProtectedTaskOutputReadPreparation({ ...input,
    authority, restricted: () => input.restricted, now });
  const repository = async (connection: PostgresJsBridgeConnection) =>
    new PostgresBackgroundAuthorizationRepository(await verifyCryptoPostgresHandle(connection));
  const hooks = (workKind: "task.deliver_result" | "task.delivery_wake") =>
    createProtectedTaskPublicationDeviceAuthorization({ workKind, recipients: input.recipients,
      coordinates: plan => ({ workId: plan.initialRecord.snapshot.workId,
        requesterUserId: plan.intent.requesterUserId, namespaceId: plan.intent.contentNamespaceId,
        policyRevision: plan.intent.expectedPolicyRevision }),
      authority: {
        withDiscovery: ({ plan, ...operation }) => authority.withDiscovery({ ...operation, intent: plan.intent }),
        withBound: ({ plan, ...operation }) => authority.withBound({ ...operation, intent: plan.intent }),
      }, resolvePlan: preparation.resolvePlan, repository, now,
    });
  const raw = hooks("task.deliver_result");
  const wake = hooks("task.delivery_wake");
  const selected = (workKind: string) => workKind === "task.delivery_wake" ? wake : raw;
  const recoverResultMessage = createProtectedTaskRunResultMessageRecovery(input);
  const rawClaim = createProtectedTaskOutputReadClaim({
    workKind: "task.deliver_result", authority, recipients: input.recipients, repository, now,
    publish: createProtectedTaskRunResultMessagePublication({ ...input, authority,
      recover: async coordinates => await recoverResultMessage(coordinates) === "mapped" ? "mapped" : "pending",
    }),
  });
  const wakeClaim = input.createWakePublication === undefined ? null : createProtectedTaskOutputReadClaim({
    workKind: "task.delivery_wake", authority, recipients: input.recipients, repository, now,
    publish: input.createWakePublication(authority),
    finishParkedWake: preparation.finishParkedWake,
  });
  return Object.freeze({
    authority, preparation,
    async executeWake(coordinates: Readonly<{ taskId: string; taskRunId: string }>,
      signal: AbortSignal): Promise<"completed" | "pending"> {
      if (wakeClaim === null) return "pending";
      const prepared = await preparation.prepare({ ...coordinates, kind: "wake" });
      if (prepared.status !== "created" && prepared.status !== "exact_replay") return "pending";
      const record = await (await repository(input.restricted)).get(prepared.plan.initialRecord.snapshot.requestId);
      if (record?.snapshot.formatVersion !== 3 || record.workKind !== "task.delivery_wake"
        || record.purpose !== "task.delivery_wake" || record.snapshot.state !== "grant_ready") return "pending";
      const completed = await wakeClaim({ plan: prepared.plan, record: record as BackgroundAuthorizationTaskRuntimeRecordV3,
        restricted: input.restricted, signal });
      return completed?.snapshot.state === "completed" ? "completed" : "pending";
    },
    async deliverResult(coordinates: Readonly<{ taskId: string; taskRunId: string }>,
      signal: AbortSignal): Promise<"mapped" | "pending"> {
      // Receipt recovery precedes grant planning and remains usable after the
      // temporary read recipient and authorization request have been released.
      const recovered = await recoverResultMessage(coordinates);
      if (recovered === "mapped") return "mapped";
      if (recovered !== "missing") return "pending";
      const prepared = await preparation.prepare({ ...coordinates, kind: "raw" });
      if (prepared.status !== "created" && prepared.status !== "exact_replay") return "pending";
      const record = await (await repository(input.restricted)).get(prepared.plan.initialRecord.snapshot.requestId);
      if (record?.snapshot.formatVersion !== 3 || record.workKind !== "task.deliver_result"
        || record.purpose !== "task.deliver_result" || record.snapshot.state !== "grant_ready") return "pending";
      return await rawClaim({ plan: prepared.plan, record: record as BackgroundAuthorizationTaskRuntimeRecordV3,
        restricted: input.restricted, signal }) === null ? "pending" : "mapped";
    },
    bindTaskRecipient: ((operation) => selected(operation.record.workKind).bindTaskRecipient(operation)) as typeof raw.bindTaskRecipient,
    withTaskAuthority: ((operation) => selected(operation.record.workKind).withTaskAuthority(operation)) as typeof raw.withTaskAuthority,
    isTaskRecipientActive: ((record) => selected(record.workKind).isTaskRecipientActive(record)) as typeof raw.isTaskRecipientActive,
  });
}
