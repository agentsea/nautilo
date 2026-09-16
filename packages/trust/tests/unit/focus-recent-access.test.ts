import { describe, expect, test } from "bun:test";
import type { FocusEvent } from "@nautilo/db";
import { deriveRecentFocusBotActorIds } from "@nautilo/trust";

const REQUESTER = "00000000-0000-4000-8000-000000000001";
const OTHER_REQUESTER = "00000000-0000-4000-8000-000000000002";

function event(
  id: number,
  partial: Pick<FocusEvent, "botActorId" | "eventType" | "focusId"> & Partial<FocusEvent>,
): FocusEvent {
  return {
    id,
    roomId: partial.roomId ?? "00000000-0000-4000-8000-000000000010",
    userActorId: partial.userActorId ?? REQUESTER,
    botActorId: partial.botActorId,
    focusId: partial.focusId,
    eventType: partial.eventType,
    source: partial.source ?? null,
    reason: partial.reason ?? null,
    expiresAt: partial.expiresAt ?? null,
    anchorMessageId: partial.anchorMessageId ?? null,
    occurredAt: partial.occurredAt ?? new Date("2026-07-22T12:00:00.000Z"),
  };
}

describe("deriveRecentFocusBotActorIds", () => {
  test("is requester-private, spans rooms, and ranks the latest open or extend", () => {
    const atlas = "00000000-0000-4000-8000-000000000101";
    const nova = "00000000-0000-4000-8000-000000000102";
    const privateBot = "00000000-0000-4000-8000-000000000103";

    expect(deriveRecentFocusBotActorIds([
      event(1, {
        botActorId: atlas,
        focusId: "00000000-0000-4000-8000-000000000201",
        eventType: "opened",
        roomId: "00000000-0000-4000-8000-000000000011",
        occurredAt: new Date("2026-07-22T12:01:00.000Z"),
      }),
      event(2, {
        botActorId: nova,
        focusId: "00000000-0000-4000-8000-000000000202",
        eventType: "opened",
        roomId: "00000000-0000-4000-8000-000000000012",
        occurredAt: new Date("2026-07-22T12:02:00.000Z"),
      }),
      event(3, {
        botActorId: atlas,
        focusId: "00000000-0000-4000-8000-000000000201",
        eventType: "extended",
        roomId: "00000000-0000-4000-8000-000000000011",
        occurredAt: new Date("2026-07-22T12:03:00.000Z"),
      }),
      event(4, {
        botActorId: privateBot,
        focusId: "00000000-0000-4000-8000-000000000203",
        eventType: "opened",
        userActorId: OTHER_REQUESTER,
        occurredAt: new Date("2026-07-22T12:04:00.000Z"),
      }),
    ], REQUESTER)).toEqual([atlas, nova]);
  });

  test("does not treat cleared or expired rows as access", () => {
    const atlas = "00000000-0000-4000-8000-000000000101";
    const nova = "00000000-0000-4000-8000-000000000102";

    expect(deriveRecentFocusBotActorIds([
      event(1, {
        botActorId: atlas,
        focusId: "00000000-0000-4000-8000-000000000201",
        eventType: "opened",
        occurredAt: new Date("2026-07-22T12:01:00.000Z"),
      }),
      event(2, {
        botActorId: atlas,
        focusId: "00000000-0000-4000-8000-000000000201",
        eventType: "cleared",
        occurredAt: new Date("2026-07-22T12:05:00.000Z"),
      }),
      event(3, {
        botActorId: nova,
        focusId: "00000000-0000-4000-8000-000000000202",
        eventType: "opened",
        occurredAt: new Date("2026-07-22T12:02:00.000Z"),
      }),
      event(4, {
        botActorId: nova,
        focusId: "00000000-0000-4000-8000-000000000202",
        eventType: "expired",
        occurredAt: new Date("2026-07-22T12:06:00.000Z"),
      }),
    ], REQUESTER)).toEqual([nova, atlas]);
  });

  test("breaks same-time access ties by event insertion id", () => {
    const atlas = "00000000-0000-4000-8000-000000000101";
    const nova = "00000000-0000-4000-8000-000000000102";
    const sameMoment = new Date("2026-07-22T12:00:00.000Z");

    expect(deriveRecentFocusBotActorIds([
      event(8, { botActorId: atlas, focusId: "00000000-0000-4000-8000-000000000201", eventType: "opened", occurredAt: sameMoment }),
      event(9, { botActorId: nova, focusId: "00000000-0000-4000-8000-000000000202", eventType: "opened", occurredAt: sameMoment }),
    ], REQUESTER)).toEqual([nova, atlas]);
  });
});
