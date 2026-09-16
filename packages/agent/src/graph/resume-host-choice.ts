import { Command } from "@langchain/langgraph";
import { createNautiloGraph } from "../agent/graph";
import { defaultPostModelDeps } from "../agent/post-model-deps";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import { getPolicyResolver } from "@nautilo/trust";
import { log, runWithTurn, warn } from "@nautilo/logger";
import { emitChainedInterrupts, type StreamEventProcessor } from "./resume-approval";
import { readTurnIdFromCheckpoint } from "./turn-id";
import {
  GraphExecutionMetrics,
  resolveGraphExecutionPolicy,
  toGraphBudgetOutcome,
} from "./execution-policy";

/** Resume the exact graph interrupt that requested a paired-computer choice. */
export async function resumeGraphWithHostChoice(
  threadId: string,
  choice: { choiceId: string; selector: string },
  processEvent: StreamEventProcessor,
  laneKey?: string,
  signal?: AbortSignal,
): Promise<void> {
  const graph = createNautiloGraph(
    createCheckpointSaver(),
    getPolicyResolver(),
    defaultPostModelDeps,
  );
  const executionPolicy = resolveGraphExecutionPolicy();
  const metrics = new GraphExecutionMetrics();
  const turnId = await readTurnIdFromCheckpoint(graph, threadId);
  await runWithTurn(turnId, async () => {
    log(`[agent/resume-host-choice] Resuming thread ${threadId}`);
    try {
      await processEvent.beginResume?.(threadId, turnId);
      for await (const event of graph.streamEvents(
        new Command({ resume: choice }),
        {
          configurable: { thread_id: threadId },
          version: "v2" as const,
          recursionLimit: executionPolicy.recursionLimit,
          ...(signal ? { signal } : {}),
        },
      )) {
        metrics.noteStreamEvent(event);
        await Promise.resolve(processEvent.process(event));
      }
      await emitChainedInterrupts(
        graph,
        threadId,
        laneKey,
        processEvent,
        "resume-host-choice",
      );
      processEvent.flush();
      log(`[agent/resume-host-choice] Thread ${threadId} resume complete ${metrics.formatLogToken()}`);
    } catch (error) {
      await processEvent.failResume?.();
      processEvent.flush();
      const budget = toGraphBudgetOutcome(error, executionPolicy.recursionLimit);
      warn(
        `[agent/resume-host-choice] Resume failed: ${budget?.kind ?? "internal_error"} ${metrics.formatLogToken()}`,
      );
      throw error;
    }
  });
}
