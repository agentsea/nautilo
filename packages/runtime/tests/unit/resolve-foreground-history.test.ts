import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ROOM_CONTEXT_MESSAGE_HEADER } from "@nautilo/agent";
import { FOREGROUND_RECORD_CONTEXT_HEADER } from "@nautilo/reflection/foreground";
import {
  resolveForegroundHistoryMessages,
  type BuildTranscriptContextDeps,
  type RoomHistoryHit,
  type TranscriptContextScope,
} from "@nautilo/runtime";
import { assertTranscriptCovers } from "./build-transcript-context.test";

/**
 * M168 Commit 2 / M171 (Phase H) — unit coverage for the executor's
 * history-resolution seam with an INJECTED fake `deps`. Proves the builder is
 * the history source on fresh room turns, R3 (one reader, three scopes), R5
 * (current-turn exclusion), the M171 no-`roomId`/`resume` → **`[]`** contract
 * (the checkpoint-history fallback was removed in Phase H), and the R9 coverage
 * harness for the three flows.
 */

type RoomScope = Extract<TranscriptContextScope, { kind: "room" }>;

function makeHit(handle: string, display: string, content: string, isoTs: string): RoomHistoryHit {
  return {
    messageId: Math.floor(Math.random() * 100000),
    ts: new Date(isoTs),
    authorDisplayName: display,
    handle,
    authorActorId: `actor-${handle}`,
    snippet: content,
  };
}

/** Fake deps that capture every room scope they receive + return canned hits. */
function capturingDeps(hits: RoomHistoryHit[]): {
  deps: BuildTranscriptContextDeps;
  scopes: RoomScope[];
} {
  const scopes: RoomScope[] = [];
  return {
    deps: {
      async readRoomTranscript(scope) {
        scopes.push(scope);
        return hits;
      },
      readSubagentTranscript(): Promise<never> {
        return Promise.reject(new Error("subagent reader must not be called in M168"));
      },
    },
    scopes,
  };
}

