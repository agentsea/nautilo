import { afterEach, expect, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { dispatchControlConnectedWebOperation } from "./control-connected-web-operation";
import { resetConnectedWebAccountReadToolRuntimeForTests, setConnectedWebOperationDirectToolRuntime } from "./runtime";

const OWNER = "00000000-0000-4000-8000-000000000571";
const AGENT = "00000000-0000-4000-8000-000000000572";
const ROOM = "00000000-0000-4000-8000-000000000573";
const OPERATION = "00000000-0000-4000-8000-000000000575";

afterEach(() => resetConnectedWebAccountReadToolRuntimeForTests());

test("D568 direct control preserves ordinary page links while projecting no coordinates", async () => {
  setConnectedWebOperationDirectToolRuntime({
    control: async (_actor, input) => ({
      ok: true,
      command: { text: "Docs: https://example.test/help", truncated: false },
      operation: {
        operationId: input.operationId, driver: "direct", lifecycle: "running", controlEpoch: input.expectedControlEpoch,
        activity: { phase: "working", code: "direct_browser_control", summary: "Connected website control is active." }, receipt: null, result: null,
      },
    }),
  });
  const memoryAccessEnvelope: MemoryAccessEnvelope = {
    ownerId: OWNER, actorId: OWNER, agentId: AGENT, roomId: ROOM,
    readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: {},
  };
  const result = await dispatchControlConnectedWebOperation({ operationId: OPERATION, expectedControlEpoch: 2, command: { kind: "snapshot" } }, {
    userId: OWNER, agentId: AGENT, roomId: ROOM, callingRoomId: null, memoryAccessEnvelope,
    toolCallId: "tool", currentThreadId: "thread", turnId: "turn", laneKey: "lane",
  });
  expect(JSON.parse(result)).toMatchObject({ ok: true, command: { text: "Docs: https://example.test/help" } });
});
