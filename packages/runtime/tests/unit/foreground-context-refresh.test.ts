import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
  type ForegroundContextRefreshTransition,
  type NautiloState,
} from "@nautilo/agent";
import { ModelCatalogSchema } from "@nautilo/types";
import type { ProtectedConversationExecutorTurnScope } from "../../src/conversation/conversation-execution-services";
import { createLocalExecutionHistoryPort } from "../../src/conversation/local-execution-history";
import type { RoomHistoryHit } from "../../src/conductor/history-search";
import { acceptedForegroundMessages, createForegroundContextRebuilder, ForegroundContextReceipts } from "../../src/executors/foreground-context-refresh";

function transition(signal?: AbortSignal, modelId = "test-model"): ForegroundContextRefreshTransition {
  const accepted = new HumanMessage("Keep working on my request");
  return {
    state: {
      messages: [accepted, new AIMessage({ content: "Checking", tool_calls: [{ id: "call", name: "read", args: {} }] }), new ToolMessage({ content: "completed result", tool_call_id: "call" })],
      foregroundContextRefreshSource: { acceptedMessages: [accepted], triggerMessageId: 10 },
    } as NautiloState,
    request: { kind: "foreground_context_refresh", status: "ready", reason: "visible_assistant_text", modelId, maximumContextCharacters: 1000, projectionFingerprint: "cut" },
    ...(signal === undefined ? {} : { signal }),
  };
}

function localExecutionToolHit(): RoomHistoryHit {
  return {
    messageId: 14,
    ts: new Date("2026-01-01T00:00:00.000Z"),
    role: "tool",
    toolName: "exec_command",
    authorDisplayName: "Genie",
    handle: "genie",
    authorActorId: "actor-agent",
    snippet: JSON.stringify({
      executionId: "execution-1",
      session_id: "execution-1",
      generation: "generation-1",
      state: "running",
    }),
    foregroundExecutionId: "turn-1",
    sourceOrderTimestamp: "2026-01-01T00:00:00.000Z",
  };
}

const protectedRefreshModelId = "openrouter:openai/gpt-5.6-sol";

