import { and, desc, eq, focusEvents, inArray, type FocusEvent } from "@nautilo/db";
import { deriveActiveFoci, type ActiveFocus } from "./derive";
import { materializeExpiry, type FocusDb } from "./writer";

/**
 * M134 Phase 1 — focus read surface (powers routing AND the focus UI).
 *
 * `loadFocusEventsNear` from the spec is deferred — it only feeds
 * history-evidence routing, which is out of M134.
 */
async function loadFocusEvents(
  db: FocusDb,
  roomId: string,
  userActorId: string,
): Promise<FocusEvent[]> {
  return (await db
    .select()
    .from(focusEvents)
    .where(
      and(
        eq(focusEvents.roomId, roomId),
        eq(focusEvents.userActorId, userActorId),
      ),
    )
    .orderBy(desc(focusEvents.occurredAt))) as FocusEvent[];
}

/**
 * Loads only the latest access event per Genie across every room. This
 * intentionally does not constrain by room: the compact Genie rail is a
 * requester-private recent-access surface, rather than a transcript or
 * room-speaking history. `DISTINCT ON` keeps the projection bounded by the
 * number of Genies the requester has accessed rather than their event-log
 * length, and SQL filters terminal events before materialization.
 */
async function loadRequesterFocusEvents(
  db: FocusDb,
  userActorId: string,
): Promise<FocusEvent[]> {
  return (await db
    .selectDistinctOn([focusEvents.botActorId])
    .from(focusEvents)
    .where(
      and(
        eq(focusEvents.userActorId, userActorId),
        inArray(focusEvents.eventType, ["opened", "extended"]),
      ),
    )
    .orderBy(
      focusEvents.botActorId,
      desc(focusEvents.occurredAt),
      desc(focusEvents.id),
    )) as FocusEvent[];
}

/**
 * Derives a deterministic most-recently-accessed Genie order from the
 * append-only focus log. Opening or extending a focus is access; clearing or
 * lazily expiring it is not. A clear/expiry therefore ends routing focus
 * without erasing the requester's private access history. It accepts a full
 * event log in unit tests even though the production query already returns one
 * qualifying event per Genie.
 */
export function deriveRecentFocusBotActorIds(
  events: readonly FocusEvent[],
  userActorId: string,
): string[] {
  const latestAccessByBot = new Map<string, FocusEvent>();
  for (const event of events) {
    if (event.userActorId !== userActorId) continue;
    if (event.eventType !== "opened" && event.eventType !== "extended") continue;
    const previous = latestAccessByBot.get(event.botActorId);
    if (
      !previous ||
      event.occurredAt > previous.occurredAt ||
      (event.occurredAt.getTime() === previous.occurredAt.getTime() && event.id > previous.id)
    ) {
      latestAccessByBot.set(event.botActorId, event);
    }
  }

  return [...latestAccessByBot.values()]
    .sort((left, right) => {
      const occurredDelta = right.occurredAt.getTime() - left.occurredAt.getTime();
      if (occurredDelta !== 0) return occurredDelta;
      const idDelta = right.id - left.id;
      if (idDelta !== 0) return idDelta;
      return left.botActorId < right.botActorId ? -1 : left.botActorId > right.botActorId ? 1 : 0;
    })
    .map((event) => event.botActorId);
}

/**
 * Returns the requester's global Genie focus-access order. Callers must apply
 * their own current-room eligibility policy before exposing it to a room UI.
 */
export async function loadRecentFocusBotActorIds(
  db: FocusDb,
  userActorId: string,
): Promise<string[]> {
  return deriveRecentFocusBotActorIds(
    await loadRequesterFocusEvents(db, userActorId),
    userActorId,
  );
}

/**
 * Folds the latest event per focus and lazily writes `expired` rows for
 * any focus whose window has lapsed (no later `expired`/`cleared`).
 */
async function sweepExpiredOnTouch(
  db: FocusDb,
  roomId: string,
  userActorId: string,
  now: Date,
  preloaded?: FocusEvent[],
): Promise<void> {
  const events = preloaded ?? (await loadFocusEvents(db, roomId, userActorId));
  const latest = new Map<string, FocusEvent>();
  for (const e of events) {
    const prev = latest.get(e.focusId);
    // Same deterministic tie-break as deriveActiveFoci: at equal
    // `occurred_at`, the higher serial `id` (latest insertion) wins, so a
    // same-instant `cleared`/`expired` is not masked by an `extended`.
    if (
      !prev ||
      e.occurredAt > prev.occurredAt ||
      (e.occurredAt.getTime() === prev.occurredAt.getTime() && e.id > prev.id)
    ) {
      latest.set(e.focusId, e);
    }
  }
  for (const [focusId, e] of latest) {
    if (e.eventType !== "opened" && e.eventType !== "extended") continue;
    if (!e.expiresAt || e.expiresAt > now) continue; // still active
    await materializeExpiry(
      db,
      {
        roomId,
        userActorId,
        botActorId: e.botActorId,
        focusId,
        lapsedExpiresAt: e.expiresAt,
        now,
      },
      // Reuse the events we already loaded to avoid an extra round-trip.
      { loadEvents: () => Promise.resolve(events) },
    );
  }
}

/**
 * Returns only truly-active foci for (room, user), materializing lazy
 * `expired` rows as a side effect.
 */
export async function loadActiveFoci(
  db: FocusDb,
  roomId: string,
  userActorId: string,
  now: Date,
): Promise<ActiveFocus[]> {
  const events = await loadFocusEvents(db, roomId, userActorId);
  await sweepExpiredOnTouch(db, roomId, userActorId, now, events);
  return deriveActiveFoci(events, now);
}
