import { describe, test, expect } from "bun:test";
import { HumanMessage, AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  ROOM_CONTEXT_MESSAGE_HEADER,
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "@nautilo/agent";
import { ModelCatalogSchema } from "@nautilo/types";
import {
  StrictShadowEnforcementError,
} from "@nautilo/lattice-bridge";
import {
  FOREGROUND_RECORD_CONTEXT_HEADER,
  type ForegroundRecordSelectionResult,
} from "@nautilo/reflection/foreground";
import {
  ROOM_JOURNAL_CONTEXT_HEADER,
  buildBudgetedRoomContext,
  buildProtectedRoomHybridContext,
  buildTranscriptContext,
  selectForegroundRecordsWithDeadline,
  runAgentTranscriptToHits,
  type RoomHistoryHit,
  type BuildTranscriptContextDeps,
  type ForegroundContextClock,
} from "@nautilo/runtime";

function makeHit(
  handle: string,
  display: string,
  content: string,
  isoTs: string,
  role?: RoomHistoryHit["role"],
): RoomHistoryHit {
  return {
    messageId: Math.floor(Math.random() * 100000),
    ts: new Date(isoTs),
    authorDisplayName: display,
    handle,
    authorActorId: `actor-${handle}`,
    snippet: content,
    ...(role ? { role } : {}),
  };
}

function depsFrom(room: RoomHistoryHit[], sub: RoomHistoryHit[] = []): BuildTranscriptContextDeps {
  return {
    readRoomTranscript: async () => room,
    readSubagentTranscript: async () => sub,
  };
}

/**
 * R5 no-loss harness. Asserts the rendered transcript block CONTAINS the text
 * content of every user/assistant/tool message in the checkpoint history.
 * Representation differs by design (structured messages → narration), so this
 * is content-coverage, NOT structural equality. Reused by later cutovers.
 */
export function assertTranscriptCovers(
  checkpointMsgs: BaseMessage[],
  builtBlock: string,
): void {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const haystack = normalize(builtBlock);
  for (const m of checkpointMsgs) {
    const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const needle = normalize(raw);
    if (needle.length === 0) continue;
    expect(haystack).toContain(needle);
  }
}

describe("buildTranscriptContext (M166 Phase A)", () => {
  test("empty transcript returns []", async () => {
    const result = await buildTranscriptContext(
      { scope: { kind: "room", roomId: "r1", ownerId: "o1" } },
      depsFrom([]),
    );
    expect(result).toHaveLength(0);
  });

  test("room scope with 3 mixed rows renders one HumanMessage", async () => {
    const hits = [
      makeHit("alice", "Alice", "hello there", "2026-06-01T10:00:00Z"),
      makeHit("nova", "Nova", "I can help", "2026-06-01T10:00:01Z"),
      makeHit("nova", "Nova", "tool:search_memory found items", "2026-06-01T10:00:02Z"),
    ];
    const result = await buildTranscriptContext(
      { scope: { kind: "room", roomId: "r1", ownerId: "o1" } },
      depsFrom(hits),
    );
    expect(result).toHaveLength(1);
    expect(HumanMessage.isInstance(result[0])).toBe(true);
    expect(result[0]!.additional_kwargs["nautilo_transient_context"]).toBe(true);
    expect(result[0]!.additional_kwargs["nautilo_room_context_budgeted"]).toBe(true);
    const content = result[0]!.content as string;
    expect(content.startsWith(ROOM_CONTEXT_MESSAGE_HEADER)).toBe(true);
    expect(content).toContain("hello there");
    expect(content).toContain("I can help");
    expect(content).toContain("tool:search_memory found items");
    expect(content).toMatch(/\(@alice\):/);
    expect(content).toMatch(/\(@nova\):/);
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\]/);
    expect(content).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  test("M219 journal precedes recent transcript in one transient HumanMessage", async () => {
    const deps = depsFrom([
      makeHit("alice", "Alice", "recent discussion", "2026-06-01T10:00:00Z"),
    ]);
    deps.readRoomJournal = async () => ({
      rollup: { throughEventSequence: 10, content: "Earlier durable context." },
      events: [
        {
          id: "internal-event-id",
          roomId: "internal-room-id",
          sequence: 11,
          kind: "decision",
          statement: "Ship on Tuesday.",
          status: "active",
        },
      ],
    });
    const result = await buildTranscriptContext(
      { scope: { kind: "room", roomId: "r1", ownerId: "o1" } },
      deps,
    );
    const content = result[0]!.content as string;
    expect(content.indexOf(ROOM_JOURNAL_CONTEXT_HEADER)).toBe(0);
    expect(content.indexOf(ROOM_CONTEXT_MESSAGE_HEADER)).toBeGreaterThan(
      content.indexOf("Ship on Tuesday."),
    );
    expect(content).toContain("recent discussion");
    expect(content).not.toContain("internal-event-id");
    expect(content).not.toContain("internal-room-id");
    expect(result[0]!.additional_kwargs["nautilo_transient_context"]).toBe(true);
    expect(result[0]!.additional_kwargs["nautilo_room_context_budgeted"]).toBe(true);
  });

  test("M219 journal-only context remains one transient HumanMessage", async () => {
    const deps = depsFrom([]);
    deps.readRoomJournal = async () => ({
      rollup: null,
      events: [
        {
          id: "event-1",
          roomId: "r1",
          sequence: 1,
          kind: "risk",
          statement: "The launch date is at risk.",
          status: "active",
        },
      ],
    });
    const result = await buildTranscriptContext(
      { scope: { kind: "room", roomId: "r1", ownerId: "o1" } },
      deps,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toContain("The launch date is at risk.");
    expect(result[0]!.content).not.toContain(ROOM_CONTEXT_MESSAGE_HEADER);
  });

  test("M219 preserves the newest configured complete turn before older turns", () => {
    const hits = [
      makeHit("alice", "Alice", `old question ${"o".repeat(700)}`, "2026-06-01T10:00:00Z", "user"),
      makeHit("nova", "Nova", "old answer", "2026-06-01T10:00:01Z", "assistant"),
      makeHit("alice", "Alice", "new question", "2026-06-01T10:01:00Z", "user"),
      makeHit("nova", "Nova", "new answer", "2026-06-01T10:01:01Z", "assistant"),
    ];
    const content = buildBudgetedRoomContext({
      journal: { rollup: null, events: [] },
      hits,
      modelContextTokens: 500,
      minimumFullTurns: 1,
      maxRoomContextPercent: 30,
    });
    expect(content).not.toBeNull();
    expect(content!.length).toBeLessThanOrEqual(600);
    expect(content).toContain("new question");
    expect(content).toContain("new answer");
    expect(content).not.toContain("old question");
    expect(content).not.toContain("old answer");
  });

  test("M219 trims journal before sacrificing a minimum complete turn", () => {
    const content = buildBudgetedRoomContext({
      journal: {
        rollup: {
          throughEventSequence: 1,
          content: `historical rollup ${"j".repeat(1_000)}`,
        },
        events: [],
      },
      hits: [
        makeHit("alice", "Alice", "latest question", "2026-06-01T10:01:00Z", "user"),
        makeHit("nova", "Nova", "latest answer", "2026-06-01T10:01:01Z", "assistant"),
      ],
      modelContextTokens: 500,
      minimumFullTurns: 1,
      maxRoomContextPercent: 30,
    });
    expect(content!.length).toBeLessThanOrEqual(600);
    expect(content).toContain("latest question");
    expect(content).toContain("latest answer");
    expect(content).toContain("context omitted");
  });

  test("M293 budgets Room transcript context from the active signed model entry", async () => {
    const modelId = "openrouter:openai/gpt-5.6-sol";
    const catalog = ModelCatalogSchema.parse({
      version: 1,
      catalogVersion: "2026.08.23.6",
      publishedAt: "2026-08-23T00:00:00.000Z",
      entries: [{
        id: modelId,
        displayName: modelId,
        provider: "openrouter",
        routing: "openrouter",
        priority: 1,
        defaultEnabled: true,
        modalities: { input: ["text"], output: ["text"] },
        features: { tools: true, structuredOutputs: true, reasoning: true },
        limits: { contextTokens: 500, outputTokens: 100 },
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
          fetchedAt: "2026-08-23T00:00:00.000Z",
          originUrl: "https://catalog.invalid/m293-transcript.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();

    try {
      const result = await buildTranscriptContext({
        scope: { kind: "room", roomId: "r1", ownerId: "o1" },
        modelId,
      }, depsFrom([
        makeHit("alice", "Alice", `old question ${"o".repeat(2_000)}`, "2026-06-01T10:00:00Z", "user"),
        makeHit("nova", "Nova", "old answer", "2026-06-01T10:00:01Z", "assistant"),
        makeHit("alice", "Alice", "new question", "2026-06-01T10:01:00Z", "user"),
        makeHit("nova", "Nova", "new answer", "2026-06-01T10:01:01Z", "assistant"),
      ]));
      const content = result[0]!.content as string;
      expect(content).toContain("new question");
      expect(content).toContain("new answer");
      expect(content.length).toBeLessThanOrEqual(1_000);
      expect(content).not.toContain("old question");
    } finally {
      resetRuntimeModelCatalog();
    }
  });

  test("M219 hard Room percentage wins when one complete turn is oversized", () => {
    const content = buildBudgetedRoomContext({
      journal: { rollup: null, events: [] },
      hits: [
        makeHit("alice", "Alice", `huge question ${"q".repeat(2_000)}`, "2026-06-01T10:01:00Z", "user"),
        makeHit("nova", "Nova", `huge answer ${"a".repeat(2_000)}`, "2026-06-01T10:01:01Z", "assistant"),
      ],
      modelContextTokens: 250,
      minimumFullTurns: 1,
      maxRoomContextPercent: 30,
    });
    expect(content!.length).toBeLessThanOrEqual(300);
    expect(content).toContain("context omitted");
  });

  test("M219 zero minimum lets journal context win the Room budget", () => {
    const content = buildBudgetedRoomContext({
      journal: {
        rollup: {
          throughEventSequence: 1,
          content: `durable journal ${"j".repeat(1_000)}`,
        },
        events: [],
      },
      hits: [
        makeHit("alice", "Alice", "optional recent question", "2026-06-01T10:01:00Z", "user"),
        makeHit("nova", "Nova", "optional recent answer", "2026-06-01T10:01:01Z", "assistant"),
      ],
      modelContextTokens: 500,
      minimumFullTurns: 0,
      maxRoomContextPercent: 30,
    });
    expect(content!.length).toBeLessThanOrEqual(600);
    expect(content).toContain("durable journal");
    expect(content).not.toContain("optional recent question");
    expect(content).not.toContain("optional recent answer");
  });

  test("M219 preserves a configured two-turn suffix before journal text", () => {
    const content = buildBudgetedRoomContext({
      journal: {
        rollup: {
          throughEventSequence: 1,
          content: `older journal ${"j".repeat(1_000)}`,
        },
        events: [],
      },
      hits: [
        makeHit("alice", "Alice", "first protected question", "2026-06-01T10:00:00Z", "user"),
        makeHit("nova", "Nova", "first protected answer", "2026-06-01T10:00:01Z", "assistant"),
        makeHit("alice", "Alice", "second protected question", "2026-06-01T10:01:00Z", "user"),
        makeHit("nova", "Nova", "second protected answer", "2026-06-01T10:01:01Z", "assistant"),
      ],
      modelContextTokens: 500,
      minimumFullTurns: 2,
      maxRoomContextPercent: 30,
    });
    expect(content!.length).toBeLessThanOrEqual(600);
    expect(content).toContain("first protected question");
    expect(content).toContain("first protected answer");
    expect(content).toContain("second protected question");
    expect(content).toContain("second protected answer");
    expect(content).toContain("context omitted");
  });

  test("subagent scope maps run transcript via runAgentTranscriptToHits", async () => {
    const hits = runAgentTranscriptToHits(
      [
        {
          role: "assistant",
          content: "I will search now",
          toolName: null,
          toolCalls: null,
          createdAt: new Date("2026-06-01T10:00:00Z"),
        },
        {
          role: "tool",
          content: "search results here",
          toolName: "search_memory",
          toolCalls: null,
          createdAt: new Date("2026-06-01T10:00:01Z"),
        },
      ],
      { displayName: "Genie", handle: "genie" },
    );
    const result = await buildTranscriptContext(
      {
        scope: {
          kind: "subagent",
          graphThreadId: "subagent:t1",
          ownerId: "o1",
          agentId: "a1",
          startedAt: null,
          completedAt: null,
        },
      },
      depsFrom([], hits),
    );
    expect(result).toHaveLength(1);
    const content = result[0]!.content as string;
    expect(content).toContain("I will search now");
    expect(content).toContain("tool:search_memory");
    expect(content).toContain("search results here");
    expect(content).toContain("(@genie):");
    expect(result[0]!.additional_kwargs["nautilo_room_context_budgeted"]).toBeUndefined();
  });

  test("maxLines finite elides oldest rows", async () => {
    const hits = [
      makeHit("a", "A", "oldest row", "2026-06-01T10:00:00Z"),
      makeHit("a", "A", "middle row", "2026-06-01T10:00:01Z"),
      makeHit("a", "A", "newest row", "2026-06-01T10:00:02Z"),
    ];
    const result = await buildTranscriptContext(
      { scope: { kind: "room", roomId: "r1", ownerId: "o1" }, maxLines: 2 },
      depsFrom(hits),
    );
    expect(result).toHaveLength(1);
    const content = result[0]!.content as string;
    expect(content).toContain("… earlier messages elided …");
    expect(content).toContain("middle row");
    expect(content).toContain("newest row");
    expect(content).not.toContain("oldest row");
  });

  test("R5 coverage harness: assertTranscriptCovers passes for equivalent hits", async () => {
    const checkpointMsgs: BaseMessage[] = [
      new HumanMessage("what is the weather"),
      new AIMessage("let me check"),
      new ToolMessage({ content: "sunny 25C", tool_call_id: "tc1", name: "get_weather" }),
    ];
    const hits = [
      makeHit("user", "User", "what is the weather", "2026-06-01T10:00:00Z"),
      makeHit("bot", "Bot", "let me check", "2026-06-01T10:00:01Z"),
      makeHit("bot", "Bot", "sunny 25C", "2026-06-01T10:00:02Z"),
    ];
    const result = await buildTranscriptContext(
      { scope: { kind: "room", roomId: "r1", ownerId: "o1" } },
      depsFrom(hits),
    );
    expect(result).toHaveLength(1);
    const content = (result[0] as HumanMessage).content as string;
    assertTranscriptCovers(checkpointMsgs, content);
  });
});

class ManualForegroundClock implements ForegroundContextClock {
  nowValue = 0;
  callback: (() => void) | undefined;
  cleared = false;

  now(): number {
    return this.nowValue;
  }

  setTimer(callback: () => void): unknown {
    this.callback = callback;
    return "timer";
  }

  clearTimer(): void {
    this.cleared = true;
  }

  expire(at: number): void {
    this.nowValue = at;
    this.callback?.();
  }
}

describe("M277 foreground hybrid context", () => {
  test("builds one query from current text plus the newest prior Human request", async () => {
    const hits = [
      makeHit("alice", "Alice", "Should we use Postgres?", "2026-06-01T10:00:00Z", "user"),
      makeHit("nova", "Nova", "It handles concurrent writers.", "2026-06-01T10:00:01Z", "assistant"),
    ];
    const requests: unknown[] = [];
    const diagnostics: unknown[] = [];
    const deps = depsFrom(hits);
    deps.readRoomJournal = async () => ({
      rollup: { throughEventSequence: 1, content: "The database decision is open." },
      events: [],
    });
    deps.emitForegroundContextDiagnostic = (diagnostic) => diagnostics.push(diagnostic);
    const result = await buildTranscriptContext({
      scope: { kind: "room", roomId: "room-1", ownerId: "owner-1" },
      currentHumanText: "Why did we choose that?",
      recordContext: {
        representation: "ordinary",
        async select(request) {
          requests.push({ ...request, signal: request.signal?.aborted });
          return {
            status: "available",
            representation: "ordinary",
            queryEmbeddingStatus: "available",
            candidateCount: 1,
            records: [{
              recordRef: "record:postgres",
              statement: "Postgres was selected for transactional consistency.",
              lifecycle: "current",
              structuralHeight: 2,
            }],
          };
        },
      },
    }, deps);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      query:
        "Why did we choose that?\n\n[Immediately preceding Human request]\n"
        + "user: Should we use Postgres?",
      limit: 5,
      signal: false,
    });
    const content = result[0]!.content as string;
    expect(content).toContain(ROOM_JOURNAL_CONTEXT_HEADER.trim());
    expect(content).toContain(FOREGROUND_RECORD_CONTEXT_HEADER.trim());
    expect(content).toContain("lifecycle=current; height=2; ref=record:postgres");
    expect(content).toContain(ROOM_CONTEXT_MESSAGE_HEADER.trim());
    expect(content).not.toContain("Why did we choose that?");
    expect(result).toHaveLength(1);
    expect(result[0]!.additional_kwargs["nautilo_room_context_budgeted"]).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      representation: "ordinary",
      selectionDurationBucket: "lt_50ms",
      queryEmbeddingAvailableCount: 1,
      queryEmbeddingUnavailableCount: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Postgres");
    expect(JSON.stringify(diagnostics)).not.toContain("room-1");
  });

  test("empty Human text performs no Record search", async () => {
    let calls = 0;
    await buildTranscriptContext({
      scope: { kind: "room", roomId: "room-1", ownerId: "owner-1" },
      currentHumanText: " \n ",
      recordContext: {
        representation: "ordinary",
        select: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      },
    }, depsFrom([
      makeHit("alice", "Alice", "prior", "2026-06-01T10:00:00Z", "user"),
    ]));
    expect(calls).toBe(0);
  });

  test("passive recall off skips Record search and preserves baseline context", async () => {
    let calls = 0;
    const diagnostics: unknown[] = [];
    const deps = depsFrom([
      makeHit("alice", "Alice", "prior", "2026-06-01T10:00:00Z", "user"),
    ]);
    deps.readRoomContextPolicy = async () => ({
      recentConversationLimit: 50,
      minimumFullTurns: 1,
      maxRoomContextPercent: 50,
        stenographerPriorConversationLimit: 10,
        passiveRecallEnabled: false,
        reflectionSleepEnabled: false,
          memoryReviewEnabled: null,
    });
    deps.emitForegroundContextDiagnostic = (diagnostic) => diagnostics.push(diagnostic);
    const result = await buildTranscriptContext({
      scope: { kind: "room", roomId: "room-1", ownerId: "owner-1" },
      currentHumanText: "What do you remember?",
      recordContext: {
        representation: "ordinary",
        select: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      },
    }, deps);
    expect(calls).toBe(0);
    expect(result[0]!.content).toContain("prior");
    expect(result[0]!.content).not.toContain(FOREGROUND_RECORD_CONTEXT_HEADER.trim());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      representation: "none",
      queryEmbeddingAvailableCount: 0,
      queryEmbeddingUnavailableCount: 0,
      facts: { selectionStatus: "disabled" },
    });
  });

  test("unavailable selection is byte-identical to the Journal-plus-recent baseline", async () => {
    const hits = [
      makeHit("alice", "Alice", "prior question", "2026-06-01T10:00:00Z", "user"),
      makeHit("nova", "Nova", "prior answer", "2026-06-01T10:00:01Z", "assistant"),
    ];
    const makeDeps = () => {
      const deps = depsFrom(hits);
      deps.readRoomJournal = async () => ({
        rollup: null,
        events: [{
          id: "event-1",
          roomId: "room-1",
          sequence: 1,
          kind: "decision",
          statement: "Keep the baseline exact.",
          status: "active",
        }],
      });
      return deps;
    };
    const baseline = await buildTranscriptContext({
      scope: { kind: "room", roomId: "room-1", ownerId: "owner-1" },
    }, makeDeps());
    const degraded = await buildTranscriptContext({
      scope: { kind: "room", roomId: "room-1", ownerId: "owner-1" },
      currentHumanText: "follow up",
      recordContext: {
        representation: "ordinary",
        select: async () => ({
          status: "unavailable",
          representation: "ordinary",
          queryEmbeddingStatus: "available",
          reason: "exact_scan_timeout",
        }),
      },
    }, makeDeps());
    expect(degraded[0]!.content).toBe(baseline[0]!.content);
    expect(degraded[0]!.additional_kwargs).toEqual(baseline[0]!.additional_kwargs);
  });

  test("result before the fake-clock deadline wins", async () => {
    const clock = new ManualForegroundClock();
    let complete!: (value: ForegroundRecordSelectionResult) => void;
    const selection = selectForegroundRecordsWithDeadline({
      port: {
        representation: "ordinary",
        select: () => new Promise((resolve) => { complete = resolve; }),
      },
      query: "decision",
      clock,
      deadlineMilliseconds: 100,
    });
    clock.nowValue = 40;
    complete({
      status: "available",
      representation: "ordinary",
      queryEmbeddingStatus: "available",
      candidateCount: 0,
      records: [],
    });
    expect(await selection).toEqual({
      selection: {
        status: "available",
        representation: "ordinary",
        queryEmbeddingStatus: "available",
        candidateCount: 0,
        records: [],
      },
      durationMilliseconds: 40,
    });
    expect(clock.cleared).toBe(true);
  });

  test("fake-clock deadline aborts optional work without waiting for it", async () => {
    const clock = new ManualForegroundClock();
    let observedSignal: AbortSignal | undefined;
    const never = new Promise<never>(() => {});
    const selection = selectForegroundRecordsWithDeadline({
      port: {
        representation: "ordinary",
        select: (request) => {
          observedSignal = request.signal;
          return never;
        },
      },
      query: "decision",
      clock,
      deadlineMilliseconds: 100,
    });
    clock.expire(100);
    expect(await selection).toEqual({
      selection: {
        status: "unavailable",
        representation: "ordinary",
        queryEmbeddingStatus: "unavailable",
        reason: "deadline_expired",
      },
      durationMilliseconds: 100,
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  test("protected Record work cannot be skipped by the optional soft deadline", async () => {
    const clock = new ManualForegroundClock();
    let observedSignal: AbortSignal | undefined;
    let rejectSelection!: (reason: unknown) => void;
    const enforcement = new StrictShadowEnforcementError({
      boundaryId: "conversation.read.foreground_records",
      family: "record",
      operation: "read_repair",
      actorClass: "agent",
      state: "waiting_for_authority",
      reason: "domain_authority_converging",
      retryable: true,
      policyRevision: 7,
    });
    const selection = selectForegroundRecordsWithDeadline({
      port: {
        representation: "protected",
        select: (request) => {
          observedSignal = request.signal;
          return new Promise((_resolve, reject) => {
            rejectSelection = reject;
          });
        },
      },
      query: "decision",
      clock,
      deadlineMilliseconds: 100,
    });
    clock.expire(100);
    expect(observedSignal?.aborted).toBe(true);
    rejectSelection(enforcement);
    expect(selection).rejects.toBe(enforcement);
  });

  test("Strict Shadow enforcement escapes the optional Record selector", async () => {
    const enforcement = new StrictShadowEnforcementError(
      {
        boundaryId: "conversation.read.foreground_records",
        family: "record",
        operation: "read_repair",
        actorClass: "agent",
        state: "failed",
        reason: "integrity_failure",
        retryable: false,
        policyRevision: 7,
      },
    );
    expect(selectForegroundRecordsWithDeadline({
      port: {
        representation: "protected",
        select: async () => {
          throw enforcement;
        },
      },
      query: "decision",
    })).rejects.toBe(enforcement);
  });

  test("ordinary Record selector failures remain optional", async () => {
    const result = await selectForegroundRecordsWithDeadline({
      port: {
        representation: "ordinary",
        select: async () => {
          throw new Error("temporary selector failure");
        },
      },
      query: "decision",
    });
    expect(result.selection).toEqual({
      status: "unavailable",
      representation: "ordinary",
      queryEmbeddingStatus: "unavailable",
      reason: "internal_error",
    });
  });

  test("protected hybrid uses only supplied authorized Journal, transcript, and Records", async () => {
    let calls = 0;
    const result = await buildProtectedRoomHybridContext({
      hits: [
        makeHit("alice", "Alice", "protected prior", "2026-06-01T10:00:00Z", "user"),
      ],
      journal: {
        rollup: null,
        events: [{
          id: "protected-event",
          roomId: "protected-room",
          sequence: 1,
          kind: "decision",
          statement: "Protected Journal statement.",
          status: "active",
        }],
      },
      currentHumanText: "why?",
      recordContext: {
        representation: "protected",
        async select() {
          calls += 1;
          return {
            status: "available",
            representation: "protected",
            queryEmbeddingStatus: "available",
            candidateCount: 1,
            records: [{
              recordRef: "record:protected",
              statement: "Protected Record statement.",
              lifecycle: "current",
              structuralHeight: 1,
            }],
          };
        },
      },
    });
    expect(calls).toBe(1);
    const content = result[0]!.content as string;
    expect(content).toContain("Protected Journal statement.");
    expect(content).toContain("Protected Record statement.");
    expect(content).toContain("protected prior");
  });
});
