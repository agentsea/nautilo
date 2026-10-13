import { protectedTaskDefinitionSupportsPolicy } from "@nautilo/db";
import { getEncryptionTransitionPolicy, type DirectDatabase, type PostgresJsBridgeConnection } from "@nautilo/db";
import type { LatticeCrypto, TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import { readVerifiedTaskDefinitionAccessLineage, readVerifiedForegroundTaskDefinitionAccessRevision, refreshHumanMappedTaskContentAccessHead, type StenographerRequestAdmission,
  type HumanTaskMappedContentAuthorityInput } from "@nautilo/lattice-bridge/server";
import { PostgresBackgroundAuthorizationRepository, sameTaskRuntimeAuthorityPlan, taskRuntimeStableIdempotencyKey,
  type BackgroundAuthorizationTaskRuntimeRecordV3, type TaskRuntimeGrantStableIdentity,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type BackgroundAuthorizationTaskMappedHeadReplacementRepository,
  type ProtectedTaskOccurrence } from "@nautilo/runtime";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import { createProtectedTaskRuntimeAccessLineageReader } from "./protected-task-runtime-access-lineage";
import { createProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";

export type ProtectedTaskRuntimeMappedHeadPlan = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  stableIdentity: TaskRuntimeGrantStableIdentity;
  initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3;
}>;
export type ProtectedTaskRuntimeMappedHeadReplan = (input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  admission: StenographerRequestAdmission;
  restricted: PostgresJsBridgeConnection;
  /** Re-enters the ordinary canonical planner only after the first repair commits. */
  resolvePlan(): Promise<ProtectedTaskRuntimeMappedHeadPlan | null>;
}>) => Promise<"unchanged" | "retry" | "unavailable">;

type Dependencies = Readonly<{
  repair: typeof refreshHumanMappedTaskContentAccessHead;
  readLineage: (occurrence: ProtectedTaskOccurrence, humanId: string, restricted: PostgresJsBridgeConnection) => ReturnType<ReturnType<typeof createProtectedTaskRuntimeAccessLineageReader>>;
  readPolicy: (db: DirectDatabase) => Promise<Pick<Awaited<ReturnType<typeof getEncryptionTransitionPolicy>>, "mode" | "revision">>;
  privateRoom: ReturnType<typeof createProtectedTaskRequesterPrivateRoomResolver>;
  productContext: typeof createHumanProductTransactionContext;
  repository: (input: Parameters<NonNullable<Parameters<typeof refreshHumanMappedTaskContentAccessHead>[0]["withMappedHead"]>>[0]) =>
    BackgroundAuthorizationTaskMappedHeadReplacementRepository & BackgroundAuthorizationTaskRuntimeReplacementRepository;
}>;

