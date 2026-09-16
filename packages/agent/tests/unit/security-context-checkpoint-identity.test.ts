import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { assignStableToolMessageId } from "@nautilo/message-invariants";
import type { NautiloState } from "../../src/agent/state";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext } from "../../src/tools/security/research-context";
import { currentResearchContextRecovery } from "../../src/tools/security/research-context-rollover";

test("real checkpoint serialization preserves stable tool identity and every frozen recovery reference", async () => {
  // Use the production saver serializer without opening a database or model.
  const serde = new PostgresSaver({} as never).serde;
  const result = new ToolMessage({ content: "source 🦀\n", tool_call_id: "source-call", name: "file", status: "success" });
  assignStableToolMessageId(result);
  const state = { userId: "owner", currentTaskId: "11111111-1111-4111-8111-111111111111",
    currentTaskRunId: "22222222-2222-4222-8222-222222222222", subagentRun: true, toolWhitelist: ["file", "security_scan"],
    messages: [new HumanMessage({ id: "request", content: "Audit this source" }),
      new AIMessage({ id: "source-request", content: "", tool_calls: [{ id: "source-call", name: "file", args: { command: "read", path: "src/access.ts" } }] }), result],
    researchContextRecovery: null } as unknown as NautiloState;
  const source = describeResearchContextMessage(state, 2)!;
  const index = describeResearchContextIndex(state, 2)!;
  state.researchContextRecovery = { taskRunId: state.currentTaskRunId!, throughIndex: 2, indexRef: index.ref, pendingRefs: [source.ref] };
  const [encoding, bytes] = await serde.dumpsTyped(state);
  const loaded = await serde.loadsTyped(encoding, bytes) as NautiloState;
  expect(loaded.messages[2]?.id).toBe("tm:source-call");
  expect(describeResearchContextIndex(loaded, 2)).toEqual(index);
  expect(describeResearchContextMessage(loaded, 2)).toEqual(source);
  expect(currentResearchContextRecovery(loaded)?.pendingRefs).toEqual([source.ref]);
  const read = readResearchContext(loaded, { version: "security-scan-v1", operation: "context", contextRef: source.ref }, { maxPageBytes: 4000 });
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.result.text).toContain("source 🦀");
});
