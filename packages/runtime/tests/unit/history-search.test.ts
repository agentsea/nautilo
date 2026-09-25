import { describe, expect, test } from "bun:test";
import {
  searchRoomHistory,
  searchRoomHistoryRelaxed,
  type RoomHistorySearchDb,
} from "../../src/conductor/history-search";

function fakeDb(rows: readonly Record<string, unknown>[]): RoomHistorySearchDb {
  return {
    async execute() {
      return rows;
    },
  };
}

describe("searchRoomHistory", () => {
  test("keeps whole-token FTS and Conductor deaf-window policy in its adapter", async () => {
    let queryText = "";
    const db: RoomHistorySearchDb = {
      async execute(query) {
        queryText = JSON.stringify(query);
        return [];
      },
    };

    await searchRoomHistory(db, { roomId: "room-1", query: "launch plans", limit: 5 });
    expect(queryText).toContain("plainto_tsquery('english'");
    expect(queryText).toContain("room_silence_state");
    expect(queryText).toContain("content_search");
    expect(queryText).toContain("nautilo_browser_decision_observation");
    expect(queryText).toContain("browser-choice:%");
  });

  test("does not execute for invalid shared-search input", async () => {
    let calls = 0;
    const db: RoomHistorySearchDb = {
      async execute() {
        calls += 1;
        return [];
      },
    };
    const hits = await searchRoomHistory(db, { roomId: "room-1", query: "---", limit: 5 });
    expect(hits).toEqual([]);
    expect(calls).toBe(0);
  });

  test("attributes tool rows in an agent session to that agent", async () => {
    const hits = await searchRoomHistory(
      fakeDb([
        {
          message_id: 42,
          ts: "2026-06-12T12:00:00.000Z",
          role: "tool",
          content: "SOXL crashed hard and then recovered.",
          agent_handle: "genie_taylor",
          agent_display_name: "Genie",
          agent_actor_id: "actor-genie-taylor",
          user_handle: "alex",
          user_name: "Alex",
          user_actor_id: "actor-alex",
        },
      ]),
      { roomId: "room-1", query: "stock crash", limit: 5 },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      messageId: 42,
      authorDisplayName: "Genie",
      handle: "genie_taylor",
      authorActorId: "actor-genie-taylor",
      snippet: "SOXL crashed hard and then recovered.",
    });
  });

  test("keeps user rows attributed to the human even in an agent session", async () => {
    const hits = await searchRoomHistory(
      fakeDb([
        {
          message_id: 43,
          ts: "2026-06-12T12:00:00.000Z",
          role: "user",
          content: "Who was I talking to about the stock crash?",
          agent_handle: "genie_taylor",
          agent_display_name: "Genie",
          agent_actor_id: "actor-genie-taylor",
          user_handle: "alex",
          user_name: "Alex",
          user_actor_id: "actor-alex",
        },
      ]),
      { roomId: "room-1", query: "stock crash", limit: 5 },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      messageId: 43,
      authorDisplayName: "Alex",
      handle: "alex",
      authorActorId: "actor-alex",
    });
  });
});

describe("searchRoomHistoryRelaxed (D302 P11)", () => {
  test("retries normalized query ladder until hits are found", async () => {
    let calls = 0;
    const db: RoomHistorySearchDb = {
      async execute() {
        calls += 1;
        if (calls < 2) return [];
        return [
          {
            message_id: 44,
            ts: "2026-06-12T12:00:00.000Z",
            role: "assistant",
            content: "The stock crash recovered after SOXL bounced.",
            agent_handle: "genie_taylor",
            agent_display_name: "Genie",
            agent_actor_id: "actor-genie-taylor",
            user_handle: "alex",
            user_name: "Alex",
            user_actor_id: "actor-alex",
          },
        ];
      },
    };

    const hits = await searchRoomHistoryRelaxed(db, {
      roomId: "room-1",
      query: "stock crash conversation history",
      limit: 5,
    });

    expect(calls).toBe(2);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      messageId: 44,
      handle: "genie_taylor",
      authorActorId: "actor-genie-taylor",
    });
  });
});
