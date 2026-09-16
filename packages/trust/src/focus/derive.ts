import type { FocusEvent } from "@nautilo/db";

/**
 * M134 Phase 1 — derived active-focus projection.
 *
 * A focus link is **active** iff its latest event (by `occurredAt`) is
 * `opened` or `extended` AND `now() < expires_at` AND it has no later
 * `expired`/`cleared` event. The `expires_at` timestamp is the source of
 * truth: a focus past `expires_at` is treated as inactive even before the
 * lazy `expired` row is written.
 */
export interface ActiveFocus {
  focusId: string;
  botActorId: string;
  expiresAt: Date;
  openedSource: "mention" | "reply" | "ui" | "inferred";
  openedAt?: Date;
  extendCount?: number;
  openedReason?: string | null;
  anchorMessageId?: number | null;
}

export function deriveActiveFoci(events: FocusEvent[], now: Date): ActiveFocus[] {
  const latest = new Map<string, FocusEvent>();
  const opened = new Map<string, FocusEvent>();
  for (const e of events) {
    if (e.eventType === "opened") opened.set(e.focusId, e);
    const prev = latest.get(e.focusId);
    // Break `occurred_at` ties by the serial `id` (monotonic insertion
    // order) so the fold is deterministic regardless of SQL row order.
    // Without this, events written at the same instant — e.g. an
    // `extended` and a `cleared` for one focus in the same turn — could
    // resolve either way, leaving a cleared focus spuriously active.
    // `cleared` is inserted last, so its higher id correctly wins.
    if (
      !prev ||
      e.occurredAt > prev.occurredAt ||
      (e.occurredAt.getTime() === prev.occurredAt.getTime() && e.id > prev.id)
    ) {
      latest.set(e.focusId, e);
    }
  }
  const out: ActiveFocus[] = [];
  for (const [focusId, e] of latest) {
    if (e.eventType === "cleared" || e.eventType === "expired") continue;
    if (!e.expiresAt || e.expiresAt <= now) continue; // past TTL => inactive
    out.push({
      focusId,
      botActorId: e.botActorId,
      expiresAt: e.expiresAt,
      openedSource: opened.get(focusId)?.source ?? "inferred",
      openedAt: opened.get(focusId)?.occurredAt ?? e.occurredAt,
      extendCount: events.filter((event) => event.focusId === focusId && event.eventType === "extended").length,
      openedReason: opened.get(focusId)?.reason ?? null,
      anchorMessageId: opened.get(focusId)?.anchorMessageId ?? null,
    });
  }
  return out;
}
