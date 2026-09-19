/**
 * Regression tests for the session-rehydrate auth contract.
 *
 * Why these tests exist — on 2026-04-21 we discovered
 * NautiloRuntimeProvider's mount effect was calling
 * `/api/sessions/latest?limit=50` with NO Authorization header. The
 * endpoint returned `{ messages: [] }` silently, which wiped every
 * prior user+assistant turn from the UI on every page load, HMR
 * cycle, or route reparent. The user saw a blank thread with no
 * explanation; you couldn't tell it from a brand-new session.
 *
 * Room transport/auth outcome coverage now lives at the bound Room operations
 * facade and `restoreRoomReadOutcome`; this file retains pure transcript
 * restoration regressions.
 */

import { describe, test, expect } from "bun:test";
import {
  reconcileRoomHistoryShadowPayloads,
  reconcileFetchedRoomHistoryPage,
  restoreSessionMessages,
} from "../../src/adapters/session-rehydrate";
import { runShellRenderer } from "../../src/components/tool-card/renderers/run-shell";

function firstContentPart(message: unknown): Record<string, unknown> | null {
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const part: unknown = content[0];
  return typeof part === "object" && part !== null
    ? part as Record<string, unknown>
    : null;
}

type HydrationRow = Parameters<typeof restoreSessionMessages>[0][number];

function assistantToolCalls(
  id: string,
  calls: readonly Record<string, unknown>[],
): HydrationRow {
  return { id, role: "assistant", content: "", toolCalls: JSON.stringify(calls) };
}

function toolResult(
  id: string,
  toolName: string,
  content: string | null,
  authenticatedToolCallId?: string,
): HydrationRow {
  return {
    id,
    role: "tool",
    toolName,
    content,
    ...(authenticatedToolCallId === undefined ? {} : { authenticatedToolCallId }),
  };
}

function restoredToolParts(rows: readonly HydrationRow[]): Record<string, unknown>[] {
  return restoreSessionMessages(rows).map(firstContentPart).filter(
    (part): part is Record<string, unknown> => part !== null,
  );
}

describe("restoreSessionMessages — sealed Computer Use receipt", () => {
  test("preserves a successful partial receipt through history restoration", () => {
    const receipt = JSON.stringify({
      version: 1,
      ok: true,
      settlement: "completed",
      presentation: {
        label: "Observe native computer state",
        summary: "Computer Use completed with a partial result. Continue from the returned result where available.",
      },
      result: {
        kind: "observation",
        observation: { operation: "desktop_state", completeness: "partial", privateTarget: "not-rendered" },
      },
    });
    const [message] = restoreSessionMessages([
      { id: "a1", role: "assistant", content: "", toolCalls: JSON.stringify([{ id: "call-1", name: "computer_observe", args: {} }]) },
      { id: "t1", role: "tool", toolName: "computer_observe", content: receipt, displayContent: "⚙ computer_observe [success]" },
    ]);
    const part: unknown = Array.isArray(message?.content) ? message.content[0] : undefined;
    expect(part).toMatchObject({
      type: "tool-call", toolCallId: "call-1", toolName: "computer_observe", result: receipt,
    });
  });
});

describe("restoreSessionMessages — D426 root summaries", () => {
  test("preserves authoritative summary metadata for parent reply affordances", () => {
    const [message] = restoreSessionMessages([
      {
        id: "42",
        role: "user",
        content: "Parent root",
        replyCount: 3,
        lastReplyAt: "2026-07-15T10:00:00.000Z",
        summaryRevision: 7,
      },
    ]);

    expect(message?.metadata).toEqual({
      custom: {
        replyCount: 3,
        lastReplyAt: "2026-07-15T10:00:00.000Z",
        summaryRevision: 7,
      },
    });
  });
});

