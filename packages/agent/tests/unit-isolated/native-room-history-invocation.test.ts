/** Real agent/model-call and checkpoint boundaries; no provider or desktop input. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { END, START, MemorySaver, StateGraph } from "@langchain/langgraph";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { NautiloStateAnnotation, type NautiloState } from "../../src/agent/state";
import { agentNode } from "../../src/nodes/agent";
import type { ChatModel } from "../../src/providers/types";
import { __setStubModelForTests } from "../../src/providers/universal";
import { registerAllTools } from "../../src/tools/register-all";
import type { NativeRoomHistoryPort } from "../../src/tools/computer/native-history";

const oldMode = process.env["NAUTILO_TEST_MODE"];
let received: BaseMessage[][] = [];
const model: ChatModel = {
  bindTools() { return model; },
  async invoke(messages) { received.push(messages as BaseMessage[]); return new AIMessage("Checked."); },
};
beforeAll(() => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  const catalog = new ToolCatalog(); registerAllTools(catalog); initToolCatalog(catalog);
  __setStubModelForTests(model);
});
afterAll(() => {
  __setStubModelForTests(null); clearToolCatalog();
  if (oldMode === undefined) delete process.env["NAUTILO_TEST_MODE"]; else process.env["NAUTILO_TEST_MODE"] = oldMode;
});

test("only the provider receives the Room projection; checkpoints and unavailable recovery retain originals", async () => {
  const original = new HumanMessage({ content: "Original authorized Room controls ".repeat(100),
    additional_kwargs: { nautilo_room_context_budgeted: true } });
  const system = new SystemMessage("Unchanged system prefix");
  const compact = "Historical collection; read its offered historyRoomRef for exact evidence.";
  const port: NativeRoomHistoryPort = { project: message => message.content === original.content ? compact : null,
    read: () => ({ text: "Exact historical evidence" }) };
  for (const scenario of ["available", "no-port", "no-tool", "unresolved"] as const) {
    received = [];
    const input: Partial<NautiloState> = { model: "anthropic:claude-sonnet-4-6", modelFallbackMode: "none",
      userId: "owner", actorRole: "owner", agentId: "genie", roomId: "room", turnId: "turn",
      trustedExecutionEntrypoint: "foreground.main", messages: [original], preparedMessages: [system, original],
      toolWhitelist: scenario === "no-tool" ? [] : ["computer_observe"], activatedToolNames: ["computer_observe"],
      relayCapabilities: { canUseComputer: true, control_desktop: true },
      foregroundModelControlSnapshot: { roomSelection: null, agentSelection: null, serverReasoningPolicy: null, turnModelId: null },
      ...(scenario === "unresolved" ? { nativeDecision: { unresolved: [{ toolCallId: "pending" }] } as unknown as NonNullable<NautiloState["nativeDecision"]> } : {}),
    };
    const graph = new StateGraph(NautiloStateAnnotation).addNode("call", state =>
      agentNode(state, undefined, undefined, false, undefined, undefined, () => scenario === "no-port" ? undefined : port))
      .addEdge(START, "call").addEdge("call", END).compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: `room-projection-${scenario}` } };
    const result = await graph.invoke(input, config);
    expect(received).toHaveLength(1);
    expect(received[0]![0]!.content).toBe(system.content);
    expect(received[0]![1]!.content).toBe(scenario === "available" ? compact : original.content);
    expect(result.preparedMessages[1]!.content).toBe(original.content);
    for await (const checkpoint of graph.getStateHistory(config)) {
      expect(JSON.stringify(checkpoint.values)).not.toContain(compact);
    }
  }
});
