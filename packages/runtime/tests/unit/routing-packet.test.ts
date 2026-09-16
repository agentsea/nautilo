import { describe, test, expect } from "bun:test";
import {
  loadRoutingPacket,
  formatRoutingPacketLines,
  type RoomHistorySearchDb,
  type TypedRoomHistorySearchDb,
} from "@nautilo/runtime";
import {
  CONTINUATION_FIXTURES,
  SENTINEL_VALUES,
} from "./continuation-fixtures";
import type { DirectDatabase } from "@nautilo/db";

type RoutingPacketDb = TypedRoomHistorySearchDb &
  Pick<DirectDatabase, "selectDistinctOn">;

const ROOM_ID = "room-abc-123";
const USER_ACTOR_ID = "actor-user-999";
const NOW = new Date("2026-06-12T12:00:00.000Z");

/**
 * Extract the raw SQL text fragments from a drizzle `sql` template so the fake
 * DB can dispatch by query content (a stable, self-explaining signal) instead
 * of fragile call-order magic. Interpolated parameter values are dropped — only
 * the static SQL text is inspected.
 */
function sqlText(query: Parameters<RoomHistorySearchDb["execute"]>[0]): string {
  const chunks =
    (query as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      parts.push(chunk);
      continue;
    }
    if (chunk && typeof chunk === "object" && "value" in chunk) {
      const v = (chunk as { value: unknown }).value;
      if (Array.isArray(v)) {
        for (const s of v) if (typeof s === "string") parts.push(s);
      } else if (typeof v === "string") {
        parts.push(v);
      }
    }
  }
  return parts.join("");
}

/**
 * Fake DB that dispatches by query content rather than call order. Each loader
 * query carries a distinctive static token (a table alias, column name, or an
 * explicit `routing-packet:recent-counterparts` SQL comment sentinel), so
 * adding a new query never silently shifts another query's handler.
 */
function fakeDb(handlers: {
  presence?: Record<string, unknown>[];
  replyTargets?: Record<string, unknown>[];
  tempo?: Record<string, unknown>[];
  recentCounterparts?: Record<string, unknown>[];
}): RoutingPacketDb {
  const selectedRows = [
    handlers.presence ?? [],
    handlers.replyTargets ?? [],
    handlers.tempo ?? [{ msgs_last_window: 0, latest_ts: null }],
  ];
  let selectIndex = 0;
  const selectedQuery = () => {
    const rows = selectedRows[selectIndex++] ?? [];
    const builder: object = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "then") {
            return (resolve: (value: Record<string, unknown>[]) => unknown) =>
              Promise.resolve(rows).then(resolve);
          }
          return () => builder;
        },
      },
    );
    return builder;
  };
  return {
    select: selectedQuery as TypedRoomHistorySearchDb["select"],
    selectDistinctOn: selectedQuery as RoutingPacketDb["selectDistinctOn"],
    execute: async (query) => {
      const text = sqlText(query);
      if (text.includes("routing-packet:recent-counterparts")) {
        return handlers.recentCounterparts ?? [];
      }
      return [];
    },
  };
}

describe("loadRoutingPacket (D302 P6b)", () => {
  test("maps presence, reply graph, and tempo from SQL rows", async () => {
    const packet = await loadRoutingPacket(
      fakeDb({
        presence: [
          {
            recipient_id: "user-uuid-1",
            read_at: "2026-06-12T11:55:00.000Z",
            delivered_at: "2026-06-12T11:54:00.000Z",
            message_ts: "2026-06-12T11:54:00.000Z",
            user_handle: "casey",
            user_name: "Casey",
          },
        ],
        replyTargets: [
          {
            user_handle: "alex",
            user_name: "Alex",
            agent_handle: "nova",
            agent_display_name: "Nova",
          },
        ],
        tempo: [
          {
            msgs_last_window: 7,
            latest_ts: "2026-06-12T11:59:00.000Z",
          },
        ],
      }),
      {
        roomId: ROOM_ID,
        userActorId: USER_ACTOR_ID,
        now: NOW,
        members: [],
      },
    );

    expect(packet.presence).toEqual([
      {
        user: "Casey",
        lastSeenMs: 5 * 60_000,
        hasRead: true,
      },
    ]);
    expect(packet.replyTargets).toEqual([
      { fromUser: "Alex", toBot: "Nova" },
    ]);
    expect(packet.tempo.msgsLastWindow).toBe(7);
    expect(packet.tempo.lastMessageAgoMs).toBe(60_000);
    // No counterpart rows supplied → empty, but the field is always present.
    expect(packet.recentCounterparts).toEqual([]);
  });

  test("skips rows that cannot resolve display labels", async () => {
    const packet = await loadRoutingPacket(
      fakeDb({
        presence: [
          {
            recipient_id: "user-uuid-orphan",
            read_at: null,
            delivered_at: "2026-06-12T11:00:00.000Z",
            message_ts: "2026-06-12T11:00:00.000Z",
            user_handle: null,
            user_name: null,
          },
        ],
        replyTargets: [
          {
            user_handle: null,
            user_name: null,
            agent_handle: "nova",
            agent_display_name: "Nova",
          },
        ],
        tempo: [{ msgs_last_window: 0, latest_ts: null }],
      }),
      {
        roomId: ROOM_ID,
        userActorId: USER_ACTOR_ID,
        now: NOW,
        members: [],
      },
    );

    expect(packet.presence).toEqual([]);
    expect(packet.replyTargets).toEqual([]);
    expect(packet.tempo.lastMessageAgoMs).toBeNull();
  });
});

