import { describe, expect, test } from "bun:test";
import { getActiveComputerUseContractCatalogueSync } from "@nautilo/agent";
import {
  enrichSessionMessagesForDisplay,
  inferToolEndStatusFromContent,
  parseAssistantToolCallsJson,
  toolDisplayNameFromDisplayContent,
} from "../../src/lib/session-messages-display.js";

describe("parseAssistantToolCallsJson", () => {
  test("parses id + name fields in order", () => {
    const raw = JSON.stringify([
      { id: "a", name: "file", args: { x: 1 } },
      { id: "b", name: "run_shell", extra: "ignored" },
    ]);
    expect(parseAssistantToolCallsJson(raw)).toEqual([
      { id: "a", name: "file" },
      { id: "b", name: "run_shell" },
    ]);
  });

  test("null or invalid JSON → empty", () => {
    expect(parseAssistantToolCallsJson(null)).toEqual([]);
    expect(parseAssistantToolCallsJson("")).toEqual([]);
    expect(parseAssistantToolCallsJson("{")).toEqual([]);
    expect(parseAssistantToolCallsJson("{}")).toEqual([]);
  });
});

describe("inferToolEndStatusFromContent", () => {
  test("treats normal stdout as success", () => {
    expect(inferToolEndStatusFromContent("exit code 0\n")).toBe("success");
  });

  test("detects plain-text errors", () => {
    expect(inferToolEndStatusFromContent("Error: boom")).toBe("error");
    expect(inferToolEndStatusFromContent("error: lowercase")).toBe("error");
    expect(inferToolEndStatusFromContent("Security: blocked")).toBe("error");
  });

  test("detects JSON tool error shape", () => {
    expect(inferToolEndStatusFromContent(JSON.stringify({ error: "nope" }))).toBe("error");
  });
});

describe("enrichSessionMessagesForDisplay", () => {
  test("does not infer a tool status or project a body when ordinary content is absent", () => {
    const [message] = enrichSessionMessagesForDisplay([
      { id: "t1", role: "tool", content: null, toolCalls: null, toolName: "secret_tool" },
    ]);
    expect(message).toEqual({
      id: "t1",
      role: "tool",
      content: null,
      toolCalls: null,
      toolName: "secret_tool",
    });
  });

  test("pairs FIFO tool_calls with tool rows and sets displayContent", () => {
    const messages = enrichSessionMessagesForDisplay([
      {
        id: "u1",
        role: "user",
        content: "go",
        toolCalls: null,
      },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([
          { id: "c1", name: "alpha", args: {} },
          { id: "c2", name: "beta", args: {} },
        ]),
      },
      { id: "t1", role: "tool", content: "out-a", toolCalls: null },
      { id: "t2", role: "tool", content: "Error: failed", toolCalls: null },
    ]);

    expect(messages[2]!.displayContent).toBe("⚙ alpha [success]");
    expect(messages[3]!.displayContent).toBe("⚙ beta [error]");
    expect(messages[0]!.displayContent).toBeUndefined();
    expect(messages[1]!.displayContent).toBeUndefined();
  });

  test("persisted tool_name wins over FIFO assistant name", () => {
    const out = enrichSessionMessagesForDisplay([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([{ id: "c1", name: "wrong_queue", args: {} }]),
      },
      {
        id: "t1",
        role: "tool",
        content: "ok",
        toolCalls: null,
        toolName: "truthy_name",
      },
    ]);
    expect(out[1]!.displayContent).toBe("⚙ truthy_name [success]");
  });

  test("orphan tool row (empty queue) uses generic tool name", () => {
    const enriched = enrichSessionMessagesForDisplay([
      { id: "t1", role: "tool", content: "lonely", toolCalls: null },
    ]);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]!.displayContent).toBe("⚙ tool [success]");
  });

  test("assistant with text and tool_calls still queues calls before subsequent tools", () => {
    const out = enrichSessionMessagesForDisplay([
      {
        id: "a1",
        role: "assistant",
        content: "thinking",
        toolCalls: JSON.stringify([{ id: "c1", name: "file", args: {} }]),
      },
      { id: "t1", role: "tool", content: "ok", toolCalls: null },
    ]);
    expect(out[1]!.displayContent).toBe("⚙ file [success]");
  });

  test("does not carry an unpaired tool call across a later Human turn", () => {
    const out = enrichSessionMessagesForDisplay([
      { id: "u1", role: "user", content: "start", toolCalls: null },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([{ id: "cancelled", name: "old_tool", args: {} }]),
      },
      { id: "u2", role: "user", content: "try again", toolCalls: null },
      {
        id: "a2",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([{ id: "fresh", name: "new_tool", args: {} }]),
      },
      { id: "t2", role: "tool", content: "ok", toolCalls: null },
    ]);

    expect(out[4]!.displayContent).toBe("⚙ new_tool [success]");
  });

  test("projects durable Computer Use host results for safe history rendering", () => {
    const context = `dctx_${"a".repeat(43)}`;
    const target = { version: 1, context, reference: `dtgt_${"b".repeat(43)}` };
    const verifyContract = getActiveComputerUseContractCatalogueSync().contracts.find(
      (entry) => entry.projection.toolName === "computer_verify",
    );
    expect(verifyContract).toBeDefined();
    const out = enrichSessionMessagesForDisplay([
      {
        id: "t1",
        role: "tool",
        toolName: "computer_verify",
        toolCalls: null,
        content: JSON.stringify({
          kind: "result",
          protocol: { major: 3, minor: 0 },
          requestId: "request-1",
          fence: {
            hostGeneration: "host-1",
            driverGeneration: "driver-1",
            cancellationGeneration: 0,
          },
          contract: verifyContract!.descriptor,
          settlement: "completed",
          result: {
            version: 1,
            target,
            provider: "cua",
            status: "satisfied",
            stable: true,
            elapsedMs: 513,
            samples: 2,
            predicates: [{ index: 0, status: "satisfied", unknownReason: null }],
            outcome: {
              version: 1,
              phase: "post_effect_verification",
              retrySafety: "never",
              stateChangeCertainty: "not_applicable",
              providerCondition: "ready",
              targetCondition: "current",
              recovery: [],
            },
          },
        }),
      },
    ]);

    const projected = JSON.parse(out[0]!.content) as Record<string, unknown>;
    expect(projected).toMatchObject({
      version: 1,
      ok: true,
      settlement: "completed",
      presentation: {
        label: "Verify native computer state",
        summary: "Computer Use completed.",
      },
      result: {
        status: "satisfied",
        stable: true,
        samples: 2,
      },
    });
    expect(out[0]!.content).not.toContain("hostGeneration");
    expect(out[0]!.content).not.toContain("driverGeneration");
  });
});

describe("toolDisplayNameFromDisplayContent", () => {
  test("extracts name for success and error lines", () => {
    expect(toolDisplayNameFromDisplayContent("⚙ run_shell [success]")).toBe("run_shell");
    expect(toolDisplayNameFromDisplayContent("⚙ my tool [error]")).toBe("my tool");
  });

  test("supports optional duration suffix (WS parity)", () => {
    expect(toolDisplayNameFromDisplayContent("⚙ x [success 42ms]")).toBe("x");
  });

  test("returns undefined for non-matching strings", () => {
    expect(toolDisplayNameFromDisplayContent(undefined)).toBeUndefined();
    expect(toolDisplayNameFromDisplayContent("raw blob")).toBeUndefined();
  });
});