/** Each phase commits before the next owner starts; no nested product planner under crypto locks. */
export function createProtectedTaskRuntimeMappedHeadReplan(input: Readonly<{
  db: DirectDatabase; crypto: LatticeCrypto; serverScope: string;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">; now?: () => number;
}>, overrides: Partial<Dependencies> = {}): ProtectedTaskRuntimeMappedHeadReplan {
  const dependencies: Dependencies = { repair: refreshHumanMappedTaskContentAccessHead,
    readLineage: (occurrence, humanId, restricted) => createProtectedTaskRuntimeAccessLineageReader({
      db: input.db, crypto: input.crypto, restricted: () => restricted })({ occurrence }, humanId),
    readPolicy: getEncryptionTransitionPolicy, privateRoom: createProtectedTaskRequesterPrivateRoomResolver(input.db),
    productContext: createHumanProductTransactionContext,
    repository: held => new PostgresBackgroundAuthorizationRepository(held.context.handle), ...overrides };
  const now = input.now ?? Date.now;
  return async operation => {
    const selected = structuredClone(operation.record);
    const occurrence = structuredClone(operation.occurrence);
    const admission = { ...operation.admission, headDigest: Uint8Array.from(operation.admission.headDigest) };
    try {
      if (!["awaiting_recipient", "awaiting_device"].includes(selected.snapshot.state)) return "unchanged";
      if (admission.expiresAt <= now() || occurrence.task.requestorId !== admission.userId
        || selected.snapshot.workId !== occurrence.run.id
        || selected.snapshot.namespaceId !== occurrence.task.contentNamespaceId) return "unavailable";
      // Read-only descendants cannot change authority. An exact current plan needs no owned-Task repair.
      const currentLineage = await dependencies.readLineage(occurrence, admission.humanActorId, operation.restricted);
      if (currentLineage !== null) {
        const currentPlan = await operation.resolvePlan();
        if (currentPlan !== null && currentPlan.occurrence.task.id === occurrence.task.id
          && currentPlan.occurrence.run.id === occurrence.run.id
          && currentPlan.initialRecord.idempotencyKey === taskRuntimeStableIdempotencyKey(currentPlan.stableIdentity)
          && selected.idempotencyKey === currentPlan.initialRecord.idempotencyKey
          && sameTaskRuntimeAuthorityPlan(selected, currentPlan.initialRecord)) {
          readVerifiedTaskDefinitionAccessLineage(currentLineage, currentPlan.stableIdentity);
          return "unchanged";
        }
      }
      if (occurrence.task.ownerId !== admission.userId) return "unavailable";
      const policy = await dependencies.readPolicy(input.db);
      if (policy.mode === "plaintext_only" || !protectedTaskDefinitionSupportsPolicy(occurrence.task.contentRepresentation, policy.mode)) return "unavailable";
      const room = await dependencies.privateRoom(admission.userId, occurrence.task.agentId, occurrence.task.contentNamespaceId);
      if (room === null) return "unavailable";
      const product = await dependencies.productContext(admission.userId, input.db);
      const authority: HumanTaskMappedContentAuthorityInput = { runner: product.canonicalRunner,
        restricted: operation.restricted, crypto: input.crypto, serverScope: input.serverScope,
        coordinate: { kind: "definition", taskId: occurrence.task.id, contentRevision: occurrence.task.contentRevision },
        sourceRoomId: room.roomId, expectedPolicyRevision: policy.revision,
        subject: { userId: admission.userId, humanActorId: admission.humanActorId,
          admission: { ...admission, status: "admitted" } }, now };
      if (await dependencies.repair(authority) === "unavailable") return "unavailable";
      const fresh = await operation.resolvePlan();
      if (fresh === null || fresh.occurrence.task.id !== occurrence.task.id || fresh.occurrence.run.id !== occurrence.run.id
        || fresh.initialRecord.snapshot.requestId !== selected.snapshot.requestId) return "unavailable";
      const retired = new Set<number>();
      let outcome: "unchanged" | "retry" | "unavailable" = "unavailable";
      const repaired = await dependencies.repair({ ...authority, withMappedHead: async held => {
        if (held.lineage === null) throw new TypeError("Task replan requires a definition lineage");
        readVerifiedTaskDefinitionAccessLineage(held.lineage, fresh.stableIdentity);
        if (readVerifiedForegroundTaskDefinitionAccessRevision(held.proof, { lifecycle: held.lifecycle,
          currentAuthority: held.context.currentAuthority }) !== fresh.stableIdentity.contentAccessRevision) {
          throw new TypeError("Task mapped head advanced after fresh planning");
        }
        const repository = dependencies.repository(held);
        const current = await repository.get(selected.snapshot.requestId);
        if (current === null || current.snapshot.formatVersion !== 3 || current.snapshot.credentialSubject.kind !== "runtime"
          || current.snapshot.credentialSubject.runtimeKind !== "task" || current.authoritySet === undefined) return;
        const record = current as BackgroundAuthorizationTaskRuntimeRecordV3;
        if (!sameTaskRuntimeAuthorityPlan(record, fresh.initialRecord)) {
          const replaced = record.idempotencyKey === fresh.initialRecord.idempotencyKey
            ? await repository.replaceUnclaimedTaskRuntimeAuthority({ expected: record,
              replacement: fresh.initialRecord, now: now() })
            : await repository.replaceUnclaimedTaskMappedHeadAuthority({ expected: record,
              replacement: fresh.initialRecord, now: now(), stableIdentity: fresh.stableIdentity,
              proof: held.proof, lineage: held.lineage, lifecycle: held.lifecycle, currentAuthority: held.context.currentAuthority });
          if (replaced.status !== "replaced") throw new Error("Task Runtime request changed before replacement");
          if (record.snapshot.recipient !== null) retired.add(record.snapshot.recipientGeneration);
          outcome = "retry";
        } else {
          outcome = record.snapshot.requestRevision === selected.snapshot.requestRevision
            && sameTaskRuntimeAuthorityPlan(selected, fresh.initialRecord) ? "unchanged" : "retry";
        }
        if (selected.snapshot.recipient !== null && selected.snapshot.recipientGeneration < record.snapshot.recipientGeneration) {
          retired.add(selected.snapshot.recipientGeneration);
        }
        held.context.assertCurrent();
      } });
      if (repaired === "unavailable") return "unavailable";
      // The cryptographic CAS may commit before product; custody retires only after both owners return.
      for (const generation of retired) input.recipients.delete(selected.snapshot.requestId, generation);
      return outcome;
    } finally { admission.headDigest.fill(0); }
  };
}
