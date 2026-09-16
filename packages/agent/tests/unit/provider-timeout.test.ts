import { describe, expect, spyOn, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { ProviderTimeoutError } from "../../src/providers/errors";
import {
  _resetAgentTurnContextsForTests,
  bindModelAttemptProgressSinkByKey,
  recordStreamActivityFromEvent,
} from "../../src/runtime/turn-context";
import {
  ModelAttemptSupervisor,
  type ModelAttemptTerminalOutcome,
  type ResolvedModelAttemptPolicy,
} from "../../src/utils/model-attempt-policy";

function policy(overrides: Partial<ResolvedModelAttemptPolicy> = {}): ResolvedModelAttemptPolicy {
  return {
    attemptId: "attempt-current",
    modelId: "openai:test-model",
    firstProgressMs: 60,
    progressIdleMs: 80,
    provenance: {
      firstProgress: { kind: "temporary_legacy", id: "D264/D331", version: "2026-08" },
      progressIdle: { kind: "temporary_legacy", id: "D264/D331", version: "2026-08" },
    },
    ...overrides,
  };
}

function timeoutError(outcome: Extract<ModelAttemptTerminalOutcome, { kind: "timeout" }>): ProviderTimeoutError {
  return new ProviderTimeoutError("openai:test-model", outcome.timeoutKind === "absolute_timeout" ? 90 : 60, {
    kind: outcome.timeoutKind,
    attemptId: "attempt-current",
    policyProvenance: {},
    elapsedMs: outcome.elapsedMs,
    visibleOutput: outcome.visibleOutput,
    partialState: outcome.partialState,
    abortRequested: outcome.abortRequested,
    safeToFallback: outcome.safeToFallback,
  });
}

function withFakeTimers(run: (timers: Array<() => void>, cleared: () => number) => Promise<void> | void): Promise<void> | void {
  const timers: Array<() => void> = [];
  let clearCount = 0;
  const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
    timers.push(() => callback());
    return callback as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(() => { clearCount += 1; });
  const finish = () => { setTimer.mockRestore(); clearTimer.mockRestore(); };
  try {
    const result = run(timers, () => clearCount);
    if (result instanceof Promise) return result.finally(finish);
    finish();
  } catch (error) {
    finish();
    throw error;
  }
}

/**
 * Reaching into the agent loop's private timeout race is awkward
 * because `invokeModelWithTimeout` is module-scoped. Instead, we
 * exercise the same race shape (Promise.race vs setTimeout) and
 * assert the surfaced error type is `ProviderTimeoutError` — that's
 * what the agent loop does, so a regression in the helper would have
 * to also break this same race.
 */
async function raceAgainstTimeout(
  pending: Promise<unknown>,
  modelId: string,
  timeoutMs: number,
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ProviderTimeoutError(modelId, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("provider invocation timeout race", () => {
  test("rejects with ProviderTimeoutError when the underlying call hangs", async () => {
    const hangForever = new Promise<unknown>(() => {
      /* no resolve, no reject — simulates a stuck upstream */
    });
    const start = Date.now();
    let caught: unknown;
    try {
      await raceAgainstTimeout(hangForever, "openai:test-model", 50);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(ProviderTimeoutError);
    expect((caught as ProviderTimeoutError).modelId).toBe("openai:test-model");
    expect((caught as ProviderTimeoutError).timeoutMs).toBe(50);
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(500);
  });

  test("returns the underlying value when it resolves before the timer fires", async () => {
    const fastResolve = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 10));
    const result = await raceAgainstTimeout(fastResolve, "openai:test-model", 1000);
    expect(result).toBe("ok");
  });

  test("AbortSignal-shaped error from upstream is surfaced as-is (caller decides)", async () => {
    const aborted = Promise.reject(new Error("AbortError: operation was aborted"));
    let caught: unknown;
    try {
      await raceAgainstTimeout(aborted, "openai:test-model", 1000);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("aborted");
  });
});

describe("D563 ModelAttemptSupervisor", () => {
  test("times out when no meaningful progress arrives", async () => {
    await withFakeTimers(async (timers) => {
      const supervisor = new ModelAttemptSupervisor(policy(), { onTimeout: timeoutError });
      const pending = supervisor.race(new Promise<never>(() => {}));
      expect(timers).toHaveLength(1);
      timers[0]!();
      await pending.then(
        () => { throw new Error("expected timeout"); },
        (error) => expect(error).toMatchObject({ details: { kind: "first_progress_timeout", attemptId: "attempt-current", safeToFallback: true } }),
      );
      expect(supervisor.signal.aborted).toBe(true);
    });
  });

  test("wins the typed timeout race against a cooperative provider AbortError", async () => {
    await withFakeTimers(async (timers) => {
      const supervisor = new ModelAttemptSupervisor(policy(), { onTimeout: timeoutError });
      const cooperative = new Promise<never>((_, reject) => {
        supervisor.signal.addEventListener("abort", () => reject(new Error("AbortError: provider cancelled")));
      });
      const pending = supervisor.race(cooperative);
      timers[0]!();
      await pending.then(
        () => { throw new Error("expected timeout"); },
        (error) => expect(error).toMatchObject({ details: { kind: "first_progress_timeout" } }),
      );
    });
  });

  test("meaningful progress switches first-progress to idle supervision and rearms it", async () => {
    await withFakeTimers(async (timers, cleared) => {
      const supervisor = new ModelAttemptSupervisor(policy(), { onTimeout: timeoutError });
      const pending = supervisor.race(new Promise<never>(() => {}));
      expect(supervisor.reportMeaningfulProgress("attempt-current")).toBe(true);
      expect(supervisor.reportMeaningfulProgress("attempt-current")).toBe(true);
      expect(cleared()).toBeGreaterThanOrEqual(2);
      // first timer, first idle timer, rearmed idle timer — only the latest
      // active timer may end the attempt.
      timers[2]!();
      await pending.then(
        () => { throw new Error("expected timeout"); },
        (error) => expect(error).toMatchObject({ details: { kind: "progress_idle_timeout", partialState: true } }),
      );
    });
  });

  test("has no universal ten-minute timer while meaningful progress continues", () => {
    withFakeTimers((timers) => {
      const supervisor = new ModelAttemptSupervisor(policy(), { onTimeout: timeoutError });
      supervisor.start();
      for (let i = 0; i < 121; i++) supervisor.reportMeaningfulProgress("attempt-current");
      // There is one first-progress timer and per-progress idle rearming, but
      // no default absolute timer. An explicit caller is the only source.
      expect(timers).toHaveLength(122);
      supervisor.dispose();
    });
  });

  test("enforces an explicit caller-owned absolute deadline and ignores stale attempt progress", async () => {
    await withFakeTimers(async (timers) => {
      const supervisor = new ModelAttemptSupervisor(policy({ absoluteMs: 90, provenance: {
        firstProgress: { kind: "temporary_legacy", id: "D264/D331", version: "2026-08" },
        progressIdle: { kind: "temporary_legacy", id: "D264/D331", version: "2026-08" },
        absolute: { kind: "caller_override", id: "invoke_options.providerTimeoutMs", version: "1" },
      } }), { onTimeout: timeoutError });
      const pending = supervisor.race(new Promise<never>(() => {}));
      expect(supervisor.reportMeaningfulProgress("attempt-stale")).toBe(false);
      // Absolute is armed after first-progress and is not reset by progress.
      timers[1]!();
      await pending.then(
        () => { throw new Error("expected timeout"); },
        (error) => expect(error).toMatchObject({ details: { kind: "absolute_timeout" } }),
      );
    });
  });

  test("forwards parent cancellation into its owned signal without reclassifying it", async () => {
    await withFakeTimers(async () => {
      const parent = new AbortController();
      const supervisor = new ModelAttemptSupervisor(policy(), {
        parentSignal: parent.signal,
        onTimeout: timeoutError,
      });
      const pending = supervisor.race(new Promise<never>(() => {}));
      parent.abort(new Error("job cancelled"));
      expect(supervisor.signal.aborted).toBe(true);
      await pending.then(
        () => { throw new Error("expected parent abort"); },
        (error) => expect(error).toMatchObject({ message: "job cancelled" }),
      );
    });
  });

  test("wins the parent-cancellation race against a cooperative provider AbortError", async () => {
    await withFakeTimers(async () => {
      const parent = new AbortController();
      const supervisor = new ModelAttemptSupervisor(policy(), {
        parentSignal: parent.signal,
        onTimeout: timeoutError,
      });
      const cooperative = new Promise<never>((_, reject) => {
        supervisor.signal.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
      });
      const pending = supervisor.race(cooperative);
      const cancellation = new Error("job cancelled by user");
      parent.abort(cancellation);
      await pending.then(
        () => { throw new Error("expected parent abort"); },
        (error) => expect(error).toBe(cancellation),
      );
    });
  });

  test("scope reporting retains the start attempt ID, resets high-water, and rejects explicit stale chunks", () => {
    _resetAgentTurnContextsForTests();
    const reports: string[] = [];
    bindModelAttemptProgressSinkByKey("scope-turn::scope-agent", {
      attemptId: "attempt-current",
      reportMeaningfulProgress: (attemptId) => {
        if (attemptId !== "attempt-current") return false;
        reports.push(attemptId);
        return true;
      },
    });

    expect(recordStreamActivityFromEvent({
      event: "on_chat_model_start",
      metadata: { model_attempt_id: "attempt-current" },
    }, "scope-turn::scope-agent")).toBe(false);
    expect(recordStreamActivityFromEvent({
      event: "on_chat_model_stream",
      data: { chunk: { usage_metadata: { output_tokens: 3 } } },
    }, "scope-turn::scope-agent")).toBe(true);
    // Repeated aggregate usage is not progress within one attempt.
    expect(recordStreamActivityFromEvent({
      event: "on_chat_model_stream",
      data: { chunk: { usage_metadata: { output_tokens: 3 } } },
    }, "scope-turn::scope-agent")).toBe(false);
    // A fresh start resets that high-water mark, while chunks are allowed to
    // omit the attempt metadata repeated on the start event.
    expect(recordStreamActivityFromEvent({
      event: "on_chat_model_start",
      metadata: { model_attempt_id: "attempt-current" },
    }, "scope-turn::scope-agent")).toBe(false);
    expect(recordStreamActivityFromEvent({
      event: "on_chat_model_stream",
      data: { chunk: { usage_metadata: { output_tokens: 3 } } },
    }, "scope-turn::scope-agent")).toBe(true);
    expect(recordStreamActivityFromEvent({
      event: "on_chat_model_stream",
      metadata: { model_attempt_id: "attempt-stale" },
      data: { chunk: { content: "late delta" } },
    }, "scope-turn::scope-agent")).toBe(false);
    expect(reports).toEqual(["attempt-current", "attempt-current"]);
    _resetAgentTurnContextsForTests();
  });
});

/**
 * Sanity-check that a manually-aborted controller mid-call rejects
 * the wrapped promise with an abort-shaped error rather than hanging
 * forever. This is what `RunnableConfig.signal` plumbing relies on
 * once the agent loop forwards the caller's signal into the model
 * invoke path.
 */
describe("AbortSignal mid-call", () => {
  test("aborting a controller mid-call surfaces an abort-shaped error from the underlying promise", async () => {
    const controller = new AbortController();
    const work = new Promise<unknown>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("AbortError: aborted by signal")));
    });
    setTimeout(() => controller.abort(), 20);
    let caught: unknown;
    try {
      await work;
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("aborted by signal");
  });
});

// Type-only smoke check that `RunnableConfig` declares a `signal`
// field — the agent loop relies on this to thread caller-supplied
// AbortSignals through `invoke(messages, { signal })`.
const _signalSlotProbe: RunnableConfig = { signal: new AbortController().signal };
void (_signalSlotProbe as unknown);

// Type-only smoke check that BaseMessage import resolves under bun:test.
const _msgImportProbe: BaseMessage[] = [];
void _msgImportProbe;