async function activateProtectedRefreshModelCatalog(): Promise<void> {
  const catalog = ModelCatalogSchema.parse({
    version: 1,
    catalogVersion: "2026.01.01.1",
    publishedAt: "2026-01-01T00:00:00.000Z",
    entries: [{
      id: protectedRefreshModelId,
      displayName: "Foreground Refresh Test Model",
      provider: "openrouter",
      routing: "openrouter",
      priority: 1,
      defaultEnabled: true,
      modalities: { input: ["text"], output: ["text"] },
      features: { tools: true, structuredOutputs: true, reasoning: true },
      limits: { contextTokens: 8_000, outputTokens: 1_000 },
      cost: { coefficient: 1 },
      privacy: { grade: 2 },
      intelligence: { tier: "frontier" },
    }],
  });
  configureRuntimeModelCatalog({
    loader: {
      get: async () => ({
        catalog,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2026-01-01T00:00:00.000Z",
        originUrl: "https://catalog.invalid/foreground-refresh-test.json",
        reason: "",
        catalogVersion: catalog.catalogVersion,
      }),
      refresh: async () => {},
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
}

describe("foreground narrative continuation", () => {
  test("only durable coordinates advance the read fence; resumed Humans cannot replace the original trigger", () => {
    const receipts = new ForegroundContextReceipts();
    receipts.recordRows([{ id: "10", role: "user" }, { id: "11", role: "assistant" }]);
    receipts.recordIds([15, 13]);
    expect(receipts.triggerMessageId).toBe(10);
    expect(receipts.throughMessageIdInclusive).toBe(15);
    expect(() => receipts.recordIds([NaN])).toThrow("Invalid committed");
    const resumed = new ForegroundContextReceipts(undefined, false);
    resumed.recordRows([{ id: "21", role: "user" }]);
    expect(resumed.triggerMessageId).toBeUndefined();
    expect(resumed.throughMessageIdInclusive).toBe(21);
  });

  test("settled rebuild places the accepted request once before narrated completed progress", async () => {
    const receipts = new ForegroundContextReceipts(10);
    receipts.recordRows([{ id: "14", role: "tool" }]);
    const input = transition();
    let observed: unknown;
    const rebuild = createForegroundContextRebuilder({ roomId: "room", ownerId: "owner", agentId: "agent", receipts }, {
      readHistory: async (args) => {
        observed = args;
        return [new HumanMessage({ content: "Narrated completed result", additional_kwargs: { nautilo_transient_context: true } })];
      },
    });
    const result = await rebuild(input);
    expect(observed).toMatchObject({ currentMessageId: 10, throughMessageIdInclusive: 14, maximumContextCharacters: 1000, modelId: "test-model" });
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error("expected source-aware rebuild");
    expect(result.messages.map((message) => message.content)).toEqual(["Keep working on my request", "Narrated completed result"]);
    expect(result.messages.filter((message) => message.content === "Keep working on my request")).toHaveLength(1);
    expect(result.messages.some((message) => ToolMessage.isInstance(message))).toBe(false);
    expect(result.source).toMatchObject({ triggerMessageId: 10, throughMessageIdInclusive: 14 });
    expect(result.source.retainedMessages).toBeUndefined();
  });

  test("fresh authorized tool hits replace the local-execution recovery source", async () => {
    const hit = localExecutionToolHit();
    let admitted: readonly RoomHistoryHit[] = [];
    const receipts = new ForegroundContextReceipts(10);
    receipts.recordIds([14]);
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts,
      onAuthorizedHistory: (hits) => { admitted = hits; },
    }, {
      readHistory: async (args) => {
        args.onAuthorizedHistory?.([hit]);
        return [];
      },
    });

    await rebuild(transition());

    expect(admitted).toEqual([hit]);
    const port = createLocalExecutionHistoryPort({
      conversationId: "room:graph:bot:agent",
      readPolicy: async () => ({ mode: "plaintext_only", revision: 1 }),
      readScope: async () => ({
        graphThreadId: "room:graph",
        agentActorId: "actor-agent",
      }),
      readTranscript: async () => admitted,
    });
    expect(await port.withReference("execution-1", async (reference) => reference))
      .toEqual({
        executionId: "execution-1",
        generation: "generation-1",
        sourceMessageId: 14,
      });
  });

  test("protected refresh publishes authorized tool hits from the fresh read", async () => {
    const hit = localExecutionToolHit();
    let admitted: readonly RoomHistoryHit[] = [];
    const protectedTurn: ProtectedConversationExecutorTurnScope = {
      history: [],
      readFreshHistory: async (input) => ({
        status: "executed",
        value: await input.execute([hit]),
      }),
      persist: async () => [],
    };
    const receipts = new ForegroundContextReceipts(10);
    receipts.recordIds([14]);
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts,
      protectedTurn,
      onAuthorizedHistory: (hits) => { admitted = hits; },
    });

    await activateProtectedRefreshModelCatalog();
    try {
      await rebuild(transition(undefined, protectedRefreshModelId));
      expect(admitted).toEqual([hit]);
    } finally {
      resetRuntimeModelCatalog();
    }
  });

  test("rejected protected refresh does not replace the admitted recovery source", async () => {
    const original = localExecutionToolHit();
    let admitted: readonly RoomHistoryHit[] = [original];
    const protectedTurn: ProtectedConversationExecutorTurnScope = {
      history: [],
      readFreshHistory: async () => ({
        status: "unavailable",
        reason: "authorization_unavailable",
      }),
      persist: async () => [],
    };
    const receipts = new ForegroundContextReceipts(10);
    receipts.recordIds([14]);
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts,
      protectedTurn,
      onAuthorizedHistory: (hits) => { admitted = hits; },
    });

    expect(rebuild(transition())).rejects.toThrow(
      "Authorized foreground history refresh is unavailable",
    );
    expect(admitted).toEqual([original]);
  });

  test("parked resume replaces settled narration in place and preserves the exact question/reply sequence", async () => {
    const original = new HumanMessage("original request");
    const question = new AIMessage("Which destination should I use?");
    const reply = new HumanMessage("Use the approved destination");
    const staleNarrative = new HumanMessage({
      content: "Stale narration from the settled refresh",
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const freshNarrative = new HumanMessage({
      content: "Narrated work completed before the question",
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts: new ForegroundContextReceipts(undefined, false),
    }, {
      readHistory: async (args) => {
        expect(args).toMatchObject({
          currentMessageId: 10,
          throughMessageIdInclusive: 14,
          foregroundExecutionId: "turn-1",
        });
        expect(args.maximumContextCharacters).toBeLessThan(1000);
        return [freshNarrative];
      },
    });
    const result = await rebuild({
      state: {
        messages: [original, staleNarrative, question, reply],
        foregroundContextRefreshSource: {
          acceptedMessages: [original],
          triggerMessageId: 10,
          throughMessageIdInclusive: 14,
          executionId: "turn-1",
        },
      } as NautiloState,
      request: {
        kind: "foreground_context_refresh",
        status: "ready",
        reason: "visible_assistant_text",
        modelId: "test-model",
        maximumContextCharacters: 1000,
        projectionFingerprint: "parked",
      },
    });
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error("expected source-aware rebuild");
    expect(result.messages.map((message) => message.content)).toEqual([
      "original request",
      "Narrated work completed before the question",
      "Which destination should I use?",
      "Use the approved destination",
    ]);
    expect(result.messages).not.toContain(staleNarrative);
    expect(result.source.acceptedMessages.map((message) => message.content)).toEqual([
      "original request",
      "Use the approved destination",
    ]);
    expect(result.source.retainedMessages?.map((message) => message.content)).toEqual([
      "Which destination should I use?",
    ]);
    expect(result.source.throughMessageIdInclusive).toBe(14);
  });

  test("repeated no-cut pressure keeps fresh narration after the accepted request", async () => {
    const original = new HumanMessage("complete all eight checks");
    const staleNarrative = new HumanMessage({
      content: "Old completed progress",
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const freshNarrative = new HumanMessage({
      content: "Fresh completed progress",
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts: new ForegroundContextReceipts(undefined, false),
    }, {
      readHistory: async () => [freshNarrative],
    });
    const result = await rebuild({
      state: {
        messages: [original, staleNarrative],
        foregroundContextRefreshSource: {
          acceptedMessages: [original],
          triggerMessageId: 10,
          throughMessageIdInclusive: 14,
          executionId: "turn-1",
        },
      } as NautiloState,
      request: {
        kind: "foreground_context_refresh",
        status: "ready",
        reason: "context_pressure",
        modelId: "test-model",
        maximumContextCharacters: 1000,
        projectionFingerprint: "repeat-no-cut",
      },
    });
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error("expected source-aware rebuild");
    expect(result.messages).toEqual([original, freshNarrative]);
  });

  test("no-cut fork refresh retains its transient live marker once without reserving the same suffix twice", async () => {
    const priorNarrative = new HumanMessage({
      content: "Narrated durable history",
      additional_kwargs: { nautilo_transient_context: true },
    });
    const forkMarker = new HumanMessage({
      content: "[FORK BACKGROUND] Do not redo the preceding request.",
      additional_kwargs: { nautilo_transient_context: true },
    });
    const request = new HumanMessage("Handle only this fork request");
    const question = new AIMessage("Which destination should I use?");
    const reply = new HumanMessage("Use the approved destination");
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts: new ForegroundContextReceipts(undefined, false),
    }, {
      readHistory: async (args) => {
        expect(args.maximumContextCharacters).toBe(1000);
        return [priorNarrative];
      },
    });
    const result = await rebuild({
      state: {
        messages: [priorNarrative, forkMarker, request, question, reply],
        foregroundContextRefreshSource: {
          acceptedMessages: [forkMarker, request, reply],
          retainedMessages: [question],
          triggerMessageId: 10,
          throughMessageIdInclusive: 14,
          executionId: "turn-1",
        },
      } as NautiloState,
      request: {
        kind: "foreground_context_refresh",
        status: "ready",
        reason: "visible_assistant_text",
        modelId: "test-model",
        maximumContextCharacters: 1000,
        projectionFingerprint: "fork-parked",
      },
    });
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error("expected source-aware rebuild");
    expect(result.messages.map((message) => message.content)).toEqual([
      "Narrated durable history",
      "[FORK BACKGROUND] Do not redo the preceding request.",
      "Handle only this fork request",
      "Which destination should I use?",
      "Use the approved destination",
    ]);
    expect(result.messages.filter((message) => message === forkMarker)).toHaveLength(1);
    expect(result.source.retainedMessages?.map((message) => message.content)).toEqual([
      "Which destination should I use?",
    ]);
  });

  test("accepted Human reply survives refresh; transient history is not promoted to instructions", () => {
    const original = new HumanMessage("original request");
    const reply = new HumanMessage("Use the approved destination");
    const context = new HumanMessage({ content: "quoted history", additional_kwargs: { nautilo_transient_context: true } });
    expect(acceptedForegroundMessages([original], [context, original, reply]).map((message) => message.content))
      .toEqual(["original request", "Use the approved destination"]);
  });

  test("identical accepted replies remain distinct occurrences", () => {
    const original = new HumanMessage("yes");
    const reply = new HumanMessage("yes");
    expect(acceptedForegroundMessages([original], [original, reply]).map((message) => message.content)).toEqual(["yes", "yes"]);
  });

  test("parked refresh anchors an identical reply at the original request", async () => {
    const priorNarrative = new HumanMessage({
      content: "Narrated durable history",
      additional_kwargs: { nautilo_transient_context: true },
    });
    const original = new HumanMessage("yes");
    const question = new AIMessage("Should I continue?");
    const reply = new HumanMessage("yes");
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts: new ForegroundContextReceipts(undefined, false),
    }, {
      readHistory: async () => [priorNarrative],
    });
    const result = await rebuild({
      state: {
        messages: [priorNarrative, original, question, reply],
        foregroundContextRefreshSource: {
          acceptedMessages: [original],
          triggerMessageId: 10,
          throughMessageIdInclusive: 14,
          executionId: "turn-1",
        },
      } as NautiloState,
      request: {
        kind: "foreground_context_refresh",
        status: "ready",
        reason: "visible_assistant_text",
        modelId: "test-model",
        maximumContextCharacters: 1000,
        projectionFingerprint: "identical-reply",
      },
    });
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error("expected source-aware rebuild");
    expect(result.messages.map((message) => message.content)).toEqual([
      "Narrated durable history",
      "yes",
      "Should I continue?",
      "yes",
    ]);
    expect(result.source.acceptedMessages).toHaveLength(2);
    expect(result.source.retainedMessages).toEqual([question]);
  });

  test("cancellation before or during history loading prevents a replacement", async () => {
    const controller = new AbortController();
    const receipts = new ForegroundContextReceipts(10);
    receipts.recordIds([12]);
    let calls = 0;
    const rebuild = createForegroundContextRebuilder({ roomId: "room", ownerId: "owner", agentId: "agent", receipts }, {
      readHistory: async () => { calls++; controller.abort(); return []; },
    });
    expect(rebuild(transition(controller.signal))).rejects.toThrow();
    expect(calls).toBe(1);
    expect(rebuild(transition(controller.signal))).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("missing committed boundary fails without a history read", async () => {
    let reads = 0;
    const rebuild = createForegroundContextRebuilder({ roomId: "room", ownerId: "owner", agentId: "agent", receipts: new ForegroundContextReceipts() }, {
      readHistory: async () => { reads++; return []; },
    });
    expect(rebuild(transition())).rejects.toThrow("committed transcript boundary");
    expect(reads).toBe(0);
  });
});
