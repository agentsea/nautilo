import { and, eq, gt, resolveModelAttemptReplaySafety, roomJournalBatches, roomJournalState, type DirectDatabase,
  type StenographerCompactionAcceptedPlan } from "@nautilo/db";
import { MemoryProviderOutcomeUnknownError } from "@nautilo/agent";
import { createRoomSideModelInvoker, extractionModelExposureDependencies, compactionModelExposureDependencies,
  type ExtractionClaim, type CompactionClaim, type AdmittedStenographerModel } from "@nautilo/runtime";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import type { MemoryOperationBinding } from "@nautilo/types";
import { openMemoryOperation, type OpenMemoryOperationInput } from "./personal-memory-operation";
import { getCurrentProtectedMemoryEvidence } from "./protected-memory-model-evidence";

type Common = Pick<OpenMemoryOperationInput, "ports" | "budget" | "commitmentKey"> & {
  db: DirectDatabase;
  resolveServiceModel(): string;
  assertAvailable(): Promise<void>;
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
    const assertCurrent = async () => {
      await input.assertAvailable();
      const lease = await input.db.select({ roomId: roomJournalState.roomId }).from(roomJournalState).where(currentLease()).limit(2);
      if (lease.length !== 1) throw new Error("Memory processing lease changed");
    };
    const bind = (resolve: () => Promise<MemoryOperationBinding>) => input.db.transaction(async tx => {
      const leases = await tx.select({ roomId: roomJournalState.roomId,
        accepted: roomJournalState.compactionAcceptedModelBinding,
        acceptedPlan: roomJournalState.compactionAcceptedPlan })
        .from(roomJournalState).where(currentLease()).for("update").limit(2);
      if (leases.length !== 1) throw new Error("Memory processing lease changed");
      if (extraction) {
        const rows = await tx.select({ accepted: roomJournalBatches.acceptedModelBinding }).from(roomJournalBatches)
          .where(and(eq(roomJournalBatches.id, operationKey), eq(roomJournalBatches.roomId, claim.roomId), eq(roomJournalBatches.status, "running"))).for("update").limit(2);
        if (rows.length !== 1) throw new Error("Memory extraction batch changed");
        if (rows[0]!.accepted !== null) return rows[0]!.accepted;
        const accepted = await resolve();
        await tx.update(roomJournalBatches).set({ acceptedModelBinding: accepted }).where(eq(roomJournalBatches.id, operationKey));
        return accepted;
      }
      const acceptedPlan = "acceptedPlan" in claim
        ? claim.acceptedPlan
        : (() => { throw new TypeError("Memory compaction plan is invalid"); })();
      if (leases[0]!.accepted !== null) {
        if (!sameCompactionPlan(leases[0]!.acceptedPlan, acceptedPlan)) {
          throw new Error("Memory compaction acceptance changed");
        }
        return leases[0]!.accepted;
      }
      if (leases[0]!.acceptedPlan !== null) {
        throw new Error("Memory compaction acceptance is incoherent");
      }
      const accepted = await resolve();
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
    const admitted = await openMemoryOperation({
      ...input, ports, role: "memorySummarization", operationKey, dependencies,
      bind, assertCurrent,
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
    return {
      modelId: admitted.modelId,
      assertCurrent: () => admitted.assertCurrent(),
      invoke: (input.createInvoker ?? createRoomSideModelInvoker)({ modelId: admitted.modelId,
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
        assertCurrent: () => admitted.assertCurrent(),
      }),
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
