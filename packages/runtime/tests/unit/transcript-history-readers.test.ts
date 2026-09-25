import { describe, expect, test } from "bun:test";
import type { SQL } from "@nautilo/db";
import {
  allRoomMessages,
  defaultBuildTranscriptContextDeps,
  recentBoundedRoomMessages,
  readSubagentRunTranscript,
  type TypedRoomHistorySearchDb,
} from "@nautilo/runtime";

/**
 * M168 Commit 1 — unit coverage for the transcript readers + production deps
 * factory, exercised with fake `TypedRoomHistorySearchDb` handles (no DB). SQL-level
 * filtering (deaf windows, `excludeMessageId`) is proven against real Postgres
 * in `transcript-context-flows.integration.test.ts`; here we cover the TS-side
 * mapping, ordering, concatenation, and Phase-F guard.
 */

type RawRow = Record<string, unknown>;

function userRow(id: number, content: string, isoTs: string, handle = "alice"): RawRow {
  return {
    message_id: id,
    ts: isoTs,
    role: "user",
    content,
    agent_handle: null,
    agent_display_name: null,
    agent_actor_id: null,
    user_handle: handle,
    user_name: handle === "alice" ? "Alice" : handle,
    user_actor_id: `actor-${handle}`,
  };
}

function agentRow(
  id: number,
  content: string,
  isoTs: string,
  role: "assistant" | "tool" = "assistant",
  handle = "nova",
): RawRow {
  return {
    message_id: id,
    ts: isoTs,
    role,
    content,
    agent_handle: handle,
    agent_display_name: "Nova",
    agent_actor_id: `actor-${handle}`,
    user_handle: null,
    user_name: null,
    user_actor_id: null,
  };
}

/** One canned result regardless of query. */
function selectFake(nextRows: () => readonly RawRow[]): TypedRoomHistorySearchDb["select"] {
  return (() => {
    const builder: object = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "then") {
            return (resolve: (value: readonly RawRow[]) => unknown) =>
              Promise.resolve(nextRows()).then(resolve);
          }
          return () => builder;
        },
      },
    );
    return builder;
  }) as TypedRoomHistorySearchDb["select"];
}

function fakeDb(rows: readonly RawRow[]): TypedRoomHistorySearchDb {
  return {
    async execute() {
      return rows;
    },
    select: selectFake(() => rows),
  };
}

/** Returns canned results in call order (one per `execute`). */
function scriptedDb(responses: ReadonlyArray<readonly RawRow[]>): {
  db: TypedRoomHistorySearchDb;
  calls: () => number;
} {
  let i = 0;
  const nextRows = () => responses[i++] ?? [];
  return {
    db: {
      async execute() {
        return nextRows();
      },
      select: selectFake(nextRows),
    },
    calls: () => i,
  };
}

function parameterValues(query: SQL): unknown[] {
  const values: unknown[] = [];
  const visit = (chunk: unknown): void => {
    if (!chunk || typeof chunk !== "object") return;
    const record = chunk as {
      constructor?: { name?: string };
      queryChunks?: unknown[];
      value?: unknown;
    };
    if (record.constructor?.name === "Param") {
      values.push(record.value);
      return;
    }
    record.queryChunks?.forEach((child) => {
      if (child === null || typeof child !== "object") {
        values.push(child);
        return;
      }
      visit(child);
    });
  };
  visit(query);
  return values;
}

describe("allRoomMessages (M168 R4)", () => {
  test("maps user/assistant/tool authors and returns oldest-first", async () => {
    // SQL returns newest-first; the reader reverses to oldest-first.
    const rows = [
      agentRow(3, "tool:get_weather sunny 25C", "2026-06-01T10:00:02Z", "tool"),
      agentRow(2, "let me check", "2026-06-01T10:00:01Z", "assistant"),
      userRow(1, "what is the weather", "2026-06-01T10:00:00Z"),
    ];
    const hits = await allRoomMessages(fakeDb(rows), { roomId: "r1" });
    expect(hits.map((h) => h.snippet)).toEqual([
      "what is the weather",
      "let me check",
      "tool:get_weather sunny 25C",
    ]);
    // Author attribution: human row → human, agent/tool rows → agent.
    expect(hits[0]!.handle).toBe("alice");
    expect(hits[1]!.handle).toBe("nova");
    expect(hits[2]!.handle).toBe("nova");
  });

  test("empty room → []", async () => {
    const hits = await allRoomMessages(fakeDb([]), { roomId: "r1" });
    expect(hits).toEqual([]);
  });

  test("preserves retained tool output beyond the legacy 280-character snippet cap", async () => {
    const fullToolOutput = `tool-result:${"x".repeat(500)}`;
    const hits = await allRoomMessages(
      fakeDb([
        agentRow(2, fullToolOutput, "2026-06-01T10:00:01Z", "tool"),
        userRow(1, "inspect it", "2026-06-01T10:00:00Z"),
      ]),
      { roomId: "r1" },
    );
    expect(hits[1]!.snippet).toBe(fullToolOutput);
    expect(hits[1]!.snippet.length).toBeGreaterThan(280);
  });

  test("no userId → no reaction enrichment (no extra DB work)", async () => {
    const hits = await allRoomMessages(fakeDb([userRow(1, "hi", "2026-06-01T10:00:00Z")]), {
      roomId: "r1",
    });
    expect(hits[0]!.reactions).toBeUndefined();
  });

  test("drops rows whose author cannot be resolved", async () => {
    const orphan: RawRow = {
      message_id: 9,
      ts: "2026-06-01T10:00:00Z",
      role: "user",
      content: "orphaned",
      agent_handle: null,
      agent_display_name: null,
      agent_actor_id: null,
      user_handle: null,
      user_name: null,
      user_actor_id: null,
    };
    const hits = await allRoomMessages(fakeDb([orphan]), { roomId: "r1" });
    expect(hits).toEqual([]);
  });
});