describe("restoreSessionMessages — durable terminal execution notices", () => {
  test("attaches authenticated cold-load outcomes only to their selected Human input", async () => {
    const messages: HydrationRow[] = [
      { id: "27", role: "user", content: "Stop this", logicalMessageKey: "logical:27" },
      { id: "28", role: "user", content: "Keep this", logicalMessageKey: "logical:28" },
    ];
    const reconciled = await reconcileFetchedRoomHistoryPage(
      "40000000-0000-4000-8000-000000000275",
      messages,
      {
        responseVersion: 1,
        status: "ready",
        operationId: "history:terminal",
        clientRequestKey: "history:terminal:request",
        selectedCoordinateDigestBase64url: "A".repeat(43),
        selectedCount: 2,
        selectedCoordinates: [
          { sessionId: "41000000-0000-4000-8000-000000000275", messageId: 27,
            editRevision: 0, role: "user", logicalMessageKey: "logical:27" },
          { sessionId: "41000000-0000-4000-8000-000000000275", messageId: 28,
            editRevision: 0, role: "user", logicalMessageKey: "logical:28" },
        ],
        eligibleCount: 1,
        authority: {
          scheme: "domain_key_v2", keyClass: "ai", subjectHumanId: "human:one",
          readerDeviceId: "device:browser", readerDeviceSigningKeyGeneration: 1,
          hostAuthorizationRevision: 1, policyRevision: 1,
          roomId: "40000000-0000-4000-8000-000000000275",
          namespaceId: "42000000-0000-4000-8000-000000000275",
          namespaceAccessRevision: 0, namespaceCurrentGeneration: 1,
          namespaceHeadDigestBase64url: "A".repeat(43), domainId: "domain:one",
          domainKeyGeneration: 1, domainAuthorizationRevision: 1,
          domainHeadDigestBase64url: "A".repeat(43), namespaceBundleRevision: 1,
          namespaceBundleDigestBase64url: "A".repeat(43),
        },
        records: [{
          coordinate: {
            sessionId: "41000000-0000-4000-8000-000000000275", messageId: 27,
            editRevision: 0, role: "user", logicalMessageKey: "logical:27",
          },
          shadowOperationId: "turn:27",
          shadowTranscriptOrdinal: 1,
          ordinaryPayloadBytesBase64url: "e30",
          retainedGeneration: {
            namespaceGeneration: 1, accessRevision: 0,
            headDigestBase64url: "A".repeat(43),
            publicationDigestBase64url: "A".repeat(43),
            publicationSetDigestBase64url: "A".repeat(43),
            audienceFingerprintBase64url: "A".repeat(43),
          },
          protectedMessage: {
            dtoVersion: 2,
            projection: {
              messageId: "27", logicalMessageKey: "logical:27",
              sessionId: "41000000-0000-4000-8000-000000000275",
              roomId: "40000000-0000-4000-8000-000000000275",
              namespaceId: "42000000-0000-4000-8000-000000000275",
              role: "user", createdAt: "2026-08-23T12:00:00.000Z", editRevision: 0,
            },
            protectedPayload: { status: "pending", reason: "shadow_pending" },
          },
        }],
        signerEvidence: [],
        terminalExecutions: [
          { messageId: 27, executionId: "execution:cancelled", classification: "cancelled" },
          { messageId: 27, executionId: "execution:lost", classification: "process_lost" },
        ],
        acknowledgement: { status: "already_recorded" },
      },
      {
        createIntent: () => ({ requestVersion: 1, clientRequestKey: "unused" }),
        reconcile: async ({ messages: selected }) => selected,
      },
      { protectedAttempt: true },
    );
    const restored = restoreSessionMessages(reconciled);

    expect(restored[0]?.metadata?.custom?.terminalExecutions).toEqual([
      { messageId: 27, executionId: "execution:cancelled", classification: "cancelled" },
      { messageId: 27, executionId: "execution:lost", classification: "process_lost" },
    ]);
    expect(restored[1]?.metadata?.custom).not.toHaveProperty("terminalExecutions");
  });
});