describe("loadRoutingPacket recentCounterparts (Stack-162)", () => {
  test("sender-scoped message counterpart maps with age and intervening count", async () => {
    const packet = await loadRoutingPacket(
      fakeDb({
        recentCounterparts: [
          {
            agent_handle: "nova",
            agent_display_name: "Nova",
            interaction_ts: "2026-06-12T11:57:00.000Z",
            interaction_kind: "message",
            intervening_messages: 2,
          },
        ],
      }),
      {
        roomId: ROOM_ID,
        userActorId: USER_ACTOR_ID,
        now: NOW,
        members: [],
      },
    );

    expect(packet.recentCounterparts).toEqual([
      {
        bot: "Nova",
        lastInteractionAgoMs: 3 * 60_000,
        interaction: "message",
        interveningMessages: 2,
      },
    ]);
  });

  test("empty assistant scaffolding is excluded from visible message interactions", async () => {
    let counterpartSql = "";
    const db: RoutingPacketDb = {
      ...fakeDb({}),
      execute: async (query) => {
        const text = sqlText(query);
        if (text.includes("routing-packet:recent-counterparts")) {
          counterpartSql = text;
          return [];
        }
        if (text.includes("msgs_last_window")) {
          return [{ msgs_last_window: 0, latest_ts: null }];
        }
        return [];
      },
    };

    await loadRoutingPacket(db, {
      roomId: ROOM_ID,
      userActorId: USER_ACTOR_ID,
      now: NOW,
      members: [],
    });

    // The fake DB cannot evaluate SQL semantics, so pin the query contract:
    // null, empty, and whitespace-only assistant rows (for example react/tool
    // scaffolding) must not enter msg_interactions or supersede a reaction.
    expect(counterpartSql).toContain("WHERE sm.role = 'assistant'");
    expect(counterpartSql).toContain(
      "COALESCE(sm.content, '') ~ '[^[:space:]]'",
    );
  });

  test("reaction-only interaction maps (handle fallback when no display name)", async () => {
    const packet = await loadRoutingPacket(
      fakeDb({
        recentCounterparts: [
          {
            agent_handle: "alepo",
            agent_display_name: null,
            interaction_ts: "2026-06-12T11:50:00.000Z",
            interaction_kind: "reaction",
            intervening_messages: 0,
          },
        ],
      }),
      {
        roomId: ROOM_ID,
        userActorId: USER_ACTOR_ID,
        now: NOW,
        members: [],
      },
    );

    expect(packet.recentCounterparts).toEqual([
      {
        bot: "@alepo",
        lastInteractionAgoMs: 10 * 60_000,
        interaction: "reaction",
        interveningMessages: 0,
      },
    ]);
  });

  test("stale (>60m) evidence excluded while fresh evidence is kept", async () => {
    const packet = await loadRoutingPacket(
      fakeDb({
        recentCounterparts: [
          {
            // 90 minutes ago — outside the 60m counterpart window.
            agent_handle: "stale-bot",
            agent_display_name: "Stale",
            interaction_ts: "2026-06-12T10:30:00.000Z",
            interaction_kind: "message",
            intervening_messages: 99,
          },
          {
            // 5 minutes ago — inside the window.
            agent_handle: "nova",
            agent_display_name: "Nova",
            interaction_ts: "2026-06-12T11:55:00.000Z",
            interaction_kind: "message",
            intervening_messages: 1,
          },
        ],
      }),
      {
        roomId: ROOM_ID,
        userActorId: USER_ACTOR_ID,
        now: NOW,
        members: [],
      },
    );

    expect(packet.recentCounterparts).toEqual([
      {
        bot: "Nova",
        lastInteractionAgoMs: 5 * 60_000,
        interaction: "message",
        interveningMessages: 1,
      },
    ]);
  });

  test("empty userActorId yields no counterparts (no SQL relied upon)", async () => {
    const packet = await loadRoutingPacket(
      fakeDb({
        recentCounterparts: [
          {
            agent_handle: "nova",
            agent_display_name: "Nova",
            interaction_ts: "2026-06-12T11:59:00.000Z",
            interaction_kind: "message",
            intervening_messages: 0,
          },
        ],
      }),
      {
        roomId: ROOM_ID,
        userActorId: "",
        now: NOW,
        members: [],
      },
    );
    // Short-circuit before the DB is consulted for counterparts.
    expect(packet.recentCounterparts).toEqual([]);
  });
});

