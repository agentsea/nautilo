import {
  invokeChatModelWithFallback,
  runWithUsageContext,
  type CapabilityFundingSession,
  type MemoryReviewOptions,
} from "@nautilo/agent";
import type { OrganizerEvidenceBudget } from "@nautilo/reflection";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import type { PersonalMemoryEvidencePort } from "@nautilo/reflection-bridge/server";
import type {
  AdmittedMemoryReviewModel,
  MemoryReviewClaim,
  MemoryReviewInput,
  MemoryReviewRepository,
} from "@nautilo/runtime";
import {
  openMemoryOperation,
  type AdmittedMemoryOperation,
  type OpenMemoryOperationInput,
} from "./personal-memory-operation";

type InvokeModel = NonNullable<MemoryReviewOptions["invokeModel"]>;
type MemoryReviewSnapshot = Parameters<NonNullable<MemoryReviewOptions["onModelExposure"]>>[0][number];

export interface PersonalMemoryReviewFundingOptions {
  readonly repository: MemoryReviewRepository;
  readonly evidence: PersonalMemoryEvidencePort;
  readonly budget: OrganizerEvidenceBudget;
  readonly commitmentKey: Uint8Array;
  readonly resolveServiceModel: () => string;
  /** Resolve current canonical Memory rows for the exact retrieved snapshots. */
  readonly resolveExposureDependencies: (
    claim: MemoryReviewClaim,
    snapshots: readonly MemoryReviewSnapshot[],
  ) => Promise<readonly DurableModelExposureDependency[] | undefined>;
  readonly openHumanSession?: (humanUserId: string, recheck: () => Promise<void>) => CapabilityFundingSession;
  /** Test seam; production uses the shared operation admission owner. */
  readonly openOperation?: (input: OpenMemoryOperationInput) => Promise<AdmittedMemoryOperation>;
}

/** Review-specific adapter over the shared durable Memory operation admission. */
export function createPersonalMemoryReviewAdmitter(options: PersonalMemoryReviewFundingOptions) {
  return async (
    claim: MemoryReviewClaim,
    input: MemoryReviewInput,
    assertCurrent: () => Promise<void>,
  ): Promise<AdmittedMemoryReviewModel> => {
    if (!options.repository.bindModelOperation) throw new Error("memory_review_binding_unavailable");
    const operation = await (options.openOperation ?? openMemoryOperation)({
      role: "memoryReview",
      operationKey: claim.workId,
      dependencies: () => Promise.resolve(input.modelExposureDependencies),
      ports: options.evidence,
      budget: options.budget,
      commitmentKey: options.commitmentKey,
      bind: (resolve) => options.repository.bindModelOperation!(claim, resolve),
      assertCurrent,
      resolveServiceModel: options.resolveServiceModel,
      ...(options.openHumanSession === undefined ? {} : { openHumanSession: options.openHumanSession }),
    });
    const invokeModel: InvokeModel = async (invocation) => runWithUsageContext({
      callType: "memory_review",
      userId: operation.humanUserId,
      roomId: claim.roomId,
      metadata: { workId: claim.workId, attemptId: claim.attemptId, agentId: claim.agentId },
    }, async () => {
      await operation.assertCurrent();
      const fundingOptions = operation.humanUserId === null
        ? { serverFundedService: "shared_memory_maintenance" as const, modelFallbackMode: "none" as const,
            sameModelRetryMode: "none" as const, useOpenAIResponsesApi: true,
            reasoningOutput: operation.modelId.startsWith("openai:") }
        : operation.fundingSession === undefined
          ? (() => { throw new Error("personal_memory_review_funding_unavailable"); })()
          : { fundingHumanUserId: operation.humanUserId, fundingSession: operation.fundingSession,
              modelFallbackMode: "none" as const, sameModelRetryMode: "none" as const,
              useOpenAIResponsesApi: true, reasoningOutput: operation.modelId.startsWith("openai:") };
      const { response } = await invokeChatModelWithFallback(
        invocation.messages,
        invocation.tools,
        operation.modelId,
        operation.humanUserId ?? claim.ownerId,
        claim.agentId,
        `room:${claim.roomId}`,
        invocation.signal ? { signal: invocation.signal } : undefined,
        fundingOptions,
      );
      return response;
    });
    return {
      modelId: operation.modelId,
      invokeModel,
      assertCurrent: () => operation.assertCurrent(),
      resolveMemoryExposureDependencies: async (snapshots) => {
        await operation.assertCurrent();
        const dependencies = await options.resolveExposureDependencies(claim, snapshots);
        if (snapshots.length > 0) await operation.assertExposure(dependencies);
        return dependencies;
      },
      onModelExposure: async (snapshots) => {
        if (snapshots.length === 0) { await operation.assertCurrent(); return; }
        await operation.assertExposure(await options.resolveExposureDependencies(claim, snapshots));
      },
    };
  };
}
