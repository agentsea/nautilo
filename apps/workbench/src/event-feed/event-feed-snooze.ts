import type { EventFeedPreference } from "@nautilo/types";

export function eventFeedSnoozePreset(preset: "hour" | "tomorrow", now = new Date()): EventFeedPreference {
  const until = new Date(now);
  if (preset === "hour") until.setTime(until.getTime() + 60 * 60 * 1000);
  else {
    until.setDate(until.getDate() + 1);
    until.setHours(9, 0, 0, 0);
  }
  return { mode: "snoozed", until: until.toISOString() };
}

export function eventFeedLocalDateInput(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}T${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

export function eventFeedCustomSnooze(value: string, now = Date.now()): EventFeedPreference | null {
  const date = new Date(value);
  // Reject invalid dates and nonexistent local times (DST spring-forward),
  // rather than silently normalizing the Human's chosen time.
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now || eventFeedLocalDateInput(date) !== value) return null;
  return { mode: "snoozed", until: date.toISOString() };
}
