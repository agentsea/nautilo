import { describe, expect, test } from "bun:test";
import type { FocusEvent } from "@nautilo/db";
import { deriveActiveFoci } from "@nautilo/trust";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const BOT_ID = "00000000-0000-4000-8000-000000000003";
const FOCUS_ID = "00000000-0000-4000-8000-000000000010";

let nextId = 1;

function makeEvent(
  partial: Partial<FocusEvent> & Pick<FocusEvent, "eventType" | "focusId">,
): FocusEvent {
  const occurredAt = partial.occurredAt ?? new Date("2026-01-01T12:00:00.000Z");
  return {
    id: partial.id ?? nextId++,
    roomId: partial.roomId ?? ROOM_ID,
    userActorId: partial.userActorId ?? USER_ID,
    botActorId: partial.botActorId ?? BOT_ID,
    focusId: partial.focusId,
    eventType: partial.eventType,
    source: partial.source ?? null,
    reason: partial.reason ?? null,
    expiresAt: partial.expiresAt ?? null,
    anchorMessageId: partial.anchorMessageId ?? null,
    occurredAt,
  };
}

describe("deriveActiveFoci", () => {
  const now = new Date("2026-01-01T12:01:00.000Z");

  test("single opened with future expiresAt yields one ActiveFocus", () => {
    const expiresAt = new Date("2026-01-01T12:02:00.000Z");
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt,
      }),
    ];
    const active = deriveActiveFoci(events, now);
    expect(active).toHaveLength(1);
    expect(active[0]).toEqual({
      focusId: FOCUS_ID,
      botActorId: BOT_ID,
      expiresAt,
      openedSource: "mention",
      openedAt: new Date("2026-01-01T12:00:00.000Z"),
      extendCount: 0,
      openedReason: null,
      anchorMessageId: null,
    });
  });

  test("opened then extended uses extended expiresAt", () => {
    const openedExpires = new Date("2026-01-01T12:01:30.000Z");
    const extendedExpires = new Date("2026-01-01T12:03:00.000Z");
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "ui",
        expiresAt: openedExpires,
        occurredAt: new Date("2026-01-01T12:00:00.000Z"),
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "extended",
        source: "reply",
        expiresAt: extendedExpires,
        occurredAt: new Date("2026-01-01T12:00:30.000Z"),
      }),
    ];
    const active = deriveActiveFoci(events, now);
    expect(active).toHaveLength(1);
    expect(active[0]!.expiresAt).toEqual(extendedExpires);
    expect(active[0]!.openedSource).toBe("ui");
  });

  test("opened with expiresAt <= now is not active without expired row", () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: new Date("2026-01-01T12:00:59.000Z"),
      }),
    ];
    expect(deriveActiveFoci(events, now)).toEqual([]);
  });

  test("opened then expired is not active", () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: new Date("2026-01-01T12:02:00.000Z"),
        occurredAt: new Date("2026-01-01T12:00:00.000Z"),
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "expired",
        source: null,
        expiresAt: new Date("2026-01-01T12:02:00.000Z"),
        occurredAt: new Date("2026-01-01T12:01:30.000Z"),
      }),
    ];
    expect(deriveActiveFoci(events, now)).toEqual([]);
  });

  test("opened then cleared is not active", () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: new Date("2026-01-01T12:02:00.000Z"),
        occurredAt: new Date("2026-01-01T12:00:00.000Z"),
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "cleared",
        source: null,
        expiresAt: null,
        occurredAt: new Date("2026-01-01T12:00:30.000Z"),
      }),
    ];
    expect(deriveActiveFoci(events, now)).toEqual([]);
  });

  test("cleared as latest event wins over earlier opened and later-looking expired", () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: new Date("2026-01-01T12:02:00.000Z"),
        occurredAt: new Date("2026-01-01T12:00:00.000Z"),
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "expired",
        source: null,
        expiresAt: new Date("2026-01-01T12:02:00.000Z"),
        occurredAt: new Date("2026-01-01T12:00:45.000Z"),
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "cleared",
        source: null,
        expiresAt: null,
        occurredAt: new Date("2026-01-01T12:01:00.000Z"),
      }),
    ];
    expect(deriveActiveFoci(events, now)).toEqual([]);
  });

  test("two distinct focusIds for same user yield two ActiveFocus entries", () => {
    const focusA = "00000000-0000-4000-8000-000000000011";
    const focusB = "00000000-0000-4000-8000-000000000012";
    const botB = "00000000-0000-4000-8000-000000000004";
    const expiresAt = new Date("2026-01-01T12:02:00.000Z");
    const events = [
      makeEvent({
        focusId: focusA,
        eventType: "opened",
        source: "mention",
        expiresAt,
        botActorId: BOT_ID,
      }),
      makeEvent({
        focusId: focusB,
        eventType: "opened",
        source: "ui",
        expiresAt,
        botActorId: botB,
      }),
    ];
    const active = deriveActiveFoci(events, now);
    expect(active).toHaveLength(2);
    expect(active.map((f) => f.focusId).sort()).toEqual([focusA, focusB].sort());
  });

  test("openedSource reflects original opened row source", () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "inferred",
        expiresAt: new Date("2026-01-01T12:00:00.000Z"),
        occurredAt: new Date("2026-01-01T11:59:00.000Z"),
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "extended",
        source: "mention",
        expiresAt: new Date("2026-01-01T12:02:00.000Z"),
        occurredAt: new Date("2026-01-01T12:00:30.000Z"),
      }),
    ];
    const active = deriveActiveFoci(events, now);
    expect(active).toHaveLength(1);
    expect(active[0]!.openedSource).toBe("inferred");
  });

  test("D302 R7/R8 exposes opened metadata, extend count, reason, and anchor", () => {
    const openedAt = new Date("2026-01-01T12:00:00.000Z");
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "inferred",
        reason: "floor: direct address",
        expiresAt: new Date("2026-01-01T12:01:30.000Z"),
        occurredAt: openedAt,
        anchorMessageId: 42,
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "extended",
        source: "reply",
        reason: "reply",
        expiresAt: new Date("2026-01-01T12:03:00.000Z"),
        occurredAt: new Date("2026-01-01T12:00:30.000Z"),
      }),
    ];
    const active = deriveActiveFoci(events, now);
    expect(active).toHaveLength(1);
    expect(active[0]!).toMatchObject({
      openedAt,
      extendCount: 1,
      openedReason: "floor: direct address",
      anchorMessageId: 42,
    });
  });
});
