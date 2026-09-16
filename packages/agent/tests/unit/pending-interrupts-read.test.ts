import { expect, spyOn, test } from "bun:test";
import { END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import { NautiloStateAnnotation } from "../../src/agent/state";
import { readPendingInterruptEventsForThread } from "../../src/graph/pending-interrupts";

test("reconstructed pending reader preserves exact preview without invoking nodes or writing checkpoints", async () => {
  const saver = new MemorySaver();
  const threadId = "room:source:bot:agent:fork:exact-original-coordinate";
  const tool = { id: "call-exact", name: "share_memory", args: { mode: "projection", content: "Exact synthetic preview", target: { room_id: "destination" } } };
  let executions = 0;
  const graph = new StateGraph(NautiloStateAnnotation)
    .addNode("post_model", () => {
      executions++;
      interrupt({ type: "approval_ask", approvalId: "approval-exact", userId: "owner",
        tools: [tool], reason: "Exact reason", reasonCode: "destructive-tool", allowedVerbs: ["once", "deny"] });
      return {};
    })
    .addEdge(START, "post_model").addEdge("post_model", END).compile({ checkpointer: saver });
  await graph.invoke({ messages: [], userId: "owner" }, { configurable: { thread_id: threadId } });
  const put = spyOn(saver, "put");
  const writes = spyOn(saver, "putWrites");
  try {
    const first = await readPendingInterruptEventsForThread(threadId, "room:source", saver);
    const again = await readPendingInterruptEventsForThread(threadId, "room:source", saver);
    expect(first).toEqual(again);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "approval.ask", threadId, laneKey: "room:source",
      approvalId: "approval-exact", userId: "owner", tools: [tool], reason: "Exact reason" });
    expect(executions).toBe(1);
    expect(put).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(await readPendingInterruptEventsForThread("other-checkpoint", "room:source", saver)).toEqual([]);
  } finally { put.mockRestore(); writes.mockRestore(); }
});
