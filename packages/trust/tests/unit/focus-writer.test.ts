import { describe, expect, test } from "bun:test";
import type { FocusEvent, NewFocusEvent } from "@nautilo/db";
import {
  clearFocus,
  materializeExpiry,
  openOrExtendFocus,
  type FocusDb,
} from "@nautilo/trust";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const BOT_ID = "00000000-0000-4000-8000-000000000003";
const FOCUS_ID = "00000000-0000-4000-8000-000000000010";
const FOCUS_TTL_MS = 90_000;

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
    anchorMessageId: partial.anchorMessageId ?? null,
    expiresAt: partial.expiresAt ?? null,
    occurredAt,
  };
}

function makeFakeDb() {
  const inserted: NewFocusEvent[] = [];
  const db = {
    insert: () => ({
      values: (row: NewFocusEvent) => {
        inserted.push(row);
        return Promise.resolve();
      },
    }),
  } as unknown as FocusDb;
  return { db, inserted };
}

function deps(events: FocusEvent[]) {
  return { loadEvents: async () => events };
}

describe("openOrExtendFocus", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  test("open into empty log inserts opened with new focusId and TTL", async () => {
    const { db, inserted } = makeFakeDb();
    const result = await openOrExtendFocus(
      db,
      {
        roomId: ROOM_ID,
        userActorId: USER_ID,
        botActorId: BOT_ID,
        source: "mention",
        now,
      },
      deps([]),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.eventType).toBe("opened");
    expect(inserted[0]!.focusId).toBeTruthy();
    expect(inserted[0]!.expiresAt).toEqual(new Date(now.getTime() + FOCUS_TTL_MS));
    expect(result.focusId).toBe(inserted[0]!.focusId);
    expect(result.expiresAt).toEqual(new Date(now.getTime() + FOCUS_TTL_MS));
    expect(result.created).toBe(true);
  });

  test("extend when active opened focus exists for bot reuses focusId", async () => {
    const expiresAt = new Date(now.getTime() + FOCUS_TTL_MS);
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "ui",
        expiresAt,
        occurredAt: now,
      }),
    ];
    const { db, inserted } = makeFakeDb();
    const later = new Date(now.getTime() + 30_000);
    const result = await openOrExtendFocus(
      db,
      {
        roomId: ROOM_ID,
        userActorId: USER_ID,
        botActorId: BOT_ID,
        source: "reply",
        now: later,
      },
      deps(events),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.eventType).toBe("extended");
    expect(inserted[0]!.focusId).toBe(FOCUS_ID);
    expect(result.focusId).toBe(FOCUS_ID);
    expect(result.expiresAt).toEqual(new Date(later.getTime() + FOCUS_TTL_MS));
    expect(result.created).toBe(false);
  });

  test("extend does not resurrect cleared focus — mints new focusId", async () => {
    const oldExpires = new Date(now.getTime() + FOCUS_TTL_MS);
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: oldExpires,
        occurredAt: new Date(now.getTime() - 60_000),
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "cleared",
        source: null,
        expiresAt: null,
        occurredAt: new Date(now.getTime() - 30_000),
      }),
    ];
    const { db, inserted } = makeFakeDb();
    const result = await openOrExtendFocus(
      db,
      {
        roomId: ROOM_ID,
        userActorId: USER_ID,
        botActorId: BOT_ID,
        source: "ui",
        now,
      },
      deps(events),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.eventType).toBe("opened");
    expect(inserted[0]!.focusId).not.toBe(FOCUS_ID);
    expect(result.focusId).not.toBe(FOCUS_ID);
    expect(result.created).toBe(true);
  });
});

describe("clearFocus", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  test("clear known focus inserts cleared with resolved botActorId", async () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: new Date(now.getTime() + FOCUS_TTL_MS),
      }),
    ];
    const { db, inserted } = makeFakeDb();
    const result = await clearFocus(
      db,
      { roomId: ROOM_ID, userActorId: USER_ID, focusId: FOCUS_ID, now },
      deps(events),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      eventType: "cleared",
      focusId: FOCUS_ID,
      botActorId: BOT_ID,
      expiresAt: null,
    });
    expect(result.botActorId).toBe(BOT_ID);
  });

  test("clearFocus is idempotent when cleared already exists", async () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: new Date(now.getTime() + FOCUS_TTL_MS),
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "cleared",
        source: null,
        expiresAt: null,
      }),
    ];
    const { db, inserted } = makeFakeDb();
    const result = await clearFocus(
      db,
      { roomId: ROOM_ID, userActorId: USER_ID, focusId: FOCUS_ID, now },
      deps(events),
    );
    expect(inserted).toHaveLength(0);
    expect(result.botActorId).toBe(BOT_ID);
  });

  test("clearFocus on unknown focusId inserts nothing", async () => {
    const { db, inserted } = makeFakeDb();
    const result = await clearFocus(
      db,
      {
        roomId: ROOM_ID,
        userActorId: USER_ID,
        focusId: "00000000-0000-4000-8000-000000000099",
        now,
      },
      deps([]),
    );
    expect(inserted).toHaveLength(0);
    expect(result.botActorId).toBeNull();
  });
});

describe("materializeExpiry", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  const lapsedExpiresAt = new Date("2026-01-01T11:59:00.000Z");

  test("writes expired with lapsed expiresAt when no cleared or expired exists", async () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: lapsedExpiresAt,
      }),
    ];
    const { db, inserted } = makeFakeDb();
    await materializeExpiry(
      db,
      {
        roomId: ROOM_ID,
        userActorId: USER_ID,
        botActorId: BOT_ID,
        focusId: FOCUS_ID,
        lapsedExpiresAt,
        now,
      },
      deps(events),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      eventType: "expired",
      focusId: FOCUS_ID,
      expiresAt: lapsedExpiresAt,
    });
  });

  test("skips when cleared exists for focusId", async () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: lapsedExpiresAt,
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "cleared",
        source: null,
        expiresAt: null,
      }),
    ];
    const { db, inserted } = makeFakeDb();
    await materializeExpiry(
      db,
      {
        roomId: ROOM_ID,
        userActorId: USER_ID,
        botActorId: BOT_ID,
        focusId: FOCUS_ID,
        lapsedExpiresAt,
        now,
      },
      deps(events),
    );
    expect(inserted).toHaveLength(0);
  });

  test("skips when expired already exists for focusId", async () => {
    const events = [
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "opened",
        source: "mention",
        expiresAt: lapsedExpiresAt,
      }),
      makeEvent({
        focusId: FOCUS_ID,
        eventType: "expired",
        source: null,
        expiresAt: lapsedExpiresAt,
      }),
    ];
    const { db, inserted } = makeFakeDb();
    await materializeExpiry(
      db,
      {
        roomId: ROOM_ID,
        userActorId: USER_ID,
        botActorId: BOT_ID,
        focusId: FOCUS_ID,
        lapsedExpiresAt,
        now,
      },
      deps(events),
    );
    expect(inserted).toHaveLength(0);
  });
});
