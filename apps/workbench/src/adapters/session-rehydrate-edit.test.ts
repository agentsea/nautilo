import { describe, expect, test } from "bun:test";
import {
  reconcileRoomHistoryShadowPayloads,
  restoreSessionMessages,
  roomHistoryShadowOrdinarySibling,
  withholdRoomHistoryShadowPayloads,
} from "./session-rehydrate";
describe("restoreSessionMessages M230 edit metadata", () => {
  test("preserves harness authorship separately from the delegating agent", () => {
    const [message] = restoreSessionMessages([{
      id: "harness-result-1",
      role: "assistant",
      content: "I changed the repository.",
      authorAgentId: "agent-moxie",
      authorHarnessId: "claude-code",
    }]);
    expect(message).toMatchObject({
      id: "harness-result-1",
      metadata: {
        custom: {
          authorAgentId: "agent-moxie",
          authorHarnessId: "claude-code",
        },
      },
    });
  });

  test("hydrates logical identity, revision, and edited marker for user rows", () => {
    const [message] = restoreSessionMessages([{
      id: "42",
      logicalMessageKey: "turn:fp-1",
      role: "user",
      content: "fixed",
      createdAt: "2026-08-01T10:00:00.000Z",
      editedAt: "2026-08-01T10:01:00.000Z",
      editRevision: 3,
    }]);
    expect(message?.metadata).toMatchObject({
      custom: {
        logicalMessageKey: "turn:fp-1",
        sentAt: "2026-08-01T10:00:00.000Z",
        editedAt: "2026-08-01T10:01:00.000Z",
        editRevision: 3,
      },
    });
  });

  test("projects a server-marked Advanced video continuation as a neutral system row", () => {
    const [message] = restoreSessionMessages([{
      id: "advanced-video-1",
      role: "user",
      content: "private machine instruction that must not render as authored prose",
      workcardContinuation: { kind: "advanced_video", referenceCount: 2 },
    }]);
    expect(message).toMatchObject({
      id: "advanced-video-1",
      role: "system",
      content: [{
        type: "text",
        text: "Advanced video workcard · Requested exact quote with 2 references.",
      }],
      metadata: { custom: { workcardContinuation: { kind: "advanced_video", referenceCount: 2 } } },
    });
    expect(JSON.stringify(message)).not.toContain("private machine instruction");
  });

  test("keeps ordinary user prose user-authored without the server marker", () => {
    const [message] = restoreSessionMessages([{
      id: "ordinary-1",
      role: "user",
      content: "This is my own message.",
    }]);
    expect(message).toMatchObject({ role: "user", content: [{ type: "text", text: "This is my own message." }] });
  });

  test("projects paginated inspect tool args before restarted history reaches ToolCards", () => {
    const sessionSecret = "restart-inspect-session-secret";
    const nestedSecret = "restart-nested-refresh-secret";
    const restored = restoreSessionMessages([
      {
        id: "assistant-inspects",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([
          {
            id: "inspect-page-1",
            name: "inspect_open_design",
            args: {
              sessionToken: sessionSecret,
              pageSize: 25,
              nested: { refresh_token: nestedSecret, intent: "continue inspection" },
            },
          },
          {
            id: "inspect-page-2",
            name: "inspect_open_design",
            arguments: JSON.stringify({
              session_token: sessionSecret,
              cursor: "page:2",
              nested: { accessToken: nestedSecret, intent: "continue inspection" },
            }),
          },
        ]),
      },
      {
        id: "result-page-1",
        role: "tool",
        toolName: "inspect_open_design",
        content: "page one",
      },
      {
        id: "result-page-2",
        role: "tool",
        toolName: "inspect_open_design",
        content: "page two",
      },
    ]);

    expect(restored).toHaveLength(2);
    expect(restored.map((message) => message.content[0])).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "inspect-page-1",
        toolName: "inspect_open_design",
        args: {
          pageSize: 25,
          nested: { intent: "continue inspection" },
        },
      }),
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "inspect-page-2",
        toolName: "inspect_open_design",
        args: {
          nested: { intent: "continue inspection" },
        },
      }),
    ]);
    const serialized = JSON.stringify(restored);
    expect(serialized).not.toContain(sessionSecret);
    expect(serialized).not.toContain(nestedSecret);
  });

  test("hydrates server-authored Workspace document pointers without inferring from prose", () => {
    const [message] = restoreSessionMessages([{
      id: "43",
      role: "user",
      content: "Please read the plan",
      artifacts: [
        {
          roomId: "room-1",
          artifactInternalId: "artifact-1",
          basename: "master-plan.md",
          mimeType: "text/markdown",
          sizeBytes: 120,
        },
        {
          roomId: "room-1",
          artifactInternalId: "artifact-1",
          basename: "master-plan.md",
          mimeType: "text/markdown",
          sizeBytes: 120,
        },
      ],
    }]);

    expect(message?.metadata).toMatchObject({
      custom: {
        artifactOpenRefs: [{
          roomId: "room-1",
          artifactInternalId: "artifact-1",
          basename: "master-plan.md",
        }],
      },
    });
  });

  test("hydrates trusted ask_peer document pointers on assistant questions", () => {
    const [message] = restoreSessionMessages([{
      id: "44",
      role: "assistant",
      content: "Please review the attached document.",
      authorAgentId: "agent-moxie",
      artifacts: [{
        roomId: "peer-dm",
        artifactInternalId: "artifact-1",
        basename: "routing-test.html",
        mimeType: "text/html",
        sizeBytes: 240,
      }],
    }]);

    expect(message).toMatchObject({
      role: "assistant",
      metadata: {
        custom: {
          authorAgentId: "agent-moxie",
          artifactOpenRefs: [{
            roomId: "peer-dm",
            artifactInternalId: "artifact-1",
            basename: "routing-test.html",
          }],
        },
      },
    });
  });

  test("does not create document metadata when the server omits pointers", () => {
    const [message] = restoreSessionMessages([{
      id: "44",
      role: "user",
      content: "@alex: @mini-cloud-master-plan.md",
    }]);

    expect(message?.metadata).toBeUndefined();
  });

  test("derives assistant parity input from the actual ordinary row", () => {
    expect(roomHistoryShadowOrdinarySibling({
      id: "45",
      logicalMessageKey: "logical:45",
      role: "assistant",
      content: "I will inspect it.",
      toolCalls: JSON.stringify([{
        id: "call:45",
        type: "function",
        function: {
          name: "inspect_open_design",
          arguments: JSON.stringify({ pageSize: 25, cursor: "page:2" }),
        },
      }]),
    })).toEqual({
      logicalMessageKey: "logical:45",
      payload: {
        role: "assistant",
        content: "I will inspect it.",
        toolCalls: [{
          id: "call:45",
          name: "inspect_open_design",
          args: { pageSize: 25, cursor: "page:2" },
        }],
      },
    });
  });

  test("applies verified protected payloads before one ordinary restore pass", () => {
    const ordinary = [{
      id: "46",
      logicalMessageKey: "logical:46",
      role: "user",
      content: "ordinary fallback",
      editRevision: 0,
      reactions: [{ emoji: "👍", count: 1 }],
    }, {
      id: "47",
      role: "assistant",
      content: "unchanged fallback",
      editRevision: 0,
    }];
    const reconciled = reconcileRoomHistoryShadowPayloads(ordinary, [{
      messageId: "46",
      editRevision: 0,
      status: "verified",
      payload: { role: "user", content: "opened protected bytes" },
    }, {
      messageId: "47",
      editRevision: 0,
      status: "fallback",
    }]);
    const restored = restoreSessionMessages(reconciled);
    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({
      id: "46",
      role: "user",
      content: [{ type: "text", text: "opened protected bytes" }],
      metadata: {
        custom: {
          logicalMessageKey: "logical:46",
          editRevision: 0,
          reactions: [{ emoji: "👍", count: 1 }],
        },
      },
    });
    expect(restored[1]).toMatchObject({
      id: "47",
      content: [{ type: "text", text: "unchanged fallback" }],
    });
  });

  test.each([
    [undefined, '{"error":"Cannot project Memory: search first."}', true],
    ["success", '{"error":"Cannot project Memory: search first."}', false],
    ["error", "rejected without an envelope", true],
    [undefined, '{"error":"","detail":"not canonical"}', false],
  ] as const)("classifies only an authenticated opened projection rejection: %s %s", (
    explicitStatus,
    content,
    isError,
  ) => {
    const ordinary = [{
      id: "projection-call",
      role: "assistant",
      content: null,
      toolCalls: null,
      editRevision: 0,
    }, {
      id: "projection-result",
      role: "tool",
      content: null,
      toolName: null,
      editRevision: 0,
    }];
    const reconciled = reconcileRoomHistoryShadowPayloads(ordinary, [{
      messageId: "projection-call",
      editRevision: 0,
      status: "verified",
      payload: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "rejected-projection",
          name: "share_memory",
          args: { mode: "project" },
        }],
      },
    }, {
      messageId: "projection-result",
      editRevision: 0,
      status: "verified",
      payload: {
        role: "tool",
        content,
        toolName: "share_memory",
        sensitiveMetadata: {
          toolCallId: "rejected-projection",
          ...(explicitStatus === undefined ? {} : { toolStatus: explicitStatus }),
        },
      },
    }], { strict: true, requireVerified: true });

    const restored = restoreSessionMessages(reconciled);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: "projection-result",
      content: [{
        type: "tool-call",
        toolCallId: "rejected-projection",
        toolName: "share_memory",
        result: content,
        ...(isError ? { isError: true } : {}),
      }],
    });
    if (!isError) {
      expect(restored[0]?.content[0]).not.toHaveProperty("isError");
    }
  });

  test("does not infer a projection rejection from unauthenticated ordinary content", () => {
    const [restored] = restoreSessionMessages([{
      id: "ordinary-projection-result",
      role: "tool",
      content: '{"error":"Cannot project Memory: search first."}',
      toolName: "share_memory",
    }]);

    expect(restored?.content[0]).not.toHaveProperty("isError");
  });

  test("Fallback retains ordinary content when verification results are duplicate", () => {
    const ordinary = [{ id: "48", role: "user", content: "ordinary" }];
    expect(reconcileRoomHistoryShadowPayloads(ordinary, [{
      messageId: "48",
      editRevision: 0,
      status: "verified",
      payload: { role: "user", content: "first" },
    }, {
      messageId: "48",
      editRevision: 0,
      status: "verified",
      payload: { role: "user", content: "second" },
    }])).toEqual(ordinary);
  });

  test("Strict accounts for every row and preserves unrelated verified rows", () => {
    const ordinary = [{
      id: "strict-verified",
      role: "user",
      content: "verified ordinary sibling",
      editRevision: 2,
    }, {
      id: "strict-missing",
      role: "user",
      content: "missing ordinary secret",
      editRevision: 1,
    }, {
      id: "strict-wrong-role",
      role: "assistant",
      content: "wrong-role ordinary secret",
      toolCalls: JSON.stringify([{ id: "secret-call", name: "secret", args: {} }]),
      editRevision: 0,
    }, {
      id: "strict-duplicate",
      role: "user",
      content: "duplicate ordinary secret",
      editRevision: 3,
    }];
    const reconciled = reconcileRoomHistoryShadowPayloads(ordinary, [{
      messageId: "strict-verified",
      editRevision: 2,
      status: "verified",
      payload: { role: "user", content: "authenticated content" },
    }, {
      messageId: "strict-wrong-role",
      editRevision: 0,
      status: "verified",
      payload: { role: "user", content: "substituted role" },
    }, {
      messageId: "strict-duplicate",
      editRevision: 3,
      status: "verified",
      payload: { role: "user", content: "first candidate" },
    }, {
      messageId: "strict-duplicate",
      editRevision: 3,
      status: "verified",
      payload: { role: "user", content: "second candidate" },
    }], { strict: true });

    expect(reconciled[0]?.content).toBe("authenticated content");
    expect(reconciled.slice(1).map(message => message.content)).toEqual([
      "Encrypted history is unavailable on this device.",
      "Encrypted history is unavailable on this device.",
      "Encrypted history is unavailable on this device.",
    ]);
    expect(reconciled[2]?.toolCalls).toBe("[]");
    expect(JSON.stringify(reconciled)).not.toContain("ordinary secret");
    expect(JSON.stringify(reconciled)).not.toContain("secret-call");
  });

});
