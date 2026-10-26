import { expect, spyOn, test } from "bun:test";
import type { ChatModel } from "../../src/providers/types";
import { invokeWithRetry } from "../../src/utils/invoke";

test("a timed-out request is aborted before the replacement attempt starts", async () => {
  const signals: AbortSignal[] = [];
  const model: ChatModel = {
    invoke: async (_messages, options) => {
      const signal = options?.["signal"] as AbortSignal;
      signals.push(signal);
      if (signals.length === 2) {
        expect(signals[0]?.aborted).toBe(true);
        return "recovered";
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Transport aborted", { cause: signal.reason })), { once: true });
      });
    },
  };
  expect(await invokeWithRetry(model, [], { attempts: 2, timeoutMs: 1000 })).toBe("recovered");
  expect(signals).toHaveLength(2);
  expect(signals[1]?.aborted).toBe(false);
});

test("caller cancellation aborts transport and settles even when the model ignores it", async () => {
  const caller = new AbortController();
  const reason = new Error("QA task cancelled");
  let transportSignal: AbortSignal | undefined;
  let calls = 0;
  const model: ChatModel = {
    invoke: async (_messages, options) => {
      calls += 1;
      transportSignal = options?.["signal"] as AbortSignal;
      return new Promise(() => {});
    },
  };
  const result = invokeWithRetry(model, [], { signal: caller.signal }).catch((error: unknown) => error);
  caller.abort(reason);
  expect(await result).toBe(reason);
  expect(transportSignal?.aborted).toBe(true);
  expect(calls).toBe(1);
});

test("an already-cancelled caller makes no provider request", async () => {
  const caller = new AbortController();
  const reason = new Error("QA task already cancelled");
  caller.abort(reason);
  let calls = 0;
  const model: ChatModel = { invoke: async () => { calls += 1; return "unexpected"; } };
  const result = await invokeWithRetry(model, [], { signal: caller.signal }).catch((error: unknown) => error);
  expect(result).toBe(reason);
  expect(calls).toBe(0);
});


for (const confidential of [false, true]) {
  test(`retry diagnostics retain ordinary details and suppress confidential details (${confidential})`, async () => {
    const logger = spyOn(console, "error").mockImplementation(() => {});
    const cause = new Error("PRIVATE_PROVIDER_FAILURE_MARKER");
    const model: ChatModel = { invoke: async () => { throw cause; } };
    try {
      const failure = await invokeWithRetry(model, [], { attempts: 1,
        ...(confidential ? { confidential: true } : {}) }).catch((error: unknown) => error);
      expect(failure).toBe(cause);
      expect(JSON.stringify(logger.mock.calls).includes(cause.message)).toBe(!confidential);
    } finally { logger.mockRestore(); }
  });
}
