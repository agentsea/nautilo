import { and, eq, gt, inArray, isNull, resolveModelAttemptReplaySafety, roomJournalBatches,
  roomJournalModelRecoveries, roomJournalState,
  sessionMessages, sessions, users, type DirectDatabase,
  type StenographerCompactionAcceptedPlan } from "@nautilo/db";
import { MemoryProviderOutcomeUnknownError } from "@nautilo/agent";
import { createRoomSideModelInvoker, extractionModelExposureDependencies, compactionModelExposureDependencies,
  StenographerInputAuthorityUnavailableError,
  type ExtractionClaim, type CompactionClaim, type AdmittedStenographerModel } from "@nautilo/runtime";
import type { DurableModelExposureDependency, DurableRecordEnvelope } from "@nautilo/reflection/durable";
import { parseMemoryOperationBinding, type MemoryOperationBinding } from "@nautilo/types";
import { openMemoryOperation, type OpenMemoryOperationInput } from "./personal-memory-operation";
import { getCurrentProtectedMemoryEvidence } from "./protected-memory-model-evidence";

type RecordDependency = Extract<DurableModelExposureDependency, { kind: "record" }>;

type Common = Pick<OpenMemoryOperationInput, "ports" | "budget" | "commitmentKey"> & {
  db: DirectDatabase;
  resolveServiceModel(): string;
  assertAvailable(): Promise<void>;
  readRetiredJournalPredecessor?: (dependency: RecordDependency, roomId: string) => Promise<DurableRecordEnvelope | null>;
  /** Pure injection seam for funding-boundary tests. */
  createInvoker?: typeof createRoomSideModelInvoker;
};

export type ProtectedStenographerFundingClaim =
  | Readonly<{
      readonly kind: "extraction";
      readonly sourceBatchId: string;
      readonly roomId: string;
      readonly namespaceId: string;
      readonly leaseToken: string;
    }>
  | Readonly<{
      readonly kind: "compaction";
      readonly workId: string;
      readonly roomId: string;
      readonly namespaceId: string;
      readonly leaseToken: string;
      readonly acceptedPlan: Extract<
        StenographerCompactionAcceptedPlan,
        { owner: "protected" }
      >;
    }>;

type Dependencies =
  () => Promise<readonly DurableModelExposureDependency[] | undefined>;

function sameCompactionPlan(
  left: StenographerCompactionAcceptedPlan | null,
  right: StenographerCompactionAcceptedPlan,
): boolean {
  if (
    left === null
    || left.version !== right.version
    || left.owner !== right.owner
    || left.operationId !== right.operationId
    || left.rebuildGeneration !== right.rebuildGeneration
    || left.previousRollupId !== right.previousRollupId
  ) return false;
  if (left.owner === "protected" || right.owner === "protected") {
    return left.owner === right.owner;
  }
  return JSON.stringify(left.selectedEventIds)
      === JSON.stringify(right.selectedEventIds)
    && JSON.stringify(left.protectedTailEventIds)
      === JSON.stringify(right.protectedTailEventIds);
}

async function assertDirectInputAuthorityAvailable(input: Readonly<{
  db: DirectDatabase;
  roomId: string;
  dependencies: readonly DurableModelExposureDependency[] | undefined;
}>): Promise<void> {
  const messageIds = [...new Set((input.dependencies ?? []).flatMap((dependency) => {
    if (dependency.kind !== "source" || dependency.sourceKind !== "message") return [];
    const match = /^message:(\d+)$/.exec(dependency.logicalSourceRef);
    if (match === null) return [];
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  }))];
  if (messageIds.length === 0) return;
  const rows = await input.db.select({
    id: sessionMessages.id,
    disabledAt: users.disabledAt,
  }).from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(and(
      inArray(sessionMessages.id, messageIds),
      eq(sessions.roomId, input.roomId),
    ))
    .limit(messageIds.length + 1);
  if (rows.some((row) => row.disabledAt !== null)) {
    throw new StenographerInputAuthorityUnavailableError();
  }
}

