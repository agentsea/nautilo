import { describe, test, expect } from "bun:test";
import { nextCronOccurrence } from "../../src/tasks/cron";

describe("M142 — nextCronOccurrence", () => {
  test("weekday 9am resolves to different UTC instants per timezone", () => {
    const after = new Date("2026-06-08T00:00:00Z"); // Monday
    const cron = "0 9 * * 1-5"; // 09:00 on Mon-Fri

    const utc = nextCronOccurrence(cron, "UTC", after);
    const ny = nextCronOccurrence(cron, "America/New_York", after);

    // 09:00 UTC vs 09:00 America/New_York (EDT = UTC-4 in June → 13:00 UTC).
    expect(utc.toISOString()).toBe("2026-06-08T09:00:00.000Z");
    expect(ny.toISOString()).toBe("2026-06-08T13:00:00.000Z");
    expect(utc.getTime()).not.toBe(ny.getTime());
  });

  test("is strictly after `after` (never returns `after` itself)", () => {
    const exact = new Date("2026-06-08T09:00:00Z");
    const next = nextCronOccurrence("0 9 * * *", "UTC", exact);
    expect(next.getTime()).toBeGreaterThan(exact.getTime());
    expect(next.toISOString()).toBe("2026-06-09T09:00:00.000Z");
  });

  test("every-minute cron advances by one minute", () => {
    const after = new Date("2026-06-08T09:00:30Z");
    const next = nextCronOccurrence("* * * * *", "UTC", after);
    expect(next.toISOString()).toBe("2026-06-08T09:01:00.000Z");
  });
});
