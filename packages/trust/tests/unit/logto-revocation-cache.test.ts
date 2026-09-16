/**
 * M052 — `logto-revocation-cache.ts` unit tests.
 *
 * The cache is module-level state; each test resets it via
 * `_resetRevocationCacheForTests()` and substitutes the
 * `LogtoAdminClient` resolver with a stub. The `warn` logger is
 * captured so we can assert the fail-open path actually warns.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  checkLogtoRevocation,
  _resetRevocationCacheForTests,
  _setLogtoAdminResolverForTests,
  _setRevocationWarnLoggerForTests,
} from "../../src/logto-revocation-cache";
import type { LogtoAdminClient } from "../../src/logto-admin";

interface StubClient {
  isUserActive: (sub: string) => Promise<boolean>;
  /** Number of times isUserActive was called. */
  calls: number;
}

function stubClient(
  impl: (sub: string) => Promise<boolean>,
): StubClient {
  const stub: StubClient = {
    calls: 0,
    isUserActive: async (sub: string) => {
      stub.calls++;
      return impl(sub);
    },
  };
  return stub;
}

interface WarnCapture {
  msgs: Array<{ msg: string; meta?: Record<string, unknown> }>;
}

let warnCapture: WarnCapture;

beforeEach(() => {
  _resetRevocationCacheForTests();
  warnCapture = { msgs: [] };
  _setRevocationWarnLoggerForTests((msg, meta) =>
    warnCapture.msgs.push({ msg, ...(meta ? { meta } : {}) }),
  );
});

afterEach(() => {
  _setLogtoAdminResolverForTests(null);
  _setRevocationWarnLoggerForTests(null);
  _resetRevocationCacheForTests();
});

describe("checkLogtoRevocation", () => {
  test("cache miss → calls isUserActive, populates cache, returns the verdict", async () => {
    const stub = stubClient(async () => true);
    _setLogtoAdminResolverForTests(() => stub as unknown as LogtoAdminClient);

    expect(await checkLogtoRevocation("user-1")).toBe(true);
    expect(stub.calls).toBe(1);
  });

  test("cache hit within TTL → no Management API call", async () => {
    const stub = stubClient(async () => true);
    _setLogtoAdminResolverForTests(() => stub as unknown as LogtoAdminClient);

    expect(await checkLogtoRevocation("user-1")).toBe(true);
    expect(await checkLogtoRevocation("user-1")).toBe(true);
    expect(await checkLogtoRevocation("user-1")).toBe(true);
    expect(stub.calls).toBe(1);
  });

  test("negative result is cached (no repeated calls within TTL)", async () => {
    const stub = stubClient(async () => false);
    _setLogtoAdminResolverForTests(() => stub as unknown as LogtoAdminClient);

    expect(await checkLogtoRevocation("revoked")).toBe(false);
    expect(await checkLogtoRevocation("revoked")).toBe(false);
    expect(stub.calls).toBe(1);
  });

  test("Management API throws → returns true (fail open) and logs warning", async () => {
    const stub = stubClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    _setLogtoAdminResolverForTests(() => stub as unknown as LogtoAdminClient);

    const verdict = await checkLogtoRevocation("user-1");
    expect(verdict).toBe(true);
    expect(stub.calls).toBe(1);
    expect(warnCapture.msgs.length).toBe(1);
    expect(warnCapture.msgs[0]!.msg).toBe("management_api_unreachable");
    expect(warnCapture.msgs[0]!.meta?.["sub"]).toBe("user-1");
  });

  test("isolated cache entries per sub", async () => {
    const stub = stubClient(async (sub) => sub !== "revoked");
    _setLogtoAdminResolverForTests(() => stub as unknown as LogtoAdminClient);

    expect(await checkLogtoRevocation("alice")).toBe(true);
    expect(await checkLogtoRevocation("revoked")).toBe(false);
    expect(await checkLogtoRevocation("bob")).toBe(true);
    expect(stub.calls).toBe(3);

    // Re-asks: all three are now cached.
    expect(await checkLogtoRevocation("alice")).toBe(true);
    expect(await checkLogtoRevocation("revoked")).toBe(false);
    expect(await checkLogtoRevocation("bob")).toBe(true);
    expect(stub.calls).toBe(3);
  });
});