describe("formatRoutingPacketLines (no raw ids)", () => {
  test("renders concise sections with handles/names only", () => {
    const lines = formatRoutingPacketLines({
      presence: [
        { user: "Casey", lastSeenMs: 120_000, hasRead: true },
        { user: "@alex", lastSeenMs: 300_000, hasRead: false },
      ],
      replyTargets: [{ fromUser: "Alex", toBot: "@nova" }],
      tempo: { msgsLastWindow: 4, lastMessageAgoMs: 90_000 },
      recentCounterparts: [],
    });
    const text = lines.join("\n");

    expect(text).toContain("Room relationship metadata:");
    expect(text).toContain("Presence/read:");
    expect(text).toContain("Casey");
    expect(text).toContain("@alex");
    expect(text).toContain("Recent reply graph: Alex → @nova");
    expect(text).toContain("Room tempo: 4 messages in recent 5m window");
    expect(text).toContain("latest 2m ago");
    // Empty counterparts still surface a (none) line so the FM knows.
    expect(text).toContain("Recent counterparts for this sender: (none in the last 60m)");

    expect(text).not.toContain(ROOM_ID);
    expect(text).not.toContain(USER_ACTOR_ID);
    expect(text).not.toContain("user-uuid");
    expect(text).not.toContain("actor-");
  });

  test("Stack-162 — renders recent counterpart evidence with bot/age/kind/intervening count, no raw ids or content", () => {
    const lines = formatRoutingPacketLines({
      presence: [],
      replyTargets: [],
      tempo: { msgsLastWindow: 0, lastMessageAgoMs: null },
      recentCounterparts: [
        {
          bot: "Nova",
          lastInteractionAgoMs: 180_000,
          interaction: "message",
          interveningMessages: 2,
        },
        {
          bot: "@alepo",
          lastInteractionAgoMs: 600_000,
          interaction: "reaction",
          interveningMessages: 0,
        },
      ],
    });
    const text = lines.join("\n");

    expect(text).toContain("Recent counterparts for this sender (newest first):");
    expect(text).toContain("Nova — 3m ago, message, 2 intervening room messages");
    expect(text).toContain("@alepo — 10m ago, reaction, 0 intervening room messages");
    // No raw ids, no message content leaks into the prompt-facing packet.
    expect(text).not.toContain(ROOM_ID);
    expect(text).not.toContain(USER_ACTOR_ID);
    expect(text).not.toContain("actor-");
    expect(text).not.toContain("agent-");
  });

  test("Stack-162 — high intervening message count is visible and described as weakening continuity", () => {
    const lines = formatRoutingPacketLines({
      presence: [],
      replyTargets: [],
      tempo: { msgsLastWindow: 0, lastMessageAgoMs: null },
      recentCounterparts: [
        {
          bot: "@nova",
          lastInteractionAgoMs: 1_200_000,
          interaction: "reaction",
          interveningMessages: 47,
        },
      ],
    });
    const text = lines.join("\n");

    expect(text).toContain("47 intervening room messages");
    // The factual packet points to the continuation rubric and notes weakening,
    // without re-stating the full policy prose (consolidated in the FM prompt).
    expect(text).toContain("SOFT relationship context");
    expect(text).toContain("high intervening counts weaken continuity");
    expect(text).not.toContain("WEAKEN or BREAK continuity");
    expect(text).not.toContain("DIRECTED CONTINUATION");
  });

  test("Stack-162 — counterpart evidence is factual + a one-line pointer to the rubric (no duplicated policy prose)", () => {
    const lines = formatRoutingPacketLines({
      presence: [],
      replyTargets: [],
      tempo: { msgsLastWindow: 0, lastMessageAgoMs: null },
      recentCounterparts: [
        {
          bot: "@nova",
          lastInteractionAgoMs: 240_000,
          interaction: "message",
          interveningMessages: 0,
        },
      ],
    });
    const text = lines.join("\n");

    // Factual evidence only — bot, age, kind, intervening count.
    expect(text).toContain("Recent counterparts for this sender (newest first):");
    expect(text).toContain("@nova — 4m ago, message, 0 intervening room messages");
    // One concise pointer line; the full rubric lives in the FM prompt, not here.
    expect(text).toContain("SOFT relationship context for the continuation rubric below");
    expect(text).toContain("never a wake trigger by itself");
    // The duplicated policy block is gone from the packet snapshot.
    expect(text).not.toContain("DIRECTED CONTINUATION");
    expect(text).not.toContain("Continuity guidance for the above counterparts");
    expect(text).not.toContain("Recency alone is NEVER a wake trigger");
    expect(text).not.toContain("STRONGLY PREFER");
    // Reserved live-evaluation phrase must never appear.
    expect(text.toLowerCase()).not.toContain("dazzle");
    expect(text.toLowerCase()).not.toContain("zazz");
  });
});

