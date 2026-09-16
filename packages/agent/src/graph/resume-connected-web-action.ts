import { readTurnIdFromCheckpoint } from "./turn-id";
import { Command } from "@langchain/langgraph";
import { createNautiloGraph } from "../agent/graph";
import { defaultPostModelDeps } from "../agent/post-model-deps";
import type { LiveShadowToolBoundary } from "../nodes/tools";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import type { EncryptedCheckpointSaver } from "../checkpoints/encrypted-checkpoint-saver";
import { getPolicyResolver } from "@nautilo/trust";
import type { ConnectedWebAccountAuthenticationIntervention } from "../tools/connected-web-accounts/runtime";
import { emitChainedInterrupts, type StreamEventProcessor } from "./resume-approval";

/** Resume the same parked action tool invocation; the tool owns Done/Cancel. */
export async function resumeGraphWithConnectedWebAction(
  threadId: string,
  reply: { readonly toolCallId: string; readonly decision: "done" | "cancel" },
  intervention: ConnectedWebAccountAuthenticationIntervention,
  userId: string,
  processor: StreamEventProcessor,
  laneKey?: string,
  invocationCheckpointSaver?: EncryptedCheckpointSaver,
  signal?: AbortSignal,
  liveShadowToolBoundaryForState?: () => LiveShadowToolBoundary | undefined,
): Promise<void> {
  const checkpointSaver =
    invocationCheckpointSaver ?? createCheckpointSaver();
  const graph = createNautiloGraph(
    checkpointSaver,
    getPolicyResolver(),
    liveShadowToolBoundaryForState === undefined
      ? defaultPostModelDeps
      : { ...defaultPostModelDeps, liveShadowToolBoundaryForState },
  );
  try {
    await processor.beginResume?.(threadId, await readTurnIdFromCheckpoint(graph, threadId));
    for await (const event of graph.streamEvents(new Command({ resume: reply }), {
      configurable: {
        thread_id: threadId,
        connectedWebActionResumeContext: {
          version: "connected-web-action-resume-v1",
          toolCallId: reply.toolCallId,
          userId,
          intervention,
        },
      },
      version: "v2" as const,
      ...(signal ? { signal } : {}),
    })) await Promise.resolve(processor.process(event));
    await emitChainedInterrupts(graph, threadId, laneKey, processor, "resume-connected-web-action");
  } catch (error) {
    await processor.failResume?.();
    throw error;
  } finally { processor.flush(); }
}
