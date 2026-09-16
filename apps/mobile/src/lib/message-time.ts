import type { ChatItem } from "./messages";

/** Display time must come from the server, not the local receipt/sort clock. */
export function messageSentDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function messageDay(value: unknown): string | null {
  const date = messageSentDate(value);
  return date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : null;
}

/** FlatList is inverted; decorate the oldest dated message in each day. */
export function messageDayLabels(newestFirst: readonly ChatItem[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  let previous: string | null = null;
  for (let index = newestFirst.length - 1; index >= 0; index--) {
    const item = newestFirst[index];
    if (!item || item.kind !== "message" || item.status !== "sent") continue;
    const date = messageSentDate(item.sentAt);
    const day = messageDay(item.sentAt);
    if (!date || !day) continue;
    if (day !== previous) labels.set(item.id, date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }));
    previous = day;
  }
  return labels;
}