/** The existing batch/compaction lease owns both acceptance and publication. */
export function createStenographerMemoryFunding(input: Common) {
  const admit = async (
    claim: ExtractionClaim | CompactionClaim | ProtectedStenographerFundingClaim,
    stage: "extraction" | "compaction",
    dependencies: Dependencies,
    expectedDependencies: readonly DurableModelExposureDependency[] | undefined,
    protectedEvidence: boolean,
  ): Promise<AdmittedStenographerModel> => {
    const extraction = stage === "extraction";
    const operationKey = extraction
      ? "batchId" in claim
        ? claim.batchId
        : "sourceBatchId" in claim
          ? claim.sourceBatchId
          : (() => { throw new TypeError("Memory extraction claim is invalid"); })()
      : "modelOperationId" in claim
        ? claim.modelOperationId
        : "workId" in claim
          ? claim.workId
          : (() => { throw new TypeError("Memory compaction claim is invalid"); })();
    const currentLease = () => and(eq(roomJournalState.roomId, claim.roomId),
      eq(extraction ? roomJournalState.leaseToken : roomJournalState.compactionLeaseToken, claim.leaseToken),
      gt(extraction ? roomJournalState.leaseExpiresAt : roomJournalState.compactionLeaseExpiresAt, new Date()));
    const manualRecoveryId = "manualModelRecoveryId" in claim
      ? claim.manualModelRecoveryId
      : undefined;
    const manualRecoveryTarget = async (
      tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    ): Promise<string | null> => {
      if (manualRecoveryId === undefined) return null;
      const [recovery] = await tx.select({
        targetModelId: roomJournalModelRecoveries.targetModelId,
      }).from(roomJournalModelRecoveries).where(and(
        eq(roomJournalModelRecoveries.id, manualRecoveryId),
        eq(roomJournalModelRecoveries.roomId, claim.roomId),
        eq(roomJournalModelRecoveries.workKind, stage),
        eq(roomJournalModelRecoveries.workId, operationKey),
        eq(roomJournalModelRecoveries.claimLeaseToken, claim.leaseToken),
        isNull(roomJournalModelRecoveries.spentAt),
        isNull(roomJournalModelRecoveries.sourceChangedAt),
      )).limit(1).for("update", { of: roomJournalModelRecoveries });
      if (!recovery) {
        throw new Error("Manual Journal recovery authorization changed");
      }
      return recovery.targetModelId;
    };
    const assertManualServiceBinding = (
      value: MemoryOperationBinding,
      targetModelId: string | null,
    ) => {
      if (targetModelId !== null
        && (value.kind !== "service"
          || value.role !== "memorySummarization"
          || value.modelId !== targetModelId)) {
        throw new Error("Manual Journal recovery binding changed");
      }
      return value;
    };
    const assertCurrent = async () => {
      await input.assertAvailable();
      const lease = await input.db.select({ roomId: roomJournalState.roomId }).from(roomJournalState).where(currentLease()).limit(2);
      if (lease.length !== 1) throw new Error("Memory processing lease changed");
    };
    const bind = (
      resolve: (legacyServiceModelId?: string) => Promise<MemoryOperationBinding>,
    ) => input.db.transaction(async tx => {
      const leases = await tx.select({ roomId: roomJournalState.roomId,
        accepted: roomJournalState.compactionAcceptedModelBinding,
        acceptedPlan: roomJournalState.compactionAcceptedPlan })
        .from(roomJournalState).where(currentLease()).for("update").limit(2);
      if (leases.length !== 1) throw new Error("Memory processing lease changed");
      if (extraction) {
        const rows = await tx.select({ accepted: roomJournalBatches.acceptedModelBinding }).from(roomJournalBatches)
          .where(and(eq(roomJournalBatches.id, operationKey), eq(roomJournalBatches.roomId, claim.roomId), eq(roomJournalBatches.status, "running"))).for("update").limit(2);
        if (rows.length !== 1) throw new Error("Memory extraction batch changed");
        const targetModelId = await manualRecoveryTarget(tx);
        if (rows[0]!.accepted !== null) {
          return assertManualServiceBinding(
            parseMemoryOperationBinding(rows[0]!.accepted),
            targetModelId,
          );
        }
        const accepted = await (targetModelId === null
          ? resolve()
          : resolve(targetModelId));
        assertManualServiceBinding(accepted, targetModelId);
        await tx.update(roomJournalBatches).set({ acceptedModelBinding: accepted }).where(eq(roomJournalBatches.id, operationKey));
        return accepted;
      }
      const acceptedPlan = "acceptedPlan" in claim
        ? claim.acceptedPlan
        : (() => { throw new TypeError("Memory compaction plan is invalid"); })();
      const targetModelId = await manualRecoveryTarget(tx);
      if (leases[0]!.accepted !== null) {
        if (!sameCompactionPlan(leases[0]!.acceptedPlan, acceptedPlan)) {
          throw new Error("Memory compaction acceptance changed");
        }
        return assertManualServiceBinding(
          parseMemoryOperationBinding(leases[0]!.accepted),
          targetModelId,
        );
      }
      if (leases[0]!.acceptedPlan !== null) {
        if (targetModelId === null
          || !sameCompactionPlan(leases[0]!.acceptedPlan, acceptedPlan)) {
          throw new Error("Memory compaction acceptance is incoherent");
        }
        const accepted = await resolve(targetModelId);
        assertManualServiceBinding(accepted, targetModelId);
        await tx.update(roomJournalState).set({
          compactionAcceptedModelBinding: accepted,
        }).where(currentLease());
        return accepted;
      }
      const accepted = await (targetModelId === null
        ? resolve()
        : resolve(targetModelId));
      assertManualServiceBinding(accepted, targetModelId);
      await tx.update(roomJournalState).set({
        compactionAcceptedModelBinding: accepted,
        compactionAcceptedPlan: acceptedPlan,
      }).where(currentLease());
      return accepted;
    });
    const ports = protectedEvidence
      ? getCurrentProtectedMemoryEvidence()
      : input.ports;
    if (ports === undefined) {
      throw new Error("Protected Memory evidence is unavailable");
    }
    const readPredecessor = input.readRetiredJournalPredecessor;
    const readRetiredJournalPredecessor =
      !protectedEvidence && extraction && readPredecessor !== undefined
        ? (dependency: RecordDependency) => readPredecessor(dependency, claim.roomId)
        : undefined;
    if (!protectedEvidence && extraction) {
      const replaySafety = await resolveModelAttemptReplaySafety({
        kind: "operation",
        roomId: claim.roomId,
        callType: "room_stenographer",
        operationId: operationKey,
      }, {
        db: input.db,
        knownNonusableResult:
          "batchId" in claim
          && claim.previousModelResultKnownNonusable === true,
      });
      if (replaySafety.decision === "block_unknown"
        && !("manualModelRecoveryId" in claim
          && claim.manualModelRecoveryId !== undefined)) {
        throw new MemoryProviderOutcomeUnknownError();
      }
      await assertDirectInputAuthorityAvailable({
        db: input.db,
        roomId: claim.roomId,
        dependencies: expectedDependencies,
      });
    }
    const admitted = await openMemoryOperation({
      ports, role: "memorySummarization", operationKey, dependencies, bind, assertCurrent,
      requireCurrentServicePayer: "requiresCurrentServicePayer" in claim && claim.requiresCurrentServicePayer === true,
      budget: input.budget, commitmentKey: input.commitmentKey,
      resolveServiceModel: () => input.resolveServiceModel(),
      ...(readRetiredJournalPredecessor === undefined ? {} : { readRetiredJournalPredecessor }),
    });
    await admitted.assertExposure(expectedDependencies);
    if (protectedEvidence) {
      const replaySafety = await resolveModelAttemptReplaySafety({
        kind: "operation",
        roomId: claim.roomId,
        callType: extraction
          ? "room_stenographer"
          : "room_event_compaction",
        operationId: operationKey,
      }, { db: input.db });
      if (replaySafety.decision === "block_unknown") {
        throw new MemoryProviderOutcomeUnknownError();
      }
    }
    let recoveryDispatch: Promise<void> | undefined;
    const beforeProviderDispatch = manualRecoveryId === undefined ? undefined : async (signal?: AbortSignal) => {
      await admitted.assertCurrent();
      signal?.throwIfAborted();
      recoveryDispatch ??= input.db.transaction(async tx => {
        const [recovery] = await tx.select({
          id: roomJournalModelRecoveries.id,
        }).from(roomJournalModelRecoveries).where(and(
          eq(roomJournalModelRecoveries.id, manualRecoveryId),
          eq(roomJournalModelRecoveries.roomId, claim.roomId),
          eq(roomJournalModelRecoveries.workKind, stage),
          eq(roomJournalModelRecoveries.workId, operationKey),
          eq(roomJournalModelRecoveries.claimLeaseToken, claim.leaseToken),
          eq(roomJournalModelRecoveries.targetModelId, admitted.modelId),
          isNull(roomJournalModelRecoveries.spentAt),
          isNull(roomJournalModelRecoveries.sourceChangedAt),
        )).limit(1).for("update", { of: roomJournalModelRecoveries });
        if (!recovery) throw new Error("Manual Journal recovery authorization changed");
        // The recovery row lock may have been held while cancellation arrived.
        // Throwing here rolls the transaction back without consuming consent.
        signal?.throwIfAborted();
        const spent = await tx.update(roomJournalModelRecoveries).set({
          spentAt: new Date(),
        }).where(and(
          eq(roomJournalModelRecoveries.id, manualRecoveryId),
          isNull(roomJournalModelRecoveries.spentAt),
          isNull(roomJournalModelRecoveries.sourceChangedAt),
        )).returning({ id: roomJournalModelRecoveries.id });
        if (spent.length !== 1) throw new Error("Manual Journal recovery authorization changed");
        // Cancellation during the UPDATE still aborts this transaction before
        // COMMIT; there is deliberately no cancellation check after COMMIT.
        signal?.throwIfAborted();
      });
      await recoveryDispatch;
    };
    const invoke = (input.createInvoker ?? createRoomSideModelInvoker)({ modelId: admitted.modelId,
      ...(admitted.humanUserId === null ? {} : { userId: admitted.humanUserId }),
      roomId: claim.roomId, laneKey: `room:${claim.roomId}:${stage}`, operationId: operationKey,
      callType: stage === "extraction" ? "room_stenographer" : "room_event_compaction",
      invocationPolicy: {
        modelFallbackMode: "none",
        sameModelRetryMode: "none",
      },
      ...(!protectedEvidence ? { allowUnpinnedSurplusRetry: true as const } : {}),
      ...(admitted.fundingSession === undefined ? {} : {
        fundingSession: protectedEvidence
          ? admitted.fundingSession
          : Object.freeze({ ...admitted.fundingSession, allowUnpinnedSurplusRetry: true as const }),
      }),
      ...(beforeProviderDispatch === undefined ? {} : { beforeProviderDispatch }),
      assertCurrent: () => admitted.assertCurrent(),
    });
    return {
      modelId: admitted.modelId,
      assertCurrent: () => admitted.assertCurrent(),
      invoke,
    };
  };
  return {
    admitExtractionModel: (
      claim: ExtractionClaim,
      dependencies: readonly DurableModelExposureDependency[] | undefined,
    ) => admit(
      claim,
      "extraction",
      () => Promise.resolve(extractionModelExposureDependencies(claim)),
      dependencies,
      false,
    ),
    admitCompactionModel: (
      claim: CompactionClaim,
      dependencies: readonly DurableModelExposureDependency[] | undefined,
    ) => admit(
      claim,
      "compaction",
      () => Promise.resolve(compactionModelExposureDependencies(claim)),
      dependencies,
      false,
    ),
    admitProtectedExtractionModel: (
      claim: Extract<ProtectedStenographerFundingClaim, { kind: "extraction" }>,
      dependencies: Dependencies,
    ) => dependencies().then((actual) =>
      admit(claim, "extraction", () => Promise.resolve(actual), actual, true)
    ),
    admitProtectedCompactionModel: (
      claim: Extract<ProtectedStenographerFundingClaim, { kind: "compaction" }>,
      dependencies: Dependencies,
    ) => dependencies().then((actual) =>
      admit(claim, "compaction", () => Promise.resolve(actual), actual, true)
    ),
  };
}
