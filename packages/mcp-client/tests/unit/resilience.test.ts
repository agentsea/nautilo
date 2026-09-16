import { describe, expect, test } from "bun:test";
import { createMcpResiliencePolicy } from "../../src/resilience.ts";

describe("createMcpResiliencePolicy", () => {
  test("executes a successful operation and returns its value", async () => {
    const policy = createMcpResiliencePolicy("s1");
    const out = await policy.execute(() => Promise.resolve("ok"));
    expect(out).toBe("ok");
  });

  test("retries a transient failure then succeeds (maxAttempts=2)", async () => {
    const policy = createMcpResiliencePolicy("s2", { maxAttempts: 2 });
    let calls = 0;
    const out = await policy.execute(() => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return Promise.resolve("recovered");
    });
    expect(out).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("surfaces the error after attempts are exhausted (maxAttempts=1 → 2 tries)", async () => {
    const policy = createMcpResiliencePolicy("s3", { maxAttempts: 1 });
    let calls = 0;
    let err: unknown;
    try {
      await policy.execute(() => {
        calls += 1;
        return Promise.reject(new Error("always fails"));
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error | undefined)?.message).toContain("always fails");
    expect(calls).toBe(2);
  });
});
