import type { EventFeedItem } from "@nautilo/types";

export function mergeUniqueEventFeedItems(
  first: readonly EventFeedItem[],
  second: readonly EventFeedItem[],
): EventFeedItem[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

/** Refresh only the loaded range; stage new rows until the reader asks for them. */
export function reconcileEventFeedPages(
  current: readonly EventFeedItem[],
  incoming: readonly EventFeedItem[],
  unreadOnly = false,
): { events: EventFeedItem[]; pending: EventFeedItem[] | null; retainedOlder: boolean } {
  if (current.length === 0) return { events: [...incoming], pending: null, retainedOlder: false };
  const incomingById = new Map(incoming.map((event) => [event.id, event]));
  const oldest = incoming.at(-1);
  const isOlder = (event: EventFeedItem): boolean => oldest !== undefined && (
    event.createdAt < oldest.createdAt
    || (event.createdAt === oldest.createdAt && event.id < oldest.id)
  );
  const retainedOlder = current.some((event) => !incomingById.has(event.id) && isOlder(event));
  const events = current
    .filter((event) => incomingById.has(event.id) || (unreadOnly ? isOlder(event) : incoming.length > 0))
    .map((event) => {
      const refreshed = incomingById.get(event.id);
      if (refreshed !== undefined) return refreshed;
      // A retained older row is outside the refreshed server window. Do not
      // preserve an earlier authorized actor label across a later authority
      // reconciliation; the generic presentation remains safe until this row
      // is returned by the server again.
      return event.type === "unknown" ? event : { ...event, actorDisplayName: null };
    });
  const currentIds = new Set(current.map((event) => event.id));
  const pending = incoming.some((event) => !currentIds.has(event.id)) ? [...incoming] : null;
  return { events, pending, retainedOlder };
}