describe("restoreSessionMessages — D497 historical shell-card fidelity", () => {
  function restoredToolCall(messages: Parameters<typeof restoreSessionMessages>[0]) {
    const [message] = restoreSessionMessages(messages);
    const content = firstContentPart(message);
    return content as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
      result?: string;
    };
  }

  test("rehydrates canonical run_shell args into the renderer-visible success card", () => {
    const call = restoredToolCall([
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([{
          id: "shell-current",
          name: "run_shell",
          args: {
            command: "git status --short",
            cwd: "nautilo",
            timeout: 60_000,
          },
        }]),
      },
      { id: "tool-1", role: "tool", toolName: "run_shell", content: "{\"stdout\":\"\"}" },
    ]);

    expect(call).toMatchObject({
      type: "tool-call",
      toolCallId: "shell-current",
      toolName: "run_shell",
      args: { command: "git status --short", cwd: "nautilo", timeout: 60_000 },
    });
    expect(runShellRenderer.collapsedSummary?.({
      args: call.args ?? {},
      result: call.result,
      resultText: call.result,
      state: "success",
    })).toBe("git status --short");
  });

  test("normalizes the legacy provider wrapper for a failed run_shell without exposing credentials", () => {
    const call = restoredToolCall([
      {
        id: "assistant-legacy",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([{
          id: "shell-legacy",
          type: "function",
          function: {
            name: "run_shell",
            arguments: JSON.stringify({
              command: "gh issue list -R agentsea/nautilo --limit 20",
              cwd: "nautilo",
              sessionToken: "must-not-reach-the-tool-card",
            }),
          },
        }]),
      },
      { id: "tool-legacy", role: "tool", toolName: "run_shell", content: "Error: gh exited 1" },
    ]);

    expect(call).toMatchObject({
      toolCallId: "shell-legacy",
      toolName: "run_shell",
      args: {
        command: "gh issue list -R agentsea/nautilo --limit 20",
        cwd: "nautilo",
      },
    });
    expect(call.args).not.toHaveProperty("sessionToken");
    expect(JSON.stringify(call)).not.toContain("must-not-reach-the-tool-card");
    expect(runShellRenderer.collapsedSummary?.({
      args: call.args ?? {},
      result: call.result,
      resultText: call.result,
      state: "error",
    })).toBe("gh issue list -R agentsea/nautilo --limit 20");
  });

  test("does not let a page-boundary orphan tool row steal a later command", () => {
    const restored = restoreSessionMessages([
      { id: "orphan-tool", role: "tool", toolName: "run_shell", content: "error" },
      {
        id: "assistant-after-boundary",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([{
          id: "later-call",
          name: "run_shell",
          args: { command: "git log -1" },
        }]),
      },
      { id: "matched-tool", role: "tool", toolName: "run_shell", content: "ok" },
    ]);

    const first = firstContentPart(restored[0]);
    const second = firstContentPart(restored[1]);
    expect((first as { args?: Record<string, unknown> }).args).toEqual({});
    expect(second).toMatchObject({
      toolCallId: "later-call",
      args: { command: "git log -1" },
    });
  });

  test("does not carry an unpaired tool call across a later Human turn", () => {
    const restored = restoreSessionMessages([
      { id: "user-old", role: "user", content: "start" },
      {
        id: "assistant-old",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([{
          id: "old-call",
          name: "run_shell",
          args: { command: "sleep 30" },
        }]),
      },
      { id: "user-new", role: "user", content: "continue" },
      {
        id: "assistant-new",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([{
          id: "new-call",
          name: "run_shell",
          args: { command: "printf safe" },
        }]),
      },
      {
        id: "tool-new",
        role: "tool",
        toolName: "run_shell",
        content: "Error: outcome unknown after relay dispatch (disconnect)",
        displayContent: "⚙ run_shell [error]",
      },
    ]);

    const tool = restored.find((message) => message.id === "tool-new");
    const part = firstContentPart(tool);
    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "new-call",
      toolName: "run_shell",
      args: { command: "printf safe" },
      isError: true,
    });
    expect(JSON.stringify(restored)).not.toContain("sleep 30");
  });

  test("keeps a malformed call's identity without inventing args from its result", () => {
    const call = restoredToolCall([
      {
        id: "assistant-malformed",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([{
          id: "shell-malformed",
          name: "run_shell",
          args: "not valid JSON",
        }]),
      },
      { id: "tool-malformed", role: "tool", toolName: "run_shell", content: "Command failed\nsecret output" },
    ]);

    expect(call).toMatchObject({
      toolCallId: "shell-malformed",
      toolName: "run_shell",
      args: {},
    });
    expect(call.args).not.toHaveProperty("command");
  });
});

