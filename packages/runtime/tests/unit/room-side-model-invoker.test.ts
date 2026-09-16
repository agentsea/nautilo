import { describe, expect, test } from "bun:test";

import { runRoomSideModelWithDeadline } from "../../src/stenographer/model-invoker";

describe("room-side model hard deadline", () => {
  test("rejects and aborts a provider that does not settle before its deadline", async () => {
    let observedAbort = false;
    const startedAt = performance.now();
    const invocation = runRoomSideModelWithDeadline(
      (signal) => new Promise<string>(() => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
        }, { once: true });
      }),
      undefined,
      20,
    );

    let thrown: unknown;
    try {
      await invocation;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("room_side_model_deadline_exceeded");
    expect(observedAbort).toBeTrue();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("parent cancellation rejects even when the provider ignores AbortSignal", async () => {
    const parent = new AbortController();
    const invocation = runRoomSideModelWithDeadline(
      () => new Promise<string>(() => {}),
      parent.signal,
      5_000,
    );
    parent.abort();

    let thrown: unknown;
    try {
      await invocation;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("room_side_model_aborted");
  });

  test("rejects a late completion even when provider work starves the deadline timer", async () => {
    let observedAbort = false;
    let now = 0;
    const invocation = runRoomSideModelWithDeadline(
      (signal) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
        }, { once: true });
        now = 21;
        return Promise.resolve("too late");
      },
      undefined,
      20,
      () => now,
    );

    let thrown: unknown;
    try {
      await invocation;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("room_side_model_deadline_exceeded");
    expect(observedAbort).toBeTrue();
  });

  test("returns a result before the deadline", async () => {
    expect(await runRoomSideModelWithDeadline(
      async () => "ok",
      undefined,
      5_000,
    )).toBe("ok");
  });
});

describe("shared background invocation cancellation", () => {
  test("cancels a provider that ignores AbortSignal without inventing a deadline", async () => {
    const { runBackgroundModelInvocation } = await import("../../src/background-processing/model-invocation");
    const parent = new AbortController();
    const invocation = runBackgroundModelInvocation({
      usage: { callType: "memory_review", userId: "owner", roomId: "room", metadata: { workId: "work" } },
      signal: parent.signal,
      invoke: () => new Promise<string>(() => {}),
    });
    parent.abort();
    let thrown: unknown;
    try { await invocation; } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("room_side_model_aborted");
  });
});