describe("recentBoundedRoomMessages (M219 full retained evidence)", () => {
  test("preserves full user, assistant, and tool content", async () => {
    const longUser = `user:${"u".repeat(400)}`;
    const longAssistant = `assistant:${"a".repeat(400)}`;
    const longTool = `tool:${"t".repeat(600)}`;
    const hits = await recentBoundedRoomMessages(
      fakeDb([
        userRow(1, longUser, "2026-06-01T10:00:00Z"),
        agentRow(2, longAssistant, "2026-06-01T10:00:01Z"),
        agentRow(3, longTool, "2026-06-01T10:00:02Z", "tool"),
      ]),
      { roomId: "r1" },
    );
    expect(hits.map((hit) => hit.snippet)).toEqual([
      longUser,
      longAssistant,
      longTool,
    ]);
  });

  test("passes the configured conversation limit into the bounded query", async () => {
    const queries: SQL[] = [];
    await recentBoundedRoomMessages(
      {
        async execute(query) {
          queries.push(query);
          return [];
        },
      },
      { roomId: "r1", conversationalLimit: 75 },
    );
    expect(queries).toHaveLength(1);
    expect(parameterValues(queries[0]!)).toContain(75);
    const queryText = JSON.stringify(queries[0]);
    expect(queryText).toContain("nautilo_browser_decision_observation");
    expect(queryText).toContain("browser-choice:%");
  });
});

