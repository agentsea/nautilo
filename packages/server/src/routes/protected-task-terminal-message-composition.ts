import {
  eq, getEncryptionTransitionPolicy, insertOrAdoptProtectedTaskWakeJob,
  listProtectedTaskRunOutputBindingsNeedingDelivery, taskRuns,
  type DirectDatabase, type PostgresJsBridgeConnection,
  type ProtectedTaskRunOutputRecoveryCursor,
} from "@nautilo/db";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { verifyCryptoPostgresHandle } from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto, TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import { PostgresBackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import { createProtectedTaskPublicationDeviceAuthorization } from "./protected-task-cancellation-device-authorization";
import { createProtectedTaskTerminalMessageAuthorityPort } from "./protected-task-terminal-message-authority";
import { createProtectedTaskTerminalMessageClaim } from "./protected-task-terminal-message-claim";
import { createProtectedTaskTerminalMessagePreparation } from "./protected-task-terminal-message-preparation";
import { createProtectedTaskTerminalMessagePublication } from "./protected-task-terminal-message-publication";
import { createProtectedTaskTerminalMessageRecovery } from "./protected-task-terminal-message-recovery";
import { createProtectedTaskTerminalMessageSettlement } from "./protected-task-terminal-message-settlement";
import type { ProtectedTaskAuthorizationRequested } from
  "./protected-task-authorization-requested";

type Repository = Pick<PostgresBackgroundAuthorizationRepository, "get" | "compareAndSwap">;
type Dependencies = Readonly<{
  preparation: ReturnType<typeof createProtectedTaskTerminalMessagePreparation>;
  claim: ReturnType<typeof createProtectedTaskTerminalMessageClaim>;
  recovery: ReturnType<typeof createProtectedTaskTerminalMessageRecovery>;
  list: typeof listProtectedTaskRunOutputBindingsNeedingDelivery;
  readPolicy: typeof getEncryptionTransitionPolicy;
  scheduleWake: typeof insertOrAdoptProtectedTaskWakeJob;
  taskId(taskRunId: string): Promise<string | null>;
  repository(connection: PostgresJsBridgeConnection): Promise<Repository>;
}>;

/** Shared protected-output observation and device exchange; Plain remains inactive. */
export function createProtectedTaskTerminalMessageComposition(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  serverScope: string;
  recipients: TaskRuntimeRecipientRegistry;
  recipientTtlMs: number;
  now?: () => number;
  authorizationRequested?: ProtectedTaskAuthorizationRequested | undefined;
  deliverResult?(coordinates: Readonly<{ taskId: string; taskRunId: string }>, signal: AbortSignal): Promise<"mapped" | "pending">;
}>, overrides: Partial<Dependencies> = {}) {
  const now = input.now ?? Date.now;
  const repository = overrides.repository ?? (async (connection: PostgresJsBridgeConnection) =>
    new PostgresBackgroundAuthorizationRepository(await verifyCryptoPostgresHandle(connection)));
  const authority = createProtectedTaskTerminalMessageAuthorityPort({
    db: input.db, crypto: input.crypto, serverScope: input.serverScope,
    restricted: () => input.restricted, now,
  });
  const preparation = overrides.preparation ?? createProtectedTaskTerminalMessagePreparation({
    ...input, restricted: () => input.restricted, now,
  });
  const recovery = overrides.recovery ?? createProtectedTaskTerminalMessageRecovery({
    ...input, now,
    settle: createProtectedTaskTerminalMessageSettlement({
      recipients: input.recipients, repository, now,
    }),
  });
  const hooks = createProtectedTaskPublicationDeviceAuthorization({
    workKind: "task.deliver_message", recipients: input.recipients,
    coordinates: plan => ({ workId: plan.intent.taskRunId,
      requesterUserId: plan.intent.requesterUserId,
      namespaceId: plan.intent.destinationNamespaceId, policyRevision: plan.publicationPolicyRevision }),
    authority: {
      withDiscovery: ({ plan, ...operation }) => authority.withDiscovery({
        ...operation, intent: plan.intent, publicationPolicyRevision: plan.publicationPolicyRevision }),
      withBound: ({ plan, ...operation }) => authority.withBound({
        ...operation, intent: plan.intent, publicationPolicyRevision: plan.publicationPolicyRevision }),
    },
    resolvePlan: preparation.resolvePlan, repository, now,
  });
  const claim = overrides.claim ?? createProtectedTaskTerminalMessageClaim({
    crypto: input.crypto, authority, recipients: input.recipients, repository, now,
    publish: createProtectedTaskTerminalMessagePublication({ ...input, authority,
      recover: recovery.recover }),
  });
  const taskId = overrides.taskId ?? (async (taskRunId: string) => {
    const [run] = await input.db.select({ taskId: taskRuns.taskId }).from(taskRuns)
      .where(eq(taskRuns.id, taskRunId)).limit(1);
    return run?.taskId ?? null;
  });
  return Object.freeze({ ...hooks,
    async recoverPage(options: Readonly<{
      limit: number;
      after?: ProtectedTaskRunOutputRecoveryCursor;
      signal?: AbortSignal;
    }>): Promise<Readonly<{ attempted: number; published: number; wakesScheduled: number;
      pending: number; failures: number; next?: ProtectedTaskRunOutputRecoveryCursor }>> {
      if ((await (overrides.readPolicy ?? getEncryptionTransitionPolicy)(input.db)).mode === "plaintext_only") {
        return Object.freeze({ attempted: 0, published: 0, wakesScheduled: 0, pending: 0, failures: 0 });
      }
      const signal = options.signal ?? new AbortController().signal;
      const page = await (overrides.list ?? listProtectedTaskRunOutputBindingsNeedingDelivery)(
        input.db, options.limit, options.after);
      let published = 0;
      let wakesScheduled = 0;
      let pending = 0;
      let failures = 0;
      for (const binding of page) {
        signal.throwIfAborted();
        try {
          const id = await taskId(binding.taskRunId);
          if (id === null || binding.resultAttachedAt === null) { pending += 1; continue; }
          const coordinates = { taskId: id, taskRunId: binding.taskRunId };
          if (binding.messageOperationId !== null && binding.messagePublishedAt === null) {
            // Revision 2 has a fixed terminal notice, so it needs no private
            // result read. Other result bodies enter their own read owner.
            if (binding.resultRevision !== 2) {
              if (await input.deliverResult?.(coordinates, signal) !== "mapped") { pending += 1; continue; }
              published += 1;
            } else {
            const recovered = await recovery.recoverCoordinates(coordinates);
            if (recovered === "pending" || recovered === "quarantined") { pending += 1; continue; }
            if (recovered === "mapped") published += 1;
            else {
              const prepared = await preparation.prepare(coordinates);
              if (prepared.status !== "created" && prepared.status !== "exact_replay") { pending += 1; continue; }
              const record = await (await repository(input.restricted)).get(prepared.plan.initialRecord.snapshot.requestId);
              if (record?.snapshot.formatVersion !== 3 || record.workKind !== "task.deliver_message"
                || record.purpose !== "task.deliver_message" || record.snapshot.state !== "grant_ready") {
                pending += 1; continue;
              }
              if (await claim({ plan: prepared.plan, record: record as BackgroundAuthorizationTaskRuntimeRecordV3,
                restricted: input.restricted, signal }) === null) { pending += 1; continue; }
              published += 1;
            }
            }
          }
          if (binding.wakeOperationId !== null && binding.wakeScheduledAt === null) {
            const wake = await (overrides.scheduleWake ?? insertOrAdoptProtectedTaskWakeJob)(input.db, coordinates);
            if (wake.status === "rejected") pending += 1;
            else wakesScheduled += 1;
          }
        } catch { signal.throwIfAborted(); failures += 1; }
      }
      const last = page.at(-1);
      return Object.freeze({ attempted: page.length, published, wakesScheduled, pending, failures,
        ...(last === undefined || page.length < options.limit ? {} : {
          next: { acceptedAt: last.acceptedAt, taskRunId: last.taskRunId },
        }),
      });
    },
  });
}
