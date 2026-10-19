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
import { buildForegroundHistoryMessages } from "../../src/context/foreground-history";
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
  test("durable Human receipts decode into coordinates aligned to accepted messages", () => {
    const original = new HumanMessage({ id: "accepted-original", content: "Original request" });
    const progress = new AIMessage("Intermediate progress");
    const reply = new HumanMessage({ id: "accepted-reply", content: "Later accepted reply" });
    const receipts = new ForegroundContextReceipts();

    receipts.recordMessages([
      { id: "10", role: "user" },
      { id: "11", role: "assistant" },
      { id: "12", role: "user" },
    ], [original, progress, reply]);

    expect(receipts.triggerMessageId).toBe(10);
    expect(receipts.throughMessageIdInclusive).toBe(12);
    const rehydratedReply = new HumanMessage({
      id: "accepted-reply",
      content: "Later accepted reply",
    });
    expect(receipts.acceptedMessageCoordinates(
      [original, rehydratedReply],
      [
        { acceptedMessageIndex: -1, messageId: 9 },
        { acceptedMessageIndex: 8, messageId: 14 },
        { acceptedMessageIndex: 0, messageId: 10 },
      ],
    )).toEqual([
      { acceptedMessageIndex: 0, messageId: 10 },
      { acceptedMessageIndex: 1, messageId: 12 },
    ]);
    expect(receipts.acceptedMessageCoordinates([
      original,
      new HumanMessage({
        id: "different-reply",
        content: "Later accepted reply",
      }),
    ])).toEqual([
      { acceptedMessageIndex: 0, messageId: 10 },
    ]);
  });

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

  test("real rebuilder carries the latest durable receipt through more than fifty fitting updates", async () => {
    const updateCount = 64;
    const accepted = new HumanMessage({
      id: "accepted-many-refreshes",
      content: "Complete every numbered update",
    });
    const receipts = new ForegroundContextReceipts(10);
    const observedCuts: number[] = [];
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts,
    }, {
      readHistory: async (args) => {
        expect(args.currentMessageId).toBe(10);
        expect(args.maximumContextCharacters).toBe(2_000);
        const through = args.throughMessageIdInclusive;
        if (through === undefined) throw new Error("expected a durable read fence");
        observedCuts.push(through);
        return [new HumanMessage({
          content: `Latest completed update: ${through - 10}`,
          additional_kwargs: {
            nautilo_transient_context: true,
            nautilo_room_context_budgeted: true,
          },
        })];
      },
    });
    let state = {
      messages: [accepted],
      foregroundContextRefreshSource: {
        acceptedMessages: [accepted],
        triggerMessageId: 10,
        throughMessageIdInclusive: 10,
        executionId: "many-refreshes",
      },
    } as NautiloState;

    for (let expected = 1; expected <= updateCount; expected += 1) {
      const visibleLatest = state.messages.flatMap((message) =>
        typeof message.content === "string"
          ? [/^Latest completed update: (\d+)$/.exec(message.content)?.[1]]
          : []).find((value): value is string => value !== undefined);
      expect(visibleLatest === undefined ? 0 : Number(visibleLatest)).toBe(expected - 1);
      receipts.recordIds([10 + expected]);
      const result = await rebuild({
        state,
        request: {
          kind: "foreground_context_refresh",
          status: "ready",
          reason: "visible_assistant_text",
          modelId: "test-model",
          maximumContextCharacters: 2_000,
          projectionFingerprint: `fitting-${expected}`,
        },
      });
      expect(Array.isArray(result)).toBe(false);
      if (Array.isArray(result)) throw new Error("expected source-aware rebuild");
      expect(result.messages.map((message) => message.content)).toEqual([
        "Complete every numbered update",
        `Latest completed update: ${expected}`,
      ]);
      state = {
        ...state,
        messages: result.messages,
        foregroundContextRefreshSource: result.source,
      } as NautiloState;
    }

    expect(observedCuts).toEqual(
      Array.from({ length: updateCount }, (_, index) => 11 + index),
    );
  });

  test("repeated real narrative rebuilds retain the latest answer and receipt under foreign pressure", async () => {
    const accepted = new HumanMessage("Complete every numbered update");
    const receipts = new ForegroundContextReceipts(10);
    const rows: RoomHistoryHit[] = [];
    const rebuild = createForegroundContextRebuilder({
      roomId: "room", ownerId: "owner", agentId: "agent", receipts,
    }, {
      readHistory: async ({ modelId: _modelId, ...args }) => buildForegroundHistoryMessages(args, {
        readRoomTranscript: async () => rows.filter((row) =>
          row.messageId <= args.throughMessageIdInclusive!),
        readSubagentTranscript: async () => [],
        readRoomJournal: async () => ({
          rollup: null,
          events: [{
            id: "journal-continuity", roomId: "room", kind: "fact",
            statement: "JOURNAL_CONTINUITY", sequence: 1, status: "active",
          }],
        }),
      }),
    });
    let state = {
      messages: [accepted],
      foregroundContextRefreshSource: {
        acceptedMessages: [accepted], triggerMessageId: 10,
        throughMessageIdInclusive: 10, executionId: "repeated-run",
      },
    } as unknown as NautiloState;

    for (let update = 1; update <= 64; update += 1) {
      const firstId = 11 + (update - 1) * 3;
      for (const [offset, role, snippet, foreign] of [
        [0, "assistant", `ANSWER[${update}] already delivered`, false],
        [1, "tool", `RECEIPT[${update}] action succeeded`, false],
        [2, "assistant", `FOREIGN[${update}] ${"surrounding activity ".repeat(100)}`, true],
      ] as const) {
        rows.push({
          messageId: firstId + offset, role, snippet,
          ts: new Date((firstId + offset) * 1_000),
          authorDisplayName: foreign ? "Other" : "Agent",
          handle: foreign ? "other" : "agent",
          authorActorId: foreign ? "actor-other" : "actor-agent",
          authorAgentId: foreign ? "other" : "agent",
          foregroundExecutionId: foreign ? "foreign-run" : "repeated-run",
        });
      }
      receipts.recordIds([firstId + 2]);
      const result = await rebuild({
        state,
        request: {
          kind: "foreground_context_refresh", status: "ready",
          reason: "visible_assistant_text", modelId: "test-model",
          maximumContextCharacters: 1_000, projectionFingerprint: `refresh-${update}`,
        },
      });
      if (Array.isArray(result)) throw new Error("expected source-aware rebuild");
      const narrative = result.messages.filter((message) =>
        message.additional_kwargs["nautilo_room_context_budgeted"] === true)
        .map((message) => typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)).join("\n");
      expect(result.messages.filter((message) => message === accepted)).toHaveLength(1);
      expect(result.messages[0]).toBe(accepted);
      expect(narrative).toContain(`ANSWER[${update}] already delivered`);
      expect(narrative).toContain(`RECEIPT[${update}] action succeeded`);
      expect(narrative).toContain("JOURNAL_CONTINUITY");
      expect(narrative).not.toContain(`FOREIGN[${update}]`);
      expect(narrative.length).toBeLessThanOrEqual(1_000);
      state = { ...state, messages: result.messages, foregroundContextRefreshSource: result.source };
    }
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
    }, { readHistory: async () => [], readRoomContextPolicy: async () => undefined });

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
    }, { readHistory: async () => [], readRoomContextPolicy: async () => undefined });

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

  test("fork refresh keeps its causal Human anchor without promoting an earlier parent request", async () => {
    const parentRequest = new HumanMessage("Parent-room request outside this fork");
    const priorNarrative = new HumanMessage({
      content: "Narrated parent-room context",
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const forkMarker = new HumanMessage({
      content: "[FORK BACKGROUND] Continue only the forked objective.",
      additional_kwargs: { nautilo_transient_context: true },
    });
    const forkRequest = new HumanMessage("Inspect the forked subsystem");
    const question = new AIMessage("Should I include generated fixtures?");
    const reply = new HumanMessage("Yes, include those fixtures");
    const refreshedNarrative = new HumanMessage({
      content: "Earlier parent-room work, narrated chronologically",
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const completedNarrative = new HumanMessage({
      content: "Completed fork work through the latest durable receipt",
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const receipts = new ForegroundContextReceipts(undefined, false);
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts,
    }, {
      readHistory: async (args) => args.throughMessageIdInclusive === 14
        ? [refreshedNarrative]
        : [completedNarrative],
    });

    const result = await rebuild({
      state: {
        messages: [
          parentRequest,
          priorNarrative,
          forkMarker,
          forkRequest,
          question,
          reply,
        ],
        foregroundContextRefreshSource: {
          acceptedMessages: [forkMarker, forkRequest],
          triggerMessageId: 10,
          throughMessageIdInclusive: 14,
          executionId: "fork-turn",
        },
      } as NautiloState,
      request: {
        kind: "foreground_context_refresh",
        status: "ready",
        reason: "visible_assistant_text",
        modelId: "test-model",
        maximumContextCharacters: 1000,
        projectionFingerprint: "fork-causal-anchor",
      },
    });

    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error("expected source-aware rebuild");
    expect(result.messages.map((message) => message.content)).toEqual([
      "Earlier parent-room work, narrated chronologically",
      "[FORK BACKGROUND] Continue only the forked objective.",
      "Inspect the forked subsystem",
      "Should I include generated fixtures?",
      "Yes, include those fixtures",
    ]);
    expect(result.source.acceptedMessages.map((message) => message.content)).toEqual([
      "[FORK BACKGROUND] Continue only the forked objective.",
      "Inspect the forked subsystem",
      "Yes, include those fixtures",
    ]);
    expect(result.source.retainedMessages).toEqual([question]);

    receipts.recordIds([15]);
    const advanced = await rebuild({
      state: {
        messages: result.messages,
        foregroundContextRefreshSource: result.source,
      } as NautiloState,
      request: {
        kind: "foreground_context_refresh",
        status: "ready",
        reason: "visible_assistant_text",
        modelId: "test-model",
        maximumContextCharacters: 1000,
        projectionFingerprint: "fork-causal-anchor-advanced",
      },
    });
    expect(Array.isArray(advanced)).toBe(false);
    if (Array.isArray(advanced)) throw new Error("expected source-aware rebuild");
    expect(advanced.messages.map((message) => message.content)).toEqual([
      "[FORK BACKGROUND] Continue only the forked objective.",
      "Inspect the forked subsystem",
      "Yes, include those fixtures",
      "Completed fork work through the latest durable receipt",
    ]);
  });

  test("settled refresh represents a later accepted reply once at its durable chronological position", async () => {
    const original = new HumanMessage("Inspect the generated fixtures");
    const question = new AIMessage("Should I include archived fixtures?");
    const reply = new HumanMessage("Yes, include archived fixtures");
    const questionNarrative = new HumanMessage({
      content: "Assistant: Should I include archived fixtures?",
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const resultNarrative = new HumanMessage({
      content: "Assistant: Completed the archive inspection",
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const receipts = new ForegroundContextReceipts(10);
    receipts.recordIds([11, 12, 13]);
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: "agent",
      receipts,
    }, {
      readHistory: async (args) => {
        expect(args.throughMessageIdInclusive).toBe(13);
        expect(args.currentHumanText).toBe([
          "Inspect the generated fixtures",
          "Yes, include archived fixtures",
        ].join("\n"));
        expect(args.acceptedHumanMessages).toEqual([{
          messageId: 12,
          message: reply,
        }]);
        expect(args.excludeMessageIds).toEqual([10]);
        return [questionNarrative, reply, resultNarrative];
      },
    });

    const result = await rebuild({
      state: {
        messages: [original, question, reply],
        foregroundContextRefreshSource: {
          acceptedMessages: [original, reply],
          acceptedMessageIds: [10, 12],
          acceptedMessageCoordinates: [{
            acceptedMessageIndex: 1,
            messageId: 12,
          }],
          retainedMessages: [question],
          triggerMessageId: 10,
          throughMessageIdInclusive: 12,
          executionId: "reply-chronology",
        },
      } as unknown as NautiloState,
      request: {
        kind: "foreground_context_refresh",
        status: "ready",
        reason: "visible_assistant_text",
        modelId: "test-model",
        maximumContextCharacters: 2_000,
        projectionFingerprint: "reply-chronology-settled",
      },
    });

    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error("expected source-aware rebuild");
    const visible = result.messages.map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content)
    ).join("\n");
    expect(visible.match(/Yes, include archived fixtures/g)).toHaveLength(1);
    expect(visible.indexOf("Should I include archived fixtures?")).toBeLessThan(
      visible.indexOf("Yes, include archived fixtures"),
    );
    expect(visible.indexOf("Yes, include archived fixtures")).toBeLessThan(
      visible.indexOf("Completed the archive inspection"),
    );
    expect(result.messages[0]).toBe(original);
    expect(result.source.acceptedMessages).toEqual([original, reply]);
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

  test("exact idless causal input wins over an older equal-content Human", () => {
    const olderLookalike = new HumanMessage("yes");
    const olderReply = new HumanMessage("Reply belonging to the older request");
    const original = new HumanMessage("yes");
    const liveReply = new HumanMessage("Reply belonging to the live request");

    expect(acceptedForegroundMessages(
      [original],
      [olderLookalike, olderReply, original, liveReply],
    )).toEqual([original, liveReply]);
  });

  test("rehydrated structured causal input preserves the original blocks and an identical later reply", () => {
    const content = [
      { type: "text" as const, text: "Inspect this exact input" },
      { type: "text" as const, text: "and preserve every block" },
    ];
    const original = new HumanMessage({ id: "accepted-structured", content });
    const rehydratedAnchor = new HumanMessage({ content: structuredClone(content) });
    const identicalReply = new HumanMessage({ content: structuredClone(content) });
    const unrelatedBefore = new HumanMessage("Earlier Human outside the causal span");

    const accepted = acceptedForegroundMessages(
      [original],
      [unrelatedBefore, rehydratedAnchor, identicalReply],
    );

    expect(accepted).toHaveLength(2);
    expect(accepted[0]).toBe(original);
    expect(accepted[0]?.content).toEqual(content);
    expect(accepted[1]).toBe(identicalReply);
  });

  test("missing causal source fails closed instead of accepting unrelated checkpoint Humans", () => {
    const original = new HumanMessage("Accepted request no longer projected here");
    const unrelated = new HumanMessage("Unrelated checkpoint Human");
    expect(acceptedForegroundMessages([original], [unrelated])).toEqual([original]);
  });

  test("identical content with a different known id cannot impersonate the causal source", () => {
    const original = new HumanMessage({
      id: "fork-accepted-request",
      content: "Investigate the shared wording",
    });
    const oldParentRequest = new HumanMessage({
      id: "parent-request",
      content: "Investigate the shared wording",
    });
    const unrelatedParentFollowUp = new HumanMessage("Parent-room follow-up");
    const rehydratedForkAnchor = new HumanMessage({
      id: "fork-accepted-request",
      content: "Investigate the shared wording",
    });
    const legitimateForkReply = new HumanMessage("Use the fork-local fixtures");

    expect(acceptedForegroundMessages(
      [original],
      [
        oldParentRequest,
        unrelatedParentFollowUp,
        rehydratedForkAnchor,
        legitimateForkReply,
      ],
    )).toEqual([original, legitimateForkReply]);
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
