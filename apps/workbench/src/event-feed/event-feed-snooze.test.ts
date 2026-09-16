import { describe, expect, test } from "bun:test";
import { eventFeedPreferenceSchema, isEventFeedQuiet } from "@nautilo/types";
import { eventFeedCustomSnooze, eventFeedLocalDateInput, eventFeedSnoozePreset } from "./event-feed-snooze";

describe("Events quiet deadlines", () => {
  test("an hour is elapsed time and tomorrow is the next local calendar day at nine", () => {
    const now = new Date(2026, 8, 16, 18, 45);
    const hour = eventFeedSnoozePreset("hour", now);
    expect(hour.mode === "snoozed" && Date.parse(hour.until) - now.getTime()).toBe(3_600_000);
    const tomorrow = eventFeedSnoozePreset("tomorrow", now);
    if (tomorrow.mode !== "snoozed") throw new Error("Expected snooze");
    const until = new Date(tomorrow.until);
    expect(until.getDate()).toBe(17); expect(until.getHours()).toBe(9); expect(until.getMinutes()).toBe(0);
    expect(now.getDate()).toBe(16);
  });

  test("custom times validate the local date and convert to an absolute instant", () => {
    const date = new Date(2099, 0, 1, 11, 30);
    const input = eventFeedLocalDateInput(date);
    expect(eventFeedCustomSnooze(input, date.getTime() - 1)).toEqual({ mode: "snoozed", until: date.toISOString() });
    expect(eventFeedCustomSnooze(input, date.getTime())).toBeNull();
    expect(eventFeedCustomSnooze("2099-02-31T12:00")).toBeNull();
    expect(eventFeedCustomSnooze("")).toBeNull();
  });

  test("expires exactly at the deadline while indefinite quiet persists", () => {
    const until = "2026-09-17T09:00:00+02:00";
    expect(isEventFeedQuiet({ mode: "snoozed", until }, Date.parse(until) - 1)).toBe(true);
    expect(isEventFeedQuiet({ mode: "snoozed", until }, Date.parse(until))).toBe(false);
    expect(isEventFeedQuiet({ mode: "quiet" }, Date.parse("9999-01-01T00:00:00Z"))).toBe(true);
    expect(isEventFeedQuiet({ mode: "active" })).toBe(false);
    expect(eventFeedPreferenceSchema.safeParse({ mode: "active", userId: "someone-else" }).success).toBe(false);
  });
});