describe("defaultBuildTranscriptContextDeps (M168 Commit 1, M219 bounded context)", () => {
  test("reads the latest rollup and active events after it", async () => {
    const { db, calls } = scriptedDb([
      [{ rebuildRequestedAt: null }],
      [{ throughEventSequence: 7, content: "Earlier journal" }],
      [
        {
          id: "event-8",
          roomId: "r1",
          sequence: 8,
          kind: "decision",
          statement: "Ship the typed reader.",
          status: "active",
          supersedesEventId: null,
          resolvesEventId: null,
        },
      ],
    ]);
    const deps = defaultBuildTranscriptContextDeps(db);

    const journal = await deps.readRoomJournal!({
      kind: "room",
      roomId: "r1",
      ownerId: "owner-1",
    });
    expect(journal).toEqual({
      rollup: { throughEventSequence: 7, content: "Earlier journal" },
      events: [
        {
          id: "event-8",
          roomId: "r1",
          sequence: 8,
          kind: "decision",
          statement: "Ship the typed reader.",
          status: "active",
          supersedesEventId: null,
          resolvesEventId: null,
        },
      ],
    });
    expect(calls()).toBe(3);
  });

  test("fails journal context closed while a rebuild is pending", async () => {
    const { db, calls } = scriptedDb([
      [{ rebuildRequestedAt: new Date("2026-08-17T10:00:00.000Z") }],
    ]);
    const deps = defaultBuildTranscriptContextDeps(db);

    const journal = await deps.readRoomJournal!({
      kind: "room",
      roomId: "r1",
      ownerId: "owner-1",
    });
    expect(journal).toEqual({ rollup: null, events: [] });
    expect(calls()).toBe(1);
  });

  test("room scope delegates to recentBoundedRoomMessages (oldest-first)", async () => {
    const rows = [
      userRow(1, "question", "2026-06-01T10:00:00Z"),
      agentRow(2, "reply", "2026-06-01T10:00:01Z"),
    ];
    const deps = defaultBuildTranscriptContextDeps(fakeDb(rows));
    const hits = await deps.readRoomTranscript({
      kind: "room",
      roomId: "r1",
      ownerId: "", // empty → skips reaction enrichment in this unit test
    });
    expect(hits.map((h) => h.snippet)).toEqual(["question", "reply"]);
    await deps.close(); // injected db ⇒ no-op, must not throw
  });

  test("loads the live server setting for each fresh Room transcript", async () => {
    const queries: SQL[] = [];
    let configuredLimit = 50;
    const deps = defaultBuildTranscriptContextDeps(
      {
        ...fakeDb([]),
        async execute(query) {
          queries.push(query);
          return [];
        },
      },
      { getRecentConversationLimit: async () => configuredLimit },
    );

    await deps.readRoomTranscript({ kind: "room", roomId: "r1", ownerId: "" });
    configuredLimit = 75;
    await deps.readRoomTranscript({ kind: "room", roomId: "r1", ownerId: "" });

    expect(queries).toHaveLength(2);
    expect(parameterValues(queries[0]!)).toContain(50);
    expect(parameterValues(queries[1]!)).toContain(75);
  });

  test("reads native Journal statements through the canonical ordinary Record projection", async () => {
    const { db, calls } = scriptedDb([
      [],
      [],
      [{
          id: "event-native",
          roomId: "room-1",
          sequence: 1,
          kind: "decision",
          statement: "The statement opened from the native Record payload.",
          status: "active",
          supersedesEventId: null,
          resolvesEventId: null,
      }],
    ]);
    const deps = defaultBuildTranscriptContextDeps(db);

    const journal = await deps.readRoomJournal?.({
      kind: "room",
      roomId: "room-1",
      ownerId: "",
    });

    expect(journal?.events.map((event) => event.statement)).toEqual([
      "The statement opened from the native Record payload.",
    ]);
    expect(calls()).toBe(3);
  });

  test("subthread scope concatenates parent-window ++ subthread-window oldest→newest", async () => {
    // 1: anchor lookup, 2: parent rows (newest-first), 3: child count,
    // 4: bounded child rows (ASC).
    const { db, calls } = scriptedDb([
      [{ ts: "2026-06-02T09:00:04Z", id: 105 }],
      [
        userRow(105, "PARENT 4", "2026-06-02T09:00:04Z"),
        userRow(104, "PARENT 3", "2026-06-02T09:00:03Z"),
        userRow(103, "PARENT 2", "2026-06-02T09:00:02Z"),
        userRow(102, "PARENT 1", "2026-06-02T09:00:01Z"),
        userRow(101, "PARENT 0", "2026-06-02T09:00:00Z"),
      ],
      [{ n: 2 }],
      [
        userRow(201, "SUB 0", "2026-06-02T09:10:00Z"),
        userRow(202, "SUB 1", "2026-06-02T09:10:01Z"),
      ],
    ]);
    const deps = defaultBuildTranscriptContextDeps(db);
    const hits = await deps.readRoomTranscript({
      kind: "room",
      roomId: "sub-room",
      ownerId: "",
      subthread: { parentRoomId: "parent-room", anchorMessageId: 105 },
    });
    expect(hits.map((h) => h.snippet)).toEqual([
      "PARENT 0",
      "PARENT 1",
      "PARENT 2",
      "PARENT 3",
      "PARENT 4",
      "SUB 0",
      "SUB 1",
    ]);
    expect(calls()).toBe(4);
  });

  test("subthread scope with a missing anchor yields only the subthread window", async () => {
    const { db } = scriptedDb([
      [], // anchor lookup misses → parent window empty (no parent main query)
      [{ n: 1 }],
      [userRow(201, "SUB ONLY", "2026-06-02T09:10:00Z")],
    ]);
    const deps = defaultBuildTranscriptContextDeps(db);
    const hits = await deps.readRoomTranscript({
      kind: "room",
      roomId: "sub-room",
      ownerId: "",
      subthread: { parentRoomId: "parent-room", anchorMessageId: 999999 },
    });
    expect(hits.map((h) => h.snippet)).toEqual(["SUB ONLY"]);
  });

  test("readSubagentTranscript is wired to readSubagentRunTranscript (M169 Phase F)", () => {
    // M169 replaced M168's Phase-F throw-stub: the slot now delegates to the
    // dormant `readSubagentRunTranscript` reader (still called by NO production
    // `buildTranscriptContext({kind:"subagent"})` path — R2). The reader uses
    // its own `@nautilo/agent` queries (not the factory's `RoomHistorySearchDb`
    // handle), so its DB-free mapping coverage lives in
    // `read-subagent-run-transcript.test.ts` (injected deps), not here.
    const deps = defaultBuildTranscriptContextDeps(fakeDb([]));
    expect(typeof deps.readSubagentTranscript).toBe("function");
    expect(typeof readSubagentRunTranscript).toBe("function");
  });
});
