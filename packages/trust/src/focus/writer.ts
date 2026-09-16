import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  focusEvents,
  type DirectDatabase,
  type FocusEvent,
} from "@nautilo/db";
import { FOCUS_TTL_MS } from "./constants";
import { deriveActiveFoci } from "./derive";

/**
 * M134 Phase 1 — the ONLY module allowed to INSERT into `focus_events`.
 *
 * Single-writer rule: only `packages/runtime/src/conductor/*`,
 * `packages/trust/src/focus/writer.ts` (this file), and the focus HTTP
 * routes may import this module. Enforced by
 * `packages/trust/tests/unit/focus-single-writer-guard.test.ts`.
 *
 * Bots can never reach this code — `focus_id` is always server-minted and
 * the event log is append-only (never UPDATEd).
 */
export type FocusDb = DirectDatabase;

export type FocusSource = "mention" | "reply" | "ui" | "inferred";

/** Loads all focus events for one (room, user) pair. Injectable for unit tests. */
export type LoadFocusEventsFn = (
  db: FocusDb,
  roomId: string,
  userActorId: string,
) => Promise<FocusEvent[]>;

const defaultLoadFocusEvents: LoadFocusEventsFn = async (
  db,
  roomId,
  userActorId,
) => {
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
};

export interface FocusWriterDeps {
  /** Defaults to a direct DB read; injected in unit tests. */
  loadEvents?: LoadFocusEventsFn;
}

/**
 * Open a new focus link for (room, user, bot) or extend the existing
 * active one (sliding TTL). Extending never resurrects a `cleared` /
 * `expired` focus — those are not "active" so a fresh `focus_id` is minted.
 */
export async function openOrExtendFocus(
  db: FocusDb,
  args: {
    roomId: string;
    userActorId: string;
    botActorId: string;
    source: FocusSource;
    reason?: string;
    now: Date;
  },
  deps: FocusWriterDeps = {},
): Promise<{ focusId: string; expiresAt: Date; created: boolean }> {
  const loadEvents = deps.loadEvents ?? defaultLoadFocusEvents;
  const events = await loadEvents(db, args.roomId, args.userActorId);
  const active = deriveActiveFoci(events, args.now);
  const existing = active.find((f) => f.botActorId === args.botActorId);
  const expiresAt = new Date(args.now.getTime() + FOCUS_TTL_MS);

  if (existing) {
    await db.insert(focusEvents).values({
      roomId: args.roomId,
      userActorId: args.userActorId,
      botActorId: args.botActorId,
      focusId: existing.focusId,
      eventType: "extended",
      source: args.source,
      reason: args.reason ?? null,
      expiresAt,
      occurredAt: args.now,
    });
    return { focusId: existing.focusId, expiresAt, created: false };
  }

  const focusId = randomUUID(); // server-minted; never from any LLM
  await db.insert(focusEvents).values({
    roomId: args.roomId,
    userActorId: args.userActorId,
    botActorId: args.botActorId,
    focusId,
    eventType: "opened",
    source: args.source,
    reason: args.reason ?? null,
    expiresAt,
    occurredAt: args.now,
  });
  return { focusId, expiresAt, created: true };
}

/**
 * Explicit user clear. Final for that `focus_id` — clearing wins over any
 * later-arriving `expired`. The bot actor id is resolved from the log so
 * callers only need the `focusId`.
 */
export async function clearFocus(
  db: FocusDb,
  args: {
    roomId: string;
    userActorId: string;
    focusId: string;
    reason?: string;
    now: Date;
  },
  deps: FocusWriterDeps = {},
): Promise<{ botActorId: string | null }> {
  const loadEvents = deps.loadEvents ?? defaultLoadFocusEvents;
  const events = await loadEvents(db, args.roomId, args.userActorId);
  const forFocus = events.filter((e) => e.focusId === args.focusId);
  if (forFocus.length === 0) return { botActorId: null }; // unknown focus id — nothing to clear
  const botActorId = forFocus[0]!.botActorId;
  // Idempotent: do not write a second 'cleared'.
  if (forFocus.some((e) => e.eventType === "cleared")) return { botActorId };

  await db.insert(focusEvents).values({
    roomId: args.roomId,
    userActorId: args.userActorId,
    botActorId,
    focusId: args.focusId,
    eventType: "cleared",
    source: null,
    reason: args.reason ?? null,
    expiresAt: null,
    occurredAt: args.now,
  });
  return { botActorId };
}

/**
 * Lazily record an `expired` row for a focus whose window has lapsed.
 * `expiresAt` holds the LAPSED window (the one that ran out); `occurredAt`
 * is the wall-clock the row was written. Idempotent and clearing-wins:
 * skips if a later `cleared` or any `expired` already exists for the focus.
 */
export async function materializeExpiry(
  db: FocusDb,
  args: {
    roomId: string;
    userActorId: string;
    botActorId: string;
    focusId: string;
    lapsedExpiresAt: Date;
    now: Date;
  },
  deps: FocusWriterDeps = {},
): Promise<void> {
  const loadEvents = deps.loadEvents ?? defaultLoadFocusEvents;
  const events = await loadEvents(db, args.roomId, args.userActorId);
  const forFocus = events.filter((e) => e.focusId === args.focusId);
  // Clearing wins; never double-write an expiry.
  if (
    forFocus.some(
      (e) => e.eventType === "cleared" || e.eventType === "expired",
    )
  ) {
    return;
  }

  await db.insert(focusEvents).values({
    roomId: args.roomId,
    userActorId: args.userActorId,
    botActorId: args.botActorId,
    focusId: args.focusId,
    eventType: "expired",
    source: null,
    reason: null,
    expiresAt: args.lapsedExpiresAt,
    occurredAt: args.now,
  });
}
