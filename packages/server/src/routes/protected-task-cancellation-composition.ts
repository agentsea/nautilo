import {
  listProtectedTaskCancellationOutputCandidates,
  type DirectDatabase, type PostgresJsBridgeConnection,
  type ProtectedTaskCancellationOutputDiscoveryCursor,
} from "@nautilo/db";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { verifyCryptoPostgresHandle } from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto, TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  PostgresBackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import { createProtectedTaskCancellationAuthorityPort } from "./protected-task-cancellation-authority";
import { createProtectedTaskCancellationClaim } from "./protected-task-cancellation-claim";
import { createProtectedTaskCancellationDeviceAuthorization } from "./protected-task-cancellation-device-authorization";
import { createProtectedTaskCancellationPreparation } from "./protected-task-cancellation-preparation";
import { createProtectedTaskCancellationSettlement } from "./protected-task-cancellation-settlement";
import { createProtectedTaskCancellationPublication } from "./protected-task-cancellation-publication";
import { createProtectedTaskCancellationPublicationRecovery } from "./protected-task-cancellation-publication-recovery";
import type { ProtectedTaskAuthorizationRequested } from
  "./protected-task-authorization-requested";

type Dependencies = Readonly<{
  preparation: ReturnType<typeof createProtectedTaskCancellationPreparation>;
  claim: ReturnType<typeof createProtectedTaskCancellationClaim>;
  list: typeof listProtectedTaskCancellationOutputCandidates;
  settle: Parameters<typeof createProtectedTaskCancellationPublicationRecovery>[0]["settle"];
  recover: ReturnType<typeof createProtectedTaskCancellationPublicationRecovery>;
  repository: (connection: PostgresJsBridgeConnection) => Promise<Pick<PostgresBackgroundAuthorizationRepository, "get" | "compareAndSwap">>;
}>;

/** Shared observer/device composition. Constructing it does not activate encryption. */
export function createProtectedTaskCancellationComposition(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  serverScope: string;
  recipients: TaskRuntimeRecipientRegistry;
  recipientTtlMs: number;
  now?: () => number;
  authorizationRequested?: ProtectedTaskAuthorizationRequested | undefined;
}>, overrides: Partial<Dependencies> = {}) {
  const now = input.now ?? Date.now;
  const repository = overrides.repository ?? (async (connection: PostgresJsBridgeConnection) =>
    new PostgresBackgroundAuthorizationRepository(await verifyCryptoPostgresHandle(connection)));
  const authority = createProtectedTaskCancellationAuthorityPort({
    db: input.db, crypto: input.crypto, serverScope: input.serverScope,
    restricted: () => input.restricted, now,
  });
  const preparation = overrides.preparation ?? createProtectedTaskCancellationPreparation({
    ...input, restricted: () => input.restricted, now,
  });
  const hooks = createProtectedTaskCancellationDeviceAuthorization({
    recipients: input.recipients, authority,
    resolvePlan: preparation.resolvePlan, repository, now,
  });
  const claim = overrides.claim ?? createProtectedTaskCancellationClaim({
    authority, recipients: input.recipients, repository, now,
    // This connection belongs to the composition, never an enclosing claim
    // transaction. Publication acquires its own current-authority transactions.
    publish: createProtectedTaskCancellationPublication({ ...input, authority, now }),
  });
  const settle: Dependencies["settle"] = overrides.settle ?? (async (coordinates, verifyStaged, context) =>
    createProtectedTaskCancellationSettlement({
      db: context.db, repository: await repository(context.restricted), recipients: input.recipients, now,
      deferRecipientCleanup: context.deferRecipientCleanup,
    })(coordinates, verifyStaged));
  const recover = overrides.recover ?? createProtectedTaskCancellationPublicationRecovery({ ...input, settle });
  return Object.freeze({
    ...hooks,
    async recoverPage(options: Readonly<{
      limit: number;
      after?: ProtectedTaskCancellationOutputDiscoveryCursor;
      signal?: AbortSignal;
    }>) {
      const signal = options.signal ?? new AbortController().signal;
      const page = await (overrides.list ?? listProtectedTaskCancellationOutputCandidates)(input.db, {
        limit: options.limit, throughTime: options.after?.throughTime ?? new Date(now()),
        ...(options.after === undefined ? {} : { cursor: options.after }),
      });
      let published = 0;
      let pending = 0;
      let failures = 0;
      for (const candidate of page.candidates) {
        signal.throwIfAborted();
        try {
          const recovery = await recover(candidate);
          if (recovery !== "missing") {
            if (recovery === "mapped") published += 1;
            else pending += 1;
            continue;
          }
          if (candidate.resultState === "mapped") { pending += 1; continue; }
          const prepared = await preparation.prepare(candidate);
          if (prepared.status !== "created" && prepared.status !== "exact_replay") {
            pending += 1;
            continue;
          }
          const stored = await (await repository(input.restricted))
            .get(prepared.plan.initialRecord.snapshot.requestId);
          if (stored?.snapshot.formatVersion !== 3 || stored.workKind !== "task.cancel_result"
            || stored.purpose !== "task.cancel_result"
            || stored.snapshot.credentialSubject.kind !== "runtime"
            || stored.snapshot.credentialSubject.runtimeKind !== "task"
            || stored.snapshot.credentialSubject.runtimeVersion !== 1
            || stored.snapshot.state !== "grant_ready") {
            pending += 1;
            continue;
          }
          const result = await claim({ plan: prepared.plan,
            record: stored as BackgroundAuthorizationTaskRuntimeRecordV3,
            restricted: input.restricted, signal });
          if (result === null) pending += 1;
          else published += 1;
        } catch {
          signal.throwIfAborted();
          failures += 1;
        }
      }
      return Object.freeze({ attempted: page.candidates.length, published, pending, failures,
        ...(page.next === null ? {} : { next: page.next }) });
    },
  });
}