describe("resolveForegroundHistoryMessages (M168 seam / M171 no-checkpoint)", () => {
  test("DM fresh turn builds from the transcript", async () => {
    const { deps, scopes } = capturingDeps([
      makeHit("alice", "Alice", "hello", "2026-06-01T10:00:00Z"),
      makeHit("nova", "Nova", "hi there", "2026-06-01T10:00:01Z"),
    ]);

    const out = await resolveForegroundHistoryMessages(
      {
        turnKind: "fresh",
        roomId: "room-1",
        transcriptOwnerId: "owner-1",
        agentId: "agent-1",
      },
      deps,
    );

    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ kind: "room", roomId: "room-1", ownerId: "owner-1", agentId: "agent-1" });
    expect(scopes[0]!.excludeMessageId).toBeUndefined();
    expect(scopes[0]!.subthread).toBeUndefined();

    expect(out).toHaveLength(1);
    const content = out[0]!.content as string;
    expect(content.startsWith(ROOM_CONTEXT_MESSAGE_HEADER)).toBe(true);
    expect(content).toContain("hello");
    expect(content).toContain("hi there");
  });

  test("group fresh turn excludes the already-persisted triggering message (R5)", async () => {
    const { deps, scopes } = capturingDeps([
      makeHit("alice", "Alice", "peer A says hi", "2026-06-01T10:00:00Z"),
      makeHit("bob", "Bob", "bot B reply", "2026-06-01T10:00:01Z"),
    ]);

    await resolveForegroundHistoryMessages(
      {
        turnKind: "fresh",
        roomId: "room-2",
        transcriptOwnerId: "owner-1",
        agentId: "agent-2",
        currentMessageId: 4242,
      },
      deps,
    );

    expect(scopes[0]!.excludeMessageId).toBe(4242);
    expect(scopes[0]!.subthread).toBeUndefined();
  });

  test("subthread fresh turn passes parent-anchor windowing (R3)", async () => {
    const { deps, scopes } = capturingDeps([
      makeHit("alice", "Alice", "parent anchor line", "2026-06-01T10:00:00Z"),
      makeHit("nova", "Nova", "subthread reply", "2026-06-01T10:05:00Z"),
    ]);

    await resolveForegroundHistoryMessages(
      {
        turnKind: "fresh",
        roomId: "sub-room",
        transcriptOwnerId: "owner-1",
        agentId: "agent-3",
        subthreadParentRoomId: "parent-room",
        subthreadAnchorMessageId: 77,
      },
      deps,
    );

    expect(scopes[0]!.subthread).toEqual({ parentRoomId: "parent-room", anchorMessageId: 77 });
  });

  test("M171 — no roomId returns [] without touching the builder", async () => {
    const { deps, scopes } = capturingDeps([makeHit("x", "X", "should not appear", "2026-06-01T10:00:00Z")]);

    const out = await resolveForegroundHistoryMessages(
      {
        turnKind: "fresh",
        roomId: "",
        transcriptOwnerId: "owner-1",
        agentId: "agent-1",
      },
      deps,
    );

    expect(scopes).toHaveLength(0);
    expect(out).toHaveLength(0);
  });

  test("M171 — resume turnKind returns [] without rebuilding", async () => {
    const { deps, scopes } = capturingDeps([makeHit("x", "X", "nope", "2026-06-01T10:00:00Z")]);

    const out = await resolveForegroundHistoryMessages(
      {
        turnKind: "resume",
        roomId: "room-1",
        transcriptOwnerId: "owner-1",
        agentId: "agent-1",
      },
      deps,
    );

    expect(scopes).toHaveLength(0);
    expect(out).toHaveLength(0);
  });

  test("empty transcript on a fresh turn yields []", async () => {
    const { deps } = capturingDeps([]);
    const out = await resolveForegroundHistoryMessages(
      {
        turnKind: "fresh",
        roomId: "room-1",
        transcriptOwnerId: "owner-1",
        agentId: "agent-1",
      },
      deps,
    );
    expect(out).toHaveLength(0);
  });

  test("fresh Room selects initial Records once while resume never reselects", async () => {
    const { deps } = capturingDeps([
      makeHit("alice", "Alice", "Why Postgres?", "2026-06-01T10:00:00Z"),
    ]);
    let calls = 0;
    const recordContext = {
      representation: "ordinary" as const,
      select: async () => {
        calls += 1;
        return {
          status: "available" as const,
          representation: "ordinary" as const,
          queryEmbeddingStatus: "available" as const,
          candidateCount: 1,
          records: [{
            recordRef: "record:postgres",
            statement: "Postgres preserves transactional consistency.",
            lifecycle: "current" as const,
            structuralHeight: 1,
          }],
        };
      },
    };
    const fresh = await resolveForegroundHistoryMessages({
      turnKind: "fresh",
      roomId: "room-1",
      transcriptOwnerId: "owner-1",
      agentId: "agent-1",
      currentHumanText: "Why did we choose it?",
      recordContext,
    }, deps);
    expect(calls).toBe(1);
    expect(fresh[0]!.content).toContain(FOREGROUND_RECORD_CONTEXT_HEADER.trim());

    const resumed = await resolveForegroundHistoryMessages({
      turnKind: "resume",
      roomId: "room-1",
      transcriptOwnerId: "owner-1",
      agentId: "agent-1",
      currentHumanText: "approved",
      recordContext,
    }, deps);
    expect(resumed).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("R9 coverage gate — assertTranscriptCovers per flow", () => {
  async function buildBlock(
    args: Parameters<typeof resolveForegroundHistoryMessages>[0],
    hits: RoomHistoryHit[],
  ): Promise<string> {
    const { deps } = capturingDeps(hits);
    const out = await resolveForegroundHistoryMessages(args, deps);
    expect(out).toHaveLength(1);
    return out[0]!.content as string;
  }

  const checkpointMsgs: BaseMessage[] = [
    new HumanMessage("what is the weather"),
    new AIMessage("let me check the forecast"),
    new ToolMessage({ content: "sunny 25C", tool_call_id: "tc1", name: "get_weather" }),
  ];
  const hits = [
    makeHit("user", "User", "what is the weather", "2026-06-01T10:00:00Z"),
    makeHit("bot", "Bot", "let me check the forecast", "2026-06-01T10:00:01Z"),
    makeHit("bot", "Bot", "sunny 25C", "2026-06-01T10:00:02Z"),
  ];

  test("DM flow covers every checkpoint row", async () => {
    const block = await buildBlock(
      {
        turnKind: "fresh",
        roomId: "dm-room",
        transcriptOwnerId: "o1",
        agentId: "a1",
      },
      hits,
    );
    assertTranscriptCovers(checkpointMsgs, block);
  });

  test("group flow (with current-message exclusion) covers every checkpoint row", async () => {
    const block = await buildBlock(
      {
        turnKind: "fresh",
        roomId: "group-room",
        transcriptOwnerId: "o1",
        agentId: "a2",
        currentMessageId: 5,
      },
      hits,
    );
    assertTranscriptCovers(checkpointMsgs, block);
  });

  test("subthread flow covers every checkpoint row", async () => {
    const block = await buildBlock(
      {
        turnKind: "fresh",
        roomId: "sub-room",
        transcriptOwnerId: "o1",
        agentId: "a3",
        subthreadParentRoomId: "parent",
        subthreadAnchorMessageId: 9,
      },
      hits,
    );
    assertTranscriptCovers(checkpointMsgs, block);
  });
});
