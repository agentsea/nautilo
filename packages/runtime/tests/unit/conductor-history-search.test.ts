import { describe, expect, test } from "bun:test";
import type { SQL } from "@nautilo/db";
import {
  recentBoundedRoomMessages,
  recentConversationWindow,
  type RoomHistoryHit,
} from "../../src/conductor/history-search";

function hit(
  messageId: number,
  role: "user" | "assistant" | "tool",
  snippet: string,
  foregroundExecutionId?: string,
): RoomHistoryHit {
  const agentAuthored = role !== "user";
  return {
    messageId,
    ts: new Date(Date.UTC(2026, 5, 1, 10, 0, 0, messageId)),
    role,
    authorDisplayName: agentAuthored ? "Nova" : "Alice",
    handle: agentAuthored ? "nova" : "alice",
    authorActorId: agentAuthored ? "actor-nova" : "actor-alice",
    snippet,
    ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
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

describe("foreground history source", () => {
  test("keeps every fitting post-trigger pair after bounding only prior conversation", () => {
    const prior = [
      hit(1, "user", "older question"),
      hit(2, "assistant", "older answer"),
    ];
    const currentRun = Array.from({ length: 51 }, (_, index) => {
      const assistantId = 3 + index * 2;
      return [
        hit(assistantId, "assistant", `current call ${index}`, "turn-current"),
        hit(assistantId + 1, "tool", `current result ${index}`, "turn-current"),
      ];
    }).flat();

    // The forthcoming optional third argument is the inclusive trigger
    // coordinate. Reflect.apply lets this regression execute today's function
    // (which ignores it) without a nonexistent-signature compile failure.
    const retained = Reflect.apply(recentConversationWindow, null, [
      [...prior, ...currentRun],
      50,
      2,
    ]);

    expect(retained.filter((row) => row.foregroundExecutionId === "turn-current"))
      .toEqual(currentRun);
  });

  test("queries an inclusive Room timeline after a prior-only recency window", async () => {
    const queries: SQL[] = [];
    await recentBoundedRoomMessages(
      {
        async execute(query) {
          queries.push(query);
          return [];
        },
      },
      {
        roomId: "room-refresh",
        agentId: "agent-refresh",
        excludeMessageId: 100,
        excludeMessageIds: [99, 100],
        throughMessageIdInclusive: 180,
        foregroundExecutionId: "turn-current",
        conversationalLimit: 50,
      },
    );

    const queryText = JSON.stringify(queries[0]);
    const parameters = parameterValues(queries[0]!);

    // The recency boundary applies to history before the accepted trigger.
    // Every authorized visible Room row after it remains eligible through the
    // stable inclusive cut, including another Human or competing execution.
    expect(queryText).toContain("e.message_id <");
    expect(queryText).not.toContain("sm.role IN ('assistant', 'tool')");
    expect(parameters).not.toContain("agent-refresh");
    expect(parameters).not.toContain("turn-current");

    // Accepted ingress coordinates and their duplicated fingerprints remain
    // excluded even though other post-trigger Human messages are visible.
    expect(queryText).toContain("sm.id NOT IN");
    expect(queryText).toContain("accepted_sm.fingerprint = sm.fingerprint");
    expect(parameters).toContain(99);
    expect(parameters).toContain(100);
    expect(parameters).toContain(180);
  });
});