describe("restoreSessionMessages — authenticated protected tool correlation", () => {
  test("retains the verified protected tool-call id on the local hydration row", () => {
    const [reconciled] = reconcileRoomHistoryShadowPayloads([{
      id: "tool-protected",
      role: "tool",
      content: "ordinary sibling",
      toolName: "share_memory",
      editRevision: 0,
    }], [{
      messageId: "tool-protected",
      editRevision: 0,
      status: "verified",
      payload: {
        role: "tool",
        content: "opened result",
        toolName: "share_memory",
        sensitiveMetadata: { toolCallId: "share-exact" },
      },
    }]);

    expect(reconciled).toMatchObject({
      content: "opened result",
      authenticatedToolCallId: "share-exact",
    });
  });

  test("pairs interleaved results by authenticated id despite resumed same-id calls", () => {
    const parts = restoredToolParts([
      assistantToolCalls("assistant-share-1", [{ id: "share-1", name: "share_memory", args: {
        mode: "project", proposed_content: "first", target_room_name: "Team",
      } }]),
      assistantToolCalls("assistant-share-1-resume", [{
        id: "share-1", name: "share_memory", args: { mode: "project" },
      }]),
      toolResult("tool-share-1", "share_memory", "first result", "share-1"),
      assistantToolCalls("assistant-discover", [{ id: "discover-1", name: "discover_tools", args: {
        query: "fresh projection preflight share memory",
      } }]),
      toolResult("tool-discover", "discover_tools", "discover result", "discover-1"),
      assistantToolCalls("assistant-share-2", [{ id: "share-2", name: "share_memory", args: {
        mode: "project", proposed_content: "second", target_room_name: "Team",
      } }]),
      assistantToolCalls("assistant-share-2-resume", [{
        id: "share-2", name: "share_memory", args: { mode: "project" },
      }]),
      toolResult("tool-share-2", "share_memory", "second result", "share-2"),
    ]);

    expect(parts).toMatchObject([
      { toolCallId: "share-1", toolName: "share_memory", args: {
        mode: "project", proposed_content: "first", target_room_name: "Team",
      } },
      { toolCallId: "discover-1", toolName: "discover_tools", args: {
        query: "fresh projection preflight share memory",
      } },
      { toolCallId: "share-2", toolName: "share_memory", args: {
        mode: "project", proposed_content: "second", target_room_name: "Team",
      } },
    ]);
  });

  test("completion removes every queued same-id copy before a later id reuse", () => {
    const parts = restoredToolParts([
      assistantToolCalls("assistant-first", [{
        id: "same-id", name: "share_memory", args: { mode: "project", proposed_content: "first" },
      }]),
      assistantToolCalls("assistant-first-resume", [{
        id: "same-id", name: "share_memory", args: { mode: "project" },
      }]),
      toolResult("tool-first", "share_memory", "first result", "same-id"),
      assistantToolCalls("assistant-reused", [{
        id: "same-id", name: "share_memory", args: { mode: "project", proposed_content: "new" },
      }]),
      toolResult("tool-reused", "share_memory", "new result", "same-id"),
    ]);

    expect(parts).toMatchObject([
      { toolCallId: "same-id", args: { proposed_content: "first" }, result: "first result" },
      { toolCallId: "same-id", args: { proposed_content: "new" }, result: "new result" },
    ]);
  });

  test("an unmatched authenticated id cannot steal a pending call", () => {
    const parts = restoredToolParts([
      assistantToolCalls("assistant-safe", [{
        id: "safe-call", name: "discover_tools", args: { query: "safe query" },
      }]),
      toolResult("tool-unmatched", "share_memory", "unmatched", "other-call"),
      toolResult("tool-safe", "discover_tools", "matched", "safe-call"),
    ]);

    expect(parts).toMatchObject([
      { toolCallId: "other-call", toolName: "share_memory", args: {}, result: "unmatched" },
      { toolCallId: "safe-call", toolName: "discover_tools", args: { query: "safe query" }, result: "matched" },
    ]);
  });

  test("empty and withheld authenticated results retire every matching pending copy", () => {
    for (const skippedContent of ["", null] as const) {
      const parts = restoredToolParts([
        assistantToolCalls("assistant-skipped", [{
          id: "same-id", name: "share_memory", args: { mode: "project", proposed_content: "stale" },
        }]),
        assistantToolCalls("assistant-skipped-resume", [{
          id: "same-id", name: "share_memory", args: { mode: "project" },
        }]),
        toolResult("tool-skipped", "share_memory", skippedContent, "same-id"),
        assistantToolCalls("assistant-after-skip", [{
          id: "same-id", name: "share_memory", args: { mode: "project", proposed_content: "fresh" },
        }]),
        toolResult("tool-after-skip", "share_memory", "fresh result", "same-id"),
      ]);

      expect(parts).toMatchObject([{
        toolCallId: "same-id",
        args: { proposed_content: "fresh" },
        result: "fresh result",
      }]);
    }
  });
});
