import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { createProjectionPreflightNode } from "../../src/nodes/projection-preflight";
import type { ProjectionPreflightResult, ProjectionSnapshot } from "../../src/tools/memory/projection-sharing";

const snapshot: ProjectionSnapshot = {
  toolCallId: "valid-project",
  requesterUserId: "user",
  requesterActorId: "actor",
  agentId: "agent",
  sourceFingerprints: [{ id: "private-source", contentHash: "hash" }],
  content: "Safe public text.",
  contentHash: "content-hash",
  destination: { roomId: "room", namespaceId: "namespace", label: "pub-room", kind: "open", memberCount: 2, audienceFingerprint: "audience" },
  audienceFingerprint: "audience",
  createdAt: 1,
  expiresAt: 2,
  creationKey: "projection:550e8400-e29b-41d4-a716-446655440023",
};

describe("projection preflight mixed batches", () => {
  test("pairs every rejected projection ToolMessage without discarding a valid sibling snapshot", async () => {
    const node = createProjectionPreflightNode(async () => ({
      snapshots: [snapshot],
      choiceMappings: [],
      rejectedToolCallIds: ["rejected-project"],
      messages: [{ toolCallId: "rejected-project", content: "Choose a Room first." }],
    } satisfies ProjectionPreflightResult));
    const messages = [new AIMessage({
      content: "",
      tool_calls: [
        { id: "valid-project", name: "share_memory", args: { mode: "project" } },
        { id: "rejected-project", name: "share_memory", args: { mode: "project" } },
      ],
    })];

    const result = await node({ messages, projectionRoomChoices: [] } as unknown as NautiloState);
    const outputMessages = result.messages as NautiloState["messages"];
    const response = outputMessages[outputMessages.length - 1];
    expect(ToolMessage.isInstance(response)).toBe(true);
    expect((response as ToolMessage).tool_call_id).toBe("rejected-project");
    expect(JSON.parse((response as ToolMessage).content as string)).toEqual({
      error: "Choose a Room first.",
    });
    expect((response as ToolMessage).status).toBe("error");
    expect((response as ToolMessage).additional_kwargs["nautilo_tool_status"]).toBe("error");
    expect(result.projectionSnapshots).toEqual([snapshot]);
    expect(result.projectionRejectedToolCallIds).toEqual(["rejected-project"]);
  });

  test("clears a stale rejection after the model stops requesting tools", async () => {
    const node = createProjectionPreflightNode();
    const result = await node({
      messages: [new AIMessage("I need a different source before sharing.")],
      projectionRejectedToolCallIds: ["rejected-project"],
      projectionRoomChoices: [],
    } as unknown as NautiloState);

    expect(result.projectionRejectedToolCallIds).toEqual([]);
    expect(result.projectionSnapshots).toEqual([]);
  });

  test("expires and bounds checkpointed Room choice mappings", async () => {
    const now = Date.now();
    const choices = Array.from({ length: 60 }, (_, index) => ({
      token: `choice-${index}`,
      requesterUserId: "user",
      normalizedQuery: "pub",
      roomId: `room-${index}`,
      expiresAt: index === 0 ? now - 1 : now + 60_000,
    }));
    const node = createProjectionPreflightNode();

    const result = await node({
      messages: [],
      projectionRoomChoices: choices,
    } as unknown as NautiloState);

    expect(result.projectionRoomChoices).toHaveLength(50);
    expect(result.projectionRoomChoices?.[0]?.token).toBe("choice-10");
    expect(result.projectionRoomChoices?.at(-1)?.token).toBe("choice-59");
  });
});

test("malformed-call receipts cannot bypass projection checks for a valid sibling", async () => {
  const { modelOutputPreflightNode } = await import("../../src/nodes/model-output-preflight");
  let inspectedIds: (string | undefined)[] = [];
  const node = createProjectionPreflightNode(async (_state, calls) => {
    inspectedIds = calls.map((call) => call.id);
    return { snapshots: [snapshot], choiceMappings: [], rejectedToolCallIds: [], messages: [] };
  });
  const state = { messages: [new AIMessage({ content: "",
    tool_calls: [{ id: "valid-project", name: "share_memory", args: { mode: "project" } }],
    invalid_tool_calls: [{ id: "broken", name: "share_memory", args: '{"mode":', error: "Malformed args.", type: "invalid_tool_call" }],
  })], projectionRoomChoices: [] } as unknown as NautiloState;
  const normalized = { ...state, ...modelOutputPreflightNode(state) };
  const result = await node(normalized);
  expect(inspectedIds).toEqual(["valid-project"]);
  expect(result.projectionSnapshots).toEqual([snapshot]);
  expect(result.messages?.at(-1)?.content).toContain("MALFORMED_TOOL_ARGUMENTS");
});
