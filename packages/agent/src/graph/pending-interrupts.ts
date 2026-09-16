import type { ServerEvent } from "@nautilo/types";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { getPolicyResolver } from "@nautilo/trust";
import { createNautiloGraph } from "../agent/graph";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import { collectPendingInterruptEvents } from "./interrupt-mapping";

/** Read-only projection of the interrupts in one durable graph checkpoint. */
export async function readPendingInterruptEventsForThread(
  threadId: string,
  laneKey: string,
  checkpointSaver?: BaseCheckpointSaver,
): Promise<ServerEvent[]> {
  const graph = createNautiloGraph(checkpointSaver ?? createCheckpointSaver(), getPolicyResolver());
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  return collectPendingInterruptEvents(
    state as { tasks?: Array<Record<string, unknown>> } | undefined,
    threadId,
    laneKey,
  );
}
