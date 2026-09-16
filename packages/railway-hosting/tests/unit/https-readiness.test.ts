import { describe, expect, test } from "bun:test";
import { waitForRailwayHttpsReadiness } from "../../src/https-readiness";

const origin = "https://nautilo.example.test";

function input(fetch: Parameters<typeof waitForRailwayHttpsReadiness>[0]["fetch"], wait = async () => undefined) {
  return { origin, fetch, wait, requestTimeoutMs: 20, retryDelayMs: 1, maxAttempts: 100 };
}

describe("waitForRailwayHttpsReadiness", () => {
  test("retries transient 503 then accepts exact 200 without reading a body", async () => {
    let calls = 0;
    let waits = 0;
    const result = await waitForRailwayHttpsReadiness(input(async (url, init) => {
      calls += 1;
      expect(url).toBe(`${origin}/health/ready`);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
      return { status: calls === 1 ? 503 : 200, body: { mustNotBeRead: true } };
    }, async () => { waits += 1; }));
    expect(result).toEqual({ outcome: "complete", attempts: 2 });
    expect(waits).toBe(1);
  });

  test("fails closed for redirects and terminal 401", async () => {
    expect(await waitForRailwayHttpsReadiness(input(async () => ({ status: 302 })))).toEqual({ outcome: "failure", attempts: 1, code: "redirect" });
    expect(await waitForRailwayHttpsReadiness(input(async () => ({ status: 401 })))).toEqual({ outcome: "failure", attempts: 1, code: "terminal-http" });
  });

  test("aborts a hung request and returns a redacted bounded failure", async () => {
    const result = await waitForRailwayHttpsReadiness({ ...input(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), async () => undefined), maxAttempts: 2 });
    expect(result).toEqual({ outcome: "failure", attempts: 2, code: "retry-exhausted" });
  });

  test("rejects malformed or malicious origins before fetch", async () => {
    let calls = 0;
    for (const unsafe of ["http://nautilo.example.test", "https://user@nautilo.example.test", "https://nautilo.example.test/path", "https://nautilo.example.test/", `https://${"a".repeat(2048)}.test`]) {
      expect(await waitForRailwayHttpsReadiness({ ...input(async () => { calls += 1; return { status: 200 }; }), origin: unsafe })).toEqual({ outcome: "failure", attempts: 0, code: "invalid-origin" });
    }
    expect(calls).toBe(0);
  });

  test("snapshots mutable inputs before waiting", async () => {
    const mutable = input(async () => ({ status: 503 }));
    let first = true;
    mutable.fetch = async (url) => {
      if (first) { first = false; mutable.origin = "https://evil.example.test"; mutable.fetch = async () => ({ status: 200 }); return { status: 503 }; }
      expect(url).toBe(`${origin}/health/ready`);
      return { status: 200 };
    };
    const result = await waitForRailwayHttpsReadiness(mutable);
    expect(result).toEqual({ outcome: "complete", attempts: 2 });
  });

  test("enforces caller-selected 1..100 attempt bounds before fetch", async () => {
    let calls = 0;
    const fetch = async () => { calls += 1; return { status: 503 }; };
    expect(await waitForRailwayHttpsReadiness({ ...input(fetch), maxAttempts: 2 })).toEqual({ outcome: "failure", attempts: 2, code: "retry-exhausted" });
    expect(await waitForRailwayHttpsReadiness({ ...input(fetch), maxAttempts: 0 })).toEqual({ outcome: "failure", attempts: 0, code: "invalid-origin" });
    expect(await waitForRailwayHttpsReadiness({ ...input(fetch), maxAttempts: 101 })).toEqual({ outcome: "failure", attempts: 0, code: "invalid-origin" });
    expect(calls).toBe(2);
  });

  test("contains wait and hostile response failures in redacted results", async () => {
    const secret = "wait-secret-must-not-leak";
    const waitFailure = await waitForRailwayHttpsReadiness(input(async () => ({ status: 503 }), async () => { throw new Error(secret); }));
    expect(waitFailure).toEqual({ outcome: "failure", attempts: 1, code: "wait-failed" });
    expect(JSON.stringify(waitFailure)).not.toContain(secret);
    const hostile = await waitForRailwayHttpsReadiness({ ...input(async () => ({ get status() { throw new Error(secret); } } as unknown as { readonly status: number })), maxAttempts: 1 });
    expect(hostile).toEqual({ outcome: "failure", attempts: 1, code: "retry-exhausted" });
    expect(JSON.stringify(hostile)).not.toContain(secret);
  });
});
