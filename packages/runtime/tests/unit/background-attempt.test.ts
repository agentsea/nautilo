import { describe, expect, test } from "bun:test";
import {
  BackgroundAttemptCancelledError,
  BackgroundAttemptUnavailableError,
  runBackgroundAttempt,
  openBackgroundAttempt,
  type BackgroundAttemptObservation,
  type BackgroundAttemptContext,
} from "../../src/background-processing/attempt";

const identity = { family: "memory" as const, stage: "review", workId: "work", attemptId: "attempt" };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected rejection");
}

describe("shared background attempt", () => {
  test("availability rejection precedes access and confidential reads", async () => {
    const events: string[] = [];
    expect(await rejection(runBackgroundAttempt({
      identity,
      checkAvailable: async () => false,
      openAccess: async () => { events.push("open"); return { assertCurrent: async () => {}, close: async () => {} }; },
      run: async () => { events.push("read"); },
    }))).toBeInstanceOf(BackgroundAttemptUnavailableError);
    expect(events).toEqual([]);
  });

  test("revalidates immediately before publication and always closes", async () => {
    const events: string[] = [];
    let current = true;
    expect(await rejection(runBackgroundAttempt({
      identity,
      checkAvailable: async () => true,
      openAccess: async () => ({
        assertCurrent: async () => { events.push("validate"); if (!current) throw new Error("revoked"); },
        close: async () => { events.push("close"); },
      }),
      run: async (context) => {
        events.push("read");
        current = false;
        await context.publish(async () => { events.push("publish"); });
      },
    }))).toEqual(new Error("revoked"));
    expect(events).toEqual(["validate", "read", "validate", "close"]);
  });

  test("preserves committed outcome despite cleanup, diagnostics and concurrent cancellation", async () => {
    const controller = new AbortController();
    const result = await runBackgroundAttempt({
      identity,
      signal: controller.signal,
      checkAvailable: async () => true,
      openAccess: async () => ({ assertCurrent: async () => {}, close: async () => { throw new Error("close"); } }),
      run: (context) => context.publish(async () => { controller.abort(); return "committed"; }),
      observe: () => { throw new Error("telemetry"); },
    });
    expect(result).toBe("committed");
  });

  test("late continuations and cancelled attempts cannot publish", async () => {
    let captured: BackgroundAttemptContext | undefined;
    let publications = 0;
    await runBackgroundAttempt({
      identity,
      checkAvailable: async () => true,
      openAccess: async () => ({ assertCurrent: async () => {}, close: async () => {} }),
      run: async (context) => { captured = context; },
    });
    expect(await rejection(captured!.publish(async () => { publications++; }))).toBeInstanceOf(BackgroundAttemptCancelledError);
    expect(publications).toBe(0);
  });
});


describe("retained background attempt lifetime", () => {
  test("keeps independent batch members open until each closes", async () => {
    const closed: string[] = [];
    const observations: BackgroundAttemptObservation[] = [];
    const open = (attemptId: string) => openBackgroundAttempt({
      identity: { ...identity, family: "reflection", attemptId },
      checkAvailable: async () => true,
      openAccess: async () => ({ assertCurrent: async () => {}, close: async () => { closed.push(attemptId); } }),
      observe: (event) => { observations.push(event); },
    });
    const first = await open("one");
    const second = await open("two");
    expect(closed).toEqual([]);
    await first.close("failed");
    expect(await second.publish(async () => "committed")).toBe("committed");
    await second.close("completed");
    expect(closed).toEqual(["one", "two"]);
    expect(observations.map(({ attemptId, outcome }) => ({ attemptId, outcome }))).toEqual([
      { attemptId: "one", outcome: "failed" }, { attemptId: "two", outcome: "completed" },
    ]);
  });

  test("concurrent closes fence immediately and release and observe exactly once", async () => {
    let releases = 0;
    let finishRelease!: () => void;
    const releasing = new Promise<void>((resolve) => { finishRelease = resolve; });
    const observed: string[] = [];
    const attempt = await openBackgroundAttempt({
      identity, checkAvailable: async () => true,
      openAccess: async () => ({ assertCurrent: async () => {}, close: async () => { releases++; await releasing; } }),
      observe: (event) => { observed.push(event.outcome); throw new Error("observer failure"); },
    });
    const first = attempt.close("completed");
    expect(attempt.close("failed")).toBe(first);
    expect(await rejection(attempt.publish(async () => "must not publish"))).toBeInstanceOf(BackgroundAttemptCancelledError);
    finishRelease();
    await first;
    await attempt.close("cancelled");
    expect(releases).toBe(1);
    expect(observed).toEqual(["completed"]);
  });

  test("setup rejection observes once and closes an acquired session", async () => {
    for (const failure of ["availability", "open", "current", "cancelled"] as const) {
      let opens = 0; let closes = 0;
      const outcomes: string[] = [];
      const controller = new AbortController();
      const error = await rejection(openBackgroundAttempt({
        identity, signal: controller.signal,
        checkAvailable: async () => failure !== "availability",
        openAccess: async () => {
          opens++;
          if (failure === "open") throw new Error("open failed");
          if (failure === "cancelled") controller.abort();
          return { assertCurrent: async () => { throw new Error("current failed"); }, close: async () => { closes++; throw new Error("cleanup failed"); } };
        },
        observe: (event) => { outcomes.push(event.outcome); },
      }));
      expect(error).toBeInstanceOf(Error);
      expect(opens).toBe(failure === "availability" ? 0 : 1);
      expect(closes).toBe(failure === "current" || failure === "cancelled" ? 1 : 0);
      expect(outcomes).toEqual([failure === "availability" ? "unavailable" : failure === "cancelled" ? "cancelled" : "failed"]);
    }
  });

  test("closing during authority validation prevents pending publication", async () => {
    let calls = 0; let publications = 0;
    let finishValidation!: () => void;
    const validation = new Promise<void>((resolve) => { finishValidation = resolve; });
    const attempt = await openBackgroundAttempt({
      identity, checkAvailable: async () => true,
      openAccess: async () => ({ assertCurrent: async () => { if (++calls > 1) await validation; }, close: async () => {} }),
    });
    const publishing = attempt.publish(async () => { publications++; });
    await attempt.close("cancelled");
    finishValidation();
    expect(await rejection(publishing)).toBeInstanceOf(BackgroundAttemptCancelledError);
    expect(publications).toBe(0);
  });

  test("a publisher already entered retains its committed result after cancellation", async () => {
    const controller = new AbortController();
    const outcomes: string[] = [];
    const attempt = await openBackgroundAttempt({
      identity, signal: controller.signal, checkAvailable: async () => true,
      openAccess: async () => ({ assertCurrent: async () => {}, close: async () => { throw new Error("cleanup failed"); } }),
      observe: (event) => { outcomes.push(event.outcome); },
    });
    expect(await attempt.publish(async () => { controller.abort(); return "committed"; })).toBe("committed");
    await attempt.close("completed");
    expect(outcomes).toEqual(["completed"]);
  });
});
