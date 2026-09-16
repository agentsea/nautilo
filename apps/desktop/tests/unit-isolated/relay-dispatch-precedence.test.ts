/**
 * D565 production precedence receipts. These exercise the composed Desktop
 * dispatch handler at overlapping boundaries; the router kernel separately
 * pins the exhaustive fixed tuple without inspecting production source text.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-d565-relay-dispatch-precedence" },
}));

let makeDispatchHandler: typeof import("../../electron/relay.ts").makeDispatchHandler;

beforeAll(async () => {
  ({ makeDispatchHandler } = await import("../../electron/relay.ts"));
});

function browserResearchRequest(
  overrides: Partial<RelayDispatchRequest> = {},
): RelayDispatchRequest {
  return {
    correlationId: "d565-browser-research",
    toolName: "browser_research_read",
    args: {
      url: "https://example.com/d565",
      toolCallId: "tool-d565",
      laneKey: "room:d565",
    },
    impact: "read-only",
    approvalObtained: false,
    executionClass: "browser",
    ...overrides,
  };
}

describe("D565 fixed production dispatch precedence and ownership", () => {
  test("keeps representative overlapping internal operations ahead of their generic classes", async () => {
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      browserResearchRead: async () => ({ status: "ok", result: { unexpected: true } }),
    });

    // The operation name wins over the generic desktop class; it is rejected
    // by its own browser/read-only validation rather than reaching Peekaboo.
    expect(await handler(browserResearchRequest({ executionClass: "desktop" }))).toEqual({
      status: "error",
      error: "browser research read is unavailable",
    });

    // Retained SSH output similarly wins over the broad structured-SSH lane
    // and validates its own Desktop-only compatibility contract first.
    expect(await handler({
      correlationId: "d565-ssh-output",
      toolName: "structured_ssh_output",
      args: { output_artifact: "not-an-object" },
      impact: "read-only",
      approvalObtained: false,
      executionClass: "structured-ssh",
    })).toEqual({
      status: "error",
      errorCode: "STRUCTURED_SSH_OUTPUT_ARTIFACT_REQUEST_INVALID",
      error: "Structured SSH output continuation request is invalid.",
    });
  });

  test("preserves selected-handler result/error mapping and passes client cancellation through", async () => {
    const seenSignals: AbortSignal[] = [];
    const controller = new AbortController();
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      browserResearchRead: async (_request, signal) => {
        if (signal !== undefined) seenSignals.push(signal);
        return { status: "error", errorCode: "D565_RECEIPT", error: "injected refusal" };
      },
    });

    expect(await handler(browserResearchRequest(), controller.signal)).toEqual({
      status: "error",
      errorCode: "D565_RECEIPT",
      error: "injected refusal",
    });
    expect(seenSignals).toEqual([controller.signal]);
  });

  test("returns the canonical unsupported-tool result after all current lanes decline", async () => {
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      isProduction: false,
    });
    expect(await handler({
      correlationId: "d565-unknown",
      toolName: "d565_unknown_tool",
      args: {},
      impact: "low",
      approvalObtained: false,
    })).toEqual({
      status: "error",
      error: "Unknown tool: d565_unknown_tool",
    });
  });
});
