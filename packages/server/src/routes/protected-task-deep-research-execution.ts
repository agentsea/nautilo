import { isDeepStrictEqual } from "node:util";
import { readDeepResearchTaskMetadata, runWithCapabilityFundingSession } from "@nautilo/agent";
import { reconstructProtectedTaskMetadataV1 } from "@nautilo/types";
import { streamDeepResearchReport, type HarnessExecutionOutput } from "@nautilo/runtime";
import type { ProductionProtectedTaskNativeExecutionInput } from "./protected-task-native-execution-composition";
import { createProductionProtectedTaskNativeExecutionContext } from "./protected-task-native-execution-context";
import { createProtectedTaskExternalExecution, type ProtectedTaskExternalExecutionDependencies,
  type ProtectedTaskExternalExecutionFactory, type ProtectedTaskExternalProvider } from "./protected-task-external-execution";
import { waitForProtectedTaskExternalOperation } from "./protected-task-external-operation";
import type { createProtectedTaskExternalRequests } from "./protected-task-external-requests";
import { parseProtectedTaskDeepResearchSelection, sameProtectedTaskDeepResearchSelection,
  type ProtectedTaskDeepResearchSelection } from "./protected-task-deep-research-selection";

type Input = Pick<ProductionProtectedTaskNativeExecutionInput, "db"> & Readonly<{
  executionContext?: ReturnType<typeof createProductionProtectedTaskNativeExecutionContext>;
  stream?: typeof streamDeepResearchReport;
}>;

/** The existing research graph is one-shot; a lost effect never becomes a replay checkpoint. */
export function createProtectedTaskDeepResearchProvider(input: Input):
ProtectedTaskExternalProvider<ProtectedTaskDeepResearchSelection, ProtectedTaskDeepResearchSelection> {
  const context = input.executionContext ?? createProductionProtectedTaskNativeExecutionContext({ db: input.db });
  const stream = input.stream ?? streamDeepResearchReport;
  return {
    matchesCurrentSelection: (current, selection) =>
      sameProtectedTaskDeepResearchSelection(current.deepResearchExecutionSelection, selection),
    admit: (_ownerId, selection) => Promise.resolve(parseProtectedTaskDeepResearchSelection(selection)),
    sameAdmission: (left, right) => isDeepStrictEqual(left, right),
    start: async ({ occurrence, predispatch, jobId, signal, assertCurrent, admission, payload }) => {
      signal.throwIfAborted();
      if (predispatch === undefined) throw new TypeError("Protected research scheduling authority is unavailable");
      const restored = reconstructProtectedTaskMetadataV1(admission, payload.protectedMetadata);
      if (restored.status !== "supported") throw new TypeError("Protected research definition is unsupported");
      const research = readDeepResearchTaskMetadata(restored.metadata);
      if (research === null) throw new TypeError("Protected research execution is unavailable");
      await assertCurrent();
      const execution = await context({ occurrence, predispatch, protectedMetadata: restored.metadata,
        signal, assertCurrentTaskAuthority: assertCurrent });
      await assertCurrent();
      signal.throwIfAborted();
      const attribution = Object.freeze({ taskId: occurrence.task.id, roomId: occurrence.task.callingRoomId!,
        bindingId: occurrence.run.id, bindingGeneration: jobId, vendorSessionId: null, vendorTurnId: null, vendorItemId: null });
      let consumed = false;
      const outputs: AsyncIterable<HarnessExecutionOutput> = {
        async *[Symbol.asyncIterator]() {
          if (consumed) throw new TypeError("Protected research execution was already consumed");
          consumed = true;
          await assertCurrent();
          signal.throwIfAborted();
          const funding = execution.foregroundChatFundingSession?.capabilityFunding;
          const report = runWithCapabilityFundingSession(funding, () => stream({
            research_brief: payload.prompt, report_language: research.reportLanguage,
            deep_research_model_plan: research.modelPlan,
            ...(research.version === 2 ? { deep_research_funding: research } : {}),
          }, occurrence.run.id, signal, occurrence.task.requestorId, {
            roomId: predispatch.scheduling.roomId, taskId: occurrence.task.id,
            taskRunId: occurrence.run.id, agentId: occurrence.task.agentId,
          }, { confidential: true }));
          let complete = false;
          try {
            for (;;) {
              await assertCurrent();
              const next = await waitForProtectedTaskExternalOperation(signal,
                runWithCapabilityFundingSession(funding, () => report.next()));
              await assertCurrent();
              signal.throwIfAborted();
              if (next.done) {
                complete = true;
                if (!next.value.trim()) throw new TypeError("Protected research report is unavailable");
                yield { kind: "assistant_completed", attribution, text: next.value };
                await assertCurrent();
                signal.throwIfAborted();
                yield { kind: "terminal", attribution, status: "completed" };
                return;
              }
              // Research progress is not a durable or owner-wide plaintext event.
            }
          } finally {
            if (!complete) {
              const closing = runWithCapabilityFundingSession(funding, () => report.return(""));
              // The original iterator retains settlement ownership after cancellation.
              await waitForProtectedTaskExternalOperation(signal, closing).catch(() => undefined);
            }
          }
        },
      };
      return { attribution, outputs, hasLiveRequest: () => false,
        respond: () => Promise.reject(new TypeError("Protected research requests are unsupported")) };
    },
  };
}

export function createProtectedTaskDeepResearchExecution(input: ProductionProtectedTaskNativeExecutionInput & Input & Readonly<{
  requests: Pick<ReturnType<typeof createProtectedTaskExternalRequests>, "register">;
}>, overrides: Partial<ProtectedTaskExternalExecutionDependencies> = {}): ProtectedTaskExternalExecutionFactory<ProtectedTaskDeepResearchSelection> {
  return createProtectedTaskExternalExecution({ ...input, provider: createProtectedTaskDeepResearchProvider(input) }, overrides);
}