/**
 * D421 Phase 1 — Stack 202 corpus-driven packet rendering (tasks 1.2.1–1.2.3).
 *
 * Asserts the routing packet rendered for each corpus fixture surfaces
 * counterpart evidence by display label only, with the DIRECTED CONTINUATION
 * rubric present when a counterpart exists, and that no raw sentinel id or
 * held-out live phrase fragment leaks into the packet snapshot.
 */
describe("D421 Phase 1 — continuation corpus packet rendering", () => {
  // Fragments of the held-out live-evaluation phrase; the full phrase is never
  // committed. Matches the convention in floor-manager.test.ts.
  const HELD_OUT_FRAGMENTS = ["dazzle", "zazz"];

  test("every fixture with a counterpart renders that counterpart by display label and a pointer to the rubric", () => {
    for (const f of CONTINUATION_FIXTURES) {
      const text = formatRoutingPacketLines(f.routingPacket).join("\n");
      if (f.routingPacket.recentCounterparts.length === 0) {
        expect(text).toContain("(none in the last 60m)");
      } else {
        for (const c of f.routingPacket.recentCounterparts) {
          expect(text).toContain(c.bot);
        }
        // The packet points to the continuation rubric; the full policy prose
        // is consolidated in the FM prompt, not duplicated here.
        expect(text).toContain("continuation rubric below");
        expect(text).not.toContain("DIRECTED CONTINUATION");
      }
    }
  });

  test("high-churn fixture surfaces a high intervening count with the weakening note", () => {
    const f = CONTINUATION_FIXTURES.find((x) => x.category === "high_churn")!;
    const text = formatRoutingPacketLines(f.routingPacket).join("\n");
    expect(text).toContain("20 intervening room messages");
    expect(text).toContain("high intervening counts weaken continuity");
    // The old verbose weakening block moved to the FM prompt rubric.
    expect(text).not.toContain("WEAKEN or BREAK continuity");
  });

  test("stale fixture surfaces the stale counterpart age without leaking raw ids", () => {
    const f = CONTINUATION_FIXTURES.find((x) => x.category === "stale")!;
    const text = formatRoutingPacketLines(f.routingPacket).join("\n");
    expect(text).toContain("Nova — 55m ago");
    for (const sentinel of SENTINEL_VALUES) {
      expect(text).not.toContain(sentinel);
    }
  });

  test("no raw sentinel id or held-out phrase fragment appears in any corpus packet snapshot", () => {
    for (const f of CONTINUATION_FIXTURES) {
      const text = formatRoutingPacketLines(f.routingPacket).join("\n");
      for (const sentinel of SENTINEL_VALUES) {
        expect(text).not.toContain(sentinel);
      }
      const lower = text.toLowerCase();
      for (const frag of HELD_OUT_FRAGMENTS) {
        expect(lower).not.toContain(frag);
      }
    }
  });
});
