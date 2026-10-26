import { expect, test } from "bun:test";
import { scheduleProtectedTaskCheckpointRefresh } from "../../src/routes/protected-task-checkpoint-refresh";

function fixture(remaining: number) {
  let now = 1000;
  let callback: (() => void) | undefined;
  const delays: number[] = [];
  let cancelled = 0;
  let pauses = 0;
  const abort = new AbortController();
  const clock = { now: () => now,
    schedule: (body: () => void, delay: number) => {
      callback = body; delays.push(delay); return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => { cancelled += 1; },
  };
  const close = scheduleProtectedTaskCheckpointRefresh({ expiresAt: now + remaining,
    signal: abort.signal, requestPause: () => { pauses += 1; return true; } }, clock);
  return { abort, delays, close, runAt(value: number) { now = value; callback?.(); },
    pauses: () => pauses, cancelled: () => cancelled };
}
test("requests one checkpoint before expiry and releases its timer", () => {
  const f = fixture(300_000);
  expect(f.delays).toEqual([240_000]);
  f.runAt(241_000);
  expect(f.pauses()).toBe(1);
  expect(f.cancelled()).toBe(1);
  f.runAt(250_000); f.close();
  expect(f.pauses()).toBe(1);
});
test("short grants retain half their remaining execution interval", () => {
  const f = fixture(30_000);
  expect(f.delays).toEqual([15_000]);
  f.runAt(16_000);
  expect(f.pauses()).toBe(1);
});
test.each(["expired", "aborted", "closed"] as const)("%s custody never requests another pause", state => {
  const f = fixture(300_000);
  if (state === "aborted") f.abort.abort();
  if (state === "closed") f.close();
  f.runAt(state === "expired" ? 301_000 : 241_000);
  expect(f.pauses()).toBe(0);
});
test("an early timer reschedules against the actual clock", () => {
  const f = fixture(300_000);
  f.runAt(200_000);
  expect(f.pauses()).toBe(0);
  expect(f.delays).toEqual([240_000, 41_000]);
  f.runAt(241_000);
  expect(f.pauses()).toBe(1);
});
