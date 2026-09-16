/**
 * D212 — client-side reaction wiring locks:
 *   1. restoreSessionMessages carries inlined `reactions` into
 *      `metadata.custom.reactions` for user + assistant text messages.
 *   2. The agent `react` tool result is NOT restored as a tool card,
 *      and skipping it preserves FIFO pairing for the next real tool.
 *   3. reaction.added / reaction.removed WS events route by room lane.
 */
import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  restoreSessionMessages,
  type StoredSessionMessageDto,
} from "../../src/adapters/session-rehydrate";
import { shouldApplyWsEventForActiveRoom } from "../../src/adapters/ws-event-room";
import { applyReactionDelta } from "../../src/modes/rooms/shape/reactions/reaction-aggregate";

type Part = { type?: string; toolName?: string; toolCallId?: string; text?: string };
type Restored = {
  role: string;
  content: Part[];
  metadata?: { custom?: { reactions?: { emoji: string; count: number }[] } };
};

function reactionsOf(m: Restored): { emoji: string; count: number }[] | undefined {
  return m.metadata?.custom?.reactions;
}

describe("restoreSessionMessages — D212 reactions plumbing", () => {
  test("user message carries inlined reactions into metadata.custom", () => {
    const msgs: StoredSessionMessageDto[] = [
      {
        id: "1",
        role: "user",
        content: "hi",
        reactions: [{ emoji: "👍", count: 2 }],
      },
    ];
    const out = restoreSessionMessages(msgs) as unknown as Restored[];
    expect(out).toHaveLength(1);
    expect(reactionsOf(out[0]!)).toEqual([{ emoji: "👍", count: 2 }]);
  });

  test("assistant text message carries reactions; absent field → no metadata", () => {
    const msgs: StoredSessionMessageDto[] = [
      { id: "1", role: "assistant", content: "done", reactions: [{ emoji: "🎉", count: 1 }] },
      { id: "2", role: "assistant", content: "plain" },
    ];
    const out = restoreSessionMessages(msgs) as unknown as Restored[];
    expect(reactionsOf(out[0]!)).toEqual([{ emoji: "🎉", count: 1 }]);
    expect(reactionsOf(out[1]!)).toBeUndefined();
  });
});

describe("restoreSessionMessages — D212 react tool-card suppression", () => {
  test("react tool result is not restored as a tool-call part", () => {
    const msgs: StoredSessionMessageDto[] = [
      { id: "1", role: "assistant", content: "", toolCalls: JSON.stringify([{ id: "c1", name: "react" }]) },
      { id: "2", role: "tool", content: '{"ok":true}', toolName: "react" },
    ];
    const out = restoreSessionMessages(msgs) as unknown as Restored[];
    const toolParts = out.flatMap((m) => m.content).filter((p) => p.type === "tool-call");
    expect(toolParts).toHaveLength(0);
  });

  test("skipping react preserves FIFO pairing for the next real tool", () => {
    const msgs: StoredSessionMessageDto[] = [
      {
        id: "1",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([
          { id: "c1", name: "react" },
          { id: "c2", name: "search_memory", args: { query: "x" } },
        ]),
      },
      { id: "2", role: "tool", content: '{"ok":true}', toolName: "react" },
      { id: "3", role: "tool", content: "results", toolName: "search_memory" },
    ];
    const out = restoreSessionMessages(msgs) as unknown as Restored[];
    const toolParts = out.flatMap((m) => m.content).filter((p) => p.type === "tool-call");
    // Only the non-react tool survives, paired with ITS call id (not c1).
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]!.toolName).toBe("search_memory");
    expect(toolParts[0]!.toolCallId).toBe("c2");
  });

  test("react detected via the paired call name when message toolName is absent", () => {
    const msgs: StoredSessionMessageDto[] = [
      { id: "1", role: "assistant", content: "", toolCalls: JSON.stringify([{ id: "c1", name: "react" }]) },
      { id: "2", role: "tool", content: '{"ok":true}' },
    ];
    const out = restoreSessionMessages(msgs) as unknown as Restored[];
    const toolParts = out.flatMap((m) => m.content).filter((p) => p.type === "tool-call");
    expect(toolParts).toHaveLength(0);
  });
});

describe("applyReactionDelta — D212 P2 count aggregation", () => {
  test("add a brand-new emoji inserts with count 1", () => {
    expect(applyReactionDelta([], "👍", 1)).toEqual([{ emoji: "👍", count: 1 }]);
  });

  test("add an existing emoji increments its count (distinct actor)", () => {
    expect(applyReactionDelta([{ emoji: "👍", count: 1 }], "👍", 1)).toEqual([
      { emoji: "👍", count: 2 },
    ]);
  });

  test("remove decrements; the entry is dropped when it hits zero", () => {
    expect(applyReactionDelta([{ emoji: "👍", count: 1 }], "👍", -1)).toEqual([]);
  });

  test("remove of a higher count keeps the entry", () => {
    expect(applyReactionDelta([{ emoji: "🎉", count: 3 }], "🎉", -1)).toEqual([
      { emoji: "🎉", count: 2 },
    ]);
  });

  test("remove of an absent emoji is a no-op (idempotent)", () => {
    expect(applyReactionDelta([{ emoji: "👍", count: 1 }], "🎉", -1)).toEqual([
      { emoji: "👍", count: 1 },
    ]);
  });

  test("does not mutate the input array (pure)", () => {
    const input = [{ emoji: "👍", count: 1 }];
    applyReactionDelta(input, "👍", 1);
    expect(input).toEqual([{ emoji: "👍", count: 1 }]);
  });
});

describe("shouldApplyWsEventForActiveRoom — D212 reaction routing", () => {
  const ROOM = "809996bd-5db4-44a1-875d-82eb9ff84c82";
  const OTHER = "11111111-2222-3333-4444-555555555555";

  function added(roomLane: string): ServerEvent {
    return {
      type: "reaction.added",
      laneKey: `room:${roomLane}`,
      messageId: 42,
      actorId: "actor-1",
      emoji: "👍",
      createdAt: "2026-06-05T00:00:00Z",
    } satisfies ServerEvent;
  }

  test("reaction in the active room applies", () => {
    expect(
      shouldApplyWsEventForActiveRoom({
        event: added(ROOM),
        activeRoomId: ROOM,
        laneKeyToRoomId: new Map(),
        jobIdToRoomId: new Map(),
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("reaction in another room is dropped", () => {
    expect(
      shouldApplyWsEventForActiveRoom({
        event: added(OTHER),
        activeRoomId: ROOM,
        laneKeyToRoomId: new Map(),
        jobIdToRoomId: new Map(),
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("reaction.removed routes by lane the same way", () => {
    const ev = {
      type: "reaction.removed",
      laneKey: `room:${OTHER}`,
      messageId: 42,
      actorId: "actor-1",
      emoji: "👍",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: ROOM,
        laneKeyToRoomId: new Map(),
        jobIdToRoomId: new Map(),
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });
});
